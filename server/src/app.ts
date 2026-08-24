import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from './config.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { statsRoutes } from './routes/stats.js';
import type { StatsService } from './stats-service.js';
import type { TelemetryStore } from './telemetry/store.js';

export interface AppDeps {
    config: AppConfig;
    service: StatsService;
    /** Absent unless there is somewhere to write, so the ingest routes simply do not exist. */
    store?: TelemetryStore | undefined;
    /** Preset ranges are a lookback from now, so the routes need the same injection point. */
    now?: () => number;
    logger?: boolean;
}

// Set as a response header rather than a <meta> tag so dev can allow the Vite HMR
// websocket without a different index.html.
function csp(dev: boolean): string {
    const connect = dev ? "'self' ws:" : "'self'";
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        `connect-src ${connect}`,
        "img-src 'self' data:",
        "font-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

/** No `listen` here — that split is what lets the route tests drive the app in-process. */
export async function buildApp({
    config,
    service,
    store,
    now = Date.now,
    logger = false,
}: AppDeps): Promise<FastifyInstance> {
    const app = Fastify({ logger });

    const header = csp(config.webRoot === null);
    app.addHook('onSend', async (_request, reply) => {
        reply.header('Content-Security-Policy', header);
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'no-referrer');
    });

    await app.register(healthRoutes(config));
    await app.register(statsRoutes(config, service, now));
    if (store) await app.register(ingestRoutes(store));

    if (config.webRoot) {
        const { default: fastifyStatic } = await import('@fastify/static');
        await app.register(fastifyStatic, { root: config.webRoot });
        app.setNotFoundHandler(async (request, reply) => {
            if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
            return reply.sendFile('index.html');
        });
    }

    return app;
}
