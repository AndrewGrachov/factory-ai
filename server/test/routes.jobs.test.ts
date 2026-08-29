import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Claim, Job, JobStore, LeaseResult } from '../src/db/job-store.js';
import { createStatsService } from '../src/stats-service.js';
import { stubClient, stubTelemetryClient, testConfig } from './helpers.js';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

const ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = '22222222-2222-4222-8222-222222222222';

interface StoreStub extends JobStore {
    commands: string[];
    completed: { id: string; output: string | null }[];
}

/**
 * Deliberately not a lease implementation. These tests are about the HTTP contract — which body is
 * refused, which code a store verdict maps to — and a second copy of the claim rules here would
 * only ever agree with itself. The real ones are exercised against a database in
 * test-db/job-store.test.ts.
 */
function stubStore(
    options: { fail?: boolean; claim?: Claim | null; verdict?: LeaseResult; job?: Job | null } = {},
): StoreStub {
    const boom = () => {
        if (options.fail) throw new Error('database is down');
    };
    const stub: StoreStub = {
        commands: [],
        completed: [],
        async create(command) {
            boom();
            stub.commands.push(command);
            return { id: ID };
        },
        async claim() {
            boom();
            return options.claim ?? null;
        },
        async heartbeat() {
            boom();
            const result = options.verdict ?? 'ok';
            return { result, leaseExpiresAt: result === 'ok' ? '2026-08-21T12:05:00.000Z' : null };
        },
        async complete(id, _token, { output }) {
            boom();
            stub.completed.push({ id, output });
            return options.verdict ?? 'ok';
        },
        async get() {
            boom();
            return options.job ?? null;
        },
        async list() {
            boom();
            return options.job ? [options.job] : [];
        },
    };
    return stub;
}

async function harnessWith(jobs?: StoreStub) {
    const config = testConfig();
    const service = createStatsService({
        config,
        client: stubClient(),
        telemetry: stubTelemetryClient(),
        now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    });
    const instance = await buildApp({ config, service, jobs });
    app = instance;
    return instance;
}

const post = (instance: FastifyInstance, url: string, payload: unknown) =>
    instance.inject({ method: 'POST', url, payload: payload as object });

describe('POST /api/jobs', () => {
    it('queues a command', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);

        const response = await post(instance, '/api/jobs', { command: 'claude -p "fix the build"' });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toEqual({ id: ID, status: 'queued' });
        expect(store.commands).toEqual(['claude -p "fix the build"']);
    });

    it.each([
        ['a missing command', {}],
        ['an empty command', { command: '' }],
        ['whitespace only', { command: '   ' }],
        ['a non-string command', { command: 42 }],
        ['an oversized command', { command: 'x'.repeat(16_385) }],
    ])('refuses %s', async (_label, payload) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, '/api/jobs', payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_COMMAND');
    });

    it('answers 503 when the store is down, so the caller retries', async () => {
        const instance = await harnessWith(stubStore({ fail: true }));
        const response = await post(instance, '/api/jobs', { command: 'echo hi' });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe('UNAVAILABLE');
    });
});

describe('POST /api/jobs/claim', () => {
    const claim: Claim = {
        id: ID,
        command: 'echo hi',
        attempts: 1,
        leaseToken: TOKEN,
        leaseExpiresAt: '2026-08-21T12:05:00.000Z',
    };

    it('hands out the job with its lease token', async () => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds: 300 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(claim);
    });

    // The idle poll is the common case: it must be recognisable without parsing a body.
    it('answers 204 when nothing is waiting', async () => {
        const instance = await harnessWith(stubStore({ claim: null }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1' });
        expect(response.statusCode).toBe(204);
        expect(response.body).toBe('');
    });

    it('requires a worker id, because a stuck job has to be traceable to a container', async () => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { leaseSeconds: 300 });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_WORKER');
    });

    it.each([0, -1, 3601, 1.5, 'soon'])('refuses leaseSeconds %p', async (leaseSeconds) => {
        const instance = await harnessWith(stubStore({ claim }));
        const response = await post(instance, '/api/jobs/claim', { worker: 'w1', leaseSeconds });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_LEASE');
    });
});

describe('POST /api/jobs/:id/heartbeat', () => {
    it('extends the lease', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'ok' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(200);
        expect(response.json().leaseExpiresAt).toBe('2026-08-21T12:05:00.000Z');
    });

    // The only signal a superseded worker gets. The driver kills the container on this.
    it('answers 409 once the lease has moved on', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('LEASE_LOST');
    });

    it('answers 404 for a job that does not exist', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'missing' }));
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: TOKEN });
        expect(response.statusCode).toBe(404);
    });

    // Reaches the store as a uuid or not at all: postgres rejects a malformed one with a 500-shaped
    // error, and a bad path is a 400.
    it('refuses a malformed id before touching the store', async () => {
        const store = stubStore();
        const instance = await harnessWith(store);
        const response = await post(instance, '/api/jobs/not-a-uuid/heartbeat', { leaseToken: TOKEN });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_ID');
    });

    it('refuses a malformed lease token', async () => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/heartbeat`, { leaseToken: 'nope' });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('BAD_TOKEN');
    });
});

describe('POST /api/jobs/:id/complete', () => {
    const done = { leaseToken: TOKEN, status: 'succeeded', exitCode: 0, output: 'hello' };

    it('records the outcome', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(200);
        expect(store.completed).toEqual([{ id: ID, output: 'hello' }]);
    });

    it('rejects a report from a worker whose lease was reclaimed', async () => {
        const instance = await harnessWith(stubStore({ verdict: 'lost' }));
        const response = await post(instance, `/api/jobs/${ID}/complete`, done);
        expect(response.statusCode).toBe(409);
    });

    it.each([
        ['an unknown status', { ...done, status: 'dead' }, 'BAD_STATUS'],
        ['a fractional exit code', { ...done, exitCode: 1.5 }, 'BAD_EXIT_CODE'],
        ['a non-string output', { ...done, output: { tail: 'x' } }, 'BAD_OUTPUT'],
    ])('refuses %s', async (_label, payload, code) => {
        const instance = await harnessWith(stubStore());
        const response = await post(instance, `/api/jobs/${ID}/complete`, payload);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });

    // A body limit is not a length check: 128 KiB of output gets through it and would be stored.
    it('truncates output before it reaches the store', async () => {
        const store = stubStore({ verdict: 'ok' });
        const instance = await harnessWith(store);

        await post(instance, `/api/jobs/${ID}/complete`, { ...done, output: 'x'.repeat(100_000) });

        expect(store.completed[0]?.output).toHaveLength(64 * 1024);
    });
});

describe('GET /api/jobs', () => {
    const job: Job = {
        id: ID,
        command: 'echo hi',
        status: 'succeeded',
        attempts: 1,
        maxAttempts: 3,
        claimedBy: 'w1',
        exitCode: 0,
        output: 'hello',
        createdAt: '2026-08-21T12:00:00.000Z',
        startedAt: '2026-08-21T12:00:01.000Z',
        finishedAt: '2026-08-21T12:00:09.000Z',
    };

    it('reads one job', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual(job);
    });

    it('answers 404 for an unknown job', async () => {
        const instance = await harnessWith(stubStore({ job: null }));
        const response = await instance.inject({ method: 'GET', url: `/api/jobs/${ID}` });
        expect(response.statusCode).toBe(404);
    });

    it('lists jobs', async () => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url: '/api/jobs?status=succeeded' });
        expect(response.statusCode).toBe(200);
        expect(response.json().jobs).toHaveLength(1);
    });

    it.each([
        ['an unknown status', '/api/jobs?status=pending', 'BAD_STATUS'],
        ['an over-cap limit', '/api/jobs?limit=1000', 'BAD_LIMIT'],
        ['a non-numeric limit', '/api/jobs?limit=lots', 'BAD_LIMIT'],
    ])('refuses %s', async (_label, url, code) => {
        const instance = await harnessWith(stubStore({ job }));
        const response = await instance.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe(code);
    });
});

// Guards the `if (jobs)` in app.ts: every existing route test builds an app without a job store,
// and registering the board unconditionally would give them all a live queue.
it('does not register the board when there is no job store', async () => {
    const instance = await harnessWith();
    const response = await post(instance, '/api/jobs', { command: 'echo hi' });
    expect(response.statusCode).toBe(404);
});
