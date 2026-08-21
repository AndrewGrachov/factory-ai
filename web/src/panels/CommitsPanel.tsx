import type { Stats } from '@factory-ai/core';
import { Histogram } from '../charts/BarChart.js';
import { KeyValues } from '../components/KeyValues.js';
import { duration } from '../format.js';

export function CommitsPanel({ stats }: { stats: Stats }) {
    return (
        <section className="panel">
            <h2>Commits per PR</h2>
            <div className="chart-wrap">
                <Histogram
                    labels={stats.commitsHistogram.map((b) => b.label)}
                    values={stats.commitsHistogram.map((b) => b.count)}
                    width={460}
                />
            </div>
            <KeyValues
                pairs={[
                    ['first review wait p50 (any)', duration(stats.cycle.firstReviewWaitP50)],
                    ['first review wait p50 (human)', duration(stats.cycle.firstHumanReviewWaitP50)],
                    ['last commit → merge p50', duration(stats.cycle.lastCommitToMergeP50)],
                    ['cycle p50 from ready-for-review', duration(stats.cycle.p50FromReady)],
                ]}
            />
        </section>
    );
}
