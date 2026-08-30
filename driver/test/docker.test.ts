import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName, dockerArgs, parseRemoteSessionId, remoteSessionArgs } from '../src/docker.js';

const USER = '44444444-4444-4444-8444-444444444444';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    resumeSessionId: null,
    userId: USER,
    workspacePath: `bellows/${USER}`,
};

const SESSION = '33333333-3333-4333-8333-333333333333';

const args = (env: NodeJS.ProcessEnv = {}) =>
    dockerArgs(loadDriverConfig(env), job, { id: SESSION, resume: false });

const resumed = (env: NodeJS.ProcessEnv = {}) =>
    dockerArgs(loadDriverConfig(env), job, { id: SESSION, resume: true });

describe('the docker run arguments', () => {
    it('runs the command as a prompt, after the image', () => {
        expect(args().slice(-5)).toEqual([
            'claude-executor',
            '--session-id',
            SESSION,
            '-p',
            'fix the failing build',
        ]);
    });

    // The link the UI shows is built from this, so it has to be the id the runner actually uses —
    // which is why it is given to the CLI rather than read back out of it.
    it('tells the runner which session id to use, in both modes', () => {
        expect(args()).toEqual(expect.arrayContaining(['--session-id', SESSION]));
        expect(args({ RUNNER_REMOTE_CONTROL: '1' })).toEqual(
            expect.arrayContaining(['--session-id', SESSION]),
        );
    });

    it('mounts the checkouts volume and starts at the AUTHOR\'s workspace root', () => {
        // Was `/workspaces/<orgId>`, built from the driver's own ORG_ID — one tree every member's
        // agent shared. The board sends the path now, because it owns the layout; this process
        // only knows where the volume is mounted.
        expect(args()).toEqual(
            expect.arrayContaining([
                '-v',
                'factory-ai_workspaces:/workspaces',
                `WORKDIR=/workspaces/bellows/${USER}`,
            ]),
        );
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        /*
         * The board is not something this process trusts with a fragment of a command line — the
         * same rule remoteSessionArgs applies to a session id, and the stakes are higher here:
         * the value becomes the agent's working directory, and `..` in it points at the parent of
         * every member's tree.
         */
        for (const path of [
            '../../etc',
            'bellows/../../etc',
            'bellows/not-a-uuid',
            `/absolute/${USER}`,
            `bellows/${USER}/extra`,
            null,
        ]) {
            expect(
                () => dockerArgs(loadDriverConfig({}), { ...job, workspacePath: path }, { id: SESSION, resume: false }),
                String(path),
            ).toThrow(/no usable workspace path/);
        }
    });

    // The same discipline the workspace reconcile applies to the git token: `-e NAME` makes docker
    // read the value from the driver's environment, where `-e NAME=value` would publish it to every
    // `ps` on the host.
    it('names credentials without ever putting their values on the command line', () => {
        const line = args({ RUNNER_ENV: 'CLAUDE_CODE_OAUTH_TOKEN' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN']));
        expect(line.some((arg) => arg.includes('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false);
    });

    it('labels the container so an orphan can be found after the driver dies', () => {
        expect(args()).toEqual(
            expect.arrayContaining(['--name', containerName(job), '--label', `factory.job=${job.id}`]),
        );
    });

    it('joins a network only when one is configured', () => {
        expect(args()).not.toContain('--network');
        expect(args({ RUNNER_NETWORK: 'factory-ai_default' })).toEqual(
            expect.arrayContaining(['--network', 'factory-ai_default']),
        );
    });

    it('skips permissions only when told to', () => {
        expect(args()).not.toContain('--dangerously-skip-permissions');
        expect(args({ RUNNER_SKIP_PERMISSIONS: '1' })).toContain('--dangerously-skip-permissions');
    });

    it('leaves nothing behind', () => {
        expect(args()).toContain('--rm');
    });
});

describe('reading the remote session id', () => {
    it('reads the bridge record out of the running container, by session id', () => {
        const line = remoteSessionArgs(job, SESSION);
        expect(line.slice(0, 4)).toEqual(['exec', containerName(job), 'sh', '-c']);
        expect(line[4]).toContain(`${SESSION}.jsonl`);
        expect(line[4]).toContain('bridge-session');
    });

    // The id arrives from the board on a resume, and a board is not something this process should
    // trust with a fragment of a shell command.
    it('refuses a session id that is not a uuid, rather than interpolating it', () => {
        expect(() => remoteSessionArgs(job, '$(touch /tmp/pwned)')).toThrow('not a uuid');
    });

    it('pulls the remote id out of the transcript line', () => {
        const line = JSON.stringify({
            type: 'bridge-session',
            sessionId: SESSION,
            bridgeSessionId: 'cse_015tb2nHhHNrBuL7ZDhn9Wx5',
        });
        expect(parseRemoteSessionId(line)).toBe('cse_015tb2nHhHNrBuL7ZDhn9Wx5');
    });

    // Every one of these is the ordinary case: the bridge has not connected, or the file is being
    // written as it is read.
    it.each([['', 'nothing yet'], ['not json', 'a partial line'], ['{"type":"mode"}', 'another record']])(
        'answers null for %p (%s)',
        (line) => {
            expect(parseRemoteSessionId(line)).toBeNull();
        },
    );
});

describe('a Remote Control runner', () => {
    const rc = (env: NodeJS.ProcessEnv = {}) => args({ RUNNER_REMOTE_CONTROL: '1', ...env });

    it('starts an interactive session with the command as its opening prompt', () => {
        expect(rc().slice(-3)).toEqual(['--remote-control', containerName(job), 'fix the failing build']);
        expect(rc()).not.toContain('-p');
    });

    /**
     * `-t` and never `-i -t`. The CLI will not start an interactive session without a tty, but the
     * driver's stdin is not a terminal, and `docker run -i` from such a process fails outright with
     * "the input device is not a TTY" — so the pairing that looks obvious is the one that breaks.
     */
    it('allocates a tty without attaching stdin to it', () => {
        expect(rc()).toContain('-t');
        expect(rc()).not.toContain('-i');
        expect(args()).not.toContain('-t');
    });

    /**
     * The two halves of resuming a parked job. `--resume` keeps the original session id rather than
     * forking it, so the link the UI shows still opens the session — and the command is NOT
     * re-delivered, because it is already in the transcript and sending it again would re-run the
     * work somebody has been driving by hand.
     */
    it('restores the session instead of starting one, without re-sending the command', () => {
        const line = resumed({ RUNNER_REMOTE_CONTROL: '1' });
        expect(line.slice(-4)).toEqual([
            '--resume',
            SESSION,
            '--remote-control',
            containerName(job),
        ]);
        expect(line).not.toContain('--session-id');
        expect(line).not.toContain('fix the failing build');
    });

    it('mounts the login volume over the config directory', () => {
        expect(rc()).toEqual(expect.arrayContaining(['-v', 'claude-executor-auth:/home/node/.claude']));
        expect(rc({ RUNNER_AUTH_VOLUME: 'other' })).toEqual(
            expect.arrayContaining(['-v', 'other:/home/node/.claude']),
        );
        expect(args().join(' ')).not.toContain('/home/node/.claude');
    });

    /**
     * The failure this prevents is silent, which is why it is pinned. Remote Control needs a
     * claude.ai subscription login; given a token instead, `--remote-control` still starts a
     * perfectly ordinary local session and the only symptom is that it never appears at
     * claude.ai/code.
     */
    it('forwards no credentials, so the volume login is the only one available', () => {
        expect(rc({ RUNNER_ENV: 'CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY' })).not.toContain(
            'CLAUDE_CODE_OAUTH_TOKEN',
        );
    });

    // An interactive session started by a driver has nobody to answer the trust dialog.
    it('accepts the trust dialog for the mount', () => {
        expect(rc()).toEqual(expect.arrayContaining(['-e', 'TRUST_WORKDIR=1']));
        expect(args()).not.toContain('TRUST_WORKDIR=1');
    });
});
