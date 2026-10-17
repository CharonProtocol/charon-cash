import { TokenIcon, type Token } from "./TokenIcon";
import { AVAILABLE_TOKENS } from "../../lib/config";

export function TokenSelector({
  value,
  onChange,
  locked = false,
}: {
  value: Token;
  onChange: (token: Token) => void;
  locked?: boolean;
}) {
  const next = AVAILABLE_TOKENS[(AVAILABLE_TOKENS.indexOf(value) + 1) % AVAILABLE_TOKENS.length];
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
