export type GitHubErrorCode =
    | 'TOKEN_REJECTED'
    | 'FORBIDDEN'
    | 'RATE_LIMITED'
    | 'NOT_FOUND'
    | 'UPSTREAM'
    | 'NETWORK'
    | 'GRAPHQL';

export class GitHubError extends Error {
    readonly code: GitHubErrorCode;
    readonly status: number | undefined;

    constructor(message: string, code: GitHubErrorCode, status?: number) {
        super(message);
        this.name = 'GitHubError';
        this.code = code;
        this.status = status;
    }
}

export interface HttpFailure {
    message: string;
    code: GitHubErrorCode;
}

export function describeHttpFailure(
    response: { status: number; headers: { get(name: string): string | null } },
    body: string,
    repo: { owner: string; name: string },
): HttpFailure {
    if (response.status === 401) {
        return {
            code: 'TOKEN_REJECTED',
            message: 'Token rejected (401). It is invalid, expired, or revoked.',
        };
    }
    if (response.status === 403 || response.status === 429) {
        // Header-based detection is the reliable signal, but a proxy that does not
        // expose x-ratelimit-* would make a rate limit look like a permission problem,
        // so fall back to the message GitHub puts in the body.
        const remaining = response.headers.get('x-ratelimit-remaining');
        const reset = response.headers.get('x-ratelimit-reset');
        if (remaining === '0' || /rate limit/i.test(body)) {
            const at = reset ? new Date(Number(reset) * 1000).toISOString() : 'an unknown time';
            return { code: 'RATE_LIMITED', message: `Rate limit exhausted. Resets at ${at}.` };
        }
        return {
            code: 'FORBIDDEN',
            message: `Forbidden (${response.status}). The token likely lacks access to ${repo.owner}/${repo.name}, or the org has not approved it.`,
        };
    }
    if (response.status === 404) {
        return {
            code: 'NOT_FOUND',
            message: `Repository ${repo.owner}/${repo.name} not visible to this token.`,
        };
    }
    return { code: 'UPSTREAM', message: `GitHub returned ${response.status}. ${body.slice(0, 200)}` };
}
