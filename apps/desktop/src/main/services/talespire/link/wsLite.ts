/**
 * A small dependency-free WebSocket server side (RFC 6455) for the add-on link: the handshake, frame reading and
 * writing, and `attachWebSocket` to serve it from a node:http server. Text frames only, no extensions; a fragmented,
 * binary, unmasked or oversized client frame closes the connection. Enough for one local page that sends small JSON
 * messages, not a general WebSocket library.
 *
 * Why not the `ws` package: the app bundles every dependency into out/ (electron-vite, no node_modules shipped), `ws`
 * pulls optional native add-ons (bufferutil, utf-8-validate) the bundler has to be taught to skip, and the link needs
 * none of its features. This file is ~200 lines with its own tests, and every byte from the socket goes through it.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;
/** Close codes the link uses (4000-4999 are free for applications). */
export const CLOSE = {
  normal: 1000,
  tooBig: 1009,
  protocol: 1002,
  replaced: 4000,
  pairing: 4001,
  origin: 4003,
} as const;

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

export type Frame =
  | { kind: "frame"; fin: boolean; opcode: number; masked: boolean; payload: Buffer; length: number }
  | { kind: "tooBig" };

/**
 * One frame from the start of `b`, null when more bytes are needed, or { kind: "tooBig" } for a frame over `max`
 * payload bytes. Unmasks a masked (client) frame.
 */
export function readFrame(b: Buffer, max: number): Frame | null {
  if (b.length < 2) return null;
  const b0 = b[0] ?? 0;
  const b1 = b[1] ?? 0;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    const big = b.readBigUInt64BE(2);
    if (big > BigInt(max)) return { kind: "tooBig" };
    len = Number(big);
    off = 10;
  }
  if (len > max) return { kind: "tooBig" };
  const masked = (b1 & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (b.length < off + maskLen + len) return null;
  const payload = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
  if (masked)
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (b[off + (i % 4)] ?? 0);
  return {
    kind: "frame",
    fin: (b0 & 0x80) !== 0,
    opcode: b0 & 0x0f,
    masked,
    payload,
    length: off + maskLen + len,
  };
}

/** A frame of any size; with `mask` (4 bytes) it is a client frame. */
export function encodeFrame(opcode: number, payload: Buffer | string, mask?: Buffer): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const m = mask ? 0x80 : 0;
  let head: Buffer;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, m | p.length]);
  else if (p.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = m | 126;
    head.writeUInt16BE(p.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = m | 127;
    head.writeBigUInt64BE(BigInt(p.length), 2);
  }
  if (!mask) return Buffer.concat([head, p]);
  const body = Buffer.from(p.map((byte, i) => byte ^ (mask[i % 4] ?? 0)));
  return Buffer.concat([head, mask, body]);
}

/** A close frame with a code (and no reason text). */
export function closeFrame(code: number): Buffer {
  const p = Buffer.alloc(2);
  p.writeUInt16BE(code, 0);
  return encodeFrame(OPCODE.close, p);
}

export interface WsConnection {
  readonly id: number;
  /** The request path, without the query. */
  readonly path: string;
  readonly origin: string | null;
  send(text: string): void;
  close(code?: number): void;
}

export interface WsHandlers {
  /** Decides before the handshake: a status code refuses the upgrade (403, 404), null accepts it. */
  checkUpgrade(req: IncomingMessage): number | null;
  onOpen(c: WsConnection): void;
  onMessage(c: WsConnection, text: string): void;
  onClose(c: WsConnection): void;
  /** Largest client message, in bytes; anything bigger closes the connection (1009). */
  maxMessageBytes: number;
}

/**
 * The close code a client frame ends the connection with, or null to go on: browsers mask every frame and send small
 * text messages whole, so a fragmented, unmasked, binary or oversized frame is refused; a close frame closes.
 */
export function frameStop(frame: Frame): number | null {
  if (frame.kind === "tooBig") return CLOSE.tooBig;
  if (!frame.masked || !frame.fin) return CLOSE.protocol;
  if (frame.opcode === OPCODE.close) return CLOSE.normal;
  const ok: number[] = [OPCODE.text, OPCODE.ping, OPCODE.pong];
  return ok.includes(frame.opcode) ? null : CLOSE.protocol;
}

const STATUS_TEXT: Record<number, string> = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found" };

function refuse(socket: Duplex, status: number): void {
  socket.end(`HTTP/1.1 ${String(status)} ${STATUS_TEXT[status] ?? "Refused"}\r\nConnection: close\r\n\r\n`);
}

/** Serves WebSocket connections from an http server's "upgrade" event. Returns the set of open connections. */
export function attachWebSocket(server: Server, h: WsHandlers): Set<WsConnection> {
  const open = new Set<WsConnection>();
  let nextId = 1;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    socket.on("error", () => socket.destroy());
    const key = req.headers["sec-websocket-key"];
    const upgrade = (req.headers.upgrade ?? "").toLowerCase();
    if (typeof key !== "string" || upgrade !== "websocket" || req.headers["sec-websocket-version"] !== "13") {
      refuse(socket, 400);
      return;
    }
    const status = h.checkUpgrade(req);
    if (status !== null) {
      refuse(socket, status);
      return;
    }
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );
    let closed = false;
    const conn: WsConnection = {
      id: nextId++,
      path: (req.url ?? "").split("?")[0] ?? "",
      origin: typeof req.headers.origin === "string" ? req.headers.origin : null,
      send: (text) => {
        if (!closed) socket.write(encodeFrame(OPCODE.text, text));
      },
      close: (code = CLOSE.normal) => {
        if (closed) return;
        closed = true;
        socket.end(closeFrame(code));
      },
    };
    open.add(conn);
    const gone = (): void => {
      if (!open.delete(conn)) return;
      closed = true;
      h.onClose(conn);
    };
    const fail = (code: number): void => {
      conn.close(code);
      gone();
    };
    h.onOpen(conn);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (closed) return;
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = readFrame(buf, h.maxMessageBytes);
        if (!frame) {
          // a header that promises more than the limit is caught above; this stops a slow trickle of junk
          if (buf.length > h.maxMessageBytes + 14) fail(CLOSE.tooBig);
          return;
        }
        const stop = frameStop(frame);
        if (stop !== null) {
          fail(stop);
          return;
        }
        if (frame.kind !== "frame") return;
        buf = buf.subarray(frame.length);
        if (frame.opcode === OPCODE.ping) socket.write(encodeFrame(OPCODE.pong, frame.payload));
        else if (frame.opcode === OPCODE.text) h.onMessage(conn, frame.payload.toString("utf8"));
      }
    });
    socket.on("close", gone);
  });
  return open;
}
