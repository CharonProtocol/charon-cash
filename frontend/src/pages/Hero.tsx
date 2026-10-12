import { useCallback, useEffect, useRef, useState } from "react";
import {
  CharonScene,
  type CharonSceneHandle,
} from "../components/charon/CharonScene";
import "./Landing.css";

export function Hero({
  onPrivacyChange,
  variant = "waitlist",
}: {
  onPrivacyChange?: (isPrivate: boolean) => void;
  variant?: "landing" | "waitlist";
}) {
  const scene = useRef<CharonSceneHandle>(null);
  const [privateMode, setPrivateMode] = useState(false);

  useEffect(() => {
    onPrivacyChange?.(privateMode);
  }, [privateMode, onPrivacyChange]);

  const [paused, setPaused] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [introComplete, setIntroComplete] = useState(false);
  const [exploring, setExploring] = useState(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onBackgroundActivity = useCallback((holding: boolean) => {
    setExploring(true);
    if (idleTimer.current) clearTimeout(idleTimer.current);
    if (!holding)
      idleTimer.current = setTimeout(() => setExploring(false), 600);
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) clearTimeout(idleTimer.current);
    },
    [],
  );

  useEffect(() => {
    const handleScroll = () => {
      const progress = Math.min(
        1,
        Math.max(0, window.scrollY / window.innerHeight),
      );
      scene.current?.setScrollProgress(progress);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);
  const panelVisible = introComplete && !exploring;

  return (
    <div
      className="charon-landing"
      data-private={privateMode}
    >
      <main
        className="charon-hero"
        aria-labelledby="charon-heading"
      >
        <CharonScene
          ref={scene}
          paused={paused}
          onPrivacyChange={setPrivateMode}
          onReadyChange={setInteractive}
          onIntroComplete={() => setIntroComplete(true)}
          onActivity={onBackgroundActivity}
        />
        <section
          className="charon-panel"
          data-visible={panelVisible}
          inert={!panelVisible}
        >
          <p className="charon-wordmark">CHARON</p>
          <h1
            id="charon-heading"
            className="charon-heading"
          >
            <span className="charon-heading-line">
              <span className="charon-soft">The</span> <strong>Private</strong>{" "}
              <span className="charon-layer">layer</span>
            </span>
            <span className="charon-heading-line charon-solana-line">
              <span className="charon-soft">for</span>{" "}
              <span
                className="charon-solana"
                aria-label="Solana"
              >
                <img
                  src="/Solana Logomark - Black.svg"
                  alt=""
                  width="78"
                  height="70"
                />
                <span aria-hidden="true">olana</span>
              </span>
            </span>
          </h1>
          <p className="charon-description">
            Private transfers, Shielded Balance
            <br />
            Shielded Swaps &amp; Payroll.
          </p>
          {variant === "waitlist" ? (
            <button
              id="join-waitlist"
              className="charon-waitlist"
              type="button"
            >
              <span>Join the waitlist</span>
            </button>
          ) : (
            <div className="charon-hero-actions">
              <button className="charon-action-button" type="button">
                Contact Us
              </button>
              <a className="charon-action-button" href="#dashboard">
                Shield Yourself
              </a>
            </div>
          )}
          <button
            className="charon-ferryman"
            type="button"
            aria-label="Toggle transaction privacy"
            aria-pressed={privateMode}
            title={
              privateMode
                ? "Bring the transactions back into the light"
                : "Click to make the transactions private"
            }
            disabled={!interactive}
            onClick={() => {
              scene.current?.togglePrivacy();
              onBackgroundActivity(false);
            }}
          >
            <img
              src={privateMode ? "/LogoOff.png" : "/LogoOn.png"}
              alt=""
              width="178"
              height="171"
            />
          </button>
        </section>
        {interactive && (
          <div className="charon-scene-controls">
            <p>
              Drag to explore <span aria-hidden="true">·</span> Click Charon to
              go {privateMode ? "public" : "private"}
            </p>
            <button
              type="button"
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? "Resume motion" : "Pause motion"}
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
