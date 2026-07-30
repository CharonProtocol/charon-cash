import { SOL_TREE_KEY } from "./constants";
// Backend URL is configurable; defaults to the Vite env var the frontend sets.
let BACKEND_URL = (import.meta.env?.VITE_BACKEND_URL ?? "").replace(/\/$/, "");
export function setBackendUrl(url) {
    BACKEND_URL = url.replace(/\/$/, "");
}
export function getBackendUrl() {
    return BACKEND_URL;
}
function u8ToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
}
export async function submitTransaction(serializedTx) {
    if (!BACKEND_URL) {
        throw new Error("backend URL not set — call setBackendUrl() or set VITE_BACKEND_URL");
    }
    const res = await fetch(BACKEND_URL + "/api/relayer/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction: u8ToHex(serializedTx) }),
    });
    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        }
        catch {
            data = text;
        }
    }
    if (!res.ok) {
        const err = data?.error;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    const payload = data;
    if (!payload?.signature) {
        throw new Error("relayer returned no signature");
    }
    if (payload.status &&
        payload.status !== "confirmed" &&
        payload.status !== "submitted") {
        throw new Error(`relayer status: ${payload.status}`);
    }
    return payload.signature;
}
export function bytesToHex(bytes) {
    let out = "0x";
    for (let i = 0; i < bytes.length; i++)
        out += bytes[i].toString(16).padStart(2, "0");
    return out;
}
function hexToDecimal(hex) {
    return BigInt(hex).toString();
}
/** Poseidon / Fr decimal string → 32-byte big-endian hex (no 0x). */
export function fieldToHex32(dec) {
    let hex = BigInt(dec).toString(16);
    if (hex.length % 2)
        hex = "0" + hex;
    return hex.padStart(64, "0");
}
async function getJson(path) {
    if (!BACKEND_URL) {
        throw new Error("backend URL not set — call setBackendUrl() or set VITE_BACKEND_URL");
    }
    const res = await fetch(BACKEND_URL + path);
    const text = await res.text();
    let data = null;
    if (text) {
        try {
            data = JSON.parse(text);
        }
        catch {
            data = text;
        }
    }
    if (!res.ok) {
        const err = data?.error;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    return data;
}
export async function fetchRelayerInfo() {
    const r = await getJson("/api/relayer/info");
    return {
        programId: r.program_id,
        feeRecipient: r.fee_recipient,
        withdrawalFeeRateBps: r.withdrawal_fee_rate_bps,
        feeErrorMarginBps: r.fee_error_margin_bps,
        supportedMints: (r.supported_mints ?? []).map((m) => ({
            mint: m.mint,
            feeAta: m.fee_ata,
        })),
    };
}
/** Latest blockhash + slot from the backend — no client RPC needed to build a tx. */
export async function fetchBlockhash() {
    const r = await getJson("/api/relayer/blockhash");
    return { blockhash: r.blockhash, slot: Number(r.slot) };
}
/** Raw Address Lookup Table account bytes (hex), or null if it doesn't exist. */
export async function fetchAltAccount(address) {
    const r = await getJson(`/api/relayer/alt/${encodeURIComponent(address)}`);
    return r.exists ? r.data_hex : null;
}
export async function fetchTreeState(treeKey) {
    const s = await getJson(`/api/merkle/${encodeURIComponent(treeKey)}`);
    return {
        nextLeafIndex: s.next_leaf_index,
        root: hexToDecimal("0x" + s.current_root),
        knownRoots: (s.known_roots ?? []).map((h) => hexToDecimal("0x" + h)),
    };
}
export async function fetchMerkleProof(treeKey, leafIndex) {
    const p = await getJson(`/api/merkle/${encodeURIComponent(treeKey)}/proof/${leafIndex}`);
    const raw = p.path_elements;
    const isNested = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]);
    const asHex = isNested
        ? raw.map((b) => bytesToHex(b))
        : raw;
    return {
        pathElements: asHex.map(hexToDecimal),
        pathIndices: p.path_indices,
    };
}
export async function isNullifierSpent(hashHex) {
    try {
        const r = await getJson(`/api/nullifier/${encodeURIComponent(hashHex)}`);
        return !!r.spent;
    }
    catch {
        return false;
    }
}
export async function fetchUtxoRange(treeKey, start, end) {
    const q = new URLSearchParams({
        tree_key: treeKey,
        start: String(start),
        end: String(end),
    });
    const r = await getJson(`/api/utxos/range?${q}`);
    return {
        treeKey: r.tree_key,
        start: r.start,
        end: r.end,
        total: Number(r.total),
        nextIndex: Number(r.next_index ?? r.total),
        hasMore: !!r.has_more,
        utxos: (r.utxos ?? []).map((u) => ({
            leafIndex: Number(u.leaf_index),
            commitment: u.commitment,
            encryptedOutputHex: u.encrypted_output_hex,
            signature: u.signature,
            slot: Number(u.slot),
        })),
    };
}
export async function checkEncryptedOutput(encryptedHex, treeKey) {
    const hex = encryptedHex.replace(/^0x/i, "").toLowerCase();
    const q = treeKey
        ? `?tree_key=${encodeURIComponent(treeKey)}`
        : "";
    const r = await getJson(`/api/utxos/check/${encodeURIComponent(hex)}${q}`);
    if (!r.exists)
        return { exists: false };
    return {
        exists: true,
        treeKey: r.tree_key,
        leafIndex: Number(r.leaf_index),
        commitment: r.commitment,
        signature: r.signature,
        slot: Number(r.slot),
    };
}
/** Poll until `next_leaf_index > minLeafIndex` (i.e. leaves through minLeafIndex exist). */
export async function waitForLeafIndex(treeKey, minLeafIndex, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 750;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await fetchTreeState(treeKey);
        if (last.nextLeafIndex > minLeafIndex)
            return last;
        await sleep(intervalMs);
    }
    throw new Error(`indexer timeout waiting for leaf ${minLeafIndex} on tree ${treeKey}` +
        (last ? ` (next=${last.nextLeafIndex})` : ""));
}
/** Poll until an encrypted output hex appears in the indexer. */
export async function waitForEncryptedOutput(encryptedHex, treeKey, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 750;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const r = await checkEncryptedOutput(encryptedHex, treeKey);
        if (r.exists)
            return r;
        await sleep(intervalMs);
    }
    throw new Error("indexer timeout waiting for encrypted output");
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
export function solTreeKey() {
    return SOL_TREE_KEY;
}
export function splTreeKey(mint) {
    return mint;
}
