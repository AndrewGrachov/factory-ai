import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GitHubError } from '../src/github/errors.js';
import { TEST_REPO, harness, memoryPrStore, samplePrs, stubClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const NOW = '2026-08-21T12:00:00.000Z';
const THREE_DAYS_AGO = '2026-08-18T12:00:00.000Z';

/** A database that has been fully reconciled recently, so the next sync is the cheap kind. */
const seeded = (lastFullAt = NOW) =>
    memoryPrStore({
        prs: samplePrs(),
        sync: {
            [TEST_REPO]: {
                watermarkAt: THREE_DAYS_AGO,
                lastSyncAt: THREE_DAYS_AGO,
                lastFullAt,
                syncedEpoch: 1,
            },
        },
    });

describe('a warm database serves the first request', () => {
    it('answers 200 with real data before any fetch has run', async () => {
        // The whole point of persisting: a restart must not put a 202 or a spinner on screen
        // when the answer is already on disk.
        const gate = new Promise<never>(() => {});
        const client = stubClient({ prs: () => gate });
        const h = await harness({ client, store: seeded() });
        app = h.app;

        await h.service.prime();
        const res = await app.inject({ method: 'GET', url: '/api/stats' });

        expect(res.statusCode).toBe(200);
        expect(res.json().stats.meta.counts.all).toBe(203);
        expect(res.json().meta.persistence.status).toBe('ok');
    });

    it('dates the seed by the last sync, so a stale database reads as stale', async () => {
        // Seeding with now() would report ageSeconds: 0 and stale: false off a three-day-old
        // database, and ensureFresh() would then decline to sync — a frozen dashboard that
        // looks fresh.
        const client = stubClient();
        const h = await harness({ client, store: seeded() });
        app = h.app;

        await h.service.prime();
        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();

        expect(body.meta.stale).toBe(true);
        expect(body.meta.ageSeconds).toBe(3 * 86_400);
        expect(body.meta.persistence.lastSyncAt).toBe(THREE_DAYS_AGO);
    });

    it('starts a background sync off the back of that staleness', async () => {
        const client = stubClient();
        const h = await harness({ client, store: seeded() });
        app = h.app;

        await h.service.prime();
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        expect(client.prCalls).toBe(1);
        expect(client.lastMode).toBe('incremental');
    });

    it('escalates to a full reconciliation once a day', async () => {
        // updatedAt does not reliably bump on a child change, and a newly selected field leaves
        // old rows null. Only a full walk repairs either, so it runs on a schedule of its own
        // rather than waiting for something to notice.
        const client = stubClient();
        const h = await harness({ client, store: seeded(THREE_DAYS_AGO) });
        app = h.app;

        await h.service.prime();
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        expect(client.lastMode).toBe('full');
    });

    it('keeps serving the seed with 200 while the sync is failing', async () => {
        const client = stubClient({
            prs: async () => {
                throw new GitHubError('Rate limit exhausted.', 'RATE_LIMITED', 403);
            },
        });
        const h = await harness({ client, store: seeded() });
        app = h.app;

        await h.service.prime();
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.stats.meta.counts.all).toBe(203);
        expect(body.meta.stale).toBe(true);
        expect(h.service.fetchState().error?.code).toBe('RATE_LIMITED');
        // And the 30s cooldown still applies, so a refused token is not a request loop.
        expect(client.prCalls).toBe(1);
    });

    it('never lets a seed overwrite a fetch that already landed', async () => {
        const client = stubClient();
        const h = await harness({ client, store: seeded() });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        const fresh = (await app.inject({ method: 'GET', url: '/api/stats' })).json().meta.fetchedAt;

        await h.service.prime();
        const after = (await app.inject({ method: 'GET', url: '/api/stats' })).json().meta.fetchedAt;
        expect(after).toBe(fresh);
        expect(after).toBe(NOW);
    });
});

describe('a store failure degrades alone', () => {
    it('serves 200 from the network and reports the store unavailable', async () => {
        const store = memoryPrStore({ prs: samplePrs() });
        store.broken = true;
        const client = stubClient();
        const h = await harness({ client, store });
        app = h.app;

        await h.service.prime();
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.stats.meta.counts.all).toBe(203);
        expect(body.meta.persistence.status).toBe('unavailable');
        expect(body.meta.persistence.reason).toMatch(/unreachable/);
    });

    it('does not set the fetch cooldown, so the next tick still calls the client', async () => {
        // A store fault must never freeze the PR pipeline for 30s. That is the
        // one-degradation-causes-another mistake the separate telemetry cooldown exists to stop.
        const store = memoryPrStore({ prs: samplePrs() });
        store.broken = true;
        const client = stubClient();
        const h = await harness({ client, store });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(h.service.fetchState().error).toBeNull();

        // Past the slot's TTL, which the service floors at a minute per measured repo. A 1ms TTL
        // used to express this; it is not a state a running process can be in any more, because
        // that floor moved out of loadConfig when the repo count started coming from GitHub.
        h.advance(60_010);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(2);
    });
});

describe('window ordering survives the store', () => {
    it('reports the window off creation order however rows arrive', async () => {
        // compute() derives meta.window from array position, so the store's `order by` is the
        // single authority for it. A shuffled load must not move the window.
        const shuffled = [...samplePrs()].sort(() => Math.random() - 0.5);
        const store = memoryPrStore({
            prs: shuffled,
            sync: { [TEST_REPO]: { watermarkAt: THREE_DAYS_AGO, lastSyncAt: THREE_DAYS_AGO, lastFullAt: NOW, syncedEpoch: 1 } },
        });
        const client = stubClient();
        const h = await harness({ client, store });
        app = h.app;

        await h.service.prime();
        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();

        const merged = samplePrs()
            .filter((pr) => pr.mergedAt && pr.baseRef === 'dev')
            .map((pr) => pr.mergedAt as string);
        // Not asserted as min/max of mergedAt: creation order and merge order genuinely differ,
        // and the point is that the store reproduces the ordering compute() was written against.
        const inCreationOrder = [...samplePrs()]
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)
            .filter((pr) => pr.mergedAt && pr.baseRef === 'dev');

        expect(merged.length).toBeGreaterThan(0);
        expect(body.stats.meta.window.to).toBe(inCreationOrder[0]?.mergedAt);
        expect(body.stats.meta.window.from).toBe(inCreationOrder[inCreationOrder.length - 1]?.mergedAt);
    });
});
