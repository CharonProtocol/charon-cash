import { useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { toast } from "sonner";
import { ArrowDownToLine } from "lucide-react";

import { usePrivacyCash } from "@/hooks/usePrivacyCash";
import { solToLamports, lamportsToSol, shortHash } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { ErrorBlock, JsonBlock } from "@/components/ResponsePanel";
import { PublicKey } from "@solana/web3.js";

interface Result {
  signature: string;
}

function isValidPubkey(value: string) {
  try {
    new PublicKey(value.trim());
    return true;
  } catch {
    return false;
  }
}

export function DepositCard({ onChanged }: { onChanged?: () => void }) {
  const { client, connected } = usePrivacyCash();
  const { publicKey } = useWallet();
  const [amount, setAmount] = useState("0.05");
  const [recipient, setRecipient] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const recipientTrimmed = (recipient || "").trim();
  const recipientValid =
    recipientTrimmed.length > 0 && isValidPubkey(recipientTrimmed);

  const handleDeposit = async () => {
    if (!client) return;
    if (!recipientValid) {
      setErr("Enter a valid recipient public key.");
      return;
    }
    setBusy(true);
    setErr(null);
    setResult(null);
    setStatus("unlocking (approve the wallet signature)…");
    try {
      const lamports = solToLamports(Number(amount) || 0);
      setStatus("generating ZK proof + wallet signing…");
      const res = await client.sendSol(lamports, recipientTrimmed);
      setResult(res);
      setStatus(null);
      onChanged?.();
      toast.success("deposit landed", {
        description: shortHash(res.signature, 8, 6),
      });
    } catch (e) {
      setStatus(null);
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ArrowDownToLine className="size-4" /> Deposit SOL
        </CardTitle>
        <CardDescription>
          Client-side ZK proof, then your wallet signs the deposit. The signed
          tx is submitted via the backend broadcast API (no browser RPC submit).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!connected && (
          <Alert variant="warning">
            <AlertTitle>Wallet not connected</AlertTitle>
            <AlertDescription>
              Connect a wallet that supports <code>signMessage</code> +{" "}
              <code>signTransaction</code> (e.g. Phantom) to deposit.
            </AlertDescription>
          </Alert>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="amount">amount (SOL)</Label>
          <Input
            id="amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            disabled={!connected || busy}
          />
          <p className="text-xs text-muted-foreground">
            {lamportsToSol(solToLamports(Number(amount) || 0)).toFixed(9)} SOL ·{" "}
            {publicKey ? "depositor pays gas" : "connect wallet"}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="recipient">recipient</Label>
          <Input
            id="recipient"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder={recipient}
            disabled={!connected || busy}
            className={!recipientValid ? "border-destructive" : undefined}
          />
          <p className="text-xs text-muted-foreground">
            {recipientTrimmed.length === 0
              ? "leave as system program placeholder for a self-deposit"
              : recipientValid
                ? `sending to ${shortHash(recipientTrimmed, 6, 6)}`
                : "invalid public key"}
          </p>
        </div>

        <Button
          onClick={handleDeposit}
          disabled={!connected || busy || !recipientValid}
          className="w-full"
        >
          {busy ? (status ?? "Working…") : "Deposit SOL"}
        </Button>

        {result && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">result</p>
            <JsonBlock
              value={{
                signature: result.signature,
              }}
            />
          </div>
        )}
        {err && (
          <ErrorBlock
            code="DEPOSIT_FAILED"
            message={err}
          />
        )}
      </CardContent>
    </Card>
  );
}
