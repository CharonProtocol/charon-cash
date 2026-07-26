import { type ReactNode, useState } from "react"
import { toast } from "sonner"
import { Rocket } from "lucide-react"

import {
  operatorInitialize,
  operatorInitializeSpl,
  operatorUpdateConfig,
  operatorUpdateDepositLimit,
  OperatorError,
  type OperatorResponse,
} from "privacy-cash-sdk"

import { shortHash } from "@/lib/format"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  )
}

export function AdminCard({ onChanged }: { onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [last, setLast] = useState<OperatorResponse | null>(null)
  const [errCode, setErrCode] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)

  const [splMint, setSplMint] = useState("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  const [splMax, setSplMax] = useState("")
  const [withdrawalFee, setWithdrawalFee] = useState("")
  const [depositFee, setDepositFee] = useState("")
  const [feeMargin, setFeeMargin] = useState("")
  const [newLimit, setNewLimit] = useState("1000000000000")

  async function run(name: string, fn: () => Promise<OperatorResponse>) {
    setBusy(name)
    setErrCode(null)
    setErrMsg(null)
    setLast(null)
    try {
      const r = await fn()
      setLast(r)
      toast.success(`${name}: ${r.status}`, {
        description: shortHash(r.signature, 10, 8),
      })
      onChanged()
    } catch (e) {
      const code = e instanceof OperatorError ? e.code : "ERROR"
      const msg = (e as Error).message
      setErrCode(code)
      setErrMsg(msg)
      toast.error(`${name} failed: ${code}`, { description: msg })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="size-4" /> Admin
        </CardTitle>
        <CardDescription>
          Program setup &amp; fee config. These operator actions are signed and
          submitted by the backend.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Section title="Initialize SOL tree">
          <Button
            onClick={() => run("initialize", () => operatorInitialize())}
            disabled={!!busy}
          >
            {busy === "initialize" ? "Initializing…" : "Initialize"}
          </Button>
        </Section>

        <div className="border-t pt-4" />
        <Section title="Initialize SPL tree">
          <div className="space-y-1.5">
            <Label htmlFor="spl-mint">mint (base58)</Label>
            <Input
              id="spl-mint"
              value={splMint}
              onChange={(e) => setSplMint(e.target.value)}
              className="font-mono text-xs"
            />
            <Label htmlFor="spl-max">max deposit amount (optional, lamports)</Label>
            <Input
              id="spl-max"
              value={splMax}
              onChange={(e) => setSplMax(e.target.value)}
              inputMode="numeric"
            />
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              run("initialize-spl", () =>
                operatorInitializeSpl(
                  splMint.trim(),
                  splMax.trim() ? Number(splMax) : undefined,
                ),
              )
            }
            disabled={!!busy}
          >
            {busy === "initialize-spl" ? "Initializing…" : "Initialize SPL"}
          </Button>
        </Section>

        <div className="border-t pt-4" />
        <Section title="Update fee config (bps, fill the ones to change)">
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label htmlFor="dep-fee" className="text-[11px]">
                deposit
              </Label>
              <Input
                id="dep-fee"
                value={depositFee}
                onChange={(e) => setDepositFee(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="wdr-fee" className="text-[11px]">
                withdrawal
              </Label>
              <Input
                id="wdr-fee"
                value={withdrawalFee}
                onChange={(e) => setWithdrawalFee(e.target.value)}
                inputMode="numeric"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fee-margin" className="text-[11px]">
                error margin
              </Label>
              <Input
                id="fee-margin"
                value={feeMargin}
                onChange={(e) => setFeeMargin(e.target.value)}
                inputMode="numeric"
              />
            </div>
          </div>
          <Button
            variant="secondary"
            onClick={() =>
              run("update-config", () =>
                operatorUpdateConfig({
                  deposit_fee_rate: depositFee.trim() ? Number(depositFee) : undefined,
                  withdrawal_fee_rate: withdrawalFee.trim()
                    ? Number(withdrawalFee)
                    : undefined,
                  fee_error_margin: feeMargin.trim() ? Number(feeMargin) : undefined,
                }),
              )
            }
            disabled={!!busy}
          >
            {busy === "update-config" ? "Updating…" : "Update config"}
          </Button>
        </Section>

        <div className="border-t pt-4" />
        <Section title="Update SOL deposit limit (lamports)">
          <div className="flex gap-2">
            <Input
              value={newLimit}
              onChange={(e) => setNewLimit(e.target.value)}
              inputMode="numeric"
              className="font-mono"
            />
            <Button
              variant="secondary"
              onClick={() =>
                run("update-deposit-limit", () =>
                  operatorUpdateDepositLimit(Number(newLimit)),
                )
              }
              disabled={!!busy}
            >
              {busy === "update-deposit-limit" ? "…" : "Update"}
            </Button>
          </div>
        </Section>

        {last && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">last response</p>
            <JsonBlock value={last} />
          </div>
        )}
        {errCode && errMsg && <ErrorBlock code={errCode} message={errMsg} />}
      </CardContent>
    </Card>
  )
}
