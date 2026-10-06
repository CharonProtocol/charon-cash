/**
 * Proving artifacts for the `transaction2` circuit: the snarkjs proving key
 * and the circom-witnesscalc witness graph. Both are public; what matters is
 * that the browser proves against exactly the key the on-chain verifier was
 * built from, so every byte is checked against the SHA-256 pinned below
 * (same values as `programs/privacy-cash/artifacts/circuits/SHA256SUMS`).
 */
export declare const CIRCUIT_ARTIFACTS: {
    readonly zkey: {
        readonly file: "transaction2.zkey";
        readonly sha256: "4aa7aa5c1c28ed1f00fee84f49c1686f53210fd999ef7c8db6cfcd298af4e693";
    };
    readonly graph: {
        readonly file: "transaction2.graph";
        readonly sha256: "addf378de65a18512ccb730c36ceb613c2e9671925748b208762de33290aca48";
    };
};
export declare const DEFAULT_CIRCUIT_BASE_URL = "/circuit/";
/**
 * The sdk ships the artifacts next to its build output (dist/circuits/, the
 * same place constants.ts points the snarkjs-era fetches at). Resolved
 * relative to this module so it works from source and from dist.
 */
export declare const SDK_CIRCUIT_BASE_URL: string;
export declare const CIRCUIT_CACHE_NAME = "privacy-cash-circuit-v1";
export interface CircuitArtifacts {
    zkey: Uint8Array;
    graph: Uint8Array;
}
/** Throws unless `bytes` hashes to the pinned value for `kind`. */
export declare function verifyArtifact(kind: keyof typeof CIRCUIT_ARTIFACTS, bytes: Uint8Array): Promise<void>;
/**
 * Fetches (or reads from Cache Storage) and verifies both artifacts.
 * First load is ~17 MB; later loads are served from the cache.
 */
export declare function loadCircuitArtifacts(baseUrl?: string): Promise<CircuitArtifacts>;
//# sourceMappingURL=circuit-artifacts.d.ts.map