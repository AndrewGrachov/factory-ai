import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, resolveConfig } from '../src/config-file.js';
import { loadConfig } from '../src/config.js';
import { envTokenProvider } from '../src/github/token.js';

// Every case drives the reader through an injected cwd and a plain-object env. Mutating
// process.env or chdir-ing would leak across the suite, and reading the real process.env would
// make the result depend on whoever ran it.
let dir: string;
const warnings: string[] = [];
const warn = (message: string) => warnings.push(message);

function write(contents: string, name = 'factory.toml'): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    // mkdtemp inherits the umask, so a fresh file is usually 0644 and would warn in cases that
    // are not about the permission check.
    chmodSync(path, 0o600);
    return path;
}

/**
 * DATABASE_URL is required now, and none of these cases is about it — so it is supplied as a
 * baseline rather than repeated in twenty env literals. A case that IS about it overrides it.
 */
const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';

function resolve(toml: string | null, env: NodeJS.ProcessEnv = {}) {
    if (toml !== null) write(toml);
    return resolveConfig({ env: { DATABASE_URL: DB, ...env }, cwd: dir, warn });
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'factory-cfg-'));
    // Stops the upward walk from leaving the temp directory and finding a real factory.toml
    // somewhere above /var/folders.
    writeFileSync(join(dir, 'package-lock.json'), '{}');
    warnings.length = 0;
});

afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
});

describe('config file', () => {
    it('loads every section', () => {
        // No baseline DATABASE_URL: this case asserts the file's own telemetry.database_url is
        // what lands, and an env value would win over it.
        const { config, source } = resolve(`
[organization]
id = "acme-org"
name = "Acme Org"
repos = ["widgets", "other-owner/gadgets"]

[github]
token = "file-token"
owner = "acme"
base_branch = "main"
bots = ["botty", "otherbot"]

[server]
port = 9100
host = "0.0.0.0"
web_root = "/srv/web"

[cache]
sync_ttl_seconds = 1200

[telemetry]
source = "off"
database_url = "postgres://from-file/db"
ttl_seconds = 45
`, { DATABASE_URL: undefined });

        expect(source).toBe(join(dir, 'factory.toml'));
        expect(config.orgId).toBe('acme-org');
        expect(config.orgName).toBe('Acme Org');
        // A bare name takes github.owner; a qualified entry keeps its own. The organization owns
        // the list, but the owner it falls back to is still a GitHub setting — a Factory
        // organization is not a GitHub organization.
        expect(config.repos).toEqual([
            { owner: 'acme', name: 'widgets' },
            { owner: 'other-owner', name: 'gadgets' },
        ]);
        expect(config.baseBranch).toBe('main');
        expect(config.bots).toEqual(['botty', 'otherbot']);
        expect(config.port).toBe(9100);
        expect(config.host).toBe('0.0.0.0');
        expect(config.webRoot).toBe('/srv/web');
        expect(config.syncTtlMs).toBe(1_200_000);
        expect(config.telemetrySource).toBe('off');
        expect(config.databaseUrl).toBe('postgres://from-file/db');
        expect(config.telemetryTtlMs).toBe(45_000);
        // Derived from the repo list, never separately configurable.
        expect(config.repoNames).toEqual(['acme/widgets', 'other-owner/gadgets']);
    });

    it('scales the sync TTL floor with the repo count', () => {
        // Even an incremental sync costs a few rate-limit points per repo, so the floor has to
        // scale with the list or it weakens exactly as repos are added.
        expect(() =>
            resolve('[organization]\nrepos = ["a", "b"]\n\n[cache]\nsync_ttl_seconds = 90\n'),
        ).toThrow(/at least 120 for 2 repositories/);
    });

    it('names the new home of a moved key rather than calling it unknown', () => {
        // "unknown key github.repos" reads as a typo in something that demonstrably worked
        // yesterday, and the reader's next move is to type it again.
        expect(() => resolve('[github]\nrepos = ["a"]\n')).toThrow(
            /github\.repos has moved to organization\.repos/,
        );
    });

    it('accepts an [organization] table and defaults the id', () => {
        const { config } = resolve('[organization]\nname = "Leeloo AI"\n');
        expect(config.orgId).toBe('default');
        expect(config.orgName).toBe('Leeloo AI');
    });

    it('names the TOML key when the organization id is illegal', () => {
        // Pins explain()'s provenance rewriting for the new keys — the only non-mechanical part of
        // the file layer's half of this change.
        expect(() => resolve('[organization]\nid = "Leeloo AI"\n')).toThrow(
            /ORG_ID must be[\s\S]*organization\.id/,
        );
    });

    it('gives the token provider the file token', async () => {
        const { env } = resolve('[github]\ntoken = "file-token"\n');
        await expect(envTokenProvider(env).get()).resolves.toBe('file-token');
    });

    it('lets the environment win', () => {
        const { config } = resolve('[server]\nport = 9100\n', { PORT: '7777' });
        expect(config.port).toBe(7777);
    });

    it('refuses a removed file key rather than ignoring it', () => {
        // github.source used to choose between the live API and a replayed payload. A tolerated
        // leftover would boot a dashboard whose operator believes it is showing something else.
        expect(() => resolve('[github]\nsource = "fixture"\n')).toThrow(
            /github\.source is no longer supported[\s\S]*npm run seed/,
        );
    });

    it('refuses a removed environment variable rather than ignoring it', () => {
        expect(() => resolve(null, { DATA_SOURCE: 'fixture' })).toThrow(/DATA_SOURCE is no longer supported/);
    });

    it('refuses CACHE_TTL_SECONDS rather than silently dropping to the sync floor', () => {
        expect(() => resolve(null, { CACHE_TTL_SECONDS: '900' })).toThrow(
            /CACHE_TTL_SECONDS is no longer supported/,
        );
    });

    it('does not treat an empty environment variable as an override', () => {
        const { config } = resolve('[server]\nhost = "0.0.0.0"\n', { HOST: '' });
        expect(config.host).toBe('0.0.0.0');
    });

    it('survives the empty GITHUB_TOKEN that compose passes', () => {
        // docker-compose.yml sends GITHUB_TOKEN='' whenever the host has no token, which would
        // otherwise clobber a mounted file on every container start.
        const { env } = resolve('[github]\ntoken = "file-token"\n', { GITHUB_TOKEN: '' });
        expect(env.GITHUB_TOKEN).toBe('file-token');
    });

    it('names the TOML key in a validation error', () => {
        expect(() => resolve('[cache]\nsync_ttl_seconds = 30\n')).toThrow(
            /at least 60[\s\S]*cache\.sync_ttl_seconds/,
        );
    });

    it('rejects a non-integer', () => {
        expect(() => resolve('[cache]\nsync_ttl_seconds = 900.5\n')).toThrow(/cache\.sync_ttl_seconds must be an integer/);
    });

    it('rejects a quoted integer', () => {
        expect(() => resolve('[cache]\nsync_ttl_seconds = "900"\n')).toThrow(/cache\.sync_ttl_seconds must be an integer/);
    });

    it('rejects a non-string', () => {
        expect(() => resolve('[github]\nowner = 42\n')).toThrow(/github\.owner must be a string/);
    });

    it('rejects a bot name containing a comma', () => {
        expect(() => resolve('[github]\nbots = ["a,b"]\n')).toThrow(/cannot contain a comma/);
    });

    it('rejects an unknown key', () => {
        expect(() => resolve('[github]\ntokenn = "oops"\n')).toThrow(/unknown key github\.tokenn/);
    });

    it('rejects an unknown section', () => {
        expect(() => resolve('[gitub]\ntoken = "oops"\n')).toThrow(/unknown section \[gitub\]/);
    });

    it('rejects malformed TOML', () => {
        expect(() => resolve('[github\ntoken = "oops"\n')).toThrow(/is not valid TOML/);
    });

    it('ignores a byte order mark', () => {
        const { config } = resolve('\uFEFF[github]\nowner = "acme"\n');
        expect(config.repos[0]?.owner).toBe('acme');
    });

    it('warns about a world-readable file that holds a token', () => {
        write('[github]\ntoken = "secret"\n');
        chmodSync(join(dir, 'factory.toml'), 0o644);
        resolveConfig({ env: { DATABASE_URL: DB }, cwd: dir, warn });
        expect(warnings.join('\n')).toMatch(/mode 644/);
    });

    it('does not warn about a world-readable file with no token in it', () => {
        // The committed e2e config declares no token and is necessarily mode 644. A warning that
        // fires on a file with no secret is how people learn to ignore the ones that matter.
        write('[github]\nowner = "acme"\n');
        chmodSync(join(dir, 'factory.toml'), 0o644);
        resolveConfig({ env: { DATABASE_URL: DB }, cwd: dir, warn });
        expect(warnings).toEqual([]);
    });

    it('does not warn about a private file', () => {
        resolve('[github]\nowner = "acme"\n');
        expect(warnings).toEqual([]);
    });
});

describe('discovery', () => {
    it('behaves exactly like the environment alone when there is no file', () => {
        const env = { TELEMETRY_TTL_SECONDS: '7', DATABASE_URL: DB };
        const { config, source } = resolveConfig({ env, cwd: dir, warn });
        expect(source).toBeNull();
        expect(config).toEqual(loadConfig(env));
    });

    it('honours FACTORY_CONFIG', () => {
        write('[github]\nowner = "acme"\n', 'elsewhere.toml');
        const { config, source } = resolveConfig({
            env: { FACTORY_CONFIG: join(dir, 'elsewhere.toml'), DATABASE_URL: DB },
            cwd: dir,
            warn,
        });
        expect(source).toBe(join(dir, 'elsewhere.toml'));
        expect(config.repos[0]?.owner).toBe('acme');
    });

    it('fails when FACTORY_CONFIG points at nothing', () => {
        expect(() =>
            resolveConfig({ env: { FACTORY_CONFIG: join(dir, 'missing.toml') }, cwd: dir, warn }),
        ).toThrow(/does not exist/);
    });

    it('rejects a directory', () => {
        mkdirSync(join(dir, 'factory.toml'));
        expect(() => resolveConfig({ env: {}, cwd: dir, warn })).toThrow(/is a directory/);
    });

    it('finds a root file from a nested cwd', () => {
        // `npm run dev -w server` runs with cwd=server/, so this is the everyday case, not an edge.
        write('[github]\nowner = "acme"\n');
        const nested = join(dir, 'server', 'deep');
        mkdirSync(nested, { recursive: true });
        const { config } = resolveConfig({ env: { DATABASE_URL: DB }, cwd: nested, warn });
        expect(config.repos[0]?.owner).toBe('acme');
    });

    it('stops the walk at a package-lock.json', () => {
        write('[github]\nowner = "acme"\n');
        const inner = join(dir, 'inner');
        mkdirSync(join(inner, 'deep'), { recursive: true });
        writeFileSync(join(inner, 'package-lock.json'), '{}');
        expect(discover({}, join(inner, 'deep'))).toBeNull();
    });
});
