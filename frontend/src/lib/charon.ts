// Charon client for the dashboard, backed by privacy-cash-sdk (our backend,
// our program). Keeps the surface the dashboard was written against
// (generateClient, utxoByMint, sendSol, withdrawSpl, swap, ...) so the pages
// stay as they are; every call goes to the SDK.
import BN from "bn.js";
import type { PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import {
  PrivacyCashClient,
  WRAPPED_SOL_MINT,
  fetchRecipientKeys,
  fetchRelayerInfo,
  publishRecipientKeys,
  rememberUnlockSigner,
  setBackendUrl,
  unspentNotes,
} from "privacy-cash-sdk";

import { ensureBrowserProver } from "./browserProver";
import { BACKEND_URL } from "./config";
import { SUPPORTED_SPL_MINTS } from "../hooks/usePaymentTransaction";

export interface Signer {
  publicKey: PublicKey;
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
}

export type UtxoSummary = {
  totalAmount: BN;
  maxSingleTxAmount: BN;
};

/** Background note scan while the dashboard is open (new payments in). */
const SCAN_MS = 20_000;

export class CharonProtocol {
  readonly publicKey: PublicKey;
  utxoByMint = new Map<string, UtxoSummary>();
  private listeners = new Set<() => void>();
  private scanning: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private sdk: PrivacyCashClient;

  private constructor(sdk: PrivacyCashClient, publicKey: PublicKey) {
    this.sdk = sdk;
    this.publicKey = publicKey;
  }

  /**
   * Unlock the wallet's notes (one signature), enroll it for private receiving
   * on first use, and learn the backend's token pools (USDC per network).
   */
  static async generateClient({ owner }: { rpcUrl?: string; owner: Signer }) {
    setBackendUrl(BACKEND_URL);
    const info = await fetchRelayerInfo();
    for (const m of info.supportedMints) {
      const key = m.symbol?.toLowerCase();
      if (key && key in SUPPORTED_SPL_MINTS) {
        SUPPORTED_SPL_MINTS[key as keyof typeof SUPPORTED_SPL_MINTS] = m.mint;
      }
    }
    // the same wasm-arkworks prover as payroll: one multi-threaded worker on
    // all cores (cross-origin isolated page); the SDK's snarkjs if it can't start
    void ensureBrowserProver().catch(() => {});
    // the two unlock signatures are kept for this tab: a reload doesn't prompt
    const signer = rememberUnlockSigner(owner);
    const sdk = new PrivacyCashClient(signer);
    await sdk.init();
    await sdk.unlock();
    // enroll with the keys unlock just derived; the same signature links the
    // note-backup key: one prompt, once ever
    if (!(await fetchRecipientKeys(owner.publicKey))) await publishRecipientKeys(signer, sdk.receiveKeys(), sdk.backupKey());
    const client = new CharonProtocol(sdk, owner.publicKey);
    client.recalculateBalances();
    client.timer = setInterval(() => client.requestNoteScan(), SCAN_MS);
    return client;
  }

  /** Runs after the note totals change. */
  watchBalances(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  requestNoteScan() {
    void this.syncUtxos();
  }

  /** Scan the pools for new and spent notes (single-flight). */
  syncUtxos(): Promise<void> {
    this.scanning ??= this.sdk
      .refreshNotes()
      .then(() => this.recalculateBalances())
      .catch(() => {})
      .finally(() => {
        this.scanning = null;
      });
    return this.scanning;
  }

  async stopClient() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /** Deposit from the wallet straight into `recipientKey`'s private balance. */
  async sendSol(amountInLamports: number, recipientKey: string) {
    return this.done(await this.sdk.depositSOLTo(amountInLamports, recipientKey));
  }

  async sendSpl(amount: number, recipientKey: string, mintAddress: string) {
    return this.done(await this.sdk.depositSPLTo(mintAddress, amount, recipientKey));
  }

  /** Private balance -> own wallet (relayed, 0.25% fee out of the amount). */
  async withdrawSol(amountInLamports: number) {
    return this.done(await this.sdk.withdrawSOL(amountInLamports, this.publicKey, { relay: true }));
  }

  async withdrawSpl(amount: number, mintAddress: string) {
    return this.done(await this.sdk.withdrawSPL(mintAddress, amount, this.publicKey, { relay: true }));
  }

  /** Private balance -> another user's private balance (nothing public moves). */
  async shieldedTransferSol(amountInLamports: number, recipientKey: string) {
    return this.done(await this.sdk.transferNoteSOL(recipientKey, amountInLamports, { relay: true }));
  }

  async shieldedTransferSpl(amount: number, mintAddress: string, recipientKey: string) {
    return this.done(await this.sdk.transferNoteSPL(mintAddress, recipientKey, amount, { relay: true }));
  }

  /** Private SOL <-> SPL swap through Jupiter (mainnet). */
  async swap(fromMint: string, outMint: string, amountIn: number) {
    return this.done(await this.sdk.swap(fromMint, outMint, amountIn));
  }

  private done(result: { signature: string }) {
    this.recalculateBalances();
    this.requestNoteScan();
    return { signature: result.signature };
  }

  private recalculateBalances() {
    const byMint = new Map<string, bigint[]>();
    for (const n of unspentNotes(this.publicKey)) {
      const list = byMint.get(n.mintAddress) ?? [];
      list.push(BigInt(n.amount));
      byMint.set(n.mintAddress, list);
    }
    const next = new Map<string, UtxoSummary>();
    for (const [mint, amounts] of byMint) {
      amounts.sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
      const total = amounts.reduce((s, a) => s + a, 0n);
      // a spend takes at most two notes
      const maxSingle = (amounts[0] ?? 0n) + (amounts[1] ?? 0n);
      next.set(mint, { totalAmount: new BN(total.toString()), maxSingleTxAmount: new BN(maxSingle.toString()) });
    }
    if (!next.has(WRAPPED_SOL_MINT)) next.set(WRAPPED_SOL_MINT, { totalAmount: new BN(0), maxSingleTxAmount: new BN(0) });
    this.utxoByMint = next;
    for (const l of this.listeners) l();
  }
}
