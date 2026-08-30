import type { ProviderCapabilities } from './canonical.js';

export const DEFAULT_BOTS = [
    'claude',
    'claude[bot]',
    'github-actions',
    'github-actions[bot]',
    'bellows-frontend-fix-bot',
];

export const AI_LABELS = new Set(['bellows-frontend-fix', 'bellows-backend-fix']);

/**
 * Every capability present. The default for `derive`, so a caller that has not yet grown a
 * provider notion behaves exactly as before rather than nulling metrics it can measure.
 */
export const ALL_CAPABILITIES: ProviderCapabilities = Object.freeze({ reviewLinkage: true });

export const HOUR = 3600 * 1000;

/**
 * A revert is recognised from its headline, so persisted commits keep the headline and are
 * re-classified on read. Storing the verdict instead would freeze this definition into every
 * historical row, and the next refinement could not reach them.
 */
export function isRevertHeadline(headline: string): boolean {
    return /^revert[\s"']/i.test(headline);
}

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
