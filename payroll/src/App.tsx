import { useCallback, useRef, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { totalBalance } from "privacy-cash-sdk"

import { HistoryCard } from "@/components/HistoryCard"
import { PlanReviewCard } from "@/components/PlanReviewCard"
import { RunProgressCard } from "@/components/RunProgressCard"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { UploadCard } from "@/components/UploadCard"
import { WalletBar } from "@/components/WalletBar"
import { useConnectWallet } from "@/components/WalletProvider"
import { usePayrollClient } from "@/hooks/usePayrollClient"
import { createEngine, type RunSnapshot } from "@/lib/engine"
import { failedEntriesOf, storageOk } from "@/lib/store"
import type { Asset, ParsedFile, RunMode, RunReceipt } from "@/lib/types"

export default function App() {
  const { open: openModal } = useConnectWallet()
  const { publicKey } = useWallet()
  const { client, ready, busy, error, vaultSolRaw, bps, minTransferFee, refreshVault } = usePayrollClient()
  const [storageWarn] = useState(() => !storageOk())

  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null)
  const [receipt, setReceipt] = useState<RunReceipt | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const engineRef = useRef<{ cancel: () => void } | null>(null)

  const startRun = useCallback(
    async (
      asset: Asset,
      entries = parsed?.entries,
      fileHash = parsed?.fileHash,
      mode: RunMode = "public",
    ) => {
      if (!client || !entries || !fileHash || bps === null) return
      setReceipt(null)
      setSnapshot({ phase: "funding", rows: entries.map((e) => ({ ...e, status: "queued" as const, attempts: 0 })) })
      const engine = createEngine(client)
      engineRef.current = engine
      try {
        let vaultRaw = vaultSolRaw ?? 0n
        if (asset.kind === "spl") {
          await client.syncNotes(asset.mint)
          vaultRaw = totalBalance(client.publicKey, asset.mint)
        }
        const r = await engine.run(
          { fileHash, asset, entries, bps, vaultRaw, mode, minTransferFee },
          setSnapshot,
        )
        await refreshVault()
        setReceipt(r)
        if (r.summary.failed > 0) toast.warning(`${r.summary.failed} payout(s) failed — resume available`)
        else toast.success("Payroll run complete")
      } catch (e) {
        toast.error(`Run crashed: ${(e as Error).message}`)
        setSnapshot(null)
      }
    },
    [client, parsed, bps, minTransferFee, vaultSolRaw, refreshVault],
  )

  const resumeFailed = useCallback(
    (r: RunReceipt) => {
      const entries = failedEntriesOf(r)
      if (!entries.length) return
      setParsed({ entries, fileHash: r.fileHash })
      startRun(r.asset, entries, r.fileHash, r.mode)
    },
    [startRun],
  )

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <h1 className="text-2xl font-semibold">Privacy Payroll</h1>
      <WalletBar vaultSolRaw={vaultSolRaw} relayerOk={bps !== null} onOpenSettings={() => setSettingsOpen(true)} />

      {error && <p className="text-sm text-destructive">{error}</p>}
      {storageWarn && (
        <p className="text-sm text-muted-foreground">
          Browser storage is unavailable — runs will work but receipts won't persist.
        </p>
      )}

      {!publicKey ? (
        <button className="w-full rounded-lg border p-6 text-center" onClick={openModal}>
          Connect the treasury wallet to begin
        </button>
      ) : busy ? (
        <p className="text-sm text-muted-foreground">Unlocking vault… (approve the signature request)</p>
      ) : (
        <>
          <UploadCard onParsed={setParsed} />
          <PlanReviewCard
            parsed={parsed}
            bps={bps}
            minTransferFee={minTransferFee}
            vaultSolRaw={vaultSolRaw}
            disabled={!ready}
            onRun={(asset, mode) => startRun(asset, undefined, undefined, mode)}
          />
          <RunProgressCard
            snapshot={snapshot}
            receipt={receipt}
            onCancel={() => engineRef.current?.cancel()}
            onDone={() => { setSnapshot(null); setReceipt(null); setParsed(null) }}
            onResumeFailed={() => receipt && resumeFailed(receipt)}
          />
        </>
      )}

      <HistoryCard onResumeFailed={resumeFailed} />
      {settingsOpen && <SettingsDrawer onClose={() => setSettingsOpen(false)} />}
    </main>
  )
}
