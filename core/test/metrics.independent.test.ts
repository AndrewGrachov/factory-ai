import { describe, expect, it } from 'vitest';
import { compute, deriveAll } from '../src/metrics.js';
import { FIXTURE_NOW, samplePayload } from './fixtures/load.js';

// Deliberately duplicated rather than imported: this file recomputes every number
// straight off the canonical payload so that a bug on either side shows up as a mismatch.
// Sharing helpers with metrics.ts would make a wrong number invisible.
//
// The raw-to-canonical half of the chain is covered independently by
// server/test/github.map.test.ts, which recomputes the same landmarks off the GitHub capture.
const BOTS = new Set([
    'claude',
    'claude[bot]',
    'github-actions',
    'github-actions[bot]',
    'bellows-frontend-fix-bot',
]);

const raw = samplePayload();
const stats = compute(deriveAll(raw), { baseBranch: 'dev', now: FIXTURE_NOW });

const mergedRaw = raw.filter((pr) => pr.mergedAt && pr.baseRef === 'dev');
const threadsRaw = mergedRaw.flatMap((pr) => pr.threads);

describe('independent recomputation off the canonical payload', () => {
    it('counts PRs the same way', () => {
        expect(stats.meta.counts.all).toBe(raw.length);
        expect(stats.meta.counts.mergedToBase).toBe(mergedRaw.length);
        expect(stats.meta.counts.open).toBe(raw.filter((pr) => pr.state === 'open').length);
        expect(stats.meta.counts.closedUnmerged).toBe(
            raw.filter((pr) => pr.state === 'closed').length,
        );
    });

    it('totals threads from the authoritative count, not the truncatable node list', () => {
        expect(stats.threads.total).toBe(mergedRaw.reduce((s, pr) => s + pr.threadCount, 0));
        expect(stats.threads.resolved).toBe(threadsRaw.filter((t) => t.isResolved).length);
    });

    it('splits threads by the first comment author', () => {
        const botAuthored = threadsRaw.filter((t) =>
            BOTS.has(t.firstCommentAuthor?.login ?? 'ghost'),
        ).length;
        expect(stats.threads.bot).toBe(botAuthored);
        expect(stats.threads.human).toBe(threadsRaw.length - botAuthored);
    });

    it('totals reviews the same way', () => {
        expect(stats.reviewers.reduce((s, r) => s + r.reviews, 0)).toBe(
            mergedRaw.reduce((s, pr) => s + pr.reviewCount, 0),
        );
    });

    it('counts sub-two-minute merges independently', () => {
        const instant = mergedRaw.filter(
            (pr) =>
                new Date(pr.mergedAt as string).getTime() - new Date(pr.createdAt).getTime() <
                2 * 60 * 1000,
        ).length;
        expect(stats.quality.instantMerges).toBe(instant);
    });
});

// SPEC.md §1 — measured against the live repo on 2026-08-21, not estimated. These pin the
// port to the numbers the reference implementation produced.
describe('SPEC §1 landmarks', () => {
    it('matches the measured headline figures', () => {
        expect(stats.meta.counts.all).toBe(203);
        expect(stats.meta.counts.mergedToBase).toBe(178);
        expect(stats.threads.total).toBe(654);
        expect(stats.threads.resolved).toBe(226);
        expect(stats.threads.bot).toBe(624);
        expect(stats.threads.human).toBe(30);
        expect(stats.quality.instantMerges).toBe(37);
        // SPEC rounds this to "154 LOC"; the exact median of an even-sized set is 153.5.
        expect(stats.headline.medianSize).toBe(153.5);
        expect(stats.size.medianChangedFiles).toBe(5);
    });

    it('reports the claude/human resolution gap', () => {
        const claude = stats.reviewers.find((r) => r.login === 'claude');
        expect(claude?.threads).toBe(624);
        expect(claude?.resolvedRatio).toBeCloseTo(0.325, 3);

        const humans = stats.reviewers.filter((r) => !r.isBot);
        expect(humans.reduce((s, r) => s + r.threads, 0)).toBe(30);
        // SPEC's "95% resolved" is AndrewGrachov's rate, not every human's: last731
        // resolves 4 of 10, pulling the pooled human rate down to 23/30.
        expect(humans.find((r) => r.login === 'AndrewGrachov')?.resolvedRatio).toBe(0.95);
        expect(humans.reduce((s, r) => s + r.resolved, 0)).toBe(23);
    });

    it('counts body-only reviews, which thread counts alone miss', () => {
        const andrew = stats.reviewers.find((r) => r.login === 'AndrewGrachov');
        expect(andrew?.bodyOnlyReviews).toBe(224);
        expect(andrew?.threads).toBe(20);
    });
});
