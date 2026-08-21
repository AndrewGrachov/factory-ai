import type { AuthorRow, Stats } from '@factory-ai/core';
import { DataTable } from '../components/DataTable.js';
import { duration, num, pct } from '../format.js';

export function AuthorsPanel({ stats }: { stats: Stats }) {
    return (
        <section className="panel">
            <h2>Per author</h2>
            <p className="muted">
                Workload shape, not performance. Rows with fewer than ten merged PRs are not
                comparable. Click a header to sort.
            </p>
            <DataTable<AuthorRow>
                rows={stats.authors}
                sortable
                columns={[
                    {
                        key: 'login',
                        label: 'author',
                        format: (r) => r.login + (r.isBot ? ' (bot)' : ''),
                    },
                    { key: 'merged', label: 'merged' },
                    { key: 'medianSize', label: 'median LOC', format: (r) => num(r.medianSize, 0) },
                    {
                        key: 'medianCommits',
                        label: 'median commits',
                        format: (r) => num(r.medianCommits, 1),
                    },
                    { key: 'cycleP50', label: 'cycle p50', format: (r) => duration(r.cycleP50) },
                    { key: 'reworkRatio', label: 'rework', format: (r) => pct(r.reworkRatio) },
                    { key: 'threadsReceived', label: 'threads received' },
                    {
                        key: 'unresolvedRatio',
                        label: 'unresolved',
                        format: (r) => pct(r.unresolvedRatio),
                    },
                ]}
            />
        </section>
    );
}
