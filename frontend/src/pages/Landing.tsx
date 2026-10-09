import { useState } from "react";
import { Hero } from "./Hero";
import { PrivateFinancialLayer } from "./PrivateFinancialLayer";
import "./Dashboard.css";

export function Landing() {
  const [isPrivate, setIsPrivate] = useState(false);

  return (
    <div className="landing-page relative">
      <header className="dashboard-navbar landing-dashboard-navbar" data-private={isPrivate}>
        <a href="#" aria-label="Charon home" className="dashboard-brand">
          <img src="/LogoOn.png" alt="" className="dashboard-brand-mark" />
          <span>CHARON</span>
        </a>
        <a className="landing-launch-button" href="#dashboard">
          Launch App
        </a>
      </header>
      <div className="sticky top-0 h-[100svh] w-full z-0">
        <Hero variant="landing" onPrivacyChange={setIsPrivate} />
      </div>
      <div className="relative z-10 shadow-2xl">
        <PrivateFinancialLayer />
      </div>
    </div>
  );
}
