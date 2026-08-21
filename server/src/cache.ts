export interface CacheEntry<T> {
    value: T;
    fetchedAt: number;
}

export interface Cache<T> {
    /** The last good value, whether or not it is stale. Null until the first success. */
    peek(): CacheEntry<T> | null;
    isStale(): boolean;
    /** Runs `produce` at most once concurrently, no matter how many callers arrive. */
    refresh(): Promise<CacheEntry<T>>;
    inFlight(): boolean;
}

export interface CacheDeps<T> {
    ttlMs: number;
    produce: () => Promise<T>;
    now?: () => number;
}

/**
 * One in-memory slot with single-flight refresh. No disk, no Redis: a restart costs one
 * ~45s fetch. Callers decide whether to serve a stale entry — that is what keeps the last
 * good render on screen when GitHub rate-limits us.
 */
export function createCache<T>({ ttlMs, produce, now = Date.now }: CacheDeps<T>): Cache<T> {
    let entry: CacheEntry<T> | null = null;
    let pending: Promise<CacheEntry<T>> | null = null;

    return {
        peek: () => entry,
        isStale: () => entry === null || now() - entry.fetchedAt >= ttlMs,
        inFlight: () => pending !== null,
        refresh() {
            if (pending) return pending;
            pending = produce()
                .then((value) => {
                    entry = { value, fetchedAt: now() };
                    return entry;
                })
                .finally(() => {
                    pending = null;
                });
            return pending;
        },
    };
}
