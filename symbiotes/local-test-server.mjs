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
import { createServer } from "node:http";
import { attachWebSocket } from "./ws-lite.mjs";

const port = Number(process.argv[2] ?? 48731);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  console.error("Port must be a whole number from 1024 to 65535.");
  process.exit(1);
}
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

attachWebSocket(server, {
  onOpen: (c) => log(`WebSocket open ${c.url}  Origin: ${c.origin}`),
  onMessage: (c, text) => {
    log(`WebSocket message: ${text}`);
    c.send("hello from the local test server");
  },
  onClose: () => log("WebSocket closed"),
});

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
