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
    /**
     * Fills an empty slot from durable storage, dated by when that data was actually fetched.
     *
     * Only fills an EMPTY slot: a seed arriving after a live fetch has already landed is older
     * by definition, and overwriting would move the dashboard backwards. Returns whether it
     * took effect.
     */
    seed(value: T, fetchedAt: number): boolean;
}

export interface CacheDeps<T> {
    ttlMs: number;
    produce: () => Promise<T>;
    now?: () => number;
}

/**
 * One in-memory slot with single-flight refresh. Durability, where there is any, comes from
 * `seed()` being handed what a store already holds — the slot itself stays in memory so that a
 * database-less deployment behaves exactly as it always did. Callers decide whether to serve a
 * stale entry, which is what keeps the last good render on screen when GitHub rate-limits us.
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
        seed(value, fetchedAt) {
            if (entry !== null) return false;
            entry = { value, fetchedAt };
            return true;
        },
    };
}
