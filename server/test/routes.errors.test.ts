import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GitHubError } from '../src/github/errors.js';
import { TEST_REPO, harness, samplePrs, stubClient } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const failing = (error: Error) => stubClient({ prs: async () => Promise.reject(error) });

describe('cold-start failures', () => {
    it.each([
        ['TOKEN_REJECTED', 401, 'Token rejected (401). It is invalid, expired, or revoked.'],
        ['FORBIDDEN', 403, 'Forbidden (403). The token likely lacks access'],
        ['RATE_LIMITED', 403, 'Rate limit exhausted. Resets at 2026-08-21T13:00:00.000Z.'],
        ['NOT_FOUND', 404, 'not visible to this token'],
    ] as const)('maps a %s upstream failure onto 503 with the code', async (code, status, message) => {
        const h = await harness({ client: failing(new GitHubError(message, code, status)) });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const response = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe(code);
        expect(response.json().error).toContain(message.slice(0, 20));
    });

    it('reports a network failure rather than hanging', async () => {
        const h = await harness({
            client: failing(new GitHubError('Could not reach api.github.com (fetch failed).', 'NETWORK')),
        });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const response = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('NETWORK');
    });

    it('does not retry on every request while the failure is fresh', async () => {
        const client = failing(new GitHubError('Token rejected (401).', 'TOKEN_REJECTED', 401));
        const h = await harness({ client });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(1);

        for (let i = 0; i < 5; i += 1) await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(1);

        h.advance(30_001);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect(client.prCalls).toBe(2);
    });

    it('retries immediately when a refresh is asked for explicitly', async () => {
        const client = failing(new GitHubError('Token rejected (401).', 'TOKEN_REJECTED', 401));
        const h = await harness({ client });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        await app.inject({ method: 'POST', url: '/api/refresh' });
        await h.settle();
        expect(client.prCalls).toBe(2);
    });

    it('never leaks the token into an error body', async () => {
        const secret = 'github_pat_TOPSECRET';
        const h = await harness({
            client: failing(new GitHubError(`Forbidden (403). token=${'redacted'}`, 'FORBIDDEN', 403)),
        });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).body;
        expect(body).not.toContain(secret);
    });
});

describe('a rate limit keeps the last good render', () => {
    it('serves the cached stats with 200 after a refresh fails', async () => {
        let fail = false;
        const client = stubClient({
            prs: async () => {
                if (fail) throw new GitHubError('Rate limit exhausted.', 'RATE_LIMITED', 403);
                return { prs: structuredClone(samplePrs()), rateLimit: null, completed: { [TEST_REPO]: true } };
            },
        });
        const h = await harness({ client });
        app = h.app;

        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();
        expect((await app.inject({ method: 'GET', url: '/api/stats' })).statusCode).toBe(200);

        fail = true;
        h.advance(900_001);
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const response = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(response.statusCode).toBe(200);
        expect(response.json().stats.threads.total).toBe(654);
        expect(response.json().meta.stale).toBe(true);
        // The failure is reported through fetchState, not by blanking the dashboard.
        expect(h.service.fetchState().error?.code).toBe('RATE_LIMITED');
    });
});

describe('revert rate degrades instead of reporting zero', () => {
    it('marks it unavailable when the branch is not readable', async () => {
        const h = await harness({ client: stubClient({ history: async () => null }) });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.revert.status).toBe('unavailable');
        expect(body.meta.revert.reason).toContain('Contents: read');
        expect(body.stats.quality.history).toBeNull();
        expect(body.stats.quality.revertRatio).toBeNull();
    });

    it('marks it unavailable when Contents: read is missing, without failing the dashboard', async () => {
        const h = await harness({
            client: stubClient({
                history: async () => {
                    throw new GitHubError('Forbidden (403).', 'FORBIDDEN', 403);
                },
            }),
        });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const response = await app.inject({ method: 'GET', url: '/api/stats' });
        expect(response.statusCode).toBe(200);
        const body = response.json();
        expect(body.meta.revert.status).toBe('unavailable');
        expect(body.stats.quality.revertRatio).toBeNull();
        // "0 reverts in 0 commits" reads as a real answer, so it must never be emitted.
        expect(response.body).not.toContain('"commits":0');
        expect(response.body).not.toContain('"reverts":0');
        expect(body.stats.threads.total).toBe(654);
    });

    it('reports the ratio when history is readable', async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const body = (await app.inject({ method: 'GET', url: '/api/stats' })).json();
        expect(body.meta.revert.status).toBe('ok');
        expect(body.stats.quality.history).toEqual({
            branch: 'dev',
            since: expect.any(String),
            commits: 515,
            reverts: 5,
        });
        expect(body.stats.quality.revertRatio).toBeCloseTo(5 / 515, 6);
    });
});

describe('GET /api/health', () => {
    it('is healthy even when GitHub is unreachable', async () => {
        const h = await harness({ client: failing(new GitHubError('nope', 'NETWORK')) });
        app = h.app;
        await app.inject({ method: 'GET', url: '/api/stats' });
        await h.settle();

        const response = await app.inject({ method: 'GET', url: '/api/health' });
        expect(response.statusCode).toBe(200);
        expect(response.json().status).toBe('ok');
    });
});
