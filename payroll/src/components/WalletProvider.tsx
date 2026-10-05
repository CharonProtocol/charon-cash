import { useMemo, type ReactNode } from "react"
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react"
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui"
import "@solana/wallet-adapter-react-ui/styles.css"

import { config } from "@/lib/config"
import { DemoWalletAdapter } from "@/lib/demoWallet"

export function SolanaProviders({ children }: { children: ReactNode }) {
  // Dev-only burner wallet so the console is testable in a browser with no
  // wallet extension installed. Never ships in the prod bundle.
  const wallets = useMemo(
    () => (import.meta.env.DEV ? [new DemoWalletAdapter()] : []),
    [],
  )
  return (
    <ConnectionProvider endpoint={config.get().rpcUrl} config={{ commitment: "confirmed" }}>
      {/* autoConnect restores an explicitly-made connection across refreshes —
          a fresh browser still lands on the connect gate */}
      <SolanaWalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </SolanaWalletProvider>
    </ConnectionProvider>
  )
}

export function useConnectWallet() {
  const { setVisible } = useWalletModal()
  return { open: () => setVisible(true) }
}
