/**
 * Async because the implementation that ships is `installationTokenProvider`, which mints a token
 * against GitHub and refreshes it every hour. It was async before that existed too, on the bet that
 * it eventually would — which is why swapping a personal access token for a GitHub App touched no
 * call site of this interface.
 */
export interface TokenProvider {
    get(): Promise<string>;
}
