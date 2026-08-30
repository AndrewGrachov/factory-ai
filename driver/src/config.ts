/**
 * The driver's configuration, read from the environment only.
 *
 * No factory.toml: the server's config file carries a GitHub App private key and describes a
 * dashboard. This process runs somewhere else — on the host, or in a container holding the docker
 * socket — and the two now have nothing in common at all: the board tells this process which
 * workspace a job belongs to, so it does not even need to know the organization.
 */
export interface DriverConfig {
    /** Where the board is. The driver is a client of it, never of the database. */
    boardUrl: string;
    /**
     * The worker token the board authenticates this process by, or '' against an open board.
     *
     * Environment only — there is no config file here, and a credential that decides whether a
     * process may run shell commands does not belong on a command line. It is also what tells the
     * board which organization this driver works for, which is why it is minted per organization by
     * `npm run worker-token` rather than shared between deployments.
     */
    boardToken: string;
    /** Names this driver on every claim, so a stuck job can be traced back to a process. */
    worker: string;
    /*
     * `orgId` used to live here, and its only job was building the runner's WORKDIR as
     * `<workspaceMount>/<orgId>`. The board sends `workspacePath` on the claim now — it owns the
     * layout, because it is what created the directory — so this process builds nothing and no
     * longer has to be told which organization it is working for. The worker token already says
     * that, and said it more reliably.
     */
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
    /**
     * The wall-clock cap on a headless run. **Not armed under Remote Control**, where idleMs is the
     * bound instead: an interactive session has no meaningful total duration — being driven for
     * three hours is the feature — and arming both would mean the shorter one always won, killing a
     * drivable job before it could ever be parked.
     */
    jobTimeoutMs: number;
    /**
     * Appends --dangerously-skip-permissions. Off by default and deliberately a separate switch: a
     * headless agent cannot answer a permission prompt, so without it most useful jobs stall until
     * the timeout — and with it the agent edits and runs whatever it likes inside the container.
     * Making that a decision someone types is the whole point.
     */
    skipPermissions: boolean;
    /**
     * Runs the job as an interactive Remote Control session instead of a headless `-p` prompt, so it
     * can be driven from claude.ai/code and the mobile app.
     *
     * This changes what a job is. An interactive session does not end when the agent stops talking,
     * so the container lives until somebody ends the session or idleMs parks it, and a drivable job
     * holds its worker slot for that whole time. Off by default for that reason.
     */
    remoteControl: boolean;
    /**
     * How long a Remote Control runner may produce nothing before it is parked. Silence is the
     * signal because it is the one the driver already has: it reads every chunk the container
     * writes, and asking the board or the telemetry store instead would make this process a client
     * of something other than the HTTP board.
     *
     * Only armed under Remote Control. A headless run is bounded by jobTimeoutMs and has nobody to
     * come back to it, so parking one would strand it.
     */
    idleMs: number;
    /**
     * The volume holding a full-scope claude.ai login, mounted over the runner's CLAUDE_CONFIG_DIR.
     * Only used in Remote Control mode, which is the only mode that cannot work without one — see
     * docker/claude-executor/run.sh, which writes it.
     */
    authVolume: string;
    /**
     * Names of environment variables forwarded to the runner. Names only: the values are passed as
     * `-e NAME`, which makes docker read them from this process's environment rather than putting a
     * credential in a command line every `ps` on the host can read.
     */
    passEnv: readonly string[];
}

const DEFAULTS = {
    boardUrl: 'http://127.0.0.1:8080',
    image: 'claude-executor',
    workspaceVolume: 'factory-ai_workspaces',
    workspaceMount: '/workspaces',
    concurrency: 2,
    pollMs: 5_000,
    leaseSeconds: 300,
    jobTimeoutMs: 30 * 60_000,
    idleMs: 60 * 60_000,
    authVolume: 'claude-executor-auth',
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
        boardToken: (env.JOB_BOARD_TOKEN ?? '').trim(),
        worker: text(env.DRIVER_WORKER, 'DRIVER_WORKER', `driver-${process.pid}`),
        image: text(env.EXECUTOR_IMAGE, 'EXECUTOR_IMAGE', DEFAULTS.image),
        workspaceVolume: text(env.WORKSPACE_VOLUME, 'WORKSPACE_VOLUME', DEFAULTS.workspaceVolume),
        workspaceMount: text(env.WORKSPACE_MOUNT, 'WORKSPACE_MOUNT', DEFAULTS.workspaceMount),
        network: (env.RUNNER_NETWORK ?? '').trim() || null,
        concurrency: int(env.DRIVER_CONCURRENCY, 'DRIVER_CONCURRENCY', DEFAULTS.concurrency, 1, 32),
        pollMs: int(env.DRIVER_POLL_MS, 'DRIVER_POLL_MS', DEFAULTS.pollMs, 250, 300_000),
        leaseSeconds,
        jobTimeoutMs,
        skipPermissions: flag(env.RUNNER_SKIP_PERMISSIONS),
        remoteControl: flag(env.RUNNER_REMOTE_CONTROL),
        idleMs: int(env.RUNNER_IDLE_MS, 'RUNNER_IDLE_MS', DEFAULTS.idleMs, 1_000, 24 * 3600_000),
        authVolume: text(env.RUNNER_AUTH_VOLUME, 'RUNNER_AUTH_VOLUME', DEFAULTS.authVolume),
        passEnv: text(env.RUNNER_ENV, 'RUNNER_ENV', DEFAULTS.passEnv)
            .split(',')
            .map((name) => name.trim())
            .filter(Boolean),
    };
}
