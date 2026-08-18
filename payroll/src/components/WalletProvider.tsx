import { useMemo, type ReactNode } from "react"
import {
  ConnectionProvider,
  WalletProvider as SolanaWalletProvider,
} from "@solana/wallet-adapter-react"
import { WalletModalProvider, useWalletModal } from "@solana/wallet-adapter-react-ui"
import "@solana/wallet-adapter-react-ui/styles.css"

import { config } from "@/lib/config"

export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], [])
  return (
    <ConnectionProvider endpoint={config.get().rpcUrl} config={{ commitment: "confirmed" }}>
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
