import { ChartRoot } from './Axes.js';
import { PAD, linearScale, niceMax } from './scale.js';

export interface HBarRow {
    label: string;
    value: number;
    display?: string;
}

const LABEL_WIDTH = 160;

export function HBarChart({
    rows,
    width = 340,
    barHeight = 22,
}: {
    rows: HBarRow[];
    width?: number;
    barHeight?: number;
}) {
    const height = rows.length * barHeight + PAD.top + 8;
    const max = niceMax(Math.max(...rows.map((r) => r.value), 0));
    const x = linearScale([0, max], [LABEL_WIDTH, width - 16]);

    return (
        <ChartRoot width={width} height={height}>
            {rows.map((r, i) => {
                const y = PAD.top + i * barHeight;
                return (
                    <g key={r.label}>
                        <text x={0} y={y + 14} className="tick" textAnchor="start">
                            {r.label}
                        </text>
                        <rect
                            x={LABEL_WIDTH}
                            y={y + 4}
                            width={Math.max(x(r.value) - LABEL_WIDTH, 1)}
                            height={barHeight - 10}
                            className="bar bar-primary"
                        />
                        <text x={x(r.value) + 6} y={y + 14} className="tick">
                            {r.display ?? r.value}
                        </text>
                    </g>
                );
            })}
        </ChartRoot>
    );
}
