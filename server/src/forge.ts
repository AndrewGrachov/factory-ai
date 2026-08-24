import type { BranchHistory, CanonicalPr, ProviderCapabilities, ProviderId } from '@factory-ai/core';

/**
 * What the app needs from a code forge. GitHub is one implementation; GitLab and Bitbucket
 * would be siblings of `server/src/github/`.
 *
 * The interface is deliberately not in `server/src/github/`: an interface that lives inside one
 * adapter's directory grows that adapter's assumptions.
 */

export interface RateLimit {
    remaining: number;
    resetAt: string;
}

export interface Progress {
    phase: 'prs' | 'backfill' | 'history';
    /** "owner/name" of the repo in flight, so a slow fetch says which one it is waiting on. */
    repo?: string;
    prsFetched?: number;
    backfillingPr?: number;
    historyScanned?: number;
}

/**
 * `full` walks every PR. `incremental` walks newest-updated first and stops once a whole page
 * falls below the cutoff, which costs a few pages instead of the full ~243 rate-limit points.
 */
export type SyncMode = 'full' | 'incremental';

export interface PullRequestsOptions {
    onProgress?: (p: Progress) => void;
    mode?: SyncMode;
    /**
     * Per repo ("owner/name") ISO instant. An incremental walk stops at it. A repo missing from
     * the map is walked in full, which is what a first sync of a newly added repo needs.
     */
    cutoff?: Record<string, string>;
}

export interface PullRequestsResult {
    prs: CanonicalPr[];
    rateLimit: RateLimit | null;
    /**
     * Per repo: whether the walk reached the end of the list rather than stopping early or
     * dying. A watermark may only advance for a repo that completed — advancing it after a
     * partial walk skips everything the walk never reached, silently and forever.
     */
    completed: Record<string, boolean>;
}

/** One commit on a base branch. `messageHeadline` is kept raw so the revert classifier can change. */
export interface BranchCommit {
    sha: string;
    committedAt: string;
    messageHeadline: string;
}

/**
 * Per repo rather than combined, because a null history is not zero and the caller has to be able
 * to see WHICH repo went unreadable before deciding whether a combined figure is reportable.
 */
export interface RepoBranchHistory {
    repo: string;
    branch: string;
    history: BranchHistory | null;
    commits: BranchCommit[];
}

export interface ForgeClient {
    readonly provider: ProviderId;
    readonly capabilities: ProviderCapabilities;
    fetchPullRequests(options?: PullRequestsOptions): Promise<PullRequestsResult>;
    /**
     * `since` is per repo and mandatory for each: a base branch can carry tens of thousands of
     * commits of pre-existing history, and an unbounded scan is hundreds of pages for a number
     * that only describes the last few months.
     */
    fetchBranchHistories(
        since: Record<string, string>,
        options?: { onProgress?: (p: Progress) => void },
    ): Promise<RepoBranchHistory[]>;
}
