export interface CharonSceneController {
  togglePrivacy(): void;
  setPaused(paused: boolean): void;
  setScrollProgress(value: number): void;
  destroy(): void;
}

export function createCharonScene(
  host: HTMLElement,
  options?: {
    assetBase?: string;
    signal?: AbortSignal;
    onPrivacyChange?: (privateMode: boolean) => void;
    onError?: (error: Error) => void;
    onIntroComplete?: () => void;
    onActivity?: (holding: boolean) => void;
  },
): Promise<CharonSceneController | null>;
