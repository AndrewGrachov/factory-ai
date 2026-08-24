import type { CanonicalPr } from '@factory-ai/core';
import type { ForgeClient } from '../forge.js';
import { FIXTURE_REPO, fixturePayload } from './fixture-payload.js';
import { GITHUB_CAPABILITIES, toCanonical } from './map.js';

export interface FixtureOptions {
    /** Stamped onto every PR. The committed JSON carries no repo identity of its own. */
    repo?: string;
}

/**
 * Serves the committed 203-PR payload so the app and every route test run with no token
 * and no rate-limit quota. Branch history is reported unavailable rather than zeroed —
 * the fixture has no commit history, and "0 reverts in 0 commits" reads as a real answer.
 *
 * It maps through `toCanonical()` rather than serving canonical records directly, so the
 * fixture path exercises the adapter instead of routing around it.
 */
export function createFixtureClient({ repo = FIXTURE_REPO }: FixtureOptions = {}): ForgeClient {
    let cached: CanonicalPr[] | null = null;
    const load = () => {
        if (!cached) cached = fixturePayload().map((pr) => toCanonical(pr, repo));
        return cached;
    };

    return {
        provider: 'github',
        capabilities: GITHUB_CAPABILITIES,

        async fetchPullRequests({ onProgress } = {}) {
            const prs = load();
            onProgress?.({ phase: 'prs', repo, prsFetched: prs.length });
            return {
                prs: structuredClone(prs),
                rateLimit: null,
                // A fixture walk always reaches the end of the list. Reporting otherwise would
                // pin the watermark, which matters if anyone ever wires this to a store.
                completed: { [repo]: true },
            };
        },

        async fetchBranchHistories() {
            return [{ repo, branch: 'dev', history: null, commits: [] }];
        },
    };
}
