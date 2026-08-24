export interface Actor {
    login: string;
}

export interface RawPullRequest {
    /**
     * "owner/name". Stamped by the client as it maps each repo's response, because the GraphQL
     * query is per-repo and the payload itself carries no repo identity. A PR number is only
     * unique within a repo, so the combined view needs this to say which #204 it means.
     */
    repo: string;
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
    /** "owner/name", carried through from RawPullRequest. */
    repo: string;
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
    repo: string;
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

/**
 * Telemetry from AI coding agents, joined to PRs by branch.
 *
 * The join exists because agent telemetry carries no PR number, branch, or commit SHA —
 * only a session id. A hook reports `session -> (repo, branch)` out of band, and the
 * branch is what reaches `DerivedPr.headRefName`.
 *
 * There is deliberately no monetary field anywhere below. Prices and cache discounts
 * change, and a dollar figure invites precision this attribution cannot support.
 */

/** One row per (session, branch) the hook observed. Three checkouts yield three spans. */
export interface SessionBranchSpan {
    sessionId: string;
    repo: string;
    /** null on detached HEAD. Never the literal 'HEAD', which would join to nothing while looking real. */
    branch: string | null;
    headSha: string | null;
    from: string;
    to: string;
    samples: number;
}

/**
 * The four types are never summed into one figure: a long cached conversation would
 * count the same context repeatedly. Where one number is needed it is input + output.
 */
export interface TokenTotals {
    input: number | null;
    output: number | null;
    cacheRead: number | null;
    cacheCreation: number | null;
}

export interface SessionRollup {
    sessionId: string;
    agent: string;
    /** Resolved from the hook, not from telemetry. null means the hook never reported. */
    repo: string | null;
    firstSeen: string;
    lastSeen: string;
    tokens: TokenTotals;
    linesAdded: number | null;
    linesRemoved: number | null;
    editsAccepted: number | null;
    editsRejected: number | null;
    activeSeconds: number | null;
    commits: number | null;
    pullRequests: number | null;
    /**
     * 'window' when delta temporality gave time-sliced increments that can be divided
     * across branches; 'session' when only a cumulative end-of-session total exists.
     */
    granularity: 'window' | 'session';
}

/** Per-(session, branch) allocation, computed by time containment where the timestamps live. */
export interface SessionSpanSplit {
    sessionId: string;
    /** From the span. A branch name is only unique within a repo, so the join needs both. */
    repo: string;
    branch: string | null;
    /** The interval this allocation covers. Needed because a branch is not a unique key —
     *  the sample payload reuses several head branches across separate PRs. */
    from: string;
    to: string;
    /** 0..1. null when the session's total could not be divided — ratio()'s contract, applied to attribution. */
    share: number | null;
    tokens: TokenTotals;
    linesAdded: number | null;
    linesRemoved: number | null;
    editsAccepted: number | null;
    editsRejected: number | null;
    activeSeconds: number | null;
}

/**
 * A session's direct PR association, from a transcript `pr-link` record.
 *
 * Strictly better than the branch join: an exact PR number, so no reuse ambiguity and no
 * time-window heuristic. Only present when Claude Code opened the PR itself, so branch
 * matching remains the fallback rather than being replaced.
 */
export interface SessionPrLink {
    sessionId: string;
    repo: string;
    prNumber: number;
    at: string;
}

export interface TelemetryInput {
    /** Every session in the store, unfiltered. attribute() applies the repo filter. */
    sessions: SessionRollup[];
    spans: SessionBranchSpan[];
    splits: SessionSpanSplit[];
    links: SessionPrLink[];
    coverage: { from: string | null; to: string | null };
}

/**
 * The slim PR projection attribute() is allowed to read. Deliberately not DerivedPr, so a
 * change there cannot silently alter telemetry output.
 */
export interface PrTelemetryKey {
    repo: string;
    number: number;
    author: string;
    headRefName: string;
    createdAt: string;
    mergedAt: string | null;
    size: number;
    cycleHours: number | null;
    commitsAfterHumanReview: number;
}

export interface PrTelemetryRow {
    repo: string;
    number: number;
    branch: string;
    author: string;
    mergedAt: string | null;
    size: number;
    cycleHours: number | null;
    commitsAfterHumanReview: number;
    sessions: number;
    tokens: TokenTotals;
    linesAdded: number | null;
    linesRemoved: number | null;
    editsAccepted: number | null;
    editsRejected: number | null;
    acceptRatio: number | null;
    activeHours: number | null;
    /** (input + output) per changed line. */
    tokensPerLoc: number | null;
    /**
     * 'linked' — the transcript names this PR outright, so the whole session belongs to it.
     *            The strongest tier: no branch inference at all.
     * 'exact'  — matched by branch, narrowed by time, and divisible.
     * 'shared' — a matched session also held other branches, or named several PRs, and could
     *            not be divided; every quantity above is null.
     * 'none'   — nothing matched. Also all null, and still listed: filtering the row out
     *            would make absence invisible.
     */
    attribution: 'linked' | 'exact' | 'shared' | 'none';
}

export interface TelemetryWeekPoint {
    week: string;
    start: string;
    sessions: number;
    tokens: TokenTotals;
    linesAdded: number;
    linesRemoved: number;
    partial: boolean;
}

export interface TelemetryStats {
    /** From `sessions`, never from `prs` — see the conservation tests. */
    totals: {
        sessions: number;
        tokens: TokenTotals;
        activeHours: number | null;
        linesAdded: number | null;
        linesRemoved: number | null;
        acceptRatio: number | null;
    };
    prs: PrTelemetryRow[];
    /** Work on branches matching no PR: dead ends, or a PR outside the fetch window. */
    /**
     * `branches` carries the repo because a branch name is not unique across repos: two repos
     * both having an unmatched `main` must read as two entries, not one.
     */
    unmatched: { sessions: number; tokens: TokenTotals; branches: { repo: string; branch: string }[] };
    /** PRs in the window with no session at all — merged before the plugin, or written without AI. */
    prsWithoutTelemetry: number;
    /** Sessions that held several branches, or named several PRs, and could not be divided. */
    sharedSessions: number;
    /** Sessions attributed by an exact PR number from a transcript rather than by branch. */
    linkedSessions: number;
    /** Sessions the hook attributed to a different repo. */
    otherRepoSessions: number;
    /** Sessions with telemetry but no hook data — the plugin is missing, or failing. */
    sessionsWithoutHook: number;
    weekly: TelemetryWeekPoint[];
    coverage: { from: string | null; to: string | null };
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
        scatter: { repo: string; number: number; size: number; hours: number; botThreads: number }[];
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
