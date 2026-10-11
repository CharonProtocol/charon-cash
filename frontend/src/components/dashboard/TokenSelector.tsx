import { TokenIcon, type Token } from "./TokenIcon";

const TOKENS: Token[] = ["SOL", "USDC", "USDT"];

export function TokenSelector({
  value,
  onChange,
  locked = false,
}: {
  value: Token;
  onChange: (token: Token) => void;
  locked?: boolean;
}) {
  const next = TOKENS[(TOKENS.indexOf(value) + 1) % TOKENS.length];
  return (
    <button
      type="button"
      className="pay-token-chip"
      disabled={locked}
      aria-label={`Asset ${value}. Choose ${next}.`}
      onClick={() => onChange(next)}
    >
      <TokenIcon
        token={value}
        className="dashboard-token-icon"
      />
      {value}
    </button>
  );
}
