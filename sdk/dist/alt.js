import { AddressLookupTableAccount, AddressLookupTableProgram, PublicKey, SystemProgram, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, } from "@solana/web3.js";
import { SEED } from "./constants";
import { TOKEN_PROGRAM_ID, ATA_PROGRAM_ID, deriveSplTreeAccount, } from "./program";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { fetchAltAccount, fetchBlockhash, submitTransaction } from "./merkle";
const ALT_CACHE_KEY = "privacy-cash:alt-address";
export function envAltAddress() {
    try {
        const v = (typeof import.meta !== "undefined" &&
            import.meta.env?.VITE_ALT_ADDRESS) ||
            (typeof process !== "undefined" && process.env?.VITE_ALT_ADDRESS) ||
            null;
        return v ? new PublicKey(v) : null;
    }
    catch {
        return null;
    }
}
export function cachedAltAddress(wallet) {
    if (typeof localStorage === "undefined")
        return null;
    try {
        const key = wallet
            ? `${ALT_CACHE_KEY}:${wallet.toBase58()}`
            : ALT_CACHE_KEY;
        const v = localStorage.getItem(key);
        return v ? new PublicKey(v) : null;
    }
    catch {
        return null;
    }
}
export function cacheAltAddress(address, wallet) {
    if (typeof localStorage === "undefined")
        return;
    try {
        const key = wallet
            ? `${ALT_CACHE_KEY}:${wallet.toBase58()}`
            : ALT_CACHE_KEY;
        localStorage.setItem(key, address.toBase58());
    }
    catch {
        /* ignore */
    }
}
/** Static + mint-scoped addresses that compress well via an ALT. */
export function splAltAddresses(params) {
    const [globalConfig] = PublicKey.findProgramAddressSync([Buffer.from(SEED.GLOBAL_CONFIG)], params.programId);
    const [treeAccount] = deriveSplTreeAccount(params.programId, params.mint);
    const treeAta = getAssociatedTokenAddressSync(params.mint, globalConfig, true);
    const feeAta = getAssociatedTokenAddressSync(params.mint, params.feeRecipient, true);
    return dedupe([
        params.programId,
        globalConfig,
        treeAccount,
        treeAta,
        params.feeRecipient,
        feeAta,
        params.mint,
        SystemProgram.programId,
        TOKEN_PROGRAM_ID,
        ATA_PROGRAM_ID,
        ComputeBudgetProgram.programId,
    ]);
}
function dedupe(keys) {
    const seen = new Set();
    const out = [];
    for (const k of keys) {
        const s = k.toBase58();
        if (seen.has(s))
            continue;
        seen.add(s);
        out.push(k);
    }
    return out;
}
/** Fetch + deserialize an on-chain ALT via the backend (no client RPC). */
export async function fetchAlt(address) {
    const hex = await fetchAltAccount(address.toBase58());
    if (!hex)
        return null;
    const state = AddressLookupTableAccount.deserialize(Buffer.from(hex, "hex"));
    return new AddressLookupTableAccount({ key: address, state });
}
async function sendIx(signer, ixs) {
    const { blockhash } = await fetchBlockhash();
    const msg = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: blockhash,
        instructions: ixs,
    }).compileToV0Message();
    const tx = await signer.signTransaction(new VersionedTransaction(msg));
    return submitTransaction(tx.serialize());
}
/**
 * Ensure an ALT exists that contains the given addresses.
 * Prefers `VITE_ALT_ADDRESS` (read-only — may be owned by the CLI keypair).
 * Falls back to a per-wallet ALT in localStorage, creating/extending as needed.
 */
export async function ensureAlt(params) {
    const fromEnv = params.preferred ?? envAltAddress();
    if (fromEnv) {
        const existing = await fetchAlt(fromEnv);
        if (existing)
            return existing;
    }
    const cached = cachedAltAddress(params.signer.publicKey);
    if (cached) {
        const existing = await fetchAlt(cached);
        if (existing) {
            const have = new Set(existing.state.addresses.map((a) => a.toBase58()));
            const missing = params.addresses.filter((a) => !have.has(a.toBase58()));
            if (missing.length === 0)
                return existing;
            for (let i = 0; i < missing.length; i += 20) {
                const chunk = missing.slice(i, i + 20);
                const ix = AddressLookupTableProgram.extendLookupTable({
                    payer: params.signer.publicKey,
                    authority: params.signer.publicKey,
                    lookupTable: cached,
                    addresses: chunk,
                });
                await sendIx(params.signer, [ix]);
            }
            return waitForAltAddresses(cached, params.addresses);
        }
    }
    // Create a new ALT under the connected wallet.
    const { slot } = await fetchBlockhash();
    const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
        authority: params.signer.publicKey,
        payer: params.signer.publicKey,
        recentSlot: slot - 1,
    });
    await sendIx(params.signer, [createIx]);
    // sendIx() returns once the relayer has SUBMITTED the tx (status "submitted"),
    // not confirmed. Extending immediately races the create and fails with
    // "Lookup table owner should be the Address Lookup Table program", so wait for
    // the create to actually land on-chain before extending. Same reason we wait
    // after extend: the deposit tx resolves addresses from the ALT, so it must
    // hold all of them before we hand it back.
    await waitForAlt(altAddress);
    cacheAltAddress(altAddress, params.signer.publicKey);
    for (let i = 0; i < params.addresses.length; i += 20) {
        const chunk = params.addresses.slice(i, i + 20);
        const ix = AddressLookupTableProgram.extendLookupTable({
            payer: params.signer.publicKey,
            authority: params.signer.publicKey,
            lookupTable: altAddress,
            addresses: chunk,
        });
        await sendIx(params.signer, [ix]);
    }
    return waitForAltAddresses(altAddress, params.addresses);
}
/** Poll the on-chain ALT until it exists (the create has landed). */
async function waitForAlt(address, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const alt = await fetchAlt(address);
        if (alt)
            return alt;
        await sleep(500);
    }
    throw new Error(`ALT ${address.toBase58()} not found on-chain (timeout)`);
}
/**
 * Poll the on-chain ALT until it contains every wanted address (the extends have
 * landed). Guards both the create-then-extend and the cached-extend paths
 * against the submit-not-confirm race.
 */
async function waitForAltAddresses(address, wanted, timeoutMs = 20_000) {
    const want = new Set(wanted.map((a) => a.toBase58()));
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const alt = await fetchAlt(address);
        if (alt) {
            const have = new Set(alt.state.addresses.map((a) => a.toBase58()));
            if ([...want].every((w) => have.has(w)))
                return alt;
        }
        await sleep(500);
    }
    throw new Error(`ALT ${address.toBase58()} did not contain all addresses after extend (timeout)`);
}
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
