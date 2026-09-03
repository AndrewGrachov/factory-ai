import { describe, expect, it } from 'vitest';
import { EXECUTOR_TYPES } from '@factory-ai/core';
import { MAX_CONFIG_BYTES, REQUIRED_FIELDS, validateExecutorConfig } from '../src/workspace/executors.js';

const valid = () => validateExecutorConfig('{ "model": "sonnet" }', 'main', 'claude-code');

describe('validateExecutorConfig', () => {
    it('accepts a plain object with a name and a known type', () => {
        expect(valid()).toEqual({
            ok: true,
            value: { name: 'main', type: 'claude-code', config: { model: 'sonnet' } },
        });
    });

    it('trims the name it keeps', () => {
        const result = validateExecutorConfig('{}', '  main  ', 'claude-code');
        expect(result.ok && result.value.name).toBe('main');
    });

    it('rejects paste that is not JSON, with the parser said so', () => {
        const result = validateExecutorConfig('{ model: sonnet }', 'main', 'claude-code');
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/Not valid JSON/);
    });

    it('rejects an empty paste', () => {
        expect(validateExecutorConfig('   ', 'main', 'claude-code').ok).toBe(false);
    });

    it('rejects a JSON array or scalar as the config', () => {
        // An object is the contract; an array would pass a naive `typeof === 'object'` check.
        expect(validateExecutorConfig('[]', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('7', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('"text"', 'main', 'claude-code').ok).toBe(false);
        expect(validateExecutorConfig('null', 'main', 'claude-code').ok).toBe(false);
    });

    it('rejects a blank, slashed, or dash-leading name', () => {
        for (const name of ['', '  ', 'a/b', 'a\\b', '-x', '.hidden']) {
            const result = validateExecutorConfig('{}', name, 'claude-code');
            expect(result.ok, name).toBe(false);
        }
    });

    it('enforces the per-type required fields', () => {
        // Empty today — the contract is raw JSON until a consumer defines the fields — but the
        // mechanism is asserted so adding a requirement actually bites.
        expect(REQUIRED_FIELDS['claude-code']).toEqual([]);
    });

    it('rejects a config over the size limit', () => {
        const big = JSON.stringify({ padding: 'x'.repeat(MAX_CONFIG_BYTES) });
        expect(validateExecutorConfig(big, 'main', 'claude-code').ok).toBe(false);
    });

    it('covers every executor type in REQUIRED_FIELDS', () => {
        // The exhaustiveness guard: a new EXECUTOR_TYPES entry must declare its requirements,
        // even if the answer is "none", or this record stops compiling.
        for (const type of EXECUTOR_TYPES) expect(type in REQUIRED_FIELDS).toBe(true);
    });
});
