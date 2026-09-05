import { describe, expect, it } from 'vitest';
import { EXECUTOR_TYPES } from '../src/executors.js';

describe('EXECUTOR_TYPES', () => {
    it('lists claude-code and opencode as the known executor types', () => {
        // The single list the server's route check and the web UI's picker both render from. The
        // user_executor.type constraint in the migrations must hold the same values — 012 created
        // it, 013 rewrote it to add opencode.
        expect([...EXECUTOR_TYPES]).toEqual(['claude-code', 'opencode']);
    });
});
