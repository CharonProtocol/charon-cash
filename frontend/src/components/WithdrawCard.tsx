import { useEffect, useState } from "react"
import { useWallet } from "@solana/wallet-adapter-react"
import { toast } from "sonner"
import { WalletMinimal } from "lucide-react"

import { api, BackendError } from "@/lib/api"
import { solToLamports, shortHash } from "@/lib/format"
import {
  isClientSdkConnected,
  buildWithdrawRequest,
  parsePastedWithdrawRequest,
  ClientSdkNotConnectedError,
} from "@/lib/client-sdk"
import type { RelayResponse, WithdrawKind } from "@/lib/types"
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
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel"

export function WithdrawCard() {
  const { publicKey } = useWallet()
  const [kind, setKind] = useState<WithdrawKind>("sol")
  const [amount, setAmount] = useState("1.0")
  const [feeBps, setFeeBps] = useState("25")
  const [mint, setMint] = useState("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  const [recipient, setRecipient] = useState("")
  const [pasted, setPasted] = useState("")
  const [result, setResult] = useState<RelayResponse | null>(null)
  const [errCode, setErrCode] = useState<string | null>(null)
  const [errMsg, setErrMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (publicKey && !recipient) setRecipient(publicKey.toBase58())
  }, [publicKey, recipient])

  const extAmount = -Math.abs(solToLamports(Number(amount) || 0))
  const feeLamports = Math.round(
    (Math.abs(extAmount) * (Number(feeBps) || 0)) / 10_000,
  )

  const handleBuild = async () => {
    setBusy(true)
    setErrCode(null)
    setErrMsg(null)
    setResult(null)
    try {
      const req = await buildWithdrawRequest({
        kind,
        recipient,
        extAmount: Math.abs(extAmount),
        fee: feeLamports,
        mint: kind === "spl" ? mint : undefined,
      })
      setResult(await api.withdraw(req))
      toast.success("withdraw submitted", { description: "relayer signed & sent" })
    } catch (e) {
      if (e instanceof ClientSdkNotConnectedError) {
        setErrCode("CLIENT_SDK_NOT_CONNECTED")
        setErrMsg(e.message)
      } else {
        setErrCode(e instanceof BackendError ? e.code : "ERROR")
        setErrMsg(e instanceof BackendError ? e.message : (e as Error).message)
      }
    } finally {
      setBusy(false)
    }
  }

  const handlePasteSubmit = async () => {
    setBusy(true)
    setErrCode(null)
    setErrMsg(null)
    setResult(null)
    try {
      const req = parsePastedWithdrawRequest(pasted)
      const res = await api.withdraw(req)
      setResult(res)
      toast.success("withdraw submitted", { description: shortHash(res.signature, 8, 6) })
    } catch (e) {
      setErrCode(e instanceof BackendError ? e.code : "PROOF_INVALID")
      setErrMsg(e instanceof BackendError ? e.message : (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <WalletMinimal className="size-4" /> Withdraw
        </CardTitle>
        <CardDescription>
          Relayed withdrawal. The relayer signs + pays gas; funds land in the recipient.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert variant={isClientSdkConnected() ? "default" : "warning"}>
          <AlertTitle>Client SDK {isClientSdkConnected() ? "connected" : "not connected"}</AlertTitle>
          <AlertDescription>
            Proof generation is a stub in <code>src/lib/client-sdk</code>. A real withdrawal will return{" "}
            <code>InvalidProof</code> until it's implemented. You can paste a ready-made proof JSON below to test the relayer path now.
          </AlertDescription>
        </Alert>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>asset</Label>
            <div className="flex gap-1">
              {(["sol", "spl"] as const).map((k) => (
                <Button
                  key={k}
                  size="sm"
                  variant={kind === k ? "default" : "outline"}
                  onClick={() => setKind(k)}
                  className="flex-1"
                >
                  {k.toUpperCase()}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="amount">amount ({kind === "sol" ? "SOL" : "raw"})</Label>
            <Input id="amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          </div>
        </div>

        {kind === "spl" && (
          <div className="space-y-1.5">
            <Label htmlFor="mint">mint (base58)</Label>
            <Input id="mint" value={mint} onChange={(e) => setMint(e.target.value)} className="font-mono text-xs" />
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="fee">relayer fee (bps)</Label>
            <Input id="fee" value={feeBps} onChange={(e) => setFeeBps(e.target.value)} inputMode="numeric" />
          </div>
          <div className="space-y-1.5">
            <Label>computed</Label>
            <div className="flex h-9 items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">ext_amount {extAmount.toLocaleString()}</Badge>
              <Badge variant="outline">fee {feeLamports.toLocaleString()}</Badge>
            </div>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="recipient">recipient</Label>
          <Input
            id="recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={publicKey ? publicKey.toBase58() : "connect wallet to prefill"}
            className="font-mono text-xs"
          />
          <p className="text-xs text-muted-foreground">
            {publicKey ? "Prefilled from connected wallet." : "Connect a wallet to prefill your address."}
          </p>
        </div>

        <Button onClick={handleBuild} disabled={busy} className="w-full">
          {busy ? "Working…" : "Build & submit via relayer"}
        </Button>

        <div className="border-t pt-3">
          <Label htmlFor="paste" className="mb-1.5 block">
            Or paste a full proof JSON (manual test)
          </Label>
          <Textarea
            id="paste"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder='{ "kind": "sol", "proof_a": "0x…", … }'
            className="font-mono text-xs"
            rows={5}
          />
          <Button variant="secondary" onClick={handlePasteSubmit} disabled={busy || !pasted} className="mt-2 w-full">
            Submit pasted proof to relayer
          </Button>
        </div>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">response</p>
            <JsonBlock value={result} />
          </div>
        )}
        {errCode && errMsg && <ErrorBlock code={errCode} message={errMsg} />}
      </CardContent>
    </Card>
  )
}
