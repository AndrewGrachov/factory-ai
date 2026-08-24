import { readFileSync } from 'node:fs';
import type { BranchHistory, CanonicalPr, TelemetryInput } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { PrStore, SyncState } from '../src/db/pr-store.js';
import type { ForgeClient, PullRequestsResult } from '../src/forge.js';
import { fixturePayload } from '../src/github/fixture-payload.js';
import { GITHUB_CAPABILITIES, toCanonical } from '../src/github/map.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';

const TELEMETRY_FIXTURE = new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

export const TEST_REPO = 'Leeloo-AI-RGA-OS/leeloo.ai';

let payload: CanonicalPr[] | null = null;
/** Mapped through the adapter, like both real clients do, rather than read pre-canonicalised. */
export function samplePrs(): CanonicalPr[] {
    if (!payload) {
        payload = fixturePayload().map((pr) => toCanonical(pr, TEST_REPO));
    }
    return payload;
}

let telemetryPayload: TelemetryInput | null = null;
export function sampleTelemetry(): TelemetryInput {
    if (!telemetryPayload) {
        telemetryPayload = JSON.parse(readFileSync(TELEMETRY_FIXTURE, 'utf8')) as TelemetryInput;
    }
    return telemetryPayload;
}

export const EMPTY_TELEMETRY: TelemetryInput = {
    sessions: [],
    spans: [],
    splits: [],
    links: [],
    coverage: { from: null, to: null },
};

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        repos: [{ owner: 'Leeloo-AI-RGA-OS', name: 'leeloo.ai' }],
        baseBranch: 'dev',
        bots: ['claude', 'claude[bot]', 'github-actions', 'github-actions[bot]', 'leeloo-frontend-fix-bot'],
        cacheTtlMs: 900_000,
        syncTtlMs: 60_000,
        persistence: 'off',
        port: 0,
        host: '127.0.0.1',
        dataSource: 'github',
        webRoot: null,
        telemetrySource: 'fixture',
        databaseUrl: null,
        telemetryTtlMs: 30_000,
        repoNames: [TEST_REPO],
        ...overrides,
    };
}

export interface StubOptions {
    prs?: () => Promise<PullRequestsResult>;
    /** A single repo's history. The stub wraps it into the per-repo list the client returns. */
    history?: () => Promise<BranchHistory | null>;
    /** The base-branch commits the history is made of. Needed to slice a revert rate by date. */
    commits?: () => { sha: string; committedAt: string; messageHeadline: string }[];
}

export interface Stub extends ForgeClient {
    prCalls: number;
    historyCalls: number;
    /** What the service asked each walk to stop at, so a test can pin the cutoff arithmetic. */
    lastCutoff: Record<string, string> | null;
    lastMode: string | null;
    /** What the service asked each history scan to start from. */
    lastSince: Record<string, string> | null;
}

export function stubClient(options: StubOptions = {}): Stub {
    const stub: Stub = {
        provider: 'github',
        capabilities: GITHUB_CAPABILITIES,
        prCalls: 0,
        historyCalls: 0,
        lastCutoff: null,
        lastMode: null,
        lastSince: null,
        async fetchPullRequests({ mode, cutoff } = {}) {
            stub.prCalls += 1;
            stub.lastMode = mode ?? null;
            stub.lastCutoff = cutoff ?? null;
            if (options.prs) return options.prs();
            return {
                prs: structuredClone(samplePrs()),
                rateLimit: null,
                completed: { [TEST_REPO]: true },
            };
        },
        async fetchBranchHistories(since) {
            stub.historyCalls += 1;
            stub.lastSince = since;
            const history = options.history
                ? await options.history()
                : { branch: 'dev', since: '2026-04-03T00:00:00Z', commits: 515, reverts: 5 };
            return [
                { repo: TEST_REPO, branch: 'dev', history, commits: options.commits?.() ?? [] },
            ];
        },
    };
    return stub;
}

export interface MemoryStore extends PrStore {
    /** Every write the service attempted, so a test can assert what was and was not persisted. */
    saved: CanonicalPr[][];
    recorded: { repo: string; kind: string; watermarkAt: string | null; mode: string }[];
    /** Set to make every method reject, standing in for an unreachable database. */
    broken: boolean;
}

/**
 * An in-memory PrStore. Keeps the offline suite a no-database suite while still exercising the
 * seed, the watermark arithmetic and the failure isolation — the SQL itself is covered by
 * server/test-db, which needs a container.
 */
export function memoryPrStore(seed: {
    prs?: CanonicalPr[];
    commits?: { repo: string; branch: string; sha: string; committedAt: string; messageHeadline: string }[];
    coverage?: { repo: string; branch: string; from: string; commits: number; reverts: number }[];
    sync?: Record<string, Partial<SyncState>>;
    /** The instant a recorded sync is stamped with. Never the real clock: the harness pins time. */
    now?: () => number;
} = {}): MemoryStore {
    const now = seed.now ?? (() => Date.parse('2026-08-21T12:00:00.000Z'));
    let prs = seed.prs ? [...seed.prs] : [];
    const commits = seed.commits ? [...seed.commits] : [];
    const coverage = seed.coverage ? [...seed.coverage] : [];
    const sync: Record<string, SyncState> = {};
    for (const [repo, state] of Object.entries(seed.sync ?? {})) {
        sync[repo] = {
            watermarkAt: null,
            lastSyncAt: null,
            lastFullAt: null,
            syncedEpoch: 0,
            lastRateLimit: null,
            ...state,
        };
    }

    const guard = () => {
        if (store.broken) throw new Error('database is unreachable');
    };

    const store: MemoryStore = {
        saved: [],
        recorded: [],
        broken: false,

        async loadPullRequests() {
            guard();
            // Same ordering the SQL imposes, and for the same reason: compute() reads
            // stats.meta.window off array position.
            return [...prs].sort(
                (a, b) =>
                    b.createdAt.localeCompare(a.createdAt) ||
                    a.repo.localeCompare(b.repo) ||
                    b.number - a.number,
            );
        },
        async savePullRequests(incoming) {
            guard();
            store.saved.push([...incoming]);
            const byKey = new Map(prs.map((pr) => [`${pr.repo}#${pr.number}`, pr]));
            for (const pr of incoming) byKey.set(`${pr.repo}#${pr.number}`, pr);
            prs = [...byKey.values()];
        },
        async loadBranchCommits(_provider, _repos, branch) {
            guard();
            return commits.filter((c) => c.branch === branch);
        },
        async saveBranchHistory(_provider, entry) {
            guard();
            for (const commit of entry.newCommits) {
                if (commits.some((c) => c.repo === entry.repo && c.sha === commit.sha)) continue;
                commits.push({ repo: entry.repo, branch: entry.branch, ...commit });
            }
            const held = coverage.find((c) => c.repo === entry.repo && c.branch === entry.branch);
            if (held) {
                held.from = held.from < entry.coveredFrom ? held.from : entry.coveredFrom;
                held.commits = entry.commits;
                held.reverts = entry.reverts;
            } else {
                coverage.push({
                    repo: entry.repo,
                    branch: entry.branch,
                    from: entry.coveredFrom,
                    commits: entry.commits,
                    reverts: entry.reverts,
                });
            }
        },
        async loadBranchCoverage(_provider, _repos, branch) {
            guard();
            return coverage
                .filter((c) => c.branch === branch)
                .map((c) => ({ ...c, scannedAt: '2026-08-21T12:00:00.000Z' }));
        },
        async readSyncState() {
            guard();
            return structuredClone(sync);
        },
        async oldestOpenUpdatedAt() {
            guard();
            const oldest: Record<string, string> = {};
            for (const pr of prs) {
                if (pr.state !== 'open') continue;
                const held = oldest[pr.repo];
                if (!held || pr.updatedAt < held) oldest[pr.repo] = pr.updatedAt;
            }
            return oldest;
        },
        async recordSync(_provider, repo, kind, update) {
            guard();
            store.recorded.push({ repo, kind, watermarkAt: update.watermarkAt ?? null, mode: update.mode });
            const held = sync[repo] ?? {
                watermarkAt: null,
                lastSyncAt: null,
                lastFullAt: null,
                syncedEpoch: 0,
                lastRateLimit: null,
            };
            sync[repo] = {
                watermarkAt:
                    update.watermarkAt && (!held.watermarkAt || update.watermarkAt > held.watermarkAt)
                        ? update.watermarkAt
                        : held.watermarkAt,
                lastSyncAt: new Date(now()).toISOString(),
                lastFullAt: update.mode === 'full' ? new Date(now()).toISOString() : held.lastFullAt,
                syncedEpoch: Math.max(held.syncedEpoch, update.syncedEpoch),
                lastRateLimit: update.rateLimit ?? held.lastRateLimit,
            };
        },
    };
    return store;
}

export interface TelemetryStubOptions {
    rollups?: () => Promise<TelemetryInput>;
    health?: () => Promise<TelemetryHealth>;
}

export interface TelemetryStub extends TelemetryClient {
    rollupCalls: number;
    healthCalls: number;
}

export function stubTelemetryClient(options: TelemetryStubOptions = {}): TelemetryStub {
    const stub: TelemetryStub = {
        rollupCalls: 0,
        healthCalls: 0,
        async fetchRollups() {
            stub.rollupCalls += 1;
            if (options.rollups) return options.rollups();
            return structuredClone(sampleTelemetry());
        },
        async health() {
            stub.healthCalls += 1;
            if (options.health) return options.health();
            return { status: 'ok', reason: null };
        },
    };
    return stub;
}

export async function harness(options: {
    client: Stub;
    config?: Partial<AppConfig>;
    /** Defaults to the fixture stub, so tests written before telemetry existed still pass. */
    telemetry?: TelemetryStub;
    /** Absent by default, so the offline suite stays a no-database suite. */
    store?: PrStore;
}) {
    const config = testConfig(options.config);
    const telemetry = options.telemetry ?? stubTelemetryClient();
    let clock = Date.parse('2026-08-21T12:00:00.000Z');
    const service = createStatsService({
        config,
        client: options.client,
        telemetry,
        store: options.store,
        now: () => clock,
    });
    const app = await buildApp({ config, service, now: () => clock });
    return {
        app,
        service,
        client: options.client,
        telemetry,
        advance: (ms: number) => {
            clock += ms;
        },
        /** Lets the single-flight refresh promise settle without real timers. */
        settle: async () => {
            for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
        },
    };
}
