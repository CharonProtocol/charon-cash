import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyMotion, domMax, MotionConfig } from "motion/react";
import { OperationDock } from "./OperationDock";
import { ProcessingStep } from "./ProcessingStep";

const wrap = (children: React.ReactNode) =>
  renderToStaticMarkup(
    <MotionConfig reducedMotion="always">
      <LazyMotion features={domMax}>{children}</LazyMotion>
    </MotionConfig>,
  );
describe("payment navigation and results", () => {
  it("keeps private transfer enabled while swap and payroll are disabled", () => {
    const html = wrap(
      <OperationDock
        value="send"
        busy={false}
        onChange={() => {}}
      />,
    );
    expect(html).toMatch(
      /id="pay-tab-transfer"[^>]*aria-selected="false"[^>]*aria-controls="pay-panel"[^>]*tabindex="-1"/,
    );
    expect(html).toMatch(/id="pay-tab-swap"[^>]*disabled=""/);
    expect(html).toMatch(/id="pay-tab-payroll"[^>]*disabled=""/);
    expect(html).toMatch(/id="pay-tab-send"[^>]*aria-selected="true"/);
  });
  it("locks navigation during submission", () => {
    const html = wrap(
      <OperationDock
        value="transfer"
        busy
        onChange={() => {}}
      />,
    );
    expect((html.match(/disabled=""/g) ?? []).length).toBe(5);
  });
  it("shows a wallet approval request without claiming confirmation", () => {
    const html = wrap(
      <ProcessingStep
        status="signing"
        kind="send"
        amount="0.45"
        onReset={() => {}}
        onBack={() => {}}
      />,
    );
    expect(html).toContain("Approve in your wallet");
    expect(html).not.toContain("Transaction confirmed");
    expect(html).not.toContain("New transaction");
  });
  it("offers review after failure and a receipt only after success", () => {
    const failed = wrap(
      <ProcessingStep
        status="error"
        kind="transfer"
        amount="0.45"
        error="Wallet rejected the transaction"
        onReset={() => {}}
        onBack={() => {}}
      />,
    );
    expect(failed).toContain("Wallet rejected the transaction");
    expect(failed).toContain("Back to review");
    expect(failed).not.toContain("View transaction");
    const confirmed = wrap(
      <ProcessingStep
        status="success"
        kind="withdraw"
        amount="0.45"
        explorerUrl="https://explorer.solana.com/tx/receipt"
        onReset={() => {}}
        onBack={() => {}}
      />,
    );
    expect(confirmed).toContain("Transaction confirmed");
    expect(confirmed).toContain("View transaction");
  });
});
