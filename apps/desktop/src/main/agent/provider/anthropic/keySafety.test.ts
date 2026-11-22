/**
 * Key-safety guarantees of the Anthropic adapter: the real client factory always targets api.anthropic.com with only
 * the given key, whatever the environment says, and error text forwarded to the UI never carries a key.
 * No network: global fetch is replaced by a recorder.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError, AuthenticationError, BadRequestError, PermissionDeniedError } from "@anthropic-ai/sdk";
import { mapAnthropicError } from "./errors";
import { ANTHROPIC_API_BASE_URL, sdkClientFactory } from "./provider";

const KEY = "sk-ant-api03-GIVEN-not-real-000000000000-a1B2";
const LEAKED = "sk-ant-api03-LEAKED-not-real-111111111111-z9Y8";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sdkClientFactory (pinned host)", () => {
  it("targets api.anthropic.com with only the given key, ignoring redirecting/auth environment variables", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://evil.example.test");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-api03-ENV-not-real-222222222222-q1Q1");
    vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "env-bearer-token");
    vi.stubEnv(
      "ANTHROPIC_CUSTOM_HEADERS",
      "X-Api-Key: injected\nAuthorization: Bearer injected\nX-Extra: yes",
    );
    vi.stubEnv("ANTHROPIC_PROFILE", "someone-else");
    vi.stubEnv("ANTHROPIC_LOG", "debug");
    const seen: Array<{ url: string; headers: Headers }> = [];
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        headers: new Headers(init?.headers),
      });
      return Promise.resolve(
        new Response(JSON.stringify({ data: [], has_more: false, first_id: null, last_id: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });

    const client = sdkClientFactory({ apiKey: KEY });
    const listed: unknown[] = [];
    for await (const m of client.listModels(new AbortController().signal)) listed.push(m);
    expect(listed).toEqual([]);

    expect(ANTHROPIC_API_BASE_URL).toBe("https://api.anthropic.com");
    expect(seen).toHaveLength(1);
    const req = seen[0];
    if (!req) throw new Error("no request");
    expect(new URL(req.url).origin).toBe("https://api.anthropic.com");
    // This SDK version sends the API key as a bearer credential; only the given key may appear.
    expect(req.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(req.headers.get("x-api-key")).toBeNull();
    expect(req.headers.get("x-extra")).toBeNull();
    expect(JSON.stringify([...req.headers.entries()])).not.toMatch(/ENV-not-real|env-bearer-token|injected/);
    // The environment is untouched afterwards.
    expect(process.env["ANTHROPIC_CUSTOM_HEADERS"]).toContain("X-Extra");
  });
});

describe("error text forwarded to the UI is key-masked", () => {
  const headers = new Headers();
  const body = (msg: string) => ({ type: "error", error: { type: "invalid_request_error", message: msg } });

  it("masks keys in API messages and raw error messages", () => {
    const msg = `invalid x-api-key ${LEAKED}`;
    const cases: unknown[] = [
      new BadRequestError(400, body(msg), msg, headers),
      new PermissionDeniedError(403, body(msg), msg, headers),
      new AuthenticationError(401, body(msg), msg, headers),
      APIError.generate(418, body(msg), msg, headers),
      new Error(`socket closed while sending ${LEAKED}`),
    ];
    for (const err of cases) {
      const info = mapAnthropicError(err);
      expect(info.message).not.toContain(LEAKED);
      expect(info.message).not.toContain("LEAKED-not-real");
    }
    expect(mapAnthropicError(new BadRequestError(400, body(msg), msg, headers)).message).toContain(
      "sk-ant-…[redacted]",
    );
  });
});
