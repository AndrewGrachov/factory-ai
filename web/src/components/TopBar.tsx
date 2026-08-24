import type { StatsPayload } from '../api/useStats.js';

/**
 * Names every repo rather than reporting a count. "3 repositories combined" hides which three,
 * and the figures below are only interpretable if you know what went into them.
 */
function describeRepos(repos: { owner: string; name: string }[]): string {
    if (!repos.length) return 'no repositories configured';
    const owners = new Set(repos.map((r) => r.owner));
    // One owner is the common case, so repeating it on every entry is noise.
    if (owners.size === 1 && repos.length > 1) {
        return `${[...owners][0]}/{${repos.map((r) => r.name).join(', ')}}`;
    }
    return repos.map((r) => `${r.owner}/${r.name}`).join(', ');
}

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
                    {meta ? `${describeRepos(meta.repos)} — PRs merged into ${meta.baseBranch}` : 'loading…'}
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
