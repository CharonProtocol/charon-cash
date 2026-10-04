import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react"
import { toast } from "sonner"
import { getMint } from "@solana/spl-token"
import { useConnection } from "@solana/wallet-adapter-react"
import { PublicKey } from "@solana/web3.js"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { GliderGroup } from "@/components/motion/Glider"
import { Ms } from "@/components/motion/ms"
import { Input } from "@/components/ui/input"
import { rawToHuman, shortHash } from "@/lib/format"
import { estimateTotals } from "@/lib/estimate"
import { validateDecimals } from "@/lib/parse"
import { fetchRecipientsBatch, fetchTreeState, splTreeKey } from "privacy-cash-sdk"
import type { Asset, ParsedFile, RunMode } from "@/lib/types"

const SOL_DECIMALS = 9

interface RecipientCheck {
  total: number
  registered: number
  unregistered: string[]
}

export type PlanParams = {
  mode: RunMode
  lanes: number
  asset: Asset | null
  canRun: boolean
  check: RecipientCheck | null
}

export type PlanReviewHandle = {
  /** runs the payroll if the plan is dispatchable; explains itself otherwise */
  dispatch: () => void
}

export const PlanReviewCard = forwardRef<
  PlanReviewHandle,
  {
    parsed: ParsedFile | null
    bps: number | null
    minTransferFee: number
    vaultSolRaw: bigint | null
    onRun: (asset: Asset, mode: RunMode, lanes: number) => void
    disabled: boolean
    onParamsChange?: (p: PlanParams) => void
  }
>(function PlanReviewCard(
  { parsed, bps, minTransferFee, vaultSolRaw, onRun, disabled, onParamsChange },
  ref,
) {
  const { connection } = useConnection()
  const [kind, setKind] = useState<"sol" | "spl">("sol")
  const [mint, setMint] = useState("")
  const [decimals, setDecimals] = useState<number | null>(null)
  const [mintError, setMintError] = useState<string | null>(null)
  const [mode, setMode] = useState<RunMode>("shielded")
  // Recommended lanes: small runs pay faster strictly serially (splits cost
  // more than they save below ~10 rows); big runs overlap chain latency
  // across chains, capped by the machine's cores. The user can always
  // override — the recommendation just preselects and is badged below.
  const cores = navigator.hardwareConcurrency || 4
  const rowCount = parsed?.entries.length ?? 0
  // Same list the picker renders — the recommendation must land on a real
  // button or the "rec" badge (and the preselection) silently disappears
  // (a 10-core M4 computed 5, which isn't offered). Options grow with the
  // machine: 12/16 on 8+ cores, 24/32 on 24+ — no manual config anywhere.
  const laneOptions = [
    1, 2, 3, 4, 6, 8,
    ...(cores >= 8 ? [12, 16] : []),
    ...(cores >= 24 ? [24, 32] : []),
  ]
  const rawRec =
    rowCount === 0 || rowCount < 10
      ? 2
      : rowCount < 50
        ? 4
        : Math.min(16, Math.max(4, Math.floor(cores / 2)))
  const recommendedLanes = laneOptions.reduce((a, b) =>
    Math.abs(b - rawRec) < Math.abs(a - rawRec) ? b : a,
  )
  const [lanes, setLanes] = useState(recommendedLanes)
  const [lanesTouched, setLanesTouched] = useState(false)
  const [recipientCheck, setRecipientCheck] = useState<RecipientCheck | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  // A new file means the previous recipient check no longer applies.
  useEffect(() => {
    setRecipientCheck(null)
    setCheckError(null)
  }, [parsed?.fileHash])

  // A new CSV re-arms the recommendation unless the user picked lanes by hand.
  useEffect(() => {
    if (!lanesTouched) setLanes(recommendedLanes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedLanes])

  const asset: Asset | null = useMemo(() => {
    if (kind === "sol") return { kind: "sol" }
    if (mint && decimals !== null) return { kind: "spl", mint, decimals }
    return null
  }, [kind, mint, decimals])

  const activeDecimals = kind === "sol" ? SOL_DECIMALS : decimals

  const decimalErrors =
    parsed && activeDecimals !== null ? validateDecimals(parsed.entries, activeDecimals) : []

  const resolveMint = async () => {
    setMintError(null)
    setDecimals(null)
    try {
      const m = new PublicKey(mint)
      const info = await getMint(connection, m)
      setDecimals(info.decimals)
      // Fail fast (spec: error matrix) if this mint has no initialized tree.
      try {
        await fetchTreeState(splTreeKey(m.toBase58()))
      } catch {
        setMintError(
          "this mint has no initialized merkle tree — ask the operator to initialize it (see README ops notes)",
        )
      }
    } catch (e) {
      setMintError(`cannot load mint: ${(e as Error).message}`)
    }
  }

  const totals = useMemo(
    () =>
      parsed && activeDecimals !== null && bps !== null
        ? estimateTotals(parsed, activeDecimals, bps, minTransferFee, mode, kind === "sol")
        : null,
    [parsed, activeDecimals, bps, kind, mode, minTransferFee],
  )

  const vaultBig = vaultSolRaw ?? 0n
  const shortfall =
    totals && kind === "sol" && totals.totalNet + totals.totalFees > vaultBig
      ? totals.totalNet + totals.totalFees - vaultBig
      : 0n

  const checkRecipients = async () => {
    if (!parsed) return
    setChecking(true)
    setCheckError(null)
    try {
      // One batch round trip per 90 wallets; the batch throws only on a
      // transport/5xx failure (falling back per-wallet preserves that), so a
      // null here is still a confirmed "not enrolled".
      const keys = await fetchRecipientsBatch(parsed.entries.map((e) => e.address))
      const unregistered = parsed.entries
        .map((e) => e.address)
        .filter((a) => !keys.get(a))
      setRecipientCheck({
        total: parsed.entries.length,
        registered: parsed.entries.length - unregistered.length,
        unregistered,
      })
    } catch (e) {
      setRecipientCheck(null)
      setCheckError(`could not verify recipients: ${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  const shieldedReady =
    mode === "public" ||
    (recipientCheck !== null && recipientCheck.unregistered.length === 0)

  const canRun =
    !!parsed && bps !== null && !!asset && !mintError && decimalErrors.length === 0 && !disabled && shieldedReady

  // The settlement bar reads this snapshot through its own ref — reporting via
  // callback keeps PlanReviewCard the single source of run-truth.
  useEffect(() => {
    onParamsChange?.({ mode, lanes, asset, canRun, check: recipientCheck })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, lanes, asset, canRun, recipientCheck])

  const dispatch = () => {
    if (!asset) return
    if (!canRun) {
      if (!parsed) toast.warning("Upload a batch ledger first — the matrix is empty.")
      else if (mode === "shielded" && recipientCheck && recipientCheck.unregistered.length > 0)
        toast.warning(`${recipientCheck.unregistered.length} recipient(s) haven't enabled private receiving yet.`)
      else if (mode === "shielded" && recipientCheck === null)
        toast.info("Verify recipients once before a shielded dispatch.")
      else if (mintError) toast.warning(mintError)
      else if (decimalErrors.length > 0) toast.warning("Some amounts exceed this asset's decimals.")
      else if (disabled) toast.info("Still syncing with the relayer — one moment.")
      return
    }
    if (kind === "spl" && mint && decimals !== null) {
      toast.info("First SPL run may ask for one extra one-time signature (lookup table setup).")
    }
    if (mode === "shielded") {
      toast.info("Private mode: each employee receives a note only they can spend.")
    }
    onRun(asset, mode, lanes)
  }

  useImperativeHandle(ref, () => ({ dispatch }))

  const estSeconds = rowCount > 0 ? Math.round(rowCount * 0.8) : 0
  const estLabel =
    estSeconds === 0
      ? "load a batch for an estimate"
      : estSeconds >= 90
        ? `~${Math.round(estSeconds / 60)} min for ${rowCount} payouts`
        : `~${estSeconds}s for ${rowCount} payouts`

  return (
    <Card className="card-lift specular h-fit">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2 space-y-0">
        <div className="flex items-center gap-3">
          <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-gold-line bg-gold-soft">
            <Ms name="tune" className="text-sm text-gold" />
          </span>
          <div>
            <CardTitle className="h-display text-base font-semibold tracking-tight">
              Execution Parameters
            </CardTitle>
            <CardDescription className="mt-0.5 text-xs">
              {kind === "sol" && totals
                ? shortfall > 0n
                  ? `Vault covers ${rawToHuman(vaultBig, SOL_DECIMALS)} SOL — dispatching signs one top-up of ${rawToHuman(shortfall, SOL_DECIMALS)} SOL.`
                  : `Vault covers the full ${rawToHuman(totals.totalNet + totals.totalFees, SOL_DECIMALS)} SOL — no deposit to sign.`
                : "Vault funds are spent first."}
            </CardDescription>
          </div>
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-ok-line bg-ok-soft px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider text-ok">
          <span className="size-1.5 rounded-full bg-ok" /> fast path ready
        </span>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* settlement asset */}
        <div className="space-y-2">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
            Settlement asset
          </div>
          {[
            { id: "sol" as const, title: "SOL Native Note", sub: "shielded merkle pool · v2 notes", on: kind === "sol", soon: false },
            { id: "spl" as const, title: "Custom SPL Token", sub: "any mint with an initialized tree", on: kind === "spl", soon: false },
          ].map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => { setKind(opt.id); setDecimals(null); setMintError(null) }}
              className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                opt.on
                  ? "border-gold-line bg-gold-soft/70 ring-1 ring-[color-mix(in_srgb,var(--gold-2)_30%,transparent)]"
                  : "border-line bg-panel hover:bg-panel-2"
              }`}
            >
              <Ms
                name={opt.id === "sol" ? "currency_exchange" : "token"}
                className={`text-base ${opt.on ? "text-gold" : "text-mute"}`}
              />
              <span className="flex-1">
                <span className="block text-sm font-medium">{opt.title}</span>
                <span className="block text-[11px] text-mute">{opt.sub}</span>
              </span>
              {opt.on && <Ms name="check_circle" className="text-base text-gold" />}
            </button>
          ))}
          <div className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 opacity-55">
            <Ms name="token" className="text-base text-mute" />
            <span className="flex-1">
              <span className="block text-sm font-medium">USDC / BONK direct</span>
              <span className="block text-[11px] text-mute">preset mints · soon</span>
            </span>
            <span className="rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-mute">
              soon
            </span>
          </div>
          {kind === "spl" && (
            <div className="space-y-2 rounded-xl border border-line bg-panel p-3">
              <div className="flex gap-2">
                <Input
                  value={mint}
                  onChange={(e) => { setMint(e.target.value); setDecimals(null); setMintError(null) }}
                  placeholder="Mint pubkey"
                  className="font-mono text-xs"
                />
                <Button variant="outline" size="sm" onClick={resolveMint} disabled={!mint}>
                  Load
                </Button>
              </div>
              {decimals !== null && (
                <p className="text-xs text-body-ink">decimals: {decimals}</p>
              )}
              {mintError && <p className="text-xs text-destructive">{mintError}</p>}
            </div>
          )}
        </div>

        {/* privacy mode */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
            <Ms name="enhanced_encryption" className="text-xs" /> Privacy mode
          </div>
          <GliderGroup
            className="flex rounded-xl border border-line bg-panel p-1"
            pillClassName="bg-card border border-line shadow-sm"
            itemClassName="flex-1 justify-center px-2 text-xs"
            value={mode}
            onChange={(m) => setMode(m)}
            items={[
              { id: "shielded" as const, label: "Private notes" },
              { id: "public" as const, label: "Direct (public)" },
            ]}
          />
          <p className="text-[11px] leading-relaxed text-body-ink">
            {mode === "shielded"
              ? "Amounts and recipients stay private. One signature funds the run — every payout goes out on its own, zero signatures from you."
              : "Sent straight from your wallet. Fast, but amounts and recipients are public on-chain, and you sign every payout."}
          </p>
        </div>

        {/* lanes */}
        <div className="space-y-2">
          <div className="flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
            <span>Parallel execution lanes</span>
            <span className="normal-case tracking-normal text-gold">{lanes} concurrent</span>
          </div>
          {/* Lanes are payout chains, not CPU threads — each spends most of its
              life waiting on chain landings while proofs queue through the
              shared prover pool. Options grow with the machine; the rec caps
              at 16 because past that landing + indexing, not proving, is the
              wall. */}
          <GliderGroup
            className="flex rounded-xl border border-line bg-panel p-1"
            pillClassName="bg-card border border-line shadow-sm"
            itemClassName="flex-1 justify-center whitespace-nowrap px-1 text-xs"
            value={String(lanes)}
            onChange={(v) => {
              setLanes(Number(v))
              setLanesTouched(true)
            }}
            items={laneOptions.map((l) => ({
              id: String(l),
              label: l === recommendedLanes ? `${l} ·rec` : String(l),
            }))}
          />
          <p className="flex items-center gap-1.5 text-[11px] text-body-ink">
            <Ms name="schedule" className="text-xs text-gold" />
            est. total completion: <span className="font-medium text-ink">{estLabel}</span>
            <span className="text-mute">(zero mempool collisions)</span>
          </p>
        </div>

        {/* relayer node status */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line bg-panel px-3.5 py-2.5">
          <span className="flex items-center gap-2 text-xs">
            <span
              className={`size-1.5 rounded-full ${bps === null ? "animate-pulse bg-muted-foreground/50" : bps ? "bg-ok" : "bg-critical"}`}
            />
            Relayer:{" "}
            <span className="font-medium">
              {bps === null ? "connecting…" : bps ? "online · queue clear" : "offline"}
            </span>
          </span>
          <span className="rounded border border-ok-line bg-ok-soft px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-ok">
            gasless prover
          </span>
        </div>

        {/* recipient verification (shielded only) */}
        {mode === "shielded" && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={checkRecipients} disabled={!parsed || checking}>
                {checking ? "Verifying…" : "Verify recipients"}
              </Button>
              {recipientCheck && (
                <span
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[9px] font-semibold uppercase tracking-wider ${
                    recipientCheck.unregistered.length === 0
                      ? "border border-ok-line bg-ok-soft text-ok"
                      : "border border-warn-line bg-warn-soft text-warn"
                  }`}
                >
                  <span className="size-1.5 rounded-full bg-current" />
                  {recipientCheck.unregistered.length === 0
                    ? "enrolled & attested"
                    : `${recipientCheck.registered}/${recipientCheck.total} enrolled`}
                </span>
              )}
            </div>
            {checkError && <p className="text-xs text-destructive">{checkError}</p>}
            {recipientCheck && recipientCheck.unregistered.length > 0 && (
              <div className="rounded-xl border border-warn-line bg-warn-soft/60 p-3">
                <p className="text-xs font-medium text-warn">
                  These employees have not enabled private receiving:
                </p>
                <ul className="mt-1 space-y-0.5">
                  {recipientCheck.unregistered.map((a) => (
                    <li key={a} className="font-mono text-xs text-body-ink">
                      {shortHash(a, 8, 6)}
                    </li>
                  ))}
                </ul>
                <p className="mt-1 text-[11px] text-body-ink">
                  Dispatch stays locked until every row is registered.
                </p>
              </div>
            )}
            {recipientCheck && recipientCheck.unregistered.length === 0 && (
              <p className="text-[11px] text-body-ink">
                Every employee can receive private notes.
              </p>
            )}
          </div>
        )}

        {decimalErrors.length > 0 && (
          <Alert variant="destructive">
            <AlertTitle>Amounts exceed this asset's decimals</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {decimalErrors.map((e, i) => <li key={i} className="font-mono text-xs">{e}</li>)}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  )
})
