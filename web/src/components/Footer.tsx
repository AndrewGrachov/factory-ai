import type { StatsPayload } from '../api/useStats.js';

export function Footer({ data }: { data: StatsPayload }) {
    const truncated = data.stats.meta.truncated;
    return (
        <footer>
            <span className="muted">
                {data.meta.rateLimit
                    ? `GraphQL quota left: ${data.meta.rateLimit.remaining}`
                    : 'GraphQL quota not reported'}
            </span>
            <span className="muted">
                {truncated.length ? `${truncated.length} PR(s) with truncated detail` : ''}
            </span>
        </footer>
    );
}
