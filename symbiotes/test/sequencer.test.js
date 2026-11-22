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
    expect(Seq.statusLine(s).text).toMatch(/^Chunk 1 of 2 is ready\. Press “Put in hand”/);
    expect(Seq.controls(s).next.enabled).toBe(false);

    let r = Seq.reduce(s, { type: "send" });
    expect(r.effect).toEqual({ type: "send", index: 0 });
    s = r.state;
    expect(Seq.statusLine(s)).toEqual({ tone: "wait", text: "Sending chunk 1 of 2 to your hand…" });
    expect(Seq.controls(s).send.enabled).toBe(false);

    s = Seq.reduce(s, { type: "sent", index: 0, ok: true }).state;
    expect(s.phase).toBe("inHand");
    expect(Seq.statusLine(s).text).toMatch(
      /^Chunk 1 of 2 is in your hand\. Click the spot .* then press Next\./,
    );
    expect(Seq.controls(s).send.label).toBe("Put in hand again");

    r = Seq.reduce(s, { type: "next" });
    expect(r.effect).toEqual({ type: "send", index: 1 });
    s = Seq.reduce(r.state, { type: "sent", index: 1, ok: true }).state;
    expect(Seq.statusLine(s).text).toMatch(
      /^Chunk 2 of 2 is in your hand\. Without moving the camera, .*press Finish\./,
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
