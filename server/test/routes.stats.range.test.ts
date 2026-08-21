import { beforeAll, describe, expect, it } from 'vitest';
import type { StatsPayload } from '../src/stats-service.js';
import { harness, stubClient } from './helpers.js';

/** The fixture is captured at this instant, and the harness clock is pinned to it. */
const NOW = '2026-08-21T12:00:00.000Z';

describe('GET /api/stats ranges', () => {
    let app: Awaited<ReturnType<typeof harness>>['app'];

    beforeAll(async () => {
        const h = await harness({ client: stubClient() });
        app = h.app;
        h.service.refresh();
        await h.settle();
    });

    const get = async (query: string) => {
        const res = await app.inject({ method: 'GET', url: `/api/stats?${query}` });
        return { status: res.statusCode, body: res.json() };
    };

    it('serves the full window when no range is given, unchanged from before', async () => {
        const { status, body } = await get('');
        expect(status).toBe(200);
        expect((body as StatsPayload).meta.range).toEqual({ preset: 'all', from: null, to: null });
    });

    it('echoes the resolved bounds of a preset so the UI never re-derives them', async () => {
        const { body } = await get('range=week');
        expect((body as StatsPayload).meta.range).toEqual({
            preset: 'week',
            from: '2026-08-14T12:00:00.000Z',
            to: NOW,
        });
    });

    it('narrows every metric, not just the weekly series', async () => {
        const all = (await get('range=all')).body as StatsPayload;
        const month = (await get('range=month')).body as StatsPayload;

        expect(month.stats.meta.counts.mergedToBase).toBeLessThan(all.stats.meta.counts.mergedToBase);
        expect(month.stats.weekly.length).toBeLessThan(all.stats.weekly.length);
        expect(month.stats.authors.length).toBeLessThanOrEqual(all.stats.authors.length);
        // The headline is recomputed, not carried over from the full window.
        expect(month.stats.headline.medianSize).not.toBe(all.stats.headline.medianSize);
    });

    it('nests each range inside the wider one', async () => {
        const day = (await get('range=day')).body as StatsPayload;
        const week = (await get('range=week')).body as StatsPayload;
        const all = (await get('range=all')).body as StatsPayload;

        expect(day.stats.meta.counts.mergedToBase).toBeLessThanOrEqual(week.stats.meta.counts.mergedToBase);
        expect(week.stats.meta.counts.mergedToBase).toBeLessThanOrEqual(all.stats.meta.counts.mergedToBase);
    });

    it('degrades the revert rate rather than reporting a full-window figure beside range metrics', async () => {
        const all = (await get('range=all')).body as StatsPayload;
        expect(all.meta.revert.status).toBe('ok');
        expect(all.stats.quality.history).not.toBeNull();

        const week = (await get('range=week')).body as StatsPayload;
        expect(week.meta.revert.status).toBe('unavailable');
        expect(week.meta.revert.reason).toMatch(/full fetch window/);
        // Never {commits: 0, reverts: 0} — that reads as a measured zero.
        expect(week.stats.quality.history).toBeNull();
        expect(week.stats.quality.revertRatio).toBeNull();
    });

    it('narrows telemetry with the same range', async () => {
        const all = (await get('range=all')).body as StatsPayload;
        const day = (await get('range=day')).body as StatsPayload;
        expect(all.telemetry).not.toBeNull();
        expect(day.telemetry?.totals.sessions ?? 0).toBeLessThanOrEqual(
            all.telemetry?.totals.sessions ?? 0,
        );
        // Coverage reports what the store holds, so it must not shrink with the selection.
        expect(day.telemetry?.coverage).toEqual(all.telemetry?.coverage);
    });

    it('accepts a bare calendar day and treats `to` as the end of that day', async () => {
        const { status, body } = await get('range=custom&from=2026-08-01&to=2026-08-07');
        expect(status).toBe(200);
        expect((body as StatsPayload).meta.range).toEqual({
            preset: 'custom',
            from: '2026-08-01T00:00:00.000Z',
            to: '2026-08-08T00:00:00.000Z',
        });
    });

    it('supports a single-day custom range without it collapsing to nothing', async () => {
        const { body } = await get('range=custom&from=2026-08-20&to=2026-08-20');
        const range = (body as StatsPayload).meta.range;
        expect(range.from).toBe('2026-08-20T00:00:00.000Z');
        expect(range.to).toBe('2026-08-21T00:00:00.000Z');
    });

    it('accepts a half-open custom range', async () => {
        const { status, body } = await get('range=custom&from=2026-08-01');
        expect(status).toBe(200);
        expect((body as StatsPayload).meta.range.to).toBeNull();
    });

    it('rejects a bad range with 400, never a silent fallback to all time', async () => {
        for (const query of [
            'range=fortnight',
            'range=custom',
            'range=custom&from=yesterday',
            'range=custom&from=2026-08-10&to=2026-08-01',
        ]) {
            const { status, body } = await get(query);
            expect(status, query).toBe(400);
            expect((body as { code: string }).code).toBe('BAD_RANGE');
        }
    });

    it('serves every range from the one fetch the rate-limit budget paid for', async () => {
        const h = await harness({ client: stubClient() });
        h.service.refresh();
        await h.settle();
        for (const preset of ['day', 'week', '2w', 'month', 'all']) {
            const res = await h.app.inject({ method: 'GET', url: `/api/stats?range=${preset}` });
            expect(res.statusCode).toBe(200);
        }
        expect(h.client.prCalls).toBe(1);
    });
});
