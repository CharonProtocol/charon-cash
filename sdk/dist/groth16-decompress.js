// Decompress arkworks-compressed Groth16 points (hex, BE, 32/64/32 bytes)
// back into the snarkjs decimal shape {pi_a, pi_b, pi_c} that
// parseProofToBytesArray consumes. The wasm prover emits compressed hex;
// this bridge lets the browser engine feed the existing proof pipeline
// unchanged.
//
// Correctness is self-checked: every decompressed point must satisfy its
// curve equation, and the whole conversion is validated end-to-end by
// `snarkjs groth16.verify` against the circuit's verifying key.
// BN254/alt_bn128 base field -- cross-checked against FQ_MODULUS_BE in
// programs/privacy-cash/src/groth16.rs (0x30644e72...d87cfd47). ark-bn254 0.6
// and snarkjs share this curve.
const P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
// BN254 G2 b = 1948...373 + 2669...690*u
const G2_B0 = 19485874751759354771024239261021720505790618469301721065564631296452457478373n;
const G2_B1 = 266929791119991161246907387137283842545076965332900288569378510910307636690n;
function hexToBytes(hex) {
    const h = hex.replace(/^0x/i, "");
    if (h.length % 2 !== 0)
        throw new Error("odd hex length");
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++)
        out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return out;
}
const fp2add = (a, b) => [(a[0] + b[0]) % P, (a[1] + b[1]) % P];
const fp2sub = (a, b) => [(a[0] - b[0] + P * 2n) % P, (a[1] - b[1] + P * 2n) % P];
const fp2mul = (a, b) => [
    (((a[0] * b[0] - a[1] * b[1]) % P) + P) % P,
    (((a[0] * b[1] + a[1] * b[0]) % P) + P) % P,
];
const fp2neg = (a) => [(P - a[0]) % P, (P - a[1]) % P];
const fp2square = (a) => fp2mul(a, a);
const fp2pow = (a, e) => {
    let r = [1n, 0n];
    for (const bit of e.toString(2)) {
        r = fp2square(r);
        if (bit === "1")
            r = fp2mul(r, a);
    }
    return r;
};
const fp2eq = (a, b) => a[0] === b[0] && a[1] === b[1];
const fp2isZero = (a) => a[0] === 0n && a[1] === 0n;
// ---- square roots ----
// p = ...d87cfd47 ends 0x7 -> p = 3 mod 4, so the (p+1)/4 shortcut is exact.
const fpPow = (v, e) => {
    let r = 1n;
    for (const bit of e.toString(2)) {
        r = (r * r) % P;
        if (bit === "1")
            r = (r * v) % P;
    }
    return r;
};
if (P % 4n !== 3n)
    throw new Error("expected p = 3 mod 4");
const HALF_PLUS = (P + 1n) / 4n;
// Euler shortcut: for p = 3 mod 4, y = v^((p+1)/4) is the sqrt of a QR v.
const fpSqrt = (v) => {
    v %= P;
    if (v === 0n)
        return 0n;
    const y = fpPow(v, HALF_PLUS);
    return (y * y) % P === v ? y : null;
};
// Tonelli-Shanks over Fp2* (order P^2-1). Fp2 is a field, TS applies directly.
// Returns y with y^2 == v, or null if v is not a square.
function fp2sqrt(v) {
    if (fp2isZero(v))
        return [0n, 0n];
    // factor P^2-1 = m * 2^s
    let s = 0n;
    let m = P * P - 1n;
    while (m % 2n === 0n) {
        m /= 2n;
        s++;
    }
    // find a non-residue z: in Fp2 (u^2=-1, p=1 mod 4), a+bu is a square iff
    // its norm a^2+b^2 is a QR in Fp, so screen by norm then confirm in Fp2.
    // Computed once and cached.
    const cache = fp2sqrt;
    if (!cache.z) {
        let z = null;
        outer: for (let b = 1n; b < 40n; b++) {
            for (let a = 0n; a < 40n; a++) {
                const norm = (a * a + b * b) % P;
                if (fpPow(norm, (P - 1n) / 2n) === 1n)
                    continue; // norm is a QR -> z is a square
                if (fp2eq(fp2pow([a, b], (P * P - 1n) / 2n), fp2neg([1n, 0n]))) {
                    z = [a, b];
                    break outer;
                }
            }
        }
        if (!z)
            throw new Error("no Fp2 non-residue found");
        cache.z = z;
    }
    const z = cache.z;
    let M = s;
    let c = fp2pow(z, m);
    let t = fp2pow(v, m);
    let R = fp2pow(v, (m + 1n) / 2n);
    while (!fp2eq(t, [1n, 0n])) {
        // least i with t^(2^i) == 1
        let i = 0n;
        let t2 = t;
        while (!fp2eq(t2, [1n, 0n])) {
            t2 = fp2square(t2);
            i++;
            if (i >= M)
                return null; // not a square
        }
        let b = c;
        for (let j = 0n; j < M - i - 1n; j++)
            b = fp2square(b);
        M = i;
        c = fp2square(b);
        t = fp2mul(t, c);
        R = fp2mul(R, b);
    }
    if (!fp2eq(fp2square(R), v))
        return null;
    return R;
}
// arkworks "lexicographically largest" sign for Fp2: c1 > -c1, tie -> c0 > -c0
const fp2IsLargest = (y) => {
    if (y[1] !== 0n)
        return y[1] * 2n > P;
    return y[0] * 2n > P;
};
// ---- point decompression from ark-compressed BE hex ----
// arkworks SWFlags: bit 0x80 = YIsNegative (y is the lexicographically larger
// root), bit 0x40 = PointAtInfinity. ark writes them into the top of the last
// LE byte; the v2 serializer byte-reverses to BE, so they land in byte 0.
export function decompressG1(hex) {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 32)
        throw new Error(`G1 compressed must be 32 bytes, got ${bytes.length}`);
    const inf = (bytes[0] & 0x40) !== 0;
    const sign = (bytes[0] & 0x80) !== 0;
    const xb = Uint8Array.from(bytes);
    xb[0] &= 0x3f;
    let x = 0n;
    for (const b of xb)
        x = (x << 8n) | BigInt(b);
    if (inf)
        return { x: 0n, y: 0n, inf: true };
    const y2 = ((((x * x) % P) * x + 3n) % P + P) % P;
    let y = fpSqrt(y2);
    if (y === null)
        throw new Error("G1 x is not on curve");
    const yNeg = P - y;
    const yLargest = y * 2n > P ? y : yNeg; // lexicographically largest G1 y = numerically larger
    y = sign ? yLargest : yLargest * 2n > P ? P - yLargest : yLargest;
    return { x, y, inf: false };
}
export function decompressG2(hex) {
    const bytes = hexToBytes(hex);
    if (bytes.length !== 64)
        throw new Error(`G2 compressed must be 64 bytes, got ${bytes.length}`);
    const inf = (bytes[0] & 0x40) !== 0;
    const sign = (bytes[0] & 0x80) !== 0;
    const xb = Uint8Array.from(bytes);
    xb[0] &= 0x3f;
    const readBE = (off) => {
        let v = 0n;
        for (let i = 0; i < 32; i++)
            v = (v << 8n) | BigInt(xb[off + i]);
        return v;
    };
    // ark serializes Fp2 as c0 (plain) then c1 (carrying the flags in its top
    // byte). The v2 serializer fully reverses the 64-byte stream, so the first
    // BE word is c1 (flags in byte 0) and the second is c0.
    const c1 = readBE(0);
    const c0 = readBE(32);
    if (inf)
        return { x: [0n, 0n], y: [0n, 0n], inf: true };
    const x = [c0, c1];
    // y^2 = x^3 + b over Fp2
    const x3 = fp2mul(fp2square(x), x);
    const y2 = fp2add(x3, [G2_B0, G2_B1]);
    let y = fp2sqrt(y2);
    if (y === null) {
        // encoding guess may have c0/c1 swapped -- retry swapped before giving up
        const xs = [c1, c0];
        const y2s = fp2add(fp2mul(fp2square(xs), xs), [G2_B0, G2_B1]);
        const ys = fp2sqrt(y2s);
        if (ys === null)
            throw new Error("G2 x is not on curve (both c0/c1 orders)");
        x[0] = xs[0];
        x[1] = xs[1];
        y = ys;
    }
    const yNeg = fp2neg(y);
    y = sign ? (fp2IsLargest(y) ? y : yNeg) : fp2IsLargest(y) ? yNeg : y;
    return { x: [x[0], x[1]], y: [y[0], y[1]], inf: false };
}
const dec = (v) => v.toString(10);
// Convert one CompressedProveResponse JSON string into the snarkjs-shaped
// Proof our parseProofToBytesArray consumes.
export function compressedToSnarkjs({ proof_a, proof_b, proof_c, public_signals }) {
    const A = decompressG1(proof_a);
    const B = decompressG2(proof_b);
    const C = decompressG1(proof_c);
    return {
        proof: {
            pi_a: [dec(A.x), dec(A.y), "1"],
            pi_b: [
                [dec(B.x[0]), dec(B.x[1])],
                [dec(B.y[0]), dec(B.y[1])],
                ["1", "0"],
            ],
            pi_c: [dec(C.x), dec(C.y), "1"],
            protocol: "groth16",
            curve: "bn128",
        },
        publicSignals: public_signals,
    };
}
