import { PublicKey } from "@solana/web3.js";
import { WasmFactory } from "@lightprotocol/hasher.rs";
import { getBackendUrl } from "./merkle";
import { RECEIVE_SIGN_MESSAGE, SIGN_MESSAGE } from "./constants";
import { EncryptionService, Keypair } from "./crypto";
export const RECIPIENT_PUT_PREFIX = "privacy-cash-recipients-v1";
function b58(wallet) {
    return wallet instanceof PublicKey ? wallet.toBase58() : wallet;
}
/**
 * One-time enrollment for private receiving. The wallet signs three messages:
 * SIGN_MESSAGE (derives the existing note keypair, unchanged), RECEIVE_SIGN_MESSAGE
 * (derives the x25519 receive key), and the registry message binding wallet +
 * both pubkeys. The backend verifies the third signature before storing, so
 * nobody can overwrite someone else's keys.
 */
export async function publishRecipientKeys(signer) {
    const sig = await signer.signMessage(new TextEncoder().encode(SIGN_MESSAGE));
    const receiveSig = await signer.signMessage(new TextEncoder().encode(RECEIVE_SIGN_MESSAGE));
    const enc = new EncryptionService();
    enc.deriveFromSignature(sig, receiveSig);
    const wasm = await WasmFactory.getInstance();
    const notePubkey = new Keypair(enc.utxoPrivateKey, wasm).pubkey.toString();
    const encPubkey = Buffer.from(enc.getReceivePublicKey()).toString("hex");
    const wallet = signer.publicKey.toBase58();
    const message = `${RECIPIENT_PUT_PREFIX}\n${wallet}\n${notePubkey}\n${encPubkey}`;
    const registrySig = await signer.signMessage(new TextEncoder().encode(message));
    const res = await fetch(getBackendUrl() + "/api/recipients", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            wallet,
            note_pubkey: notePubkey,
            enc_pubkey: encPubkey,
            signature: Buffer.from(registrySig).toString("base64"),
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        let data = null;
        try {
            data = JSON.parse(text);
        }
        catch {
            data = text;
        }
        const err = data?.error;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    cache.set(wallet, { notePubkey, encPubkey });
    return { notePubkey, encPubkey };
}
const cache = new Map();
/** Registered receive keys for a wallet, or null when the wallet has not enrolled. */
export async function fetchRecipientKeys(wallet) {
    const key = b58(wallet);
    const hit = cache.get(key);
    if (hit)
        return hit;
    const res = await fetch(getBackendUrl() + "/api/recipients/" + encodeURIComponent(key));
    if (res.status === 404)
        return null;
    if (!res.ok) {
        const text = await res.text();
        let data = text;
        try {
            data = JSON.parse(text);
        }
        catch {
            data = text;
        }
        const err = data?.error;
        throw new Error(err?.message ?? `HTTP ${res.status}`);
    }
    const row = (await res.json());
    const keys = { notePubkey: row.note_pubkey, encPubkey: row.enc_pubkey };
    cache.set(key, keys);
    return keys;
}
