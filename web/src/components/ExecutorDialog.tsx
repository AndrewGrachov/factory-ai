import { useEffect, useRef, useState } from 'react';
import { EXECUTOR_TYPES, type ExecutorType } from '@factory-ai/core';
import { validateExecutorConfig } from '../workspace/executors.js';

/**
 * Add an executor.
 *
 * The same native-`<dialog>` bargain RepoPickerDialog makes: `showModal()` buys the top layer,
 * focus trapping, `::backdrop` and Escape without a hand-rolled trap; no `<form>` submits because
 * CSP sends `form-action 'none'`. The one difference in body is a textarea for the pasted JSON,
 * re-validated on every keystroke by the pure validator — cheap, and the message under the field is
 * what makes raw JSON pasteable at all.
 */

export interface ExecutorDialogProps {
    open: boolean;
    onClose: () => void;
    onSave: (executors: { name: string; type: string; config: object }[]) => Promise<string | null>;
    saving: boolean;
}

export function ExecutorDialog({ open, onClose, onSave, saving }: ExecutorDialogProps) {
    const ref = useRef<HTMLDialogElement | null>(null);
    const [type, setType] = useState<ExecutorType>(EXECUTOR_TYPES[0]);
    const [name, setName] = useState('');
    const [config, setConfig] = useState('');
    const [failure, setFailure] = useState<string | null>(null);

    // Fresh fields every time it opens; a stale paste from the last attempt is worse than blank.
    useEffect(() => {
        if (open) {
            setType(EXECUTOR_TYPES[0]);
            setName('');
            setConfig('');
            setFailure(null);
        }
    }, [open]);

    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        if (open && !dialog.open) dialog.showModal();
        if (!open && dialog.open) dialog.close();
    }, [open]);

    // Escape closes the dialog without telling React, so without this the parent still believes it
    // is open and will not reopen it.
    useEffect(() => {
        const dialog = ref.current;
        if (!dialog) return;
        const closed = () => onClose();
        dialog.addEventListener('close', closed);
        return () => dialog.removeEventListener('close', closed);
    }, [onClose]);

    const validation = validateExecutorConfig(config, name, type);

    const save = async () => {
        if (!validation.ok) {
            setFailure(validation.error);
            return;
        }
        const message = await onSave([validation.value]);
        setFailure(message);
        if (!message) onClose();
    };

    return (
        <dialog className="picker" ref={ref} aria-labelledby="executor-title">
            <h2 id="executor-title">Add executor</h2>
            <p className="muted">
                An executor is what runs your agents' work. Paste its configuration as raw JSON.
            </p>

            <label className="picker-search">
                <span className="muted">type</span>
                <select value={type} onChange={(event) => setType(event.target.value as ExecutorType)}>
                    {/* Rendered from the shared list, so a future type needs no JSX change. */}
                    {EXECUTOR_TYPES.map((value) => (
                        <option key={value} value={value}>
                            {value}
                        </option>
                    ))}
                </select>
            </label>

            <label className="picker-search">
                <span className="muted">name</span>
                <input
                    type="text"
                    value={name}
                    placeholder="main"
                    onChange={(event) => setName(event.target.value)}
                />
            </label>

            <label className="picker-search">
                <span className="muted">config (JSON)</span>
                <textarea
                    rows={8}
                    value={config}
                    placeholder='{ "model": "sonnet" }'
                    onChange={(event) => setConfig(event.target.value)}
                />
            </label>
            {/* Re-validated per keystroke; rendered live, before Save is even pressed. */}
            {config.trim() && !validation.ok ? <p className="status">{validation.error}</p> : null}

            {failure ? <p className="status">{failure}</p> : null}

            {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
            <div className="picker-actions">
                <button type="button" onClick={onClose}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="primary"
                    onClick={() => void save()}
                    disabled={saving || !validation.ok}
                >
                    {saving ? 'Saving…' : 'Add'}
                </button>
            </div>
        </dialog>
    );
}
