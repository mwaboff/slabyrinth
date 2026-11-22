import { describe, expect, it } from "vitest";
import { redactString } from "../logger";
import { EnginePortError } from "../ports/engine";
import { mapError } from "./router";

/** Made-up key-shaped strings: none is a real secret. */
const KEY = "sk-ant-api03-NOTREAL0123456789abcdefABCDEF-zz";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.NOTREAL.signature0123";

describe("redaction of key-shaped text", () => {
  it("masks provider keys, bearer tokens and labelled api-key values", () => {
    const out = redactString(`key ${KEY}; Authorization: Bearer ${TOKEN}; x-api-key: abcdef0123456789xyz`);
    expect(out).not.toContain("NOTREAL0123456789");
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("abcdef0123456789xyz");
    expect(out).toContain("sk-ant-…[redacted]");
  });

  it("leaves ordinary text alone", () => {
    const s = "Overloaded (529). Try again in a moment; the request id is req_123.";
    expect(redactString(s)).toBe(s);
  });

  it("every error crossing IPC is redacted: provider errors, engine errors and their provider info", () => {
    const provider = { info: { kind: "auth", retryable: false, message: `Invalid key ${KEY}` } };
    const a = mapError(provider);
    expect(JSON.stringify(a)).not.toContain("NOTREAL");
    expect(a.code).toBe("no_api_key");
    const b = mapError(
      new EnginePortError({
        code: "provider",
        message: `Upstream said ${KEY}`,
        provider: { kind: "server", retryable: true, message: `Bearer ${TOKEN}` },
      }),
    );
    expect(JSON.stringify(b)).not.toContain("NOTREAL");
  });
});
