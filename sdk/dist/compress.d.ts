/** Raw G1 (x‖y, 64 bytes BE) → compressed (32 bytes). */
export declare function compressG1(raw: Uint8Array): Uint8Array;
/** Raw G2 (x1‖x0‖y1‖y0, 128 bytes BE) → compressed (64 bytes). Fp2 order is c1 first, then c0. */
export declare function compressG2(raw: Uint8Array): Uint8Array;
//# sourceMappingURL=compress.d.ts.map