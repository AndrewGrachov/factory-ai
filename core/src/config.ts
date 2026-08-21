export const DEFAULT_BOTS = [
    'claude',
    'claude[bot]',
    'github-actions',
    'github-actions[bot]',
    'leeloo-frontend-fix-bot',
];

export const AI_LABELS = new Set(['leeloo-frontend-fix', 'leeloo-backend-fix']);

export const HOUR = 3600 * 1000;

export interface SizeBucket {
    label: string;
    max: number;
}

export const SIZE_BUCKETS: readonly SizeBucket[] = [
    { label: '<50', max: 50 },
    { label: '50–200', max: 200 },
    { label: '200–1k', max: 1000 },
    { label: '1k–5k', max: 5000 },
    { label: '>5k', max: Infinity },
];
