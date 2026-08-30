import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { TomlError, parse } from 'smol-toml';
import { type AppConfig, loadConfig } from './config.js';

export const CONFIG_FILENAME = 'factory.toml';

type Kind = 'string' | 'int' | 'list' | 'bool';

/**
 * TOML path -> env key. `github.source` maps to DATA_SOURCE rather than GITHUB_SOURCE so it
 * reads as a sibling of `telemetry.source`; every other mapping is mechanical.
 */
const KEYS: Record<string, { readonly env: string; readonly kind: Kind }> = {
    // First, so the "expected one of" message on an unknown section reads identity-first.
    'organization.id': { env: 'ORG_ID', kind: 'string' },
    'organization.name': { env: 'ORG_NAME', kind: 'string' },
    'organization.repos': { env: 'ORG_REPOS', kind: 'list' },
    'organization.workspace_root': { env: 'ORG_WORKSPACE_ROOT', kind: 'string' },
    'github.token': { env: 'GITHUB_TOKEN', kind: 'string' },
    'github.owner': { env: 'GITHUB_OWNER', kind: 'string' },
    'github.base_branch': { env: 'BASE_BRANCH', kind: 'string' },
    'github.bots': { env: 'BOTS', kind: 'list' },
    'server.port': { env: 'PORT', kind: 'int' },
    'server.host': { env: 'HOST', kind: 'string' },
    'server.web_root': { env: 'WEB_ROOT', kind: 'string' },
    'cache.sync_ttl_seconds': { env: 'SYNC_TTL_SECONDS', kind: 'int' },
    'telemetry.source': { env: 'TELEMETRY_SOURCE', kind: 'string' },
    'telemetry.database_url': { env: 'DATABASE_URL', kind: 'string' },
    'telemetry.ttl_seconds': { env: 'TELEMETRY_TTL_SECONDS', kind: 'int' },
    // The three GitHub OAuth endpoint overrides are deliberately absent: they are a test seam, and
    // a configurable authorize URL in a file that ships with a deployment is a phishing vector.
    // AUTH_ALLOW_PUBLIC_BIND is absent for a related reason — it is an assertion about the network
    // in front of the process, which is a property of the host rather than of the deployment.
    'auth.mode': { env: 'AUTH_MODE', kind: 'string' },
    'auth.github_client_id': { env: 'GITHUB_OAUTH_CLIENT_ID', kind: 'string' },
    'auth.github_client_secret': { env: 'GITHUB_OAUTH_CLIENT_SECRET', kind: 'string' },
    'auth.session_secret': { env: 'SESSION_SECRET', kind: 'string' },
    'auth.session_ttl_hours': { env: 'SESSION_TTL_HOURS', kind: 'int' },
    'auth.cookie_secure': { env: 'COOKIE_SECURE', kind: 'bool' },
    'auth.public_url': { env: 'PUBLIC_URL', kind: 'string' },
    'auth.bootstrap_admin': { env: 'AUTH_BOOTSTRAP_ADMIN', kind: 'string' },
    'auth.auto_join_github_org': { env: 'AUTH_AUTO_JOIN_GITHUB_ORG', kind: 'string' },
    'auth.ingest_token': { env: 'INGEST_TOKEN', kind: 'string' },
};

/** Every env key whose value is a secret, so one list decides what the mode warning covers. */
const SECRET_KEYS = ['GITHUB_TOKEN', 'GITHUB_OAUTH_CLIENT_SECRET', 'SESSION_SECRET', 'INGEST_TOKEN'];

const SECTIONS = [...new Set(Object.keys(KEYS).map((path) => path.split('.')[0]))];

/**
 * Keys that were valid in an earlier version. Fatal like any other unknown key, but the message has
 * to name the new location: "unknown key github.repos" reads as a typo in something that
 * demonstrably worked yesterday, and the reader's next move is to type it again.
 */
const MOVED: Record<string, { readonly to: string; readonly why: string }> = {
    'github.repos': {
        to: 'organization.repos',
        why: 'the organization owns the repo list now',
    },
    'cache.ttl_seconds': {
        to: 'cache.sync_ttl_seconds',
        why: 'refreshes are incremental now that history is always persisted, so the 300s-per-repo full-walk floor no longer applies',
    },
};

/**
 * Keys that are gone with nowhere to go. Same reasoning as MOVED — a key that worked yesterday
 * needs its removal explained, not reported as a typo — but these need the replacement *workflow*
 * named rather than a new key name.
 */
const REMOVED: Record<string, string> = {
    'github.source':
        'the database is the only source the dashboard reads. For data without a GitHub token, seed a disposable database: npm run seed',
};

export interface FileConfig {
    readonly path: string;
    readonly values: Readonly<Record<string, string>>;
    /** env key -> TOML path, so a validation error can name what the user actually typed. */
    readonly provenance: ReadonlyMap<string, string>;
}

export interface Discovered {
    readonly path: string;
    /** FACTORY_CONFIG was set, so a missing file is a mistake rather than the env-only mode. */
    readonly explicit: boolean;
}

export function discover(env: NodeJS.ProcessEnv, cwd: string): Discovered | null {
    const explicit = env.FACTORY_CONFIG?.trim();
    if (explicit) return { path: resolve(cwd, explicit), explicit: true };

    let dir = resolve(cwd);
    for (;;) {
        const candidate = join(dir, CONFIG_FILENAME);
        if (existsSync(candidate)) return { path: candidate, explicit: false };
        // `npm run dev -w server` runs with cwd=server/, so a repo-root file has to be reachable
        // from a subdirectory — but the walk must not escape into $HOME and pick up an unrelated
        // file. package-lock.json marks both the repo root and /app in the container.
        if (existsSync(join(dir, 'package-lock.json'))) return null;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function describe(value: unknown): string {
    if (Array.isArray(value)) return 'an array';
    if (value === null) return 'null';
    if (typeof value === 'string') return `the string "${value}"`;
    return `${typeof value} ${String(value)}`;
}

/**
 * Everything the file layer hands over is a string, because `loadConfig` is the only validator
 * and it reads an env-shaped record. Round-tripping `900` through `String()` so `int()` can
 * re-parse it is circuitous, but it is what keeps the floors and enum checks in one place.
 */
function flatten(parsed: Record<string, unknown>, path: string): FileConfig {
    const values: Record<string, string> = {};
    const provenance = new Map<string, string>();

    for (const [section, body] of Object.entries(parsed)) {
        if (!SECTIONS.includes(section)) {
            throw new Error(
                `${path}: unknown section [${section}] (expected one of ${SECTIONS.map((s) => `[${s}]`).join(', ')})`,
            );
        }
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            throw new Error(`${path}: ${section} must be a [${section}] table`);
        }

        for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
            const tomlPath = `${section}.${key}`;
            const spec = KEYS[tomlPath];
            // Fatal, unlike an unrecognised environment variable. A config file has a closed key
            // set, so a typo there is a typo — and a tolerated `tokenn` boots a dashboard whose
            // operator believes it is authenticated.
            if (!spec) {
                const removed = REMOVED[tomlPath];
                if (removed) throw new Error(`${path}: ${tomlPath} is no longer supported — ${removed}.`);
                const moved = MOVED[tomlPath];
                if (moved) {
                    throw new Error(`${path}: ${tomlPath} has moved to ${moved.to} — ${moved.why}.`);
                }
                throw new Error(`${path}: unknown key ${tomlPath}`);
            }

            if (spec.kind === 'string') {
                if (typeof value !== 'string') {
                    throw new Error(`${path}: ${tomlPath} must be a string, not ${describe(value)}`);
                }
                values[spec.env] = value;
            } else if (spec.kind === 'int') {
                // A quoted number is rejected too, so the file stays honestly typed rather than
                // drifting into env-style stringly values.
                if (typeof value !== 'number' || !Number.isInteger(value)) {
                    throw new Error(`${path}: ${tomlPath} must be an integer, not ${describe(value)}`);
                }
                values[spec.env] = String(value);
            } else if (spec.kind === 'bool') {
                // `cookie_secure = "true"` is rejected rather than accepted, for the same reason a
                // quoted integer is: the file stays honestly typed instead of drifting into
                // env-style stringly values. The env layer still takes "1"/"true", because there
                // every value is a string and there is nothing to distinguish.
                if (typeof value !== 'boolean') {
                    throw new Error(`${path}: ${tomlPath} must be true or false, not ${describe(value)}`);
                }
                values[spec.env] = value ? '1' : '0';
            } else {
                if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
                    throw new Error(`${path}: ${tomlPath} must be an array of strings, not ${describe(value)}`);
                }
                // The env form is comma-separated, so a comma inside an entry would silently
                // split into two — and a comma is unrepresentable in BOTS either way.
                if (value.some((entry: string) => entry.includes(','))) {
                    throw new Error(`${path}: ${tomlPath} entries cannot contain a comma`);
                }
                values[spec.env] = value.join(',');
            }
            provenance.set(spec.env, tomlPath);
        }
    }

    return { path, values, provenance };
}

export interface ReadOptions {
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
    readonly warn?: (message: string) => void;
}

export function readConfigFile(options: ReadOptions = {}): FileConfig | null {
    const env = options.env ?? process.env;
    const cwd = options.cwd ?? process.cwd();
    const warn = options.warn ?? ((message: string) => console.warn(message));

    const found = discover(env, cwd);
    if (!found) return null;

    let stat;
    try {
        stat = statSync(found.path);
    } catch {
        // An absent default path is the supported env-only mode; an absent FACTORY_CONFIG is a
        // request that could not be honoured.
        if (found.explicit) throw new Error(`FACTORY_CONFIG points at ${found.path}, which does not exist`);
        return null;
    }
    if (stat.isDirectory()) throw new Error(`${found.path} is a directory, not a config file`);

    const permissive = Boolean(stat.mode & 0o077);

    let text;
    try {
        text = readFileSync(found.path, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EACCES') {
            // The usual cause is a host file at mode 600 bind-mounted into the container, which
            // runs as `node`. A bare stack sends people looking at the parser instead.
            throw new Error(
                `${found.path} is not readable (mode ${(stat.mode & 0o777).toString(8)}, owner uid ${stat.uid}, running as uid ${process.getuid?.() ?? '?'})`,
            );
        }
        throw error;
    }

    let parsed;
    try {
        // A BOM makes the first table header unparseable, and the resulting error points at
        // line 1 column 1 with nothing visibly wrong there.
        parsed = parse(text.replace(/^\uFEFF/, ''));
    } catch (error) {
        if (error instanceof TomlError) throw new Error(`${found.path} is not valid TOML: ${error.message}`);
        throw error;
    }

    const config = flatten(parsed as Record<string, unknown>, found.path);

    // Warned rather than thrown: refusing to boot over a permission bit would be worse than the
    // risk it flags. Conditioned on the file actually carrying a secret, because the committed
    // e2e config declares none and is necessarily mode 644 — and a warning that fires on a file
    // with no secret in it is how people learn to ignore the ones that matter.
    //
    // Every secret, not just the PAT: a file holding only a session secret is exactly as bad, and
    // keying the warning on one name would have left it silent.
    const secrets = SECRET_KEYS.filter((key) => config.values[key]);
    if (permissive && secrets.length) {
        warn(
            `[config] ${found.path} is readable by other users (mode ${(stat.mode & 0o777).toString(8)}) and holds ${secrets.join(', ')} — chmod 600 it`,
        );
    }

    return config;
}

export function mergeSources(file: FileConfig | null, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    // Identity when there is no file, so env-only operation stays bit-for-bit what it was before
    // this module existed — including loadConfig's inconsistent treatment of ''.
    if (!file) return env;

    const merged: NodeJS.ProcessEnv = { ...env };
    for (const [key, value] of Object.entries(file.values)) {
        // '' is not an override. int() treats '' as unset while `env.HOST ?? null` treats it as
        // set, so honouring it would apply the file to one key and not the other; and
        // docker-compose passes GITHUB_TOKEN='' whenever the host has no token, which would
        // otherwise clobber a mounted file on every start.
        if (merged[key] === undefined || merged[key] === '') merged[key] = value;
    }
    return merged;
}

export interface ResolvedConfig {
    readonly config: AppConfig;
    /** The merged record, so `envTokenProvider` sees the file's token too. Never log it. */
    readonly env: NodeJS.ProcessEnv;
    readonly source: string | null;
}

/**
 * The file layer lives out here rather than inside `loadConfig` so that the validator keeps doing
 * no I/O: `loadConfig({})` has to mean the same thing on every machine, whether or not the
 * developer happens to keep a factory.toml around.
 */
export function resolveConfig(options: ReadOptions = {}): ResolvedConfig {
    const env = options.env ?? process.env;
    const file = readConfigFile({ ...options, env });
    const merged = mergeSources(file, env);

    try {
        return { config: loadConfig(merged), env: merged, source: file?.path ?? null };
    } catch (error) {
        throw file ? new Error(explain(error as Error, file)) : error;
    }
}

/**
 * `loadConfig` reports the env key it rejected, which is the wrong name when the value came from
 * a file. Rewording happens here so the validator stays unaware of the file entirely.
 */
function explain(error: Error, file: FileConfig): string {
    const named = [...file.provenance]
        .filter(([envKey]) => error.message.includes(envKey))
        .map(([, tomlPath]) => tomlPath);
    if (!named.length) return error.message;
    return `${error.message} (from ${named.join(' and ')} in ${file.path})`;
}
