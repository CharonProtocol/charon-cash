import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { UserAgreement } from "./UserAgreement";

describe("dashboard user agreement", () => {
  it("requires explicit acceptance before continuing", () => {
    const html = renderToStaticMarkup(<UserAgreement connected onAgree={() => { throw new Error("Must not accept during render"); }} />);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('checked=""');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Agree and continue/);
    expect(html).not.toContain("Unlock");
  });
});
