import type { StatsPayload } from '../api/useStats.js';

export function TopBar({
    data,
    refreshing,
    onRefresh,
}: {
    data: StatsPayload | null;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const meta = data?.meta;
    return (
        <header className="topbar">
            <div>
                <h1>Factory stats</h1>
                <p className="muted">
                    {meta
                        ? `${meta.repo.owner}/${meta.repo.name} — PRs merged into ${meta.baseBranch}`
                        : 'loading…'}
                </p>
            </div>
            <div className="topbar-actions">
                <span className="muted">
                    {meta
                        ? `data as of ${new Date(meta.fetchedAt).toLocaleString()}${
                              meta.stale ? ' (stale)' : ''
                          }${meta.source === 'fixture' ? ' — fixture data' : ''}`
                        : ''}
                </span>
                <button type="button" onClick={onRefresh} disabled={refreshing}>
                    {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>
        </header>
    );
}
