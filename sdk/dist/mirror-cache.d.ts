/**
 * IndexedDB cache for the local Merkle mirror.
 *
 * Spending requires a Merkle path, and the privacy-correct way to get one is to
 * download every leaf and build the tree locally, because that request is identical
 * for every caller and so reveals nothing about which leaf is yours. The obvious
 * "optimization" — asking the backend for the proof of one leaf — makes the request
 * itself the secret. See the note above `merkleForSpend` in `client.ts`.
 *
 * So the download stays, and this makes it cheap instead of selective. Leaves are
 * append-only and immutable once indexed, which is what allows a cache at all: after
 * the first sync every later one fetches only the delta and inserts it, which is
 * O(depth) per leaf.
 *
 * Nothing here is trusted. `client.ts` rebuilds the tree from the cached leaves and
 * checks the resulting root before using any path, so a stale or tampered cache is
 * detected and discarded rather than believed.
 */
/** True when leaves can be cached. Callers still work without it, just slower. */
export declare function mirrorCacheAvailable(): boolean;
/**
 * Cached leaves for a tree, in leaf-index order.
 *
 * Stops at the first gap rather than returning a sparse array: the caller inserts
 * these into a Merkle tree in sequence, and a hole would silently produce a tree
 * whose root matches nothing. Truncating just means more leaves get re-fetched.
 */
export declare function loadCachedLeaves(treeKey: string): Promise<string[]>;
/**
 * Persist `leaves` (the complete list from index 0), rewriting only the chunks at or
 * after `changedFrom`.
 *
 * Best-effort: a failed write costs a slower next sync, never correctness, so it
 * must not fail a spend.
 */
export declare function saveCachedLeaves(treeKey: string, leaves: string[], changedFrom?: number): Promise<void>;
/**
 * Drop a tree's cache. Called when the rebuilt root does not match, which means the
 * cached leaves are wrong and re-deriving from them would keep failing.
 */
export declare function clearCachedLeaves(treeKey: string): Promise<void>;
export declare const MIRROR_CACHE_CHUNK_SIZE = 2000;
//# sourceMappingURL=mirror-cache.d.ts.map