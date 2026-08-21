import type { Stats } from '@factory-ai/core';
import { HBarChart, type HBarRow } from '../charts/HBarChart.js';
import { KeyValues } from '../components/KeyValues.js';
import { num } from '../format.js';

export function ReworkPanel({ stats }: { stats: Stats }) {
    const r = stats.rework;
    const rows: HBarRow[] = [
        { label: 'after any review', value: r.afterAnyReview },
        { label: 'after human review', value: r.afterHumanReview },
        { label: 'force-pushes', value: r.forcePushes },
    ];
    // Without a readable branch history there is no revert count, and a zero-length bar
    // would read as "no reverts".
    if (stats.quality.history) {
        rows.push({
            label: `reverts on ${stats.quality.history.branch}`,
            value: stats.quality.history.reverts,
        });
    }

    return (
        <section className="panel">
            <h2>Rework</h2>
            <p className="muted">
                The bot reviews within minutes of opening, so "after any review" counts almost every
                commit as rework. The human-review variant is the honest one.
            </p>
            <div className="chart-wrap">
                <HBarChart rows={rows} width={460} />
            </div>
            <KeyValues
                pairs={[
                    [
                        'PRs that got any review',
                        `${r.prsWithAnyReview} of ${stats.meta.counts.mergedToBase}`,
                    ],
                    [
                        'PRs that got a human review',
                        `${r.prsWithHumanReview} of ${stats.meta.counts.mergedToBase}`,
                    ],
                    ['median commits after human review', num(r.medianCommitsAfterHumanReview, 1)],
                ]}
            />
        </section>
    );
}
