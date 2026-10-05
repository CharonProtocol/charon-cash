import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { SolanaProviders } from "@/components/WalletProvider"
import { Toaster } from "@/components/ui/sonner"
import { config } from "@/lib/config"
import { initAnalytics } from "@/lib/analytics"

config.apply()
initAnalytics()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
      <Toaster />
    </SolanaProviders>
  </StrictMode>,
)
