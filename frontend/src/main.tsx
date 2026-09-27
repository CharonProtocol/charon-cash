import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App.tsx";
import { SolanaProviders } from "@/components/WalletProvider";
import { Toaster } from "@/components/ui/sonner";

createRoot(document.getElementById("root")!).render(
  <SolanaProviders>
    <App />
    <Toaster />
  </SolanaProviders>,
);
