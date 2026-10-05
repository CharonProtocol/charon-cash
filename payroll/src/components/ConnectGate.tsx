import { useWallet } from "@solana/wallet-adapter-react"
import { WalletReadyState, type WalletName } from "@solana/wallet-adapter-base"
import { useEffect, useRef } from "react"
import { ArrowRight, Fingerprint, KeyRound, ShieldCheck } from "lucide-react"

import { GliderGroup } from "@/components/motion/Glider"
import { Ms } from "@/components/motion/ms"
import { Scramble } from "@/components/motion/Scramble"
import { Button } from "@/components/ui/button"
import { useConnectWallet } from "@/components/WalletProvider"
import { isLocalRpc } from "@/lib/explorer"
import { navigate } from "@/lib/router"

const SUBTITLES: Record<string, string> = {
  Phantom: "Solana native & Ledger support",
  Solflare: "Hardware & ephemeral key compatible",
  Backpack: "xNFT enabled · encrypted ledger",
  Ledger: "Direct USB / WebHID / Air-gapped QR",
  Torus: "Social recovery · embedded keys",
  Glow: "Mobile-first · Wallet Standard",
  "Demo Wallet": "Burner keypair · no extension needed (dev only)",
}

const invariants = [
  {
    icon: <ShieldCheck className="size-4 text-gold" />,
    title: "Non-custodial",
    body: "The program's PDA holds assets — no third party, including the relayer, can move them.",
  },
  {
    icon: <Fingerprint className="size-4 text-gold" />,
    title: "Zero metadata",
    body: "Recipient addresses are blinded before Groth16 witness generation ever runs.",
  },
  {
    icon: <KeyRound className="size-4 text-gold" />,
    title: "Hardware isolation",
    body: "Every payload signature resolves strictly on your device — keys never leave it.",
  },
]

/**
 * Full-page gate shown on /employer and /employee until a wallet is connected.
 * Mirrors the connect-wallet ref: suite pill, portal toggle, program row,
 * wallet rows, security invariants, network/relayer strip.
 */
export function ConnectGate({
  role,
  footerAction,
}: {
  role: "employer" | "employee"
  /** one-more-step block rendered inside the card (e.g. employee key setup) */
  footerAction?: React.ReactNode
}) {
  const { open } = useConnectWallet()
  const { wallets, select, wallet, connecting } = useWallet()

  // connect-from-click: select() attaches the context's listeners to the
  // adapter; once the selected wallet reflects the click we connect THE
  // ADAPTER directly — the context's connect() closes over stale state and
  // silently no-ops here. The adapter's connect event drives the context.
  const pendingConnect = useRef<string | null>(null)
  useEffect(() => {
    if (pendingConnect.current && wallet?.adapter.name === pendingConnect.current) {
      pendingConnect.current = null
      // defer one task: this effect runs before the provider's own adapter-
      // listener effect in the same commit, and connecting synchronously
      // would emit `connect` before anyone listens
      const adapter = wallet.adapter
      const t = setTimeout(() => {
        void adapter.connect().catch(() => open()) // popup blocked → full picker
      }, 0)
      return () => clearTimeout(t)
    }
  }, [wallet, open])

  const installed = wallets.filter((w) => w.readyState === WalletReadyState.Installed)
  const detected = new Set<string>(installed.map((w) => w.adapter.name))
  // Curated order so the screen matches the ref even before wallets install;
  // anything detected that isn't curated still gets a row. In dev the burner
  // wallet leads so the console is one click away without an extension.
  const curated = import.meta.env.DEV
    ? ["Demo Wallet", "Phantom", "Solflare", "Backpack"]
    : ["Phantom", "Solflare", "Backpack", "Ledger"]
  const names = [
    ...curated,
    ...wallets.map((w) => w.adapter.name as string).filter((n) => !curated.includes(n)),
  ].slice(0, 5)

  return (
    <div className="flex min-h-[calc(100dvh-3.5rem)] items-center justify-center px-4 py-10 sm:py-14">
      <div data-stagger className="w-full max-w-xl space-y-4">
        <div className="card-lift specular rounded-2xl border border-border bg-card p-6 sm:p-8">
          <div className="flex flex-col items-center text-center">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-[var(--gold-2)] opacity-25 blur-2xl" />
              <img src="/charon-lit.png" alt="" className="relative size-16 rounded-full object-contain" />
              <span className="absolute -right-0.5 bottom-1 flex size-3">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-band-gold opacity-60" />
                <span className="relative inline-flex size-3 rounded-full border-2 border-card bg-band-gold" />
              </span>
            </div>
            <span className="mt-4 flex items-center gap-2 rounded-full border border-gold-line bg-gold-soft px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-gold">
              <span className="size-1.5 rounded-full bg-gold" /> Charon Pay — Confidential Suite
            </span>
            <h1 className="h-display mt-3 text-2xl sm:text-3xl">
              <Scramble text={role === "employer" ? "Connect Employer Treasury" : "Connect Employee Wallet"} />
            </h1>
            <p className="mt-2 max-w-sm text-sm text-body-ink">
              {role === "employer"
                ? "Unlock the omnibus vault, run shielded payroll batches, and audit every receipt — one signature at a time."
                : "Claim ECDH-encrypted salary notes gaslessly — amounts stay invisible to everyone but you."}
            </p>
          </div>

          <div className="mt-6 flex justify-center">
            <GliderGroup
              pillClassName="bg-panel-2 border border-line shadow-sm"
              className="flex rounded-xl border border-line bg-panel p-1"
              itemClassName="whitespace-nowrap px-4 text-xs sm:text-sm"
              value={role}
              onChange={(id) => navigate(id === "employer" ? "/employer" : "/employee")}
              items={[
                { id: "employer", label: "Employer Treasury" },
                { id: "employee", label: "Employee Portal" },
              ]}
            />
          </div>

          <div className="mt-6 grid grid-cols-1 gap-2 font-mono text-[11px] sm:grid-cols-2">
            <div className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-body-ink">
              <span className="text-mute">PROGRAM_ID</span>
              <span>CHRN_zkPayroll_v2</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-body-ink">
              <span className="text-mute">PROOF</span>
              <span>GROTH16 · BN254</span>
            </div>
          </div>

          <div className="mt-3 space-y-2">
            {names.map((name) => {
              const isDetected = detected.has(name)
              // real wallet art when the adapter provides it (installed wallets
              // + the dev burner); letter tile for curated-but-absent names
              const icon = wallets.find((w) => (w.adapter.name as string) === name)?.adapter.icon
              return (
                <div
                  key={name}
                  className="flex items-center gap-3 rounded-xl border border-line bg-panel px-3.5 py-3 transition-all hover:-translate-y-px hover:border-[color-mix(in_srgb,var(--gold-2)_35%,var(--border))] hover:bg-panel-2"
                >
                  {icon ? (
                    <img
                      src={icon}
                      alt=""
                      className="size-9 flex-none rounded-lg border border-line bg-card object-contain p-0.5"
                    />
                  ) : (
                    <span className="flex size-9 flex-none items-center justify-center rounded-lg border border-line bg-card font-mono text-xs font-bold text-gold">
                      {name.slice(0, 2).toUpperCase()}
                    </span>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      {name}
                      {isDetected && (
                        <span className="rounded border border-gold-line bg-gold-soft px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-gold">
                          detected
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-mute">{SUBTITLES[name] ?? "Wallet Standard adapter"}</div>
                  </div>
                  <Button
                    size="sm"
                    className="btn-glow flex-none"
                    disabled={connecting}
                    onClick={() => {
                      const target = wallets.find((w) => w.adapter.name === name)?.adapter
                      if (wallet?.adapter.name === name && target) {
                        // already selected (persisted from a previous session) —
                        // select() won't re-render anything, connect right here
                        void target.connect().catch(() => open())
                        return
                      }
                      // straight from this click so the wallet's own popup
                      // keeps the user gesture; the modal is the fallback
                      pendingConnect.current = name
                      select(name as WalletName)
                    }}
                  >
                    {connecting ? "Connecting…" : "Connect"}{" "}
                    <ArrowRight className="ml-1 size-3.5" />
                  </Button>
                </div>
              )
            })}
            {wallets.length === 0 && (
              <Button className="btn-glow w-full" size="lg" onClick={open}>
                Open wallet picker <ArrowRight className="ml-1 size-4" />
              </Button>
            )}
          </div>

          {footerAction && (
            <div className="mt-4 rounded-xl border border-gold-line bg-gold-soft/60 p-4">{footerAction}</div>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-mute">
            Zero-knowledge security invariants
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {invariants.map((inv) => (
              <div key={inv.title} className="rounded-xl border border-line bg-panel p-3">
                <div className="flex items-center gap-2 text-xs font-semibold">
                  {inv.icon}
                  {inv.title}
                </div>
                <p className="mt-1.5 text-[11px] leading-relaxed text-body-ink">{inv.body}</p>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-center gap-2 pb-2 font-mono text-[11px] text-body-ink">
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5">
            <span className="size-1.5 rounded-full bg-gold" /> {isLocalRpc() ? "Localnet" : "Devnet"}
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5">
            <Ms name="bolt" className="text-xs text-gold" /> Relayer · gasless submits
          </span>
          <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1.5">
            <Ms name="lock" className="text-xs text-gold" /> Proofs built on-device
          </span>
        </div>
      </div>
    </div>
  )
}
