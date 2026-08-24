import { describe, expect, it } from 'vitest';
import { compute, deriveAll } from '@factory-ai/core';
import { FIXTURE_REPO, fixturePayload } from '../src/github/fixture-payload.js';
import { GITHUB_CAPABILITIES, toCanonical } from '../src/github/map.js';

/**
 * The raw-to-canonical seam.
 *
 * core/test/metrics.independent.test.ts used to recompute the SPEC §1 landmarks straight off the
 * GitHub payload, which covered `derive()` and the response mapping in one pass. Now that `core`
 * speaks CanonicalPr the seam moved here, so this file holds the other half: every number below
 * is recomputed off the RAW capture and asserted against what the mapped records produce.
 *
 * If any of these landmarks moves, the adapter is wrong. Do not adjust the expectation.
 */

const raw = fixturePayload();
const canonical = raw.map((pr) => toCanonical(pr, FIXTURE_REPO));
const stats = compute(deriveAll(canonical, undefined, GITHUB_CAPABILITIES), {
    baseBranch: 'dev',
    now: new Date('2026-08-21T12:00:00.000Z'),
});

const mergedRaw = raw.filter((pr) => pr.mergedAt && pr.baseRefName === 'dev');

describe('toCanonical, recomputed off the raw GitHub capture', () => {
    it('carries every PR across', () => {
        expect(canonical).toHaveLength(raw.length);
        expect(stats.meta.counts.all).toBe(203);
        expect(stats.meta.counts.mergedToBase).toBe(mergedRaw.length);
        expect(stats.meta.counts.mergedToBase).toBe(178);
    });

    it('keeps the authoritative totals, not the node-list lengths', () => {
        expect(stats.threads.total).toBe(
            mergedRaw.reduce((s, pr) => s + pr.reviewThreads.totalCount, 0),
        );
        expect(stats.threads.total).toBe(654);
        expect(stats.reviewers.reduce((s, r) => s + r.reviews, 0)).toBe(
            mergedRaw.reduce((s, pr) => s + pr.reviews.totalCount, 0),
        );
    });

    it('splits threads by the raw first-comment author', () => {
        const bots = new Set([
            'claude',
            'claude[bot]',
            'github-actions',
            'github-actions[bot]',
            'leeloo-frontend-fix-bot',
        ]);
        const threads = mergedRaw.flatMap((pr) => pr.reviewThreads.nodes);
        const bot = threads.filter((t) => bots.has(t.comments.nodes[0]?.author?.login ?? 'ghost')).length;
        expect(stats.threads.bot).toBe(bot);
        expect(stats.threads.bot).toBe(624);
        expect(stats.threads.human).toBe(30);
        expect(stats.threads.resolved).toBe(226);
    });

    it('reproduces the remaining SPEC §1 landmarks', () => {
        expect(stats.quality.instantMerges).toBe(37);
        expect(stats.headline.medianSize).toBe(153.5);
        expect(stats.size.medianChangedFiles).toBe(5);
        expect(stats.reviewers.find((r) => r.login === 'claude')?.resolvedRatio).toBeCloseTo(0.325, 3);
        expect(stats.reviewers.find((r) => r.login === 'AndrewGrachov')?.bodyOnlyReviews).toBe(224);
    });

    it('maps every review state without falling back to a passthrough string', () => {
        const states = new Set(canonical.flatMap((pr) => pr.reviews.map((r) => r.state)));
        for (const state of states) {
            expect(['pending', 'commented', 'approved', 'changes_requested', 'dismissed']).toContain(state);
        }
        // The verbatim provider string survives beside the neutral one, for audit.
        const sample = canonical.flatMap((pr) => pr.reviews)[0];
        expect(sample?.providerState).toBe(sample?.providerState.toUpperCase());
    });

    it('rejects a review state it does not know, rather than passing it through', () => {
        const [first] = structuredClone(raw);
        const pr = first as (typeof raw)[number];
        pr.reviews.nodes = [{ id: 'r1', author: null, state: 'ENDORSED', submittedAt: null }];
        expect(() => toCanonical(pr, FIXTURE_REPO)).toThrow(/Unknown GitHub review state/);
    });

    it('counts force pushes from the filtered node list, never a connection total', () => {
        // timelineItems.totalCount ignores itemTypes and once reported 404 across 14 PRs, so a
        // total would be wildly wrong here while still looking like a number.
        for (const [i, pr] of raw.entries()) {
            expect(canonical[i]?.forcePushCount).toBe(pr.forcePushes.nodes.length);
        }
    });

    it('reports truncation from the gap between a count and its node list', () => {
        for (const [i, pr] of raw.entries()) {
            const mapped = canonical[i] as (typeof canonical)[number];
            expect(mapped.truncated.includes('reviews')).toBe(
                pr.reviews.nodes.length < pr.reviews.totalCount,
            );
            expect(mapped.truncated.includes('commits')).toBe(
                pr.commits.nodes.length < pr.commits.totalCount,
            );
        }
    });
});
