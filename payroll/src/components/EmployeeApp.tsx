import { useMemo, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Copy, ShieldCheck } from "lucide-react"

import { Ms } from "@/components/motion/ms"
import { CountUp } from "@/components/motion/CountUp"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ConnectGate } from "@/components/ConnectGate"
import { useEmployeeClient } from "@/hooks/useEmployeeClient"
import { assetDecimals, assetKey, assetSymbol, SOL_ASSET } from "@/lib/assets"
import { shortHash } from "@/lib/format"
import { toRaw } from "@/lib/parse"
import type { Asset } from "@/lib/types"

/** `amount` is already formatted with its symbol */
type ClaimRecord = { sig: string; amount: string; at: number }

export function EmployeeApp() {
  const { publicKey, signMessage, signTransaction } = useWallet()
  const {
    connected,
    client,
    busy,
    error,
    registered,
    enable: enableReceiving,
    noteRawOf,
    walletRawOf,
    tokens,
    bps,
    minFee,
    rescan,
    notes,
  } = useEmployeeClient()

  // SOL or a token pool (USDC); a pool that disappears falls back to SOL
  const [assetPick, setAssetPick] = useState<Asset>(SOL_ASSET)
  const asset = tokens.some((t) => assetKey(t) === assetKey(assetPick)) ? assetPick : SOL_ASSET
  const decimals = assetDecimals(asset)
  const symbol = assetSymbol(asset)
  /** human amount, `digits` decimals at most */
  const fmt = (raw: bigint, digits = 6) => (Number(raw) / 10 ** decimals).toFixed(Math.min(digits, decimals))
  // the relayer's minimum fee is lamports: token claims pay bps only
  const feeFloor = BigInt(asset.kind === "sol" ? minFee : 0)
  const feeOf = (gross: bigint) => {
    if (bps === null) return 0n
    const f = (gross * BigInt(bps)) / 10000n
    return f > feeFloor ? f : feeFloor
  }
  const noteRawNow = noteRawOf(asset)
  const walletRawNow = walletRawOf(asset)

  const [claimSol, setClaimSol] = useState("")
  const [claiming, setClaiming] = useState(false)
  const [claimingNote, setClaimingNote] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<ClaimRecord[]>([])

  const noteRows = useMemo(() => notes(asset), [notes, asset])
  const maxClaim = noteRawNow ?? 0n
  const gross = (() => {
    try {
      return claimSol.trim() ? toRaw(claimSol.trim(), decimals) : 0n
    } catch {
      return 0n
    }
  })()
  const fee = gross > 0n ? feeOf(gross) : 0n
  const net = gross > fee ? gross - fee : 0n

  const selectedRaw = useMemo(
    () =>
      noteRows
        .filter((n) => selected.has(n.id))
        .reduce((s, n) => s + BigInt(n.amount), 0n),
    [noteRows, selected],
  )
  const selectedFee = selectedRaw > 0n ? feeOf(selectedRaw) : 0n
  const selectedNet = selectedRaw > selectedFee ? selectedRaw - selectedFee : 0n

  const enable = async () => {
    if (!publicKey || !signMessage || !signTransaction) return
    setEnabling(true)
    try {
      await enableReceiving()
      toast.success("Private receiving enabled")
    } catch (e) {
      toast.error(`Could not enable: ${(e as Error).message}`)
    } finally {
      setEnabling(false)
    }
  }

  const claimTo = async (lamports: bigint, noteId?: string) => {
    if (!client || !publicKey || lamports <= 0n) return
    if (noteId) setClaimingNote(noteId)
    else setClaiming(true)
    try {
      const r =
        asset.kind === "sol"
          ? await client.withdrawSOL(Number(lamports), publicKey, { relay: true })
          : await client.withdrawSPL(asset.mint, Number(lamports), publicKey, { relay: true })
      const got = BigInt(r.recipientLamports)
      toast.success(`Claimed ${fmt(got)} ${symbol}`, { description: shortHash(r.signature, 10) })
      setHistory((h) => [{ sig: r.signature, amount: `${fmt(got, 4)} ${symbol}`, at: Date.now() }, ...h].slice(0, 8))
      setSelected(new Set())
      setClaimSol("")
      await rescan()
    } catch (e) {
      toast.error(`Claim failed: ${(e as Error).message}`)
    } finally {
      setClaiming(false)
      setClaimingNote(null)
    }
  }

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const allSelected = noteRows.length > 0 && selected.size === noteRows.length

  // One sign-in page: wallet connect + one-time stealth-key setup together —
  // never two stacked gates.
  if (!connected || registered === false) {
    return (
      <ConnectGate
        role="employee"
        footerAction={
          connected ? (
            <div className="text-center">
              <span className="mx-auto flex size-10 items-center justify-center rounded-xl border border-gold-line bg-card">
                <ShieldCheck className="size-4 text-gold" />
              </span>
              <p className="mt-2 text-sm font-semibold">Enable private receiving</p>
              <p className="mx-auto mt-1 max-w-sm text-xs text-body-ink">
                One-time setup publishes your stealth receiving keys - approve the signature
                requests. Until then, payouts arrive as normal public SOL transfers.
              </p>
              <Button className="btn-glow mt-3" onClick={enable} disabled={enabling}>
                {enabling ? "Waiting for signature…" : "Generate stealth keys"}
              </Button>
            </div>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pb-16 pt-6 sm:px-6 sm:pt-8 lg:px-10">
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      {busy && (
        <p className="mb-3 text-sm text-muted-foreground">Unlocking… (approve the signature request)</p>
      )}
      {registered === null ? null : (
        <>
          {/* ── header ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h1 className="h-display text-3xl tracking-[-0.02em] sm:text-4xl">
                Employee Shielded Note Claims
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {tokens.length > 0 && (
                <div role="group" aria-label="Asset" className="flex rounded-lg border border-line bg-card p-0.5">
                  {[SOL_ASSET, ...tokens].map((t) => (
                    <button
                      key={assetKey(t)}
                      type="button"
                      aria-pressed={assetKey(t) === assetKey(asset)}
                      onClick={() => {
                        setAssetPick(t)
                        setSelected(new Set())
                        setClaimSol("")
                      }}
                      className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold ${
                        assetKey(t) === assetKey(asset) ? "bg-gold-soft text-gold" : "text-mute hover:text-ink"
                      }`}
                    >
                      {assetSymbol(t)}
                    </button>
                  ))}
                </div>
              )}
              <Button variant="outline" size="sm" onClick={() => rescan()} disabled={busy}>
                <Ms name="radar" className="mr-1 text-sm text-gold" />
                Scan tree for new notes
              </Button>
              {publicKey && (
                <span className="flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 font-mono text-[11px] text-body-ink">
                  {shortHash(publicKey.toBase58())}
                  <button
                    type="button"
                    aria-label="Copy address"
                    onClick={() => {
                      void navigator.clipboard.writeText(publicKey.toBase58())
                      toast.success("Address copied")
                    }}
                  >
                    <Copy className="size-3 text-mute hover:text-foreground" />
                  </button>
                </span>
              )}
            </div>
          </div>

          {/* ── stat strip ─────────────────────────────────────────────── */}
          <div data-stagger className="mt-6 grid gap-4 sm:grid-cols-2">
            <StatCard
              label="Claimable private notes"
              value={noteRawNow === null ? <span className="text-mute">-</span> : <CountUp to={Number(noteRawNow) / 10 ** decimals} decimals={Math.min(4, decimals)} suffix={` ${symbol}`} />}
              dot="ok"
              dotLabel={noteRows.length > 0 ? `${noteRows.length} note${noteRows.length === 1 ? "" : "s"}` : "none yet"}
              sub="shielded state · unspent leaves"
            />
            <StatCard
              label="Wallet balance"
              value={walletRawNow === null ? <span className="text-mute">-</span> : <CountUp to={Number(walletRawNow) / 10 ** decimals} decimals={Math.min(4, decimals)} suffix={` ${symbol}`} />}
              dot="idle"
              dotLabel="public"
              sub="spendable now · visible on-chain"
            />
          </div>

          {/* ── main grid ──────────────────────────────────────────────── */}
          <div data-stagger className="mt-6 grid gap-5 lg:grid-cols-12">
            {/* left column */}
            <div className="space-y-5 lg:col-span-12">
              {/* unclaimed notes ledger */}
              <Card className="card-lift specular">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
                  <div className="flex items-center gap-3">
                    <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
                      <Ms name="receipt_long" className="text-sm text-gold" />
                    </span>
                    <div>
                      <div className="h-display text-base font-semibold tracking-tight">
                        Unclaimed Private Notes Ledger
                      </div>
                      <div className="text-[11px] text-mute">
                        tree scan: {noteRows.length} hit{noteRows.length === 1 ? "" : "s"} detected
                      </div>
                    </div>
                  </div>
                  {noteRows.length > 0 && (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-body-ink">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(noteRows.map((n) => n.id)) : new Set())
                        }
                        className="size-3.5 accent-[var(--gold)]"
                      />
                      Select all ({noteRows.length})
                    </label>
                  )}
                </div>
                {noteRows.length === 0 ? (
                  <div className="px-5 py-10 text-center">
                    <p className="text-sm font-medium">No private notes yet</p>
                    <p className="mx-auto mt-1 max-w-sm text-xs text-body-ink">
                      When your employer runs a shielded payroll, your notes appear here - hit
                      “Scan tree” after they confirm the run.
                    </p>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-sm">
                      <thead>
                        <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-[0.14em] text-mute">
                          <th className="w-8 px-4 py-2.5" />
                          <th className="px-3 py-2.5 font-medium">Note & leaf</th>
                          <th className="px-3 py-2.5 text-right font-medium">Shielded amount</th>
                          <th className="hidden px-3 py-2.5 font-medium sm:table-cell">Received</th>
                          <th className="px-5 py-2.5 text-right font-medium">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {noteRows.map((n) => {
                          return (
                            <tr
                              key={n.id}
                              className={`border-b border-line/60 transition-colors last:border-0 ${
                                selected.has(n.id) ? "bg-gold-soft/50" : "hover:bg-panel/60"
                              }`}
                            >
                              <td className="px-4 py-3">
                                <input
                                  type="checkbox"
                                  checked={selected.has(n.id)}
                                  onChange={() => toggle(n.id)}
                                  className="size-3.5 accent-[var(--gold)]"
                                />
                              </td>
                              <td className="px-3 py-3">
                                <span className="block font-mono text-xs">
                                  leaf #{n.index}
                                </span>
                                <span className="block text-[11px] text-mute">
                                  {new Date(n.createdAt).toLocaleDateString()}
                                </span>
                              </td>
                              <td className="px-3 py-3 text-right">
                                <span className="font-mono text-xs tabular-nums">{fmt(BigInt(n.amount))} {symbol}</span>
                                <span className="tag tag--priv ml-2">
                                  <Ms name="lock" className="text-[10px]" /> shielded
                                </span>
                              </td>
                              <td className="hidden px-3 py-3 text-xs text-body-ink sm:table-cell">
                                {new Date(n.createdAt).toLocaleTimeString()}
                              </td>
                              <td className="px-5 py-3 text-right">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={claimingNote !== null}
                                  onClick={() => claimTo(BigInt(n.amount), n.id)}
                                >
                                  {claimingNote === n.id ? (
                                    "Proving…"
                                  ) : (
                                    <>
                                      <Ms name="bolt" className="mr-1 text-xs text-gold" /> Claim
                                    </>
                                  )}
                                </Button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-5 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-mute">
                    merkle proofs verified client-side
                  </span>
                  <span className="flex items-center gap-1.5 rounded border border-line bg-panel px-2 py-0.5 font-mono text-[10px] text-body-ink">
                    <Ms name="memory" className="text-xs text-gold" /> client proof cache ready
                  </span>
                </div>
              </Card>

              {/* claim settlement parameters */}
              <Card className="card-lift specular">
                <div className="flex items-center gap-3 border-b border-line px-5 py-4">
                  <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
                    <Ms name="swap_vert" className="text-sm text-gold" />
                  </span>
                  <div>
                    <div className="h-display text-base font-semibold tracking-tight">
                      Claim Settlement Parameters
                    </div>
                    <div className="text-[11px] text-mute">zero-L1-trace circuit · relayer submits, you sign</div>
                  </div>
                </div>
                <div className="space-y-4 px-5 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3.5 py-2.5">
                    <span className="text-xs text-body-ink">
                      Destination:{" "}
                      <span className="font-mono text-ink">
                        {publicKey ? shortHash(publicKey.toBase58(), 8, 6) : "-"}
                      </span>{" "}
                      <span className="text-mute">(your connected wallet - a fresh keypair is maximally private)</span>
                    </span>
                    <span className="flex items-center gap-2 text-xs">
                      <span className={`size-1.5 rounded-full ${bps !== null ? "bg-ok" : "bg-critical"}`} />
                      relayer {bps !== null ? "online" : "offline"}
                    </span>
                  </div>
                  <div className="space-y-1.5 text-[11px] text-body-ink">
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked readOnly className="size-3 accent-[var(--gold)]" />
                      Spent notes are nullified in the Poseidon tree automatically (prevents double claims)
                    </label>
                    <label className="flex items-center gap-2">
                      <input type="checkbox" checked readOnly className="size-3 accent-[var(--gold)]" />
                      Withdrawal proof is generated inside this browser - zero secrets leave your device
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
                        Redeem selected
                      </div>
                      <div className="stat-number font-mono text-lg font-semibold tabular-nums">
                        {selectedRaw > 0n ? `${fmt(selectedNet)} ${symbol}` : "-"}
                        {selectedRaw > 0n && (
                          <span className="ml-2 text-[11px] font-normal text-body-ink">
                            net of {fmt(selectedFee)} fee
                          </span>
                        )}
                      </div>
                    </div>
                    <Button
                      size="lg"
                      className="btn-glow font-semibold active:scale-[0.98]"
                      disabled={claiming || claimingNote !== null || selectedRaw <= 0n || selectedNet <= 0n}
                      onClick={() => claimTo(selectedRaw)}
                    >
                      <Ms name="lock" className="mr-1.5 text-sm" />
                      {claiming
                        ? "Proving…"
                        : selectedRaw > 0n
                          ? `Redeem selected (${fmt(selectedRaw, 4)} ${symbol})`
                          : "Select notes to redeem"}
                    </Button>
                  </div>
                  <div className="border-t border-line pt-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={claimSol}
                        onChange={(e) => setClaimSol(e.target.value)}
                        placeholder={`or a custom amount, up to ${fmt(maxClaim)} ${symbol}`}
                        inputMode="decimal"
                        className="font-mono text-xs"
                      />
                      <Button variant="outline" size="sm" onClick={() => setClaimSol(fmt(maxClaim, decimals))}>
                        Max
                      </Button>
                      <Button
                        className="btn-glow"
                        size="sm"
                        onClick={() => claimTo(gross)}
                        disabled={claiming || claimingNote !== null || gross <= 0n || net <= 0n}
                      >
                        {claiming ? "Claiming…" : "Claim"}
                      </Button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-body-ink">
                      {gross > 0n
                        ? `receive ${fmt(net)} ${symbol} · relayer fee ${fmt(fee)} ${symbol}`
                        : "Moves notes out of the shielded pool to your public balance."}
                    </p>
                  </div>
                </div>
              </Card>

              {/* claim history */}
              <Card className="card-lift specular">
                <div className="flex items-center justify-between border-b border-line px-5 py-4">
                  <div className="h-display text-base font-semibold tracking-tight">Claim history</div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-mute">
                    this session
                  </span>
                </div>
                <div className="px-5 py-3">
                  {history.length === 0 ? (
                    <p className="py-4 text-center text-xs text-body-ink">
                      No claims yet this session - receipts land here as you redeem.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {history.map((h) => (
                        <div
                          key={h.sig}
                          className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-xs"
                        >
                          <span className="font-mono tabular-nums text-ok">+{h.amount}</span>
                          <span className="text-mute">{new Date(h.at).toLocaleTimeString()}</span>
                          <span className="font-mono text-mute">{shortHash(h.sig, 4, 4)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </Card>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  dot,
  dotLabel,
  sub,
}: {
  label: string
  value: React.ReactNode
  dot: "ok" | "wait" | "idle"
  dotLabel: string
  sub: string
}) {
  const dotCls = { ok: "bg-ok", wait: "bg-muted-foreground/50 animate-pulse", idle: "bg-zinc-400" }[dot]
  return (
    <Card className="card-lift specular p-4">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">{label}</span>
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-panel px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider text-body-ink">
          <span className={`size-1.5 rounded-full ${dotCls}`} />
          {dotLabel}
        </span>
      </div>
      <div className="stat-number mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      <p className="mt-1 truncate text-[11px] text-body-ink">{sub}</p>
    </Card>
  )
}
