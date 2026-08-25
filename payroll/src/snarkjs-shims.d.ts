declare module "snarkjs" {
  interface SnarkProof {
    pi_a: string[]
    pi_b: string[][]
    pi_c: string[]
    protocol: string
    curve: string
  }
  export const groth16: {
    fullProve: (
      input: Record<string, unknown>,
      wasm: Uint8Array | ArrayBuffer | string,
      zkey: Uint8Array | ArrayBuffer | string,
      logger?: unknown,
      wtnsCalcOptions?: { singleThread?: boolean },
      proverOptions?: { singleThread?: boolean },
    ) => Promise<{ proof: SnarkProof; publicSignals: string[] }>
    verify: (
      vkey: unknown,
      publicSignals: unknown,
      proof: unknown,
    ) => Promise<boolean>
  }
  export const wtns: {
    calculate: (
      input: Record<string, unknown>,
      wasm: string,
      wtnsPath: string,
    ) => Promise<void>
  }
  export const zKey: {
    exportVerificationKey: (zkeyPath: string) => Promise<unknown>
  }
}

declare module "ffjavascript" {
  export const utils: {
    leInt2Buff: (val: unknown, len: number) => Uint8Array
    unstringifyBigInts: (val: unknown) => unknown
    stringifyBigInts: (val: unknown) => unknown
  }
}
