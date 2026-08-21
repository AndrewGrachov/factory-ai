import { DEFAULT_BOTS } from '@factory-ai/core';

export type DataSource = 'github' | 'fixture';

export interface AppConfig {
    readonly repo: { readonly owner: string; readonly name: string };
    readonly baseBranch: string;
    readonly bots: readonly string[];
    readonly cacheTtlMs: number;
    readonly port: number;
    readonly host: string;
    readonly dataSource: DataSource;
    readonly webRoot: string | null;
}

// A full fetch costs ~243 rate-limit points and ~45s against a 5000/hour budget, so a
// short TTL would let a handful of reloads exhaust the quota.
const MIN_TTL_SECONDS = 300;

function int(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer, got "${raw}"`);
    }
    return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    const dataSource = (env.DATA_SOURCE ?? 'fixture') as DataSource;
    if (dataSource !== 'github' && dataSource !== 'fixture') {
        throw new Error(`DATA_SOURCE must be "github" or "fixture", got "${env.DATA_SOURCE}"`);
    }
    if (dataSource === 'github' && !env.GITHUB_TOKEN) {
        throw new Error('DATA_SOURCE=github requires GITHUB_TOKEN');
    }

    const ttlSeconds = int(env.CACHE_TTL_SECONDS, 900, 'CACHE_TTL_SECONDS');
    if (ttlSeconds < MIN_TTL_SECONDS) {
        throw new Error(
            `CACHE_TTL_SECONDS must be at least ${MIN_TTL_SECONDS}; a full fetch costs ~243 rate-limit points`,
        );
    }

    const bots = env.BOTS
        ? env.BOTS.split(',')
              .map((b) => b.trim())
              .filter(Boolean)
        : DEFAULT_BOTS;

    return Object.freeze({
        repo: Object.freeze({
            owner: env.GITHUB_OWNER ?? 'Leeloo-AI-RGA-OS',
            name: env.GITHUB_REPO ?? 'leeloo.ai',
        }),
        baseBranch: env.BASE_BRANCH ?? 'dev',
        bots: Object.freeze(bots),
        cacheTtlMs: ttlSeconds * 1000,
        port: int(env.PORT, 8080, 'PORT'),
        host: env.HOST ?? '127.0.0.1',
        dataSource,
        webRoot: env.WEB_ROOT ?? null,
    });
}
