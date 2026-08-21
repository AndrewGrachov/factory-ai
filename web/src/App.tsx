import { useStats } from './api/useStats.js';
import { Footer } from './components/Footer.js';
import { Limitations } from './components/Limitations.js';
import { StatusBanner } from './components/StatusBanner.js';
import { TopBar } from './components/TopBar.js';
import { AuthorsPanel } from './panels/AuthorsPanel.js';
import { CommitsPanel } from './panels/CommitsPanel.js';
import { DataQualityPanel } from './panels/DataQualityPanel.js';
import { HeadlineCards } from './panels/HeadlineCards.js';
import { ReviewSignalPanel } from './panels/ReviewSignalPanel.js';
import { ReworkPanel } from './panels/ReworkPanel.js';
import { SizePanel } from './panels/SizePanel.js';
import { ThroughputPanel } from './panels/ThroughputPanel.js';

export function App() {
    const { data, refreshing, progress, error, refresh } = useStats();

    return (
        <>
            <TopBar data={data} refreshing={refreshing} onRefresh={refresh} />
            <main>
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
                        <DataQualityPanel stats={data.stats} meta={data.meta} />
                        <Limitations />
                    </>
                ) : null}
            </main>
            {data ? <Footer data={data} /> : null}
        </>
    );
}
