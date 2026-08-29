import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Repo } from '../config.js';

/**
 * Makes the organization's checkouts match its repo list: one clone per configured repo at
 * `<root>/<orgId>/<name>`.
 *
 * Reconciles in one direction only. It never fetches an existing clone and never removes one for a
 * repo that left the list, because both would touch a working tree that may hold uncommitted work —
 * and the process that owns that work is a Claude Code session, not this one.
 */

const run = promisify(execFile);

/** The variable the credential helper below reads. Never appears on a command line. */
const TOKEN_VAR = 'GIT_WORKSPACE_TOKEN';

export interface ReconcileResult {
    readonly present: number;
    readonly cloned: number;
    readonly failed: number;
}

export type GitRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<void>;

export interface ReconcileOptions {
    readonly root: string;
    readonly orgId: string;
    readonly repos: readonly Repo[];
    /** Optional: without one, only public repos clone. A missing token is a supported state. */
    readonly token?: string | undefined;
    readonly log?: (message: string) => void;
    /** Test seam: lets the suite clone from a local bare repo over file://, with no network. */
    readonly cloneUrl?: (repo: Repo) => string;
    /** Test seam: lets the suite assert on argv and the child environment without running git. */
    readonly run?: GitRunner;
}

function httpsUrl(repo: Repo): string {
    return `https://github.com/${repo.owner}/${repo.name}.git`;
}

async function defaultRunner(args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
    await run('git', [...args], { env });
}

/**
 * The token reaches git through the environment, and only the helper *snippet* — which references
 * the variable — reaches argv. A token in the clone URL would be world-readable in
 * `/proc/<pid>/cmdline` and, worse, git writes the URL permanently into `.git/config`: every later
 * `git remote get-url origin` would print it, including the one `backfill/transcripts.ts` runs to
 * attribute sessions to a repo.
 *
 * The empty `credential.helper` first clears any helper inherited from the user's global config
 * (osxkeychain, store), which would otherwise answer first with a stale credential.
 */
function gitArgs(url: string, dest: string, authenticated: boolean): string[] {
    const args = ['-c', 'credential.helper='];
    if (authenticated) {
        args.push(
            '-c',
            `credential.helper=!f(){ test "$1" = get && echo username=x-access-token && echo "password=\${${TOKEN_VAR}}"; }; f`,
        );
    }
    // Not --depth 1: base-branch history and revert detection both read history.
    // `--` so a repo name that somehow reached here as "-x" is still a path.
    return [...args, 'clone', '--origin', 'origin', '--', url, dest];
}

export async function ensureWorkspace(options: ReconcileOptions): Promise<ReconcileResult> {
    const { root, orgId, repos, token, log = () => {}, cloneUrl = httpsUrl } = options;
    const exec = options.run ?? defaultRunner;

    const orgDir = join(root, orgId);
    log(`${orgDir}`);

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Without this a private repo with no usable credential blocks on stdin forever, and the
        // clone never returns — a hang at boot rather than a reported failure.
        GIT_TERMINAL_PROMPT: '0',
        ...(token ? { [TOKEN_VAR]: token } : {}),
    };

    let present = 0;
    let cloned = 0;
    let failed = 0;

    for (const repo of repos) {
        const dest = join(orgDir, repo.name);
        if (existsSync(join(dest, '.git'))) {
            present += 1;
            log(`present ${repo.name}`);
            continue;
        }
        // Thrown, not counted: a non-repo directory here means the root points at the wrong tree,
        // and carrying on would scatter clones through somebody's home directory.
        if (existsSync(dest)) {
            throw new Error(`${dest} exists and is not a git checkout — refusing to clone over it`);
        }

        // Cloned aside and renamed into place, so a process killed mid-clone leaves no partial tree
        // at `dest`. One that did would be classified as "exists, not a checkout" on the next boot
        // and would then fail forever.
        const staging = `${dest}.tmp-${process.pid}`;
        rmSync(staging, { recursive: true, force: true });
        mkdirSync(orgDir, { recursive: true });

        log(`cloning ${repo.owner}/${repo.name}`);
        const started = Date.now();
        try {
            await exec(gitArgs(cloneUrl(repo), staging, Boolean(token)), env);
            renameSync(staging, dest);
            cloned += 1;
            log(`cloned ${repo.name} in ${Date.now() - started}ms`);
        } catch (error) {
            rmSync(staging, { recursive: true, force: true });
            failed += 1;
            // Reported and survived, like a failed prime: nothing on the read path needs a
            // checkout, so an unreachable GitHub must not stop the stored figures being served.
            log(`failed ${repo.name}: ${(error as Error).message.split('\n')[0]}`);
        }
    }

    log(`${present} present, ${cloned} cloned, ${failed} failed`);
    return { present, cloned, failed };
}
