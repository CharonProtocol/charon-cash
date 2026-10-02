import {
  ArrowUpRight,
  ArrowRight,
  ShieldCheck,
  Fingerprint,
  Waves,
  Zap,
} from "lucide-react";

export function Brand() {
  return (
    <a
      className="brand"
      href="#"
      aria-label="Charon home"
    >
      <span className="brand-mark">
        <Waves size={22} />
      </span>
      charon<span className="brand-dot">.</span>
    </a>
  );
}
export function Landing() {
  return (
    <div className="site landing">
      <header className="topbar">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#how-it-works">How it works</a>
          <a href="#features">Why Charon</a>
        </nav>
        <a
          className="button glass small"
          href="#dashboard"
        >
          Launch app <ArrowUpRight size={16} />
        </a>
      </header>
      <main>
        <section className="landing-hero">
          <div className="hero-copy">
            <span className="eyebrow">
              <span className="status-dot" /> A quieter way to move on Solana
            </span>
            <h1>
              Your money.
              <br />
              Your business.
              <br />
              <span>Keep it that way.</span>
            </h1>
            <p>
              Move SOL through a shielded pool. A little less exposure. A lot
              more control.
            </p>
            <div className="hero-actions">
              <a
                className="button primary"
                href="#dashboard"
              >
                Enter the app <ArrowUpRight size={18} />
              </a>
              <a
                className="text-link"
                href="#how-it-works"
              >
                Explore the protocol <ArrowRight size={16} />
              </a>
            </div>
            <div className="hero-footnote">
              <ShieldCheck size={15} /> Zero-knowledge proofs <span>·</span>{" "}
              Built on Solana
            </div>
          </div>
          <div
            className="hero-art"
            aria-hidden="true"
          >
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="glass-sphere">
              <Waves
                strokeWidth={1}
                size={110}
              />
            </div>
            <div className="art-label glass">
              <ShieldCheck size={18} />
              <div>
                Privacy, by design.<small>Proof without exposure.</small>
              </div>
              <span className="status-dot" />
            </div>
            <span className="art-coordinate">35° / THE PRIVATE SIDE</span>
          </div>
        </section>
        <section
          className="feature-strip"
          id="features"
        >
          <div>
            <Fingerprint />
            <h3>Prove. Don’t reveal.</h3>
            <p>Generate zero-knowledge proofs right in your browser.</p>
          </div>
          <div>
            <ShieldCheck />
            <h3>Keys stay with you.</h3>
            <p>Your wallet authorizes every move. You remain in control.</p>
          </div>
          <div>
            <Zap />
            <h3>Made for Solana.</h3>
            <p>A shielded payment layer on the network you already use.</p>
          </div>
        </section>
        <section
          className="how-section"
          id="how-it-works"
        >
          <div>
            <span className="eyebrow">LESS EXPOSURE. SAME YOU.</span>
            <h2>
              Three steps.
              <br />A little more privacy.
            </h2>
          </div>
          <ol>
            <li>
              <span>01</span>
              <div>
                <h3>Connect your wallet</h3>
                <p>
                  Use your Solana wallet, then sign a message to unlock your
                  account.
                </p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>Send into the shielded pool</h3>
                <p>
                  Send SOL to a registered Charon wallet with a
                  browser-generated proof.
                </p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>Withdraw when you’re ready</h3>
                <p>
                  Withdraw private funds to your connected wallet. The
                  destination and amount are public.
                </p>
              </div>
            </li>
          </ol>
        </section>
      </main>
      <footer>
        <Brand />
        <span>A private space in a public world.</span>
        <a href="#dashboard">
          Open dashboard <ArrowUpRight size={14} />
        </a>
      </footer>
    </div>
  );
}
