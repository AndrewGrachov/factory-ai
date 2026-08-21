import type { Stats } from '@factory-ai/core';
import { BarChart } from '../charts/BarChart.js';

export function ThroughputPanel({ stats }: { stats: Stats }) {
    const weeks = stats.weekly;
    return (
        <section className="panel">
            <h2>Throughput</h2>
            <p className="muted">
                PRs merged into <code>{stats.meta.baseBranch}</code> per ISO week (bars) against
                median cycle time (line, right axis). Weeks with no merges are kept, and the last
                week is partial.
            </p>
            <div className="chart-wrap">
                <BarChart
                    labels={weeks.map((w) => w.start.slice(5))}
                    series={[{ values: weeks.map((w) => w.merges), className: 'bar-primary' }]}
                    line={{ label: 'cycle p50 (h)', values: weeks.map((w) => w.cycleP50) }}
                    width={900}
                    height={280}
                    labelEvery={Math.ceil(weeks.length / 12)}
                />
            </div>
        </section>
    );
}
