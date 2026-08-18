import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { SolanaProviders } from "@/components/WalletProvider"
import { Toaster } from "@/components/ui/sonner"
import { config } from "@/lib/config"

config.apply()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
      <Toaster />
    </SolanaProviders>
  </StrictMode>,
)
