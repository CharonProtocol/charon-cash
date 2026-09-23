
const DB_NAME = "privacy-cash-merkle"
const DB_VERSION = 1
const CHUNK_STORE = "leafChunks"

/**
 * Leaves per stored record.
 * sync that adds two leaves rewrites one small record 
 */
const CHUNK_SIZE = 2_000

function indexedDb(): IDBFactory | null {
  try {
    if (typeof indexedDB !== "undefined") return indexedDB
  } catch {
  }
  return null
}


export function mirrorCacheAvailable(): boolean {
  return indexedDb() !== null
}

function openDb(): Promise<IDBDatabase> {
  const factory = indexedDb()
  if (!factory) return Promise.reject(new Error("IndexedDB unavailable"))
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        // Keyed by [treeKey, chunkIndex] so a range scan returns one tree's chunks
        // already in leaf order.
        db.createObjectStore(CHUNK_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"))
  })
}


function treeRange(treeKey: string): IDBKeyRange {
  return IDBKeyRange.bound([treeKey, 0], [treeKey, Number.MAX_SAFE_INTEGER])
}

function awaitTransaction(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"))
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"))
  })
}


export async function loadCachedLeaves(treeKey: string): Promise<string[]> {
  if (!mirrorCacheAvailable()) return []
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return []
  }
  try {
    const store = db.transaction(CHUNK_STORE, "readonly").objectStore(CHUNK_STORE)
    const request = store.openCursor(treeRange(treeKey))
    return await new Promise<string[]>((resolve, reject) => {
      const leaves: string[] = []
      let expected = 0
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return resolve(leaves)
        const [, chunk] = cursor.key as [string, number]
        if (chunk !== expected) return resolve(leaves)
        const rows = cursor.value as string[]
        leaves.push(...rows)
        if (rows.length < CHUNK_SIZE) return resolve(leaves)
        expected++
        cursor.continue()
      }
      request.onerror = () =>
        reject(request.error ?? new Error("IndexedDB cursor failed"))
    })
  } catch {
    return []
  } finally {
    db.close()
  }
}


export async function saveCachedLeaves(
  treeKey: string,
  leaves: string[],
  changedFrom = 0,
): Promise<void> {
  if (!mirrorCacheAvailable()) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  try {
    const tx = db.transaction(CHUNK_STORE, "readwrite")
    const store = tx.objectStore(CHUNK_STORE)
    const firstChunk = Math.floor(Math.max(0, changedFrom) / CHUNK_SIZE)
    const lastChunk = Math.max(firstChunk, Math.ceil(leaves.length / CHUNK_SIZE) - 1)
    for (let chunk = firstChunk; chunk <= lastChunk; chunk++) {
      const slice = leaves.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE)
      if (slice.length === 0) {
        store.delete([treeKey, chunk])
      } else {
        store.put(slice, [treeKey, chunk])
      }
    }
    await awaitTransaction(tx)
  } catch {

  } finally {
    db.close()
  }
}

export async function clearCachedLeaves(treeKey: string): Promise<void> {
  if (!mirrorCacheAvailable()) return
  let db: IDBDatabase
  try {
    db = await openDb()
  } catch {
    return
  }
  try {
    const tx = db.transaction(CHUNK_STORE, "readwrite")
    tx.objectStore(CHUNK_STORE).delete(treeRange(treeKey))
    await awaitTransaction(tx)
  } catch {
  } finally {
    db.close()
  }
}

export const MIRROR_CACHE_CHUNK_SIZE = CHUNK_SIZE
