import { useState } from "react"
import { ArrowDownToLine, ArrowUpRight, Coins, ShieldCheck } from "lucide-react"

import { DepositCard } from "@/components/DepositCard"
import { WithdrawCard } from "@/components/WithdrawCard"
import { DepositSplCard } from "@/components/DepositSplCard"
import { WithdrawSplCard } from "@/components/WithdrawSplCard"
import { Button } from "@/components/ui/button"

interface UserAppViewProps {
  onChanged: () => void
}

export function UserAppView({ onChanged }: UserAppViewProps) {
  const [assetType, setAssetType] = useState<"SOL" | "SPL">("SOL")
  const [activeTab, setActiveTab] = useState<"deposit" | "withdraw">("deposit")

  return (
    <div className="mx-auto max-w-4xl space-y-6 py-4">
      {/* Header + asset toggle */}
      <div className="flex flex-col items-start justify-between gap-4 rounded-[14px] border border-border bg-card p-4 sm:flex-row sm:items-center">
        <div>
          <h2 className="h-display flex items-center gap-2 text-xl text-foreground">
            <ShieldCheck className="size-5 text-primary" /> Privacy Cash Portal
          </h2>
          <p className="text-xs text-muted-foreground">
            Client-side ZK proof generation · self-signed, direct to RPC
          </p>
        </div>

        <div className="flex items-center gap-1 rounded-xl border border-border bg-secondary p-1">
          <Button
            size="sm"
            variant={assetType === "SOL" ? "default" : "ghost"}
            onClick={() => setAssetType("SOL")}
          >
            <Coins className="mr-1.5 size-4" /> Native SOL
          </Button>
          <Button
            size="sm"
            variant={assetType === "SPL" ? "default" : "ghost"}
            onClick={() => setAssetType("SPL")}
          >
            SPL Tokens
          </Button>
        </div>
      </div>

      {/* Action tabs */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setActiveTab("deposit")}
          className={`flex items-center gap-2 border-b-2 px-6 py-3 text-sm font-medium transition-colors ${
            activeTab === "deposit"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <ArrowDownToLine className="size-4" /> Shield Deposit ({assetType})
        </button>
        <button
          onClick={() => setActiveTab("withdraw")}
          className={`flex items-center gap-2 border-b-2 px-6 py-3 text-sm font-medium transition-colors ${
            activeTab === "withdraw"
              ? "border-primary text-primary"
              : "border-transparent text-muted-foreground hover:text-foreground"
          }`}
        >
          <ArrowUpRight className="size-4" /> Private Withdraw ({assetType})
        </button>
      </div>

      {/* Panels */}
      <div className="transition-all">
        {activeTab === "deposit" ? (
          assetType === "SOL" ? (
            <DepositCard onChanged={onChanged} />
          ) : (
            <DepositSplCard onChanged={onChanged} />
          )
        ) : assetType === "SOL" ? (
          <WithdrawCard onChanged={onChanged} />
        ) : (
          <WithdrawSplCard onChanged={onChanged} />
        )}
      </div>
    </div>
  )
}
