import type { FetchState } from '../api/useStats.js';

function describe(progress: FetchState): string {
    // Named rather than counted: repos are fetched sequentially, so with several configured the
    // only way to tell progress from a stall is knowing which one is in flight.
    const where = progress.repo ? ` in ${progress.repo}` : '';
    if (progress.backfillingPr !== null && progress.phase === 'backfill') {
        return `Fetching the full review history of #${progress.backfillingPr}${where}…`;
    }
    if (progress.phase === 'history') {
        return `Scanning branch history${where}… ${progress.historyScanned ?? 0} commits`;
    }
    return `Fetching pull requests${where}… ${progress.prsFetched ?? 0} so far`;
}

export function StatusBanner({
    progress,
    error,
    hasData,
}: {
    progress: FetchState | null;
    error: string | null;
    hasData: boolean;
}) {
    if (error) {
        return (
            <p className="status error">
                {error}
                {hasData ? ' — showing the last successful fetch below.' : ''}
            </p>
        );
    }
    if (!progress) return null;
    return (
        <p className="status">
            {describe(progress)}
            {hasData ? '' : ' (a cold fetch takes about 45 seconds)'}
        </p>
    );
}
