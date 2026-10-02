import type { CharonProtocol } from 'charonprotocol-sdk';
export type TransactionStage = 'proof' | 'signing' | 'confirming';
export type PaymentKind = 'send' | 'transfer' | 'withdraw';
export type DashboardOperation = PaymentKind | 'swap' | 'payroll';
export type PaymentContext = {
  client: CharonProtocol | null;
  address?: string;
  connected: boolean;
  unlocking: boolean;
  limit: string;
  unlock: () => Promise<void>;
  refresh: () => void;
  observeProgress: (listener: ((stage: TransactionStage) => void) | null) => void;
  onBusyChange: (busy: boolean) => void;
  rpcUrl: string;
};
export type PaymentStatus = 'idle' | 'unlocking' | TransactionStage | 'success' | 'error';
