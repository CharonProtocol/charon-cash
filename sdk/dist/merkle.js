import { SOL_TREE_KEY, backendUrl } from "./constants";
// Backend URL override set by the host app via setBackendUrl(). When empty,
// getBackendUrl() falls back to the zero-config default in constants.backendUrl()
// (VITE_BACKEND_URL, or http://localhost:8080 if that is unset), so the SDK runs
// with no environment configuration at all.
let BACKEND_URL = "";
export function setBackendUrl(url) {
    BACKEND_URL = url.replace(/\/$/, "");
}
export function getBackendUrl() {
    return BACKEND_URL || backendUrl();
}
function u8ToHex(bytes) {
    let out = "";
    for (let i = 0; i < bytes.length; i++) {
        out += bytes[i].toString(16).padStart(2, "0");
    }
    return out;
}
export async function submitTransaction(serializedTx) {
    const res = await fetch(getBackendUrl() + "/api/relayer/submit", {
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
        payload.status !== "submitted" &&
        payload.status !== "ok") {
        throw new Error(`relayer status: ${payload.status}`);
    }
    return payload.signature;
}
/** Relayer-signed withdraw: POST proof fields; backend builds + signs + submits. */
export async function relayWithdraw(req) {
    const body = {
        kind: req.kind,
        proof_a: bytesToHex(req.proofA),
        proof_b: bytesToHex(req.proofB),
        proof_c: bytesToHex(req.proofC),
        root: bytesToHex(req.root),
        public_amount: bytesToHex(req.publicAmount),
        ext_data_hash: bytesToHex(req.extDataHash),
        input_nullifiers: req.inputNullifiers.map((n) => bytesToHex(n)),
        output_commitments: req.outputCommitments.map((n) => bytesToHex(n)),
        ext_amount: req.extAmount,
        fee: req.fee,
        encrypted_output1: bytesToHex(req.encryptedOutput1),
        encrypted_output2: bytesToHex(req.encryptedOutput2),
        recipient: req.recipient,
        mint: req.mint,
        recipient_owner: req.recipientOwner,
        alt_address: req.altAddress,
    };
    const res = await fetch(getBackendUrl() + "/api/relayer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
        payload.status !== "submitted" &&
        payload.status !== "ok") {
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
    const res = await fetch(getBackendUrl() + path);
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
async function postJson(path, body) {
    const res = await fetch(getBackendUrl() + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
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
    return data;
}
export async function fetchJupiterRoute(req) {
    return postJson("/api/jupiter/route", { ...req, slippageBps: req.slippageBps ?? 100 });
}
/** Relayer-signed private swap (instruction 7, v1 packet). */
export async function relaySwap(body) {
    const r = await postJson("/api/relayer/swap", body);
    if (!r?.signature)
        throw new Error("relayer swap returned no signature");
    return r;
}
export async function fetchRelayerInfo() {
    const r = await getJson("/api/relayer/info");
    return {
        programId: r.program_id,
        feeRecipient: r.fee_recipient,
        withdrawalFeeRateBps: r.withdrawal_fee_rate_bps,
        feeErrorMarginBps: r.fee_error_margin_bps,
        minTransferFee: r.min_transfer_fee ?? 0,
        supportedMints: (r.supported_mints ?? []).map((m) => ({
            mint: m.mint,
            feeAta: m.fee_ata,
            ...(m.alt ? { alt: m.alt } : {}),
            ...(typeof m.decimals === "number" ? { decimals: m.decimals } : {}),
            ...(m.symbol ? { symbol: m.symbol } : {}),
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
        root: hexToDecimal("0x" + p.root),
        nextLeafIndex: Number(p.next_leaf_index),
        pathElements: asHex.map(hexToDecimal),
        pathIndices: p.path_indices,
    };
}
/** Ask the relayer to sync the mirror now (throttled server-side). */
export async function kickIndexer() {
    await postJson("/api/indexer/kick", {}).catch(() => { });
}
/**
 * Root + N input paths from ONE backend read. The old convergence loop fetched
 * each input's proof separately; two requests straddling a mirror sync commit
 * disagreed on the root and burned the whole retry budget (the 15:05Z run lost
 * 28 rows × 3 attempts to exactly that). One snapshot makes the disagreement
 * structurally impossible. Returns null on 404 — the caller falls back to the
 * per-leaf loop against backends that predate this endpoint.
 */
export async function fetchMerkleSnapshot(treeKey, indexes) {
    if (indexes.length === 0) {
        return { root: "", nextLeafIndex: 0, proofs: [], missing: [] };
    }
    const q = indexes.map((i) => `idx=${i}`).join("&");
    const res = await fetch(getBackendUrl() + `/api/merkle/${encodeURIComponent(treeKey)}/snapshot?${q}`);
    // Older backend without the route → caller uses the legacy per-leaf loop.
    if (res.status === 404)
        return null;
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
    const r = data;
    const proofs = (r.proofs ?? []).map((p) => {
        const raw = p.path_elements;
        const isNested = Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0]);
        const asHex = isNested
            ? raw.map((b) => bytesToHex(b))
            : raw;
        return {
            root: hexToDecimal("0x" + p.root),
            nextLeafIndex: Number(p.next_leaf_index),
            pathElements: asHex.map(hexToDecimal),
            pathIndices: p.path_indices,
        };
    });
    return {
        root: hexToDecimal("0x" + r.current_root),
        nextLeafIndex: Number(r.next_leaf_index),
        proofs,
        missing: (r.missing ?? []).map(Number),
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
/**
 * Spent flags for many nullifiers in as few calls as possible: one batch
 * request per 90 (the scan otherwise paid a round trip per note — the slow
 * unlock and slow in-run sync passes). Input order is preserved.
 */
export async function nullifiersSpent(hashHexes) {
    const out = [];
    for (let i = 0; i < hashHexes.length; i += 90) {
        const chunk = hashHexes.slice(i, i + 90);
        // The batch endpoint 500s without CORS headers when the worker is
        // saturated (platform-level kills), and every failure used to fan out
        // into per-hex singular calls — hundreds of extra requests that made
        // the saturation worse. Retry the chunk in place instead.
        let r;
        let lastErr;
        for (let attempt = 0;; attempt++) {
            try {
                r = await postJson("/api/nullifiers/batch", { hashes: chunk });
                lastErr = undefined;
                break;
            }
            catch (e) {
                lastErr = e;
                if (attempt >= 2)
                    throw e;
                await new Promise((res) => setTimeout(res, 250 * (attempt + 1)));
            }
        }
        void lastErr;
        const results = r.results;
        if (!Array.isArray(results) || results.length !== chunk.length) {
            throw new Error("nullifier batch returned a mismatched result set");
        }
        for (const item of results)
            out.push(!!item.spent);
    }
    return out;
}
/** Spent flag plus the spending tx signature, when the relayer recorded one. */
export async function nullifierInfo(hashHex) {
    const r = await getJson(`/api/nullifier/${encodeURIComponent(hashHex)}`);
    return { spent: !!r.spent, signature: r.signature ?? undefined };
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
/**
 * Authoritative leaf index for a commitment (the relayer assigns indexes, so
 * the transfer path's own index is only a guess until the tx is indexed).
 * 404 while the tx is still landing — callers poll.
 */
export async function fetchCommitmentLeaf(commitmentHex, treeKey) {
    const hex = commitmentHex.replace(/^0x/i, "").toLowerCase();
    const r = await getJson(`/api/commitment/${encodeURIComponent(hex)}?tree_key=${encodeURIComponent(treeKey)}`);
    return {
        treeKey: r.tree_key,
        commitment: r.commitment,
        leafIndex: Number(r.leaf_index),
    };
}
/** Poll until `next_leaf_index > minLeafIndex` (i.e. leaves through minLeafIndex exist). */
export async function waitForLeafIndex(treeKey, minLeafIndex, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const intervalMs = opts.intervalMs ?? 750;
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        const prev = last?.nextLeafIndex;
        last = await fetchTreeState(treeKey);
        if (last.nextLeafIndex > minLeafIndex)
            return last;
        if (opts.kick && last.nextLeafIndex === prev) {
            // The mirror is stalled: reads are sync-free and the cron only walks
            // the chain once a minute, so ask the indexer to sync now instead of
            // idling out the waiting caller (the split fan-out paid up to 80s
            // here per wave). The backend throttle bounds repeat kicks.
            await postJson("/api/indexer/kick", {}).catch(() => { });
        }
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
