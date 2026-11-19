import { describe, expect, it } from "vitest";
import type { UpdateStatus } from "../../shared/ipc";
import type { AppSettings } from "../../shared/project";
import { memoryLogger } from "../logger";
import { defaultSettings } from "./settingsStore";
import {
  CHECK_INTERVAL_MS,
  LATEST_RELEASE_URL,
  NOTES_MAX_CHARS,
  UpdateService,
  isCheckDue,
  plainNotes,
  type FetchLike,
} from "./updateService";

const NOW = new Date("2026-12-01T10:00:00Z");

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: "v0.2.0",
    name: "Slabyrinth 0.2.0",
    draft: false,
    prerelease: false,
    published_at: "2026-11-30T09:00:00Z",
    html_url: "https://evil.example/download",
    body: "## Added\r\n- Stamps\r\n\r\n<script>alert(1)</script>",
    assets: [{ browser_download_url: "https://evil.example/x.exe" }],
    ...over,
  };
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

function rig(
  respond: (url: string, init: RequestInit) => Promise<Response> | Response,
  opts: {
    current?: string;
    settings?: Partial<AppSettings["updates"]>;
    timeoutMs?: number;
    maxBytes?: number;
  } = {},
) {
  let settings: AppSettings = { ...defaultSettings("/maps"), updates: { autoCheck: true, ...opts.settings } };
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const available: UpdateStatus[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  const service = new UpdateService({
    currentVersion: opts.current ?? "0.1.0",
    settings: {
      get: () => structuredClone(settings),
      updateInternal: (mutate) => {
        settings = mutate(structuredClone(settings));
        return Promise.resolve(settings);
      },
    },
    logger: memoryLogger(),
    fetch,
    now: () => NOW,
    onAvailable: (s) => available.push(s),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytes: opts.maxBytes } : {}),
  });
  return { service, calls, available, settings: () => settings };
}

describe("UpdateService.check", () => {
  it("newer release → available, with a URL built from the tag and plain-text notes", async () => {
    const r = rig(() => json(release()));
    const s = await r.service.check({ manual: true });
    expect(s).toMatchObject({ state: "available", currentVersion: "0.1.0", skipped: false });
    expect(s.update).toEqual({
      version: "0.2.0",
      tag: "v0.2.0",
      publishedAt: "2026-11-30T09:00:00Z",
      notes: "## Added\n- Stamps\n\n<script>alert(1)</script>",
      url: "https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0",
    });
    expect(JSON.stringify(s)).not.toContain("evil.example");
    expect(r.available).toHaveLength(1);
    expect(s.lastCheckedAt).toBe(NOW.toISOString());
    // One anonymous GET to the pinned endpoint, no redirect following, generic headers only.
    expect(r.calls).toHaveLength(1);
    const call = r.calls[0];
    expect(call?.url).toBe("https://api.github.com/repos/mwaboff/slabyrinth/releases/latest");
    expect(call?.url).toBe(LATEST_RELEASE_URL);
    expect(call?.init).toMatchObject({ method: "GET", redirect: "manual", credentials: "omit" });
    expect(call?.init.headers).toEqual({
      Accept: "application/vnd.github+json",
      "User-Agent": "Slabyrinth/0.1.0",
    });
  });

  it("same or older release → up to date; nothing emitted", async () => {
    for (const tag of ["v0.1.0", "v0.0.9", "0.1.0"]) {
      const r = rig(() => json(release({ tag_name: tag })));
      const s = await r.service.check({ manual: false });
      expect(s.state, tag).toBe("up_to_date");
      expect(s.update).toBeNull();
      expect(r.available).toHaveLength(0);
    }
  });

  it("prerelease, draft and garbage tags are never offered", async () => {
    for (const over of [
      { tag_name: "v0.3.0-beta.1" },
      { prerelease: true },
      { draft: true },
      { tag_name: "nightly" },
      { tag_name: "v0.2" },
      { tag_name: "v0.2.0/../../x" },
    ]) {
      const r = rig(() => json(release(over)));
      const s = await r.service.check({ manual: true });
      expect(s.state, JSON.stringify(over)).toBe("up_to_date");
      expect(r.available).toHaveLength(0);
    }
  });

  it("a running prerelease is offered the final release", async () => {
    const r = rig(() => json(release({ tag_name: "v0.2.0" })), { current: "0.2.0-beta.3" });
    expect((await r.service.check({ manual: true })).state).toBe("available");
  });

  it("malformed, oversized, rate-limited, offline and HTTP errors → quiet 'failed'", async () => {
    const cases: Array<[string, () => Promise<Response> | Response]> = [
      ["not json", () => json("<html>")],
      ["wrong shape", () => json({ tag: "v9.9.9" })],
      ["tag too long", () => json(release({ tag_name: `v1.0.0-${"x".repeat(100)}` }))],
      ["oversized (declared)", () => json(release(), { headers: { "content-length": String(300 * 1024) } })],
      ["oversized (streamed)", () => json(release({ body: "x".repeat(300 * 1024) }))],
      ["403", () => json({ message: "API rate limit exceeded" }, { status: 403 })],
      ["429", () => json({}, { status: 429 })],
      ["500", () => json({}, { status: 500 })],
      ["404", () => json({}, { status: 404 })],
      [
        "offline",
        () => {
          throw new TypeError("fetch failed");
        },
      ],
    ];
    for (const [name, respond] of cases) {
      const r = rig(respond);
      const s = await r.service.check({ manual: true });
      expect(s.state, name).toBe("failed");
      expect(s.update, name).toBeNull();
      expect(r.available, name).toHaveLength(0);
      // A failed attempt still counts for the daily throttle.
      expect(s.lastCheckedAt, name).toBe(NOW.toISOString());
    }
  });

  it("times out (~8 s by default) even if fetch ignores the abort signal", async () => {
    const r = rig(() => new Promise<Response>(() => undefined), { timeoutMs: 30 });
    const s = await r.service.check({ manual: true });
    expect(s.state).toBe("failed");
  });

  it("follows a redirect only to api.github.com over https; other hosts fail", async () => {
    const moved = "https://api.github.com/repositories/123/releases/latest";
    const ok = rig((url) =>
      url === LATEST_RELEASE_URL
        ? new Response(null, { status: 301, headers: { location: moved } })
        : json(release()),
    );
    expect((await ok.service.check({ manual: true })).state).toBe("available");
    expect(ok.calls.map((c) => c.url)).toEqual([LATEST_RELEASE_URL, moved]);

    for (const location of [
      "https://evil.example/releases/latest",
      "http://api.github.com/repos/mwaboff/slabyrinth/releases/latest",
      "https://api.github.com.evil.example/x",
      "https://api.github.com:8443/x",
      "https://user:pw@api.github.com/x",
    ]) {
      const bad = rig((url) =>
        url === LATEST_RELEASE_URL
          ? new Response(null, { status: 302, headers: { location } })
          : json(release()),
      );
      expect((await bad.service.check({ manual: true })).state, location).toBe("failed");
      expect(bad.calls, location).toHaveLength(1);
    }
    const loop = rig(() => new Response(null, { status: 302, headers: { location: moved } }));
    expect((await loop.service.check({ manual: true })).state).toBe("failed");
    expect(loop.calls.length).toBeLessThanOrEqual(4);
  });

  it("concurrent checks share one request", async () => {
    const r = rig(() => json(release()));
    const [a, b] = await Promise.all([r.service.check({ manual: true }), r.service.check({ manual: false })]);
    expect(a).toEqual(b);
    expect(r.calls).toHaveLength(1);
  });
});

describe("throttle, startup rules and skip", () => {
  it("isCheckDue: never, 24 h, unreadable and future timestamps", () => {
    expect(isCheckDue(undefined, NOW)).toBe(true);
    expect(isCheckDue(new Date(NOW.getTime() - CHECK_INTERVAL_MS + 60_000).toISOString(), NOW)).toBe(false);
    expect(isCheckDue(new Date(NOW.getTime() - CHECK_INTERVAL_MS).toISOString(), NOW)).toBe(true);
    expect(isCheckDue("garbage", NOW)).toBe(true);
    expect(isCheckDue(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW)).toBe(true);
  });

  it("startup: packaged only, never in safe mode, only with autoCheck, at most daily", async () => {
    const recent = new Date(NOW.getTime() - 3600_000).toISOString();
    const r = rig(() => json(release()));
    expect(await r.service.startupCheck({ packaged: false, safeMode: false })).toBeNull();
    expect(await r.service.startupCheck({ packaged: true, safeMode: true })).toBeNull();
    expect(r.calls).toHaveLength(0);
    expect((await r.service.startupCheck({ packaged: true, safeMode: false }))?.state).toBe("available");
    expect(r.calls).toHaveLength(1);
    // lastCheckedAt is now set: the next startup the same day doesn't check again…
    expect(await r.service.startupCheck({ packaged: true, safeMode: false })).toBeNull();
    // …but a manual check always runs (dev builds too).
    expect((await r.service.check({ manual: true })).state).toBe("available");
    expect(r.calls).toHaveLength(2);

    const off = rig(() => json(release()), { settings: { autoCheck: false } });
    expect(await off.service.startupCheck({ packaged: true, safeMode: false })).toBeNull();
    expect((await off.service.check({ manual: true })).state).toBe("available");

    const throttled = rig(() => json(release()), { settings: { lastCheckedAt: recent } });
    expect(await throttled.service.startupCheck({ packaged: true, safeMode: false })).toBeNull();
    expect(throttled.calls).toHaveLength(0);
  });

  it("skip: the skipped version raises no event and is marked skipped; a newer one shows again", async () => {
    let tag = "v0.2.0";
    const r = rig(() => json(release({ tag_name: tag })));
    await r.service.check({ manual: true });
    expect(r.available).toHaveLength(1);
    const s = await r.service.skip("0.2.0");
    expect(s.skipped).toBe(true);
    expect(r.settings().updates.skippedVersion).toBe("0.2.0");
    await r.service.check({ manual: true });
    expect(r.available).toHaveLength(1);
    expect(r.service.status()).toMatchObject({ state: "available", skipped: true });
    tag = "v0.3.0";
    const next = await r.service.check({ manual: true });
    expect(next).toMatchObject({ state: "available", skipped: false, update: { version: "0.3.0" } });
    expect(r.available).toHaveLength(2);
    // Garbage versions are not recorded.
    await r.service.skip("whatever");
    expect(r.settings().updates.skippedVersion).toBe("0.2.0");
  });
});

describe("plainNotes", () => {
  it("normalizes line breaks, strips control, bidi and zero-width characters, caps with a … line", () => {
    expect(plainNotes("a\r\nb\rc\u0007‮d​\u0000\n\n\n\ne")).toBe("a\nb\ncd\n\ne");
    expect(plainNotes(null)).toBe("");
    const long = plainNotes("x".repeat(NOTES_MAX_CHARS + 50));
    expect(long.length).toBe(NOTES_MAX_CHARS);
    expect(long.endsWith("\n…")).toBe(true);
    // A cut prefers a line break, and the renderer never receives more than the cap (even from a huge body).
    const lines = plainNotes("- item\n".repeat(10_000));
    expect(lines.length).toBeLessThanOrEqual(NOTES_MAX_CHARS);
    expect(lines.endsWith("- item\n…")).toBe(true);
    expect(plainNotes("y".repeat(256 * 1024)).length).toBe(NOTES_MAX_CHARS);
  });
});
