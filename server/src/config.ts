import { DEFAULT_BOTS } from '@factory-ai/core';
import type { TelemetrySource } from './telemetry/client.js';

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
    readonly telemetrySource: TelemetrySource;
    readonly databaseUrl: string | null;
    readonly telemetryTtlMs: number;
    /** Only sessions the hook tagged with this repo count toward the dashboard. */
    readonly telemetryRepo: string;
}

// A full fetch costs ~243 rate-limit points and ~45s against a 5000/hour budget, so a
// short TTL would let a handful of reloads exhaust the quota.
const MIN_TTL_SECONDS = 300;

// Not a typo next to the 300s above: the reasons are opposite. A telemetry read is a local
// query with no quota to protect, so the floor exists only to stop a hot loop.
const MIN_TELEMETRY_TTL_SECONDS = 5;

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

    const telemetrySource = (env.TELEMETRY_SOURCE ?? 'fixture') as TelemetrySource;
    if (!['postgres', 'fixture', 'off'].includes(telemetrySource)) {
        throw new Error(
            `TELEMETRY_SOURCE must be "postgres", "fixture", or "off", got "${env.TELEMETRY_SOURCE}"`,
        );
    }
    if (telemetrySource === 'postgres' && !env.DATABASE_URL) {
        throw new Error('TELEMETRY_SOURCE=postgres requires DATABASE_URL');
    }

    const telemetryTtlSeconds = int(env.TELEMETRY_TTL_SECONDS, 30, 'TELEMETRY_TTL_SECONDS');
    if (telemetryTtlSeconds < MIN_TELEMETRY_TTL_SECONDS) {
        throw new Error(`TELEMETRY_TTL_SECONDS must be at least ${MIN_TELEMETRY_TTL_SECONDS}`);
    }

    const bots = env.BOTS
        ? env.BOTS.split(',')
              .map((b) => b.trim())
              .filter(Boolean)
        : DEFAULT_BOTS;

    const owner = env.GITHUB_OWNER ?? 'Leeloo-AI-RGA-OS';
    const name = env.GITHUB_REPO ?? 'leeloo.ai';

    return Object.freeze({
        repo: Object.freeze({ owner, name }),
        baseBranch: env.BASE_BRANCH ?? 'dev',
        bots: Object.freeze(bots),
        cacheTtlMs: ttlSeconds * 1000,
        port: int(env.PORT, 8080, 'PORT'),
        host: env.HOST ?? '127.0.0.1',
        dataSource,
        webRoot: env.WEB_ROOT ?? null,
        telemetrySource,
        databaseUrl: env.DATABASE_URL ?? null,
        telemetryTtlMs: telemetryTtlSeconds * 1000,
        telemetryRepo: env.TELEMETRY_REPO ?? `${owner}/${name}`,
    });
}
