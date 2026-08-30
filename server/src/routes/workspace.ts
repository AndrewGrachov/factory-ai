import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import { bad, body as jsonBody, guard } from './helpers.js';
import { fullName, type AppConfig, type Repo } from '../config.js';
import type { UserRepo, UserRepoStore } from '../db/user-repo-store.js';
import type { RepoSource } from '../github/repo-source.js';
import type { FactsCache } from '../workspace/facts.js';
import type { CloneQueue } from '../workspace/queue.js';
import { ensureUserWorkspace } from '../workspace/provision.js';
import { workspaceDir } from '../workspace/reconcile.js';

/**
 * A member's checkouts: what they picked, where each clone got to, and what is on disk.
 *
 * `PUT` rather than `POST` because the body is the WHOLE selection — replaying it changes nothing,
 * which is what makes the retry a browser does after a dropped connection safe.
 */

/**
 * A ceiling on how many repositories one person can check out.
 *
 * docs/workspace.md already admits that nothing prunes and that disk growth is unbounded and
 * unmonitored. Per-member checkouts multiply that by the number of members, so this is the one
 * bound there is — not a policy about what anybody needs, just a limit that keeps a single click
 * from cloning an entire GitHub organization onto a shared volume.
 */
export const MAX_REPOS_PER_USER = 20;

const BODY_LIMIT = 64 * 1024;

/**
 * The path-segment rules, applied where a name actually becomes a directory.
 *
 * These used to be `checkWorkspaceNames` in config.ts, run at boot against ORG_REPOS. That worked
 * while an operator typed the list; it cannot now, because the list comes from a GitHub App
 * installation and a name this rejects is one nobody here can rename. So the answer moved from "the
 * deployment will not boot" to "this one repository is refused, by name" — and `user_repo_name_ck`
 * says the same thing a third time, at the row.
 */
function badName(repo: Repo): string | null {
    for (const [label, value] of [
        ['owner', repo.owner],
        ['name', repo.name],
    ] as const) {
        if (!value) return `${label} is empty`;
        if (/[/\\]/.test(value)) return `${label} contains a path separator`;
        // A leading '-' is read by git as an option rather than a path; '.' and '..' are not names.
        if (/^[-.]/.test(value)) return `${label} starts with "-" or "."`;
    }
    return null;
}

function parseSelection(raw: unknown): Repo[] | string {
    const repos = jsonBody(raw).repos;
    if (!Array.isArray(repos)) return 'repos must be an array of { owner, name }';
    if (repos.length > MAX_REPOS_PER_USER) {
        return `at most ${MAX_REPOS_PER_USER} repositories can be checked out at once`;
    }
    const parsed: Repo[] = [];
    for (const entry of repos) {
        const item = entry as { owner?: unknown; name?: unknown };
        if (typeof item?.owner !== 'string' || typeof item?.name !== 'string') {
            return 'each entry must be { owner: string, name: string }';
        }
        parsed.push({ owner: item.owner, name: item.name });
    }
    return parsed;
}

export interface WorkspaceRoutesDeps {
    readonly config: AppConfig;
    readonly store: UserRepoStore;
    readonly repos: RepoSource;
    readonly facts: FactsCache;
    readonly queue: CloneQueue | null;
}

export const workspaceRoutes =
    ({ config, store, repos, facts, queue }: WorkspaceRoutesDeps): FastifyPluginAsync =>
    async (app) => {
        const root = config.workspaceRoot;

        const describe = (userId: string, row: UserRepo) => {
            // Only a `ready` checkout has anything on disk to read. Asking about one that is still
            // cloning would walk a half-written tree and report a size that means nothing.
            const onDisk =
                root && row.status === 'ready'
                    ? facts.get(join(workspaceDir(root, config.orgId, userId), row.name))
                    : { branch: null, lastCommit: null, sizeBytes: null };
            return {
                owner: row.owner,
                name: row.name,
                status: row.status,
                error: row.error,
                selectedAt: row.selectedAt,
                readyAt: row.readyAt,
                ...onDisk,
            };
        };

        app.get('/api/workspace', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);

            // 200 with a null root, never a 503. "Workspaces are switched off" is a configuration an
            // operator chose, and the page renders a sentence about it rather than an error.
            if (!root) return reply.code(200).send({ root: null, repos: [], orphaned: [] });

            const loaded = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                // Idempotent, and not redundant with the call in the sign-in callback: it covers
                // AUTH_MODE=none, whose caller never passes through that callback, and every
                // session that predates this deploy.
                ensureUserWorkspace({
                    root,
                    orgId: config.orgId,
                    userId: caller.user.id,
                    login: caller.user.login,
                    githubUserId: caller.user.githubUserId,
                });
                return Promise.all([store.list(caller.user.id), store.orphaned(caller.user.id)]);
            });
            if (!loaded.ok) return reply;

            const [selected, orphaned] = loaded.value;
            return reply.code(200).send({
                root: workspaceDir(root, config.orgId, caller.user.id),
                repos: selected.map((row) => describe(caller.user.id, row)),
                // Deselected, still on disk, nothing prunes them. Reported so that growth is at
                // least visible on the page rather than only in `df`.
                orphaned: orphaned.map((row) => ({ owner: row.owner, name: row.name })),
            });
        });

        app.put('/api/workspace/repos', { bodyLimit: BODY_LIMIT }, async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, 'UNAUTHENTICATED', 'Sign in required', 401);
            if (!root) {
                return bad(reply, 'WORKSPACE_DISABLED', 'This deployment has no workspace root configured', 409);
            }

            const selection = parseSelection(request.body);
            if (typeof selection === 'string') {
                const code = selection.startsWith('at most') ? 'TOO_MANY_REPOS' : 'BAD_BODY';
                return bad(reply, code, selection);
            }

            for (const repo of selection) {
                const reason = badName(repo);
                if (reason) {
                    return bad(
                        reply,
                        'BAD_REPO_NAME',
                        `"${repo.owner}/${repo.name}" cannot become a directory: ${reason}`,
                    );
                }
            }

            // The checkout directory is the bare repo name, so two owners' same-named repositories
            // are one directory. Refused here by name rather than discovered as a unique-index
            // violation, which would surface as a 503.
            const byName = new Map<string, string>();
            for (const repo of selection) {
                const first = byName.get(repo.name);
                if (first) {
                    return bad(
                        reply,
                        'REPO_NAME_CONFLICT',
                        `"${first}/${repo.name}" and "${repo.owner}/${repo.name}" share the checkout directory "${repo.name}"`,
                    );
                }
                byName.set(repo.name, repo.owner);
            }

            /*
             * Every selected repo must be one the installation can actually see.
             *
             * Not a formality: the clone uses the App's installation token, so a repository outside
             * the installation is one this deployment has no business fetching — and accepting the
             * name would write a row that fails on every retry with a 404.
             */
            const available = new Set((await repos.list()).map(fullName));
            // An unreachable installation is refused rather than waved through. The list is empty
            // in two very different situations — nothing is installed, or GitHub could not be
            // asked — and only the first is a state in which "no repository matches" is true.
            if (!available.size && repos.lastError()) {
                return reply.code(503).send({
                    error: `Cannot check the selection against the GitHub App installation: ${repos.lastError()}`,
                    code: 'UNAVAILABLE',
                });
            }
            for (const repo of selection) {
                if (available.has(`${repo.owner}/${repo.name}`)) continue;
                return bad(
                    reply,
                    'UNKNOWN_REPO',
                    `"${repo.owner}/${repo.name}" is not one of the repositories this GitHub App installation can see`,
                );
            }

            const saved = await guard(reply, (e) => request.log.error({ err: e }), async () => {
                ensureUserWorkspace({
                    root,
                    orgId: config.orgId,
                    userId: caller.user.id,
                    login: caller.user.login,
                    githubUserId: caller.user.githubUserId,
                });
                await store.select(caller.user.id, selection);
            });
            if (!saved.ok) return reply;

            // 202, and the clones run in the background: a clone is minutes, and a request that
            // waited for one would be killed by any proxy in front of it long before it finished.
            queue?.kick();
            return reply.code(202).send({ repos: selection });
        });
    };
