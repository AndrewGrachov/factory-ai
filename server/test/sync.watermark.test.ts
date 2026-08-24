import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GitHubError } from '../src/github/errors.js';
import { TEST_REPO, harness, memoryPrStore, samplePrs, stubClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const DAY = 86_400_000;

async function run(store: ReturnType<typeof memoryPrStore>, client: ReturnType<typeof stubClient>) {
    const h = await harness({ client, store });
    app = h.app;
    await h.service.prime();
    await app.inject({ method: 'GET', url: '/api/stats' });
    await h.settle();
    return h;
}

describe('the incremental cutoff', () => {
    it('sits an overlap behind the watermark, not on it', async () => {
        // GraphQL reads replicas, so a PR updated at T can surface after the reader has passed
        // T. With no overlap that update is missed permanently and invisibly.
        // A very recent watermark, so the 14 day floor cannot be what moves the cutoff.
        const store = memoryPrStore({
            prs: samplePrs().map((pr) => ({ ...pr, state: 'merged' as const, updatedAt: at(0) })),
            sync: {
                [TEST_REPO]: {
                    watermarkAt: at(0),
                    lastSyncAt: at(-2 * DAY),
                    lastFullAt: at(0),
                    syncedEpoch: 1,
                },
            },
        });
        const client = stubClient();
        await run(store, client);

        expect(client.lastMode).toBe('incremental');
        // 5 minutes behind, and the recent-window floor takes it further still — never on it.
        expect(Date.parse(client.lastCutoff?.[TEST_REPO] as string)).toBeLessThanOrEqual(NOW - 300_000);
    });

    it('is floored by the fourteen-day recent window', async () => {
        // A review thread can be resolved long after a merge without the PR's updatedAt moving.
        const store = memoryPrStore({
            prs: samplePrs().map((pr) => ({ ...pr, state: 'merged' as const })),
            sync: {
                [TEST_REPO]: { watermarkAt: at(0), lastSyncAt: at(0), lastFullAt: at(0), syncedEpoch: 1 },
            },
        });
        const client = stubClient();
        const h = await harness({ client, store, config: { syncTtlMs: 1 } });
        app = h.app;
        await h.service.prime();
        h.advance(10);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        // The floor is read off the clock at sync time, which the harness advanced by 10ms.
        expect(client.lastCutoff?.[TEST_REPO]).toBe(at(10 - 14 * DAY));
    });

    it('is floored by the oldest still-open PR', async () => {
        const ancient = at(-200 * DAY);
        const store = memoryPrStore({
            prs: [
                { ...(samplePrs()[0] as never), state: 'open', mergedAt: null, updatedAt: ancient } as never,
            ],
            sync: {
                [TEST_REPO]: { watermarkAt: at(0), lastSyncAt: at(0), lastFullAt: at(0), syncedEpoch: 1 },
            },
        });
        const client = stubClient();
        const h = await harness({ client, store, config: { syncTtlMs: 1 } });
        app = h.app;
        await h.service.prime();
        h.advance(10);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        expect(client.lastCutoff?.[TEST_REPO]).toBe(ancient);
    });

    it('walks a repo with no watermark in full, even in incremental mode', async () => {
        const store = memoryPrStore({ prs: samplePrs() });
        const client = stubClient();
        await run(store, client);

        expect(client.lastMode).toBe('full');
        expect(client.lastCutoff?.[TEST_REPO]).toBeUndefined();
    });
});

describe('the watermark itself', () => {
    it('advances only for a repo whose walk completed', async () => {
        // Advancing after a partial walk means the next run resumes from the newest row it
        // happened to write and skips everything in between, silently and permanently.
        const store = memoryPrStore({});
        const client = stubClient({
            prs: async () => ({
                prs: structuredClone(samplePrs()),
                rateLimit: null,
                completed: { [TEST_REPO]: false },
            }),
        });
        await run(store, client);

        expect(store.saved).toHaveLength(1);
        expect(store.recorded).toEqual([]);
    });

    it('records the newest updatedAt it actually saw', async () => {
        const store = memoryPrStore({});
        const client = stubClient();
        await run(store, client);

        const newest = samplePrs()
            .map((pr) => pr.updatedAt)
            .reduce((a, b) => (a > b ? a : b));
        expect(store.recorded).toEqual([
            { repo: TEST_REPO, kind: 'pull_requests', watermarkAt: newest, mode: 'full' },
        ]);
    });

    it('is not touched when the fetch itself fails', async () => {
        const store = memoryPrStore({});
        const client = stubClient({
            prs: async () => {
                throw new GitHubError('Rate limit exhausted.', 'RATE_LIMITED', 403);
            },
        });
        await run(store, client);

        expect(store.saved).toEqual([]);
        expect(store.recorded).toEqual([]);
    });
});

describe('the base-branch scan', () => {
    it('resumes an hour behind the newest stored commit, not on it', async () => {
        // A commit date is not monotonic with history order — a rebase can place a commit behind
        // its own parent — so a zero-overlap resume genuinely skips commits.
        const tip = at(-DAY);
        const store = memoryPrStore({
            prs: samplePrs(),
            commits: [
                { repo: TEST_REPO, branch: 'dev', sha: 'aaa', committedAt: tip, messageHeadline: 'feat: x' },
            ],
            coverage: [{ repo: TEST_REPO, branch: 'dev', from: at(-30 * DAY), commits: 1, reverts: 0 }],
            sync: {
                [TEST_REPO]: { watermarkAt: at(-DAY), lastSyncAt: at(-DAY), lastFullAt: at(0), syncedEpoch: 1 },
            },
        });
        const client = stubClient();
        await run(store, client);

        expect(client.lastSince?.[TEST_REPO]).toBe(at(-DAY - 3_600_000));
    });

    it('starts at the earliest merge when nothing is stored', async () => {
        const store = memoryPrStore({});
        const client = stubClient();
        await run(store, client);

        const earliest = samplePrs()
            .map((pr) => pr.mergedAt)
            .filter((merged): merged is string => merged !== null)
            .reduce((a, b) => (a < b ? a : b));
        expect(client.lastSince?.[TEST_REPO]).toBe(earliest);
    });
});
