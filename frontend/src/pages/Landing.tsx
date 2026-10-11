import { useState, type SVGProps } from "react";
import { BookOpen, Shield } from "lucide-react";
import { Hero } from "./Hero";
import { PrivateFinancialLayer } from "./PrivateFinancialLayer";
import "./Dashboard.css";

const FOOTER_LINKS = [
  // { href: "https://charon.cash/docs", label: "Docs", icon: BookOpen },
  // { href: "https://github.com/CharonProtocol/", label: "GitHub", icon: GitHubMark },
  { href: "https://x.com/Charon_cash", label: "X", icon: XMark },
  //{ href: "https://charon.cash/privacy-policy", label: "Privacy", icon: Shield },
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

function GitHubMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 2C6.48 2 2 6.58 2 12.26c0 4.52 2.87 8.35 6.84 9.7.5.1.68-.22.68-.49 0-.24-.01-.87-.01-1.71-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.89 1.57 2.34 1.12 2.91.86.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.07 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.3.1-2.71 0 0 .84-.27 2.75 1.05a9.2 9.2 0 0 1 5.01 0c1.9-1.32 2.74-1.05 2.74-1.05.55 1.41.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.94-2.34 4.81-4.57 5.07.36.32.68.94.68 1.9 0 1.38-.01 2.49-.01 2.83 0 .27.18.59.69.49A10.04 10.04 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z" />
    </svg>
  );
}

function XMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M17.55 3h3.05l-6.66 7.62L22 21h-6.15l-4.82-6.3L5.4 21H2.34l7.13-8.15L2 3h6.3l4.35 5.76L17.55 3Zm-1.07 16.2h1.69L7.58 4.7H5.77l10.71 14.5Z" />
    </svg>
  );
}
