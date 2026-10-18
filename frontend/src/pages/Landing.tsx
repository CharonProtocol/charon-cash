import { useState, type SVGProps } from "react";
import { Hero } from "./Hero";
import { PrivateFinancialLayer } from "./PrivateFinancialLayer";
import "./Dashboard.css";

const FOOTER_LINKS = [
  { href: "https://x.com/Charon_cash", label: "X", icon: XMark },
] as const;

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
      <div className="landing-sheet">
        <PrivateFinancialLayer />
        <footer className="landing-footer">
          {FOOTER_LINKS.map(({ href, label, icon: Icon }) => (
            <a key={label} href={href}>
              <span className="landing-footer-mark">
                <Icon aria-hidden="true" />
              </span>
              {label}
            </a>
          ))}
        </footer>
      </div>
    </div>
  );
}

function XMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M17.55 3h3.05l-6.66 7.62L22 21h-6.15l-4.82-6.3L5.4 21H2.34l7.13-8.15L2 3h6.3l4.35 5.76L17.55 3Zm-1.07 16.2h1.69L7.58 4.7H5.77l10.71 14.5Z" />
    </svg>
  );
}
