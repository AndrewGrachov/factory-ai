import { DEFAULT_BOTS } from '@factory-ai/core';
import type { TelemetrySource } from './telemetry/client.js';

export type DataSource = 'github' | 'fixture';

export interface Repo {
    readonly owner: string;
    readonly name: string;
}

export interface AppConfig {
    /** The landing page reports every one of these combined. Never empty. */
    readonly repos: readonly Repo[];
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
    /**
     * "owner/name" for each configured repo — the form the hook reports and the form stamped onto
     * every PR. Derived rather than configurable: a separate telemetry repo list is a second
     * source of truth that silently drops sessions the moment it drifts from `repos`.
     */
    readonly repoNames: readonly string[];
}

// A full fetch costs ~243 rate-limit points and ~45s against a 5000/hour budget, so a
// short TTL would let a handful of reloads exhaust the quota. Per repo, because the cost is
// paid once per repo: the floor has to scale with the list or the guard weakens as repos are
// added, which is exactly when it matters most.
const MIN_TTL_SECONDS_PER_REPO = 300;

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

    const owner = env.GITHUB_OWNER ?? 'Leeloo-AI-RGA-OS';
    const names = env.GITHUB_REPOS
        ? env.GITHUB_REPOS.split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : ['leeloo.ai'];
    if (!names.length) throw new Error('GITHUB_REPOS lists no repositories');
    // A bare name takes GITHUB_OWNER; a qualified "other-owner/name" keeps its own, so one
    // dashboard can span organisations without a second owner setting.
    const repos: Repo[] = names.map((entry) => {
        const slash = entry.indexOf('/');
        if (slash === -1) return { owner, name: entry };
        const [entryOwner, entryName] = [entry.slice(0, slash), entry.slice(slash + 1)];
        if (!entryOwner || !entryName || entryName.includes('/')) {
            throw new Error(`GITHUB_REPOS entry "${entry}" must be "name" or "owner/name"`);
        }
        return { owner: entryOwner, name: entryName };
    });

    const minTtlSeconds = MIN_TTL_SECONDS_PER_REPO * repos.length;
    const ttlSeconds = int(env.CACHE_TTL_SECONDS, Math.max(900, minTtlSeconds), 'CACHE_TTL_SECONDS');
    if (ttlSeconds < minTtlSeconds) {
        throw new Error(
            `CACHE_TTL_SECONDS must be at least ${minTtlSeconds} for ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}; a full fetch costs ~243 rate-limit points per repo`,
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

    return Object.freeze({
        repos: Object.freeze(repos.map((repo) => Object.freeze(repo))),
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
        repoNames: Object.freeze(repos.map((repo) => `${repo.owner}/${repo.name}`)),
    });
}
