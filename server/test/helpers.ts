import { readFileSync } from 'node:fs';
import type { BranchHistory, RawPullRequest } from '@factory-ai/core';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { GitHubClient, PullRequestsResult } from '../src/github/client.js';
import { createStatsService } from '../src/stats-service.js';

const FIXTURE = new URL('../../core/test/fixtures/sample-payload.json', import.meta.url);

let payload: RawPullRequest[] | null = null;
export function samplePrs(): RawPullRequest[] {
    if (!payload) payload = JSON.parse(readFileSync(FIXTURE, 'utf8')) as RawPullRequest[];
    return payload;
}

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

export async function harness(options: { client: Stub; config?: Partial<AppConfig> } ) {
    const config = testConfig(options.config);
    let clock = Date.parse('2026-08-21T12:00:00.000Z');
    const service = createStatsService({ config, client: options.client, now: () => clock });
    const app = await buildApp({ config, service });
    return {
        app,
        service,
        client: options.client,
        advance: (ms: number) => {
            clock += ms;
        },
        /** Lets the single-flight refresh promise settle without real timers. */
        settle: async () => {
            for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
        },
    };
}
