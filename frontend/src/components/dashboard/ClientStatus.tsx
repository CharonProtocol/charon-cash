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
    <div role="status" aria-live="polite" className="dashboard-status">
      {!supported ? (
        <p>Connect a wallet that supports message and transaction signing.</p>
      ) : error ? (
        <>
          <p>{error}</p>
          <button type="button" onClick={onRetry}>Try again</button>
        </>
      ) : (
        <p>Approve the sign-in in your wallet.</p>
      )}
    </div>
  );
}
