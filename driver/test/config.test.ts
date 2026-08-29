import { describe, expect, it } from 'vitest';
import { loadDriverConfig } from '../src/config.js';

describe('the driver config', () => {
    it('runs on defaults, so a driver next to the dashboard needs no environment at all', () => {
        const config = loadDriverConfig({});

        expect(config).toMatchObject({
            boardUrl: 'http://127.0.0.1:8080',
            orgId: 'default',
            image: 'claude-executor',
            workspaceVolume: 'factory-ai_workspaces',
            workspaceMount: '/workspaces',
            network: null,
            concurrency: 2,
            pollMs: 5_000,
            leaseSeconds: 300,
            jobTimeoutMs: 1_800_000,
            skipPermissions: false,
            remoteControl: false,
            idleMs: 3_600_000,
            authVolume: 'claude-executor-auth',
        });
        expect(config.passEnv).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']);
    });

    it('trims the trailing slash, so a board url pastes in either form', () => {
        expect(loadDriverConfig({ JOB_BOARD_URL: 'http://dashboard:8080/' }).boardUrl).toBe(
            'http://dashboard:8080',
        );
    });

    it.each([
        ['JOB_BOARD_URL', { JOB_BOARD_URL: 'dashboard:8080' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '0' }],
        ['DRIVER_CONCURRENCY', { DRIVER_CONCURRENCY: '2.5' }],
        ['DRIVER_POLL_MS', { DRIVER_POLL_MS: '10' }],
        ['DRIVER_LEASE_SECONDS', { DRIVER_LEASE_SECONDS: '5' }],
        ['DRIVER_JOB_TIMEOUT_MS', { DRIVER_JOB_TIMEOUT_MS: 'soon' }],
    ])('refuses a bad %s rather than falling back to the default', (label, env) => {
        expect(() => loadDriverConfig(env)).toThrow(label);
    });

    // The switch that decides whether an agent may edit and run things unsupervised. A typo in it
    // must not read as "on".
    it('treats only an explicit value as permission to skip permissions', () => {
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '1' }).skipPermissions).toBe(true);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '0' }).skipPermissions).toBe(false);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: 'false' }).skipPermissions).toBe(false);
        expect(loadDriverConfig({ RUNNER_SKIP_PERMISSIONS: '' }).skipPermissions).toBe(false);
    });

    // Turning this on stops a job being run-to-completion: the container lives until the session is
    // ended or the timeout kills it. A typo must not read as "on".
    it('treats only an explicit value as a request for Remote Control', () => {
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '1' }).remoteControl).toBe(true);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '0' }).remoteControl).toBe(false);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: 'false' }).remoteControl).toBe(false);
        expect(loadDriverConfig({ RUNNER_REMOTE_CONTROL: '' }).remoteControl).toBe(false);
    });

    it('reads RUNNER_ENV as a list of names', () => {
        expect(loadDriverConfig({ RUNNER_ENV: 'A, B ,,C' }).passEnv).toEqual(['A', 'B', 'C']);
    });
});
