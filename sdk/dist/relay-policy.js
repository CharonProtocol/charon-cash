import BN from "bn.js";
export function canRelay(cap) {
    if (cap.selfRelay)
        return false;
    return !cap.isSpl || cap.splRelayAvailable;
}
export function withdrawalFee(args) {
    const protocolFee = args.grossLamports
        .muln(args.withdrawalFeeRateBps)
        .addn(9_999)
        .divn(10_000);
    if (!args.relay)
        return protocolFee;
    return BN.max(protocolFee, args.minRelayFeeLamports);
}
export function transferFee(args) {
    return args.relay ? args.minRelayFeeLamports : new BN(0);
}
export function transferRecipient(args) {
    return args.relay ? args.feeRecipient : args.wallet;
}
export function minEconomicWithdrawal(args) {
    if (!args.relay)
        return new BN(1);
    return args.minRelayFeeLamports.addn(1);
}
