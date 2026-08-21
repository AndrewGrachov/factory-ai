export type TelemetryErrorCode = 'UNREACHABLE' | 'AUTH' | 'MIGRATION' | 'QUERY' | 'TIMEOUT';

/**
 * Mirrors GitHubError so the envelope carries a real message rather than a stringified
 * driver error. The reason text is rendered to the page, so it has to be readable.
 */
export class TelemetryError extends Error {
    readonly code: TelemetryErrorCode;

    constructor(message: string, code: TelemetryErrorCode) {
        super(message);
        this.name = 'TelemetryError';
        this.code = code;
    }
}
