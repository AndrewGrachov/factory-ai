export interface TokenProvider {
    get(): Promise<string>;
}

/**
 * Async from the start so a GitHub App installation-token provider — which has to mint
 * and refresh — drops in without touching any call site. Nothing else in the server
 * reads GITHUB_TOKEN.
 */
export function envTokenProvider(env: NodeJS.ProcessEnv = process.env): TokenProvider {
    return {
        async get() {
            const token = env.GITHUB_TOKEN;
            if (!token) throw new Error('GITHUB_TOKEN is not set');
            return token;
        },
    };
}

export function staticTokenProvider(token: string): TokenProvider {
    return { get: async () => token };
}
