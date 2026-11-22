/**
 * Tests only: a minimal WebSocket client (masked frames, as a browser sends them) with full control of the
 * handshake headers, so a test can play the add-on, another web page, or a DNS-rebinding page.
 */
import { randomBytes } from "node:crypto";
import { request } from "node:http";
import type { Duplex } from "node:stream";
import { OPCODE, encodeFrame, readFrame } from "../wsLite";

export interface TestClient {
  messages: string[];
  /** Close code from the server, once closed. */
  closedWith: number | null;
  send(text: string): void;
  sendRaw(buf: Buffer): void;
  close(): void;
  /** Resolves with the next message matching `test` (already received ones included). */
  next(test?: (m: string) => boolean, timeoutMs?: number): Promise<string>;
  closed(timeoutMs?: number): Promise<number | null>;
}

export async function connect(
  port: number,
  opts: { path?: string; origin?: string | null; host?: string } = {},
): Promise<TestClient | { refused: number }> {
  const headers: Record<string, string> = {
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
    Host: opts.host ?? `127.0.0.1:${String(port)}`,
  };
  const origin = opts.origin === undefined ? "http://localhost:59998" : opts.origin;
  if (origin !== null) headers["Origin"] = origin;
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: opts.path ?? "/link", headers });
    req.on("response", (res) => {
      res.resume();
      resolve({ refused: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.on("upgrade", (_res, socket: Duplex, head: Buffer) => {
      resolve(client(socket, head));
    });
    req.end();
  });
}

function client(socket: Duplex, head: Buffer): TestClient {
  const waiters: Array<() => void> = [];
  const wake = (): void => {
    for (const w of waiters.splice(0)) w();
  };
  let buf = head;
  const c: TestClient = {
    messages: [],
    closedWith: null,
    send: (text) => socket.write(encodeFrame(OPCODE.text, text, randomBytes(4))),
    sendRaw: (b) => socket.write(b),
    close: () => {
      socket.end(encodeFrame(OPCODE.close, Buffer.alloc(0), randomBytes(4)));
    },
    next: (test = () => true, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        let seen = 0;
        const check = (): boolean => {
          for (; seen < c.messages.length; seen++) {
            const m = c.messages[seen] ?? "";
            if (test(m)) {
              c.messages.splice(seen, 1);
              resolve(m);
              return true;
            }
          }
          return false;
        };
        if (check()) return;
        const timer = setTimeout(() => {
          reject(new Error("no matching message"));
        }, timeoutMs);
        const wait = (): void => {
          if (check()) clearTimeout(timer);
          else waiters.push(wait);
        };
        waiters.push(wait);
      }),
    closed: (timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        if (c.closedWith !== null) {
          resolve(c.closedWith);
          return;
        }
        const timer = setTimeout(() => {
          reject(new Error("not closed"));
        }, timeoutMs);
        const wait = (): void => {
          if (c.closedWith !== null) {
            clearTimeout(timer);
            resolve(c.closedWith);
          } else waiters.push(wait);
        };
        waiters.push(wait);
      }),
  };
  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const f = readFrame(buf, 64 * 1024 * 1024);
      if (!f || f.kind !== "frame") break;
      buf = buf.subarray(f.length);
      if (f.opcode === OPCODE.text) c.messages.push(f.payload.toString("utf8"));
      if (f.opcode === OPCODE.close) c.closedWith = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
    }
    wake();
  };
  socket.on("data", onData);
  socket.on("close", () => {
    if (c.closedWith === null) c.closedWith = 1006;
    wake();
  });
  socket.on("error", () => undefined);
  if (head.length) onData(Buffer.alloc(0));
  return c;
}
