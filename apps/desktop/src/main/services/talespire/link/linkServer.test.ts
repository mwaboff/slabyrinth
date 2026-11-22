/**
 * The app's real link server on an ephemeral port, against the add-on's real protocol code (sequencer.js, driven as
 * app.js drives it) and against pages that must be refused. No real hotkey is registered: a fake registrar records.
 */
import { request } from "node:http";
import { connect as netConnect, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { LinkStatus } from "../../../../shared/ipc";
import { memoryLogger } from "../../../logger";
import {
  LinkServer,
  MAX_PENDING,
  allowedHost,
  allowedOrigin,
  httpAnswer,
  loadTimeoutError,
} from "./linkServer";
import { LINK_PROTOCOL, LINK_VERSION, type ChunkSet } from "./protocol";
import { connectAddon, loadSequencer } from "./testing/fakeAddon";
import { connect } from "./testing/wsClient";
import { OPCODE, encodeFrame } from "./wsLite";

const TOKEN = "a".repeat(48);
// a tiny real slab with one asset
const SLAB = "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==";
const SET: ChunkSet = {
  format: "slabyrinth-chunks",
  version: 1,
  name: "Two halves",
  size: { w: 20, h: 10 },
  levels: 1,
  chunks: [
    { label: "West (l1-01)", slab: SLAB },
    { label: "East (l1-02)", slab: SLAB },
  ],
};

interface RigOptions {
  taken?: string[];
  helloTimeoutMs?: number;
  loadTimeoutMs?: number;
}

function rig(opts: RigOptions = {}) {
  const registered = new Map<string, () => void>();
  const changes: LinkStatus[] = [];
  const server = new LinkServer({
    port: 0,
    token: () => TOKEN,
    wayland: false,
    logger: memoryLogger(),
    ...(opts.helloTimeoutMs !== undefined ? { helloTimeoutMs: opts.helloTimeoutMs } : {}),
    ...(opts.loadTimeoutMs !== undefined ? { loadTimeoutMs: opts.loadTimeoutMs } : {}),
    registrar: {
      register: (acc, cb) => {
        if (opts.taken?.includes(acc) || registered.has(acc)) return false;
        registered.set(acc, cb);
        return true;
      },
      unregister: (acc) => {
        registered.delete(acc);
      },
    },
    onChange: (s) => changes.push(s),
  });
  return { server, registered, changes };
}

const servers: LinkServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function started(opts: RigOptions = {}) {
  const r = rig(opts);
  servers.push(r.server);
  await r.server.start();
  return r;
}

async function waitFor(test: () => boolean, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!test()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("who may connect", () => {
  it("listens on 127.0.0.1 on an ephemeral port", async () => {
    const { server } = await started();
    expect(server.port).toBeGreaterThan(0);
    expect(server.status().server).toEqual({ state: "listening", port: server.port });
  });

  it("refuses another origin, a missing origin, a rebinding host and an unknown path before the handshake", async () => {
    const { server } = await started();
    const p = server.port;
    expect(await connect(p, { origin: "https://evil.example" })).toEqual({ refused: 403 });
    expect(await connect(p, { origin: null })).toEqual({ refused: 403 });
    expect(await connect(p, { origin: "http://localhost.evil.com" })).toEqual({ refused: 403 });
    expect(await connect(p, { host: `evil.example:${String(p)}` })).toEqual({ refused: 403 });
    expect(await connect(p, { path: "/other" })).toEqual({ refused: 404 });
    // the connection test is plain HTTP: no WebSocket on /probe
    expect(await connect(p, { path: "/probe" })).toEqual({ refused: 404 });
    expect(server.status().helper.state).toBe("refused");
  });

  it("closes a connection with the wrong token, or none, with 4001 and reports it refused", async () => {
    const { server } = await started();
    const c = await connect(server.port);
    if ("refused" in c) throw new Error("refused");
    c.send(
      JSON.stringify({
        protocol: LINK_PROTOCOL,
        version: LINK_VERSION,
        type: "hello",
        token: "b".repeat(48),
      }),
    );
    expect(await c.closed()).toBe(4001);
    expect(server.status().helper).toEqual({ state: "refused", version: null, reason: "token" });
    const old = await connect(server.port);
    if ("refused" in old) throw new Error("refused");
    // an add-on from before pairing starts with its state, not a hello
    old.send(
      JSON.stringify({ protocol: LINK_PROTOCOL, version: LINK_VERSION, type: "state", chunk: 0, total: 0 }),
    );
    expect(await old.closed()).toBe(4001);
    expect(server.status().helper.reason).toBe("protocol");
  });

  it("closes an unmasked, binary or oversized frame", async () => {
    const { server } = await started();
    for (const bad of [
      encodeFrame(OPCODE.text, "hi"), // unmasked
      encodeFrame(OPCODE.binary, Buffer.from([1, 2]), Buffer.from([1, 2, 3, 4])),
      encodeFrame(OPCODE.text, "x".repeat(70 * 1024), Buffer.from([1, 2, 3, 4])),
    ]) {
      const c = await connect(server.port);
      if ("refused" in c) throw new Error("refused");
      c.sendRaw(bad);
      expect([1002, 1009]).toContain(await c.closed());
    }
  });

  it("answers the add-on's HTTP connection test for local pages only", async () => {
    const { server } = await started();
    const get = (origin: string, host = `127.0.0.1:${String(server.port)}`) =>
      new Promise<{ status: number; cors: string | undefined }>((resolve, reject) => {
        const req = request({
          host: "127.0.0.1",
          port: server.port,
          path: "/probe",
          headers: { Origin: origin, Host: host },
        });
        req.on("response", (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, cors: res.headers["access-control-allow-origin"] });
        });
        req.on("error", reject);
        req.end();
      });
    expect(await get("http://localhost:59998")).toEqual({ status: 200, cors: "http://localhost:59998" });
    expect((await get("https://evil.example")).cors).toBeUndefined();
    expect((await get("http://localhost:1", "evil.example")).status).toBe(403);
    expect(httpAnswer("GET", "/", "http://localhost:1").status).toBe(404);
    expect(httpAnswer("DELETE", "/probe", "http://localhost:1").status).toBe(405);
    expect(allowedOrigin("http://127.0.0.1:5000")).toBe(true);
    for (const o of ["null", "http://localhost:1/x", "https://localhost:3", undefined])
      expect(allowedOrigin(o)).toBe(false);
    expect(allowedHost("localhost:7", 7)).toBe(true);
    expect(allowedHost("localhost:8", 7)).toBe(false);
  });
});

describe("a map through the link, with the add-on's own code", () => {
  it("pairs, loads a set, holds the hotkeys while placing, and releases them at the end", async () => {
    const { server, registered } = await started();
    const addon = await connectAddon(server.port, TOKEN, { version: "0.2.0" });
    await waitFor(() => server.status().helper.state === "connected");
    expect(server.status().helper).toEqual({ state: "connected", version: "0.2.0", reason: null });
    expect(server.status().hotkeys.state).toBe("off");
    expect(registered.size).toBe(0);

    server.load(SET, "build-1");
    await addon.until((s) => s.set !== null);
    await waitFor(() => server.status().send.state === "loaded");
    expect(server.status().set).toMatchObject({
      name: "Two halves",
      chunk: 1,
      total: 2,
      phase: "ready",
      finished: false,
    });
    // a map is being placed: the three hotkeys are registered, and the add-on is told
    await waitFor(() => registered.size === 3);
    expect([...registered.keys()].sort()).toEqual(["Control+Alt+A", "Control+Alt+D", "Control+Alt+S"]);
    await waitFor(() => addon.hotkeys()?.next?.status === "active");

    // the hotkeys drive the add-on: Next puts chunk 1 in hand, Next again chunk 2, Back chunk 1, Again resends
    registered.get("Control+Alt+D")?.();
    await addon.until((s) => s.phase === "inHand" && s.index === 0);
    registered.get("Control+Alt+D")?.();
    await addon.until((s) => s.phase === "inHand" && s.index === 1);
    registered.get("Control+Alt+A")?.();
    await addon.until((s) => s.phase === "inHand" && s.index === 0);
    registered.get("Control+Alt+S")?.();
    await waitFor(() => addon.hand.length === 4);
    expect(addon.hand).toEqual(["West (l1-01)", "East (l1-02)", "West (l1-01)", "West (l1-01)"]);
    await waitFor(() => server.status().set?.chunk === 1 && server.status().set?.phase === "inHand");

    // the panel's own buttons are followed too, up to the end: finished, hotkeys released
    addon.press("next");
    addon.press("next");
    await waitFor(() => server.status().set?.finished === true);
    await waitFor(() => registered.size === 0);
    expect(server.status().hotkeys.state).toBe("off");
    await waitFor(() => addon.hotkeys()?.next?.status === "standby");

    // Start over (Again after the end) holds them again; unload drops the set and releases them
    addon.press("send");
    await waitFor(() => registered.size === 3);
    server.command("unload");
    await addon.until((s) => s.set === null);
    await waitFor(() => server.status().set === null && registered.size === 0);
  });

  it("reports a set the add-on refuses as a failed send", async () => {
    const { server } = await started();
    const addon = await connectAddon(server.port, TOKEN);
    await waitFor(() => server.connected);
    // an empty slab (no assets): the add-on's own check refuses the whole set
    const empty = gzipSync(Buffer.alloc(12)).toString("base64");
    server.load({ ...SET, chunks: [{ label: "Empty", slab: empty }] }, "b2");
    await waitFor(() => server.status().send.state === "failed");
    expect(server.status().send.error).toMatch(/no assets|not a slab|not base64/);
    expect(addon.state().set).toBeNull();
  });

  it("takes the GM's hotkeys from the add-on, refuses a key another program holds, and keeps the old one", async () => {
    const { server, registered } = await started({ taken: ["Control+Alt+F"] });
    const addon = await connectAddon(server.port, TOKEN, { hotkeys: { next: "Ctrl+Alt+G" } });
    await waitFor(() => addon.hotkeys()?.next?.combo === "Ctrl+Alt+G");
    expect(addon.hotkeys()?.next?.status).toBe("standby");
    server.load(SET, "b3");
    await waitFor(() => registered.has("Control+Alt+G"));
    addon.ws.send(JSON.stringify(addon.seq.hotkeysMessage({ next: "Ctrl+Alt+F" }, 2)));
    await waitFor(() => addon.hotkeys()?.next?.status === "refused");
    expect(addon.hotkeys()?.next).toMatchObject({
      combo: "Ctrl+Alt+G",
      wanted: "Ctrl+Alt+F",
      reason: "taken by another program",
    });
    expect(registered.has("Control+Alt+G")).toBe(true);
  });

  it("releases everything when the add-on leaves, and a new paired add-on replaces the old", async () => {
    const { server, registered } = await started();
    const a = await connectAddon(server.port, TOKEN);
    await waitFor(() => server.connected);
    server.load(SET, "b4");
    await waitFor(() => registered.size === 3);
    const b = await connectAddon(server.port, TOKEN, { version: "0.3.0" });
    expect(await a.ws.closed()).toBe(4000);
    await waitFor(() => server.status().helper.version === "0.3.0");
    expect(registered.size).toBe(0);
    b.ws.close();
    await waitFor(() => server.status().helper.state === "none");
    expect(server.status().set).toBeNull();
  });

  it("reports a port another program holds, without throwing", async () => {
    const first = await started();
    const second = new LinkServer({
      port: first.server.port,
      token: () => TOKEN,
      wayland: true,
      logger: memoryLogger(),
      registrar: { register: () => true, unregister: () => undefined },
      onChange: () => undefined,
    });
    servers.push(second);
    await second.start();
    expect(second.status().server.state).toBe("port_in_use");
    expect(second.status().hotkeys.wayland).toBe(true);
  });
});

const MASK = Buffer.from([9, 8, 7, 6]);
const hello = (token = TOKEN): string =>
  JSON.stringify({ protocol: LINK_PROTOCOL, version: LINK_VERSION, type: "hello", token });

async function client(port: number, opts: Parameters<typeof connect>[1] = {}) {
  const c = await connect(port, opts);
  if ("refused" in c) throw new Error(`refused ${String(c.refused)}`);
  return c;
}

/** A plain TCP connection that sends `text` and keeps whatever comes back. */
function rawSocket(port: number, text: Buffer | string): Promise<{ socket: Socket; received: () => string }> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const socket = netConnect({ host: "127.0.0.1", port, allowHalfOpen: true }, () => {
      socket.write(text);
      resolve({ socket, received: () => got.toString("latin1") });
    });
    socket.on("data", (d: Buffer) => {
      got = Buffer.concat([got, d]);
    });
    socket.on("error", reject);
  });
}

describe("frames and timers", () => {
  it("closes a connection that never says hello, and reports it refused", async () => {
    const { server } = await started({ helloTimeoutMs: 100 });
    const c = await client(server.port);
    expect(await c.closed()).toBe(4001);
    expect(server.status().helper).toEqual({ state: "refused", version: null, reason: "protocol" });
  });

  it("answers a ping with a pong, closes on a client close frame, and refuses a fragmented frame", async () => {
    const { server } = await started();
    const c = await client(server.port);
    c.send(hello());
    await waitFor(() => server.connected);
    c.sendRaw(encodeFrame(OPCODE.ping, "are you there", MASK));
    await waitFor(() => c.opcodes.includes(OPCODE.pong));
    c.close();
    expect(await c.closed()).toBe(1000);
    await waitFor(() => !server.connected);

    const f = await client(server.port);
    const first = encodeFrame(OPCODE.text, '{"protocol":', MASK);
    first[0] = (first[0] ?? 0) & 0x7f; // FIN off: the first part of a fragmented message
    f.sendRaw(first);
    expect(await f.closed()).toBe(1002);
  });

  it("reads bytes the client sent right behind its handshake", async () => {
    const { server } = await started();
    const handshake =
      `GET /link HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\nOrigin: http://localhost:59998\r\n` +
      "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
      "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n";
    const raw = await rawSocket(
      server.port,
      Buffer.concat([Buffer.from(handshake, "latin1"), encodeFrame(OPCODE.text, hello(), MASK)]),
    );
    await waitFor(() => server.connected);
    expect(raw.received()).toMatch(/^HTTP\/1\.1 101/);
    raw.socket.destroy();
  });

  it("refuses more than a few connections waiting for their hello", async () => {
    const { server } = await started();
    const waiting = [];
    for (let i = 0; i < MAX_PENDING; i++) waiting.push(await client(server.port));
    expect(await connect(server.port)).toEqual({ refused: 503 });
    // once one has paired, there is room again
    waiting[0]?.send(hello());
    await waitFor(() => server.connected);
    await client(server.port);
  });
});

describe("close", () => {
  it("returns at once with silent peers still open: paired, unpaired, plain HTTP and idle TCP", async () => {
    const { server, changes } = await started({ helloTimeoutMs: 300, loadTimeoutMs: 300 });
    const paired = await client(server.port, { silent: true });
    paired.send(hello());
    await waitFor(() => server.connected);
    server.load(SET, "b-close");
    const unpaired = await client(server.port, { silent: true });
    const http = await rawSocket(
      server.port,
      `GET /probe HTTP/1.1\r\nHost: 127.0.0.1:${String(server.port)}\r\n\r\n`,
    );
    const idle = await rawSocket(server.port, "");
    const t0 = Date.now();
    await server.close();
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(paired.closedWith).not.toBeNull();
    expect(unpaired.closedWith).not.toBeNull();
    // the hello and send timers went with it: nothing is reported after close
    const seen = changes.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(changes.length).toBe(seen);
    for (const s of [http.socket, idle.socket]) s.destroy();
  });
});

describe("a send that is not answered", () => {
  it("times out with a plain reason, a late answer still settles it, and Stop ends it", async () => {
    const { server } = await started({ loadTimeoutMs: 100 });
    const c = await client(server.port);
    c.send(hello());
    await waitFor(() => server.connected);
    expect(server.load(SET, "b-late")).toBe(true);
    expect(server.status().send.state).toBe("sending");
    await waitFor(() => server.status().send.state === "failed");
    expect(server.status().send.error).toBe(loadTimeoutError(100));
    expect(loadTimeoutError(30_000)).toMatch(/^The add-on didn't answer within 30 seconds\./);
    const load = JSON.parse(await c.next((m) => m.includes('"load"'))) as { id: number };
    const seq = loadSequencer();
    c.send(JSON.stringify(seq.linkReply(seq.initialState(), load.id)));
    await waitFor(() => server.status().send.state === "loaded");

    server.load(SET, "b-stop");
    server.stopSend();
    expect(server.status().send).toMatchObject({ state: "idle", buildId: "b-stop", error: null });
    c.close();
    await waitFor(() => !server.connected);
    expect(server.load(SET, "b-gone")).toBe(false);
  });

  it("a disconnect while sending (or after the deadline) is a plain failure", async () => {
    const { server } = await started({ loadTimeoutMs: 100 });
    const c = await client(server.port);
    c.send(hello());
    await waitFor(() => server.connected);
    server.load(SET, "b-drop");
    await waitFor(() => server.status().send.error === loadTimeoutError(100));
    c.close();
    await waitFor(() => server.status().send.error === "The add-on disconnected.");
    expect(server.status().send.state).toBe("failed");
  });
});
