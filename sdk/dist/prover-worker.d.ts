export type ProverRequest = {
    id: number;
    type: "init";
    circuitBaseUrl: string;
    threads?: number;
} | {
    id: number;
    type: "prove";
    circuitBaseUrl: string;
    threads?: number;
    input: string;
};
/** `init` answers with `{ threads, threadError? }` JSON as `result`; `prove` with the proof JSON. */
export type ProverResponse = {
    id: number;
    ok: true;
    result?: string;
} | {
    id: number;
    ok: false;
    error: string;
};
//# sourceMappingURL=prover-worker.d.ts.map