import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';

/** Never calls GitHub: a container with no token, or one that is rate-limited, is still healthy. */
export const healthRoutes =
    (config: AppConfig): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/health', async () => ({
            status: 'ok',
            dataSource: config.dataSource,
            uptimeSeconds: Math.floor(process.uptime()),
        }));
    };
