import type { AuthConfig } from '../config.js';

/** What GitHub is asked for, and all it is asked for. */
export interface GitHubIdentity {
    /** The identity. Stable across renames, which is why nothing keys on the login. */
    githubUserId: number;
    login: string;
    displayName: string | null;
    avatarUrl: string | null;
}

/**
 * The two calls the OAuth exchange needs, behind a seam.
 *
 * An interface rather than direct `fetch` calls because it is what keeps `npm test` offline: the
 * route tests drive a stub and never reach the network. Hand-rolled rather than delegated to an
 * OAuth library because the state and CSRF handling is the part of this flow most worth being able
 * to read here, and a library would own it — the same argument docs/organizations.md makes for not
 * introducing an interface that ships one implementation.
 */
export interface GitHubIdentityClient {
    authorizeUrl(state: string): string;
    exchange(code: string): Promise<string>;
    identity(accessToken: string): Promise<GitHubIdentity>;
}

/** Where GitHub sends the browser back. Derived from the configured origin, never from a header. */
export const callbackPath = '/api/auth/github/callback';

export class GitHubAuthError extends Error {}

export function createGitHubIdentityClient(
    auth: Extract<AuthConfig, { mode: 'github' }>,
    fetchFn: typeof fetch = fetch,
): GitHubIdentityClient {
    const redirectUri = `${auth.publicUrl}${callbackPath}`;

    return {
        authorizeUrl(state) {
            const url = new URL(auth.authorizeUrl);
            url.searchParams.set('client_id', auth.clientId);
            url.searchParams.set('redirect_uri', redirectUri);
            url.searchParams.set('state', state);
            // NO `scope` parameter, deliberately. Membership is Factory's, not GitHub's, so
            // `read:org` buys nothing; and the numeric id and login this flow needs come back from
            // /user on an unscoped token. The visible cost is that GitHub's consent screen then says
            // the app "will not be able to access your data", which reads as broken to some people —
            // that is the honest description of a login that reads nothing.
            return url.toString();
        },

        async exchange(code) {
            const response = await fetchFn(auth.tokenUrl, {
                method: 'POST',
                headers: { accept: 'application/json', 'content-type': 'application/json' },
                body: JSON.stringify({
                    client_id: auth.clientId,
                    client_secret: auth.clientSecret,
                    code,
                    redirect_uri: redirectUri,
                }),
            });
            if (!response.ok) {
                throw new GitHubAuthError(`token exchange failed with ${response.status}`);
            }
            const body = (await response.json()) as { access_token?: string; error_description?: string; error?: string };
            if (!body.access_token) {
                // GitHub reports a bad or reused code with a 200 and an `error` field, so the status
                // check above does not cover it.
                throw new GitHubAuthError(body.error_description ?? body.error ?? 'no access token returned');
            }
            return body.access_token;
        },

        async identity(accessToken) {
            const response = await fetchFn(auth.userUrl, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    accept: 'application/vnd.github+json',
                    // GitHub rejects an API request with no User-Agent outright.
                    'user-agent': 'factory-ai',
                },
            });
            if (!response.ok) throw new GitHubAuthError(`identity lookup failed with ${response.status}`);
            const body = (await response.json()) as {
                id?: number;
                login?: string;
                name?: string | null;
                avatar_url?: string | null;
            };
            if (typeof body.id !== 'number' || !body.login) {
                throw new GitHubAuthError('identity response carried no id or login');
            }
            return {
                githubUserId: body.id,
                login: body.login,
                displayName: body.name ?? null,
                avatarUrl: body.avatar_url ?? null,
            };
        },
    };
}
