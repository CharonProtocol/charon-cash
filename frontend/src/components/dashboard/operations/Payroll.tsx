import { OperationLayout } from "../OperationLayout";

/** Private payroll runs in its own app (same wallet, same private balances). */
const PAYROLL_URL = "https://betapay.charon.cash";

export function Payroll() {
  return (
    <OperationLayout>
      <div className="pay-soon">
        <h2>Private payroll</h2>
        <p>Pay your whole team in SOL or USDC in one signature. Salaries stay private.</p>
      </div>
      <a className="pay-review pay-link" href={PAYROLL_URL} target="_blank" rel="noopener noreferrer">
        Open Charon Payroll
      </a>
    </OperationLayout>
  );
}
