import { z } from "zod";
import type { UpdateInfo, UpdateStatus } from "../../shared/ipc";
import type { AppSettings } from "../../shared/project";
import { isAllowedExternalUrl, REPO_PATH } from "../externalUrls";
import type { Logger } from "../logger";
import { formatVersion, isNewer, parseVersion } from "./semver";

/**
 * UpdateService (decisions.md "Update notice"): tells the user a newer release exists and links to its page.
 * It never downloads or installs anything (builds are unsigned).
 *
 *  - One anonymous GET to GitHub's latest-release endpoint (drafts and prereleases are excluded there, and
 *    ignored here too). The host is pinned, https only; a redirect is followed only to the same host.
 *    Headers: Accept and a generic User-Agent ("Slabyrinth/<version>"); no identifiers, no key, no map data.
 *  - ~8 s timeout and a 256 KB response cap; the body is zod-validated. Any failure (offline, 403, 429, bad
 *    JSON, oversized, timeout, foreign redirect) is the quiet "failed" state, never an error dialog.
 *  - The download URL is built here from the validated tag and must pass the shell:openExternal allow-list;
 *    nothing URL-like from the response is used. Release notes are passed on as capped plain text.
 *  - Startup checks: packaged builds only, never in safe mode (smoke/e2e), only with autoCheck on, at most
 *    once per 24 h (settings.updates.lastCheckedAt). Manual checks ignore the throttle and the setting.
 */
export const RELEASES_API_HOST = "api.github.com";
export const LATEST_RELEASE_URL = `https://${RELEASES_API_HOST}/repos${REPO_PATH}/releases/latest`;
export const RELEASE_PAGE_BASE = `https://github.com${REPO_PATH}/releases/tag/`;
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 256 * 1024;
export const NOTES_MAX_CHARS = 4000;
const MAX_REDIRECTS = 3;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface UpdateSettingsPort {
  get(): AppSettings;
  updateInternal(mutate: (s: AppSettings) => AppSettings): Promise<AppSettings>;
}

export interface UpdateServiceOptions {
  currentVersion: string;
  settings: UpdateSettingsPort;
  logger: Logger;
  /** Injectable for tests and the e2e test build; defaults to the global fetch. */
  fetch?: FetchLike;
  now?: () => Date;
  /** Called when a check finds a newer version that isn't skipped (the renderer shows the chip). */
  onAvailable?: (status: UpdateStatus) => void;
  timeoutMs?: number;
  maxBytes?: number;
}

const releaseSchema = z.object({
  tag_name: z.string().min(1).max(64),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
  published_at: z.string().max(64).nullable().optional(),
  body: z.string().nullable().optional(),
});

type FetchOutcome = { ok: true; release: z.infer<typeof releaseSchema> } | { ok: false; reason: string };

class CheckFailure extends Error {}

/** Untrusted release body → plain text: normalized line breaks, no control characters, capped with "…". */
export function plainNotes(body: string | null | undefined, max = NOTES_MAX_CHARS): string {
  if (body === null || body === undefined) return "";
  let text = body
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}

/** Due when never checked, when the last check is 24 h old, or when its time is unreadable or in the future. */
export function isCheckDue(lastCheckedAt: string | undefined, now: Date): boolean {
  if (lastCheckedAt === undefined) return true;
  const t = Date.parse(lastCheckedAt);
  if (!Number.isFinite(t) || t > now.getTime() + 60_000) return true;
  return now.getTime() - t >= CHECK_INTERVAL_MS;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "NaN");
  if (Number.isFinite(declared) && declared > maxBytes) throw new CheckFailure("oversized");
  if (!res.body) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new CheckFailure("oversized");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(all);
}

export class UpdateService {
  private state: UpdateStatus["state"] = "idle";
  private update: UpdateInfo | null = null;
  private inFlight: Promise<UpdateStatus> | null = null;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => Date;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: UpdateServiceOptions) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => new Date());
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  status(): UpdateStatus {
    const u = this.opts.settings.get().updates;
    return {
      state: this.state,
      currentVersion: this.opts.currentVersion,
      lastCheckedAt: u.lastCheckedAt ?? null,
      update: this.update,
      skipped: this.update !== null && u.skippedVersion === this.update.version,
    };
  }

  /** Whether the startup check may run (packaged, not safe mode, autoCheck on, 24 h since the last one). */
  shouldCheckAtStartup(ctx: { packaged: boolean; safeMode: boolean }): boolean {
    if (!ctx.packaged || ctx.safeMode) return false;
    const u = this.opts.settings.get().updates;
    return u.autoCheck && isCheckDue(u.lastCheckedAt, this.now());
  }

  /** `force` exists only for the e2e test build with an injected response (never in production code paths). */
  async startupCheck(ctx: {
    packaged: boolean;
    safeMode: boolean;
    force?: boolean;
  }): Promise<UpdateStatus | null> {
    if (ctx.force !== true && !this.shouldCheckAtStartup(ctx)) return null;
    return this.check({ manual: false });
  }

  /** Runs one check (concurrent calls share it). Never throws. */
  check(req: { manual: boolean }): Promise<UpdateStatus> {
    this.opts.logger.debug("update check requested", { manual: req.manual });
    this.inFlight ??= this.run().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async skip(version: string): Promise<UpdateStatus> {
    const v = parseVersion(version);
    if (v) {
      await this.opts.settings.updateInternal((s) => {
        s.updates = { ...s.updates, skippedVersion: formatVersion(v) };
        return s;
      });
    }
    return this.status();
  }

  private async run(): Promise<UpdateStatus> {
    this.state = "checking";
    const outcome = await this.fetchLatest();
    const checkedAt = this.now().toISOString();
    try {
      await this.opts.settings.updateInternal((s) => {
        s.updates = { ...s.updates, lastCheckedAt: checkedAt };
        return s;
      });
    } catch (err) {
      this.opts.logger.warn("could not record the update check time", { error: err });
    }
    if (!outcome.ok) {
      this.state = "failed";
      this.opts.logger.info("update check failed", { reason: outcome.reason });
      return this.status();
    }
    const r = outcome.release;
    const parsed = parseVersion(r.tag_name);
    if (r.draft === true || r.prerelease === true || parsed === null || parsed.prerelease.length > 0) {
      // Not a stable release we can offer: treated as nothing new.
      this.state = "up_to_date";
      this.update = null;
      this.opts.logger.info("update check: latest release ignored", { tag: r.tag_name.slice(0, 64) });
      return this.status();
    }
    const version = formatVersion(parsed);
    if (!isNewer(version, this.opts.currentVersion)) {
      this.state = "up_to_date";
      this.update = null;
      this.opts.logger.info("update check: up to date", { latest: version });
      return this.status();
    }
    const tag = r.tag_name.trim();
    const url = `${RELEASE_PAGE_BASE}${encodeURIComponent(tag)}`;
    if (!isAllowedExternalUrl(url)) {
      this.state = "failed";
      return this.status();
    }
    const published = r.published_at ?? null;
    this.update = {
      version,
      tag,
      publishedAt: published !== null && Number.isFinite(Date.parse(published)) ? published : null,
      notes: plainNotes(r.body),
      url,
    };
    this.state = "available";
    this.opts.logger.info("update available", { version });
    const status = this.status();
    if (!status.skipped) this.opts.onAvailable?.(status);
    return status;
  }

  private async fetchLatest(): Promise<FetchOutcome> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new CheckFailure("timeout"));
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([this.request(controller.signal), timeout]);
    } catch (err) {
      return { ok: false, reason: err instanceof CheckFailure ? err.message : "network" };
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(signal: AbortSignal): Promise<FetchOutcome> {
    let url = LATEST_RELEASE_URL;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `Slabyrinth/${this.opts.currentVersion}`,
        },
        redirect: "manual",
        credentials: "omit",
        signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (loc === null) throw new CheckFailure("redirect");
        let next: URL;
        try {
          next = new URL(loc, url);
        } catch {
          throw new CheckFailure("redirect");
        }
        if (
          next.protocol !== "https:" ||
          next.hostname.toLowerCase() !== RELEASES_API_HOST ||
          next.port !== "" ||
          next.username !== "" ||
          next.password !== ""
        )
          throw new CheckFailure("redirect_other_host");
        url = next.toString();
        continue;
      }
      if (res.status === 403 || res.status === 429) throw new CheckFailure("rate_limited");
      if (!res.ok) throw new CheckFailure(`http_${String(res.status)}`);
      const text = await readCapped(res, this.maxBytes);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new CheckFailure("malformed");
      }
      const parsed = releaseSchema.safeParse(json);
      if (!parsed.success) throw new CheckFailure("malformed");
      return { ok: true, release: parsed.data };
    }
    throw new CheckFailure("too_many_redirects");
  }
}
