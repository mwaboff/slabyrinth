/**
 * A tiny dependency-free WebSocket server side (RFC 6455) for the symbiote experiments: the handshake, frame
 * reading and writing, and `attachWebSocket` to serve it from a node:http server. Text frames only, no extensions,
 * no fragmentation (browsers send small messages whole); enough for a local probe and the hotkey bridge, not a
 * general WebSocket library.
 */
import { createHash } from "node:crypto";

export const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** Largest frame accepted from a client; anything bigger closes the connection. */
export const MAX_FRAME_BYTES = 1 << 20;

export const OPCODE = { text: 0x1, close: 0x8, ping: 0x9, pong: 0xa };

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export function acceptKey(key) {
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
}

export function handshakeResponse(key) {
  return (
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
  );
}

/**
 * One frame from the start of `b`: { opcode, payload, length } (length = bytes used), null when more bytes are
 * needed, or { tooBig: true } for a frame over MAX_FRAME_BYTES. Unmasks a masked (client) frame.
 */
export function readFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (b.length < 10) return null;
    const big = b.readBigUInt64BE(2);
    if (big > BigInt(MAX_FRAME_BYTES)) return { tooBig: true };
    len = Number(big);
    off = 10;
  }
  if (len > MAX_FRAME_BYTES) return { tooBig: true };
  const masked = (b[1] & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (b.length < off + maskLen + len) return null;
  const payload = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[off + (i % 4)];
  return { opcode, payload, length: off + maskLen + len };
}

/** An unmasked (server) frame of any size. */
export function encodeFrame(opcode, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let head;
  if (p.length < 126) head = Buffer.from([0x80 | opcode, p.length]);
  else if (p.length < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(p.length, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(p.length), 2);
  }
  return Buffer.concat([head, p]);
}

export const textFrame = (text) => encodeFrame(OPCODE.text, text);

/**
 * Serves WebSocket connections from an http server's "upgrade" event. Handlers get a connection object
 * `{ id, origin, send(text), close() }`. Returns the set of open connections.
 */
export function attachWebSocket(server, { onOpen, onMessage, onClose } = {}) {
  const open = new Set();
  let nextId = 1;
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    socket.write(handshakeResponse(key));
    let closed = false;
    const conn = {
      id: nextId++,
      origin: req.headers.origin ?? "(none)",
      url: req.url,
      send: (text) => {
        if (!closed) socket.write(textFrame(text));
      },
      close: () => {
        if (closed) return;
        closed = true;
        socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0)));
      },
    };
    open.add(conn);
    const gone = () => {
      if (!open.delete(conn)) return;
      closed = true;
      onClose?.(conn);
    };
    onOpen?.(conn);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const frame = readFrame(buf);
        if (!frame) break;
        if (frame.tooBig) {
          conn.close();
          gone();
          return;
        }
        buf = buf.subarray(frame.length);
        if (frame.opcode === OPCODE.close) {
          conn.close();
          gone();
          return;
        }
        if (frame.opcode === OPCODE.ping) socket.write(encodeFrame(OPCODE.pong, frame.payload));
        else if (frame.opcode === OPCODE.text) onMessage?.(conn, frame.payload.toString("utf8"));
      }
    });
    socket.on("close", gone);
    socket.on("error", gone);
  });
  return open;
}
