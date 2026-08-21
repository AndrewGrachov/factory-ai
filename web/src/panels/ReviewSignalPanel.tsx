import type { ReviewerRow, Stats } from '@factory-ai/core';
import { BarChart } from '../charts/BarChart.js';
import { DataTable } from '../components/DataTable.js';
import { pct } from '../format.js';

export function ReviewSignalPanel({ stats }: { stats: Stats }) {
    const weeks = stats.weekly;
    return (
        <section className="panel">
            <h2>Review signal quality</h2>
            <p className="muted">
                Review threads per week by fate. Unresolved-but-outdated usually means the code
                changed and nobody clicked resolve; unresolved-and-live means the comment was left
                standing.
            </p>
            <div className="chart-wrap">
                <BarChart
                    labels={weeks.map((w) => w.start.slice(5))}
                    series={[
                        { values: weeks.map((w) => w.resolved), className: 'bar-ok' },
                        { values: weeks.map((w) => w.unresolvedOutdated), className: 'bar-warn' },
                        { values: weeks.map((w) => w.unresolvedLive), className: 'bar-bad' },
                    ]}
                    width={460}
                    height={240}
                    labelEvery={Math.ceil(weeks.length / 6)}
                />
            </div>
            <DataTable<ReviewerRow>
                rows={stats.reviewers}
                columns={[
                    {
                        key: 'login',
                        label: 'reviewer',
                        format: (r) => r.login + (r.isBot ? ' (bot)' : ''),
                    },
                    { key: 'threads', label: 'threads' },
                    { key: 'resolvedRatio', label: 'resolved', format: (r) => pct(r.resolvedRatio) },
                    { key: 'bodyOnlyReviews', label: 'body-only reviews' },
                    { key: 'prsTouched', label: 'PRs' },
                ]}
            />
        </section>
    );
}
