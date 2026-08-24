/**
 * The provider-neutral pull request. Everything downstream of a fetch reads this, never a
 * provider's response shape.
 *
 * Kept in its own file rather than appended to types.ts so the export at index.ts is
 * explicit: types.ts is re-exported wholesale, which is how a half-finished type ends up
 * public.
 */

export type ProviderId = 'github' | 'gitlab' | 'bitbucket';

export type CanonicalPrState = 'open' | 'closed' | 'merged';

export type CanonicalReviewState =
    | 'pending'
    | 'commented'
    | 'approved'
    | 'changes_requested'
    | 'dismissed';

/** The connections whose node list can be shorter than its authoritative count. */
export type PrConnection = 'reviews' | 'reviewThreads' | 'commits';

export interface CanonicalActor {
    login: string;
}

export interface CanonicalReview {
    /**
     * Opaque, provider-scoped correlation token. Compare for equality within one PR only —
     * never parse it, never display it, never join on it across PRs. Its whole job is
     * letting a thread say which review it belongs to.
     */
    reviewKey: string;
    author: CanonicalActor | null;
    state: CanonicalReviewState;
    /** The provider's own string, kept verbatim for audit. Nothing computes from it. */
    providerState: string;
    submittedAt: string | null;
}

export interface CanonicalReviewThread {
    threadKey: string;
    isResolved: boolean;
    isOutdated: boolean;
    firstCommentAuthor: CanonicalActor | null;
    firstCommentAt: string | null;
    /**
     * The review this thread was opened under, or null when it was opened outside any review.
     * Null also arrives in bulk from a provider that cannot link the two at all — which of
     * the two it is comes from ProviderCapabilities.reviewLinkage, not from this field.
     */
    parentReviewKey: string | null;
}

export interface CanonicalCommit {
    sha: string;
    committedAt: string;
}

export interface CanonicalPr {
    provider: ProviderId;
    /**
     * "owner/name" on GitHub, "group/subgroup/project" on GitLab. Stamped by the adapter,
     * which is the one place that knows which repo a response came from. A PR number is
     * unique only within a repo, so the combined view needs this to say which #204 it means.
     */
    repo: string;
    number: number;
    title: string;
    state: CanonicalPrState;
    isDraft: boolean;
    baseRef: string;
    headRef: string;
    createdAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    /** Last upstream modification. The incremental-sync watermark; no metric reads it. */
    updatedAt: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    author: CanonicalActor | null;

    /*
     * Authoritative totals. Siblings of the arrays below, never wrappers around them.
     *
     * A { totalCount, nodes } shape reads as if the two agree. They do not: #149 in the
     * sample payload has 397 reviews and at most 100 nodes. Separate names force every call
     * site to say which one it means — totals feed headline figures, node lists feed
     * distributions.
     */
    commitCount: number;
    reviewCount: number;
    threadCount: number;
    issueCommentCount: number;
    /**
     * null means the provider cannot observe force pushes at all; 0 means it can and none
     * happened. Different facts, and a dashboard that conflates them asserts a clean history
     * it never measured.
     */
    forcePushCount: number | null;
    readyAt: string | null;

    /* Possibly-capped child lists. Distributions only. */
    commits: CanonicalCommit[];
    reviews: CanonicalReview[];
    threads: CanonicalReviewThread[];
    labels: string[];

    /** Connections whose list above is shorter than its count above. */
    truncated: PrConnection[];
}

/**
 * What the source this data came from can and cannot observe.
 *
 * Only holds the capabilities that cannot be expressed in the data itself. `forcePushCount` is
 * already nullable, and a null `readyAt` means "never a draft" on every forge — a flag for either
 * would be a second way to say the same thing, which is how the two drift. Add a field here when
 * something reads it, not in anticipation.
 */
export interface ProviderCapabilities {
    /**
     * Whether a thread can be attributed to the review it was opened under. False makes
     * body-only review counting unavailable, NOT zero — zero would read as "this reviewer
     * always left line comments". It needs a flag because "no thread named a review" and
     * "threads cannot name reviews here" are identical in the data.
     */
    reviewLinkage: boolean;
}
