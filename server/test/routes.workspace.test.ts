import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_REPOS_PER_USER } from '../src/routes/workspace.js';
import {
    githubAuth,
    harness,
    memoryAuthStore,
    memoryUserRepoStore,
    signedIn,
    stubClient,
    type MemoryUserRepoStore,
} from './helpers.js';

/**
 * Offline: nothing here clones. `PUT` only writes rows and answers 202 — the clone happens in the
 * queue, which this app is built without, and which has its own suite.
 */

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

let root: string;
let store: MemoryUserRepoStore;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'factory-ws-routes-'));
    store = memoryUserRepoStore();
});

const REPOS = [
    { owner: 'acme', name: 'web' },
    { owner: 'acme', name: 'api' },
    { owner: 'other-owner', name: 'api' },
];

async function boot(options: { withRoot?: boolean } = {}) {
    const auth = memoryAuthStore();
    const caller = auth.seedMember('test-org', 'octocat');
    const h = await harness({
        client: stubClient(),
        auth,
        userRepos: store,
        repos: REPOS,
        config: {
            workspaceRoot: options.withRoot === false ? null : root,
            // github mode, so the cookie is what identifies the caller. Under `none` the resolver
            // returns the stand-in local account regardless of what cookie arrives, and a test
            // about per-member workspaces needs two members to be distinguishable.
            auth: githubAuth(),
        },
    });
    app = h.app;
    return { app: h.app, caller, cookie: await signedIn(auth, caller) };
}

describe('GET /api/workspace', () => {
    it('provisions the directory on first read, and reports it', async () => {
        // Idempotent, and deliberately duplicated with the sign-in callback: this covers
        // AUTH_MODE=none, whose caller never passes through that callback, and every session that
        // predates the deploy.
        const { app, caller, cookie } = await boot();
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(200);
        expect(response.json().root).toBe(join(root, 'test-org', caller.user.id));
        expect(existsSync(join(root, 'test-org', caller.user.id))).toBe(true);
    });

    it('writes a breadcrumb naming the owner, so the directory is not a wall of uuids', async () => {
        const { app, caller, cookie } = await boot();
        await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        const path = join(root, 'test-org', caller.user.id, '.factory-workspace.json');
        expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
            userId: caller.user.id,
            login: 'octocat',
        });
    });

    it('answers 200 with a null root when workspaces are switched off', async () => {
        // Not a 503. "No workspace root configured" is a choice an operator made, and the page
        // renders a sentence about it rather than an error nobody can act on.
        const { app, cookie } = await boot({ withRoot: false });
        const response = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ root: null, repos: [], orphaned: [] });
    });

    it('needs a session', async () => {
        const { app } = await boot();
        expect((await app.inject({ method: 'GET', url: '/api/workspace' })).statusCode).toBe(401);
    });

    it('reports a queued repo with no on-disk facts, never with zeroes', async () => {
        // The null-not-zero contract. A repo that has not cloned has no size and no branch, and
        // `0 B` would be a claim rather than an absence.
        const { app, cookie } = await boot();
        await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            headers: { cookie },
            payload: { repos: [{ owner: 'acme', name: 'web' }] },
        });

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toEqual([
            expect.objectContaining({
                owner: 'acme',
                name: 'web',
                status: 'queued',
                error: null,
                branch: null,
                lastCommit: null,
                sizeBytes: null,
            }),
        ]);
    });

    it('lists a deselected repo as orphaned rather than forgetting it', async () => {
        // Nothing prunes, so the row is the only record that the directory exists. Deleting it
        // would make unbounded disk growth invisible.
        const { app, cookie } = await boot();
        const put = (repos: unknown) =>
            app.inject({ method: 'PUT', url: '/api/workspace/repos', headers: { cookie }, payload: { repos } });

        await put([{ owner: 'acme', name: 'web' }]);
        await put([]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toEqual([]);
        expect(body.orphaned).toEqual([{ owner: 'acme', name: 'web' }]);
    });
});

describe('PUT /api/workspace/repos', () => {
    const put = (app: FastifyInstance, cookie: string, repos: unknown) =>
        app.inject({ method: 'PUT', url: '/api/workspace/repos', headers: { cookie }, payload: { repos } });

    it('answers 202, because a clone is minutes and no request may wait for one', async () => {
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        expect(response.statusCode).toBe(202);
        expect(response.json().repos).toEqual([{ owner: 'acme', name: 'web' }]);
    });

    it('replaces the whole selection, so replaying the same body changes nothing', async () => {
        // What makes it a PUT: the browser's retry after a dropped connection is safe.
        const { app, cookie } = await boot();
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);
        await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        const body = (await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } })).json();
        expect(body.repos).toHaveLength(1);
    });

    it('refuses a repo the installation cannot see', async () => {
        // The clone would use the App's installation token, so a repo outside it is one this
        // deployment has no business fetching — and the row would fail forever with a 404.
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [{ owner: 'stranger', name: 'private-thing' }]);

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('UNKNOWN_REPO');
    });

    it('refuses a name that cannot become a directory, by name', async () => {
        /*
         * These rules used to be `checkWorkspaceNames` in loadConfig, refusing to BOOT over an
         * ORG_REPOS entry. That worked while an operator typed the list. It cannot now — the list
         * comes from a GitHub App installation and a bad name is one nobody here can rename — so
         * the answer became a 400 about one repository.
         */
        const { app, cookie } = await boot();
        for (const name of ['-x', '.', '..', 'a/b']) {
            const response = await put(app, cookie, [{ owner: 'acme', name }]);
            expect(response.statusCode, name).toBe(400);
            expect(response.json().code, name).toBe('BAD_REPO_NAME');
        }
    });

    it('refuses two repos that would share one checkout directory', async () => {
        // The directory is the bare repo name, so two owners' same-named repos are one directory.
        // Caught by name here rather than as a unique-index violation, which would be a 503.
        const { app, cookie } = await boot();
        const response = await put(app, cookie, [
            { owner: 'acme', name: 'api' },
            { owner: 'other-owner', name: 'api' },
        ]);

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('REPO_NAME_CONFLICT');
        expect(response.json().error).toMatch(/share the checkout directory "api"/);
    });

    it('caps how much one member can clone onto a shared volume', async () => {
        // Nothing prunes, and per-member checkouts multiply that by the number of members. This is
        // the only bound there is.
        const { app, cookie } = await boot();
        const many = Array.from({ length: MAX_REPOS_PER_USER + 1 }, (_, i) => ({ owner: 'acme', name: `r${i}` }));
        const response = await put(app, cookie, many);

        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe('TOO_MANY_REPOS');
    });

    it('rejects a body that is not a list of { owner, name }', async () => {
        const { app, cookie } = await boot();
        expect((await put(app, cookie, 'web')).statusCode).toBe(400);
        expect((await put(app, cookie, [{ owner: 'acme' }])).statusCode).toBe(400);
    });

    it('answers 409 rather than writing rows when workspaces are switched off', async () => {
        const { app, cookie } = await boot({ withRoot: false });
        const response = await put(app, cookie, [{ owner: 'acme', name: 'web' }]);

        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe('WORKSPACE_DISABLED');
        expect(store.rows()).toEqual([]);
    });

    it('needs a session', async () => {
        const { app } = await boot();
        const response = await app.inject({
            method: 'PUT',
            url: '/api/workspace/repos',
            payload: { repos: [] },
        });
        expect(response.statusCode).toBe(401);
    });
});
