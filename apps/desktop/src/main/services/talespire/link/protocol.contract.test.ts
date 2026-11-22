/**
 * The `slabyrinth-link` contract, both sides: the app's protocol.ts against the add-on's own sequencer.js (plain
 * JavaScript with no build step, loaded as TaleSpire loads it). What one side writes, the other must read; the
 * constants, the message types and the hotkey rule must agree. A change on one side alone fails here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APP_COMMANDS,
  APP_MESSAGE_TYPES,
  DEFAULT_HOTKEYS,
  DEFAULT_LINK_PORT,
  HELPER_MESSAGE_TYPES,
  HOTKEY_ACTIONS,
  LINK_CONFIG_FILE,
  LINK_MAX_CHARS,
  LINK_PROTOCOL,
  LINK_VERSION,
  MAX_CHUNKS,
  appMessage,
  checkHotkey,
  parseHelperMessage,
  type ChunkSet,
} from "./protocol";
import { HELPER_DIR, loadSequencer } from "./testing/fakeAddon";
import { CLOSE } from "./wsLite";

const Seq = loadSequencer();
const SLAB = "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==";

describe("slabyrinth-link: the constants agree", () => {
  it("pins the protocol name, version, limits, pairing file and close code", () => {
    expect([LINK_PROTOCOL, LINK_VERSION]).toEqual(["slabyrinth-link", 1]);
    expect([Seq.LINK_PROTOCOL, Seq.LINK_VERSION]).toEqual([LINK_PROTOCOL, LINK_VERSION]);
    expect(Seq.LINK_MAX_CHARS).toBe(LINK_MAX_CHARS);
    expect(Seq.MAX_CHUNKS).toBe(MAX_CHUNKS);
    expect(Seq.LINK_CONFIG_FILE).toBe(LINK_CONFIG_FILE);
    expect(Seq.LINK_CLOSE_PAIRING).toBe(CLOSE.pairing);
    expect(DEFAULT_LINK_PORT).toBe(48731);
    expect([...Seq.HOTKEY_ACTIONS]).toEqual([...HOTKEY_ACTIONS]);
    expect({ ...Seq.DEFAULT_HOTKEYS }).toEqual(DEFAULT_HOTKEYS);
  });

  it("the add-on reads every type the app sends, and the page's default port is the app's", () => {
    expect([...Seq.LINK_TYPES].sort()).toEqual([...APP_MESSAGE_TYPES].sort());
    const page = readFileSync(new URL("app.js", HELPER_DIR), "utf8");
    expect(page).toMatch(new RegExp(`const DEFAULT_PORT = ${String(DEFAULT_LINK_PORT)};`));
  });

  it("checks hotkeys with the same rule", () => {
    const combos = [
      "Ctrl+Alt+D",
      "Alt+Ctrl+D",
      "Alt+F4",
      "Shift+Alt+Up",
      "Ctrl+Space",
      "Shift+D",
      "Meta+D",
      "Ctrl+F25",
    ];
    for (const c of [...combos, "Ctrl+0", "X", "Ctrl+Alt+d", "Ctrl+Ctrl+D", "", "Ctrl+Alt+PageDown"]) {
      const app = checkHotkey(c);
      const helper = Seq.checkHotkey(c);
      expect([c, helper.ok, helper.combo]).toEqual([c, app.ok, app.ok ? app.combo : undefined]);
    }
  });
});

describe("slabyrinth-link: helper -> app", () => {
  it("the app accepts the add-on's hello, state and hotkeys messages exactly as the add-on writes them", () => {
    const hello = parseHelperMessage(JSON.stringify(Seq.helloMessage("f".repeat(48), "0.2.0")));
    expect(hello).toMatchObject({ type: "hello", token: "f".repeat(48), addon: "0.2.0" });
    const set = Seq.parseChunkSet(
      JSON.stringify({
        format: "slabyrinth-chunks",
        version: 1,
        name: "M",
        chunks: [{ label: "A", slab: SLAB }],
      }),
    ).set;
    let state = Seq.initialState();
    expect(parseHelperMessage(JSON.stringify(Seq.linkReply(state, null)))).toMatchObject({
      type: "state",
      phase: "empty",
      total: 0,
    });
    state = Seq.reduce(state, { type: "load", set }).state;
    for (const phase of ["ready", "sending", "inHand", "failed", "done"]) {
      const s = {
        ...state,
        phase,
        cause: phase === "failed" ? "System.Exception\n   at ".repeat(200) : null,
      };
      const m = parseHelperMessage(
        JSON.stringify(Seq.linkReply(s, 7, phase === "failed" ? "bad" : undefined)),
      );
      if (m?.type !== "state") throw new Error(`state ${phase} refused`);
      expect(m).toMatchObject({ phase, replyTo: 7, setName: "M", chunk: 1, total: 1 });
      expect((m.cause ?? "").length).toBeLessThanOrEqual(300);
    }
    expect(parseHelperMessage(JSON.stringify(Seq.hotkeysMessage({ next: "Ctrl+Alt+F" }, 3)))).toEqual({
      protocol: LINK_PROTOCOL,
      version: LINK_VERSION,
      type: "hotkeys",
      id: 3,
      hotkeys: { next: "Ctrl+Alt+F" },
    });
    expect([...HELPER_MESSAGE_TYPES]).toEqual(["hello", "state", "hotkeys"]);
  });

  it("the app refuses what does not fit the contract", () => {
    for (const bad of [
      "{",
      "null",
      JSON.stringify({ ...Seq.helloMessage("x", null), protocol: "other" }),
      JSON.stringify({ ...Seq.helloMessage("x", null), version: 2 }),
      JSON.stringify({ protocol: LINK_PROTOCOL, version: 1, type: "next" }),
      JSON.stringify({ ...Seq.linkReply(Seq.initialState(), null), total: 501 }),
      JSON.stringify({ ...Seq.helloMessage("x", null), token: "" }),
      "x".repeat(70 * 1024),
    ])
      expect(parseHelperMessage(bad)).toBeNull();
  });
});

describe("slabyrinth-link: app -> helper", () => {
  it("the add-on reads every command the app sends and acts on it", () => {
    for (const type of APP_COMMANDS) {
      const m = Seq.parseLinkMessage(appMessage(5, { type }));
      expect(m).toEqual({ type, id: 5 });
    }
    expect(Seq.linkCommand({ type: "next", id: 1 }).action).toEqual({ type: "next" });
    expect(Seq.linkCommand({ type: "again", id: 1 }).action).toEqual({ type: "send" });
    expect(Seq.linkCommand({ type: "unload", id: 1 }).action).toEqual({ type: "unload" });
    expect(Seq.linkCommand({ type: "status", id: 1 })).toEqual({});
  });

  it("the add-on loads the chunk set the app builds, with its size and levels", () => {
    const set: ChunkSet = {
      format: "slabyrinth-chunks",
      version: 1,
      name: "Keep",
      size: { w: 40, h: 30 },
      levels: 2,
      chunks: [{ label: "West (l1-01)", slab: SLAB }],
    };
    const m = Seq.parseLinkMessage(appMessage(9, { type: "load", set }));
    if (!m) throw new Error("the add-on refused the load message");
    const loaded = Seq.linkCommand(m, Seq.DEFAULT_MAX_BYTES).action;
    expect(loaded?.type).toBe("load");
    if (!loaded?.set) throw new Error("no set");
    expect(loaded.set).toMatchObject({ name: "Keep", size: { w: 40, h: 30 }, levels: 2 });
    expect(Seq.mapInfo(loaded.set)?.meta).toBe("1 chunk · 40 × 30 cells · 2 levels");
  });

  it("the add-on reads the paste anchor the app sends and says where the cursor goes and which pillars to delete", () => {
    const anchor = { side: "south", clearanceCells: 4, farMarkerCells: 31 } as const;
    const set: ChunkSet = {
      format: "slabyrinth-chunks",
      version: 1,
      name: "Keep",
      anchor,
      chunks: [
        { label: "West (l1-01)", slab: SLAB },
        { label: "East (l1-02)", slab: SLAB },
      ],
    };
    const m = Seq.parseLinkMessage(appMessage(9, { type: "load", set }));
    if (!m) throw new Error("the add-on refused the load message");
    const loaded = Seq.linkCommand(m, Seq.DEFAULT_MAX_BYTES).action;
    if (!loaded?.set) throw new Error("no set");
    expect(loaded.set.anchor).toEqual(anchor);
    let s = Seq.reduce(Seq.initialState(), { type: "load", set: loaded.set }).state;
    s = Seq.reduce(s, { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    expect(Seq.guide(s, {}).title).toBe("Click just south of where the map goes");
    expect(Seq.guide(s, {}).detail).toMatch(/The map lands north of the cursor, about 5 cells away\./);
    s = Seq.reduce(Seq.reduce(s, { type: "next" }).state, { type: "sent", index: 1, ok: true }).state;
    s = Seq.reduce(s, { type: "next" }).state;
    expect(Seq.statusLine(s).text).toMatch(
      /one just past the map's north-east corner, and one about 31 cells south of the map\.$/,
    );
    // the app's anchor sides are the add-on's
    for (const side of ["north", "east", "south", "west"] as const)
      expect(Seq.parseChunkSet(JSON.stringify({ ...set, anchor: { ...anchor, side } })).ok).toBe(true);
  });

  it("the add-on reads the app's hotkey results, standby included", () => {
    const text = appMessage(4, {
      type: "hotkeys-result",
      replyTo: null,
      results: {
        next: { status: "standby", combo: "Ctrl+Alt+D" },
        back: { status: "active", combo: "Ctrl+Alt+A" },
        again: { status: "refused", combo: null, wanted: "Ctrl+Alt+S", reason: "taken by another program" },
      },
    });
    expect(Seq.parseLinkMessage(text)?.results).toEqual({
      next: { status: "standby", combo: "Ctrl+Alt+D", wanted: null, reason: null },
      back: { status: "active", combo: "Ctrl+Alt+A", wanted: null, reason: null },
      again: { status: "refused", combo: null, wanted: "Ctrl+Alt+S", reason: "taken by another program" },
    });
  });

  it("the add-on reads the pairing file the app writes", () => {
    expect(Seq.parseLinkConfig(JSON.stringify({ port: 48731, token: "ab".repeat(24) }))).toEqual({
      port: 48731,
      token: "ab".repeat(24),
    });
    for (const bad of [
      "{",
      JSON.stringify({ port: 0, token: "ab".repeat(24) }),
      JSON.stringify({ port: 1, token: "zz" }),
    ])
      expect(Seq.parseLinkConfig(bad)).toBeNull();
  });
});
