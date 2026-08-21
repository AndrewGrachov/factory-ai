import { readFileSync } from 'node:fs';
import type { RawPullRequest } from '@factory-ai/core';
import type { GitHubClient } from './client.js';

const FIXTURE = new URL('../../../core/test/fixtures/sample-payload.json', import.meta.url);

/**
 * Serves the committed 203-PR payload so the app and every route test run with no token
 * and no rate-limit quota. Branch history is reported unavailable rather than zeroed —
 * the fixture has no commit history, and "0 reverts in 0 commits" reads as a real answer.
 */
export function createFixtureClient(path: URL = FIXTURE): GitHubClient {
    let cached: RawPullRequest[] | null = null;
    const load = () => {
        if (!cached) cached = JSON.parse(readFileSync(path, 'utf8')) as RawPullRequest[];
        return cached;
    };

    return {
        async fetchPullRequests({ onProgress } = {}) {
            const prs = load();
            onProgress?.({ phase: 'prs', prsFetched: prs.length });
            return {
                prs: structuredClone(prs),
                truncated: [],
                rateLimit: null,
            };
        },
        async fetchBranchHistory() {
            return null;
        },
    };
}
