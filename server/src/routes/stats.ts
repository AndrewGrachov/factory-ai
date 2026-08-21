import { isRangePreset, resolveRange } from '@factory-ai/core';
import type { DateRange } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import type { StatsService } from '../stats-service.js';

interface RangeQuery {
    range?: string;
    from?: string;
    to?: string;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A bare `YYYY-MM-DD` is what `<input type="date">` submits. `to` is an exclusive bound, so a
 * day is widened to the start of the next one — otherwise "custom range: today to today" is an
 * empty interval and the dashboard reads as no activity.
 */
function parseBound(raw: string, edge: 'from' | 'to'): string | null {
    if (DAY_ONLY.test(raw)) {
        const day = new Date(`${raw}T00:00:00.000Z`);
        if (Number.isNaN(day.getTime())) return null;
        if (edge === 'to') day.setUTCDate(day.getUTCDate() + 1);
        return day.toISOString();
    }
    const at = new Date(raw);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

function parseRange(query: RangeQuery, now: Date): DateRange | { error: string } {
    const preset = query.range ?? 'all';
    if (!isRangePreset(preset)) return { error: `Unknown range '${preset}'` };
    if (preset !== 'custom') return resolveRange(preset, now);

    if (!query.from && !query.to) return { error: 'A custom range needs from, to, or both' };
    const from = query.from ? parseBound(query.from, 'from') : null;
    const to = query.to ? parseBound(query.to, 'to') : null;
    if (query.from && from === null) return { error: `Unparseable from '${query.from}'` };
    if (query.to && to === null) return { error: `Unparseable to '${query.to}'` };
    if (from !== null && to !== null && from >= to) return { error: 'from must precede to' };

    return { preset: 'custom', from, to };
}

export const statsRoutes =
    (service: StatsService, now: () => number = Date.now): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/stats', async (request, reply) => {
            const range = parseRange(request.query as RangeQuery, new Date(now()));
            if ('error' in range) {
                return reply.code(400).send({ error: range.error, code: 'BAD_RANGE' });
            }

            service.ensureFresh();
            const payload = service.current(range);

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
