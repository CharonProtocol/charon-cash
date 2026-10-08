interface ImportMetaEnv {
  VITE_BACKEND_URL?: string
  VITE_SOLANA_RPC_URL?: string
  VITE_PROGRAM_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "snarkjs" {
  export const groth16: any
}

declare module "ffjavascript" {
  export const utils: any
}
