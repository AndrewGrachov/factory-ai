import { readFileSync } from 'node:fs';
import type { BranchHistory, RawPullRequest, TelemetryInput } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { GitHubClient, PullRequestsResult } from '../src/github/client.js';
import { createStatsService } from '../src/stats-service.js';
import type { TelemetryClient, TelemetryHealth } from '../src/telemetry/client.js';

const FIXTURE = new URL('../../core/test/fixtures/sample-payload.json', import.meta.url);
const TELEMETRY_FIXTURE = new URL('../../core/test/fixtures/telemetry-sessions.json', import.meta.url);

let payload: RawPullRequest[] | null = null;
export function samplePrs(): RawPullRequest[] {
    if (!payload) payload = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RawPullRequest[];
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
        repo: { owner: 'Leeloo-AI-RGA-OS', name: 'leeloo.ai' },
        baseBranch: 'dev',
        bots: ['claude', 'claude[bot]', 'github-actions', 'github-actions[bot]', 'leeloo-frontend-fix-bot'],
        cacheTtlMs: 900_000,
        port: 0,
        host: '127.0.0.1',
        dataSource: 'github',
        webRoot: null,
        telemetrySource: 'fixture',
        databaseUrl: null,
        telemetryTtlMs: 30_000,
        telemetryRepo: 'Leeloo-AI-RGA-OS/leeloo.ai',
        ...overrides,
    };
}

export interface StubOptions {
    prs?: () => Promise<PullRequestsResult>;
    history?: () => Promise<BranchHistory | null>;
}

export interface Stub extends GitHubClient {
    prCalls: number;
    historyCalls: number;
}

export function stubClient(options: StubOptions = {}): Stub {
    const stub: Stub = {
        prCalls: 0,
        historyCalls: 0,
        async fetchPullRequests() {
            stub.prCalls += 1;
            if (options.prs) return options.prs();
            return { prs: structuredClone(samplePrs()), truncated: [], rateLimit: null };
        },
        async fetchBranchHistory() {
            stub.historyCalls += 1;
            if (options.history) return options.history();
            return { branch: 'dev', since: '2026-04-03T00:00:00Z', commits: 515, reverts: 5 };
        },
    };
    return stub;
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
}) {
    const config = testConfig(options.config);
    const telemetry = options.telemetry ?? stubTelemetryClient();
    let clock = Date.parse('2026-08-21T12:00:00.000Z');
    const service = createStatsService({ config, client: options.client, telemetry, now: () => clock });
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
