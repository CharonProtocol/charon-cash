interface ImportMetaEnv {
  VITE_BACKEND_URL?: string
  VITE_SOLANA_RPC_URL?: string
  VITE_PROGRAM_ID?: string
  VITE_ALT_ADDRESS?: string
  VITE_FEE_RECIPIENT?: string
  VITE_SUPPORTED_SPL_MINTS?: string
  VITE_STORAGE_NAMESPACE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "ffjavascript" {
  export const utils: any
}
