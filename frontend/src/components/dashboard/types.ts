import type { CharonProtocol } from '../../lib/charon';
import type { Token } from './TokenIcon';
export type TransactionStage = 'proof' | 'signing' | 'confirming';
export type PaymentKind = 'send' | 'transfer' | 'withdraw' | 'swap';
export type DashboardOperation = PaymentKind | 'payroll';
export type PaymentContext = {
  client: CharonProtocol | null;
  address?: string;
  connected: boolean;
  limit: string;
  token: Token;
  onTokenChange: (token: Token) => void;
  available: string;
  paymentsBlocked: boolean;
  refresh: () => void;
  observeProgress: (listener: ((stage: TransactionStage) => void) | null) => void;
  onBusyChange: (busy: boolean) => void;
};
export type PaymentStatus = 'idle' | TransactionStage | 'success' | 'error';
