import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { containerName, dockerArgs } from '../src/docker.js';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
};

const args = (env: NodeJS.ProcessEnv = {}) => dockerArgs(loadDriverConfig(env), job);

describe('the docker run arguments', () => {
    it('runs the command as a prompt, after the image', () => {
        const line = args();
        expect(line.slice(-2)).toEqual(['-p', 'fix the failing build']);
        expect(line[line.length - 3]).toBe('claude-executor');
    });

    it('mounts the checkouts volume and starts at the organization root', () => {
        expect(args({ ORG_ID: 'leeloo' })).toEqual(
            expect.arrayContaining(['-v', 'factory-ai_workspaces:/workspaces', 'WORKDIR=/workspaces/leeloo']),
        );
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
