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
    mergedAt: string | null;
    closedAt: string | null;
    additions: number;
    deletions: number;
    changedFiles: number;
    author: Actor | null;
    commits: { totalCount: number; nodes: { commit: { committedDate: string } }[] };
    comments: { totalCount: number };
    labels: { nodes: { name: string }[] };
    reviews: {
        totalCount: number;
        nodes: { id: string; author: Actor | null; state: string; submittedAt: string | null }[];
    };
    reviewThreads: {
        totalCount: number;
        nodes: {
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

export interface ThreadRecord {
    author: string;
    reviewId: string | null;
    resolved: boolean;
    outdated: boolean;
}

export interface ThreadStats {
    total: number;
    threads: ThreadRecord[];
    bot: number;
    human: number;
    resolved: number;
    unresolvedOutdated: number;
    unresolvedLive: number;
}

export interface DerivedReview {
    id: string;
    author: string;
    state: string;
    submittedAt: string | null;
    bodyOnly: boolean;
}

export interface DerivedPr {
    number: number;
    title: string;
    author: string;
    authorIsBot: boolean;
    baseRefName: string;
    headRefName: string;
    state: 'OPEN' | 'CLOSED' | 'MERGED';
    createdAt: string;
    mergedAt: string | null;
    labels: string[];
    hasAiLabel: boolean;
    additions: number;
    deletions: number;
    size: number;
    changedFiles: number;
    commitCount: number;
    issueComments: number;
    reviewCount: number;
    reviews: DerivedReview[];
    bodyOnlyReviewCount: number;
    threads: ThreadStats;
    forcePushes: number;
    readyAt: string | null;
    firstReviewAt: string | null;
    firstHumanReviewAt: string | null;
    commitsAfterAnyReview: number;
    commitsAfterHumanReview: number;
    cycleHours: number | null;
    cycleFromReadyHours: number | null;
    firstReviewWaitHours: number | null;
    firstHumanReviewWaitHours: number | null;
    lastCommitToMergeHours: number | null;
}

export interface BranchHistory {
    branch: string;
    since: string;
    commits: number;
    reverts: number;
}

export interface TruncatedPr {
    number: number;
    connections: string[];
}

export interface WeekPoint {
    week: string;
    start: string;
    merges: number;
    loc: number;
    resolved: number;
    unresolvedOutdated: number;
    unresolvedLive: number;
    cycleP50: number | null;
    partial: boolean;
}

export interface ReviewerRow {
    login: string;
    isBot: boolean;
    threads: number;
    resolved: number;
    bodyOnlyReviews: number;
    reviews: number;
    prsTouched: number;
    resolvedRatio: number | null;
}

export interface AuthorRow {
    login: string;
    isBot: boolean;
    merged: number;
    medianSize: number | null;
    medianCommits: number | null;
    cycleP50: number | null;
    reworkRatio: number | null;
    threadsReceived: number;
    unresolvedRatio: number | null;
}

export interface Stats {
    meta: {
        generatedAt: string;
        baseBranch: string;
        truncated: TruncatedPr[];
        counts: { all: number; mergedToBase: number; open: number; closedUnmerged: number };
        window: { from: string | null; to: string | null };
    };
    headline: {
        unresolvedThreadRatio: number | null;
        mergesPerWeek: number | null;
        cycleP50: number | null;
        cycleP90: number | null;
        reworkAfterAnyReview: number | null;
        reworkAfterHumanReview: number | null;
        botThreadsPerPr: number | null;
        humanThreadsPerPr: number | null;
        medianSize: number | null;
    };
    threads: {
        total: number;
        resolved: number;
        unresolvedOutdated: number;
        unresolvedLive: number;
        bot: number;
        human: number;
    };
    weekly: WeekPoint[];
    cycle: {
        p50: number | null;
        p90: number | null;
        p50FromReady: number | null;
        firstReviewWaitP50: number | null;
        firstHumanReviewWaitP50: number | null;
        lastCommitToMergeP50: number | null;
    };
    rework: {
        prsWithAnyReview: number;
        prsWithHumanReview: number;
        afterAnyReview: number;
        afterHumanReview: number;
        medianCommitsAfterAnyReview: number | null;
        medianCommitsAfterHumanReview: number | null;
        forcePushes: number;
    };
    size: {
        histogram: { label: string; count: number }[];
        scatter: { number: number; size: number; hours: number; botThreads: number }[];
        medianChangedFiles: number | null;
    };
    commitsHistogram: { label: string; count: number }[];
    reviewers: ReviewerRow[];
    authors: AuthorRow[];
    quality: {
        labelledPrs: number;
        mergedPrs: number;
        instantMerges: number;
        history: BranchHistory | null;
        revertRatio: number | null;
    };
}
