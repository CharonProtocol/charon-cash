type Props = {
  connected: boolean;
  supported: boolean;
  initializing: boolean;
  error: string;
  onRetry: () => void;
};

export function ClientStatus({ connected, supported, initializing, error, onRetry }: Props) {
  if (!connected || (supported && !initializing && !error)) return null;

  return (
    <div role="status" aria-live="polite" className="shrink-0 text-center font-mono text-xs text-neutral-600">
      {!supported ? (
        <p>Connect a wallet that supports message and transaction signing.</p>
      ) : error ? (
        <>
          <p>{error}</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded-md bg-[#303030] px-3 py-2 text-white">Try again</button>
        </>
      ) : (
        <p>Preparing your private account. Approve the message in your wallet.</p>
      )}
    </div>
  );
}
