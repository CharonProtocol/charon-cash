/**
 * Proving artifacts for the `transaction2` circuit: the snarkjs proving key
 * and the circom-witnesscalc witness graph. Both are public; what matters is
 * that the browser proves against exactly the key the on-chain verifier was
 * built from, so every byte is checked against the SHA-256 pinned below
 * (same values as `programs/privacy-cash/artifacts/circuits/SHA256SUMS`).
 */
export const CIRCUIT_ARTIFACTS = {
    zkey: {
        file: "transaction2.zkey",
        sha256: "4aa7aa5c1c28ed1f00fee84f49c1686f53210fd999ef7c8db6cfcd298af4e693",
    },
    graph: {
        file: "transaction2.graph",
        sha256: "addf378de65a18512ccb730c36ceb613c2e9671925748b208762de33290aca48",
    },
};
export const DEFAULT_CIRCUIT_BASE_URL = "/circuit/";
export const CIRCUIT_CACHE_NAME = "privacy-cash-circuit-v1";
function toHex(buf) {
    const b = new Uint8Array(buf);
    let h = "";
    for (let i = 0; i < b.length; i++)
        h += b[i].toString(16).padStart(2, "0");
    return h;
}
async function sha256Hex(bytes) {
    return toHex(await crypto.subtle.digest("SHA-256", bytes));
}
/** Throws unless `bytes` hashes to the pinned value for `kind`. */
export async function verifyArtifact(kind, bytes) {
    const want = CIRCUIT_ARTIFACTS[kind].sha256;
    const got = await sha256Hex(bytes);
    if (got !== want) {
        throw new Error(`${CIRCUIT_ARTIFACTS[kind].file}: sha256 ${got} does not match pinned ${want}`);
    }
}
async function openCache() {
    try {
        return typeof caches === "undefined" ? null : await caches.open(CIRCUIT_CACHE_NAME);
    }
    catch {
        // Opaque origins and some private modes throw on Cache Storage.
        return null;
    }
}
async function loadOne(kind, baseUrl, cache) {
    const { file, sha256 } = CIRCUIT_ARTIFACTS[kind];
    const url = new URL(file, new URL(baseUrl, globalThis.location?.href)).toString();
    // Keyed by hash so a new artifact never reuses a stale entry.
    const key = `${url}?sha256=${sha256}`;
    const hit = await cache?.match(key);
    if (hit) {
        const bytes = new Uint8Array(await hit.arrayBuffer());
        if ((await sha256Hex(bytes)) === sha256)
            return bytes;
        await cache?.delete(key);
    }
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`fetch ${url} failed (${res.status})`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    await verifyArtifact(kind, bytes);
    await cache
        ?.put(key, new Response(bytes, { headers: { "content-type": "application/octet-stream" } }))
        .catch(() => { });
    return bytes;
}
/**
 * Fetches (or reads from Cache Storage) and verifies both artifacts.
 * First load is ~17 MB; later loads are served from the cache.
 */
export async function loadCircuitArtifacts(baseUrl = DEFAULT_CIRCUIT_BASE_URL) {
    const cache = await openCache();
    const [zkey, graph] = await Promise.all([
        loadOne("zkey", baseUrl, cache),
        loadOne("graph", baseUrl, cache),
    ]);
    return { zkey, graph };
}
