import BN from "bn.js"
import { PublicKey } from "@solana/web3.js"



export interface RelayCapability {
  /** User opted out of relaying, accepting the privacy cost. */
  selfRelay: boolean
  isSpl: boolean
  /** From `/api/relayer/info`: false when the relayer has no Address Lookup Table. */
  splRelayAvailable: boolean
}


export function canRelay(cap: RelayCapability): boolean {
  if (cap.selfRelay) return false
  return !cap.isSpl || cap.splRelayAvailable
}


export function withdrawalFee(args: {
  grossLamports: BN
  withdrawalFeeRateBps: number
  /** `/api/relayer/info.min_transact_fee_lamports`; 0 when self-relaying. */
  minRelayFeeLamports: BN
  relay: boolean
}): BN {
  const protocolFee = args.grossLamports
    .muln(args.withdrawalFeeRateBps)
    .addn(9_999)
    .divn(10_000)
  if (!args.relay) return protocolFee
  return BN.max(protocolFee, args.minRelayFeeLamports)
}


export function transferFee(args: {
  minRelayFeeLamports: BN
  relay: boolean
}): BN {
  return args.relay ? args.minRelayFeeLamports : new BN(0)
}


export function transferRecipient(args: {
  relay: boolean
  wallet: PublicKey
  feeRecipient: PublicKey
}): PublicKey {
  return args.relay ? args.feeRecipient : args.wallet
}


export function minEconomicWithdrawal(args: {
  withdrawalFeeRateBps: number
  minRelayFeeLamports: BN
  relay: boolean
}): BN {
  if (!args.relay) return new BN(1)
  return args.minRelayFeeLamports.addn(1)
}
