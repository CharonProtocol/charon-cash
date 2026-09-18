/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string
  readonly VITE_SOLANA_RPC_URL?: string
  readonly VITE_SOLANA_CLUSTER?: string
  readonly VITE_PROGRAM_ID?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
