import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Sql } from 'postgres';
import type { CanonicalPr } from '@factory-ai/core';
import { migrate } from '../src/db/migrate.js';
import { SCHEMA_EPOCH, createPrStore, type PrStore } from '../src/db/pr-store.js';

const url = process.env.DATABASE_URL;

/**
 * This suite TRUNCATES the pull request tables before every test, so pointing it at the database
 * the dashboard actually uses destroys real fetched history. Requiring a `_test` database name is
 * the guard, because the failure is silent: the tests pass and the data is simply gone.
 */
function assertTestDatabase(raw: string): void {
    const name = new URL(raw).pathname.replace(/^\//, '');
    if (!/_test$/.test(name)) {
        throw new Error(
            `Refusing to run: this suite truncates its tables, and "${name}" is not a test database.`,
        );
    }
}

const enabled = Boolean(url);
if (url) assertTestDatabase(url);

let sql: Sql;
let store: PrStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: PrStore;

const REPO = 'Bellows-AI/bellows.ai';
const OTHER = 'Bellows-AI/bellows-infra';
const ORG = 'test-org';
const OTHER_ORG = 'other-org';

beforeAll(async () => {
    if (!enabled) return;
    sql = postgres(url as string, { max: 2 });
    await migrate(sql, { orgId: ORG, attempts: 3 });
    store = createPrStore({ sql, orgId: ORG });
    otherOrgStore = createPrStore({ sql, orgId: OTHER_ORG });
});

afterAll(async () => {
    if (enabled) await sql.end();
});

beforeEach(async () => {
    if (!enabled) return;
    // Cascades to every child table.
    await sql`truncate pull_request cascade`;
    await sql`truncate branch_commit`;
    await sql`truncate branch_history`;
    await sql`truncate sync_state`;
});

function pr(over: Partial<CanonicalPr> = {}): CanonicalPr {
    return {
        provider: 'github',
        repo: REPO,
        number: 1,
        title: 'a change',
        state: 'merged',
        isDraft: false,
        baseRef: 'dev',
        headRef: 'feat/a',
        createdAt: '2026-08-01T00:00:00.000Z',
        mergedAt: '2026-08-02T00:00:00.000Z',
        closedAt: null,
        updatedAt: '2026-08-02T00:00:00.000Z',
        additions: 10,
        deletions: 2,
        changedFiles: 3,
        author: { login: 'AndrewGrachov' },
        commitCount: 2,
        reviewCount: 1,
        threadCount: 1,
        issueCommentCount: 0,
        forcePushCount: 0,
        readyAt: null,
        commits: [
            { sha: 'aaa', committedAt: '2026-08-01T01:00:00.000Z' },
            { sha: 'bbb', committedAt: '2026-08-01T02:00:00.000Z' },
        ],
        reviews: [
            {
                reviewKey: 'rev-1',
                author: { login: 'claude' },
                state: 'commented',
                providerState: 'COMMENTED',
                submittedAt: '2026-08-01T03:00:00.000Z',
            },
        ],
        threads: [
            {
                threadKey: 'th-1',
                isResolved: false,
                isOutdated: false,
                firstCommentAuthor: { login: 'claude' },
                firstCommentAt: '2026-08-01T03:00:00.000Z',
                parentReviewKey: 'rev-1',
            },
        ],
        labels: ['bellows-frontend-fix'],
        truncated: [],
        ...over,
    };
}

const count = async (table: string) => {
    const [row] = await sql.unsafe<{ n: string }[]>(`select count(*)::text as n from ${table}`);
    return Number((row as { n: string }).n);
};

describe.skipIf(!enabled)('the pull request store', () => {
    it('round-trips a PR and all of its children', async () => {
        const original = pr();
        await store.savePullRequests([original]);
        const [loaded] = await store.loadPullRequests('github', [REPO]);

        expect(loaded).toEqual(original);
    });

    it('is idempotent: a second identical save leaves one row', async () => {
        await store.savePullRequests([pr()]);
        await store.savePullRequests([pr()]);

        expect(await count('pull_request')).toBe(1);
        expect(await count('pr_review')).toBe(1);
        expect(await count('pr_commit')).toBe(2);
        expect(await count('pr_label')).toBe(1);
    });

    it('updates the mutable columns on a refetch', async () => {
        await store.savePullRequests([pr()]);
        await store.savePullRequests([
            pr({ title: 'renamed', state: 'closed', mergedAt: null, threadCount: 9 }),
        ]);

        const [loaded] = await store.loadPullRequests('github', [REPO]);
        expect(loaded?.title).toBe('renamed');
        expect(loaded?.state).toBe('closed');
        expect(loaded?.mergedAt).toBeNull();
        expect(loaded?.threadCount).toBe(9);
    });

    it('loads in creation order, newest first, however rows were inserted', async () => {
        // compute() derives stats.meta.window from array position, so this `order by` is the
        // single authority that keeps that invariant true now records come from a database.
        await store.savePullRequests([
            pr({ number: 2, createdAt: '2026-08-05T00:00:00.000Z' }),
            pr({ number: 1, createdAt: '2026-08-09T00:00:00.000Z' }),
            pr({ number: 3, createdAt: '2026-08-07T00:00:00.000Z' }),
        ]);

        const loaded = await store.loadPullRequests('github', [REPO]);
        expect(loaded.map((p) => p.number)).toEqual([1, 3, 2]);
    });

    it('keeps the same number under two repos apart', async () => {
        // A PR number is unique only within a repo, so #1 in two repos is two rows. Keyed on
        // number alone, one repo's data would land on the other repo's PR.
        await store.savePullRequests([pr({ repo: REPO }), pr({ repo: OTHER, title: 'other' })]);

        const both = await store.loadPullRequests('github', [REPO, OTHER]);
        expect(both).toHaveLength(2);
        expect(both.find((p) => p.repo === OTHER)?.title).toBe('other');
        expect(await store.loadPullRequests('github', [REPO])).toHaveLength(1);
    });

    it('keeps the same PR number under two organizations apart', async () => {
        // The guard that fails loudly if a future refactor drops org_id from a key. A repo path and
        // a PR number are BOTH routinely identical across organizations — two tenants each with
        // their own fork of the same repo, each with a #1 — so keyed without org one tenant's
        // figures land on the other's PR and nothing anywhere reports an error.
        await store.savePullRequests([pr({ title: 'ours' })]);
        await otherOrgStore.savePullRequests([pr({ title: 'theirs', reviews: [], reviewCount: 0 })]);

        const ours = await store.loadPullRequests('github', [REPO]);
        const theirs = await otherOrgStore.loadPullRequests('github', [REPO]);
        expect(ours).toHaveLength(1);
        expect(theirs).toHaveLength(1);
        expect(ours[0]?.title).toBe('ours');
        expect(theirs[0]?.title).toBe('theirs');
        // Two rows in the table, not one overwriting the other.
        expect(await count('pull_request')).toBe(2);
    });

    it("a complete child list does not delete another organization's rows", async () => {
        // writeChildren deletes before inserting whenever the incoming list is complete. Unscoped,
        // that delete reaches across the whole table — so one tenant's ordinary refetch silently
        // empties another tenant's reviews for the same repo and number.
        await store.savePullRequests([pr()]);
        const before = await count('pr_review');
        expect(before).toBeGreaterThan(0);

        await otherOrgStore.savePullRequests([pr({ reviews: [], reviewCount: 0 })]);

        expect((await store.loadPullRequests('github', [REPO]))[0]?.reviews).toHaveLength(before);
    });

    it('keeps sync watermarks apart across organizations', async () => {
        // A shared watermark would let one tenant's completed walk convince the other's next run
        // that it had already caught up — skipping everything in between, silently and permanently.
        await store.recordSync('github', REPO, 'pull_requests', {
            watermarkAt: '2026-08-20T00:00:00.000Z',
            mode: 'full',
            rateLimit: null,
            syncedEpoch: SCHEMA_EPOCH,
        });

        expect(await otherOrgStore.readSyncState('github', [REPO], 'pull_requests')).toEqual({});
        const mine = await store.readSyncState('github', [REPO], 'pull_requests');
        expect(mine[REPO]?.watermarkAt).toBe('2026-08-20T00:00:00.000Z');
    });

    it('deletes a review that vanished upstream, when the list was complete', async () => {
        // The only thing that ever makes a deleted review stop being counted. A pure upsert
        // leaks removed rows forever.
        await store.savePullRequests([pr()]);
        await store.savePullRequests([pr({ reviews: [], reviewCount: 0 })]);

        expect(await count('pr_review')).toBe(0);
    });
});

describe.skipIf(!enabled)('a truncated refetch never destroys better data', () => {
    /**
     * The single most dangerous case in the write path.
     *
     * A degraded refetch of a 397-review PR returns 100 nodes with the total still reading 397.
     * Delete-and-replace would substitute 100 rows for 397 and corrupt the resolution ratio with
     * no error anywhere. Do not delete this test.
     */
    const many = (n: number, from = 0) =>
        Array.from({ length: n }, (_, i) => ({
            reviewKey: `rev-${from + i}`,
            author: { login: 'AndrewGrachov' },
            state: 'commented' as const,
            providerState: 'COMMENTED',
            submittedAt: '2026-08-01T03:00:00.000Z',
        }));

    it('keeps 397 stored reviews when a refetch brings back only 100', async () => {
        await store.savePullRequests([pr({ number: 149, reviews: many(397), reviewCount: 397 })]);
        expect(await count('pr_review')).toBe(397);

        await store.savePullRequests([
            pr({ number: 149, reviews: many(100), reviewCount: 397, truncated: ['reviews'] }),
        ]);

        expect(await count('pr_review')).toBe(397);
        const [loaded] = await store.loadPullRequests('github', [REPO]);
        expect(loaded?.reviewCount).toBe(397);
        expect(loaded?.truncated).toEqual(['reviews']);
    });

    it('deliberately lets the row count disagree with the authoritative total', async () => {
        // Asserted rather than tolerated, so nobody "fixes" the discrepancy by making
        // review_count a count(*) — which would silently undercount by 297.
        await store.savePullRequests([
            pr({ number: 149, reviews: many(100), reviewCount: 397, truncated: ['reviews'] }),
        ]);

        const [loaded] = await store.loadPullRequests('github', [REPO]);
        expect(await count('pr_review')).toBe(100);
        expect(loaded?.reviewCount).toBe(397);
    });

    it('decides per connection, not per PR', async () => {
        // #149 can arrive with a complete commit list and a truncated review list in one fetch.
        await store.savePullRequests([
            pr({ number: 149, reviews: many(200), reviewCount: 200 }),
        ]);
        await store.savePullRequests([
            pr({
                number: 149,
                reviews: many(50),
                reviewCount: 200,
                truncated: ['reviews'],
                commits: [{ sha: 'ccc', committedAt: '2026-08-01T05:00:00.000Z' }],
                commitCount: 1,
            }),
        ]);

        expect(await count('pr_review')).toBe(200);
        // The commit list was complete, so the replaced list is the whole list.
        expect(await count('pr_commit')).toBe(1);
    });

    it('clears a stale caveat once the list comes back whole', async () => {
        // Unioning `truncated` would leave the page reporting a caveat that no longer applies.
        await store.savePullRequests([
            pr({ reviews: many(1), reviewCount: 5, truncated: ['reviews'] }),
        ]);
        await store.savePullRequests([pr({ reviews: many(5), reviewCount: 5 })]);

        const [loaded] = await store.loadPullRequests('github', [REPO]);
        expect(loaded?.truncated).toEqual([]);
        expect(await count('pr_review')).toBe(5);
    });
});

describe.skipIf(!enabled)('base-branch history', () => {
    const commit = (sha: string, at: string, headline = 'feat: x') => ({
        sha,
        committedAt: at,
        messageHeadline: headline,
    });

    it('treats an overlapping rescan as a no-op, never a double count', async () => {
        // `since` is inclusive upstream and the scan is deliberately given an hour of overlap, so
        // the tip commits arrive again on every run. Summing them would inflate the denominator
        // of the revert rate with no error anywhere.
        await store.saveBranchHistory('github', {
            repo: REPO,
            branch: 'dev',
            coveredFrom: '2026-08-01T00:00:00.000Z',
            commits: 3,
            reverts: 1,
            newCommits: [
                commit('c1', '2026-08-01T00:00:00.000Z'),
                commit('c2', '2026-08-02T00:00:00.000Z', 'Revert "feat: x"'),
                commit('c3', '2026-08-03T00:00:00.000Z'),
            ],
        });
        await store.saveBranchHistory('github', {
            repo: REPO,
            branch: 'dev',
            coveredFrom: '2026-08-03T00:00:00.000Z',
            commits: 4,
            reverts: 1,
            newCommits: [commit('c3', '2026-08-03T00:00:00.000Z'), commit('c4', '2026-08-04T00:00:00.000Z')],
        });

        expect(await count('branch_commit')).toBe(4);
        const loaded = await store.loadBranchCommits('github', [REPO], 'dev');
        expect(loaded.map((c) => c.sha)).toEqual(['c1', 'c2', 'c3', 'c4']);
    });

    it('only ever grows coverage backwards', async () => {
        // A later scan starting from a newer bound has not lost the older commits, and moving
        // this forward would make a range that IS covered report as unavailable.
        await store.saveBranchHistory('github', {
            repo: REPO,
            branch: 'dev',
            coveredFrom: '2026-04-01T00:00:00.000Z',
            commits: 1,
            reverts: 0,
            newCommits: [commit('c1', '2026-04-01T00:00:00.000Z')],
        });
        await store.saveBranchHistory('github', {
            repo: REPO,
            branch: 'dev',
            coveredFrom: '2026-08-01T00:00:00.000Z',
            commits: 2,
            reverts: 0,
            newCommits: [commit('c2', '2026-08-01T00:00:00.000Z')],
        });

        const [coverage] = await store.loadBranchCoverage('github', [REPO], 'dev');
        expect(coverage?.from).toBe('2026-04-01T00:00:00.000Z');
        expect(coverage?.commits).toBe(2);
    });

    it('keeps the headline, so a revert can be reclassified later', async () => {
        await store.saveBranchHistory('github', {
            repo: REPO,
            branch: 'dev',
            coveredFrom: '2026-08-01T00:00:00.000Z',
            commits: 1,
            reverts: 1,
            newCommits: [commit('c1', '2026-08-01T00:00:00.000Z', 'Revert "feat: x"')],
        });

        const [loaded] = await store.loadBranchCommits('github', [REPO], 'dev');
        expect(loaded?.messageHeadline).toBe('Revert "feat: x"');
    });
});

describe.skipIf(!enabled)('sync bookkeeping', () => {
    it('starts empty, which is what forces a first full walk', async () => {
        expect(await store.readSyncState('github', [REPO], 'pull_requests')).toEqual({});
    });

    it('never rewinds the watermark on an out-of-order report', async () => {
        await store.recordSync('github', REPO, 'pull_requests', {
            watermarkAt: '2026-08-10T00:00:00.000Z',
            mode: 'full',
            rateLimit: { remaining: 4000, resetAt: '2026-08-21T13:00:00.000Z' },
            syncedEpoch: SCHEMA_EPOCH,
        });
        await store.recordSync('github', REPO, 'pull_requests', {
            watermarkAt: '2026-08-01T00:00:00.000Z',
            mode: 'incremental',
            rateLimit: null,
            syncedEpoch: SCHEMA_EPOCH,
        });

        const state = await store.readSyncState('github', [REPO], 'pull_requests');
        expect(state[REPO]?.watermarkAt).toBe('2026-08-10T00:00:00.000Z');
        // An incremental sync does not claim to have reconciled, so the full-walk timestamp
        // the earlier one set survives untouched — otherwise the daily reconciliation would
        // never come due.
        expect(state[REPO]?.lastFullAt).not.toBeNull();
        expect(state[REPO]?.lastFullAt).not.toBe(state[REPO]?.lastSyncAt);
        // And the last known budget survives, so a failing fetch can still say when to retry.
        expect(state[REPO]?.lastRateLimit?.remaining).toBe(4000);
    });

    it('reads the oldest open PR, which floors the incremental cutoff', async () => {
        await store.savePullRequests([
            pr({ number: 1, state: 'open', mergedAt: null, updatedAt: '2026-05-01T00:00:00.000Z' }),
            pr({ number: 2, state: 'open', mergedAt: null, updatedAt: '2026-08-01T00:00:00.000Z' }),
            pr({ number: 3, state: 'merged', updatedAt: '2026-01-01T00:00:00.000Z' }),
        ]);

        expect(await store.oldestOpenUpdatedAt('github', [REPO])).toEqual({
            [REPO]: '2026-05-01T00:00:00.000Z',
        });
    });
});
