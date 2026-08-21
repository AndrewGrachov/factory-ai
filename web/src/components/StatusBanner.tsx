import type { FetchState } from '../api/useStats.js';

function describe(progress: FetchState): string {
    if (progress.backfillingPr !== null && progress.phase === 'backfill') {
        return `Fetching the full review history of #${progress.backfillingPr}…`;
    }
    if (progress.phase === 'history') {
        return `Scanning branch history… ${progress.historyScanned ?? 0} commits`;
    }
    return `Fetching pull requests… ${progress.prsFetched ?? 0} so far`;
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
