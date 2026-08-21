import { compute, deriveAll } from '@factory-ai/core';
import type { BranchHistory, Stats } from '@factory-ai/core';
import { createCache } from './cache.js';
import type { AppConfig } from './config.js';
import type { GitHubClient, Progress, RateLimit } from './github/client.js';
import { GitHubError } from './github/errors.js';

export interface RevertStatus {
    status: 'ok' | 'unavailable';
    reason: string | null;
}

export interface StatsSnapshot {
    stats: Stats;
    rateLimit: RateLimit | null;
    revert: RevertStatus;
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
    meta: {
        fetchedAt: string;
        ageSeconds: number;
        stale: boolean;
        source: 'live' | 'fixture';
        rateLimit: RateLimit | null;
        revert: RevertStatus;
        repo: { owner: string; name: string };
        baseBranch: string;
    };
}

export interface StatsService {
    /** Cached payload, or null if nothing has ever been fetched successfully. */
    current(): StatsPayload | null;
    /** Kicks off a refresh if one is warranted. Single-flight. */
    ensureFresh(): void;
    refresh(): void;
    fetchState(): FetchState;
}

export interface StatsServiceDeps {
    config: AppConfig;
    client: GitHubClient;
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

export function createStatsService({ config, client, now = Date.now }: StatsServiceDeps): StatsService {
    const bots = new Set(config.bots);
    let fetchState = idleState();
    let lastFailureAt: number | null = null;

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

            const stats = compute(derived, {
                history,
                baseBranch: config.baseBranch,
                truncated,
                bots,
                now: new Date(now()),
            });

            fetchState = { ...fetchState, state: 'idle', phase: null, finishedAt: new Date(now()).toISOString() };
            lastFailureAt = null;
            return { stats, rateLimit, revert };
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

    const cache = createCache<StatsSnapshot>({ ttlMs: config.cacheTtlMs, produce, now });

    const start = () => {
        // A rejected refresh is reported through fetchState; an unhandled rejection here
        // would take the process down.
        cache.refresh().catch(() => {});
    };

    return {
        current() {
            const entry = cache.peek();
            if (!entry) return null;
            return {
                stats: entry.value.stats,
                meta: {
                    fetchedAt: new Date(entry.fetchedAt).toISOString(),
                    ageSeconds: Math.floor((now() - entry.fetchedAt) / 1000),
                    stale: cache.isStale(),
                    source: config.dataSource === 'fixture' ? 'fixture' : 'live',
                    rateLimit: entry.value.rateLimit,
                    revert: entry.value.revert,
                    repo: { owner: config.repo.owner, name: config.repo.name },
                    baseBranch: config.baseBranch,
                },
            };
        },
        ensureFresh() {
            if (!cache.isStale() || cache.inFlight()) return;
            if (lastFailureAt !== null && now() - lastFailureAt < ERROR_COOLDOWN_MS) return;
            start();
        },
        refresh() {
            if (!cache.inFlight()) start();
        },
        fetchState: () => fetchState,
    };
}
