import { describe, expect, it } from 'vitest';
import { compute, deriveAll, isoWeekKey, percentile } from '../src/metrics.js';
import { FIXTURE_NOW, samplePayload } from './fixtures/load.js';

const raw = samplePayload();
const stats = compute(deriveAll(raw), { baseBranch: 'dev', now: FIXTURE_NOW });

const merged = raw.filter((pr) => pr.mergedAt && pr.baseRefName === 'dev').length;
const threadNodes = raw
    .filter((pr) => pr.mergedAt && pr.baseRefName === 'dev')
    .flatMap((pr) => pr.reviewThreads.nodes).length;

// Invariants a plausible-but-wrong aggregation would violate. SPEC.md §5.2.
describe('aggregation invariants', () => {
    it('every distribution sums to the merged PR count', () => {
        expect(stats.size.histogram.reduce((s, b) => s + b.count, 0)).toBe(merged);
        expect(stats.commitsHistogram.reduce((s, b) => s + b.count, 0)).toBe(merged);
        expect(stats.weekly.reduce((s, w) => s + w.merges, 0)).toBe(merged);
        expect(stats.authors.reduce((s, a) => s + a.merged, 0)).toBe(merged);
        expect(stats.quality.mergedPrs).toBe(merged);
    });

    it('resolved never exceeds total', () => {
        expect(stats.threads.resolved).toBeLessThanOrEqual(stats.threads.total);
        for (const r of stats.reviewers) expect(r.resolved).toBeLessThanOrEqual(r.threads);
    });

    it('the bot/human and resolution splits partition the node list', () => {
        expect(stats.threads.bot + stats.threads.human).toBe(threadNodes);
        expect(
            stats.threads.resolved + stats.threads.unresolvedOutdated + stats.threads.unresolvedLive,
        ).toBe(threadNodes);
    });

    it('p50 never exceeds p90', () => {
        expect(stats.cycle.p50).not.toBeNull();
        expect(stats.cycle.p50 as number).toBeLessThanOrEqual(stats.cycle.p90 as number);
    });

    it('human rework never exceeds rework after any review', () => {
        expect(stats.rework.afterHumanReview).toBeLessThanOrEqual(stats.rework.afterAnyReview);
        expect(stats.rework.prsWithHumanReview).toBeLessThanOrEqual(stats.rework.prsWithAnyReview);
    });

    it('every ratio is null or within [0,1]', () => {
        const ratios = [
            stats.headline.unresolvedThreadRatio,
            stats.headline.reworkAfterAnyReview,
            stats.headline.reworkAfterHumanReview,
            stats.quality.revertRatio,
            ...stats.reviewers.map((r) => r.resolvedRatio),
            ...stats.authors.map((a) => a.reworkRatio),
            ...stats.authors.map((a) => a.unresolvedRatio),
        ];
        for (const r of ratios) {
            if (r === null) continue;
            expect(r).toBeGreaterThanOrEqual(0);
            expect(r).toBeLessThanOrEqual(1);
        }
    });

    it('contains no NaN anywhere', () => {
        const bad: string[] = [];
        const walk = (value: unknown, path: string) => {
            if (typeof value === 'number' && Number.isNaN(value)) bad.push(path);
            else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
            else if (value && typeof value === 'object') {
                for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
            }
        };
        walk(stats, 'stats');
        expect(bad).toEqual([]);
    });

    it('emits a contiguous week series rather than closing the gaps', () => {
        expect(stats.weekly).toHaveLength(21);
        const gaps = stats.weekly
            .map((w) => new Date(w.start).getTime())
            .map((t, i, all) => (i === 0 ? 7 : (t - (all[i - 1] as number)) / 86_400_000));
        expect(gaps.every((g) => g === 7)).toBe(true);
    });

    it('reports revert rate as null rather than zero when history is absent', () => {
        expect(stats.quality.history).toBeNull();
        expect(stats.quality.revertRatio).toBeNull();
    });
});

describe('pure helpers', () => {
    it('returns null on an empty percentile rather than 0', () => {
        expect(percentile([], 50)).toBeNull();
    });

    it('interpolates between ranks', () => {
        expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
        expect(percentile([10], 90)).toBe(10);
    });

    it('puts the year boundary in the ISO week that owns the Thursday', () => {
        expect(isoWeekKey('2025-12-29T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-04T00:00:00Z')).toBe('2026-W01');
        expect(isoWeekKey('2026-01-05T00:00:00Z')).toBe('2026-W02');
    });

    it('falls back to ghost for a deleted author', () => {
        const orphan = { ...(raw[0] as (typeof raw)[number]), author: null };
        expect(deriveAll([orphan])[0]?.author).toBe('ghost');
    });
});
