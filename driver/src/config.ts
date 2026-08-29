/**
 * The driver's configuration, read from the environment only.
 *
 * No factory.toml: the server's config file carries a GitHub token and describes a dashboard. This
 * process runs somewhere else — on the host, or in a container holding the docker socket — and the
 * two have almost nothing in common but ORG_ID.
 */
export interface DriverConfig {
    /** Where the board is. The driver is a client of it, never of the database. */
    boardUrl: string;
    /** Names this driver on every claim, so a stuck job can be traced back to a process. */
    worker: string;
    /** Only used to build the runner's WORKDIR, `<workspaceMount>/<orgId>`. */
    orgId: string;
    image: string;
    /**
     * The docker volume holding the checkouts — a NAME, not a host path. The dashboard writes them
     * into a named volume precisely so no host directory is involved, and a runner spawned from
     * inside a container could not resolve a host path anyway.
     */
    workspaceVolume: string;
    /** Where that volume is mounted inside the runner. */
    workspaceMount: string;
    /** Joins the runner to a docker network, which is what lets its telemetry reach the collector. */
    network: string | null;
    concurrency: number;
    pollMs: number;
    leaseSeconds: number;
    jobTimeoutMs: number;
    /**
     * Appends --dangerously-skip-permissions. Off by default and deliberately a separate switch: a
     * headless agent cannot answer a permission prompt, so without it most useful jobs stall until
     * the timeout — and with it the agent edits and runs whatever it likes inside the container.
     * Making that a decision someone types is the whole point.
     */
    skipPermissions: boolean;
    /**
     * Names of environment variables forwarded to the runner. Names only: the values are passed as
     * `-e NAME`, which makes docker read them from this process's environment rather than putting a
     * credential in a command line every `ps` on the host can read.
     */
    passEnv: readonly string[];
}

const DEFAULTS = {
    boardUrl: 'http://127.0.0.1:8080',
    orgId: 'default',
    image: 'claude-executor',
    workspaceVolume: 'factory-ai_workspaces',
    workspaceMount: '/workspaces',
    concurrency: 2,
    pollMs: 5_000,
    leaseSeconds: 300,
    jobTimeoutMs: 30 * 60_000,
    passEnv: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY',
} as const;

function int(raw: string | undefined, label: string, fallback: number, min: number, max: number): number {
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${label} must be an integer ${min}..${max}, got "${raw}"`);
    }
    return value;
}

function flag(raw: string | undefined): boolean {
    return raw !== undefined && raw !== '' && raw !== '0' && raw.toLowerCase() !== 'false';
}

function text(raw: string | undefined, label: string, fallback: string): string {
    const value = (raw ?? '').trim() || fallback;
    if (!value) throw new Error(`${label} must not be empty`);
    return value;
}

export function loadDriverConfig(env: NodeJS.ProcessEnv): DriverConfig {
    const boardUrl = text(env.JOB_BOARD_URL, 'JOB_BOARD_URL', DEFAULTS.boardUrl).replace(/\/+$/, '');
    // The protocol is checked, not just the parse: `new URL('dashboard:8080')` succeeds with
    // 'dashboard:' as the scheme, and the first symptom would be every claim failing against a
    // value that reads perfectly well.
    const scheme = (() => {
        try {
            return new URL(boardUrl).protocol;
        } catch {
            return null;
        }
    })();
    if (scheme !== 'http:' && scheme !== 'https:') {
        throw new Error(`JOB_BOARD_URL must be an http(s) URL, got "${boardUrl}"`);
    }

    const leaseSeconds = int(env.DRIVER_LEASE_SECONDS, 'DRIVER_LEASE_SECONDS', DEFAULTS.leaseSeconds, 10, 3600);
    const jobTimeoutMs = int(
        env.DRIVER_JOB_TIMEOUT_MS,
        'DRIVER_JOB_TIMEOUT_MS',
        DEFAULTS.jobTimeoutMs,
        1_000,
        24 * 3600_000,
    );

    return {
        boardUrl,
        worker: text(env.DRIVER_WORKER, 'DRIVER_WORKER', `driver-${process.pid}`),
        orgId: text(env.ORG_ID, 'ORG_ID', DEFAULTS.orgId),
        image: text(env.EXECUTOR_IMAGE, 'EXECUTOR_IMAGE', DEFAULTS.image),
        workspaceVolume: text(env.WORKSPACE_VOLUME, 'WORKSPACE_VOLUME', DEFAULTS.workspaceVolume),
        workspaceMount: text(env.WORKSPACE_MOUNT, 'WORKSPACE_MOUNT', DEFAULTS.workspaceMount),
        network: (env.RUNNER_NETWORK ?? '').trim() || null,
        concurrency: int(env.DRIVER_CONCURRENCY, 'DRIVER_CONCURRENCY', DEFAULTS.concurrency, 1, 32),
        pollMs: int(env.DRIVER_POLL_MS, 'DRIVER_POLL_MS', DEFAULTS.pollMs, 250, 300_000),
        leaseSeconds,
        jobTimeoutMs,
        skipPermissions: flag(env.RUNNER_SKIP_PERMISSIONS),
        passEnv: text(env.RUNNER_ENV, 'RUNNER_ENV', DEFAULTS.passEnv)
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
    };
}
