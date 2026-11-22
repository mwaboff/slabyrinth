/**
 * The hotkey bridge without Electron: the WebSocket frames, the command line, the hotkey rule and manager (with a
 * fake globalShortcut), and the messages from the helper. No sockets are opened.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUTS,
  checkHotkey,
  createHotkeyManager,
  describeReply,
  linkMessage,
  parseBridgeArgs,
  parseHelperMessage,
} from "../link-bridge.mjs";
import { MAX_FRAME_BYTES, OPCODE, acceptKey, encodeFrame, readFrame, textFrame } from "../ws-lite.mjs";

/** A client (masked) frame, as a browser sends it. */
function clientFrame(text, mask = [1, 2, 3, 4]) {
  const p = Buffer.from(text, "utf8");
  const head =
    p.length < 126
      ? Buffer.from([0x81, 0x80 | p.length])
      : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 0xff]);
  const body = Buffer.from(p.map((b, i) => b ^ mask[i % 4]));
  return Buffer.concat([head, Buffer.from(mask), body]);
}

describe("ws-lite", () => {
  it("answers the handshake as RFC 6455's example does", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  it("reads masked client frames, short and long, and waits for the rest of a frame", () => {
    for (const text of ["hello", "x".repeat(300)]) {
      const f = clientFrame(text);
      expect(readFrame(f.subarray(0, f.length - 1))).toBeNull();
      const r = readFrame(Buffer.concat([f, Buffer.from([0x81])]));
      expect(r.opcode).toBe(OPCODE.text);
      expect(r.payload.toString("utf8")).toBe(text);
      expect(r.length).toBe(f.length);
    }
  });

  it("writes server frames of every length form", () => {
    for (const n of [5, 300, 70000]) {
      const f = textFrame("y".repeat(n));
      const r = readFrame(f);
      expect(r.payload.length).toBe(n);
    }
    expect(encodeFrame(OPCODE.close, Buffer.alloc(0))).toEqual(Buffer.from([0x88, 0]));
  });

  it("refuses a frame over the size limit", () => {
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES + 1), 2);
    expect(readFrame(head)).toEqual({ tooBig: true });
  });
});

describe("command line", () => {
  it("has left-hand defaults and takes overrides", () => {
    expect(DEFAULT_SHORTCUTS).toEqual({ next: "Ctrl+Alt+D", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" });
    const o = parseBridgeArgs(["--port=50123", "--next", "Ctrl+Alt+F", "--set=chunks.json"]);
    expect(o).toEqual({
      port: 50123,
      shortcuts: { next: "Ctrl+Alt+F", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" },
      setPath: "chunks.json",
      errors: [],
    });
    expect(parseBridgeArgs(["--port=80", "--frob", "--next"]).errors).toEqual([
      "--port must be from 1024 to 65535",
      "Unknown option --frob",
      "--next needs a value",
    ]);
  });
});

describe("hotkey rule", () => {
  it("maps only the allow-list to Electron accelerators", () => {
    expect(checkHotkey("Alt+Ctrl+D")).toEqual({
      ok: true,
      combo: "Ctrl+Alt+D",
      accelerator: "Control+Alt+D",
    });
    expect(checkHotkey("Ctrl+Shift+PageDown").accelerator).toBe("Control+Shift+PageDown");
    for (const bad of [
      "D",
      "Shift+D",
      "Super+D",
      "CommandOrControl+D",
      "Ctrl+Alt+Plus",
      "Ctrl+Alt+d",
      "Ctrl+Alt+D+E",
      "Ctrl+Alt+",
      "Ctrl+Ctrl+D",
      "Ctrl+Alt+D\nX",
      "",
    ])
      expect(checkHotkey(bad).ok).toBe(false);
  });

  it("agrees with the helper's own check", () => {
    const ctx = createContext({});
    runInContext(readFileSync(new URL("../slabyrinth-helper/sequencer.js", import.meta.url), "utf8"), ctx);
    const helper = ctx.SlabyrinthSequencer;
    const combos = [
      "Ctrl+Alt+D",
      "Alt+F4",
      "Shift+Alt+Up",
      "Ctrl+Space",
      "Shift+D",
      "Meta+D",
      "Ctrl+F25",
      "Ctrl+0",
      "X",
    ];
    for (const c of combos) {
      const b = checkHotkey(c);
      const h = helper.checkHotkey(c);
      expect([c, h.ok, h.combo]).toEqual([c, b.ok, b.combo]);
    }
  });
});

describe("hotkey manager", () => {
  function setup(taken = []) {
    const registered = new Map();
    const pressed = [];
    const m = createHotkeyManager({
      register: (accel, cb) => {
        if (taken.includes(accel) || registered.has(accel)) return false;
        registered.set(accel, cb);
        return true;
      },
      unregister: (accel) => registered.delete(accel),
      onCommand: (a) => pressed.push(a),
    });
    return { m, registered, pressed };
  }

  it("registers the defaults and runs the command on a press", () => {
    const { m, registered, pressed } = setup();
    const s = m.apply(DEFAULT_SHORTCUTS, "test");
    expect(s.next).toEqual({ status: "active", combo: "Ctrl+Alt+D" });
    expect([...registered.keys()].sort()).toEqual(["Control+Alt+A", "Control+Alt+D", "Control+Alt+S"]);
    registered.get("Control+Alt+D")();
    expect(pressed).toEqual(["next"]);
  });

  it("keeps the previous hotkey when the new one is taken by another program", () => {
    const { m, registered } = setup(["Control+Alt+F"]);
    m.apply(DEFAULT_SHORTCUTS, "test");
    const s = m.apply({ next: "Ctrl+Alt+F" }, "helper");
    expect(s.next).toEqual({
      status: "refused",
      combo: "Ctrl+Alt+D",
      wanted: "Ctrl+Alt+F",
      reason: "taken by another program",
    });
    expect(registered.has("Control+Alt+D")).toBe(true);
  });

  it("refuses invalid hotkeys and duplicates between actions, and lets two actions swap", () => {
    const { m, registered } = setup();
    m.apply(DEFAULT_SHORTCUTS, "test");
    expect(m.apply({ back: "Shift+D" }, "helper").back).toMatchObject({
      status: "refused",
      combo: "Ctrl+Alt+A",
    });
    expect(m.apply({ back: "Ctrl+Alt+D" }, "helper").back).toMatchObject({
      status: "refused",
      reason: "the same key as next",
    });
    const s = m.apply({ next: "Ctrl+Alt+A", back: "Ctrl+Alt+D" }, "helper");
    expect(s.next).toEqual({ status: "active", combo: "Ctrl+Alt+A" });
    expect(s.back).toEqual({ status: "active", combo: "Ctrl+Alt+D" });
    expect(registered.size).toBe(3);
    m.clear();
    expect(registered.size).toBe(0);
  });
});

describe("messages from the helper", () => {
  it("accepts state and hotkey requests, keeps only known actions, ignores the rest", () => {
    const state = JSON.stringify({
      protocol: "slabyrinth-link",
      version: 1,
      type: "state",
      chunk: 2,
      total: 3,
      phase: "inHand",
      status: "Chunk 2 of 3 is in your hand.",
    });
    expect(parseHelperMessage(state)).toEqual({
      kind: "state",
      line: "chunk 2 of 3 (inHand): Chunk 2 of 3 is in your hand.",
    });
    const hk = linkMessage("hotkeys", 4, { hotkeys: { next: "Ctrl+Alt+F", evil: "x", back: 5 } });
    expect(parseHelperMessage(hk)).toEqual({ kind: "hotkeys", id: 4, hotkeys: { next: "Ctrl+Alt+F" } });
    for (const bad of [
      "{",
      "null",
      linkMessage("hotkeys", 1),
      linkMessage("next", 1),
      JSON.stringify({ type: "state" }),
    ])
      expect(parseHelperMessage(bad)).toBeNull();
    expect(describeReply("nope")).toBeNull();
  });
});
