/**
 * Slabyrinth Helper's sequencing logic, loaded exactly as the symbiote page loads it (a classic script that defines
 * one global), plus a check that the bundled test pair is a matched pair.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { decode } from "../../packages/core/src/slab/index.ts";

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
    expect(r.effect).toBeUndefined();
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
    expect(Seq.linkLight("connecting")).toMatchObject({ tone: "wait", label: "Connecting…" });
    expect(Seq.linkLight("retrying")).toMatchObject({
      tone: "wait",
      label: "Not connected: bridge not running (retrying)",
    });
    expect(Seq.linkLight("off")).toMatchObject({ tone: "off", label: "Link is off: turn on Link below" });
    const icons = ["connected", "connecting", "retrying", "off"].map((s) => Seq.linkLight(s).icon);
    expect(new Set(icons).size).toBe(4);
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
    ["somethingNew", /TaleSpire reported "somethingNew"/],
  ])("%s", (cause, text) => expect(Seq.explainCause(cause)).toMatch(text));
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
