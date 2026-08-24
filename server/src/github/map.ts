import type {
    CanonicalPr,
    CanonicalReview,
    CanonicalReviewState,
    CanonicalReviewThread,
    PrConnection,
    ProviderCapabilities,
} from '@factory-ai/core';
import { INNER_LIMIT } from './queries.js';
import type { RawPullRequest } from './schema.js';

export const GITHUB_CAPABILITIES: ProviderCapabilities = Object.freeze({ reviewLinkage: true });

/**
 * GitHub's review states, lowercased. Kept as an explicit map rather than a `toLowerCase()`
 * so a state GitHub adds later fails here instead of flowing through as an unknown string.
 */
const REVIEW_STATES: Record<string, CanonicalReviewState> = {
    PENDING: 'pending',
    COMMENTED: 'commented',
    APPROVED: 'approved',
    CHANGES_REQUESTED: 'changes_requested',
    DISMISSED: 'dismissed',
};

function reviewState(raw: string): CanonicalReviewState {
    const mapped = REVIEW_STATES[raw];
    if (!mapped) throw new Error(`Unknown GitHub review state "${raw}"`);
    return mapped;
}

/**
 * Which node lists came back shorter than their own count.
 *
 * `totalCount` is never truncated, so headline figures stay exact; it is the node lists behind
 * these connections that a >100 count silently cuts short. `client.backfill()` refills what it
 * can, and whatever is still short is recorded here so the page can say so.
 */
function truncatedConnections(pr: RawPullRequest): PrConnection[] {
    const cut: PrConnection[] = [];
    if (pr.reviews.nodes.length < pr.reviews.totalCount) cut.push('reviews');
    if (pr.reviewThreads.nodes.length < pr.reviewThreads.totalCount) cut.push('reviewThreads');
    if (pr.commits.nodes.length < pr.commits.totalCount) cut.push('commits');
    return cut;
}

/** Connections worth a second pass, i.e. capped by the query rather than genuinely short. */
export function oversizedConnections(pr: RawPullRequest): PrConnection[] {
    return (['reviews', 'reviewThreads', 'commits'] as const).filter(
        (key) => pr[key].totalCount > INNER_LIMIT,
    );
}

export function toCanonical(raw: RawPullRequest, repo: string): CanonicalPr {
    const reviews: CanonicalReview[] = raw.reviews.nodes.map((review) => ({
        reviewKey: review.id,
        author: review.author,
        state: reviewState(review.state),
        providerState: review.state,
        submittedAt: review.submittedAt,
    }));

    const threads: CanonicalReviewThread[] = raw.reviewThreads.nodes.map((thread) => {
        const first = thread.comments.nodes[0];
        return {
            threadKey: thread.id,
            isResolved: thread.isResolved,
            isOutdated: thread.isOutdated,
            firstCommentAuthor: first?.author ?? null,
            firstCommentAt: first?.createdAt ?? null,
            parentReviewKey: first?.pullRequestReview?.id ?? null,
        };
    });

    return {
        provider: 'github',
        repo,
        number: raw.number,
        title: raw.title,
        state: raw.state === 'MERGED' ? 'merged' : raw.state === 'CLOSED' ? 'closed' : 'open',
        isDraft: raw.isDraft,
        baseRef: raw.baseRefName,
        headRef: raw.headRefName,
        createdAt: raw.createdAt,
        mergedAt: raw.mergedAt,
        closedAt: raw.closedAt,
        updatedAt: raw.updatedAt,
        additions: raw.additions,
        deletions: raw.deletions,
        changedFiles: raw.changedFiles,
        author: raw.author,
        commitCount: raw.commits.totalCount,
        reviewCount: raw.reviews.totalCount,
        threadCount: raw.reviewThreads.totalCount,
        issueCommentCount: raw.comments.totalCount,
        // From the filtered node list, never a connection total: timelineItems.totalCount
        // ignores itemTypes and once reported 404 force pushes across 14 PRs.
        forcePushCount: raw.forcePushes.nodes.length,
        readyAt: raw.readyForReview.nodes[0]?.createdAt ?? null,
        commits: raw.commits.nodes.map((node) => ({
            sha: node.commit.oid,
            committedAt: node.commit.committedDate,
        })),
        reviews,
        threads,
        labels: raw.labels.nodes.map((label) => label.name),
        truncated: truncatedConnections(raw),
    };
}
