import { describe, expect, it } from "vitest";
import { CSP_DEV, CSP_PROD } from "./csp";

// Scaffold test for the main-process project; also guards the §6.5 production policy.
describe("CSP", () => {
  it("production policy forbids inline scripts and remote connections", () => {
    expect(CSP_PROD).toContain("script-src 'self';");
    expect(CSP_PROD).toContain("connect-src 'self';");
    expect(CSP_PROD).toContain("object-src 'none'");
    expect(CSP_PROD).not.toContain("unsafe-eval");
  });
  it("development policy only adds the local dev server", () => {
    expect(CSP_DEV).toContain("ws://localhost:*");
    expect(CSP_DEV).not.toContain("https:");
  });
});
