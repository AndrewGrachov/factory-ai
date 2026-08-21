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
