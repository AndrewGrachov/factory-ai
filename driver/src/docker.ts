import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { BoardJob } from './board.js';
import type { DriverConfig } from './config.js';

const run = promisify(execFile);

/** What the board is told afterwards. `timedOut` is reported as a failure, with a reason. */
export interface RunOutcome {
    exitCode: number | null;
    output: string;
    timedOut: boolean;
}

export interface Runner {
    run(job: BoardJob): Promise<RunOutcome>;
    /** Stops a container mid-run. Used when the lease is lost, and on shutdown. */
    kill(job: BoardJob): Promise<void>;
}

/** The board truncates too; this is about not holding an unbounded string in memory first. */
const OUTPUT_LIMIT = 64 * 1024;

export const containerName = (job: BoardJob): string => `factory-job-${job.id}`;

/**
 * The full `docker run` argument list. Pure, and exported, because it is the part worth pinning in
 * a test: everything security-relevant about a runner is decided here.
 */
export function dockerArgs(config: DriverConfig, job: BoardJob): string[] {
    const args = [
        'run',
        '--rm',
        '--name',
        containerName(job),
        // Lets `docker ps --filter label=factory.job` find a runner that outlived its driver.
        '--label',
        `factory.job=${job.id}`,
        '-e',
        // The org's checkouts sit one directory down. A command-only job names no repo, so the
        // agent starts at the org root and can see all of them.
        `WORKDIR=${config.workspaceMount}/${config.orgId}`,
        '-v',
        `${config.workspaceVolume}:${config.workspaceMount}`,
    ];

    // `-e NAME` without a value: docker reads it from THIS process's environment. `-e NAME=value`
    // would put the credential in an argv every `ps` on the host can read — the same distinction
    // the workspace reconcile makes for the git token.
    for (const name of config.passEnv) args.push('-e', name);

    if (config.network) args.push('--network', config.network);

    args.push(config.image, '-p', job.command);
    if (config.skipPermissions) args.push('--dangerously-skip-permissions');
    return args;
}

type Spawn = typeof spawn;

export function createDockerRunner(config: DriverConfig, spawnFn: Spawn = spawn): Runner {
    const kill = async (job: BoardJob): Promise<void> => {
        // Killing the `docker run` process would only detach the CLI; the container keeps running
        // and the workspace keeps being written to. The daemon has to be told.
        await run('docker', ['kill', containerName(job)]).catch(() => undefined);
    };

    return {
        kill,

        run(job) {
            return new Promise<RunOutcome>((resolve, reject) => {
                const child = spawnFn('docker', dockerArgs(config, job), { stdio: ['ignore', 'pipe', 'pipe'] });

                let output = '';
                const collect = (chunk: Buffer | string) => {
                    output += String(chunk);
                    // Keep the tail: a run that fails says why at the end, and the head is banner.
                    if (output.length > OUTPUT_LIMIT) output = output.slice(-OUTPUT_LIMIT);
                };
                child.stdout?.on('data', collect);
                child.stderr?.on('data', collect);

                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    void kill(job);
                }, config.jobTimeoutMs);

                child.on('error', (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.on('close', (code) => {
                    clearTimeout(timer);
                    resolve({ exitCode: code, output, timedOut });
                });
            });
        },
    };
}
