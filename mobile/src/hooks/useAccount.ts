import { useCallback } from "react";
import { useBridge } from "../bridge/BridgeContext";
import { useWallet } from "../wallet/WalletProvider";
import { useApp } from "../store";
import { assetsFrom, type Asset } from "../lib/assets";
import { CLUSTER } from "../lib/config";
import { fetchSolBalance, fetchSplBalance } from "../lib/solana";
import type { Balances, DiagResult, StartResult } from "../lib/rpc";

/** Unlock + enroll, then keep private and wallet balances current. */
export function useAccount() {
  const { call } = useBridge();
  const { address } = useWallet();

  const loadWalletBalances = useCallback(
    async (assets: Asset[]) => {
      if (!address) return;
      const out: Record<string, string> = {};
      await Promise.all(
        assets.map(async (a) => {
          out[a.key] =
            a.key === "SOL"
              ? String(await fetchSolBalance(CLUSTER, address))
              : String((await fetchSplBalance(CLUSTER, address, a.key)).raw);
        }),
      );
      useApp.getState().setWalletBalances(out);
    },
    [address],
  );

  /** Scan for new and spent notes, then re-read every balance. */
  const refresh = useCallback(async () => {
    const st = useApp.getState();
    await call("refresh");
    st.setBalances(await call<Balances>("balances"));
    await loadWalletBalances(st.assets);
  }, [call, loadWalletBalances]);

  /** First load: one wallet approval for both unlock signatures (two more for a new user's enrollment). */
  const start = useCallback(async () => {
    const st = useApp.getState();
    st.setError(null);
    try {
      const diag = await call<DiagResult>("diag");
      if (!diag.reachable) {
        throw new Error("Can't reach the Charon network right now. Check your connection and try again.");
      }
      st.setBusy(true, "Approve the sign-in in your wallet");
      const r = await call<StartResult>("start");
      st.setAccount({ assets: assetsFrom(r.mints), feeBps: r.feeBps });
      st.setBusy(true, "Loading your private balance");
      await refresh();
    } catch (e: any) {
      const m = String(e?.message ?? e);
      st.setError(
        /declin|reject|cancel|abort/i.test(m)
          ? "The sign-in was declined in your wallet. Tap Try again to approve it."
          : /timed?\s*out/i.test(m)
            ? "Your wallet didn't answer. Open it, approve the request, then tap Try again."
            : m,
      );
    } finally {
      st.setBusy(false);
    }
  }, [call, refresh]);

  return { start, refresh };
}
