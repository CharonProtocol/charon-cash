import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from "react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { RangeSlider } from "@/components/motion/range-slider"
import { Ms } from "@/components/motion/ms"
import { rawToHuman, shortHash } from "@/lib/format"
import { estimateTotals } from "@/lib/estimate"
import { validateDecimals } from "@/lib/parse"
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
    /** recipient registry check — owned by EmployerApp so the settlement bar
     *  can run the same verify step from its dispatch button */
    check: RecipientCheck | null
    onRun: (asset: Asset, mode: RunMode, lanes: number) => void
    disabled: boolean
    onParamsChange?: (p: PlanParams) => void
  }
>(function PlanReviewCard(
  { parsed, bps, minTransferFee, vaultSolRaw, check: recipientCheck, onRun, disabled, onParamsChange },
  ref,
) {
  // SOL is the only live settlement asset (USDC/USDT tiles are preview-only).
  const kind = "sol" as const
  // The app is private-only by design — no public mode, no toggle.
  const mode: RunMode = "shielded"
  // Recommended lanes: small runs pay faster strictly serially (splits cost
  // more than they save below ~10 rows); big runs overlap chain latency
  // across chains, capped by the machine's cores. The user can always
  // override — the recommendation just preselects and is badged below.
  const cores = navigator.hardwareConcurrency || 4
  const rowCount = parsed?.entries.length ?? 0
  // Same list the picker renders — the recommendation must land on a real
  // button or the "rec" badge (and the preselection) silently disappears
  // (a 10-core M4 computed 5, which isn't offered). Options grow with the
  // machine: 12 needs 12 cores, 16 needs 16, 24/32 need 24/32 — a 10-core
  // Mac tops out at 8 and never sees the high stops. No manual config.
  const laneOptions = [
    1, 2, 3, 4, 6, 8,
    ...(cores >= 12 ? [12] : []),
    ...(cores >= 16 ? [16] : []),
    ...(cores >= 24 ? [24] : []),
    ...(cores >= 32 ? [32] : []),
  ]
  const rawRec =
    rowCount === 0 || rowCount < 10
      ? 2
      : rowCount < 50
        ? 4
        : Math.min(8, Math.max(4, cores)) // 8 lanes measured fastest for 100 rows on 8 cores
  const recommendedLanes = laneOptions.reduce((a, b) =>
    Math.abs(b - rawRec) < Math.abs(a - rawRec) ? b : a,
  )
  const [lanes, setLanes] = useState(recommendedLanes)
  const [lanesTouched, setLanesTouched] = useState(false)

  // A new CSV re-arms the recommendation unless the user picked lanes by hand.
  useEffect(() => {
    if (!lanesTouched) setLanes(recommendedLanes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recommendedLanes])

  const asset: Asset = { kind: "sol" }

  const activeDecimals = SOL_DECIMALS

  const decimalErrors =
    parsed && activeDecimals !== null ? validateDecimals(parsed.entries, activeDecimals) : []

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

  // private-only app: dispatch needs every recipient enrolled
  const shieldedReady = recipientCheck !== null && recipientCheck.unregistered.length === 0

  const canRun =
    !!parsed && bps !== null && !disabled && shieldedReady && decimalErrors.length === 0

  // The settlement bar reads this snapshot through its own ref — reporting via
  // callback keeps PlanReviewCard the single source of run-truth.
  useEffect(() => {
    onParamsChange?.({ mode, lanes, asset, canRun, check: recipientCheck })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, lanes, asset, canRun, recipientCheck])

  const dispatch = () => {
    if (!canRun) {
      if (!parsed) toast.warning("Upload a batch ledger first - the matrix is empty.")
      else if (recipientCheck && recipientCheck.unregistered.length > 0)
        toast.warning(`${recipientCheck.unregistered.length} recipient(s) haven't enabled private receiving yet.`)
      else if (recipientCheck === null)
        toast.info("Verify recipients once before a shielded dispatch.")
      else if (decimalErrors.length > 0) toast.warning("Some amounts exceed this asset's decimals.")
      else if (disabled) toast.info("Still syncing with the relayer - one moment.")
      return
    }
    toast.info("Private dispatch: each employee receives a note only they can spend.")
    onRun(asset, mode, lanes)
  }

  useImperativeHandle(ref, () => ({ dispatch }))

  // Proving overlaps across lanes; the relayer submit/confirm pipeline stays
  // roughly serial (~0.6s per payout floor), so lanes help less as they grow.
  const estSeconds =
    rowCount > 0 ? Math.ceil((rowCount * 0.8) / lanes) + Math.round(rowCount * 0.6) : 0
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
                  ? `Vault covers ${rawToHuman(vaultBig, SOL_DECIMALS)} SOL - dispatching signs one top-up of ${rawToHuman(shortfall, SOL_DECIMALS)} SOL.`
                  : `Vault covers the full ${rawToHuman(totals.totalNet + totals.totalFees, SOL_DECIMALS)} SOL - no deposit to sign.`
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
          <button
            type="button"
            className={`flex w-full items-center gap-3 rounded-xl border border-gold-line bg-gold-soft/70 px-3.5 py-2.5 text-left ring-1 ring-[color-mix(in_srgb,var(--gold-2)_30%,transparent)] transition-all`}
          >
            <Ms name="currency_exchange" className="text-base text-gold" />
            <span className="flex-1">
              <span className="block text-sm font-medium">SOL Native Note</span>
              <span className="block text-[11px] text-mute">shielded merkle pool · v2 notes</span>
            </span>
            <Ms name="check_circle" className="text-base text-gold" />
          </button>
          {[
            { title: "USDC", sub: "stablecoin pool · preset mint" },
            { title: "USDT", sub: "stablecoin pool · preset mint" },
          ].map((opt) => (
            <div
              key={opt.title}
              className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-2.5 opacity-55"
            >
              <Ms name="token" className="text-base text-mute" />
              <span className="flex-1">
                <span className="block text-sm font-medium">{opt.title}</span>
                <span className="block text-[11px] text-mute">{opt.sub}</span>
              </span>
              <span className="rounded border border-line bg-card px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-mute">
                soon
              </span>
            </div>
          ))}
        </div>

        {/* lanes */}
        <div className="space-y-3">
          <div className="flex items-center justify-between font-mono text-[10px] font-semibold uppercase tracking-[0.16em] text-mute">
            <span>Parallel execution lanes</span>
            <span className="normal-case tracking-normal text-gold">{lanes} concurrent</span>
          </div>
          {/* Lanes are payout chains, not CPU threads - each spends most of its
              life waiting on chain landings while proofs queue through the
              shared prover pool. Stops only appear when the cores back them
              (12 on 12+ cores, 16 on 16+, 24/32 on 24/32+); the rec caps at
              8 because past that landing + indexing, not proving, is the
              wall. The slider walks the INDEX into laneOptions (uneven
              stops). */}
          <RangeSlider
            aria-label="Parallel execution lanes"
            min={0}
            max={laneOptions.length - 1}
            step={1}
            value={Math.max(0, laneOptions.indexOf(lanes))}
            onValueChange={(v) => {
              setLanes(laneOptions[v] ?? lanes)
              setLanesTouched(true)
            }}
            formatValueText={(v) => `${laneOptions[v] ?? lanes} parallel lanes`}
            showTicks
            className="mx-1"
          />
          <p className="text-[11px] text-body-ink">
            Recommended <span className="font-semibold text-gold">{recommendedLanes}</span> for
            this batch · {cores} cores detected
          </p>
          <p className="flex items-center gap-1.5 text-[11px] text-body-ink">
            <Ms name="schedule" className="text-xs text-gold" />
            est. total completion: <span className="font-medium text-ink">{estLabel}</span>
            <span className="text-mute">(zero mempool collisions)</span>
          </p>
        </div>

        {/* unregistered recipients - verify itself lives in the settlement bar */}
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
