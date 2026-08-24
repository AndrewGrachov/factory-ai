/**
 * GitHub's GraphQL response shape, exactly as `queries.ts` asks for it.
 *
 * This lives beside the adapter rather than in `core` because it is not a model of a pull
 * request — it is a model of one provider's reply. `core` speaks `CanonicalPr`; `map.ts` is the
 * only file that knows both.
 */

export interface Actor {
    login: string;
}

export interface RawPullRequest {
    number: number;
    title: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    isDraft: boolean;
    baseRefName: string;
    headRefName: string;
    createdAt: string;
    updatedAt: string;
    mergedAt: string | null;
    closedAt: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    author: Actor | null;
    commits: { totalCount: number; nodes: { commit: { oid: string; committedDate: string } }[] };
    comments: { totalCount: number };
    labels: { nodes: { name: string }[] };
    reviews: {
        totalCount: number;
        nodes: { id: string; author: Actor | null; state: string; submittedAt: string | null }[];
    };
    reviewThreads: {
        totalCount: number;
        nodes: {
            id: string;
            isResolved: boolean;
            isOutdated: boolean;
            comments: {
                nodes: {
                    author: Actor | null;
                    createdAt: string;
                    pullRequestReview: { id: string } | null;
                }[];
            };
        }[];
    };
    // Counted from the filtered node list, never totalCount — see queries.ts.
    forcePushes: { nodes: { __typename: string }[] };
    readyForReview: { nodes: { createdAt: string }[] };
}
