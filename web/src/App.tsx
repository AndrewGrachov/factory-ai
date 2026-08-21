import { useMemo, useState } from 'react';
import { useStats } from './api/useStats.js';
import { Footer } from './components/Footer.js';
import { Limitations } from './components/Limitations.js';
import { DEFAULT_RANGE, RangeSelector, rangeQuery } from './components/RangeSelector.js';
import type { RangeSelection } from './components/RangeSelector.js';
import { StatusBanner } from './components/StatusBanner.js';
import { TopBar } from './components/TopBar.js';
import { AiUsagePanel } from './panels/AiUsagePanel.js';
import { AuthorsPanel } from './panels/AuthorsPanel.js';
import { CommitsPanel } from './panels/CommitsPanel.js';
import { DataQualityPanel } from './panels/DataQualityPanel.js';
import { HeadlineCards } from './panels/HeadlineCards.js';
import { PrTokenPanel } from './panels/PrTokenPanel.js';
import { ReviewSignalPanel } from './panels/ReviewSignalPanel.js';
import { ReworkPanel } from './panels/ReworkPanel.js';
import { SizePanel } from './panels/SizePanel.js';
import { ThroughputPanel } from './panels/ThroughputPanel.js';
import { TokenUsagePanel } from './panels/TokenUsagePanel.js';
import { UsageVsOutcomePanel } from './panels/UsageVsOutcomePanel.js';

export function App() {
    const [range, setRange] = useState<RangeSelection>(DEFAULT_RANGE);
    const query = useMemo(() => rangeQuery(range), [range]);
    const { data, refreshing, progress, error, refresh } = useStats(query);

    return (
        <>
            <TopBar data={data} refreshing={refreshing} onRefresh={refresh} />
            <main>
                <RangeSelector range={range} onChange={setRange} />
                <StatusBanner progress={progress} error={error} hasData={data !== null} />
                {data ? (
                    <>
                        <HeadlineCards stats={data.stats} />
                        <ThroughputPanel stats={data.stats} />
                        <div className="two-up">
                            <ReviewSignalPanel stats={data.stats} />
                            <ReworkPanel stats={data.stats} />
                        </div>
                        <div className="two-up">
                            <SizePanel stats={data.stats} />
                            <CommitsPanel stats={data.stats} />
                        </div>
                        <AuthorsPanel stats={data.stats} />
                        {/* Nothing telemetry-shaped renders when the feature is switched off:
                            empty frames for a feature nobody enabled are just noise. */}
                        {data.telemetry ? (
                            <>
                                <AiUsagePanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                    mergedPrs={data.stats.quality.mergedPrs}
                                />
                                <TokenUsagePanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                />
                                <PrTokenPanel telemetry={data.telemetry} meta={data.meta.telemetry} />
                                <UsageVsOutcomePanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                />
                            </>
                        ) : null}
                        <DataQualityPanel stats={data.stats} meta={data.meta} />
                        <Limitations />
                    </>
                ) : null}
            </main>
            {data ? <Footer data={data} /> : null}
        </>
    );
}
