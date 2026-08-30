import type { CloneStatus } from '../api/useWorkspace.js';

const LABELS: Record<CloneStatus, string> = {
    queued: 'queued',
    cloning: 'cloning…',
    ready: 'ready',
    failed: 'failed',
};

/**
 * A clone's state, with its reason attached when it has one.
 *
 * A failed pill carries git's own message inline rather than behind a tooltip, following
 * OrgSelector's rule that a control which is not doing what you expect should say why where you are
 * already looking. "failed" on its own sends somebody to the server logs for a sentence the row
 * already has.
 */
export function RepoStatus({ status, error }: { status: CloneStatus; error: string | null }) {
    return (
        <span className={`pill pill-${status}`}>
            {LABELS[status]}
            {status === 'failed' && error ? <span className="pill-reason">{error}</span> : null}
        </span>
    );
}
