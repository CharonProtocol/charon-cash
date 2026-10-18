import { useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';

import { RPC_URL } from '../lib/config';
export function SolanaProviders({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [], []);
  return <ConnectionProvider endpoint={RPC_URL} config={{ commitment: 'confirmed' }}>
    <WalletProvider wallets={wallets} autoConnect><WalletModalProvider>{children}</WalletModalProvider></WalletProvider>
  </ConnectionProvider>;
}
