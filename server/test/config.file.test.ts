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

function resolve(toml: string | null, env: NodeJS.ProcessEnv = {}) {
    if (toml !== null) write(toml);
    return resolveConfig({ env, cwd: dir, warn });
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
        const { config, source } = resolve(`
[github]
source = "github"
token = "file-token"
owner = "acme"
repos = ["widgets", "other-owner/gadgets"]
base_branch = "main"
bots = ["botty", "otherbot"]

[server]
port = 9100
host = "0.0.0.0"
web_root = "/srv/web"

[cache]
ttl_seconds = 1200

[telemetry]
source = "off"
database_url = "postgres://from-file/db"
ttl_seconds = 45
`);

        expect(source).toBe(join(dir, 'factory.toml'));
        expect(config.dataSource).toBe('github');
        // A bare name takes github.owner; a qualified entry keeps its own.
        expect(config.repos).toEqual([
            { owner: 'acme', name: 'widgets' },
            { owner: 'other-owner', name: 'gadgets' },
        ]);
        expect(config.baseBranch).toBe('main');
        expect(config.bots).toEqual(['botty', 'otherbot']);
        expect(config.port).toBe(9100);
        expect(config.host).toBe('0.0.0.0');
        expect(config.webRoot).toBe('/srv/web');
        expect(config.cacheTtlMs).toBe(1_200_000);
        expect(config.telemetrySource).toBe('off');
        expect(config.databaseUrl).toBe('postgres://from-file/db');
        expect(config.telemetryTtlMs).toBe(45_000);
        // Derived from the repo list, never separately configurable.
        expect(config.repoNames).toEqual(['acme/widgets', 'other-owner/gadgets']);
    });

    it('scales the cache TTL floor with the repo count', () => {
        // The 300s floor protects a rate-limit budget that is spent once per repo, so two repos
        // on a 300s TTL is the same exposure the floor exists to prevent.
        expect(() => resolve('[github]\nrepos = ["a", "b"]\n\n[cache]\nttl_seconds = 400\n')).toThrow(
            /at least 600 for 2 repositories/,
        );
    });

    it('gives the token provider the file token', async () => {
        const { env } = resolve('[github]\nsource = "github"\ntoken = "file-token"\n');
        await expect(envTokenProvider(env).get()).resolves.toBe('file-token');
    });

    it('lets the environment win', () => {
        const { config } = resolve('[server]\nport = 9100\n', { PORT: '7777' });
        expect(config.port).toBe(7777);
    });

    it('keeps verify:ui on fixture data despite a personal config file', () => {
        // playwright.config.ts merges its env onto process.env with cwd at the repo root, so a
        // developer's factory.toml is in scope for that run and must not change the data source.
        const { config } = resolve('[github]\nsource = "github"\ntoken = "file-token"\n', {
            DATA_SOURCE: 'fixture',
            TELEMETRY_SOURCE: 'fixture',
        });
        expect(config.dataSource).toBe('fixture');
        expect(config.telemetrySource).toBe('fixture');
    });

    it('does not treat an empty environment variable as an override', () => {
        const { config } = resolve('[server]\nhost = "0.0.0.0"\n', { HOST: '' });
        expect(config.host).toBe('0.0.0.0');
    });

    it('survives the empty GITHUB_TOKEN that compose passes', () => {
        // docker-compose.yml sends GITHUB_TOKEN='' whenever the host has no token, which would
        // otherwise clobber a mounted file on every container start.
        const { config, env } = resolve('[github]\nsource = "github"\ntoken = "file-token"\n', {
            GITHUB_TOKEN: '',
        });
        expect(config.dataSource).toBe('github');
        expect(env.GITHUB_TOKEN).toBe('file-token');
    });

    it('names the TOML key in a validation error', () => {
        expect(() => resolve('[cache]\nttl_seconds = 60\n')).toThrow(/at least 300[\s\S]*cache\.ttl_seconds/);
    });

    it('rejects a non-integer', () => {
        expect(() => resolve('[cache]\nttl_seconds = 900.5\n')).toThrow(/cache\.ttl_seconds must be an integer/);
    });

    it('rejects a quoted integer', () => {
        expect(() => resolve('[cache]\nttl_seconds = "900"\n')).toThrow(/cache\.ttl_seconds must be an integer/);
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

    it('warns about a world-readable file', () => {
        write('[github]\nowner = "acme"\n');
        chmodSync(join(dir, 'factory.toml'), 0o644);
        resolveConfig({ env: {}, cwd: dir, warn });
        expect(warnings.join('\n')).toMatch(/mode 644/);
    });

    it('does not warn about a private file', () => {
        resolve('[github]\nowner = "acme"\n');
        expect(warnings).toEqual([]);
    });
});

describe('discovery', () => {
    it('behaves exactly like the environment alone when there is no file', () => {
        const env = { TELEMETRY_TTL_SECONDS: '7' };
        const { config, source } = resolve(null, env);
        expect(source).toBeNull();
        expect(config).toEqual(loadConfig(env));
    });

    it('honours FACTORY_CONFIG', () => {
        write('[github]\nowner = "acme"\n', 'elsewhere.toml');
        const { config, source } = resolveConfig({
            env: { FACTORY_CONFIG: join(dir, 'elsewhere.toml') },
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
        const { config } = resolveConfig({ env: {}, cwd: nested, warn });
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
