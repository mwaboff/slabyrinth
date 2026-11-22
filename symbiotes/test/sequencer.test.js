/**
 * Slabyrinth Helper's sequencing logic, loaded exactly as the symbiote page loads it (a classic script that defines
 * one global), plus a check that the bundled test pair is a matched pair.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { decode, decompress, encodeLayoutsRaw } from "../../packages/core/src/slab/index.ts";

const DIR = new URL("../slabyrinth-helper/", import.meta.url);

function loadScripts(...names) {
  const ctx = createContext({});
  for (const n of names) runInContext(readFileSync(new URL(n, DIR), "utf8"), ctx, { filename: n });
  return ctx;
}

const { SlabyrinthSequencer: Seq } = loadScripts("sequencer.js");
// a tiny real slab: one asset (base64 of gzip data)
const SLAB = "H4sIAAAAAAAEADv369xFJgZGBgYGt3SdZ+fP7XfrVvghbvHxkgJITIfxBEMDTwOQCQAbEZZYKAAAAA==";
const blob = (over = {}) =>
  JSON.stringify({
    format: "slabyrinth-chunks",
    version: 1,
    name: "Two halves",
    chunks: [
      { label: "West half", slab: SLAB },
      { label: "East half", slab: SLAB },
    ],
    ...over,
  });
const loaded = () => {
  const p = Seq.parseChunkSet(blob());
  if (!p.ok) throw new Error(p.error);
  return Seq.reduce(Seq.initialState(), { type: "load", set: p.set }).state;
};

describe("parseChunkSet", () => {
  it("reads a valid set, trimming fences and whitespace", () => {
    const r = Seq.parseChunkSet(blob({ chunks: [{ label: " A ", slab: "```\n" + SLAB + "\n```" }] }));
    expect(r.ok).toBe(true);
    expect(r.set.name).toBe("Two halves");
    expect(r.set.chunks[0].label).toBe("A");
    expect(r.set.chunks[0].slab).toBe(SLAB);
    expect(r.set.chunks[0].bytes).toBe(58);
  });

  it.each([
    ["", /empty/],
    ["{not json", /not valid JSON/],
    ["[]", /JSON object/],
    [blob({ format: "other" }), /"format" must be "slabyrinth-chunks"/],
    [blob({ version: 2 }), /version 1/],
    [blob({ name: "" }), /"name"/],
    [blob({ chunks: [] }), /non-empty list/],
    [blob({ chunks: [{ slab: SLAB }] }), /Chunk 1 needs a "label"/],
    [blob({ chunks: [{ label: "a", slab: SLAB }, { label: "b" }] }), /Chunk 2 needs a "slab"/],
    [blob({ chunks: [{ label: "a", slab: "not base64!" }] }), /not base64/],
    [blob({ chunks: [{ label: "a", slab: "QUJDRA==" }] }), /not gzip/],
  ])("refuses %s in plain words", (text, message) => {
    const r = Seq.parseChunkSet(text);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(message);
  });

  it("reads the optional map size and level count, and the header shows them as text", () => {
    const r = Seq.parseChunkSet(blob({ size: { w: 40, h: 30 }, levels: 2 }));
    expect(r.set).toMatchObject({ size: { w: 40, h: 30 }, levels: 2 });
    expect(Seq.mapInfo(r.set)).toEqual({ title: "Two halves", meta: "2 chunks · 40 × 30 cells · 2 levels" });
    const plain = Seq.parseChunkSet(blob()).set;
    expect(plain).toMatchObject({ size: null, levels: null });
    expect(Seq.mapInfo(plain)).toEqual({ title: "Two halves", meta: "2 chunks" });
    expect(Seq.mapInfo(null)).toBeNull();
    expect(Seq.parseChunkSet(blob({ name: "<b>x</b>" })).set.name).toBe("<b>x</b>"); // kept as text
  });

  it.each([
    [{ size: { w: 0, h: 3 } }, /"size"/],
    [{ size: { w: 2.5, h: 3 } }, /"size"/],
    [{ size: "12x10" }, /"size"/],
    [{ levels: 0 }, /"levels"/],
    [{ levels: "1" }, /"levels"/],
    [{ name: "x".repeat(201) }, /too long/],
  ])("refuses bad optional fields %j", (over, message) => {
    expect(Seq.parseChunkSet(blob(over)).error).toMatch(message);
  });

  it("refuses a chunk over the size limit TaleSpire reports", () => {
    const r = Seq.parseChunkSet(blob(), 40);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Chunk 1 is 58 bytes; TaleSpire accepts at most 40 bytes/);
  });
});

describe("the chunk flow", () => {
  it("feeds every chunk to the hand in order and says what to do at each step", () => {
    let s = loaded();
    expect(s.phase).toBe("ready");
    // the build plane is a step before the first placement, not a footnote (Test B: without it chunk 2 sat higher)
    expect(Seq.statusLine(s).text).toMatch(
      /^Chunk 1 of 2 is ready\. First press G in TaleSpire to raise the build plane .* Then press Next/,
    );
    expect(Seq.controls(s).next.enabled).toBe(true);

    // Next with nothing in hand puts the current chunk there, so one key drives the whole flow
    let r = Seq.reduce(s, { type: "next" });
    expect(r.effect).toEqual({ type: "send", index: 0 });
    s = r.state;
    expect(Seq.statusLine(s)).toEqual({ tone: "wait", text: "Sending chunk 1 of 2 to your hand…" });
    expect(Seq.controls(s).send.enabled).toBe(false);

    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    expect(s.phase).toBe("inHand");
    expect(Seq.statusLine(s).text).toMatch(
      /^Chunk 1 of 2 is in your hand\. With the build plane raised \(G\), click one spot .* then press Next\./,
    );
    expect(Seq.controls(s).send.label).toBe("Put in hand again");

    r = Seq.reduce(s, { type: "next" });
    expect(r.effect).toEqual({ type: "send", index: 1 });
    s = Seq.reduce(r.state, { type: "sent", index: 1, ok: true }).state;
    expect(Seq.statusLine(s).text).toMatch(
      /^Chunk 2 of 2 is in your hand\. Click the same spot again without moving the camera, then press Finish\./,
    );
    expect(Seq.controls(s).next.label).toBe("Finish");
    expect(Seq.progress(s)).toMatchObject({ current: 2, total: 2, placed: 1 });

    r = Seq.reduce(s, { type: "next" });
    // Finish sends nothing more, but asks the page to try to empty the hand (the last chunk is still a stamp there)
    expect(r.effect).toEqual({ type: "clearHand" });
    expect(r.state.phase).toBe("done");
    expect(Seq.statusLine(r.state).tone).toBe("done");
    expect(Seq.progress(r.state).placed).toBe(2);
    expect(Seq.controls(r.state).next.enabled).toBe(false);
  });

  it("shows a failure in plain words and lets the GM put the chunk in hand again", () => {
    let s = Seq.reduce(loaded(), { type: "send" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: "rateLimited" }).state;
    const line = Seq.statusLine(s);
    expect(line.tone).toBe("error");
    expect(line.text).toMatch(
      /^Chunk 1 of 2 did not reach your hand: .*sending too fast\. Wait a few seconds\./,
    );
    expect(line.text).toMatch(/Put in hand again/);
    const again = Seq.reduce(s, { type: "send" });
    expect(again.effect).toEqual({ type: "send", index: 0 });
  });

  it("goes back one chunk and puts it in hand; Back on the first chunk does nothing", () => {
    let s = Seq.reduce(loaded(), { type: "send" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    expect(Seq.reduce(s, { type: "back" }).effect).toBeUndefined();
    s = Seq.reduce(s, { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 1, ok: true }).state;
    const r = Seq.reduce(s, { type: "back" });
    expect(r.effect).toEqual({ type: "send", index: 0 });
  });

  it("ignores a late answer for a chunk that is no longer current", () => {
    const s = Seq.reduce(loaded(), { type: "send" }).state;
    expect(Seq.reduce(s, { type: "sent", index: 1, ok: true }).state).toBe(s);
  });

  it("does nothing before a set is loaded", () => {
    const s = Seq.initialState();
    for (const type of ["send", "next", "back"]) expect(Seq.reduce(s, { type }).effect).toBeUndefined();
    expect(Seq.statusLine(s).text).toBe("Load a set of chunks to begin.");
  });
});

describe("the link to the bridge", () => {
  const msg = (o) => JSON.stringify({ protocol: "slabyrinth-link", version: 1, ...o });

  it("accepts only well-formed messages of known types", () => {
    expect(Seq.parseLinkMessage(msg({ type: "next", id: 3 }))).toEqual({ type: "next", id: 3 });
    expect(Seq.parseLinkMessage(msg({ type: "again" }))).toEqual({ type: "again", id: null });
    for (const bad of [
      "not json",
      "[]",
      JSON.stringify({ type: "next" }),
      msg({ type: "next", version: 2 }),
      msg({ type: "fire" }),
      msg({ type: "next", id: { x: 1 } }),
      msg({ type: "load" }),
      msg({ type: "load", set: [] }),
      msg({ type: "hotkeys-result", results: { next: { status: "maybe", combo: null } } }),
    ])
      expect(Seq.parseLinkMessage(bad)).toBeNull();
  });

  it("drives the same actions as the buttons and loads a pushed set", () => {
    expect(Seq.linkCommand({ type: "next" })).toEqual({ action: { type: "next" } });
    expect(Seq.linkCommand({ type: "back" })).toEqual({ action: { type: "back" } });
    expect(Seq.linkCommand({ type: "again" })).toEqual({ action: { type: "send" } });
    expect(Seq.linkCommand({ type: "status" })).toEqual({});
    const set = JSON.parse(blob());
    const load = Seq.parseLinkMessage(msg({ type: "load", id: 1, set }));
    const cmd = Seq.linkCommand(load);
    expect(cmd.action.type).toBe("load");
    expect(cmd.action.set.chunks).toHaveLength(2);
    expect(Seq.linkCommand({ type: "load", set: { ...set, version: 9 } }).error).toMatch(/version 1/);
  });

  it("replies with where the flow stands", () => {
    let s = Seq.reduce(loaded(), { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: "notInBoard" }).state;
    expect(Seq.linkReply(s, 7)).toMatchObject({
      protocol: "slabyrinth-link",
      version: 1,
      type: "state",
      replyTo: 7,
      setName: "Two halves",
      chunk: 1,
      total: 2,
      phase: "failed",
      cause: "notInBoard",
      error: null,
    });
    expect(Seq.linkReply(s, 7).status).toMatch(/not on a board/);
  });
});

describe("global hotkeys (helper side)", () => {
  const ev = (code, mods = {}) => ({
    key: "x",
    code,
    ctrlKey: true,
    altKey: true,
    shiftKey: false,
    metaKey: false,
    ...mods,
  });

  it("records the physical key", () => {
    expect(Seq.hotkeyCombo(ev("KeyD"))).toBe("Ctrl+Alt+D");
    expect(Seq.hotkeyCombo(ev("Digit4", { altKey: false }))).toBe("Ctrl+4");
    expect(Seq.hotkeyCombo(ev("ArrowUp"))).toBe("Ctrl+Alt+Up");
    expect(Seq.hotkeyCombo(ev("ControlLeft", { key: "Control" }))).toBeNull();
  });

  it("allows Ctrl or Alt plus a listed key, in a fixed order", () => {
    expect(Seq.checkHotkey("Alt+Ctrl+D")).toEqual({ ok: true, combo: "Ctrl+Alt+D" });
    expect(Seq.checkHotkey("Ctrl+F12").ok).toBe(true);
    expect(Seq.checkHotkey("Shift+D").reason).toMatch(/Ctrl or Alt/);
    expect(Seq.checkHotkey("D").ok).toBe(false);
    expect(Seq.checkHotkey("Meta+Ctrl+D").reason).toMatch(/Meta is not allowed/);
    expect(Seq.checkHotkey("Ctrl+Numpad1").reason).toMatch(/not an allowed key/);
    expect(Seq.checkHotkey("Ctrl+Ctrl+D").reason).toMatch(/repeats/);
  });

  it("asks for only the hotkeys the GM set and reads the bridge's answer", () => {
    expect(Seq.hotkeysMessage({ next: "Ctrl+Alt+F", junk: "x" }, 2)).toEqual({
      protocol: "slabyrinth-link",
      version: 1,
      type: "hotkeys",
      id: 2,
      hotkeys: { next: "Ctrl+Alt+F" },
    });
    const m = Seq.parseLinkMessage(
      JSON.stringify({
        protocol: "slabyrinth-link",
        version: 1,
        type: "hotkeys-result",
        replyTo: 2,
        results: {
          next: {
            status: "refused",
            combo: "Ctrl+Alt+D",
            wanted: "Ctrl+Alt+F",
            reason: "taken by another program",
          },
          back: { status: "active", combo: "Ctrl+Alt+A" },
        },
      }),
    );
    expect(m.replyTo).toBe(2);
    expect(m.results.next).toEqual({
      status: "refused",
      combo: "Ctrl+Alt+D",
      wanted: "Ctrl+Alt+F",
      reason: "taken by another program",
    });
  });
});

describe("the state header", () => {
  it("link light: words and icon change with the colour", () => {
    expect(Seq.linkLight("connected")).toMatchObject({ tone: "good", label: "Connected to Slabyrinth" });
    expect(Seq.linkLight("connecting")).toMatchObject({ tone: "wait", label: "Connecting to Slabyrinth…" });
    expect(Seq.linkLight("retrying")).toMatchObject({
      tone: "wait",
      label: "Not connected to Slabyrinth",
      detail: "The bridge is not running. Retrying on its own.",
    });
    expect(Seq.linkLight("off")).toMatchObject({
      tone: "off",
      label: "Link is off",
      detail: "Turn it on under Link and hotkeys.",
    });
    const icons = ["connected", "connecting", "retrying", "off"].map((s) => Seq.linkLight(s).icon);
    expect(new Set(icons).size).toBe(4);
  });
});

describe("the now block", () => {
  const KEYS = { next: "Ctrl+Alt+D", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" };
  const two = () =>
    Seq.reduce(Seq.initialState(), { type: "load", set: Seq.parseChunkSet(blob(), 0).set }).state;

  it("asks for the build plane before chunk 1 and names the hotkey while the link is up", () => {
    const g = Seq.guide(two(), { linked: true, keys: KEYS });
    expect(g).toMatchObject({
      tone: "action",
      step: "Before chunk 1",
      title: "Press G to raise the build plane",
    });
    expect(g.detail).toMatch(/^Then press Ctrl\+Alt\+D to put chunk 1 in your hand\./);
    // no working hotkeys: the button is named instead
    expect(Seq.guide(two(), { linked: false, keys: null }).detail).toMatch(/^Then press Next /);
  });

  it("walks the chunks with a short headline and says when it is the last", () => {
    let s = Seq.reduce(two(), { type: "next" }).state;
    expect(Seq.guide(s, { keys: KEYS })).toMatchObject({
      tone: "wait",
      title: "Putting chunk 1 in your hand…",
    });
    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    let g = Seq.guide(s, { keys: KEYS });
    expect(g).toMatchObject({ step: "Chunk 1 of 2 in hand", title: "Click one spot to place it" });
    expect(g.detail).toMatch(/then press Ctrl\+Alt\+D for chunk 2\./);
    s = Seq.reduce(s, { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 1, ok: true }).state;
    g = Seq.guide(s, { keys: null });
    expect(g.title).toBe("Click the same spot");
    expect(g.detail).toBe("Don't move the camera. Then press Finish to finish.");
    s = Seq.reduce(s, { type: "next" }).state;
    expect(Seq.guide(s, { keys: KEYS })).toMatchObject({
      tone: "done",
      title: "Switching to the picking tool…",
    });
  });

  it("explains a refusal and points at Again (its hotkey, or the button)", () => {
    let s = Seq.reduce(two(), { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: "clientIsNotInGmMode" }).state;
    const g = Seq.guide(s, { keys: KEYS });
    expect(g).toMatchObject({ tone: "error", title: "Chunk 1 didn't reach your hand" });
    expect(g.detail).toBe("TaleSpire is not in GM mode. Switch to GM mode, then press Ctrl+Alt+S.");
    expect(Seq.guide(s, {}).detail).toMatch(/then press Put in hand again\.$/);
    expect(Seq.controls(s).primary).toBe("send");
    expect(Seq.controls(two()).primary).toBe("next");
  });

  it("with no map, says whether one can arrive", () => {
    expect(Seq.guide(Seq.initialState(), { linked: true }).title).toBe("Waiting for a map");
    expect(Seq.guide(Seq.initialState(), { linked: false }).title).toBe("No map loaded");
  });
});

const finished = () => {
  let s = loaded();
  s = Seq.reduce(s, { type: "next" }).state;
  s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
  s = Seq.reduce(s, { type: "next" }).state;
  s = Seq.reduce(s, { type: "sent", index: 1, ok: true }).state;
  return Seq.reduce(s, { type: "next" }).state;
};

describe("after the last chunk: the picking tool", () => {
  it("says what it is doing, then what was done, never that the hand is empty", () => {
    const s = finished();
    expect(s.clear).toEqual({ status: "trying" });
    expect(Seq.guide(s, {})).toMatchObject({
      tone: "done",
      title: "Switching to the picking tool…",
      detail: "If a slab is still in your hand, right-click. Then delete the two alignment pillars.",
    });
    const picking = Seq.reduce(s, { type: "cleared", method: "picking", ok: true }).state;
    expect(picking.clear).toEqual({ status: "answered", method: "picking", cause: null });
    expect(Seq.guide(picking, {})).toMatchObject({
      title: "Switched to the picking tool",
      detail:
        "Another click won't paste the last chunk. Click the board or dismiss the tool to leave it. " +
        "Then delete the two alignment pillars.",
    });
    for (const g of [Seq.guide(s, {}), Seq.guide(picking, {})])
      expect(`${g.title} ${g.detail}`).not.toMatch(/hand is (clear|empty)|cleared your hand/);
  });

  it("a refusal (in plain words) or the switch off ends in the plain right-click step", () => {
    const s = finished();
    const refused = Seq.reduce(s, {
      type: "cleared",
      method: "picking",
      ok: false,
      cause: "toolInUse",
    }).state;
    expect(Seq.guide(refused, {})).toMatchObject({
      title: "Right-click to clear your hand",
      detail: "Another symbiote is using the picking tool. Then delete the two alignment pillars.",
    });
    const off = Seq.reduce(s, { type: "cleared", method: "off", ok: true }).state;
    expect(off.clear.status).toBe("off");
    expect(Seq.guide(off, {})).toMatchObject({
      title: "Right-click to clear your hand",
      detail: "Then delete the two alignment pillars.",
    });
  });

  it("the picking tool is the default; the removed empty-slab setting becomes it", () => {
    expect(Seq.CLEAR_METHODS.map((m) => m.id)).toEqual(["picking", "off"]);
    expect(Seq.pickClearMethod("off")).toBe("off");
    expect(Seq.pickClearMethod("empty")).toBe("picking");
    expect(Seq.pickClearMethod(null)).toBe("picking");
  });
});

describe("after the end: Start over and Back put nothing in the hand", () => {
  it("Start over (the Again control and hotkey) resets to the first step and waits", () => {
    const done = finished();
    expect(Seq.controls(done).send).toEqual({ enabled: true, label: "Start over" });
    const r = Seq.reduce(done, { type: "send" });
    expect(r.effect).toBeUndefined();
    expect(r.state).toMatchObject({ index: 0, phase: "ready", clear: null });
    expect(Seq.progress(r.state).placed).toBe(0);
    expect(Seq.guide(r.state, {}).title).toBe("Press G to raise the build plane");
    // the link's "again" is the same action
    expect(Seq.linkCommand({ type: "again" })).toEqual({ action: { type: "send" } });
    // a late picking answer after Start over changes nothing
    expect(Seq.reduce(r.state, { type: "cleared", method: "picking", ok: true }).state).toBe(r.state);
  });

  it("Back selects the last chunk without sending it; Next or Put in hand then sends it", () => {
    const r = Seq.reduce(finished(), { type: "back" });
    expect(r.effect).toBeUndefined();
    expect(r.state).toMatchObject({ index: 1, phase: "ready", clear: null });
    const g = Seq.guide(r.state, { keys: { next: "Ctrl+Alt+D", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" } });
    expect(g).toMatchObject({
      step: "Chunk 2 of 2 selected",
      title: "Press Ctrl+Alt+D to put chunk 2 in your hand",
    });
    expect(g.detail).toMatch(/^It is not in your hand yet \(Put in hand does the same\)\./);
    expect(Seq.controls(r.state).next.label).toBe("Next");
    expect(Seq.reduce(r.state, { type: "next" }).effect).toEqual({ type: "send", index: 1 });
    expect(Seq.reduce(r.state, { type: "send" }).effect).toEqual({ type: "send", index: 1 });
  });

  it("mid-sequence Back still puts the previous chunk in hand", () => {
    let s = Seq.reduce(loaded(), { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    s = Seq.reduce(s, { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 1, ok: true }).state;
    expect(Seq.reduce(s, { type: "back" }).effect).toEqual({ type: "send", index: 0 });
  });
});

describe("empty slabs are never sent", () => {
  // a well-formed v2 slab with no layouts: TaleSpire's slab spawn divides by zero on it (Test K). Test data only.
  const EMPTY = "H4sIAAAAAAACAzv369xFJgYIAACcngOODAAAAA==";

  it("reads the uncompressed size from the gzip trailer", () => {
    expect(decode(EMPTY)).toMatchObject({ assets: [] });
    expect(Seq.slabRawSize(EMPTY)).toBe(decompress(EMPTY).raw.length);
    expect(Seq.slabRawSize(SLAB)).toBe(decompress(SLAB).raw.length);
    expect(Seq.slabRawSize(EMPTY)).toBe(encodeLayoutsRaw([]).length);
  });

  it("refuses a slab that cannot hold an asset, and a set that contains one", () => {
    expect(Seq.slabHasRoomForAnAsset(EMPTY)).toBe(false);
    expect(Seq.slabHasRoomForAnAsset(SLAB)).toBe(true);
    expect(Seq.slabHasRoomForAnAsset("H4sI")).toBe(false);
    const r = Seq.parseChunkSet(
      blob({
        chunks: [
          { label: "a", slab: SLAB },
          { label: "b", slab: EMPTY },
        ],
      }),
    );
    expect(r).toEqual({
      ok: false,
      error: "Chunk 2 has no assets. TaleSpire crashes on an empty slab, so this set cannot be used.",
    });
  });
});

describe("appearance", () => {
  it("has two looks, Slabyrinth the default and Native the alternative", () => {
    expect(Seq.DESIGNS.map((d) => d.id)).toEqual(["slabyrinth", "native"]);
    expect(Seq.pickDesign("native")).toBe("native");
    expect(Seq.pickDesign("slabyrinth")).toBe("slabyrinth");
  });

  it("falls back to Slabyrinth for a removed look, an unknown value or nothing stored", () => {
    for (const stored of ["instrument", "lantern", "neon", "", null, undefined, 3])
      expect(Seq.pickDesign(stored)).toBe("slabyrinth");
  });

  /** Runs the page script up to the point the body would paint (start() waits for DOMContentLoaded). */
  function themeOnOpen(stored, { throws = false } = {}) {
    const store = new Map(stored === undefined ? [] : [["slabyrinth-helper.design", stored]]);
    const localStorage = {
      getItem: (k) => {
        if (throws) throw new Error("blocked");
        return store.has(k) ? store.get(k) : null;
      },
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    };
    const documentElement = { dataset: {} };
    const ctx = createContext({
      window: { localStorage },
      document: { documentElement, readyState: "loading", addEventListener: () => {} },
      location: { protocol: "http:" },
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    });
    for (const n of ["sequencer.js", "app.js"])
      runInContext(readFileSync(new URL(n, DIR), "utf8"), ctx, { filename: n });
    return documentElement.dataset.theme;
  }

  it("restores the stored look before the body paints, and falls back when it is unknown", () => {
    expect(themeOnOpen("native")).toBe("native");
    expect(themeOnOpen("slabyrinth")).toBe("slabyrinth");
    expect(themeOnOpen(undefined)).toBe("slabyrinth");
    expect(themeOnOpen("instrument")).toBe("slabyrinth");
    expect(themeOnOpen("native", { throws: true })).toBe("slabyrinth");
  });

  it("ships the default look in the page itself, so nothing flashes before the script runs", () => {
    const html = readFileSync(new URL("index.html", DIR), "utf8");
    expect(html).toMatch(/<html lang="en" data-theme="slabyrinth">/);
    // the page script is in <head>, ahead of <body>
    expect(html.indexOf('<script src="app.js"></script>')).toBeLessThan(html.indexOf("<body>"));
    const css = readFileSync(new URL("style.css", DIR), "utf8");
    expect([...css.matchAll(/data-theme="([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(
      expect.arrayContaining(["native", "slabyrinth"]),
    );
    expect(css).not.toMatch(/instrument|lantern/i);
  });
});

describe("which API the page uses", () => {
  it("uses TaleSpire's API as soon as it exists", () => {
    expect(Seq.apiMode(true, "http:", 0, 15000)).toEqual({ mode: "game", fake: false, banner: null });
    expect(Seq.apiMode(true, "file:", 0, 15000).mode).toBe("game");
  });

  it("fakes only in a plain browser (file://)", () => {
    const m = Seq.apiMode(false, "file:", 0, 15000);
    expect(m).toMatchObject({ mode: "preview", fake: true });
    expect(m.banner.text).toMatch(/^Preview: .*Nothing is being sent to TaleSpire/);
  });

  it("in TaleSpire (served over http) it waits for the API, then says plainly that it is missing", () => {
    // TaleSpire starts injecting at DOMContentLoaded, so the API can be absent when the page's own handler runs
    expect(Seq.apiMode(false, "http:", 0, 15000)).toMatchObject({ mode: "waiting", fake: false });
    const missing = Seq.apiMode(false, "http:", 15000, 15000);
    expect(missing).toMatchObject({ mode: "missing", fake: false });
    expect(missing.banner).toMatchObject({ tone: "error" });
    expect(missing.banner.text).toMatch(/nothing can be put in your hand/);
  });
});

describe("buttons with no set loaded", () => {
  it("say Put in hand, Next, Back (never Finish), all off", () => {
    const c = Seq.controls(Seq.initialState());
    expect([c.send.label, c.next.label, c.back.label]).toEqual(["Put in hand", "Next", "Back"]);
    expect([c.send.enabled, c.next.enabled, c.back.enabled]).toEqual([false, false, false]);
  });

  it("slabs light: loaded or not, or what blocks pasting (progress is the bar's job)", () => {
    const READY = "Slabs are ready to paste";
    expect(Seq.slabsLight(Seq.initialState(), "gm")).toMatchObject({ tone: "off", label: "No slabs loaded" });
    let s = loaded();
    expect(Seq.slabsLight(s, "gm")).toMatchObject({ tone: "good", label: READY });
    expect(Seq.slabsLight(s, "player")).toMatchObject({ tone: "bad", label: "Blocked: not in GM mode" });
    expect(Seq.slabsLight(s, "gm", true)).toMatchObject({
      tone: "bad",
      label: "Blocked: TaleSpire's API is missing",
    });
    s = Seq.reduce(s, { type: "next" }).state;
    expect(Seq.slabsLight(s, null).label).toBe(READY);
    const failed = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: "notInBoard" }).state;
    expect(Seq.slabsLight(failed, "gm")).toMatchObject({ tone: "bad", label: "Blocked: not on a board" });
    const rate = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: "rateLimited" }).state;
    expect(Seq.slabsLight(rate, "gm").label).toBe(READY);
    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    s = Seq.reduce(s, { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 1, ok: true }).state;
    s = Seq.reduce(s, { type: "next" }).state;
    expect(s.phase).toBe("done");
    expect(Seq.slabsLight(s, "gm").label).toBe(READY);
  });
});

describe("keys", () => {
  const ev = (key, mods = {}) => ({
    key,
    code: key === " " ? "Space" : "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...mods,
  });

  it("names key combos", () => {
    expect(Seq.keyCombo(ev(" ", { ctrlKey: true }))).toBe("Ctrl+Space");
    expect(Seq.keyCombo(ev(" ", { ctrlKey: true, shiftKey: true }))).toBe("Ctrl+Shift+Space");
    expect(Seq.keyCombo(ev("n", { altKey: true }))).toBe("Alt+N");
    expect(Seq.keyCombo(ev("F8"))).toBe("F8");
    expect(Seq.keyCombo(ev("Control", { ctrlKey: true }))).toBeNull();
  });

  it("maps Ctrl+Space to Next and Ctrl+Shift+Space to Back by default, and follows chosen keys", () => {
    expect(Seq.keyAction(ev(" ", { ctrlKey: true }))).toBe("next");
    expect(Seq.keyAction(ev(" ", { ctrlKey: true, shiftKey: true }))).toBe("back");
    expect(Seq.keyAction(ev(" "))).toBeNull();
    const keys = { next: "F8", back: "F7" };
    expect(Seq.keyAction(ev("F8"), keys)).toBe("next");
    expect(Seq.keyAction(ev(" ", { ctrlKey: true }), keys)).toBeNull();
  });
});

describe("explainCause", () => {
  it.each([
    ["clientIsNotInGmMode", /not in GM mode/],
    ["notInBoard", /not on a board/],
    ["rateLimited", /sending too fast/],
    ["dataOversized", /over TaleSpire's slab size limit/],
    ["invalidSlabString", /could not read/],
    ["spawnFailed", /could not create the slab/],
    ["couldNotSwitchToTool", /could not switch to the picking tool/],
    ["emptySlab", /crashes on an empty slab/],
    ["somethingNew", /^TaleSpire reported an error \(details under Developer tools > Diagnostics\)$/],
  ])("%s", (cause, text) => expect(Seq.explainCause(cause)).toMatch(text));

  // what the owner saw in Test K: a .NET exception with its stack trace, word for word in the status line
  const EXCEPTION =
    "System.DivideByZeroException: Attempted to divide by zero.\n  at Slab.Init (DataModel.Copied copied, " +
    "UnityEngine.Shader remoteReplacementShader) [0x00123]\n  at Slab.Spawn ()\n  at " +
    "Symbiotes.Impls+v0_1+slabs.sendSlabToHand (System.String slabStr)";

  it("never puts a raw exception or stack trace in the status line, on any failure path", () => {
    let s = Seq.reduce(loaded(), { type: "next" }).state;
    s = Seq.reduce(s, { type: "sent", index: 0, ok: false, cause: EXCEPTION }).state;
    const texts = [Seq.statusLine(s).text, Seq.guide(s, {}).detail, Seq.slabsLight(s, "gm").label];
    let d = Seq.reduce(Seq.reduce(s, { type: "send" }).state, { type: "sent", index: 0, ok: true }).state;
    d = Seq.reduce(d, { type: "next" }).state;
    d = Seq.reduce(d, { type: "sent", index: 1, ok: true }).state;
    d = Seq.reduce(d, { type: "next" }).state;
    d = Seq.reduce(d, { type: "cleared", method: "picking", ok: false, cause: EXCEPTION }).state;
    texts.push(Seq.guide(d, {}).detail, Seq.linkReply(s, 1).status);
    for (const t of texts) expect(t).not.toMatch(/Exception|Slab\.Init|at Symbiotes|\n/);
    expect(Seq.guide(d, {}).detail).toMatch(/^TaleSpire reported an error \(details under/);
  });

  it("cuts a long error to its first line for a one-line readout", () => {
    expect(Seq.shortError(EXCEPTION, 160)).toBe("System.DivideByZeroException: Attempted to divide by zero.");
    expect(Seq.shortError("x".repeat(300), 20)).toBe("x".repeat(19) + "…");
    expect(Seq.shortError(null)).toBe("");
  });
});

describe("the bundled test pair", () => {
  const { SLABYRINTH_TEST_PAIR: pair } = loadScripts("test-pair.js");
  const parsed = Seq.parseChunkSet(JSON.stringify(pair));

  it("is a valid two-chunk set", () => {
    expect(parsed.ok).toBe(true);
    expect(parsed.set.chunks).toHaveLength(2);
  });

  it("shares one bounding box and the same two alignment markers", () => {
    const [a, b] = parsed.set.chunks.map((c) => decode(c.slab).assets);
    const box = (as) =>
      ["sx", "sy", "sz"].map((k) => [Math.min(...as.map((x) => x[k])), Math.max(...as.map((x) => x[k]))]);
    expect(box(a)).toEqual(box(b));
    const key = (x) => `${x.uuid}|${x.sx}|${x.sy}|${x.sz}|${x.rot}`;
    const inB = new Set(b.map(key));
    const shared = a.map(key).filter((k) => inB.has(k));
    expect(shared).toHaveLength(2); // the two alignment markers and nothing else
    // one marker at the box's min corner, one at its max corner
    const corners = shared.map((k) => k.split("|").slice(1, 4).map(Number));
    const [x, y, z] = box(a);
    expect(corners).toEqual(
      expect.arrayContaining([
        [x[0], y[0], z[0]],
        [x[1], y[1], z[1]],
      ]),
    );
  });
});
