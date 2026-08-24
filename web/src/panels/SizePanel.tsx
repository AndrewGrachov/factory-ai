import type { Stats } from '@factory-ai/core';
import { Histogram } from '../charts/BarChart.js';
import { Scatter } from '../charts/Scatter.js';
import { duration, prLabel } from '../format.js';

const dotClass = (botThreads: number) =>
    botThreads > 10 ? 'dot dot-bad' : botThreads > 0 ? 'dot dot-warn' : 'dot';

export function SizePanel({ stats, repoCount }: { stats: Stats; repoCount: number }) {
    return (
        <section className="panel">
            <h2>PR size</h2>
            <p className="muted">
                Size counts <code>additions + deletions</code>, so lockfiles, translations and
                generated code are in here. Dots are coloured by bot review threads.
            </p>
            <div className="chart-wrap">
                <Histogram
                    labels={stats.size.histogram.map((b) => b.label)}
                    values={stats.size.histogram.map((b) => b.count)}
                    width={460}
                />
            </div>
            <div className="chart-wrap">
                <Scatter
                    points={stats.size.scatter.map((p) => ({
                        x: p.size,
                        y: p.hours,
                        className: dotClass(p.botThreads),
                        title: `${prLabel(p.repo, p.number, repoCount)} — ${p.size} LOC, ${duration(p.hours)}, ${p.botThreads} bot threads`,
                    }))}
                    width={460}
                    xLabel="PR size, LOC (log)"
                    yLabel="cycle hours"
                />
            </div>
        </section>
    );
}
