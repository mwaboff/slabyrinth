#!/usr/bin/env node
/**
 * The other end of Slabyrinth Helper's "Test local connection" button: does a TaleSpire symbiote page reach a local
 * program over HTTP and WebSocket?
 *
 *   node symbiotes/local-test-server.mjs [port]      (default 48731; Ctrl+C to stop)
 *
 * No dependencies. Listens on 127.0.0.1 only, prints every request it receives (with its Origin header, which tells us
 * the symbiote page's origin), answers a short text, and answers WebSocket text messages with one reply.
 * It is a probe for one experiment, not the companion server the app would run.
 */
import { createHash } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 48731);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("Port must be a whole number from 1024 to 65535.");
  process.exit(1);
}
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const time = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`${time()}  ${msg}`);

const server = createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (d) => {
    if (body.length < 4096) body += d;
  });
  req.on("end", () => {
    log(
      `HTTP ${req.method} ${req.url}  Origin: ${req.headers.origin ?? "(none)"}${body ? `  body: ${body}` : ""}`,
    );
    res.writeHead(req.method === "OPTIONS" ? 204 : 200, {
      "Content-Type": "text/plain; charset=utf-8",
      // a probe: answer any origin so a blocked request is the browser's doing, not ours
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Private-Network": "true",
    });
    res.end(req.method === "OPTIONS" ? "" : "hello from the local test server");
  });
});

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  log(`WebSocket upgrade ${req.url}  Origin: ${req.headers.origin ?? "(none)"}`);
  if (typeof key !== "string") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  const accept = createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const frame = readFrame(buf);
      if (!frame) break;
      buf = buf.subarray(frame.length);
      if (frame.opcode === 0x8) {
        log("WebSocket closed by the page");
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (frame.opcode === 0x1) {
        log(`WebSocket message: ${frame.payload.toString("utf8")}`);
        socket.write(textFrame("hello from the local test server"));
      }
    }
  });
  socket.on("error", () => {});
});

/** One client frame (always masked), or null when more bytes are needed. Small frames only: this is a probe. */
function readFrame(b) {
  if (b.length < 2) return null;
  const opcode = b[0] & 0x0f;
  let len = b[1] & 0x7f;
  let off = 2;
  if (len === 126) {
    if (b.length < 4) return null;
    len = b.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    return { opcode: 0x8, payload: Buffer.alloc(0), length: b.length }; // too big for a probe: close
  }
  const masked = (b[1] & 0x80) !== 0;
  const maskLen = masked ? 4 : 0;
  if (b.length < off + maskLen + len) return null;
  const payload = Buffer.from(b.subarray(off + maskLen, off + maskLen + len));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= b[off + (i % 4)];
  return { opcode, payload, length: off + maskLen + len };
}

function textFrame(text) {
  const p = Buffer.from(text, "utf8");
  return Buffer.concat([Buffer.from([0x81, p.length]), p]); // under 126 bytes
}

server.on("error", (e) => {
  console.error(`Could not listen on 127.0.0.1:${port}: ${e.message}`);
  process.exit(1);
});
server.listen(port, "127.0.0.1", () => {
  log(
    `Listening on http://127.0.0.1:${port} and ws://127.0.0.1:${port} (this computer only). Ctrl+C to stop.`,
  );
});
process.on("SIGINT", () => {
  log("Stopped.");
  process.exit(0);
});
