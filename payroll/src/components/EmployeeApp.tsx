import { useMemo, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { Copy, ShieldCheck } from "lucide-react"
import { publishRecipientKeys } from "privacy-cash-sdk"

import { Ms } from "@/components/motion/ms"
import { CountUp } from "@/components/motion/CountUp"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { ConnectGate } from "@/components/ConnectGate"
import { useEmployeeClient } from "@/hooks/useEmployeeClient"
import { lamportsToSol, shortHash, solToLamports } from "@/lib/format"

type ClaimRecord = { sig: string; sol: string; at: number }

export function EmployeeApp() {
  const { publicKey, signMessage, signTransaction } = useWallet()
  const {
    connected,
    client,
    busy,
    error,
    registered,
    noteSolRaw,
    walletSolRaw,
    bps,
    minFee,
    rescan,
    notes,
  } = useEmployeeClient()

  const [claimSol, setClaimSol] = useState("")
  const [claiming, setClaiming] = useState(false)
  const [claimingNote, setClaimingNote] = useState<string | null>(null)
  const [enabling, setEnabling] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [history, setHistory] = useState<ClaimRecord[]>([])

  const noteRows = useMemo(() => notes(), [notes])
  const maxClaimSol = noteSolRaw !== null ? lamportsToSol(noteSolRaw.toString()) : 0
  const gross = BigInt(claimSol.trim() ? solToLamports(Number(claimSol) || 0) : 0)
  const fee = bps !== null ? BigInt(Math.max(minFee, Number((gross * BigInt(bps)) / 10000n))) : 0n
  const net = gross > fee ? gross - fee : 0n

  const selectedRaw = useMemo(
    () =>
      noteRows
        .filter((n) => selected.has(n.id))
        .reduce((s, n) => s + BigInt(n.amount), 0n),
    [noteRows, selected],
  )
  const selectedFee =
    bps !== null && selectedRaw > 0n
      ? BigInt(Math.max(minFee, Number((selectedRaw * BigInt(bps)) / 10000n)))
      : 0n
  const selectedNet = selectedRaw > selectedFee ? selectedRaw - selectedFee : 0n

  const enable = async () => {
    if (!publicKey || !signMessage || !signTransaction) return
    setEnabling(true)
    try {
      await publishRecipientKeys({ publicKey, signMessage, signTransaction })
      toast.success("Private receiving enabled")
      window.location.reload()
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
      const r = await client.withdrawSOL(Number(lamports), publicKey, { relay: true })
      toast.success(`Claimed ${lamportsToSol(r.recipientLamports).toFixed(6)} SOL`, { description: shortHash(r.signature, 10) })
      setHistory((h) => [{ sig: r.signature, sol: lamportsToSol(r.recipientLamports).toFixed(4), at: Date.now() }, ...h].slice(0, 8))
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
              <p className="mt-1 max-w-2xl text-sm text-body-ink">
                ECDH-encrypted salary notes waiting in the shielded pool - scan, select, and redeem
                gaslessly. Amounts are invisible to everyone but you.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
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
          <div data-stagger className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Claimable private notes"
              value={noteSolRaw === null ? <span className="text-mute">-</span> : <CountUp to={Number(lamportsToSol(noteSolRaw.toString()))} decimals={4} suffix=" SOL" />}
              dot="ok"
              dotLabel={noteRows.length > 0 ? `${noteRows.length} note${noteRows.length === 1 ? "" : "s"}` : "none yet"}
              sub="shielded state · unspent leaves"
            />
            <StatCard
              label="Wallet balance"
              value={walletSolRaw === null ? <span className="text-mute">-</span> : <CountUp to={Number(walletSolRaw) / 1e9} decimals={4} suffix=" SOL" />}
              dot="idle"
              dotLabel="public"
              sub="spendable now · visible on-chain"
            />
            <StatCard
              label="Gasless relayer"
              value={<CountUp to={100} suffix="%" />}
              dot="ok"
              dotLabel="sponsored"
              sub={bps !== null ? `fee ${(bps / 100).toFixed(2)}% · min ${lamportsToSol(minFee.toString())} SOL` : "checking relayer…"}
            />
            <StatCard
              label="ECDH key sync"
              value={registered ? "100%" : "-"}
              dot={registered ? "ok" : "wait"}
              dotLabel={registered ? "synced" : "pending"}
              sub="recipient keys published · Poseidon depth 32"
            />
          </div>

          {/* ── main grid ──────────────────────────────────────────────── */}
          <div data-stagger className="mt-6 grid gap-5 lg:grid-cols-12">
            {/* left column */}
            <div className="space-y-5 lg:col-span-8">
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
                          const sol = lamportsToSol(BigInt(n.amount).toString())
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
                                <span className="font-mono text-xs tabular-nums">{Number(sol).toFixed(6)} SOL</span>
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
                                      <Ms name="bolt" className="mr-1 text-xs text-gold" /> Claim gasless
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
                        {selectedRaw > 0n ? `${Number(lamportsToSol(selectedNet.toString())).toFixed(6)} SOL` : "-"}
                        {selectedRaw > 0n && (
                          <span className="ml-2 text-[11px] font-normal text-body-ink">
                            net of {Number(lamportsToSol(selectedFee.toString())).toFixed(6)} fee
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
                          ? `Redeem selected (${Number(lamportsToSol(selectedRaw.toString())).toFixed(4)} SOL)`
                          : "Select notes to redeem"}
                    </Button>
                  </div>
                  <div className="border-t border-line pt-3">
                    <div className="flex items-center gap-2">
                      <Input
                        value={claimSol}
                        onChange={(e) => setClaimSol(e.target.value)}
                        placeholder={`or a custom amount, up to ${maxClaimSol.toFixed(6)}`}
                        inputMode="decimal"
                        className="font-mono text-xs"
                      />
                      <Button variant="outline" size="sm" onClick={() => setClaimSol(maxClaimSol.toFixed(6))}>
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
                        ? `receive ${lamportsToSol(net.toString()).toFixed(6)} SOL · relayer fee ${lamportsToSol(fee.toString()).toFixed(6)} SOL`
                        : "Moves notes out of the shielded pool to your public balance."}
                    </p>
                  </div>
                </div>
              </Card>
            </div>

            {/* right rail */}
            <div className="space-y-5 lg:col-span-4">
              {/* stealth address manager */}
              <Card className="card-lift specular">
                <div className="flex items-center gap-3 border-b border-line px-5 py-4">
                  <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
                    <Ms name="fingerprint" className="text-sm text-gold" />
                  </span>
                  <div>
                    <div className="h-display text-base font-semibold tracking-tight">Stealth Address Manager</div>
                    <div className="text-[11px] text-mute">dual-key · derived from your wallet</div>
                  </div>
                </div>
                <div className="space-y-3 px-5 py-4">
                  <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3 py-2">
                    <span className="font-mono text-[10px] uppercase tracking-wider text-mute">Master pubkey</span>
                    <span className="flex items-center gap-1.5 font-mono text-xs">
                      {publicKey ? shortHash(publicKey.toBase58(), 6, 4) : "-"}
                      {publicKey && (
                        <button
                          type="button"
                          aria-label="Copy master pubkey"
                          onClick={() => {
                            void navigator.clipboard.writeText(publicKey.toBase58())
                            toast.success("Master pubkey copied")
                          }}
                        >
                          <Copy className="size-3 text-mute hover:text-foreground" />
                        </button>
                      )}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-body-ink">Ephemeral key rotation</span>
                    <span className="flex items-center gap-1.5 rounded-full border border-ok-line bg-ok-soft px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-ok">
                      <span className="size-1.5 rounded-full bg-ok" /> active
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed text-body-ink">
                    Receiving keys are derived deterministically from your wallet seed - same
                    wallet, same stealth identity, no rotation ceremony needed.
                  </p>
                </div>
              </Card>

              {/* ZK proof generator */}
              <Card className="card-lift specular">
                <div className="flex items-center gap-3 border-b border-line px-5 py-4">
                  <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
                    <Ms name="grid_goldenratio" className="text-sm text-gold" />
                  </span>
                  <div>
                    <div className="h-display text-base font-semibold tracking-tight">ZK Proof Generator</div>
                    <div className="text-[11px] text-mute">groth16 · BN254</div>
                  </div>
                </div>
                <div className="space-y-3 px-5 py-4">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-body-ink">Prover latency</span>
                    <span className="font-mono font-medium">~0.8s · on-device</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-body-ink">Runtime</span>
                    <span className="font-mono font-medium">browser WASM</span>
                  </div>
                  <div className="rounded-xl border border-line bg-panel p-3">
                    <p className="text-[11px] leading-relaxed text-body-ink">
                      <span className="font-medium text-ink">Zero L1 trace:</span> your claim is
                      authorized through the relay signature pool - the chain sees a relayer
                      broadcast, never you.
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
                          <span className="font-mono tabular-nums text-ok">+{h.sol} SOL</span>
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
