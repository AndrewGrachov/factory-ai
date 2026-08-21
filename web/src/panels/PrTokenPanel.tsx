import type { PrTelemetryRow, TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { DataTable } from '../components/DataTable.js';
import type { Column } from '../components/DataTable.js';
import { duration, num, pct, tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

const attribution = (row: PrTelemetryRow) =>
    row.attribution === 'shared' ? 'shared — not divisible' : row.attribution === 'none' ? '—' : 'exact';

const columns: Column<PrTelemetryRow>[] = [
    { key: 'number', label: 'PR', format: (r) => `#${r.number}` },
    { key: 'branch', label: 'branch' },
    { key: 'author', label: 'author' },
    { key: 'sessions', label: 'sessions', format: (r) => (r.sessions ? String(r.sessions) : '—') },
    { key: 'tokens', label: 'in', format: (r) => tokens(r.tokens.input) },
    { key: 'tokens', label: 'out', format: (r) => tokens(r.tokens.output) },
    { key: 'linesAdded', label: '+LOC', format: (r) => num(r.linesAdded, 0) },
    { key: 'linesRemoved', label: '−LOC', format: (r) => num(r.linesRemoved, 0) },
    { key: 'acceptRatio', label: 'edits kept', format: (r) => pct(r.acceptRatio) },
    { key: 'size', label: 'diff LOC', format: (r) => num(r.size, 0) },
    { key: 'cycleHours', label: 'cycle', format: (r) => duration(r.cycleHours) },
    {
        key: 'commitsAfterHumanReview',
        label: 'reworked',
        format: (r) => (r.commitsAfterHumanReview > 0 ? `yes (${r.commitsAfterHumanReview})` : 'no'),
    },
    { key: 'attribution', label: 'attribution', format: attribution },
];

export function PrTokenPanel({
    telemetry,
    meta,
}: {
    telemetry: TelemetryStats;
    meta: TelemetryMeta;
}) {
    // PRs with no matching session are deliberately excluded from the table but counted in
    // the caption: listing 194 all-dash rows would bury the nine that have data, while
    // dropping them silently would hide how partial the coverage is.
    const rows = telemetry.prs.filter((r) => r.attribution !== 'none');

    return (
        <TelemetryFrame
            title="Per-PR attribution"
            blurb={
                <>
                    Sessions matched to a PR through the branch the hook recorded, then narrowed by
                    time — a head branch is not a unique key here. Lines are what the agent wrote
                    during those sessions, <strong>not</strong> what survived to merge.{' '}
                    {telemetry.prsWithoutTelemetry} of {telemetry.prs.length} PRs have no session at
                    all and are omitted; {telemetry.sharedSessions} session(s) held several branches
                    and cannot be divided.
                </>
            }
            meta={meta}
        >
            {rows.length === 0 ? (
                <p className="muted">
                    No session has been matched to a PR yet.{' '}
                    {telemetry.sessionsWithoutHook > 0
                        ? `${telemetry.sessionsWithoutHook} session(s) arrived without hook data — the agent-telemetry plugin is probably not installed.`
                        : 'Work on a branch with an open PR and it will appear here.'}
                </p>
            ) : (
                <DataTable columns={columns} rows={rows} sortable />
            )}
        </TelemetryFrame>
    );
}
