import { isAbsolute, join } from 'node:path';
import { DEFAULT_BOTS } from '@factory-ai/core';
import type { TelemetrySource } from './telemetry/client.js';

export interface Repo {
    readonly owner: string;
    readonly name: string;
}

/**
 * How a request names its caller.
 *
 * A union rather than a record of optionals, so "half-configured auth" is unrepresentable rather
 * than merely rejected: there is no value of this type that has a client id and no secret, and no
 * call site has to re-check. The mode is also an EXPLICIT enum, never inferred from whether a client
 * id happens to be set — a mode reached by typo is exactly what docs/persistence.md warns about,
 * where "the service used to have a second, silent behaviour reachable by forgetting DATABASE_URL".
 */
export type AuthConfig =
    | {
          /**
           * Every route is open to anyone who can reach the port, as it was before accounts existed.
           * Kept because four things depend on it — `npm run seed`, `npm run verify:ui`,
           * `npm run test:jobs` and the route-test harness — and because there is no offline way to
           * obtain an OAuth client id, so requiring auth would make `git clone && npm run dev`
           * impossible. Same argument docs/configuration.md already makes for GITHUB_TOKEN.
           */
          readonly mode: 'none';
          readonly ingestToken: string | null;
      }
    | {
          readonly mode: 'github';
          readonly clientId: string;
          readonly clientSecret: string;
          /** Signs the session cookie, so rotating it logs everyone out. */
          readonly sessionSecret: string;
          readonly sessionTtlMs: number;
          /**
           * Whether the session cookie carries `Secure`.
           *
           * Configured rather than derived. Hard-coding it breaks every `http://127.0.0.1` boot;
           * relying on the browsers that except loopback is a trap, because Chromium does and Safari
           * does not, so `verify:ui` (which drives Chromium) would pass while a Safari developer
           * cannot sign in; and deriving it from `X-Forwarded-Proto` requires trusting a header from
           * anyone.
           */
          readonly cookieSecure: boolean;
          /**
           * The absolute origin GitHub redirects back to, e.g. `https://factory.example.com`.
           *
           * Explicit, never derived from the `Host` header: an attacker-controlled Host would then
           * choose the `redirect_uri`, which is redirect poisoning.
           */
          readonly publicUrl: string;
          /** A GitHub login made an admin at boot iff the organization has no members at all. */
          readonly bootstrapAdmin: string | null;
          /**
           * A GitHub organization whose members admit themselves on first sign-in, as ordinary
           * members. Null keeps invite-only membership, where an admin names every login in advance.
           *
           * The boundary moves to GitHub, which is the point: onboarding becomes "add them to the
           * org" rather than a second, parallel roster that has to be kept in step by hand. It is
           * not a *restriction* on invited members — an invite still admits somebody outside the
           * org, which is what keeps `bootstrapAdmin` and outside collaborators working.
           *
           * Costs the zero-scopes property: `read:org` is requested when this is set, so GitHub's
           * consent screen changes and the exchange makes one extra API call. That is the trade for
           * not maintaining the roster twice.
           */
          readonly autoJoinGithubOrg: string | null;
          readonly ingestToken: string | null;
          /** Overridable so the browser check can drive a stub. Environment only — see loadAuth. */
          readonly authorizeUrl: string;
          readonly tokenUrl: string;
          readonly userUrl: string;
      };

export interface AppConfig {
    /**
     * The organization every figure on the page belongs to, and the key every org-owned primary
     * key leads with. One per deployment, and therefore still a constant for the life of the
     * process: accounts and memberships exist now, but a member's memberships are checked against
     * this one org rather than selecting between several.
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
    /**
     * Where the organization's checkouts live: one clone per configured repo at
     * `<workspaceRoot>/<orgId>/<name>`.
     *
     * `null` — the feature off — is the default, not a path under `$HOME`. A default would make an
     * upgrade start cloning gigabytes for an operator who changed nothing, and would turn a
     * no-network boot into a network boot; nothing on the read path needs a checkout, so there is
     * no case where having one silently is better than not having one.
     *
     * Absolute, with `~` already expanded. See `workspaceRootOf` for why it is rejected rather than
     * resolved.
     */
    readonly workspaceRoot: string | null;
    readonly auth: AuthConfig;
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
 * collision in a key is invisible: `Bellows` and `bellows` are two partitions that read as one. No
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

/**
 * `~` expands against `env.HOME` rather than `os.homedir()`, and a relative path is rejected rather
 * than resolved. Both keep `loadConfig` a pure function of its argument: `homedir()` reads the
 * environment behind the validator's back, and a relative root means two different trees on one
 * machine — `npm run dev -w server` has cwd `server/` while the container has `/app`. Resolving
 * against the config file's directory instead would give one key two meanings depending on whether
 * it arrived from the file or the environment, and `loadConfig` is not allowed to know a file
 * exists at all.
 */
function workspaceRootOf(env: NodeJS.ProcessEnv): string | null {
    const raw = env.ORG_WORKSPACE_ROOT?.trim();
    if (!raw) return null;

    let path = raw;
    if (raw === '~' || raw.startsWith('~/')) {
        const home = env.HOME?.trim();
        if (!home) {
            throw new Error(`ORG_WORKSPACE_ROOT is "${raw}" but HOME is not set, so "~" cannot be expanded`);
        }
        path = raw === '~' ? home : join(home, raw.slice(2));
    }

    if (!isAbsolute(path)) {
        throw new Error(
            `ORG_WORKSPACE_ROOT must be an absolute path (or start with "~/"), got "${raw}" — a relative one would mean a different directory when run from the repo root, from server/, and in the container`,
        );
    }
    return path;
}

/**
 * A checkout is `<root>/<orgId>/<name>`, so both halves have to survive being a bare path segment.
 * `orgId` already does — ORG_ID_PATTERN forbids dots and slashes for exactly this — but a repo name
 * has never been constrained, because until now it was only ever a string in an API path.
 *
 * Checked only when a workspace root is set: these names are legal everywhere else, and a
 * deployment that never clones should not start failing to boot over one.
 */
function checkWorkspaceNames(repos: readonly Repo[]): void {
    const seen = new Map<string, string>();
    for (const repo of repos) {
        const { name } = repo;
        // A leading "-" is read by git as an option, not a path.
        if (name === '.' || name === '..' || name.includes('/') || name.startsWith('-')) {
            throw new Error(
                `ORG_REPOS entry "${repo.owner}/${name}" cannot be checked out: with ORG_WORKSPACE_ROOT set, a repo name becomes a directory name`,
            );
        }
        const first = seen.get(name);
        if (first) {
            throw new Error(
                `ORG_REPOS lists "${first}/${name}" and "${repo.owner}/${name}", which share the checkout directory "${name}" — with ORG_WORKSPACE_ROOT set, one would overwrite the other`,
            );
        }
        seen.set(name, repo.owner);
    }
}

/**
 * Long enough that the cookie signature is not the weak link. Fatal rather than padded: a secret
 * silently stretched to length is a secret nobody chose.
 */
const MIN_SESSION_SECRET_LENGTH = 32;

const DEFAULT_SESSION_TTL_HOURS = 24 * 14;

/**
 * Addresses that are only reachable from the machine itself, which is the entire access control an
 * `AUTH_MODE=none` deployment has.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function bool(raw: string | undefined, fallback: boolean, label: string): boolean {
    const value = raw?.trim();
    if (value === undefined || value === '') return fallback;
    if (['1', 'true', 'yes'].includes(value)) return true;
    if (['0', 'false', 'no'].includes(value)) return false;
    throw new Error(`${label} must be a boolean ("1"/"true" or "0"/"false"), got "${raw}"`);
}

/**
 * Every key of `[auth]`, or the one field `none` mode has.
 *
 * Pure, like the rest of loadConfig: no I/O, and the GitHub endpoints are read from the environment
 * rather than reached.
 */
function loadAuth(env: NodeJS.ProcessEnv, host: string, port: number): AuthConfig {
    const ingestToken = env.INGEST_TOKEN?.trim() || null;
    const mode = env.AUTH_MODE?.trim() || 'none';
    if (mode !== 'none' && mode !== 'github') {
        throw new Error(`AUTH_MODE must be "github" or "none", got "${env.AUTH_MODE}"`);
    }

    if (mode === 'none') {
        /*
         * Refusing the pairing is stronger than warning about it: it makes "open to the network"
         * inexpressible rather than merely discouraged, which is more than docs/security.md
         * guaranteed when the bind address was the only protection there was.
         *
         * The hatch is required, not decorative. docker/Dockerfile sets HOST=0.0.0.0, because inside
         * a container that is normal and the isolation is compose's `127.0.0.1:8080:8080` publish —
         * something loadConfig cannot see and must not guess at. So compose sets the hatch, and a
         * human who sets it has typed the sentence once.
         */
        if (!LOOPBACK_HOSTS.has(host) && !bool(env.AUTH_ALLOW_PUBLIC_BIND, false, 'AUTH_ALLOW_PUBLIC_BIND')) {
            throw new Error(
                `AUTH_MODE is "none" but HOST is "${host}", which is reachable from off this machine. With no auth every route is open to anyone who can reach the port, including POST /api/jobs, which runs shell commands. Set AUTH_MODE=github, or bind to 127.0.0.1, or set AUTH_ALLOW_PUBLIC_BIND=1 if something else in front of this port is doing the authenticating.`,
            );
        }
        return Object.freeze({ mode, ingestToken });
    }

    // Named individually rather than as "auth is incomplete": the operator has one key to fix and
    // should not have to diff the example file to find out which.
    const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
    const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
    const sessionSecret = env.SESSION_SECRET?.trim();
    for (const [label, value] of [
        ['GITHUB_OAUTH_CLIENT_ID', clientId],
        ['GITHUB_OAUTH_CLIENT_SECRET', clientSecret],
        ['SESSION_SECRET', sessionSecret],
    ] as const) {
        if (!value) {
            throw new Error(
                `AUTH_MODE is "github" but ${label} is not set. Half-configured auth is fatal rather than falling back to an open deployment, which would be the one failure nobody notices.`,
            );
        }
    }
    if (sessionSecret!.length < MIN_SESSION_SECRET_LENGTH) {
        throw new Error(
            `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters, got ${sessionSecret!.length}`,
        );
    }

    // Defaulted only for a loopback bind, where the origin is unambiguous. A deployment reachable
    // from elsewhere has to say what its origin is, because `http://0.0.0.0:8080` is not a URL any
    // browser will ever be redirected back to and a wrong one fails at GitHub with an opaque error.
    const publicUrl = env.PUBLIC_URL?.trim() || (LOOPBACK_HOSTS.has(host) ? `http://${host}:${port}` : '');
    if (!publicUrl) {
        throw new Error(
            `AUTH_MODE is "github" and HOST is "${host}", so PUBLIC_URL must be set: it is the origin GitHub redirects back to, and it cannot be derived from the request's Host header without letting the caller choose the redirect target.`,
        );
    }
    let origin: URL;
    try {
        origin = new URL(publicUrl);
    } catch {
        throw new Error(`PUBLIC_URL must be an absolute URL, got "${publicUrl}"`);
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
        throw new Error(`PUBLIC_URL must be http or https, got "${publicUrl}"`);
    }

    const sessionTtlHours = int(env.SESSION_TTL_HOURS, DEFAULT_SESSION_TTL_HOURS, 'SESSION_TTL_HOURS');

    return Object.freeze({
        mode,
        clientId: clientId!,
        clientSecret: clientSecret!,
        sessionSecret: sessionSecret!,
        sessionTtlMs: sessionTtlHours * 3600 * 1000,
        cookieSecure: bool(env.COOKIE_SECURE, false, 'COOKIE_SECURE'),
        publicUrl: origin.origin,
        bootstrapAdmin: env.AUTH_BOOTSTRAP_ADMIN?.trim().toLowerCase() || null,
        autoJoinGithubOrg: env.AUTH_AUTO_JOIN_GITHUB_ORG?.trim() || null,
        ingestToken,
        // Environment only, and deliberately absent from config-file.ts's KEYS. A configurable
        // authorize URL in a file that ships with a deployment is a phishing vector; as an
        // environment variable it stays a test seam that index.ts logs loudly when it is used.
        authorizeUrl: env.GITHUB_OAUTH_AUTHORIZE_URL?.trim() || 'https://github.com/login/oauth/authorize',
        tokenUrl: env.GITHUB_OAUTH_TOKEN_URL?.trim() || 'https://github.com/login/oauth/access_token',
        userUrl: env.GITHUB_OAUTH_USER_URL?.trim() || 'https://api.github.com/user',
    });
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

    const owner = env.GITHUB_OWNER ?? 'Bellows-AI';

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
    // "Bellows-AI" in the selector rather than the word "default", which reads as a bug.
    // Empty is unset, because an empty name renders an invisible control.
    const orgName = env.ORG_NAME?.trim() || owner;

    const names = env.ORG_REPOS
        ? env.ORG_REPOS.split(',')
              .map((entry) => entry.trim())
              .filter(Boolean)
        : ['bellows.ai'];
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

    const workspaceRoot = workspaceRootOf(env);
    if (workspaceRoot) checkWorkspaceNames(repos);

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

    // Bound before the return because loadAuth reads both: whether a deployment is reachable from
    // off the machine is what decides if running without auth is allowed at all.
    const port = int(env.PORT, 8080, 'PORT');
    const host = env.HOST ?? '127.0.0.1';

    return Object.freeze({
        orgId,
        orgName,
        repos: Object.freeze(repos.map((repo) => Object.freeze(repo))),
        baseBranch: env.BASE_BRANCH ?? 'dev',
        bots: Object.freeze(bots),
        syncTtlMs: syncTtlSeconds * 1000,
        port,
        host,
        webRoot: env.WEB_ROOT ?? null,
        telemetrySource,
        databaseUrl,
        telemetryTtlMs: telemetryTtlSeconds * 1000,
        repoNames: Object.freeze(repos.map((repo) => `${repo.owner}/${repo.name}`)),
        workspaceRoot,
        auth: loadAuth(env, host, port),
    });
}
