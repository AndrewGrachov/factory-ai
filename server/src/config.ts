import { DEFAULT_BOTS } from '@factory-ai/core';
import type { TelemetrySource } from './telemetry/client.js';

export interface Repo {
    readonly owner: string;
    readonly name: string;
}

export interface AppConfig {
    /**
     * The organization every figure on the page belongs to, and the key every org-owned primary
     * key leads with. One per deployment: there are no accounts and no memberships, so this is a
     * constant for the life of the process.
     */
    readonly orgId: string;
    /** Display only, never a key — which is why it has no character rules and the id does. */
    readonly orgName: string;
    /** The landing page reports every one of these combined. Never empty. */
    readonly repos: readonly Repo[];
    readonly baseBranch: string;
    readonly bots: readonly string[];
    /**
     * The cache slot's TTL.
     *
     * There is only one, because history is always persisted now: the ordinary refresh is an
     * incremental walk of a few pages, so it needs the cheap 60s-per-repo floor rather than the
     * 300s-per-repo one a full walk demanded. The expensive full walk it may escalate to is not
     * gated by any TTL — it runs on its own 24h schedule and refuses to start unless the
     * provider's reported remaining budget actually covers it, which is strictly stronger than
     * inferring affordability from a clock.
     */
    readonly syncTtlMs: number;
    readonly port: number;
    readonly host: string;
    readonly webRoot: string | null;
    readonly telemetrySource: TelemetrySource;
    /**
     * Required. The database is the only place figures come from, so there is no mode that runs
     * without one, and therefore no `null` to branch on at 30-odd call sites.
     */
    readonly databaseUrl: string;
    readonly telemetryTtlMs: number;
    /**
     * "owner/name" for each configured repo — the form the hook reports and the form stamped onto
     * every PR. Derived rather than configurable: a separate telemetry repo list is a second
     * source of truth that silently drops sessions the moment it drifts from `repos`.
     */
    readonly repoNames: readonly string[];
}

// A telemetry read is a local query with no quota to protect, so this floor exists only to stop a
// hot loop — unlike the sync floor below, which is rationing a rate-limit budget.
const MIN_TELEMETRY_TTL_SECONDS = 5;

// An incremental sync is ~2-5 pages, so ~5-10 points: 60s per repo costs ~600 points/hour/repo,
// about 12% of the 5000 budget, for a dashboard that is never more than a minute stale. The
// expensive full walk is not gated by this at all — see FULL_RESYNC_INTERVAL_MS.
const MIN_SYNC_TTL_SECONDS_PER_REPO = 60;

/**
 * A database whose name ends here is disposable — the db suite truncates it, and `npm run seed`
 * fills it with synthetic pull requests. Either would destroy or counterfeit real history.
 */
const DISPOSABLE_DATABASE = /_(test|seed|synthetic|demo|e2e)$/;

/**
 * The organization id when nothing sets one.
 *
 * A literal rather than something derived from GITHUB_OWNER: the id leads every org-owned primary
 * key, so deriving it would silently re-key every persisted row the day the owner changes — the
 * dashboard comes back empty and it reads as data loss, not as a config change. The *name* is
 * derived from the owner for exactly the opposite reason: nothing keys on a label.
 *
 * It defaults rather than being required because `loadConfig({})` has to keep meaning what it means
 * today; a newly required variable that fails every existing case is the signal not to require it.
 */
const DEFAULT_ORG_ID = 'default';

/**
 * The id lands in a database primary key and in a `?org=` query parameter, so the character set is
 * closed here rather than checked at each edge. Lowercase only, because a case-insensitive
 * collision in a key is invisible: `Leeloo` and `leeloo` are two partitions that read as one. No
 * dots, so the id stays usable as a bare path segment later. 39 characters is GitHub's login bound
 * — a familiar cap that keeps the key short.
 */
const ORG_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,38}$/;

/**
 * Reserved: `005_organizations.sql` backfills pre-organization rows to `__unclaimed__` and adopts
 * them into the configured org once, at boot. A configured id inside that namespace would make the
 * adoption a no-op that looks like it worked.
 */
const RESERVED_ORG_PREFIX = '__';

function databaseName(url: string): string | null {
    try {
        return new URL(url).pathname.replace(/^\//, '') || null;
    } catch {
        return null;
    }
}

function int(raw: string | undefined, fallback: number, label: string): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${label} must be a positive integer, got "${raw}"`);
    }
    return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
    // DATA_SOURCE selected between the live API and a replayed 203-PR payload. It is gone, and
    // fatal rather than ignored for the same reason GITHUB_REPOS is: it used to change what the
    // whole page was made of, so an ignored one would boot a dashboard the operator believes is
    // showing something else. Synthetic data now arrives by seeding a disposable database
    // (`npm run seed`), where it is at least visible as rows somebody chose to write.
    if (env.DATA_SOURCE) {
        throw new Error(
            `DATA_SOURCE is no longer supported (got "${env.DATA_SOURCE}"). The database is the only source the dashboard reads. For data without a GitHub token, seed a disposable database: npm run seed.`,
        );
    }

    const owner = env.GITHUB_OWNER ?? 'Leeloo-AI-RGA-OS';

    // GITHUB_REPOS held this list until the organization took ownership of it. Fatal rather than
    // ignored — the one deliberate exception to "an unknown environment variable is ignored", and
    // for the very reason that rule is stated: an ignored GITHUB_REPOS quietly reverts a two-repo
    // dashboard to one repo and still renders, indistinguishable from a repo genuinely removed.
    // An empty value is not an override, here as everywhere, or a bare `GITHUB_REPOS=` line left
    // in .env would refuse to boot.
    if (env.GITHUB_REPOS) {
        throw new Error(
            'GITHUB_REPOS has moved to ORG_REPOS: the organization owns the repo list now. Rename the variable, or move the line into an [organization] table in factory.toml.',
        );
    }

    const orgId = env.ORG_ID?.trim() || DEFAULT_ORG_ID;
    if (!ORG_ID_PATTERN.test(orgId) || orgId.startsWith(RESERVED_ORG_PREFIX)) {
        throw new Error(
            `ORG_ID must be 1-39 characters of lowercase letters, digits, "-" or "_", starting with a letter or digit, and may not begin with "__" — it is a database key and a URL parameter, so it is rejected rather than normalised — got "${orgId}"`,
        );
    }
    // Falls back to the GitHub owner, not to the id: a deployment that sets nothing shows
    // "Leeloo-AI-RGA-OS" in the selector rather than the word "default", which reads as a bug.
    // Empty is unset, because an empty name renders an invisible control.
    const orgName = env.ORG_NAME?.trim() || owner;

    const names = env.ORG_REPOS
        ? env.ORG_REPOS.split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : ['leeloo.ai'];
    if (!names.length) throw new Error('ORG_REPOS lists no repositories');
    // A bare name takes GITHUB_OWNER; a qualified "other-owner/name" keeps its own. So the
    // organization's repo list is not confined to one GitHub owner — a Factory organization is not
    // a GitHub organization, and `organization.id` has nothing to do with `github.owner`.
    const repos: Repo[] = names.map((entry) => {
        const slash = entry.indexOf('/');
        if (slash === -1) return { owner, name: entry };
        const [entryOwner, entryName] = [entry.slice(0, slash), entry.slice(slash + 1)];
        if (!entryOwner || !entryName || entryName.includes('/')) {
            throw new Error(`ORG_REPOS entry "${entry}" must be "name" or "owner/name"`);
        }
        return { owner: entryOwner, name: entryName };
    });

    // CACHE_TTL_SECONDS floored the slot at 300s per repo because every refresh was a full walk.
    // With history always persisted, the ordinary refresh is incremental and SYNC_TTL_SECONDS is
    // the only floor there is. Fatal rather than ignored: a deployment that had raised it to
    // protect its quota would otherwise silently drop to a 60s floor.
    if (env.CACHE_TTL_SECONDS) {
        throw new Error(
            'CACHE_TTL_SECONDS is no longer supported: refreshes are incremental now, so SYNC_TTL_SECONDS is the only cache floor. Rename it, or move the line to cache.sync_ttl_seconds in factory.toml.',
        );
    }

    const telemetrySource = (env.TELEMETRY_SOURCE ?? 'postgres') as TelemetrySource;
    if (!['postgres', 'fixture', 'off'].includes(telemetrySource)) {
        throw new Error(
            `TELEMETRY_SOURCE must be "postgres", "fixture", or "off", got "${env.TELEMETRY_SOURCE}"`,
        );
    }

    const telemetryTtlSeconds = int(env.TELEMETRY_TTL_SECONDS, 30, 'TELEMETRY_TTL_SECONDS');
    if (telemetryTtlSeconds < MIN_TELEMETRY_TTL_SECONDS) {
        throw new Error(`TELEMETRY_TTL_SECONDS must be at least ${MIN_TELEMETRY_TTL_SECONDS}`);
    }

    const minSyncTtl = MIN_SYNC_TTL_SECONDS_PER_REPO * repos.length;
    const syncTtlSeconds = int(env.SYNC_TTL_SECONDS, Math.max(60, minSyncTtl), 'SYNC_TTL_SECONDS');
    if (syncTtlSeconds < minSyncTtl) {
        throw new Error(
            `SYNC_TTL_SECONDS must be at least ${minSyncTtl} for ${repos.length} ${repos.length === 1 ? 'repository' : 'repositories'}; an incremental sync still costs a few rate-limit points per repo`,
        );
    }

    const databaseUrl = env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error(
            'DATABASE_URL is required: the database is the only source the dashboard reads. Start one with `docker compose up -d timescale`, then either let it sync from GitHub or seed it with `npm run seed`.',
        );
    }

    /*
     * A missing token is a supported state, not an error.
     *
     * It means this process does not fetch: it serves whatever is already in the database. That is
     * what lets the browser check and a seeded demo run with no credentials and no network, and it
     * is honest on the page — the fetch fails fast with a named reason (envTokenProvider throws
     * before any request is built) while the persisted figures still render.
     *
     * The pairing below is the one combination that must stay impossible. A disposable database is
     * one that `npm run test:db` truncates and `npm run seed` fills with invented pull requests;
     * pointing a *fetching* process at one means real history is either destroyed on the next test
     * run or interleaved with synthetic rows that no later query can tell apart.
     */
    const name = databaseName(databaseUrl) ?? '';
    if (env.GITHUB_TOKEN && DISPOSABLE_DATABASE.test(name)) {
        throw new Error(
            `DATABASE_URL points at "${name}", which is disposable: the db suite truncates it and \`npm run seed\` writes synthetic pull requests into it. Refusing to persist real fetched history there. Use a database without a _test/_seed/_synthetic/_demo/_e2e suffix, or unset GITHUB_TOKEN to read what is already stored.`,
        );
    }

    const bots = env.BOTS
        ? env.BOTS.split(',')
              .map((b) => b.trim())
              .filter(Boolean)
        : DEFAULT_BOTS;

    return Object.freeze({
        orgId,
        orgName,
        repos: Object.freeze(repos.map((repo) => Object.freeze(repo))),
        baseBranch: env.BASE_BRANCH ?? 'dev',
        bots: Object.freeze(bots),
        syncTtlMs: syncTtlSeconds * 1000,
        port: int(env.PORT, 8080, 'PORT'),
        host: env.HOST ?? '127.0.0.1',
        webRoot: env.WEB_ROOT ?? null,
        telemetrySource,
        databaseUrl,
        telemetryTtlMs: telemetryTtlSeconds * 1000,
        repoNames: Object.freeze(repos.map((repo) => `${repo.owner}/${repo.name}`)),
    });
}
