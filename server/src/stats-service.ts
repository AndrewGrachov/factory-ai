import {
    ALL_TIME,
    attribute,
    compute,
    deriveAll,
    filterPrs,
    filterTelemetryInput,
    isAllTime,
} from '@factory-ai/core';
import type {
    BranchHistory,
    DateRange,
    DerivedPr,
    PrTelemetryKey,
    Stats,
    TelemetryInput,
    TelemetryStats,
    TruncatedPr,
} from '@factory-ai/core';
import { createCache } from './cache.js';
import type { AppConfig } from './config.js';
import type { GitHubClient, Progress, RateLimit } from './github/client.js';
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
    repoFilter: string;
    /** Sessions the hook attributed to a different repo. */
    otherRepoSessions: number;
    /** Sessions with telemetry but no hook data — the plugin is missing, or failing. */
    sessionsWithoutHook: number;
}

export interface StatsSnapshot {
    /**
     * Kept whole rather than pre-aggregated, because a range selection re-runs compute() over
     * a subset. One GitHub fetch still serves every range.
     */
    derived: DerivedPr[];
    history: BranchHistory | null;
    truncated: TruncatedPr[];
    rateLimit: RateLimit | null;
    revert: RevertStatus;
}

export interface TelemetrySnapshot {
    input: TelemetryInput;
}

export interface FetchState {
    state: 'idle' | 'loading' | 'error';
    phase: 'prs' | 'backfill' | 'history' | null;
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
        repo: { owner: string; name: string };
        baseBranch: string;
        range: DateRange;
        telemetry: TelemetryMeta;
    };
}

export interface StatsService {
    /** Cached payload for a range, or null if nothing has ever been fetched successfully. */
    current(range?: DateRange): StatsPayload | null;
    /** Kicks off a refresh if one is warranted. Single-flight. */
    ensureFresh(): void;
    refresh(): void;
    fetchState(): FetchState;
}

export interface StatsServiceDeps {
    config: AppConfig;
    client: GitHubClient;
    telemetry: TelemetryClient;
    now?: () => number;
}

function idleState(): FetchState {
    return {
        state: 'idle',
        phase: null,
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

/** Deliberately not DerivedPr, so a change there cannot silently alter telemetry output. */
function toJoinKey(pr: DerivedPr): PrTelemetryKey {
    return {
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
    now = Date.now,
}: StatsServiceDeps): StatsService {
    const bots = new Set(config.bots);
    let fetchState = idleState();
    let lastFailureAt: number | null = null;
    let telemetryFailure: { at: number; reason: string } | null = null;

    async function produce(): Promise<StatsSnapshot> {
        fetchState = { ...idleState(), state: 'loading', startedAt: new Date(now()).toISOString() };
        const onProgress = (p: Progress) => {
            fetchState = {
                ...fetchState,
                phase: p.phase,
                prsFetched: p.prsFetched ?? fetchState.prsFetched,
                backfillingPr: p.backfillingPr ?? fetchState.backfillingPr,
                historyScanned: p.historyScanned ?? fetchState.historyScanned,
            };
        };

        try {
            const { prs, truncated, rateLimit } = await client.fetchPullRequests({ onProgress });
            const derived = deriveAll(prs, bots);

            // Only the revert rate depends on Contents: read. Its failure degrades one
            // metric to "unavailable" instead of failing the whole dashboard, and must
            // never surface as {commits: 0, reverts: 0}.
            const merged = derived.filter((pr) => pr.mergedAt);
            const earliest = merged.reduce<string | null>(
                (min, pr) => (min === null || (pr.mergedAt as string) < min ? pr.mergedAt : min),
                null,
            );

            let history: BranchHistory | null = null;
            let revert: RevertStatus = { status: 'unavailable', reason: 'No merged PRs to bound the history query' };
            if (earliest) {
                try {
                    history = await client.fetchBranchHistory(earliest, { onProgress });
                    revert = history
                        ? { status: 'ok', reason: null }
                        : {
                              status: 'unavailable',
                              reason: `Branch ${config.baseBranch} is not readable with this token (Contents: read missing?)`,
                          };
                } catch (e) {
                    revert = {
                        status: 'unavailable',
                        reason: e instanceof GitHubError ? e.message : (e as Error).message,
                    };
                }
            }

            fetchState = { ...fetchState, state: 'idle', phase: null, finishedAt: new Date(now()).toISOString() };
            lastFailureAt = null;
            return { derived, history, truncated, rateLimit, revert };
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

    async function produceTelemetry(): Promise<TelemetrySnapshot> {
        try {
            const input = await telemetry.fetchRollups({ repo: config.telemetryRepo });
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

    const cache = createCache<StatsSnapshot>({ ttlMs: config.cacheTtlMs, produce, now });
    // A second slot with its own TTL. Sharing the 900s slot would hide a session that just
    // finished for up to fifteen minutes, and the 300s floor exists to protect a rate-limit
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
            repoFilter: config.telemetryRepo,
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

    return {
        current(range = ALL_TIME) {
            const entry = cache.peek();
            if (!entry) return null;
            const snapshot = entry.value;

            // Aggregated at read time, not at fetch time: compute() is pure over ~200 records,
            // so every range is served from the one fetch the rate-limit budget paid for.
            const prs = filterPrs(snapshot.derived, range);
            const fullWindow = isAllTime(range);

            // The commit history was fetched with `since` = earliest merge of the whole window,
            // so its commit and revert counts cannot be re-sliced. Left in place beside
            // range-scoped metrics they would read as the revert rate *for the range*.
            const revert: RevertStatus = fullWindow
                ? snapshot.revert
                : {
                      status: 'unavailable',
                      reason: 'Revert rate is measured over the full fetch window, not a selected range',
                  };

            const inRange = new Set(prs.map((pr) => pr.number));
            const stats = compute(prs, {
                history: fullWindow ? snapshot.history : null,
                baseBranch: config.baseBranch,
                truncated: snapshot.truncated.filter((t) => inRange.has(t.number)),
                bots,
                now: new Date(now()),
            });

            const telemetryEntry = config.telemetrySource === 'off' ? null : telemetryCache.peek();
            const telemetry = telemetryEntry
                ? attribute(
                      prs.map(toJoinKey),
                      filterTelemetryInput(telemetryEntry.value.input, range),
                      { repo: config.telemetryRepo, now: new Date(now()) },
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
                    repo: { owner: config.repo.owner, name: config.repo.name },
                    baseBranch: config.baseBranch,
                    range,
                    telemetry: telemetryMeta(telemetryEntry, telemetry),
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
