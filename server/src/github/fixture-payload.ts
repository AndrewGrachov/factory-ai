import { readFileSync } from 'node:fs';
import type { RawPullRequest } from './schema.js';

/**
 * Outside the compiled tree, beside `server/migrations/`, and at the same depth from
 * `src/github/` as from `dist/github/` — because `tsc` no more copies `.json` than it copies
 * `.sql`. Kept under `src/` it resolved fine under tsx and then failed on `npm start` with an
 * ENOENT that reads nothing like a build problem.
 */
const PAYLOAD = new URL('../../fixtures/sample-payload.json', import.meta.url);

/** The repo the committed payload was actually captured from. */
export const FIXTURE_REPO = 'Leeloo-AI-RGA-OS/leeloo.ai';

/**
 * The committed capture: 203 real PRs, taken 2026-08-21 and already post-backfill. It is kept
 * verbatim, which means it predates three fields the query now selects — `updatedAt`, commit
 * `oid` and review-thread `id`. They are filled in here rather than by editing the JSON, so the
 * capture stays a capture.
 *
 * The substitutes are safe because none of them is ever load-bearing on this path: fixture data
 * is never persisted (see the DATA_SOURCE guard in config.ts), so a synthetic `updatedAt` can
 * never become a sync watermark and a synthetic sha can never become a primary key. The metrics
 * these PRs feed read neither.
 */
export function fixturePayload(): RawPullRequest[] {
    const raw = JSON.parse(readFileSync(PAYLOAD, 'utf8')) as RawPullRequest[];

    for (const pr of raw) {
        pr.updatedAt ??= pr.mergedAt ?? pr.closedAt ?? pr.createdAt;
        pr.commits.nodes.forEach((node, i) => {
            node.commit.oid ??= `fixture-commit-${pr.number}-${i}`;
        });
        pr.reviewThreads.nodes.forEach((thread, i) => {
            thread.id ??= `fixture-thread-${pr.number}-${i}`;
        });
    }

    return raw;
}
