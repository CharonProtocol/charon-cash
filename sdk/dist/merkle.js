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
/** Shim-signed atomic v1 swap. Does not use Phantom. */
export async function relaySwap(req) {
    const pack = (p) => ({
        proof_a: bytesToHex(p.proofA),
        proof_b: bytesToHex(p.proofB),
        proof_c: bytesToHex(p.proofC),
        root: bytesToHex(p.root),
        public_amount: bytesToHex(p.publicAmount),
        ext_data_hash: bytesToHex(p.extDataHash),
        input_nullifiers: p.inputNullifiers.map((n) => bytesToHex(n)),
        output_commitments: p.outputCommitments.map((n) => bytesToHex(n)),
    });
    const res = await fetch(getBackendUrl() + "/api/relayer/swap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            proof_in: pack(req.proofIn),
            proof_out: pack(req.proofOut),
            ext_amount_in: req.extAmountIn,
            ext_amount_out: req.extAmountOut,
            encrypted_output_in1: bytesToHex(req.encryptedOutputIn1),
            encrypted_output_in2: bytesToHex(req.encryptedOutputIn2),
            encrypted_output_out1: bytesToHex(req.encryptedOutputOut1),
            encrypted_output_out2: bytesToHex(req.encryptedOutputOut2),
            from_mint: req.fromMint,
            out_mint: req.outMint,
            route_data: bytesToHex(req.routeData),
            route_accounts: req.routeAccounts,
        }),
    });
    const json = await res.json();
    if (!res.ok)
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    if (!json.signature)
        throw new Error("relayer swap returned no signature");
    return json.signature;
}
/** Quote + swap-instructions via the backend shim (avoids browser CORS to Jupiter). */
export async function fetchJupiterRoute(req) {
    const res = await fetch(getBackendUrl() + "/api/jupiter/route", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            inputMint: req.inputMint,
            outputMint: req.outputMint,
            amount: String(req.amount),
            userPublicKey: req.userPublicKey,
            slippageBps: req.slippageBps ?? 100,
        }),
    });
    const json = await res.json();
    if (!res.ok)
        throw new Error(json.error?.message ?? `HTTP ${res.status}`);
    const data = json.data ?? json;
    const hex = String(data.route_data ?? data.routeData ?? "").replace(/^0x/i, "");
    if (!hex || hex.length % 2 !== 0)
        throw new Error("jupiter route returned no instruction data");
    const routeData = new Uint8Array(hex.length / 2);
    for (let i = 0; i < routeData.length; i++) {
        routeData[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    const accounts = (data.route_accounts ?? data.routeAccounts ?? []);
    return {
        minOut: String(data.minOut ?? data.min_out ?? data.otherAmountThreshold ?? ""),
        outAmount: String(data.outAmount ?? data.out_amount ?? ""),
        routeData,
        routeAccounts: accounts.map((a) => ({
            pubkey: a.pubkey,
            isWritable: !!(a.isWritable ?? a.is_writable),
        })),
    };
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
/** Hex (with or without 0x, 64 nybbles) or already-decimal field element → decimal. */
export function commitmentToDecimal(c) {
    const s = c.trim();
    if (s.startsWith("0x") || s.startsWith("0X"))
        return BigInt(s).toString();
    if (/^[0-9a-fA-F]{64}$/.test(s))
        return BigInt("0x" + s).toString();
    return s;
}
/** All tree commitments in leaf-index order (decimal field elements). */
export async function fetchTreeLeaves(treeKey) {
    const byIndex = new Map();
    let start = 0;
    let nextIndex = 0;
    while (true) {
        const page = await fetchUtxoRange(treeKey, start, start + 2_000);
        nextIndex = page.nextIndex;
        for (const u of page.utxos) {
            byIndex.set(u.leafIndex, commitmentToDecimal(u.commitment));
        }
        if (!page.hasMore)
            break;
        start = page.end;
    }
    const leaves = [];
    for (let i = 0; i < nextIndex; i++) {
        const c = byIndex.get(i);
        if (c === undefined) {
            throw new Error(`merkle indexer gap at leaf ${i} (have ${byIndex.size} of ${nextIndex})`);
        }
        leaves.push(c);
    }
    return leaves;
}
export async function registerPrivacyKeys(args) {
    const res = await fetch(getBackendUrl() + "/api/registration/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            wallet: args.wallet,
            spend_pubkey: args.spendPubkey,
            viewing_pubkey: args.viewingPubkeyHex,
        }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(text || `register failed HTTP ${res.status}`);
    }
}
export async function lookupPrivacyKeys(wallet) {
    const res = await fetch(getBackendUrl() + `/api/registration/lookup/${encodeURIComponent(wallet)}`);
    if (res.status === 404)
        return null;
    const text = await res.text();
    let data = null;
    try {
        data = text ? JSON.parse(text) : null;
    }
    catch {
        data = text;
    }
    if (!res.ok) {
        throw new Error(data?.error?.message ?? `HTTP ${res.status}`);
    }
    const spend = String(data?.spend_pubkey ?? data?.spendPubkey ?? "");
    const view = String(data?.viewing_pubkey ?? data?.viewingPubkey ?? "").replace(/^0x/i, "");
    if (!spend || !view)
        return null;
    if (!/^[0-9a-fA-F]{64}$/.test(view))
        return null;
    return { spendPubkey: spend, viewingPubkeyHex: view };
}
