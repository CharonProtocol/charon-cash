import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import type { CharonSceneController } from "./scene.js";

export interface CharonSceneHandle {
  togglePrivacy(): void;
}

interface CharonSceneProps {
  paused: boolean;
  onPrivacyChange: (privateMode: boolean) => void;
  onReadyChange: (ready: boolean) => void;
  onIntroComplete: () => void;
  onActivity: (holding: boolean) => void;
}

const fallbackNames = ["Alex Morgan", "Maya Chen", "Kai Nakamura", "Olivia Brooks", "Dev Patel", "Ava Thompson"];

/** The still grid remains visible while loading, or if WebGL is unavailable. */
function StillGrid() {
  return (
    <div className="charon-still-grid" aria-hidden="true">
      {Array.from({ length: 35 }, (_, index) => (
        <div className="charon-still-card" key={index}>
          <span className="charon-still-hash">5F{index + 3}w9X…3kLm</span>
          <div><i /><span>{fallbackNames[index % 6]}<small>8zB4…pQ7x</small><b>−16.40 SOL</b></span></div>
          <img src="/solana.svg" alt="" width="44" height="38" />
          <div><span>{fallbackNames[(index + 1) % 6]}<small>4RX4…9sVp</small><b>+16.40 SOL</b></span><i /></div>
        </div>
      ))}
    </div>
  );
}

export const CharonScene = forwardRef<CharonSceneHandle, CharonSceneProps>(
  function CharonScene({ paused, onPrivacyChange, onReadyChange, onIntroComplete, onActivity }, ref) {
    const host = useRef<HTMLDivElement>(null);
    const controller = useRef<CharonSceneController | null>(null);
    const callbacks = useRef({ onPrivacyChange, onReadyChange, onIntroComplete, onActivity, paused });
    const [ready, setReady] = useState(false);

    useEffect(() => {
      callbacks.current = { onPrivacyChange, onReadyChange, onIntroComplete, onActivity, paused };
    }, [onPrivacyChange, onReadyChange, onIntroComplete, onActivity, paused]);
    useEffect(() => {
      controller.current?.setPaused(paused);
    }, [paused]);

    useImperativeHandle(ref, () => ({
      togglePrivacy: () => controller.current?.togglePrivacy(),
    }), []);

    useEffect(() => {
      const abort = new AbortController();
      let owned: CharonSceneController | null = null;
      const fallback = () => {
        if (abort.signal.aborted) return;
        setReady(false);
        callbacks.current.onReadyChange(false);
        callbacks.current.onPrivacyChange(false);
        callbacks.current.onIntroComplete();
      };
      import("./scene.js")
        .then(async ({ createCharonScene }) => {
          if (abort.signal.aborted || !host.current) return;
          const instance = await createCharonScene(host.current, {
            signal: abort.signal,
            onPrivacyChange: (value) => callbacks.current.onPrivacyChange(value),
            onIntroComplete: () => callbacks.current.onIntroComplete(),
            onActivity: (holding) => callbacks.current.onActivity(holding),
            onError: fallback,
          });
          if (abort.signal.aborted) {
            instance?.destroy();
            return;
          }
          if (!instance) return;
          owned = instance;
          controller.current = instance;
          instance.setPaused(callbacks.current.paused);
          setReady(true);
          callbacks.current.onReadyChange(true);
        })
        .catch(fallback);
      return () => {
        abort.abort();
        owned?.destroy();
        if (controller.current === owned) controller.current = null;
      };
    }, []);

    return (
      <div className="charon-scene" aria-hidden="true">
        {!ready && <StillGrid />}
        <div className="charon-scene-canvas" ref={host} />
      </div>
    );
  },
);
