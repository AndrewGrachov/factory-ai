import { describe, expect, it } from 'vitest';
import type { CanonicalPr, ProviderCapabilities } from '../src/canonical.js';
import { compute, deriveAll } from '../src/metrics.js';
import { FIXTURE_NOW, samplePayload } from './fixtures/load.js';

/**
 * What a provider cannot observe must read as unavailable, never as zero.
 *
 * These are the two fields where the difference is invisible in the data: a force-push count of
 * 0 asserts a clean history that was never measured, and a body-only review count of 0 asserts
 * that a reviewer always left line comments. Both are claims about the work rather than about
 * the source.
 */

const capabilities = (over: Partial<ProviderCapabilities>): ProviderCapabilities => ({
    reviewLinkage: true,
    ...over,
});

const payload = samplePayload();
const options = { baseBranch: 'dev', now: FIXTURE_NOW };

function noNaN(value: unknown, path = 'stats'): string[] {
    if (typeof value === 'number' && Number.isNaN(value)) return [path];
    if (Array.isArray(value)) return value.flatMap((v, i) => noNaN(v, `${path}[${i}]`));
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => noNaN(v, `${path}.${k}`));
    }
    return [];
}

describe('provider capabilities', () => {
    it('reports the force-push total as null, not 0 and not NaN, when unobservable', () => {
        const blind: CanonicalPr[] = payload.map((pr) => ({ ...pr, forcePushCount: null }));
        const stats = compute(deriveAll(blind), options);

        expect(stats.rework.forcePushes).toBeNull();
        // A plain reduce over nulls yields NaN, which renders as the literal string "NaN".
        expect(noNaN(stats)).toEqual([]);
    });

    it('is all-or-nothing: one blind PR nulls the combined total', () => {
        const mixed = payload.map((pr, i) => (i === 0 ? { ...pr, forcePushCount: null } : pr));
        // The first PR is merged to dev in the capture, so it is in scope for the total.
        expect(mixed[0]?.mergedAt).not.toBeNull();
        expect(compute(deriveAll(mixed), options).rework.forcePushes).toBeNull();
    });

    it('nulls the body-only column rather than counting every review as body-only', () => {
        const stats = compute(deriveAll(payload, undefined, capabilities({ reviewLinkage: false })), options);

        expect(stats.reviewers.length).toBeGreaterThan(0);
        for (const reviewer of stats.reviewers) {
            expect(reviewer.bodyOnlyReviews).toBeNull();
            // Everything that does not depend on linkage keeps working.
            expect(reviewer.reviews).toBeGreaterThanOrEqual(0);
        }
        expect(noNaN(stats)).toEqual([]);
    });

    it('still counts body-only reviews when linkage is available', () => {
        const stats = compute(deriveAll(payload, undefined, capabilities({})), options);
        expect(stats.reviewers.find((r) => r.login === 'AndrewGrachov')?.bodyOnlyReviews).toBe(224);
    });

    it('derives meta.truncated from the PRs in scope, not from a side channel', () => {
        const [first, second] = payload;
        const cut: CanonicalPr[] = [
            { ...(first as CanonicalPr), truncated: ['reviews'] },
            ...payload.slice(1),
        ];
        const stats = compute(deriveAll(cut), options);

        expect(stats.meta.truncated).toEqual([
            { repo: (first as CanonicalPr).repo, number: (first as CanonicalPr).number, connections: ['reviews'] },
        ]);
        // And a PR that is out of scope cannot drag its caveat in.
        expect(second).toBeDefined();
    });
});
