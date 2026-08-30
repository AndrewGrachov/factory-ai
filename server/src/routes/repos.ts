import type { FastifyPluginAsync } from 'fastify';
import type { RepoSource } from '../github/repo-source.js';

/**
 * What the App installation can see, for the repository picker.
 *
 * A route rather than a field on `/api/stats`'s `meta`, even though both describe repositories, and
 * the distinction is worth keeping straight: `meta.repos` is what the figures on the page were
 * *measured over*, while this is what a member could *choose to check out*. They come from the same
 * installation today and could still diverge tomorrow, and conflating them would make the picker's
 * contents depend on a stats fetch having succeeded.
 */
export const repoRoutes =
    (repos: RepoSource): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/repos', async (_request, reply) => {
            const { repos: list, installation } = await repos.detail();
            const error = repos.lastError();

            // 200 with a named error and the last good list, never 503. Same rule /api/stats
            // follows: a failed refresh must keep the last good answer on screen and explain
            // itself, because an empty picker and an unreachable GitHub look identical otherwise.
            return reply.code(200).send({
                repos: list.map((repo) => ({
                    owner: repo.owner,
                    name: repo.name,
                    private: repo.private,
                    defaultBranch: repo.defaultBranch,
                    pushedAt: repo.pushedAt,
                })),
                installation,
                meta: {
                    fetchedAt: repos.fetchedAt() === null ? null : new Date(repos.fetchedAt()!).toISOString(),
                    // An empty list with no error is a real state, and the SPA renders a different
                    // thing for it: the App is installed nowhere, or on no repositories yet.
                    error,
                },
            });
        });
    };
