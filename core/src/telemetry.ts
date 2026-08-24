import { HOUR } from './config.js';
import { isoWeekKey, ratio, weekStart } from './metrics.js';
import type {
    PrTelemetryKey,
    PrTelemetryRow,
    SessionRollup,
    SessionSpanSplit,
    TelemetryInput,
    TelemetryStats,
    TelemetryWeekPoint,
    TokenTotals,
} from './types.js';

/**
 * Sums the measured values and returns null only when nothing was measured at all.
 * A missing contributor must not drag a real total down to a smaller real number, and an
 * all-missing total must not read as zero.
 */
function sum(values: (number | null | undefined)[]): number | null {
    let total = 0;
    let seen = false;
    for (const value of values) {
        if (value === null || value === undefined) continue;
        total += value;
        seen = true;
    }
    return seen ? total : null;
}

function sumTokens(items: { tokens: TokenTotals }[]): TokenTotals {
    return {
        input: sum(items.map((i) => i.tokens.input)),
        output: sum(items.map((i) => i.tokens.output)),
        cacheRead: sum(items.map((i) => i.tokens.cacheRead)),
        cacheCreation: sum(items.map((i) => i.tokens.cacheCreation)),
    };
}

const emptyTokens = (): TokenTotals => ({
    input: null,
    output: null,
    cacheRead: null,
    cacheCreation: null,
});

/** The single figure the charts plot. Cache tokens are excluded: see TokenTotals. */
function billableTokens(tokens: TokenTotals): number | null {
    return sum([tokens.input, tokens.output]);
}

function acceptRatio(accepted: number | null, rejected: number | null): number | null {
    const total = sum([accepted, rejected]);
    if (total === null || accepted === null) return null;
    return ratio(accepted, total);
}

export interface AttributeOptions {
    /** Only sessions the hook tagged with one of these repos are counted. */
    repos?: readonly string[];
    /** Injected so the `partial` week flag is testable against a frozen fixture. */
    now?: Date;
}

/**
 * Every map below is keyed by this rather than by `number` or by `branch`. Neither is unique
 * across repos — two repos routinely both have a PR #204 and a `main` — so keying on either alone
 * would merge unrelated work into one row and report it as measured.
 */
const prKey = (repo: string, number: number) => `${repo}#${number}`;
const branchKey = (repo: string, branch: string) => `${repo}@${branch}`;

interface WeekBucket {
    week: string;
    start: string;
    sessions: number;
    tokens: { tokens: TokenTotals }[];
    linesAdded: number;
    linesRemoved: number;
}

function weeklySeries(sessions: SessionRollup[], now: Date): TelemetryWeekPoint[] {
    if (!sessions.length) return [];

    const weeks = new Map<string, WeekBucket>();
    const emptyWeek = (date: string): WeekBucket => ({
        week: isoWeekKey(date),
        start: weekStart(date).toISOString().slice(0, 10),
        sessions: 0,
        tokens: [],
        linesAdded: 0,
        linesRemoved: 0,
    });

    // Seed every week in the window, including the quiet ones, for the same reason
    // metrics.weeklySeries does: a series that closes its own gaps overstates activity.
    const first = sessions[0] as SessionRollup;
    const earliest = sessions.reduce((min, s) => (s.firstSeen < min ? s.firstSeen : min), first.firstSeen);
    const latest = sessions.reduce((max, s) => (s.firstSeen > max ? s.firstSeen : max), first.firstSeen);
    const cursor = weekStart(earliest);
    const last = weekStart(latest);
    while (cursor <= last) {
        const iso = cursor.toISOString();
        weeks.set(isoWeekKey(iso), emptyWeek(iso));
        cursor.setUTCDate(cursor.getUTCDate() + 7);
    }

    for (const session of sessions) {
        const key = isoWeekKey(session.firstSeen);
        if (!weeks.has(key)) weeks.set(key, emptyWeek(session.firstSeen));
        const bucket = weeks.get(key) as WeekBucket;
        bucket.sessions += 1;
        bucket.tokens.push(session);
        bucket.linesAdded += session.linesAdded ?? 0;
        bucket.linesRemoved += session.linesRemoved ?? 0;
    }

    const currentWeek = isoWeekKey(now.toISOString());
    return [...weeks.values()]
        .sort((a, b) => a.week.localeCompare(b.week))
        .map(({ tokens, ...rest }) => ({
            ...rest,
            tokens: sumTokens(tokens),
            partial: rest.week === currentWeek,
        }));
}

function nullRow(
    pr: PrTelemetryKey,
    attribution: 'shared' | 'none',
    sessions: number,
): PrTelemetryRow {
    return {
        repo: pr.repo,
        number: pr.number,
        branch: pr.headRefName,
        author: pr.author,
        mergedAt: pr.mergedAt,
        size: pr.size,
        cycleHours: pr.cycleHours,
        commitsAfterHumanReview: pr.commitsAfterHumanReview,
        sessions,
        tokens: emptyTokens(),
        linesAdded: null,
        linesRemoved: null,
        editsAccepted: null,
        editsRejected: null,
        acceptRatio: null,
        activeHours: null,
        tokensPerLoc: null,
        attribution,
    };
}

/**
 * Joins agent telemetry to pull requests through the branch the hook recorded.
 *
 * Pure, like compute(). The fetch lives in the server; only the attribution lives here.
 */
export function attribute(
    prs: PrTelemetryKey[],
    input: TelemetryInput,
    options: AttributeOptions = {},
): TelemetryStats {
    const { repos, now = new Date() } = options;
    const inRepoScope = (name: string) => repos === undefined || repos.includes(name);

    // Three disjoint groups, counted separately because they are three different setup
    // failures: right repo, wrong repo, and no hook at all.
    const inScope: SessionRollup[] = [];
    let otherRepoSessions = 0;
    let sessionsWithoutHook = 0;
    for (const session of input.sessions) {
        if (session.repo === null) sessionsWithoutHook += 1;
        else if (!inRepoScope(session.repo)) otherRepoSessions += 1;
        else inScope.push(session);
    }

    const scoped = new Set(inScope.map((s) => s.sessionId));
    const byId = new Map(inScope.map((s) => [s.sessionId, s]));
    const prKeys = new Set(prs.map((pr) => prKey(pr.repo, pr.number)));

    // A transcript pr-link names the PR outright, which beats every branch heuristic below.
    // Group first, because a session that names several in-scope PRs cannot be divided between
    // them any more than a session holding several branches can.
    const linkedPrs = new Map<string, Set<string>>();
    for (const link of input.links ?? []) {
        if (!scoped.has(link.sessionId)) continue;
        if (!inRepoScope(link.repo)) continue;
        const key = prKey(link.repo, link.prNumber);
        if (!prKeys.has(key)) continue;
        const set = linkedPrs.get(link.sessionId) ?? new Set<string>();
        set.add(key);
        linkedPrs.set(link.sessionId, set);
    }

    const linkedByPr = new Map<string, SessionRollup[]>();
    const ambiguousLinks = new Set<string>();
    for (const [sessionId, keys] of linkedPrs) {
        const session = byId.get(sessionId);
        if (!session) continue;
        if (keys.size > 1) {
            for (const key of keys) ambiguousLinks.add(key);
            continue;
        }
        const only = [...keys][0] as string;
        linkedByPr.set(only, [...(linkedByPr.get(only) ?? []), session]);
    }

    // A linked session is accounted for by its PR number, so its branch splits must not be
    // counted a second time through the branch path.
    const linkedSessionIds = new Set(linkedPrs.keys());
    const splits = input.splits.filter(
        (s) => scoped.has(s.sessionId) && !linkedSessionIds.has(s.sessionId),
    );

    // A head branch is NOT a unique key: the sample payload reuses several across separate
    // PRs. Matching on branch alone would attribute the same work to every PR that ever used
    // it. So candidates are ordered by when they stopped accepting work, and a split goes to
    // the first PR that was still open when the work happened.
    const candidates = new Map<string, PrTelemetryKey[]>();
    for (const pr of prs) {
        const key = branchKey(pr.repo, pr.headRefName);
        const list = candidates.get(key) ?? [];
        list.push(pr);
        candidates.set(key, list);
    }
    // An open PR is still accepting work, so it sorts last and catches anything later.
    const closesAt = (pr: PrTelemetryKey) => pr.mergedAt ?? '9999';
    for (const list of candidates.values()) list.sort((a, b) => closesAt(a).localeCompare(closesAt(b)));

    const byPr = new Map<string, SessionSpanSplit[]>();
    const orphans: SessionSpanSplit[] = [];
    for (const split of splits) {
        // A null branch is detached HEAD: it matches no PR, and must not be coerced into one.
        const list =
            split.branch === null ? undefined : candidates.get(branchKey(split.repo, split.branch));
        const owner = list?.find((pr) => closesAt(pr) >= split.from);
        if (!owner) {
            // Either no PR used this branch, or every PR on it merged before the work started.
            orphans.push(split);
            continue;
        }
        const key = prKey(owner.repo, owner.number);
        byPr.set(key, [...(byPr.get(key) ?? []), split]);
    }

    const rows: PrTelemetryRow[] = [];
    let prsWithoutTelemetry = 0;
    for (const pr of prs) {
        const key = prKey(pr.repo, pr.number);
        // A session named this PR alongside others, so its usage cannot be placed on either.
        if (ambiguousLinks.has(key)) {
            rows.push(nullRow(pr, 'shared', 0));
            continue;
        }

        const linked = linkedByPr.get(key) ?? [];
        const matched = byPr.get(key) ?? [];

        // Both sources contribute to the same row. Folding them together rather than letting
        // the stronger tier win outright is what keeps the partition whole: a PR named by one
        // session and branch-matched by another would otherwise drop the second silently,
        // accounted for nowhere.
        const parts = [...linked, ...matched];
        const sessions = new Set([
            ...linked.map((s) => s.sessionId),
            ...matched.map((s) => s.sessionId),
        ]).size;

        if (!parts.length) {
            prsWithoutTelemetry += 1;
            rows.push(nullRow(pr, 'none', 0));
            continue;
        }
        // One indivisible contribution poisons the row: reporting the divisible part alone
        // would understate the PR while looking like a complete answer.
        if (matched.some((s) => s.share === null)) {
            rows.push(nullRow(pr, 'shared', sessions));
            continue;
        }

        const tokens = sumTokens(parts);
        const editsAccepted = sum(parts.map((s) => s.editsAccepted));
        const editsRejected = sum(parts.map((s) => s.editsRejected));
        const activeSeconds = sum(parts.map((s) => s.activeSeconds));
        const billable = billableTokens(tokens);

        rows.push({
            repo: pr.repo,
            number: pr.number,
            branch: pr.headRefName,
            author: pr.author,
            mergedAt: pr.mergedAt,
            size: pr.size,
            cycleHours: pr.cycleHours,
            commitsAfterHumanReview: pr.commitsAfterHumanReview,
            sessions,
            tokens,
            linesAdded: sum(parts.map((s) => s.linesAdded)),
            linesRemoved: sum(parts.map((s) => s.linesRemoved)),
            editsAccepted,
            editsRejected,
            acceptRatio: acceptRatio(editsAccepted, editsRejected),
            activeHours: activeSeconds === null ? null : (activeSeconds * 1000) / HOUR,
            tokensPerLoc: billable === null ? null : ratio(billable, pr.size),
            // 'linked' whenever a transcript named this PR outright, even if branch matching
            // added to it: the strongest evidence present is what the label should describe.
            attribution: linked.length ? 'linked' : 'exact',
        });
    }

    const totalsTokens = sumTokens(inScope);
    const totalAccepted = sum(inScope.map((s) => s.editsAccepted));
    const totalRejected = sum(inScope.map((s) => s.editsRejected));
    const totalActive = sum(inScope.map((s) => s.activeSeconds));

    return {
        totals: {
            sessions: inScope.length,
            tokens: totalsTokens,
            activeHours: totalActive === null ? null : (totalActive * 1000) / HOUR,
            linesAdded: sum(inScope.map((s) => s.linesAdded)),
            linesRemoved: sum(inScope.map((s) => s.linesRemoved)),
            acceptRatio: acceptRatio(totalAccepted, totalRejected),
        },
        prs: rows,
        unmatched: {
            sessions: new Set(orphans.map((s) => s.sessionId)).size,
            tokens: sumTokens(orphans),
            branches: [
                ...new Map(
                    orphans
                        .filter((s) => s.branch !== null)
                        .map((s) => [
                            branchKey(s.repo, s.branch as string),
                            { repo: s.repo, branch: s.branch as string },
                        ]),
                ).values(),
            ].sort((a, b) => a.repo.localeCompare(b.repo) || a.branch.localeCompare(b.branch)),
        },
        prsWithoutTelemetry,
        sharedSessions:
            new Set(splits.filter((s) => s.share === null).map((s) => s.sessionId)).size +
            [...linkedPrs.values()].filter((n) => n.size > 1).length,
        linkedSessions: [...linkedPrs.values()].filter((n) => n.size === 1).length,
        otherRepoSessions,
        sessionsWithoutHook,
        weekly: weeklySeries(inScope, now),
        coverage: input.coverage,
    };
}
