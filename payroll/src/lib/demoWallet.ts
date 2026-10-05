import {
  BaseMessageSignerWalletAdapter,
  WalletNotConnectedError,
  WalletReadyState,
  type WalletName,
} from "@solana/wallet-adapter-base"
import { Keypair, Transaction, VersionedTransaction } from "@solana/web3.js"
import nacl from "tweetnacl"

export const DEMO_WALLET_NAME = "Demo Wallet" as WalletName<"Demo Wallet">

/**
 * Dev-only burner wallet: generates an in-memory keypair on connect so the
 * gated console is fully testable in a browser without any wallet extension.
 * Signatures are real ed25519 (signMessage via tweetnacl, transactions
 * partial-signed locally) but nothing is persisted — reload = fresh identity.
 * Registered only under import.meta.env.DEV in WalletProvider.
 */
export class DemoWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = DEMO_WALLET_NAME
  url = "https://charonpay.dev"
  icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='6' fill='%2315130f'/%3E%3Ccircle cx='12' cy='12' r='6' fill='%23dbc581'/%3E%3C/svg%3E"
  readonly readyState = WalletReadyState.Installed
  readonly supportedTransactionVersions = null

  private _keypair: Keypair | null = null
  private _connecting = false

  get publicKey() {
    return this._keypair?.publicKey ?? null
  }

  get connecting() {
    return this._connecting
  }

  async connect(): Promise<void> {
    if (this.connecting) return
    this._keypair ??= Keypair.generate()
    this.emit("connect", this._keypair.publicKey)
  }

  async disconnect(): Promise<void> {
    const had = this._keypair !== null
    this._keypair = null
    if (had) this.emit("disconnect")
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(transaction: T): Promise<T> {
    if (!this._keypair) throw new WalletNotConnectedError()
    if (transaction instanceof Transaction) {
      transaction.partialSign(this._keypair)
      return transaction
    }
    transaction.sign([this._keypair])
    return transaction
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this._keypair) throw new WalletNotConnectedError()
    return nacl.sign.detached(message, this._keypair.secretKey)
  }
}
