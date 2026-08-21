/**
 * A null metric means "not measurable", which is never the same as zero. Every formatter
 * renders it as an em dash; callers must not substitute `?? 0`, and must not test
 * truthiness, because 0 is a real value here.
 */
export const pct = (value: number | null | undefined): string =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;

export const num = (value: number | null | undefined, digits = 1): string =>
    value === null || value === undefined ? '—' : Number(value.toFixed(digits)).toString();

export function duration(hours: number | null | undefined): string {
    if (hours === null || hours === undefined) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    if (hours < 48) return `${num(hours, 1)}h`;
    return `${num(hours / 24, 1)}d`;
}

/**
 * Rounded on purpose. The branch attribution behind these figures is a ~20s sample from a
 * hook that is allowed to fail, so "92.4k" is the honest precision and "92,431" is not.
 */
export function tokens(value: number | null | undefined): string {
    if (value === null || value === undefined) return '—';
    if (value < 1000) return String(Math.round(value));
    if (value < 1_000_000) return `${num(value / 1000, 1)}k`;
    // Billions are routine once cache reads are counted — a real run showed 4.5e9, which
    // rendered as the unreadable "4543.89M" before this branch existed.
    if (value < 1_000_000_000) return `${num(value / 1_000_000, 2)}M`;
    return `${num(value / 1_000_000_000, 2)}B`;
}
