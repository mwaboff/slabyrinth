/**
 * The words the working model text teaches are the words the generator reads (sp-1.14.0, generator 5). Every word
 * list the prompt names is parsed from the prompt itself and checked against the tables that read it: room kinds
 * (gen/roomPurpose.ts classifyRoom), building kinds (gen/buildingProgramme.ts buildingKind), and light, upkeep, wealth
 * and mood (resolve/character.ts, through a zone named by the word). A word dropped from a table, or a kind added to
 * one, fails here until the text says the same thing.
 */
import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "../../../src/agent";
import type { MapPlan } from "../../../src/contracts/plan";
import type { ResolvedCharacter } from "../../../src/contracts/resolved";
import { BUILDING_KIND_NAMES, buildingKind } from "../../../src/gen/buildingProgramme";
import { lightNamedBy } from "../../../src/gen/lightLevels";
import { classifyRoom } from "../../../src/gen/roomPurpose";
import { ROOM_KINDS, ROOM_TRAITS } from "../../../src/gen/roomTraits";
import {
  CHARACTER_CONDITIONS,
  CHARACTER_LIGHTS,
  CHARACTER_WEALTHS,
  resolveCharacters,
} from "../../../src/resolve/character";
import { ADVISED_CODES, NOTE_ACTIONS } from "../../../src/review/noteActions";

/** The text after `label` up to the end of its sentence (a full stop before a space or the end of a line). */
function listAfter(label: string): string {
  const i = SYSTEM_PROMPT.indexOf(label);
  if (i < 0) throw new Error(`the prompt has no "${label}"`);
  const rest = SYSTEM_PROMPT.slice(i + label.length);
  const end = rest.search(/\.(\s|$)/);
  return rest.slice(0, end < 0 ? undefined : end).trim();
}

const split = (s: string): string[] =>
  s
    .split(",")
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

/** "a, b → x, y; c → z" as [words, values] pairs. */
function arrows(label: string): Array<{ words: string[]; values: string[] }> {
  return listAfter(label)
    .split(";")
    .map((seg) => {
      const [l, r] = seg.split("→");
      return { words: split(l ?? ""), values: split(r ?? "") };
    });
}

/** The character a zone named by `word` resolves to (a zone reads setting words and may name a ruin). */
function zoneCharacter(word: string): ResolvedCharacter {
  const plan: MapPlan = {
    schema: "slabyrinth/plan@1",
    generator: 5,
    id: "00000000-0000-4000-8000-000000000001",
    title: "test",
    kind: "outdoor",
    seed: 1,
    theme: "wood_town",
    levels: [
      {
        id: "g",
        name: "Ground",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 20, h: 20 },
        base: { type: "ground", material: "grass" },
        areas: [{ id: "q", kind: "zone", name: word, shape: { type: "rect", x: 0, y: 0, w: 20, h: 20 } }],
        openings: [],
        walls: [],
        features: [],
        labels: [],
        terrain: [],
        structures: [],
      },
    ],
    links: [],
  };
  const c = resolveCharacters(plan, 0)?.get("q");
  if (!c) throw new Error("no character");
  return c;
}

describe("the room words the prompt teaches name the kinds it says", () => {
  const listed = [...listAfter("Room words:").matchAll(/([a-z ]+) \(([^)]+)\)/g)].map((m) => ({
    kind: (m[1] ?? "").trim().replace(/ /g, "_"),
    words: split(m[2] ?? ""),
  }));
  it("lists every room kind of the table, once", () => {
    expect(listed.map((k) => k.kind).sort()).toEqual([...ROOM_KINDS].sort());
  });
  it.each(listed)("$kind: its words", ({ kind, words }) => {
    expect(words.length).toBeGreaterThan(0);
    for (const w of words) expect([w, classifyRoom({ name: w }, { kinds: true }).kind]).toEqual([w, kind]);
  });
  it("a hall is a dining hall and a way through is a passage, as the prompt says", () => {
    expect(classifyRoom({ name: "Hall" }, { kinds: true }).kind).toBe("dining");
    for (const w of ["hallway", "landing", "gallery", "antechamber"])
      expect([w, classifyRoom({ name: w }, { kinds: true }).purpose]).toEqual([w, "passage"]);
    for (const w of ["derelict", "looted", "abandoned"])
      expect(classifyRoom({ name: `${w} bedroom` }, { kinds: true }).abandoned).toBe(true);
    for (const w of ["ruined", "collapsed"])
      expect(classifyRoom({ name: `${w} kitchen` }, { kinds: true }).purpose).toBe("ruin");
  });
  it("a room's default light is its kind's, as the prompt says (a ward bright, a tavern dim, a store room or crypt dark)", () => {
    expect(SYSTEM_PROMPT).toContain("a ward bright, a tavern dim, a store room or a crypt dark");
    const level = (k: keyof typeof ROOM_TRAITS) => CHARACTER_LIGHTS[ROOM_TRAITS[k].lighting.level];
    expect([level("ward"), level("tavern"), level("storeroom"), level("crypt")]).toEqual([
      "bright",
      "dim",
      "dark",
      "dark",
    ]);
  });
});

describe("the building words the prompt teaches pick the ground storey it says", () => {
  const rows = arrows("Building words:");
  it("each row's words name one kind, every row a different one, and every kind but the home has a row", () => {
    const kinds = rows.map(({ words }) => {
      const ks = new Set(words.map((w) => buildingKind({ use: w })));
      expect([words, ks.size]).toEqual([words, 1]);
      return [...ks][0];
    });
    expect(new Set(kinds).size).toBe(rows.length);
    expect(kinds).not.toContain("dwelling");
    expect([...kinds].sort()).toEqual(BUILDING_KIND_NAMES.filter((k) => k !== "dwelling").sort());
  });
});

describe("the character words the prompt teaches set the values it says", () => {
  it.each(arrows("Light words:"))("light $values: $words", ({ words, values }) => {
    for (const w of words) expect([w, zoneCharacter(w).light]).toEqual([w, values[0]]);
  });
  it("abandoned, derelict, forgotten and lost read as dark, as the prompt warns", () => {
    expect(SYSTEM_PROMPT).toContain("Abandoned, derelict, forgotten and lost read as dark too");
    for (const w of ["abandoned", "derelict", "forgotten", "lost"])
      expect(zoneCharacter(w).light).toBe("dark");
  });
  it.each(arrows("Setting words, for a scene, a quarter or a building only:"))(
    "setting $values: $words, never a room's",
    ({ words, values }) => {
      for (const w of words) {
        expect([w, zoneCharacter(w).light]).toEqual([w, values[0]]);
        expect(lightNamedBy([w], { settings: false })).toBeUndefined();
      }
    },
  );
  it.each(arrows("Upkeep words:"))("upkeep $values: $words", ({ words, values }) => {
    for (const w of words) expect([w, zoneCharacter(w).condition]).toEqual([w, values[0]]);
  });
  it.each(arrows("Wealth words:"))("wealth $values: $words", ({ words, values }) => {
    for (const w of words) expect([w, zoneCharacter(w).wealth]).toEqual([w, values[0]]);
  });
  it.each(arrows("Mood words set several at once:"))("mood $values: $words", ({ words, values }) => {
    expect(values.length).toBeGreaterThan(1);
    for (const w of words) {
      const c = zoneCharacter(w);
      for (const v of values) {
        const got = (CHARACTER_LIGHTS as readonly string[]).includes(v)
          ? c.light
          : (CHARACTER_CONDITIONS as readonly string[]).includes(v)
            ? c.condition
            : (CHARACTER_WEALTHS as readonly string[]).includes(v)
              ? c.wealth
              : c.tone;
        expect([w, got]).toEqual([w, v]);
      }
    }
  });
});

describe("generator 5's review notes", () => {
  it.each(ADVISED_CODES)("%s has an action in plan terms", (code) => {
    const a = NOTE_ACTIONS[code];
    expect(a.length).toBeGreaterThan(20);
    // plan words, never the engine's: no file, switch or internal table names
    expect(a).not.toMatch(/\.ts\b|switch|generator|resolve|palette/i);
  });
});
