import type { BranchHistory, RawPullRequest, TruncatedPr } from '@factory-ai/core';
import type { AppConfig, Repo } from '../config.js';
import { GitHubError, describeHttpFailure } from './errors.js';
import { HISTORY_QUERY, INNER_LIMIT, PAGE_SIZE, PR_QUERY, REVIEWS_QUERY, THREADS_QUERY } from './queries.js';
import type { TokenProvider } from './token.js';

const ENDPOINT = 'https://api.github.com/graphql';
const MAX_INNER_PAGES = 50;

export interface RateLimit {
    remaining: number;
    resetAt: string;
}

interface Connection<N> {
    nodes: N[];
    pageInfo: { hasNextPage: boolean; endCursor: string };
}

interface PrPageResponse {
    repository: { pullRequests: Connection<RawPullRequest> };
    rateLimit: RateLimit | null;
}

interface HistoryResponse {
    repository: {
        ref: {
            target: {
                history?: Connection<{ messageHeadline: string; committedDate: string }> & {
                    totalCount: number;
                };
            } | null;
        } | null;
    };
}

export interface Progress {
    phase: 'prs' | 'backfill' | 'history';
    /** "owner/name" of the repo in flight, so a slow fetch says which one it is waiting on. */
    repo?: string;
    prsFetched?: number;
    backfillingPr?: number;
    historyScanned?: number;
}

export interface PullRequestsResult {
    prs: RawPullRequest[];
    truncated: TruncatedPr[];
    rateLimit: RateLimit | null;
}

/**
 * Per repo rather than combined, because a null history is not zero and the caller has to be able
 * to see WHICH repo went unreadable before deciding whether a combined figure is reportable.
 */
export interface RepoBranchHistory {
    repo: string;
    history: BranchHistory | null;
}

export interface GitHubClient {
    fetchPullRequests(options?: { onProgress?: (p: Progress) => void }): Promise<PullRequestsResult>;
    fetchBranchHistories(
        since: string,
        options?: { onProgress?: (p: Progress) => void },
    ): Promise<RepoBranchHistory[]>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface ClientDeps {
    config: AppConfig;
    tokens: TokenProvider;
    fetch?: typeof globalThis.fetch;
}

export function createGitHubClient({ config, tokens, fetch = globalThis.fetch }: ClientDeps): GitHubClient {
    const { repos, baseBranch } = config;
    const fullName = (repo: Repo) => `${repo.owner}/${repo.name}`;

    async function graphql<T>(
        query: string,
        variables: Record<string, unknown>,
        repo: Repo,
        attempts = 3,
    ): Promise<T> {
        const token = await tokens.get();
        let lastError: GitHubError | undefined;

        for (let attempt = 1; attempt <= attempts; attempt += 1) {
            let response: Response;
            try {
                response = await fetch(ENDPOINT, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                    },
                    body: JSON.stringify({ query, variables }),
                });
            } catch (e) {
                // Network-level failure: no response, so no status to branch on.
                lastError = new GitHubError(
                    `Could not reach api.github.com (${(e as Error).message}).`,
                    'NETWORK',
                );
                if (attempt === attempts) throw lastError;
                await sleep(2 ** attempt * 500);
                continue;
            }

            if (response.status >= 500) {
                const failure = describeHttpFailure(response, '', repo);
                lastError = new GitHubError(failure.message, failure.code, response.status);
                if (attempt === attempts) throw lastError;
                await sleep(2 ** attempt * 500);
                continue;
            }

            if (!response.ok) {
                const failure = describeHttpFailure(response, await response.text(), repo);
                throw new GitHubError(failure.message, failure.code, response.status);
            }

            const payload = (await response.json()) as { data: T; errors?: { message: string }[] };
            if (payload.errors?.length) {
                throw new GitHubError(
                    payload.errors.map((e) => e.message).join('; '),
                    'GRAPHQL',
                    200,
                );
            }
            return payload.data;
        }

        throw lastError as GitHubError;
    }

    // totalCount is never truncated, so headline metrics stay correct; the node lists
    // behind these connections are what a >100 count would silently cut short.
    function truncatedConnections(pr: RawPullRequest): string[] {
        return (['reviews', 'reviewThreads', 'commits'] as const).filter(
            (key) => pr[key].totalCount > INNER_LIMIT,
        );
    }

    async function collectNodes<N>(
        query: string,
        repo: Repo,
        number: number,
        field: 'reviewThreads' | 'reviews',
    ): Promise<N[]> {
        const nodes: N[] = [];
        let cursor: string | null = null;

        // Hand-written cursor loop. Note: `gh api graphql --paginate` only advances the
        // cursor if the variable is named `$endCursor` — named anything else it silently
        // re-requests page 1 forever. That bug is gh-CLI-only; do not switch to gh.
        for (let page = 0; page < MAX_INNER_PAGES; page += 1) {
            const data = await graphql<{
                repository: { pullRequest: Record<string, Connection<N>> };
            }>(
                query,
                {
                    owner: repo.owner,
                    name: repo.name,
                    number,
                    cursor,
                },
                repo,
            );
            const connection = data.repository.pullRequest[field] as Connection<N>;
            nodes.push(...connection.nodes);
            if (!connection.pageInfo.hasNextPage) return nodes;
            cursor = connection.pageInfo.endCursor;
        }

        throw new GitHubError(
            `${fullName(repo)}#${number} exceeded ${MAX_INNER_PAGES} inner pages; refusing to loop.`,
            'UPSTREAM',
        );
    }

    /** Fills in the node lists the first pass cut off. Leaves `commits` alone — it only
     *  contributes commit timestamps, and 100 is already past the point of meaning. */
    async function backfill(
        repo: Repo,
        pr: RawPullRequest,
        connections: string[],
        onProgress?: (p: Progress) => void,
    ): Promise<string[]> {
        const filled: string[] = [];

        if (connections.includes('reviewThreads')) {
            pr.reviewThreads.nodes = await collectNodes(THREADS_QUERY, repo, pr.number, 'reviewThreads');
            filled.push('reviewThreads');
        }
        if (connections.includes('reviews')) {
            pr.reviews.nodes = await collectNodes(REVIEWS_QUERY, repo, pr.number, 'reviews');
            filled.push('reviews');
        }

        onProgress?.({ phase: 'backfill', repo: fullName(repo), backfillingPr: pr.number });
        return connections.filter((c) => !filled.includes(c));
    }

    return {
        async fetchPullRequests({ onProgress } = {}): Promise<PullRequestsResult> {
            const prs: RawPullRequest[] = [];
            const oversized: { repo: Repo; pr: RawPullRequest; connections: string[] }[] = [];
            let rateLimit: RateLimit | null = null;

            // Sequential, not Promise.all: the point of the rate-limit budget is that it is
            // shared, and N concurrent paginations would burn it in a burst that the TTL floor
            // cannot smooth out.
            for (const repo of repos) {
                const name = fullName(repo);
                let cursor: string | null = null;

                for (;;) {
                    const data: PrPageResponse = await graphql<PrPageResponse>(
                        PR_QUERY,
                        {
                            owner: repo.owner,
                            name: repo.name,
                            pageSize: PAGE_SIZE,
                            cursor,
                        },
                        repo,
                    );

                    const page: Connection<RawPullRequest> = data.repository.pullRequests;
                    rateLimit = data.rateLimit;

                    for (const pr of page.nodes) {
                        // The payload carries no repo identity, so it is stamped here — the one
                        // place that knows which repo the response came from.
                        pr.repo = name;
                        const cut = truncatedConnections(pr);
                        if (cut.length) oversized.push({ repo, pr, connections: cut });
                        prs.push(pr);
                    }

                    onProgress?.({ phase: 'prs', repo: name, prsFetched: prs.length });

                    if (!page.pageInfo.hasNextPage) break;
                    cursor = page.pageInfo.endCursor;
                }
            }

            const truncated: TruncatedPr[] = [];
            for (const { repo, pr, connections } of oversized) {
                const stillCut = await backfill(repo, pr, connections, onProgress);
                if (stillCut.length) {
                    truncated.push({ repo: fullName(repo), number: pr.number, connections: stillCut });
                }
            }

            return { prs, truncated, rateLimit };
        },

        async fetchBranchHistories(since, { onProgress } = {}): Promise<RepoBranchHistory[]> {
            const results: RepoBranchHistory[] = [];
            let scanned = 0;

            for (const repo of repos) {
                const name = fullName(repo);
                let cursor: string | null = null;
                let commits = 0;
                let reverts = 0;
                let readable = true;

                for (;;) {
                    const data: HistoryResponse = await graphql<HistoryResponse>(
                        HISTORY_QUERY,
                        {
                            owner: repo.owner,
                            name: repo.name,
                            branch: baseBranch,
                            since,
                            cursor,
                        },
                        repo,
                    );

                    const history = data.repository.ref?.target?.history;
                    // No readable ref means no revert rate for this repo. Returning zeros here
                    // would render "0 reverts in 0 commits", which reads as a real answer.
                    if (!history) {
                        readable = false;
                        break;
                    }

                    commits = history.totalCount;
                    for (const commit of history.nodes) {
                        scanned += 1;
                        if (REVERT_HEADLINE.test(commit.messageHeadline)) reverts += 1;
                    }
                    onProgress?.({ phase: 'history', repo: name, historyScanned: scanned });

                    if (!history.pageInfo.hasNextPage) break;
                    cursor = history.pageInfo.endCursor;
                }

                results.push({
                    repo: name,
                    history: readable ? { branch: baseBranch, since, commits, reverts } : null,
                });
            }

            return results;
        },
    };
}

const REVERT_HEADLINE = /^revert[\s"']/i;
