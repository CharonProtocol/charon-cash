import type { CharonProtocol } from 'charonprotocol-sdk';
export type TransactionStage = 'proof' | 'signing' | 'confirming';
export type PaymentKind = 'send' | 'transfer' | 'withdraw';
export type DashboardOperation = PaymentKind | 'swap' | 'payroll';
export type PaymentContext = {
  client: CharonProtocol | null;
  address?: string;
  connected: boolean;
  limit: string;
  refresh: () => void;
  observeProgress: (listener: ((stage: TransactionStage) => void) | null) => void;
  onBusyChange: (busy: boolean) => void;
};
export type PaymentStatus = 'idle' | TransactionStage | 'success' | 'error';
