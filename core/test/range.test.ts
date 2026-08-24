import { describe, expect, it } from 'vitest';
import { ALL_TIME, filterPrs, filterTelemetryInput, isAllTime, resolveRange } from '../src/range.js';
import type { DateRange } from '../src/range.js';
import type { DerivedPr, TelemetryInput } from '../src/types.js';

const NOW = new Date('2026-08-21T12:00:00.000Z');

function pr(over: Partial<DerivedPr>): DerivedPr {
    return {
        number: 1,
        title: 't',
        author: 'a',
        authorIsBot: false,
        baseRefName: 'dev',
        headRefName: 'feat',
        state: 'merged',
        createdAt: '2026-08-01T00:00:00.000Z',
        mergedAt: '2026-08-02T00:00:00.000Z',
        labels: [],
        hasAiLabel: false,
        additions: 1,
        deletions: 0,
        size: 1,
        changedFiles: 1,
        commitCount: 1,
        issueComments: 0,
        reviewCount: 0,
        reviews: [],
        bodyOnlyReviewCount: 0,
        threads: {
            total: 0, threads: [], bot: 0, human: 0, resolved: 0,
            unresolvedOutdated: 0, unresolvedLive: 0,
        },
        forcePushes: 0,
        readyAt: null,
        firstReviewAt: null,
        firstHumanReviewAt: null,
        commitsAfterAnyReview: 0,
        commitsAfterHumanReview: 0,
        cycleHours: null,
        cycleFromReadyHours: null,
        firstReviewWaitHours: null,
        firstHumanReviewWaitHours: null,
        lastCommitToMergeHours: null,
        ...over,
    };
}

const august: DateRange = {
    preset: 'custom',
    from: '2026-08-10T00:00:00.000Z',
    to: '2026-08-20T00:00:00.000Z',
};

describe('resolveRange', () => {
    it('makes presets a rolling lookback from now, not a calendar period', () => {
        expect(resolveRange('day', NOW)).toEqual({
            preset: 'day',
            from: '2026-08-20T12:00:00.000Z',
            to: '2026-08-21T12:00:00.000Z',
        });
        expect(resolveRange('2w', NOW).from).toBe('2026-08-07T12:00:00.000Z');
        expect(resolveRange('month', NOW).from).toBe('2026-07-22T12:00:00.000Z');
    });

    it('leaves all-time unbounded on both ends', () => {
        expect(resolveRange('all', NOW)).toEqual(ALL_TIME);
        expect(isAllTime(resolveRange('all', NOW))).toBe(true);
    });

    it('keeps a half-open custom range half-open', () => {
        expect(resolveRange('custom', NOW, { from: '2026-08-01T00:00:00.000Z' })).toEqual({
            preset: 'custom',
            from: '2026-08-01T00:00:00.000Z',
            to: null,
        });
    });
});

describe('filterPrs', () => {
    it('returns the same array for all-time rather than a filtered copy', () => {
        const prs = [pr({})];
        expect(filterPrs(prs, ALL_TIME)).toBe(prs);
    });

    it('places a merged PR by mergedAt, not createdAt', () => {
        // Opened long before the range, merged inside it: weeklySeries() buckets this merge
        // inside the range, so excluding it would blank the throughput chart.
        const late = pr({ number: 1, createdAt: '2026-07-01T00:00:00.000Z', mergedAt: '2026-08-12T00:00:00.000Z' });
        const early = pr({ number: 2, createdAt: '2026-08-11T00:00:00.000Z', mergedAt: '2026-08-25T00:00:00.000Z' });
        expect(filterPrs([late, early], august).map((p) => p.number)).toEqual([1]);
    });

    it('treats the bounds as inclusive from, exclusive to', () => {
        const on = pr({ number: 1, mergedAt: august.from as string });
        const off = pr({ number: 2, mergedAt: august.to as string });
        expect(filterPrs([on, off], august).map((p) => p.number)).toEqual([1]);
    });

    it('keeps an open PR that existed by the end of the range', () => {
        const opened = pr({ number: 1, state: 'open', mergedAt: null, createdAt: '2026-07-01T00:00:00.000Z' });
        const later = pr({ number: 2, state: 'open', mergedAt: null, createdAt: '2026-08-25T00:00:00.000Z' });
        expect(filterPrs([opened, later], august).map((p) => p.number)).toEqual([1]);
    });

    it('places a closed unmerged PR by createdAt, having no landing date', () => {
        const inside = pr({ number: 1, state: 'closed', mergedAt: null, createdAt: '2026-08-12T00:00:00.000Z' });
        const outside = pr({ number: 2, state: 'closed', mergedAt: null, createdAt: '2026-07-12T00:00:00.000Z' });
        expect(filterPrs([inside, outside], august).map((p) => p.number)).toEqual([1]);
    });
});

describe('filterTelemetryInput', () => {
    const input: TelemetryInput = {
        sessions: [
            {
                sessionId: 'inside', agent: 'claude-code', repo: 'o/r',
                firstSeen: '2026-08-11T00:00:00.000Z', lastSeen: '2026-08-11T01:00:00.000Z',
                tokens: { input: 10, output: 5, cacheRead: null, cacheCreation: null },
                linesAdded: 1, linesRemoved: 0, editsAccepted: 1, editsRejected: 0,
                activeSeconds: 60, commits: 1, pullRequests: 1, granularity: 'window',
            },
            {
                sessionId: 'straddles', agent: 'claude-code', repo: 'o/r',
                firstSeen: '2026-08-09T00:00:00.000Z', lastSeen: '2026-08-10T06:00:00.000Z',
                tokens: { input: 1, output: 1, cacheRead: null, cacheCreation: null },
                linesAdded: 0, linesRemoved: 0, editsAccepted: 0, editsRejected: 0,
                activeSeconds: 1, commits: 0, pullRequests: 0, granularity: 'window',
            },
            {
                sessionId: 'before', agent: 'claude-code', repo: 'o/r',
                firstSeen: '2026-07-01T00:00:00.000Z', lastSeen: '2026-07-01T01:00:00.000Z',
                tokens: { input: 99, output: 99, cacheRead: null, cacheCreation: null },
                linesAdded: 0, linesRemoved: 0, editsAccepted: 0, editsRejected: 0,
                activeSeconds: 1, commits: 0, pullRequests: 0, granularity: 'window',
            },
        ],
        spans: [
            { sessionId: 'inside', repo: 'o/r', branch: 'feat', headSha: null, from: '2026-08-11T00:00:00.000Z', to: '2026-08-11T01:00:00.000Z', samples: 3 },
            { sessionId: 'before', repo: 'o/r', branch: 'old', headSha: null, from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T01:00:00.000Z', samples: 3 },
        ],
        splits: [
            { sessionId: 'inside', branch: 'feat', from: '2026-08-11T00:00:00.000Z', to: '2026-08-11T01:00:00.000Z', share: 1, tokens: { input: 10, output: 5, cacheRead: null, cacheCreation: null }, linesAdded: 1, linesRemoved: 0, editsAccepted: 1, editsRejected: 0, activeSeconds: 60 },
            { sessionId: 'before', branch: 'old', from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T01:00:00.000Z', share: 1, tokens: { input: 99, output: 99, cacheRead: null, cacheCreation: null }, linesAdded: 0, linesRemoved: 0, editsAccepted: 0, editsRejected: 0, activeSeconds: 1 },
        ],
        links: [
            { sessionId: 'inside', repo: 'o/r', prNumber: 7, at: '2026-08-11T00:30:00.000Z' },
            { sessionId: 'before', repo: 'o/r', prNumber: 3, at: '2026-07-01T00:30:00.000Z' },
        ],
        coverage: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-21T00:00:00.000Z' },
    };

    it('keeps a session that overlaps the range, not only one contained by it', () => {
        const out = filterTelemetryInput(input, august);
        expect(out.sessions.map((s) => s.sessionId)).toEqual(['inside', 'straddles']);
    });

    it('drops the spans, splits and links of excluded sessions', () => {
        const out = filterTelemetryInput(input, august);
        expect(out.spans.map((s) => s.sessionId)).toEqual(['inside']);
        expect(out.splits.map((s) => s.sessionId)).toEqual(['inside']);
        expect(out.links.map((l) => l.prNumber)).toEqual([7]);
    });

    it('leaves coverage alone, so "no usage in range" stays distinct from "no data that far back"', () => {
        expect(filterTelemetryInput(input, august).coverage).toEqual(input.coverage);
    });
});
