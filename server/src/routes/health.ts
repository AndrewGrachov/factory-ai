import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';

/**
 * Never calls GitHub, and never queries the database either: a container that is rate-limited, or
 * whose database is still starting, is still *healthy* — it is up and answering. Probing either
 * from here would make the compose healthcheck fail during the ~1 minute the migrations retry
 * through, and restart the container that was about to succeed.
 */
export const healthRoutes =
    (config: AppConfig): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/health', async () => ({
            status: 'ok',
            organization: config.orgId,
            uptimeSeconds: Math.floor(process.uptime()),
        }));
    };
