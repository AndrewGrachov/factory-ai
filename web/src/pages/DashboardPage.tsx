import { useShell } from '../components/AppShell.js';
import { Footer } from '../components/Footer.js';
import { Limitations } from '../components/Limitations.js';
import { RangeSelector } from '../components/RangeSelector.js';
import { StatusBanner } from '../components/StatusBanner.js';
import { AiUsagePanel } from '../panels/AiUsagePanel.js';
import { AuthorsPanel } from '../panels/AuthorsPanel.js';
import { CommitsPanel } from '../panels/CommitsPanel.js';
import { DataQualityPanel } from '../panels/DataQualityPanel.js';
import { HeadlineCards } from '../panels/HeadlineCards.js';
import { PrTokenPanel } from '../panels/PrTokenPanel.js';
import { ReviewSignalPanel } from '../panels/ReviewSignalPanel.js';
import { ReworkPanel } from '../panels/ReworkPanel.js';
import { SizePanel } from '../panels/SizePanel.js';
import { ThroughputPanel } from '../panels/ThroughputPanel.js';
import { TokenUsagePanel } from '../panels/TokenUsagePanel.js';
import { UsageVsOutcomePanel } from '../panels/UsageVsOutcomePanel.js';

/** The panel list, unchanged. The state it used to own moved up to AppShell — see the note there. */
export function DashboardPage() {
    const { data, range, setRange, progress, error } = useShell();

    return (
        <>
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
                            <SizePanel stats={data.stats} repoCount={data.meta.repos.length} />
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
                                <PrTokenPanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                    repoCount={data.meta.repos.length}
                                />
                                <UsageVsOutcomePanel
                                    telemetry={data.telemetry}
                                    meta={data.meta.telemetry}
                                    repoCount={data.meta.repos.length}
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
