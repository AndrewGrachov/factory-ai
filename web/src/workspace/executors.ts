import type { ExecutorType } from '@factory-ai/core';

/**
 * Client-side structural validation for the pasted executor config.
 *
 * UX only — the server re-validates authoritatively. Exported as a pure function so the offline
 * suite can assert it, the way `pollDelay` is in api/useWorkspace.ts.
 */

/**
 * What each type minimally requires inside `config`, beyond being an object. Empty for now: the
 * contract is "raw JSON the member pastes", and field rules belong to the day an actual consumer
 * exists and can be wrong about them. Adding a type's requirements is one line here.
 */
export const REQUIRED_FIELDS: Record<ExecutorType, readonly string[]> = {
    'claude-code': [],
};

/** Half the 64 KiB body budget, so the serialized envelope cannot blow the server limit. */
export const MAX_CONFIG_BYTES = 32 * 1024;

export type ValidExecutor = {
    name: string;
    type: ExecutorType;
    config: object;
};

export type ExecutorValidation =
    | { ok: true; value: ValidExecutor }
    | { ok: false; error: string };

export function validateExecutorConfig(raw: string, name: string, type: ExecutorType): ExecutorValidation {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, error: 'Paste the executor config as JSON.' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch (e) {
        return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, error: 'The config must be a JSON object, not a list or a scalar.' };
    }

    const trimmedName = name.trim();
    if (!trimmedName) return { ok: false, error: 'Give the executor a name.' };
    if (/[/\\]/.test(trimmedName)) return { ok: false, error: 'The name cannot contain "/" or "\\".' };
    if (/^[-.]/.test(trimmedName)) return { ok: false, error: 'The name cannot start with "-" or ".".' };

    for (const field of REQUIRED_FIELDS[type]) {
        if (!(field in parsed)) {
            return { ok: false, error: `The config for "${type}" must set "${field}".` };
        }
    }

    if (new TextEncoder().encode(trimmed).length > MAX_CONFIG_BYTES) {
        return { ok: false, error: 'The config is too large (limit 32 KiB).' };
    }

    return { ok: true, value: { name: trimmedName, type, config: parsed } };
}
