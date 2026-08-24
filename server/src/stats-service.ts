import {
    ALL_TIME,
    attribute,
    compute,
    deriveAll,
    filterPrs,
    filterTelemetryInput,
    isAllTime,
    isRevertHeadline,
} from '@factory-ai/core';
import type {
    BranchHistory,
    CanonicalPr,
    DateRange,
    DerivedPr,
    OrganizationMeta,
    PrTelemetryKey,
    Stats,
    TelemetryInput,
    TelemetryStats,
    TruncatedPr,
} from '@factory-ai/core';
import { createCache } from './cache.js';
import type { AppConfig } from './config.js';
import { SCHEMA_EPOCH, type PrStore, type SyncState } from './db/pr-store.js';
import type { ForgeClient, Progress, RateLimit, SyncMode } from './forge.js';
import { GitHubError } from './github/errors.js';
import type { TelemetryClient } from './telemetry/client.js';
import { TelemetryError } from './telemetry/errors.js';

export interface RevertStatus {
    status: 'ok' | 'unavailable';
    reason: string | null;
}

export interface TelemetryMeta {
    status: 'ok' | 'empty' | 'unreachable' | 'disabled';
    reason: string | null;
    source: 'postgres' | 'fixture';
    fetchedAt: string | null;
    ageSeconds: number | null;
    stale: boolean;
    repoFilter: readonly string[];
    /** Sessions the hook attributed to a different repo. */
    otherRepoSessions: number;
    /** Sessions with telemetry but no hook data — the plugin is missing, or failing. */
    sessionsWithoutHook: number;
}

export interface PersistenceMeta {
    /**
     * 'off'         — no store configured, so a restart re-pays the full fetch.
     * 'migrating'   — a store exists but its schema is not ready yet. Distinct from
     *                 'unavailable' because it resolves itself and wants no operator action.
     * 'unavailable' — the store is configured and failing. PR metrics keep working.
     * 'ok'          — reads and writes are landing.
     */
    status: 'ok' | 'unavailable' | 'migrating' | 'off';
    reason: string | null;
    /** When the last successful sync ran, from the store rather than from this process. */
    lastSyncAt: string | null;
    mode: SyncMode | null;
}

/** One base-branch commit, kept per-repo so the revert rate stays sliceable by date. */
export interface CommitPoint {
    repo: string;
    committedAt: string;
    isRevert: boolean;
}

/** How far back persisted history actually reaches, per repo. */
export interface CoveragePoint {
    repo: string;
    from: string;
}

export interface StatsSnapshot {
    /**
     * Kept whole rather than pre-aggregated, because a range selection re-runs compute() over
     * a subset. One fetch still serves every range.
     */
    derived: DerivedPr[];
    /** The all-time figure as the provider reported it. `commits` is its totalCount, not a row count. */
    history: BranchHistory | null;
    /** Empty without a store; the revert rate then degrades on a narrowed range, as before. */
    commits: CommitPoint[];
    coverage: CoveragePoint[];
    rateLimit: RateLimit | null;
    revert: RevertStatus;
}

export interface TelemetrySnapshot {
    input: TelemetryInput;
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    phase: 'prs' | 'backfill' | 'history' | null;
    /** Which repo the fetch is on. With several configured, a cold start is N times as long. */
    repo: string | null;
    /** Which kind of walk is running. A full walk is ~243 points per repo; incremental is a few. */
    mode: SyncMode | null;
    prsFetched: number | null;
    backfillingPr: number | null;
    historyScanned: number | null;
    startedAt: string | null;
    finishedAt: string | null;
    error: { message: string; code: string } | null;
}

export interface StatsPayload {
    stats: Stats;
    /**
     * A sibling of `stats`, not a field inside it. The two have independent lifetimes and
     * independent failure modes: an unreachable database must never blank the PR metrics.
     */
    telemetry: TelemetryStats | null;
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        source: 'live' | 'fixture';
        rateLimit: RateLimit | null;
        revert: RevertStatus;
        /**
         * Whose figures these are, and what else the caller could ask for.
         *
         * One block rather than a bare `org: string`, and in this payload rather than behind a
         * second `GET /api/orgs`: `current` has to ride here regardless — the store is partitioned
         * by organization, so a page that cannot name the one it is showing cannot be read — and
         * bundling `available` with it makes the pair atomic. Split across two requests,
         * `/api/orgs` can say "you may see A and B" while these figures were computed for A.
         */
        organization: OrganizationMeta;
        /** Every repo in the combined view. Per-repo pages will filter this, not refetch. */
        repos: { owner: string; name: string }[];
        baseBranch: string;
        range: DateRange;
        telemetry: TelemetryMeta;
        persistence: PersistenceMeta;
    };
}

export interface StatsService {
    /** Cached payload for a range, or null if nothing has ever been fetched successfully. */
    current(range?: DateRange): StatsPayload | null;
    /** Kicks off a refresh if one is warranted. Single-flight. */
    ensureFresh(): void;
    refresh(): void;
    fetchState(): FetchState;
    /** Fills the slot from the store, so a restart with a warm database serves data at once. */
    prime(): Promise<void>;
}

export interface StatsServiceDeps {
    config: AppConfig;
    client: ForgeClient;
    telemetry: TelemetryClient;
    /** Absent when persistence is off, exactly as the telemetry store is. */
    store?: PrStore | undefined;
    now?: () => number;
}

function idleState(): FetchState {
    return {
        state: 'idle',
        phase: null,
        repo: null,
        mode: null,
        prsFetched: null,
        backfillingPr: null,
        historyScanned: null,
        startedAt: null,
        finishedAt: null,
        error: null,
    };
}

/**
 * After a failed fetch, hold off before trying again. Without this every incoming request
 * restarts the fetch, so a rejected token or an exhausted rate limit turns into a request
 * loop against GitHub. An explicit POST /api/refresh bypasses it.
 */
const ERROR_COOLDOWN_MS = 30_000;

/**
 * Its own, much shorter cooldown: the failure this guards against is a dead socket, not an
 * exhausted quota. Sharing ERROR_COOLDOWN_MS would let a GitHub rate limit freeze the local
 * database read for 30s, which is a subtle way for one degradation to cause another.
 */
const TELEMETRY_COOLDOWN_MS = 5_000;

/** How often a full reconciliation walk runs regardless of watermarks. */
const FULL_RESYNC_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * How far behind the watermark an incremental walk starts.
 *
 * GraphQL reads replicas, so a PR updated at T can surface in an UPDATED_AT-ordered page after
 * the reader has already passed T. With no overlap that update is missed permanently and
 * invisibly; with an overlap a few pages are re-read, and every write is an upsert.
 */
const SYNC_OVERLAP_MS = 5 * 60 * 1000;

/**
 * The cutoff never rises above this, so recently merged PRs keep being revisited. A review
 * thread can be resolved well after a merge, and a provider does not always bump `updatedAt`
 * for it.
 */
const RECENT_WINDOW_MS = 14 * 24 * 3600 * 1000;

/** An incremental scan of the base branch starts this far behind the newest stored commit. */
const HISTORY_OVERLAP_MS = 3600 * 1000;

/** Points a full walk costs per repo, from the measured ~243, with headroom. */
const FULL_WALK_POINTS_PER_REPO = 243;

/** Deliberately not DerivedPr, so a change there cannot silently alter telemetry output. */
function toJoinKey(pr: DerivedPr): PrTelemetryKey {
    return {
        repo: pr.repo,
        number: pr.number,
        author: pr.author,
        headRefName: pr.headRefName,
        createdAt: pr.createdAt,
        mergedAt: pr.mergedAt,
        size: pr.size,
        cycleHours: pr.cycleHours,
        commitsAfterHumanReview: pr.commitsAfterHumanReview,
    };
}

export function createStatsService({
    config,
    client,
    telemetry,
    store,
    now = Date.now,
}: StatsServiceDeps): StatsService {
    const bots = new Set(config.bots);
    const repoNames = config.repoNames;
    // Frozen once: with no accounts there is nothing that could change it mid-process, and one
    // object shared by `current` and `available` makes their equality structural rather than
    // coincidental.
    const organization = Object.freeze({ id: config.orgId, name: config.orgName });
    const PR_KIND = 'pull_requests';
    const HISTORY_KIND = `history:${config.baseBranch}`;

    let fetchState = idleState();
    let lastFailureAt: number | null = null;
    let telemetryFailure: { at: number; reason: string } | null = null;
    let persistence: PersistenceMeta = {
        status: store ? 'migrating' : 'off',
        reason: null,
        lastSyncAt: null,
        mode: null,
    };
    let priming: Promise<void> | null = null;

    /**
     * Never lets a store problem out. Propagating it would set `lastFailureAt` and freeze the
     * whole PR pipeline for 30s over a database fault — the one-degradation-causes-another
     * mistake TELEMETRY_COOLDOWN_MS exists to prevent.
     */
    async function tryStore<T>(what: string, run: (s: PrStore) => Promise<T>): Promise<T | null> {
        if (!store) return null;
        try {
            const value = await run(store);
            if (persistence.status !== 'ok') {
                persistence = { ...persistence, status: 'ok', reason: null };
            }
            return value;
        } catch (e) {
            persistence = {
                ...persistence,
                status: 'unavailable',
                reason: `${what}: ${(e as Error).message}`,
            };
            return null;
        }
    }

    function snapshotFrom(
        prs: CanonicalPr[],
        commits: CommitPoint[],
        coverage: CoveragePoint[],
        history: BranchHistory | null,
        revert: RevertStatus,
        rateLimit: RateLimit | null,
    ): StatsSnapshot {
        return {
            derived: deriveAll(prs, bots, client.capabilities),
            history,
            commits,
            coverage,
            rateLimit,
            revert,
        };
    }

    function chooseMode(state: Record<string, SyncState>): SyncMode {
        if (!store) return 'full';

        const missing = repoNames.filter((repo) => !state[repo]?.watermarkAt);
        // A repo with no watermark has never completed a walk, so there is nothing to be
        // incremental about.
        if (missing.length) return 'full';

        // A newly selected field leaves existing rows null, and only a full walk repairs them.
        if (repoNames.some((repo) => (state[repo]?.syncedEpoch ?? 0) < SCHEMA_EPOCH)) return 'full';

        const due = repoNames.some((repo) => {
            const at = state[repo]?.lastFullAt;
            return !at || now() - new Date(at).getTime() > FULL_RESYNC_INTERVAL_MS;
        });
        if (!due) return 'incremental';

        // A reconciliation that is due but unaffordable stays a want, not an attempt. This reads
        // the actual remaining budget rather than inferring it from a clock, which is why the
        // slot TTL does not need to gate the expensive path.
        const remaining = repoNames
            .map((repo) => state[repo]?.lastRateLimit?.remaining)
            .filter((n): n is number => typeof n === 'number');
        const needed = FULL_WALK_POINTS_PER_REPO * repoNames.length * 1.5;
        if (remaining.length && Math.min(...remaining) < needed) return 'incremental';

        return 'full';
    }

    function buildCutoff(
        state: Record<string, SyncState>,
        oldestOpen: Record<string, string>,
    ): Record<string, string> {
        const floor = now() - RECENT_WINDOW_MS;
        const cutoff: Record<string, string> = {};
        for (const repo of repoNames) {
            const watermark = state[repo]?.watermarkAt;
            if (!watermark) continue;
            const candidates = [
                new Date(watermark).getTime() - SYNC_OVERLAP_MS,
                floor,
                ...(oldestOpen[repo] ? [new Date(oldestOpen[repo] as string).getTime()] : []),
            ];
            cutoff[repo] = new Date(Math.min(...candidates)).toISOString();
        }
        return cutoff;
    }

    async function produce(): Promise<StatsSnapshot> {
        // Set before the first await, so a request arriving in the same tick as the refresh sees
        // 'loading' rather than 'idle' — that is what makes the cold-start 202 honest.
        fetchState = { ...idleState(), state: 'loading', startedAt: new Date(now()).toISOString() };

        const previous = cache.peek()?.value ?? null;
        const syncState =
            (await tryStore('read sync state', (s) => s.readSyncState(client.provider, repoNames, PR_KIND))) ?? {};
        const oldestOpen =
            (await tryStore('read open PRs', (s) => s.oldestOpenUpdatedAt(client.provider, repoNames))) ?? {};
        const mode = chooseMode(syncState);
        fetchState = { ...fetchState, mode };

        const onProgress = (p: Progress) => {
            fetchState = {
                ...fetchState,
                phase: p.phase,
                repo: p.repo ?? fetchState.repo,
                prsFetched: p.prsFetched ?? fetchState.prsFetched,
                backfillingPr: p.backfillingPr ?? fetchState.backfillingPr,
                historyScanned: p.historyScanned ?? fetchState.historyScanned,
            };
        };

        try {
            const { prs, rateLimit, completed } = await client.fetchPullRequests({
                onProgress,
                mode,
                cutoff: buildCutoff(syncState, oldestOpen),
            });

            await tryStore('write pull requests', async (s) => {
                await s.savePullRequests(prs);
                for (const repo of repoNames) {
                    // Only a walk that reached the end may move the watermark. Advancing it
                    // after a partial walk skips everything the walk never reached, silently
                    // and permanently.
                    if (!completed[repo]) continue;
                    const seen = prs.filter((pr) => pr.repo === repo).map((pr) => pr.updatedAt);
                    await s.recordSync(client.provider, repo, PR_KIND, {
                        watermarkAt: seen.length ? seen.reduce((a, b) => (a > b ? a : b)) : null,
                        mode,
                        rateLimit,
                        syncedEpoch: SCHEMA_EPOCH,
                    });
                }
            });

            // An incremental walk returns only what changed, so the full set comes from the
            // store. Without one, what was just fetched is all there is.
            const stored = await tryStore('read pull requests', (s) =>
                s.loadPullRequests(client.provider, repoNames),
            );
            const all = stored ?? prs;

            const { history, commits, coverage, revert } = await produceHistory(all, previous, onProgress);

            fetchState = {
                ...fetchState,
                state: 'idle',
                phase: null,
                finishedAt: new Date(now()).toISOString(),
            };
            lastFailureAt = null;
            // Only when there is somewhere for it to have been synced *to*. Reporting a
            // lastSyncAt beside status 'off' reads as "persisted at 07:18", which is the one
            // thing that did not happen.
            if (store) {
                persistence = { ...persistence, mode, lastSyncAt: new Date(now()).toISOString() };
            }
            return snapshotFrom(all, commits, coverage, history, revert, rateLimit);
        } catch (e) {
            const code = e instanceof GitHubError ? e.code : 'UNKNOWN';
            lastFailureAt = now();
            fetchState = {
                ...fetchState,
                state: 'error',
                finishedAt: new Date(now()).toISOString(),
                error: { message: (e as Error).message, code },
            };
            throw e;
        }
    }

    /**
     * Only the revert rate depends on Contents: read. Its failure degrades one metric to
     * "unavailable" instead of failing the whole dashboard, and must never surface as
     * {commits: 0, reverts: 0}.
     */
    async function produceHistory(
        all: CanonicalPr[],
        previous: StatsSnapshot | null,
        onProgress: (p: Progress) => void,
    ): Promise<{
        history: BranchHistory | null;
        commits: CommitPoint[];
        coverage: CoveragePoint[];
        revert: RevertStatus;
    }> {
        // Without a store there is nothing to resume from: the scan is bounded by the earliest
        // merge every time, exactly as it was before any of this existed. Accumulating in memory
        // instead would make the window depend on process uptime.
        const persistedCommits = store ? (previous?.commits ?? []) : [];
        const merges = all.map((pr) => pr.mergedAt).filter((at): at is string => at !== null);
        const earliest = merges.length ? merges.reduce((min, at) => (at < min ? at : min)) : null;

        if (!earliest) {
            return {
                history: null,
                commits: persistedCommits,
                coverage: previous?.coverage ?? [],
                revert: { status: 'unavailable', reason: 'No merged PRs to bound the history query' },
            };
        }

        // A repo already scanned resumes just behind its newest stored commit; one that has not
        // been scanned starts at the earliest merge, which is what bounds a base branch carrying
        // tens of thousands of commits of pre-existing history.
        const newest = new Map<string, string>();
        for (const commit of persistedCommits) {
            const held = newest.get(commit.repo);
            if (!held || commit.committedAt > held) newest.set(commit.repo, commit.committedAt);
        }
        const since = Object.fromEntries(
            repoNames.map((repo) => {
                const tip = newest.get(repo);
                // The overlap is not paranoia: a commit date is not monotonic with history order,
                // so a rebase can place a commit behind its own parent and a zero-overlap
                // resume genuinely skips it.
                const from = tip ? new Date(new Date(tip).getTime() - HISTORY_OVERLAP_MS).toISOString() : earliest;
                return [repo, from];
            }),
        );

        try {
            const histories = await client.fetchBranchHistories(since, { onProgress });
            const unreadable = histories.filter((h) => h.history === null).map((h) => h.repo);
            if (unreadable.length) {
                // Summing the repos that DID resolve would produce a plausible number
                // measured over an unknown subset — the one failure this metric's
                // null-not-zero contract exists to prevent. All or nothing.
                return {
                    history: null,
                    commits: persistedCommits,
                    coverage: previous?.coverage ?? [],
                    revert: {
                        status: 'unavailable',
                        reason: `Branch ${config.baseBranch} is not readable in ${unreadable.join(', ')} with this token (Contents: read missing?)`,
                    },
                };
            }

            await tryStore('write branch history', async (s) => {
                for (const entry of histories) {
                    const reported = entry.history as BranchHistory;
                    await s.saveBranchHistory(client.provider, {
                        repo: entry.repo,
                        branch: entry.branch,
                        coveredFrom: reported.since,
                        commits: reported.commits,
                        reverts: reported.reverts,
                        newCommits: entry.commits,
                    });
                }
            });

            const persisted = await tryStore('read branch history', async (s) => ({
                commits: await s.loadBranchCommits(client.provider, repoNames, config.baseBranch),
                coverage: await s.loadBranchCoverage(client.provider, repoNames, config.baseBranch),
            }));

            const fetched: CommitPoint[] = histories.flatMap((entry) =>
                entry.commits.map((commit) => ({
                    repo: entry.repo,
                    committedAt: commit.committedAt,
                    isRevert: isRevertHeadline(commit.messageHeadline),
                })),
            );

            const commits = persisted
                ? persisted.commits.map((commit) => ({
                      repo: commit.repo,
                      committedAt: commit.committedAt,
                      isRevert: isRevertHeadline(commit.messageHeadline),
                  }))
                : fetched;

            const coverage: CoveragePoint[] = persisted
                ? persisted.coverage.map((c) => ({ repo: c.repo, from: c.from }))
                : histories.map((entry) => ({ repo: entry.repo, from: (entry.history as BranchHistory).since }));

            // Combined across repos, which is why an unreadable one above disqualifies the whole
            // figure. `commits` is the reported total, never a row count.
            const history: BranchHistory = persisted
                ? {
                      branch: config.baseBranch,
                      since: persisted.coverage.reduce<string>(
                          (min, c) => (min === '' || c.from < min ? c.from : min),
                          '',
                      ),
                      commits: persisted.coverage.reduce((n, c) => n + c.commits, 0),
                      reverts: persisted.coverage.reduce((n, c) => n + c.reverts, 0),
                  }
                : {
                      branch: config.baseBranch,
                      since: earliest,
                      commits: histories.reduce((n, h) => n + (h.history as BranchHistory).commits, 0),
                      reverts: histories.reduce((n, h) => n + (h.history as BranchHistory).reverts, 0),
                  };

            return { history, commits, coverage, revert: { status: 'ok', reason: null } };
        } catch (e) {
            return {
                history: null,
                commits: persistedCommits,
                coverage: previous?.coverage ?? [],
                revert: {
                    status: 'unavailable',
                    reason: e instanceof GitHubError ? e.message : (e as Error).message,
                },
            };
        }
    }

    async function produceTelemetry(): Promise<TelemetrySnapshot> {
        try {
            const input = await telemetry.fetchRollups({ repos: repoNames });
            telemetryFailure = null;
            return { input };
        } catch (e) {
            telemetryFailure = {
                at: now(),
                reason: e instanceof TelemetryError ? e.message : (e as Error).message,
            };
            throw e;
        }
    }

    // The floor on CACHE_TTL_SECONDS protects a full walk's ~243 points per repo. Once history is
    // persisted the ordinary refresh is an incremental walk of a few pages, so it gets a much
    // shorter TTL — and the full walk it may escalate to is gated by its own schedule and by the
    // remaining budget, not by this.
    const ttlMs = store ? config.syncTtlMs : config.cacheTtlMs;
    const cache = createCache<StatsSnapshot>({ ttlMs, produce, now });
    // A second slot with its own TTL. Sharing the PR slot would hide a session that just
    // finished for as long as that slot lives, and its floor exists to protect a rate-limit
    // budget this query does not spend.
    const telemetryCache = createCache<TelemetrySnapshot>({
        ttlMs: config.telemetryTtlMs,
        produce: produceTelemetry,
        now,
    });

    const start = () => {
        // A rejected refresh is reported through fetchState; an unhandled rejection here
        // would take the process down.
        cache.refresh().catch(() => {});
    };
    const startTelemetry = () => {
        telemetryCache.refresh().catch(() => {});
    };

    function telemetryMeta(
        entry: { value: TelemetrySnapshot; fetchedAt: number } | null,
        stats: TelemetryStats | null,
    ): TelemetryMeta {
        const source = config.telemetrySource === 'postgres' ? 'postgres' : 'fixture';
        const base = {
            source,
            repoFilter: repoNames,
            otherRepoSessions: stats?.otherRepoSessions ?? 0,
            sessionsWithoutHook: stats?.sessionsWithoutHook ?? 0,
        } as const;

        if (config.telemetrySource === 'off') {
            return { ...base, status: 'disabled', reason: null, fetchedAt: null, ageSeconds: null, stale: false };
        }
        if (!entry) {
            return {
                ...base,
                status: 'unreachable',
                reason: telemetryFailure?.reason ?? 'No telemetry has been read yet',
                fetchedAt: null,
                ageSeconds: null,
                stale: false,
            };
        }
        return {
            ...base,
            // Reachable but silent is its own state: it lets the panels render their structure,
            // which is how you see the pipeline is wired and just has nothing to say yet.
            status: entry.value.input.sessions.length === 0 ? 'empty' : 'ok',
            reason: telemetryFailure?.reason ?? null,
            fetchedAt: new Date(entry.fetchedAt).toISOString(),
            ageSeconds: Math.floor((now() - entry.fetchedAt) / 1000),
            stale: telemetryCache.isStale(),
        };
    }

    /**
     * The revert rate for a selected range.
     *
     * Persisted per-commit rows make this answerable at all; before them the only honest answer
     * for a narrowed range was "unavailable", because the scan was bounded by a single `since`
     * and could not be re-sliced.
     */
    function revertForRange(
        snapshot: StatsSnapshot,
        range: DateRange,
    ): { history: BranchHistory | null; revert: RevertStatus } {
        if (isAllTime(range)) return { history: snapshot.history, revert: snapshot.revert };
        if (snapshot.revert.status !== 'ok' || !snapshot.history) {
            return { history: null, revert: snapshot.revert };
        }
        if (!snapshot.commits.length) {
            return {
                history: null,
                revert: {
                    status: 'unavailable',
                    reason: 'Revert rate is measured over the full fetch window, not a selected range',
                },
            };
        }

        // A row count is only a valid denominator if every commit the provider counted was
        // actually stored. If the two disagree the slice would be a ratio over an unknown
        // subset, which is the failure the all-or-nothing rule above exists to prevent.
        if (snapshot.commits.length !== snapshot.history.commits) {
            return {
                history: null,
                revert: {
                    status: 'unavailable',
                    reason: `Persisted commits (${snapshot.commits.length}) disagree with the reported total (${snapshot.history.commits}); a range cannot be sliced from an incomplete scan`,
                },
            };
        }

        // Coverage is what distinguishes "no reverts in this range" from "history does not reach
        // back this far". Naming the repo matters: a combined figure over a subset is worse than
        // no figure.
        const short = snapshot.coverage.filter((c) => range.from !== null && c.from > range.from);
        const missing = repoNames.filter((repo) => !snapshot.coverage.some((c) => c.repo === repo));
        if (short.length || missing.length) {
            const repos = [...short.map((c) => c.repo), ...missing];
            return {
                history: null,
                revert: {
                    status: 'unavailable',
                    reason: `Persisted history for ${repos.join(', ')} does not reach back to the start of this range`,
                },
            };
        }

        const inRange = snapshot.commits.filter(
            (commit) =>
                (range.from === null || commit.committedAt >= range.from) &&
                (range.to === null || commit.committedAt < range.to),
        );
        return {
            history: {
                branch: config.baseBranch,
                since: range.from ?? snapshot.history.since,
                commits: inRange.length,
                reverts: inRange.filter((commit) => commit.isRevert).length,
            },
            revert: { status: 'ok', reason: null },
        };
    }

    return {
        async prime() {
            if (!store) return;
            if (priming) return priming;

            priming = (async () => {
                const loaded = await tryStore('prime', async (s) => ({
                    prs: await s.loadPullRequests(client.provider, repoNames),
                    commits: await s.loadBranchCommits(client.provider, repoNames, config.baseBranch),
                    coverage: await s.loadBranchCoverage(client.provider, repoNames, config.baseBranch),
                    sync: await s.readSyncState(client.provider, repoNames, PR_KIND),
                }));
                if (!loaded || !loaded.prs.length) return;

                const lastSyncAt = repoNames
                    .map((repo) => loaded.sync[repo]?.lastSyncAt)
                    .filter((at): at is string => typeof at === 'string')
                    .reduce<string | null>((min, at) => (min === null || at < min ? at : min), null);
                const rateLimit = repoNames
                    .map((repo) => loaded.sync[repo]?.lastRateLimit)
                    .find((limit): limit is RateLimit => !!limit) ?? null;

                const commits: CommitPoint[] = loaded.commits.map((commit) => ({
                    repo: commit.repo,
                    committedAt: commit.committedAt,
                    isRevert: isRevertHeadline(commit.messageHeadline),
                }));
                const history: BranchHistory | null = loaded.coverage.length
                    ? {
                          branch: config.baseBranch,
                          since: loaded.coverage.reduce<string>(
                              (min, c) => (min === '' || c.from < min ? c.from : min),
                              '',
                          ),
                          commits: loaded.coverage.reduce((n, c) => n + c.commits, 0),
                          reverts: loaded.coverage.reduce((n, c) => n + c.reverts, 0),
                      }
                    : null;

                const snapshot = snapshotFrom(
                    loaded.prs,
                    commits,
                    loaded.coverage.map((c) => ({ repo: c.repo, from: c.from })),
                    history,
                    history
                        ? { status: 'ok', reason: null }
                        : { status: 'unavailable', reason: 'No persisted branch history yet' },
                    rateLimit,
                );

                // Dated by when the data was actually fetched, never by now(). Seeding with now()
                // would report ageSeconds: 0 and stale: false off a three-day-old database, and
                // ensureFresh() would then decline to sync — a frozen dashboard that looks fresh.
                const fetchedAt = lastSyncAt ? new Date(lastSyncAt).getTime() : 0;
                cache.seed(snapshot, fetchedAt);
                persistence = { ...persistence, status: 'ok', reason: null, lastSyncAt };
            })().finally(() => {
                priming = null;
            });

            return priming;
        },

        current(range = ALL_TIME) {
            const entry = cache.peek();
            if (!entry) return null;
            const snapshot = entry.value;

            // Aggregated at read time, not at fetch time: compute() is pure over ~200 records,
            // so every range is served from the one fetch the rate-limit budget paid for.
            const prs = filterPrs(snapshot.derived, range);
            const { history, revert } = revertForRange(snapshot, range);

            const stats = compute(prs, {
                history,
                baseBranch: config.baseBranch,
                bots,
                now: new Date(now()),
            });

            const telemetryEntry = config.telemetrySource === 'off' ? null : telemetryCache.peek();
            const telemetry = telemetryEntry
                ? attribute(
                      prs.map(toJoinKey),
                      filterTelemetryInput(telemetryEntry.value.input, range),
                      { repos: repoNames, now: new Date(now()) },
                  )
                : null;

            return {
                stats,
                telemetry,
                meta: {
                    fetchedAt: new Date(entry.fetchedAt).toISOString(),
                    ageSeconds: Math.floor((now() - entry.fetchedAt) / 1000),
                    stale: cache.isStale(),
                    source: config.dataSource === 'fixture' ? 'fixture' : 'live',
                    rateLimit: snapshot.rateLimit,
                    revert,
                    organization: {
                        // A literal, not a config field. A switch that could say 'directory' with
                        // no directory behind it is the inexpressible-bad-combination rule again —
                        // the same reason `persistence` is derived rather than configured.
                        mode: 'config',
                        current: organization,
                        available: [organization],
                    },
                    repos: config.repos.map((repo) => ({ owner: repo.owner, name: repo.name })),
                    baseBranch: config.baseBranch,
                    range,
                    telemetry: telemetryMeta(telemetryEntry, telemetry),
                    persistence,
                },
            };
        },

        ensureFresh() {
            // The two are checked independently on purpose: a GitHub cooldown must not
            // suppress the telemetry read, and a dead database must not stall the PR fetch.
            if (config.telemetrySource !== 'off' && telemetryCache.isStale() && !telemetryCache.inFlight()) {
                const cooling =
                    telemetryFailure !== null && now() - telemetryFailure.at < TELEMETRY_COOLDOWN_MS;
                if (!cooling) startTelemetry();
            }
            // A sync started while priming is in flight races the seed and would burn a full
            // walk, because the store's watermarks have not been read yet.
            if (priming !== null) return;
            if (!cache.isStale() || cache.inFlight()) return;
            if (lastFailureAt !== null && now() - lastFailureAt < ERROR_COOLDOWN_MS) return;
            start();
        },

        refresh() {
            if (!cache.inFlight()) start();
            if (config.telemetrySource !== 'off' && !telemetryCache.inFlight()) startTelemetry();
        },

        fetchState: () => fetchState,
    };
}
