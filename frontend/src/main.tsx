import { createRoot } from 'react-dom/client';
import { Toaster } from 'sonner';
import './index.css';
import App from './App';
import { SolanaProviders } from './components/WalletProvider';

createRoot(document.getElementById('root')!).render(
  <SolanaProviders><App /><Toaster theme="dark" richColors position="bottom-right" /></SolanaProviders>,
);
