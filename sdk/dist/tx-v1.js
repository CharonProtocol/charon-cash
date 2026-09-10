import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
/** SIMD-0385 v1 version prefix. */
export const V1_PREFIX = 0x81;
export const V1_MAX_SIZE = 4096;
export const V1_MAX_ACCOUNTS = 64;
const CONFIG_CU_LIMIT = 1 << 2;
const CONFIG_LOADED_ACCOUNTS = 1 << 3;
function keyEq(a, b) {
    return a.equals(b);
}
function orderAccounts(feePayer, instructions) {
    const map = new Map();
    const upsert = (pubkey, isSigner, isWritable) => {
        const k = pubkey.toBase58();
        const prev = map.get(k);
        if (!prev) {
            map.set(k, { pubkey, isSigner, isWritable });
            return;
        }
        prev.isSigner = prev.isSigner || isSigner;
        prev.isWritable = prev.isWritable || isWritable;
    };
    upsert(feePayer, true, true);
    for (const ix of instructions) {
        upsert(ix.programId, false, false);
        for (const m of ix.keys) {
            upsert(m.pubkey, m.isSigner, m.isWritable);
        }
    }
    const writableSigners = [];
    const readonlySigners = [];
    const writableUnsigned = [];
    const readonlyUnsigned = [];
    for (const acct of map.values()) {
        if (keyEq(acct.pubkey, feePayer))
            continue;
        if (acct.isSigner && acct.isWritable)
            writableSigners.push(acct);
        else if (acct.isSigner)
            readonlySigners.push(acct);
        else if (acct.isWritable)
            writableUnsigned.push(acct);
        else
            readonlyUnsigned.push(acct);
    }
    const fee = map.get(feePayer.toBase58());
    return [
        fee,
        ...writableSigners,
        ...readonlySigners,
        ...writableUnsigned,
        ...readonlyUnsigned,
    ];
}
function u32le(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}
function u16le(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
}
/** Compile an unsigned v1 transaction (signatures are appended by `signWireTransaction`). */
export function compileV1Transaction(params) {
    const accounts = orderAccounts(params.feePayer, params.instructions);
    if (accounts.length > V1_MAX_ACCOUNTS) {
        throw new Error(`v1 account cap exceeded (${accounts.length} > ${V1_MAX_ACCOUNTS}); constrain Jupiter maxAccounts`);
    }
    if (params.instructions.length > 64) {
        throw new Error("v1 instruction cap is 64");
    }
    const numRequiredSignatures = accounts.filter((a) => a.isSigner).length;
    const numReadonlySigned = accounts.filter((a) => a.isSigner && !a.isWritable).length;
    const numReadonlyUnsigned = accounts.filter((a) => !a.isSigner && !a.isWritable).length;
    const indexOf = (pk) => {
        const i = accounts.findIndex((a) => keyEq(a.pubkey, pk));
        if (i < 0)
            throw new Error(`account ${pk.toBase58()} missing from v1 message`);
        return i;
    };
    const cuLimit = params.computeUnitLimit ?? 1_400_000;
    const loaded = params.loadedAccountsDataSizeLimit ?? 64 * 1024 * 1024;
    const configMask = CONFIG_CU_LIMIT | CONFIG_LOADED_ACCOUNTS;
    const configValues = Buffer.concat([u32le(cuLimit), u32le(loaded)]);
    const blockhash = new PublicKey(params.blockhash).toBytes();
    const headers = [];
    const payloads = [];
    for (const ix of params.instructions) {
        const idxs = ix.keys.map((k) => indexOf(k.pubkey));
        const data = Buffer.from(ix.data);
        headers.push(Buffer.concat([
            Buffer.from([indexOf(ix.programId)]),
            Buffer.from([idxs.length]),
            u16le(data.length),
        ]));
        payloads.push(Buffer.concat([Buffer.from(idxs), data]));
    }
    const out = Buffer.concat([
        Buffer.from([V1_PREFIX]),
        Buffer.from([numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned]),
        u32le(configMask),
        Buffer.from(blockhash),
        Buffer.from([params.instructions.length, accounts.length]),
        ...accounts.map((a) => Buffer.from(a.pubkey.toBytes())),
        configValues,
        ...headers,
        ...payloads,
    ]);
    if (out.length + numRequiredSignatures * 64 > V1_MAX_SIZE) {
        throw new Error(`v1 transaction too large (${out.length + numRequiredSignatures * 64} > ${V1_MAX_SIZE})`);
    }
    return new Uint8Array(out);
}
/** Ed25519-sign a v1 message. Signatures are appended (SIMD-0385). */
export function signWireTransaction(message, secretKeys) {
    if (message.length === 0 || message[0] !== V1_PREFIX) {
        throw new Error("not a v1 transaction message");
    }
    const numRequiredSignatures = message[1] ?? 0;
    if (secretKeys.length < numRequiredSignatures) {
        throw new Error(`need ${numRequiredSignatures} signatures, got ${secretKeys.length}`);
    }
    const sigs = [];
    for (let i = 0; i < numRequiredSignatures; i++) {
        sigs.push(nacl.sign.detached(message, secretKeys[i]));
    }
    const out = new Uint8Array(message.length + numRequiredSignatures * 64);
    out.set(message, 0);
    for (let i = 0; i < numRequiredSignatures; i++) {
        out.set(sigs[i], message.length + i * 64);
    }
    return out;
}
export function v1SignedSize(message) {
    const n = message[1] ?? 0;
    return message.length + n * 64;
}
