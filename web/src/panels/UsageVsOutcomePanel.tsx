import type { TelemetryStats } from '@factory-ai/core';
import type { TelemetryMeta } from '../api/useStats.js';
import { Scatter } from '../charts/Scatter.js';
import { duration, tokens } from '../format.js';
import { TelemetryFrame } from './TelemetryFrame.js';

export function UsageVsOutcomePanel({
    telemetry,
    meta,
}: {
    telemetry: TelemetryStats;
    meta: TelemetryMeta;
}) {
    // 'linked' AND 'exact': both carry real numbers, and linked is the stronger tier — filtering
    // to 'exact' alone blanked this panel entirely on data where every PR came from a
    // transcript pr-link. 'shared' and 'none' stay out because their tokens are null, and
    // placing a null at an axis position is how a chart lies.
    const plotted = telemetry.prs.filter(
        (r) =>
            (r.attribution === 'linked' || r.attribution === 'exact') &&
            r.cycleHours !== null &&
            r.tokens.input !== null,
    );
    const excluded = telemetry.prs.length - plotted.length;

    return (
        <TelemetryFrame
            title="Usage against outcome"
            blurb={
                <>
                    Tokens spent on a PR against how long it took to merge. Amber dots were reworked
                    after a human review. Only attributed PRs are plotted; {excluded} of{' '}
                    {telemetry.prs.length} are excluded for having no session, or a session that
                    cannot be divided.
                </>
            }
            meta={meta}
        >
            {plotted.length === 0 ? (
                <p className="muted">Nothing exactly attributed yet, so there is nothing to plot.</p>
            ) : (
                <div className="chart-wrap">
                    <Scatter
                        points={plotted.map((r) => {
                            const used = (r.tokens.input ?? 0) + (r.tokens.output ?? 0);
                            return {
                                x: used,
                                y: r.cycleHours as number,
                                className: r.commitsAfterHumanReview > 0 ? 'dot dot-warn' : 'dot',
                                title: `#${r.number} — ${tokens(used)} tokens, ${duration(r.cycleHours)}, ${r.sessions} session(s)`,
                            };
                        })}
                        width={460}
                        xLabel="tokens in + out (log)"
                        yLabel="cycle hours"
                    />
                </div>
            )}
        </TelemetryFrame>
    );
}
