/**
 * The app's end of the add-on link: an HTTP + WebSocket listener on 127.0.0.1 only, speaking `slabyrinth-link` v1
 * (protocol.ts) with Slabyrinth Helper inside TaleSpire.
 *
 * Trust: the upgrade must come from a page on TaleSpire's own local server (`Origin: http://localhost:<port>`) and name
 * this listener in `Host` (no DNS rebinding); the first message must be `hello` with this install's pairing token,
 * within a few seconds, or the connection is closed (4001) and reported as refused. One add-on at a time: a newly
 * paired one replaces the old. Every message is parsed with zod (protocol.ts) and capped in size.
 *
 * It tracks what the add-on reports (the set, chunk i of n, finished) and holds the global hotkeys while a map is
 * being placed (hotkeys.ts). Plain Node: no Electron here, so tests run it on an ephemeral port.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { LinkStatus } from "../../../../shared/ipc";
import type { Logger } from "../../../logger";
import { HotkeyManager, type HotkeyRegistrar, type HotkeyResults } from "./hotkeys";
import {
  HELPER_MAX_BYTES,
  appMessage,
  parseHelperMessage,
  type AppCommand,
  type ChunkSet,
  type HelperState,
} from "./protocol";
import { CLOSE, attachWebSocket, type WsConnection, type WsServer } from "./wsLite";

/** How long a new connection has to say hello. */
export const HELLO_TIMEOUT_MS = 5000;
/** How often to try the port again while another program holds it. */
export const PORT_RETRY_MS = 15_000;
/**
 * How long the add-on has to answer a sent set. It only checks the set and answers (TaleSpire is not asked), so
 * 30 seconds means it is gone or stuck; the send is then reported failed with loadTimeoutError (a late answer still
 * settles it).
 */
export const LOAD_TIMEOUT_MS = 30_000;
/** Connections that have not said hello yet, at most; more are refused (503) until those finish. */
export const MAX_PENDING = 8;

/** The `send.error` of a send the add-on did not answer in time (state "failed"). */
export function loadTimeoutError(ms: number): string {
  return `The add-on didn't answer within ${String(Math.round(ms / 1000))} seconds. Check Slabyrinth Helper in TaleSpire, then send again.`;
}

export type SendState = LinkStatus["send"];

export interface LinkServerOptions {
  /** 0 = an ephemeral port (tests and e2e runs never bind the real one). */
  port: number;
  /** This install's pairing token (the add-on's slabyrinth-link.json carries the same); null refuses everyone. */
  token: () => string | null;
  registrar: HotkeyRegistrar;
  /** Whether this is a Wayland session (hotkeys may be refused or need the desktop's consent). */
  wayland: boolean;
  logger: Logger;
  onChange: (s: LinkStatus) => void;
  /** Tests only: shorter waits than HELLO_TIMEOUT_MS and LOAD_TIMEOUT_MS. */
  helloTimeoutMs?: number;
  loadTimeoutMs?: number;
}

/** A page on TaleSpire's local symbiote server (or a plain local page). */
export function allowedOrigin(origin: string | null | undefined): boolean {
  return typeof origin === "string" && /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin);
}

/** Host names this listener answers to (a DNS-rebinding page names its own host). */
export function allowedHost(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${String(port)}` || host === `localhost:${String(port)}`;
}

/**
 * The plain HTTP answer: /probe (the add-on's Diagnostics connection test, over HTTP only) answers a short text, with
 * CORS for a local page origin only; anything else is 404.
 */
export function httpAnswer(
  method: string | undefined,
  url: string | undefined,
  origin: string | undefined,
): { status: number; headers: Record<string, string>; body: string } {
  const path = (url ?? "").split("?")[0];
  const cors: Record<string, string> = allowedOrigin(origin)
    ? {
        "Access-Control-Allow-Origin": origin ?? "",
        "Access-Control-Allow-Headers": "Content-Type",
        Vary: "Origin",
      }
    : {};
  if (path !== "/probe") return { status: 404, headers: { "Content-Type": "text/plain" }, body: "Not found" };
  if (method === "OPTIONS") return { status: 204, headers: cors, body: "" };
  if (method !== "GET" && method !== "POST")
    return { status: 405, headers: { ...cors, "Content-Type": "text/plain" }, body: "Method not allowed" };
  return {
    status: 200,
    headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" },
    body: "hello from Slabyrinth (connection test only)",
  };
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A set is being placed (the hotkeys are held) in these phases. */
const PLACING = new Set<HelperState["phase"]>(["ready", "sending", "inHand", "failed"]);

export class LinkServer {
  private server: Server | null = null;
  private ws: WsServer | null = null;
  private serverState: LinkStatus["server"]["state"] = "starting";
  private boundPort: number;
  private helper: WsConnection | null = null;
  private helperInfo: LinkStatus["helper"] = { state: "none", version: null, reason: null };
  private set: LinkStatus["set"] = null;
  private sendState: SendState = { state: "idle", buildId: null, chunks: 0, error: null };
  /** The id of the load message whose answer is awaited (kept past the deadline: a late answer still settles it). */
  private pendingLoad: number | null = null;
  private loadTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private readonly hotkeys: HotkeyManager;

  constructor(private readonly o: LinkServerOptions) {
    this.boundPort = o.port;
    this.hotkeys = new HotkeyManager(o.registrar, (a) => {
      this.command(a);
    });
  }

  /** Starts listening; a port held by another program is reported (port_in_use) and tried again later. */
  async start(): Promise<void> {
    this.closed = false;
    const server = createServer((req, res) => {
      req.resume();
      if (!allowedHost(req.headers.host, this.boundPort)) {
        res.writeHead(403).end();
        return;
      }
      const a = httpAnswer(req.method, req.url, req.headers.origin);
      res.writeHead(a.status, a.headers);
      res.end(a.body);
    });
    const ws = attachWebSocket(server, {
      maxMessageBytes: HELPER_MAX_BYTES,
      checkUpgrade: (req) => this.checkUpgrade(req),
      onOpen: (c) => {
        this.onOpen(c);
      },
      onMessage: (c, text) => {
        this.onMessage(c, text);
      },
      onClose: (c) => {
        this.onClose(c);
      },
    });
    server.on("error", (err) => {
      this.o.logger.warn("link server error", { error: err });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.o.port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (err) {
      const inUse = (err as { code?: string }).code === "EADDRINUSE";
      this.serverState = inUse ? "port_in_use" : "failed";
      this.o.logger.warn("link server could not listen", { port: this.o.port, inUse });
      this.changed();
      if (inUse && !this.isClosed()) {
        this.retry = setTimeout(() => {
          if (!this.closed) void this.start();
        }, PORT_RETRY_MS);
        this.retry.unref();
      }
      return;
    }
    if (this.isClosed()) {
      // closed while it was starting
      server.close();
      return;
    }
    const addr = server.address();
    this.boundPort = typeof addr === "object" && addr ? addr.port : this.o.port;
    this.server = server;
    this.ws = ws;
    this.serverState = "listening";
    this.o.logger.info("link server listening", { port: this.boundPort });
    this.changed();
  }

  /**
   * Stops listening, drops every connection (the add-on, ones still waiting for hello, plain HTTP ones) and releases
   * the hotkeys. Resolves within about CLOSE_GRACE_MS whatever the peers do; nothing is reported after it.
   */
  async close(): Promise<void> {
    this.closed = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    this.clearLoadTimer();
    for (const t of this.waiting.values()) clearTimeout(t);
    this.waiting.clear();
    this.hotkeys.disarm();
    this.helper = null;
    const s = this.server;
    const ws = this.ws;
    this.server = null;
    this.ws = null;
    if (!s) return;
    const stopped = new Promise<void>((r) => {
      s.close(() => {
        r();
      });
    });
    s.closeAllConnections();
    await ws?.closeAll(CLOSE.goingAway);
    await stopped;
  }

  get port(): number {
    return this.boundPort;
  }

  status(): LinkStatus {
    return {
      server: { state: this.serverState, port: this.boundPort },
      helper: { ...this.helperInfo },
      set: this.set ? { ...this.set } : null,
      send: { ...this.sendState },
      hotkeys: { state: this.hotkeys.summary(), wayland: this.o.wayland, actions: this.hotkeys.state() },
    };
  }

  /** Read through a call: close() may run while start() awaits. */
  private isClosed(): boolean {
    return this.closed;
  }

  get connected(): boolean {
    return this.helper !== null;
  }

  /**
   * Sends a chunk set to the add-on; its state reply settles `send` (loaded or failed). Without an answer within the
   * load deadline the send is reported failed with LOAD_TIMEOUT_ERROR's text (the contract has no state of its own for
   * it); an answer that comes later still settles it. False, and nothing sent, with no add-on connected.
   */
  load(set: ChunkSet, buildId: string): boolean {
    const h = this.helper;
    if (!h) return false;
    const id = this.nextId++;
    this.pendingLoad = id;
    this.sendState = { state: "sending", buildId, chunks: set.chunks.length, error: null };
    this.clearLoadTimer();
    const ms = this.o.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
    this.loadTimer = setTimeout(() => {
      this.loadTimer = null;
      if (this.pendingLoad !== id || this.sendState.state !== "sending") return;
      this.o.logger.warn("the add-on did not answer a sent set in time", { ms });
      this.sendState = { ...this.sendState, state: "failed", error: loadTimeoutError(ms) };
      this.changed();
    }, ms);
    this.loadTimer.unref();
    h.send(appMessage(id, { type: "load", set }));
    this.changed();
    return true;
  }

  /** The user stopped: a send still waiting for its answer goes back to idle (a late answer is ignored). */
  stopSend(): void {
    if (this.pendingLoad === null && this.sendState.state !== "sending") return;
    this.clearLoadTimer();
    this.pendingLoad = null;
    this.sendState = { ...this.sendState, state: "idle", error: null };
    this.changed();
  }

  private clearLoadTimer(): void {
    if (this.loadTimer) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  /** Drops the add-on's connection (it was uninstalled): the set is forgotten and the hotkeys released. */
  dropHelper(): void {
    const h = this.helper;
    if (!h) return;
    h.close(CLOSE.normal);
    this.onClose(h);
  }

  /** next / back / again / status / unload. Returns false with no add-on. */
  command(type: AppCommand): boolean {
    if (!this.helper) return false;
    this.helper.send(appMessage(this.nextId++, { type }));
    return true;
  }

  /** WebSocket only on /link (the add-on's connection test uses plain HTTP /probe). */
  private checkUpgrade(req: IncomingMessage): number | null {
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/link") return 404;
    if (!allowedHost(req.headers.host, this.boundPort)) return 403;
    if (!allowedOrigin(req.headers.origin)) {
      this.o.logger.info("link refused a connection from another origin");
      this.refused("origin");
      return 403;
    }
    if (this.waiting.size >= MAX_PENDING) {
      this.o.logger.info("link refused a connection: too many waiting for their hello");
      return 503;
    }
    return null;
  }

  /** Connections waiting for their hello. */
  private readonly waiting = new Map<WsConnection, ReturnType<typeof setTimeout>>();

  private onOpen(c: WsConnection): void {
    const timer = setTimeout(() => {
      this.waiting.delete(c);
      if (this.closed) return;
      this.refused("protocol");
      c.close(CLOSE.pairing);
    }, this.o.helloTimeoutMs ?? HELLO_TIMEOUT_MS);
    timer.unref();
    this.waiting.set(c, timer);
  }

  private onMessage(c: WsConnection, text: string): void {
    const m = parseHelperMessage(text);
    const timer = this.waiting.get(c);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.waiting.delete(c);
      const token = this.o.token();
      if (m?.type !== "hello" || token === null || !sameToken(m.token, token)) {
        this.refused(m?.type === "hello" ? "token" : "protocol");
        c.close(CLOSE.pairing);
        return;
      }
      if (this.helper && this.helper !== c) this.helper.close(CLOSE.replaced);
      this.helper = c;
      this.helperInfo = { state: "connected", version: m.addon ?? null, reason: null };
      this.o.logger.info("add-on connected", { version: m.addon ?? null });
      this.changed();
      return;
    }
    if (c !== this.helper) return;
    if (!m) {
      this.o.logger.info("add-on sent a malformed message (ignored)");
      return;
    }
    if (m.type === "state") this.onState(m);
    else if (m.type === "hotkeys") {
      this.sendHotkeys(this.hotkeys.request(m.hotkeys), m.id ?? null);
      this.changed();
    }
  }

  private onState(m: HelperState): void {
    this.set =
      m.phase === "empty" || m.total === 0
        ? null
        : {
            name: m.setName ?? "",
            chunk: m.chunk,
            total: m.total,
            phase: m.phase,
            finished: m.phase === "done",
            status: m.status,
            cause: m.cause ?? null,
          };
    if (this.pendingLoad !== null && m.replyTo === this.pendingLoad) {
      this.pendingLoad = null;
      this.clearLoadTimer();
      this.sendState = m.error
        ? { ...this.sendState, state: "failed", error: m.error }
        : { ...this.sendState, state: "loaded", error: null };
    }
    this.syncHotkeys(PLACING.has(m.phase) && m.total > 0);
    this.changed();
  }

  /** Holds the hotkeys exactly while a map is being placed, and tells the add-on when that changes. */
  private syncHotkeys(placing: boolean): void {
    if (placing === this.hotkeys.armed) return;
    this.sendHotkeys(placing ? this.hotkeys.arm() : this.hotkeys.disarm(), null);
  }

  private sendHotkeys(results: HotkeyResults, replyTo: string | number | null): void {
    this.helper?.send(appMessage(this.nextId++, { type: "hotkeys-result", replyTo, results }));
  }

  private onClose(c: WsConnection): void {
    const timer = this.waiting.get(c);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.waiting.delete(c);
    }
    if (c !== this.helper) return;
    this.helper = null;
    this.helperInfo = { state: "none", version: null, reason: null };
    this.set = null;
    // still waiting for an answer (also past the deadline): the add-on is gone, so it never comes
    if (this.pendingLoad !== null || this.sendState.state === "sending")
      this.sendState = { ...this.sendState, state: "failed", error: "The add-on disconnected." };
    this.pendingLoad = null;
    this.clearLoadTimer();
    this.hotkeys.disarm();
    this.o.logger.info("add-on disconnected");
    this.changed();
  }

  /** A connection without this app's pairing; kept until the next good one (a paired add-on wins). */
  private refused(reason: "token" | "origin" | "protocol"): void {
    if (this.helper) return;
    this.helperInfo = { state: "refused", version: null, reason };
    this.changed();
  }

  private changed(): void {
    if (this.closed) return; // nothing is reported after close()
    this.o.onChange(this.status());
  }
}
