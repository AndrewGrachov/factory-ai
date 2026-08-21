import type { FastifyPluginAsync } from 'fastify';
import type { StatsService } from '../stats-service.js';

export const statsRoutes =
    (service: StatsService): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/stats', async (_request, reply) => {
            service.ensureFresh();
            const payload = service.current();

            // A stale cache is still served with 200. A rate limit must keep the last
            // good render on screen and explain itself, not blank the dashboard.
            if (payload) return reply.code(200).send(payload);

            const fetch = service.fetchState();
            if (fetch.state === 'error') {
                return reply.code(503).send({
                    error: fetch.error?.message ?? 'Fetch failed',
                    code: fetch.error?.code ?? 'UNKNOWN',
                    fetch,
                });
            }
            // Cold start: the first fetch takes ~45s, so answer 202 and let the client poll.
            return reply.code(202).send({ fetch });
        });

        app.post('/api/refresh', async (_request, reply) => {
            service.refresh();
            return reply.code(202).send({ fetch: service.fetchState() });
        });
    };
