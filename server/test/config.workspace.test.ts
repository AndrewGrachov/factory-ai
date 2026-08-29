import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { resolveConfig } from '../src/config-file.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DB = 'postgres://factory:factory@127.0.0.1:5432/factory_dev';
const env = (extra: NodeJS.ProcessEnv = {}) => ({ DATABASE_URL: DB, ...extra });

describe('the workspace root', () => {
    it('is null unless one is configured', () => {
        // Off by default rather than defaulting to a path under $HOME: a default would make an
        // upgrade start cloning gigabytes for an operator who changed nothing, and would turn a
        // no-network boot into a network boot.
        expect(loadConfig(env()).workspaceRoot).toBeNull();
    });

    it('treats an empty value as unset, consistent with every other empty value', () => {
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '' })).workspaceRoot).toBeNull();
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '   ' })).workspaceRoot).toBeNull();
    });

    it('expands ~ against the environment it was handed, not the real home directory', () => {
        // loadConfig has to stay a pure function of its argument; os.homedir() would read the
        // environment behind the validator's back and the case would pass on one machine only.
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '~/work', HOME: '/home/ada' })).workspaceRoot).toBe(
            '/home/ada/work',
        );
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '~', HOME: '/home/ada' })).workspaceRoot).toBe('/home/ada');
    });

    it('refuses ~ when there is no HOME to expand it against', () => {
        expect(() => loadConfig(env({ ORG_WORKSPACE_ROOT: '~/work' }))).toThrow(/HOME is not set/);
    });

    it('rejects a relative path rather than resolving it', () => {
        // `npm run dev -w server` has cwd server/ and the container has /app, so one relative root
        // would mean two different trees on a single machine.
        for (const path of ['work', './work', '../work']) {
            expect(() => loadConfig(env({ ORG_WORKSPACE_ROOT: path })), path).toThrow(/must be an absolute path/);
        }
    });

    it('keeps an absolute path as given', () => {
        expect(loadConfig(env({ ORG_WORKSPACE_ROOT: '/srv/factory' })).workspaceRoot).toBe('/srv/factory');
    });

    it('refuses two repos that would share one checkout directory', () => {
        // The checkout is <root>/<orgId>/<name>, so two owners' same-named repos are one directory.
        const vars = { ORG_REPOS: 'acme/widgets,other/widgets' };
        expect(() => loadConfig(env({ ...vars, ORG_WORKSPACE_ROOT: '/srv/factory' }))).toThrow(
            /share the checkout directory "widgets"/,
        );
        // Legal without a workspace: the two are distinct everywhere else, and a deployment that
        // never clones should not start failing to boot over it.
        expect(() => loadConfig(env(vars))).not.toThrow();
    });

    it('refuses a repo name that is not usable as a directory name', () => {
        for (const name of ['-x', '.', '..']) {
            expect(
                () => loadConfig(env({ ORG_REPOS: `acme/${name}`, ORG_WORKSPACE_ROOT: '/srv/factory' })),
                name,
            ).toThrow(/cannot be checked out/);
        }
    });

    it('names the TOML key, not the environment variable, when the file is at fault', () => {
        const dir = mkdtempSync(join(tmpdir(), 'factory-workspace-'));
        writeFileSync(join(dir, 'factory.toml'), '[organization]\nworkspace_root = "work"\n');
        // loadConfig only knows env keys, so an unrewritten message would send the reader looking
        // for a variable they never set.
        expect(() => resolveConfig({ env: { DATABASE_URL: DB }, cwd: dir })).toThrow(
            /from organization\.workspace_root in/,
        );
    });
});
