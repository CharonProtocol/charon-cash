import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
export interface RelayCapability {
    /** User opted out of relaying, accepting the privacy cost. */
    selfRelay: boolean;
    isSpl: boolean;
    /** From `/api/relayer/info`: false when the relayer has no Address Lookup Table. */
    splRelayAvailable: boolean;
}
export declare function canRelay(cap: RelayCapability): boolean;
export declare function withdrawalFee(args: {
    grossLamports: BN;
    withdrawalFeeRateBps: number;
    /** `/api/relayer/info.min_transact_fee_lamports`; 0 when self-relaying. */
    minRelayFeeLamports: BN;
    relay: boolean;
}): BN;
export declare function transferFee(args: {
    minRelayFeeLamports: BN;
    relay: boolean;
}): BN;
export declare function transferRecipient(args: {
    relay: boolean;
    wallet: PublicKey;
    feeRecipient: PublicKey;
}): PublicKey;
export declare function minEconomicWithdrawal(args: {
    withdrawalFeeRateBps: number;
    minRelayFeeLamports: BN;
    relay: boolean;
}): BN;
//# sourceMappingURL=relay-policy.d.ts.map