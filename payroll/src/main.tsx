import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { SolanaProviders } from "@/components/WalletProvider"
import { Toaster } from "@/components/ui/sonner"
import { config } from "@/lib/config"
import { initAnalytics } from "@/lib/analytics"
import { setNativeProverToken } from "@/lib/browserProver"

config.apply()
// Native prover pairing (NATIVE_PROVER=1 ./run.sh prints this link): a
// ?prover=<code> visit stores the code once, then the URL is cleaned.
const pairing = new URLSearchParams(location.search).get("prover")
if (pairing) {
  setNativeProverToken(pairing.trim() || null)
  history.replaceState(null, "", location.pathname + location.hash)
}
initAnalytics()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
      <Toaster />
    </SolanaProviders>
  </StrictMode>,
)
