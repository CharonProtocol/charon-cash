import { useState } from "react";
import { Hero } from "./Hero";

export function Waitlist() {
  const [isPrivate, setIsPrivate] = useState(false);

  return (
    <div className="relative">
      <header className="charon-header" data-private={isPrivate}>
        <a href="#" aria-label="Charon home">
          <img src="/LogoOn.png" alt="Charon" width="100" height="96" />
        </a>
      </header>
      <div className="sticky top-0 h-[100svh] w-full z-0">
        <Hero onPrivacyChange={setIsPrivate} />
      </div>
    </div>
  );
}

