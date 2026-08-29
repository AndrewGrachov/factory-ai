import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Repo } from '../src/config.js';
import { ensureWorkspace } from '../src/workspace/reconcile.js';

/**
 * Offline throughout: every clone here is `file://` from a bare repository this file creates, so
 * the suite keeps its "no network, no token, no database" contract.
 */

function hasGit(): boolean {
    try {
        execFileSync('git', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Pinned so the fixture does not depend on the runner's global git config, or on having one. */
const GIT_FIXTURE_CONFIG = [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=Test',
    '-c',
    'init.defaultBranch=main',
    '-c',
    'commit.gpgsign=false',
];

function git(cwd: string, ...args: string[]): void {
    execFileSync('git', [...GIT_FIXTURE_CONFIG, ...args], { cwd, stdio: 'ignore' });
}

/** A bare repo with one commit, cloneable over file://. */
function origin(dir: string, name: string): string {
    const work = join(dir, `${name}-work`);
    const bare = join(dir, `${name}.git`);
    mkdirSync(work, { recursive: true });
    git(work, 'init');
    writeFileSync(join(work, 'README.md'), `# ${name}\n`);
    git(work, 'add', 'README.md');
    git(work, 'commit', '-m', 'init');
    execFileSync('git', [...GIT_FIXTURE_CONFIG, 'clone', '--bare', work, bare], { stdio: 'ignore' });
    return bare;
}

const repos: Repo[] = [
    { owner: 'acme', name: 'widgets' },
    { owner: 'acme', name: 'gadgets' },
];

describe.skipIf(!hasGit())('the workspace reconcile', () => {
    let dir: string;
    let root: string;
    let cloneUrl: (repo: Repo) => string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'factory-reconcile-'));
        root = join(dir, 'workspaces');
        const origins = new Map(repos.map((repo) => [repo.name, origin(dir, repo.name)]));
        cloneUrl = (repo) => `file://${origins.get(repo.name)}`;
    });

    it('clones every configured repo to <root>/<orgId>/<name>', async () => {
        const result = await ensureWorkspace({ root, orgId: 'acme', repos, cloneUrl });

        expect(result).toEqual({ present: 0, cloned: 2, failed: 0 });
        expect(readdirSync(join(root, 'acme')).sort()).toEqual(['gadgets', 'widgets']);
        expect(existsSync(join(root, 'acme', 'widgets', '.git'))).toBe(true);
    });

    it('leaves an existing checkout untouched, including uncommitted work', async () => {
        await ensureWorkspace({ root, orgId: 'acme', repos, cloneUrl });
        const scratch = join(root, 'acme', 'widgets', 'NOTES.md');
        writeFileSync(scratch, 'in progress');

        const result = await ensureWorkspace({ root, orgId: 'acme', repos, cloneUrl });

        expect(result).toEqual({ present: 2, cloned: 0, failed: 0 });
        expect(readFileSync(scratch, 'utf8')).toBe('in progress');
    });

    it('refuses to clone over a directory that is not a checkout', async () => {
        // The root points at the wrong tree. Carrying on would scatter clones through it.
        mkdirSync(join(root, 'acme', 'widgets'), { recursive: true });

        await expect(ensureWorkspace({ root, orgId: 'acme', repos, cloneUrl })).rejects.toThrow(
            /exists and is not a git checkout/,
        );
    });

    it('reports a failed clone and leaves nothing behind for it', async () => {
        const result = await ensureWorkspace({
            root,
            orgId: 'acme',
            repos: [{ owner: 'acme', name: 'missing' }],
            cloneUrl: () => `file://${join(dir, 'nonexistent.git')}`,
        });

        // Survived rather than thrown: nothing on the read path needs a checkout, so an
        // unreachable origin must not stop the stored figures being served.
        expect(result).toEqual({ present: 0, cloned: 0, failed: 1 });
        // Neither the destination nor the staging directory outlives the failure — a partial tree
        // would be classified as "exists, not a checkout" on the next boot and fail forever.
        expect(readdirSync(join(root, 'acme'))).toEqual([]);
    });

    it('passes the token through the environment, never on the command line', async () => {
        const calls: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];

        await ensureWorkspace({
            root,
            orgId: 'acme',
            repos: [repos[0]],
            token: 'ghp_secret',
            cloneUrl,
            run: async (args, env) => {
                calls.push({ args, env });
                // The caller renames the staging directory into place, so it has to exist.
                mkdirSync(args[args.length - 1], { recursive: true });
            },
        });

        const [call] = calls;
        // argv is world-readable in /proc/<pid>/cmdline, and a token in the clone URL would also be
        // written permanently into .git/config, where `git remote get-url` leaks it.
        expect(call.args.join(' ')).not.toContain('ghp_secret');
        expect(call.args.join(' ')).toContain('credential.helper');
        expect(call.env.GIT_WORKSPACE_TOKEN).toBe('ghp_secret');
        // Otherwise an unauthenticated private clone blocks on stdin and hangs the boot.
        expect(call.env.GIT_TERMINAL_PROMPT).toBe('0');
    });

    it('does not offer a credential when there is no token, since running without one is supported', async () => {
        const seen: string[][] = [];

        await ensureWorkspace({
            root,
            orgId: 'acme',
            repos: [repos[0]],
            cloneUrl,
            run: async (args) => {
                seen.push([...args]);
                mkdirSync(args[args.length - 1], { recursive: true });
            },
        });

        expect(seen[0].join(' ')).not.toContain('x-access-token');
        expect(seen[0]).not.toContain('GIT_WORKSPACE_TOKEN');
    });
});
