import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { TEST_REPO, harness, memoryPrStore, samplePrs, stubClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const NOW = Date.parse('2026-08-21T12:00:00.000Z');
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** Seven commits across the last week, one of them a revert. */
const COMMITS = [
    { sha: 'c1', committedAt: at(-6 * DAY), messageHeadline: 'feat: a' },
    { sha: 'c2', committedAt: at(-5 * DAY), messageHeadline: 'Revert "feat: a"' },
    { sha: 'c3', committedAt: at(-4 * DAY), messageHeadline: 'fix: b' },
    { sha: 'c4', committedAt: at(-3 * DAY), messageHeadline: 'fix: c' },
    { sha: 'c5', committedAt: at(-2 * DAY), messageHeadline: 'chore: d' },
    { sha: 'c6', committedAt: at(-DAY), messageHeadline: 'feat: e' },
    { sha: 'c7', committedAt: at(-3_600_000), messageHeadline: 'feat: f' },
];

async function serve(options: { coveredFrom: string; store?: ReturnType<typeof memoryPrStore> }) {
    const store =
        options.store ??
        memoryPrStore({
            prs: samplePrs(),
            commits: COMMITS.map((c) => ({ repo: TEST_REPO, branch: 'dev', ...c })),
            coverage: [
                {
                    repo: TEST_REPO,
                    branch: 'dev',
                    from: options.coveredFrom,
                    commits: COMMITS.length,
                    reverts: 1,
                },
            ],
            sync: {
                [TEST_REPO]: { watermarkAt: at(0), lastSyncAt: at(0), lastFullAt: at(0), syncedEpoch: 1 },
            },
        });

    const h = await harness({ client: stubClient(), store });
    app = h.app;
    await h.service.prime();
    return h;
}

describe('the revert rate for a selected range', () => {
    it('is a real number once commits are persisted', async () => {
        // Before persistence this could only ever be "unavailable": the scan was bounded by a
        // single `since` and could not be re-sliced.
        await serve({ coveredFrom: at(-30 * DAY) });
        const body = (
            await (app as FastifyInstance).inject({
                method: 'GET',
                url: `/api/stats?range=custom&from=${at(-7 * DAY)}&to=${at(0)}`,
            })
        ).json();

        expect(body.meta.revert.status).toBe('ok');
        expect(body.stats.quality.history.commits).toBe(7);
        expect(body.stats.quality.history.reverts).toBe(1);
        expect(body.stats.quality.revertRatio).toBeCloseTo(1 / 7, 6);
    });

    it('slices to the range rather than reporting the whole window', async () => {
        await serve({ coveredFrom: at(-30 * DAY) });
        const body = (
            await (app as FastifyInstance).inject({
                method: 'GET',
                url: `/api/stats?range=custom&from=${at(-3 * DAY)}&to=${at(0)}`,
            })
        ).json();

        // c4, c5, c6, c7 — and no revert among them, which must read as a real 0 because the
        // denominator is real.
        expect(body.stats.quality.history.commits).toBe(4);
        expect(body.stats.quality.history.reverts).toBe(0);
        expect(body.stats.quality.revertRatio).toBe(0);
    });

    it('refuses a range reaching back before persisted coverage, naming the repo', async () => {
        // A ratio over an unknown subset is worse than no ratio. This is the same
        // all-or-nothing rule that makes one unreadable repo disqualify the combined figure.
        await serve({ coveredFrom: at(-4 * DAY) });
        const body = (
            await (app as FastifyInstance).inject({
                method: 'GET',
                url: `/api/stats?range=custom&from=${at(-30 * DAY)}&to=${at(0)}`,
            })
        ).json();

        expect(body.meta.revert.status).toBe('unavailable');
        expect(body.meta.revert.reason).toContain(TEST_REPO);
        expect(body.stats.quality.history).toBeNull();
        expect(body.stats.quality.revertRatio).toBeNull();
    });

    it('refuses a slice when the stored rows disagree with the reported total', async () => {
        // A partial scan would make the row count a denominator over an unknown window.
        const store = memoryPrStore({
            prs: samplePrs(),
            commits: COMMITS.slice(0, 3).map((c) => ({ repo: TEST_REPO, branch: 'dev', ...c })),
            coverage: [
                { repo: TEST_REPO, branch: 'dev', from: at(-30 * DAY), commits: COMMITS.length, reverts: 1 },
            ],
            sync: {
                [TEST_REPO]: { watermarkAt: at(0), lastSyncAt: at(0), lastFullAt: at(0), syncedEpoch: 1 },
            },
        });
        await serve({ coveredFrom: at(-30 * DAY), store });
        const body = (
            await (app as FastifyInstance).inject({
                method: 'GET',
                url: `/api/stats?range=custom&from=${at(-7 * DAY)}&to=${at(0)}`,
            })
        ).json();

        expect(body.meta.revert.status).toBe('unavailable');
        expect(body.meta.revert.reason).toMatch(/disagree with the reported total/);
    });

    it('still reports the provider total for all time, not the row count', async () => {
        await serve({ coveredFrom: at(-30 * DAY) });
        const body = (await (app as FastifyInstance).inject({ method: 'GET', url: '/api/stats' })).json();

        expect(body.meta.revert.status).toBe('ok');
        expect(body.stats.quality.history.commits).toBe(COMMITS.length);
        expect(body.stats.quality.history.since).toBe(at(-30 * DAY));
    });

    it('stays unavailable for a range when nothing is persisted', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        await h.app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (
            await h.app.inject({ method: 'GET', url: `/api/stats?range=custom&from=${at(-7 * DAY)}` })
        ).json();
        expect(body.meta.revert.status).toBe('unavailable');
        expect(body.meta.revert.reason).toMatch(/full fetch window/);
    });
});
