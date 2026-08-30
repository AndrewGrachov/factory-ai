import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discover, resolveConfig } from '../src/config-file.js';
import { loadConfig } from '../src/config.js';

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

/**
 * Same reasoning, for the same reason: two cases here set `host = "0.0.0.0"` to exercise the file
 * layer, and AUTH_MODE defaults to `none`, which refuses a bind reachable from off the machine. The
 * hatch is how that combination is expressed, so it is a baseline rather than a surprise in the two
 * cases that are about something else entirely. A case that IS about the refusal overrides it.
 */
const ALLOW_PUBLIC = '1';

/**
 * Same again. GITHUB_MODE defaults to `app`, which is fatal without an App id and a private key, so
 * every case that is not about the repo-read credential says it is not using one.
 */
const NONE = 'none';

function resolve(toml: string | null, env: NodeJS.ProcessEnv = {}) {
    if (toml !== null) write(toml);
    return resolveConfig({
        env: { DATABASE_URL: DB, AUTH_ALLOW_PUBLIC_BIND: ALLOW_PUBLIC, GITHUB_MODE: NONE, ...env },
        cwd: dir,
        warn,
    });
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

[github]
mode = "app"
app_id = "12345"
installation_id = "6789"
private_key = "-----BEGIN RSA PRIVATE KEY-----\\nshape-checked-only\\n-----END RSA PRIVATE KEY-----"
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
`, { DATABASE_URL: undefined, GITHUB_MODE: undefined });

        expect(source).toBe(join(dir, 'factory.toml'));
        expect(config.orgId).toBe('acme-org');
        expect(config.orgName).toBe('Acme Org');
        // No repo list. It is whatever the installation named here reports.
        expect(config.github).toMatchObject({ mode: 'app', appId: '12345', installationId: '6789' });
        expect(config.baseBranch).toBe('main');
        expect(config.bots).toEqual(['botty', 'otherbot']);
        expect(config.port).toBe(9100);
        expect(config.host).toBe('0.0.0.0');
        expect(config.webRoot).toBe('/srv/web');
        expect(config.syncTtlMs).toBe(1_200_000);
        expect(config.telemetrySource).toBe('off');
        expect(config.databaseUrl).toBe('postgres://from-file/db');
        expect(config.telemetryTtlMs).toBe(45_000);
    });

    it('names what replaced a removed key rather than calling it unknown', () => {
        // "unknown key github.repos" reads as a typo in something that demonstrably worked
        // yesterday, and the reader's next move is to type it again. github.repos moved to
        // organization.repos once; both are gone, so pointing at the other would be a dead end.
        expect(() => resolve('[github]\nrepos = ["a"]\n')).toThrow(
            /github\.repos is no longer supported[\s\S]*App installation reports/,
        );
        expect(() => resolve('[organization]\nrepos = ["a"]\n')).toThrow(
            /organization\.repos is no longer supported/,
        );
        expect(() => resolve('[github]\ntoken = "t"\n')).toThrow(
            /github\.token is no longer supported[\s\S]*github\.private_key/,
        );
        expect(() => resolve('[github]\nowner = "acme"\n')).toThrow(/github\.owner is no longer supported/);
    });

    it('accepts an [organization] table and defaults the id', () => {
        const { config } = resolve('[organization]\nname = "Bellows AI"\n');
        expect(config.orgId).toBe('default');
        expect(config.orgName).toBe('Bellows AI');
    });

    it('names the TOML key when the organization id is illegal', () => {
        // Pins explain()'s provenance rewriting for the new keys — the only non-mechanical part of
        // the file layer's half of this change.
        expect(() => resolve('[organization]\nid = "Bellows AI"\n')).toThrow(
            /ORG_ID must be[\s\S]*organization\.id/,
        );
    });

    it('reads github.private_key_file, because loadConfig may not touch the filesystem', () => {
        // The whole describe('loadConfig') suite depends on the validator being a pure function of
        // its argument, and a private key normally arrives as a path. So the read happens HERE, in
        // the one module that already does every byte of I/O, before the validator ever sees it.
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nfrom-a-file\n-----END RSA PRIVATE KEY-----';
        writeFileSync(join(dir, 'app.pem'), `${pem}\n`);
        const { config } = resolve(
            `[github]\nmode = "app"\napp_id = "1"\nprivate_key_file = "${join(dir, 'app.pem')}"\n`,
            { GITHUB_MODE: undefined },
        );
        expect(config.github).toMatchObject({ mode: 'app', privateKeyPem: pem });
    });

    it('says which file it could not read, rather than reporting a missing key', () => {
        expect(() =>
            resolve('[github]\nmode = "app"\napp_id = "1"\nprivate_key_file = "/nope/app.pem"\n', {
                GITHUB_MODE: undefined,
            }),
        ).toThrow(/GITHUB_APP_PRIVATE_KEY_FILE points at \/nope\/app\.pem/);
    });

    it('lets an inline key win over a stale private_key_file line', () => {
        // Env-first is the contract everywhere else here, and this is the same rule one level down:
        // a path left in a mounted factory.toml must not override a key an operator just exported.
        writeFileSync(join(dir, 'app.pem'), 'from-the-file');
        const { config } = resolve(`[github]\nprivate_key_file = "${join(dir, 'app.pem')}"\n`, {
            GITHUB_MODE: 'app',
            GITHUB_APP_ID: '1',
            GITHUB_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\ninline\n-----END RSA PRIVATE KEY-----',
        });
        expect(config.github).toMatchObject({ privateKeyPem: expect.stringContaining('inline') });
    });

    it('accepts a base64 private key, because a PEM is multi-line and .env files are not', () => {
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nb64\n-----END RSA PRIVATE KEY-----';
        const { config } = resolve(null, {
            GITHUB_MODE: 'app',
            GITHUB_APP_ID: '1',
            GITHUB_APP_PRIVATE_KEY: Buffer.from(pem).toString('base64'),
        });
        expect(config.github).toMatchObject({ privateKeyPem: pem });
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

    it('survives the empty secrets that compose passes', () => {
        // docker-compose.yml sends GITHUB_APP_PRIVATE_KEY='' whenever the host has not set one,
        // which would otherwise clobber a mounted file on every container start.
        const pem = '-----BEGIN RSA PRIVATE KEY-----\nfrom-the-file\n-----END RSA PRIVATE KEY-----';
        const { config } = resolve(
            `[github]\nmode = "app"\napp_id = "1"\nprivate_key = "${pem.replace(/\n/g, '\\n')}"\n`,
            { GITHUB_MODE: undefined, GITHUB_APP_PRIVATE_KEY: '' },
        );
        expect(config.github).toMatchObject({ privateKeyPem: pem });
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
        expect(() => resolve('[github]\napp_id = 42\n')).toThrow(/github\.app_id must be a string/);
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
        const { config } = resolve('\uFEFF[organization]\nid = "acme"\n');
        expect(config.orgId).toBe('acme');
    });

    it('warns about a world-readable file that holds the App private key', () => {
        // The worst secret in this file. A PAT carries the scopes it was issued with and can be
        // revoked; this mints installation tokens indefinitely and rotating it means generating a
        // new key in GitHub's UI.
        write('[github]\nprivate_key = "-----BEGIN RSA PRIVATE KEY-----\\nx\\n-----END RSA PRIVATE KEY-----"\n');
        chmodSync(join(dir, 'factory.toml'), 0o644);
        resolveConfig({ env: { DATABASE_URL: DB, GITHUB_MODE: NONE }, cwd: dir, warn });
        expect(warnings.join('\n')).toMatch(/mode 644/);
        expect(warnings.join('\n')).toMatch(/GITHUB_APP_PRIVATE_KEY/);
    });

    it('does not warn about a world-readable file with no secret in it', () => {
        // The committed e2e config declares no secret and is necessarily mode 644. A warning that
        // fires on a file with no secret is how people learn to ignore the ones that matter.
        write('[organization]\nid = "acme"\n');
        chmodSync(join(dir, 'factory.toml'), 0o644);
        resolveConfig({ env: { DATABASE_URL: DB, GITHUB_MODE: NONE }, cwd: dir, warn });
        expect(warnings).toEqual([]);
    });

    it('does not warn about a private file', () => {
        resolve('[organization]\nid = "acme"\n');
        expect(warnings).toEqual([]);
    });
});

describe('discovery', () => {
    it('behaves exactly like the environment alone when there is no file', () => {
        const env = { TELEMETRY_TTL_SECONDS: '7', DATABASE_URL: DB, GITHUB_MODE: NONE };
        const { config, source } = resolveConfig({ env, cwd: dir, warn });
        expect(source).toBeNull();
        expect(config).toEqual(loadConfig(env));
    });

    it('honours FACTORY_CONFIG', () => {
        write('[organization]\nid = "acme"\n', 'elsewhere.toml');
        const { config, source } = resolveConfig({
            env: { FACTORY_CONFIG: join(dir, 'elsewhere.toml'), DATABASE_URL: DB, GITHUB_MODE: NONE },
            cwd: dir,
            warn,
        });
        expect(source).toBe(join(dir, 'elsewhere.toml'));
        expect(config.orgId).toBe('acme');
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
        write('[organization]\nid = "acme"\n');
        const nested = join(dir, 'server', 'deep');
        mkdirSync(nested, { recursive: true });
        const { config } = resolveConfig({ env: { DATABASE_URL: DB, GITHUB_MODE: NONE }, cwd: nested, warn });
        expect(config.orgId).toBe('acme');
    });

    it('stops the walk at a package-lock.json', () => {
        write('[organization]\nid = "acme"\n');
        const inner = join(dir, 'inner');
        mkdirSync(join(inner, 'deep'), { recursive: true });
        writeFileSync(join(inner, 'package-lock.json'), '{}');
        expect(discover({}, join(inner, 'deep'))).toBeNull();
    });
});
