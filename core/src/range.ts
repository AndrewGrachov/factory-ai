import type { DerivedPr, TelemetryInput } from './types.js';

export type RangePreset = 'day' | 'week' | '2w' | 'month' | 'all' | 'custom';

export const RANGE_PRESETS: RangePreset[] = ['day', 'week', '2w', 'month', 'all', 'custom'];

export interface DateRange {
    preset: RangePreset;
    /** Inclusive lower bound, ISO instant. null means unbounded. */
    from: string | null;
    /** Exclusive upper bound, ISO instant. null means unbounded. */
    to: string | null;
}

export const ALL_TIME: DateRange = { preset: 'all', from: null, to: null };

const DAY_MS = 86_400_000;

const PRESET_DAYS: Record<'day' | 'week' | '2w' | 'month', number> = {
    day: 1,
    week: 7,
    '2w': 14,
    month: 30,
};

export function isRangePreset(value: string): value is RangePreset {
    return (RANGE_PRESETS as string[]).includes(value);
}

/**
 * Presets are a rolling lookback from `now`, not a calendar period: "this week" on a Tuesday
 * would otherwise report two days and read as a throughput collapse.
 */
export function resolveRange(
    preset: RangePreset,
    now: Date,
    custom?: { from?: string | null; to?: string | null },
): DateRange {
    if (preset === 'all') return ALL_TIME;
    if (preset === 'custom') {
        return { preset, from: custom?.from ?? null, to: custom?.to ?? null };
    }
    return {
        preset,
        from: new Date(now.getTime() - PRESET_DAYS[preset] * DAY_MS).toISOString(),
        to: now.toISOString(),
    };
}

export function isAllTime(range: DateRange): boolean {
    return range.from === null && range.to === null;
}

function within(at: string, range: DateRange): boolean {
    if (range.from !== null && at < range.from) return false;
    if (range.to !== null && at >= range.to) return false;
    return true;
}

function overlaps(from: string, to: string, range: DateRange): boolean {
    if (range.from !== null && to < range.from) return false;
    if (range.to !== null && from >= range.to) return false;
    return true;
}

/**
 * Membership follows the timestamp each metric is already bucketed by: `weeklySeries()`
 * buckets merges by `mergedAt`, so a merged PR is in range when it *merged* in range, not
 * when it was opened. An open PR has no landing date, so it counts while it existed.
 */
export function filterPrs(prs: DerivedPr[], range: DateRange): DerivedPr[] {
    if (isAllTime(range)) return prs;
    return prs.filter((pr) => {
        if (pr.mergedAt) return within(pr.mergedAt, range);
        if (pr.state === 'OPEN') return range.to === null || pr.createdAt < range.to;
        return within(pr.createdAt, range);
    });
}

/**
 * Sessions and splits are intervals, so they are kept on overlap rather than containment: a
 * session running across the range boundary did real work inside the range, and dropping it
 * would understate usage exactly at the edge the user is looking at.
 *
 * `coverage` is deliberately untouched — it reports what the store holds, which is how the UI
 * distinguishes "no AI usage in this range" from "telemetry does not reach back this far".
 */
export function filterTelemetryInput(input: TelemetryInput, range: DateRange): TelemetryInput {
    if (isAllTime(range)) return input;

    const sessions = input.sessions.filter((s) => overlaps(s.firstSeen, s.lastSeen, range));
    const kept = new Set(sessions.map((s) => s.sessionId));

    return {
        sessions,
        spans: input.spans.filter((s) => kept.has(s.sessionId) && overlaps(s.from, s.to, range)),
        splits: input.splits.filter((s) => kept.has(s.sessionId) && overlaps(s.from, s.to, range)),
        links: input.links.filter((l) => kept.has(l.sessionId) && within(l.at, range)),
        coverage: input.coverage,
    };
}
