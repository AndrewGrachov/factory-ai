import { readFileSync } from 'node:fs';
import type { RawPullRequest } from '@factory-ai/core';
import type { GitHubClient } from './client.js';

const FIXTURE = new URL('../../../core/test/fixtures/sample-payload.json', import.meta.url);

/** The repo the committed payload was actually captured from. */
export const FIXTURE_REPO = 'Leeloo-AI-RGA-OS/leeloo.ai';

export interface FixtureOptions {
    /** Stamped onto every PR. The committed JSON carries no repo identity of its own. */
    repo?: string;
    path?: URL;
}

/**
 * Serves the committed 203-PR payload so the app and every route test run with no token
 * and no rate-limit quota. Branch history is reported unavailable rather than zeroed —
 * the fixture has no commit history, and "0 reverts in 0 commits" reads as a real answer.
 */
export function createFixtureClient({ repo = FIXTURE_REPO, path = FIXTURE }: FixtureOptions = {}): GitHubClient {
    let cached: RawPullRequest[] | null = null;
    const load = () => {
        if (!cached) cached = JSON.parse(readFileSync(path, 'utf8')) as RawPullRequest[];
        return cached;
    };

    return {
        async fetchPullRequests({ onProgress } = {}) {
            const prs = load();
            onProgress?.({ phase: 'prs', repo, prsFetched: prs.length });
            return {
                // Stamped here for the same reason the live client stamps it: the payload has no
                // repo identity, and every PR in this one came from a single capture.
                prs: structuredClone(prs).map((pr) => ({ ...pr, repo })),
                truncated: [],
                rateLimit: null,
            };
        },
        async fetchBranchHistories() {
            return [{ repo, history: null }];
        },
    };
}
