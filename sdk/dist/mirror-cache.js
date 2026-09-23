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
const DB_NAME = "privacy-cash-merkle";
const DB_VERSION = 1;
const CHUNK_STORE = "leafChunks";
/**
 * Leaves per stored record. Chunking is what makes an incremental sync cheap: a
 * sync that adds two leaves rewrites one small record instead of a multi-megabyte
 * array.
 */
const CHUNK_SIZE = 2_000;
function indexedDb() {
    try {
        if (typeof indexedDB !== "undefined")
            return indexedDB;
    }
    catch {
        /* not a browser (Node tests, SSR) */
    }
    return null;
}
/** True when leaves can be cached. Callers still work without it, just slower. */
export function mirrorCacheAvailable() {
    return indexedDb() !== null;
}
function openDb() {
    const factory = indexedDb();
    if (!factory)
        return Promise.reject(new Error("IndexedDB unavailable"));
    return new Promise((resolve, reject) => {
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(CHUNK_STORE)) {
                // Keyed by [treeKey, chunkIndex] so a range scan returns one tree's chunks
                // already in leaf order.
                db.createObjectStore(CHUNK_STORE);
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    });
}
/** Every chunk for one tree, in chunk-index order. */
function treeRange(treeKey) {
    return IDBKeyRange.bound([treeKey, 0], [treeKey, Number.MAX_SAFE_INTEGER]);
}
function awaitTransaction(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    });
}
/**
 * Cached leaves for a tree, in leaf-index order.
 *
 * Stops at the first gap rather than returning a sparse array: the caller inserts
 * these into a Merkle tree in sequence, and a hole would silently produce a tree
 * whose root matches nothing. Truncating just means more leaves get re-fetched.
 */
export async function loadCachedLeaves(treeKey) {
    if (!mirrorCacheAvailable())
        return [];
    let db;
    try {
        db = await openDb();
    }
    catch {
        return [];
    }
    try {
        const store = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE);
        // One cursor rather than a `get` per chunk: an IndexedDB transaction commits as
        // soon as the event loop runs dry, so awaiting between separate requests on the
        // same transaction would abort it. Advancing a cursor inside its own success
        // handler keeps a request outstanding the whole time.
        const request = store.openCursor(treeRange(treeKey));
        return await new Promise((resolve, reject) => {
            const leaves = [];
            let expected = 0;
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor)
                    return resolve(leaves);
                const [, chunk] = cursor.key;
                if (chunk !== expected)
                    return resolve(leaves); // gap: stop, don't skip
                const rows = cursor.value;
                leaves.push(...rows);
                if (rows.length < CHUNK_SIZE)
                    return resolve(leaves); // short chunk is the last
                expected++;
                cursor.continue();
            };
            request.onerror = () => reject(request.error ?? new Error("IndexedDB cursor failed"));
        });
    }
    catch {
        return [];
    }
    finally {
        db.close();
    }
}
/**
 * Persist `leaves` (the complete list from index 0), rewriting only the chunks at or
 * after `changedFrom`.
 *
 * Best-effort: a failed write costs a slower next sync, never correctness, so it
 * must not fail a spend.
 */
export async function saveCachedLeaves(treeKey, leaves, changedFrom = 0) {
    if (!mirrorCacheAvailable())
        return;
    let db;
    try {
        db = await openDb();
    }
    catch {
        return;
    }
    try {
        const tx = db.transaction(CHUNK_STORE, "readwrite");
        const store = tx.objectStore(CHUNK_STORE);
        const firstChunk = Math.floor(Math.max(0, changedFrom) / CHUNK_SIZE);
        const lastChunk = Math.max(firstChunk, Math.ceil(leaves.length / CHUNK_SIZE) - 1);
        for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
            const slice = leaves.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);
            if (slice.length === 0) {
                store.delete([treeKey, chunk]);
            }
            else {
                store.put(slice, [treeKey, chunk]);
            }
        }
        await awaitTransaction(tx);
    }
    catch {
        /* cache is an optimization; a spend must not fail because of it */
    }
    finally {
        db.close();
    }
}
/**
 * Drop a tree's cache. Called when the rebuilt root does not match, which means the
 * cached leaves are wrong and re-deriving from them would keep failing.
 */
export async function clearCachedLeaves(treeKey) {
    if (!mirrorCacheAvailable())
        return;
    let db;
    try {
        db = await openDb();
    }
    catch {
        return;
    }
    try {
        const tx = db.transaction(CHUNK_STORE, "readwrite");
        tx.objectStore(CHUNK_STORE).delete(treeRange(treeKey));
        await awaitTransaction(tx);
    }
    catch {
        /* nothing to do: a cache we cannot clear is one we will fail to validate again */
    }
    finally {
        db.close();
    }
}
export const MIRROR_CACHE_CHUNK_SIZE = CHUNK_SIZE;
