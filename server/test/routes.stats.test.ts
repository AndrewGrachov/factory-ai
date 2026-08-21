import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { harness, stubClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

describe('GET /api/stats', () => {
    it('answers 202 while the cold fetch is running, then 200', async () => {
        let release: (() => void) | null = null;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const client = stubClient({
            prs: async () => {
                await gate;
                return { prs: [], truncated: [], rateLimit: null };
            },
        });
        const h = await harness({ client });
        app = h.app;

        const cold = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(cold.statusCode).toBe(202);
        expect(cold.json().fetch.state).toBe('loading');

        (release as unknown as () => void)();
        await h.settle();

        const warm = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(warm.statusCode).toBe(200);
        expect(warm.json().meta.stale).toBe(false);
    });

    it('serves the computed stats with repo and freshness metadata', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.stats.meta.counts.mergedToBase).toBe(178);
        expect(body.stats.threads.total).toBe(654);
        expect(body.meta.repo).toEqual({ owner: 'Leeloo-AI-RGA-OS', name: 'leeloo.ai' });
        expect(body.meta.baseBranch).toBe('dev');
        expect(body.meta.source).toBe('live');
        expect(body.meta.ageSeconds).toBe(0);
        // truncated lives only on stats.meta, never duplicated into the envelope.
        expect(body.stats.meta.truncated).toEqual([]);
        expect(body.meta.truncated).toBeUndefined();
    });

    it('does not refetch inside the TTL', async () => {
        const client = stubClient();
        const h = await harness({ client });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(1);

        h.advance(60_000);
        for (let i = 0; i < 3; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(1);
    });

    it('serves the stale entry and refetches exactly once past the TTL', async () => {
        const client = stubClient();
        const h = await harness({ client });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        h.advance(900_001);
        const stale = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(stale.statusCode).toBe(200);
        expect(stale.json().meta.stale).toBe(true);

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(2);
    });

    it('collapses concurrent cold requests into one fetch', async () => {
        const client = stubClient();
        const h = await harness({ client });
        app = h.app;

        await Promise.all(
            Array.from({ length: 5 }, () => app!.inject({ method: 'GET', url: '/api/stats' })),
        );
        await h.settle();
        expect(client.prCalls).toBe(1);
    });
});

describe('POST /api/refresh', () => {
    it('is single-flight when called twice', async () => {
        const client = stubClient();
        const h = await harness({ client });
        app = h.app;

        const [a, b] = await Promise.all([
            app.inject({ method: 'POST', url: '/api/refresh' }),
            app.inject({ method: 'POST', url: '/api/refresh' }),
        ]);
        await h.settle();

        expect(a.statusCode).toBe(202);
        expect(b.statusCode).toBe(202);
        expect(client.prCalls).toBe(1);
    });
});
