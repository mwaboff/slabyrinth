/**
 * Terrain with real depth (owner report 2026-11-19, "a crevice with a deteriorating stone bridge" built as a flat
 * room): generator 2 under-layer height fields, no-effect warnings, the chasm op, bridges, lava, cliff faces, cave
 * walls at the level bounds, and decode-and-check-y of the compiled slab.
 */
import { describe, expect, it } from "vitest";
import type { Area, Level, MapPlan, PlanIssue, TerrainOp } from "../../../src/contracts/plan";
import { CELL, CELL_FLAG, EDGE, type ResolvedLevel } from "../../../src/contracts/resolved";
import { compileResolved, placedName, realize, verifyBuild } from "../../../src/compile";
import { bundledPalettes, createRoleResolver, loadPalettes } from "../../../src/palette";
import { checkPlayability, resolvePlan } from "../../../src/resolve";
import { asciiView } from "../../../src/text";
import { buildDisplayList, DEFAULT_DISPLAY_OPTIONS, legendEntries } from "../../../src/render";
import { slabCodec } from "../../../src/slab";
import { boxFill, longestStraight, squareCorners } from "./shapeMetrics";
import { validatePlan } from "../../../src/plan";

const cat = loadPalettes();

function plan(level: Partial<Level>, generator: 1 | 2 = 2): MapPlan {
  return {
    schema: "slabyrinth/plan@1",
    generator,
    id: "depth",
    title: "Depth",
    kind: "cave",
    theme: "cave",
    seed: 7,
    links: [],
    levels: [
      {
        id: "lv",
        name: "L",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 32, h: 18 },
        base: { type: "solid" },
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain: [],
        labels: [],
        ...level,
      },
    ],
  };
}
const cave = (extra: Partial<Area> = {}): Area => ({
  id: "cav",
  kind: "cave",
  shape: { type: "rect", x: 1, y: 1, w: 30, h: 16 },
  ...extra,
});
const chasm = (extra: Partial<Extract<TerrainOp, { op: "chasm" }>> = {}): TerrainOp => ({
  id: "rift",
  op: "chasm",
  points: [
    [15, 0],
    [16, 9],
    [15, 17],
  ],
  width: 4,
  depth: 3,
  floor: "lava",
  ...extra,
});
const L0 = (p: MapPlan): ResolvedLevel => resolvePlan(p, bundledPalettes()).levels[0] as ResolvedLevel;
const at = (l: ResolvedLevel, x: number, y: number): number =>
  (y - l.bounds.y) * l.bounds.w + (x - l.bounds.x);
const issues = (p: MapPlan, code: string): PlanIssue[] =>
  resolvePlan(p, bundledPalettes()).issues.filter((i) => i.code === code);

/** The owner's first plan, reduced: a crevice as an under-layer height op on a solid level. */
const crevicePlan = (generator: 1 | 2): MapPlan =>
  plan(
    {
      areas: [cave({ shape: { type: "rect", x: 0, y: 0, w: 32, h: 18 } })],
      terrain: [
        {
          id: "crevice",
          op: "height",
          shape: { type: "rect", x: 14, y: 0, w: 3, h: 18 },
          set: -3,
          layer: "under",
        },
      ],
    },
    generator,
  );

describe("under-layer height ops", () => {
  it("generator 2: areas inherit the height field (the obvious crevice plan makes a crevice)", () => {
    const l = L0(crevicePlan(2));
    expect(l.cells.height[at(l, 15, 5)]).toBe(-12);
    expect(l.cells.height[at(l, 10, 5)]).toBe(0);
    expect(l.vEdges.kind[5 * 33 + 14]).toBe(EDGE.LEDGE);
    expect(issues(crevicePlan(2), "no_effect")).toEqual([]);
  });
  it("generator 1 (saved maps): unchanged geometry, but a no_effect warning with the right fix", () => {
    const l = L0(crevicePlan(1));
    expect(l.cells.height.every((q) => q === 0)).toBe(true);
    const w = issues(crevicePlan(1), "no_effect");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", elementId: "crevice" });
    expect(w[0]?.hint).toMatch(/layer "over"/);
    expect(w[0]?.hint).toMatch(/chasm terrain op/);
  });
  it("an area with its own floorHeight overrides the field, and the op is reported when overridden everywhere", () => {
    const p = crevicePlan(2);
    (p.levels[0] as Level).areas[0] = cave({
      shape: { type: "rect", x: 0, y: 0, w: 32, h: 18 },
      floorHeight: 0,
    });
    expect(L0(p).cells.height.every((q) => q === 0)).toBe(true);
    expect(issues(p, "no_effect")[0]?.message).toMatch(/overridden everywhere/);
  });
  it("new plans are generator 2 and old ones still validate", () => {
    expect(validatePlan(crevicePlan(1)).ok).toBe(true);
    expect(validatePlan(crevicePlan(2)).ok).toBe(true);
  });
});

describe("no silent no-ops", () => {
  it("paint under on a solid level that the areas paint over", () => {
    const p = plan({
      areas: [cave()],
      terrain: [
        { id: "lava", op: "paint", shape: { type: "rect", x: 14, y: 1, w: 3, h: 16 }, material: "lava" },
      ],
    });
    const w = issues(p, "no_effect")[0];
    expect(w?.elementId).toBe("lava");
    expect(w?.hint).toMatch(/layer "over"/);
  });
  it("over ops on rock, zone floor fields, bridge fields on rooms, empty wall-run removals, empty scatter", () => {
    const p = plan({
      areas: [
        cave(),
        {
          id: "z",
          kind: "zone",
          shape: { type: "circle", cx: 8, cy: 8, r: 3 },
          floorHeight: 0.5,
          floor: "marble",
        },
        { id: "rm", kind: "room", shape: { type: "rect", x: 20, y: 3, w: 4, h: 4 }, crumble: 0.2 },
      ],
      walls: [
        {
          id: "rw",
          op: "remove",
          points: [
            [3, 9],
            [6, 9],
          ],
        },
      ],
      terrain: [
        { id: "far", op: "height", shape: { type: "rect", x: 0, y: 0, w: 1, h: 1 }, set: 1, layer: "over" },
        {
          id: "sc",
          op: "scatter",
          feature: "boulder",
          shape: { type: "rect", x: 0, y: 0, w: 1, h: 1 },
          density: 1,
        },
      ],
    });
    const ids = issues(p, "no_effect").map((i) => i.elementId);
    expect(ids).toEqual(expect.arrayContaining(["far", "z", "rm", "rw", "sc"]));
    const zone = issues(p, "no_effect").find((i) => i.elementId === "z");
    expect(zone?.message).toMatch(/floor, floorHeight/);
    expect(zone?.hint).toMatch(/height terrain op with layer "over"/);
  });
  it("a door between two merged caves (no wall) is reported", () => {
    const p = plan({
      areas: [
        cave({ shape: { type: "rect", x: 1, y: 1, w: 10, h: 10 } }),
        { id: "c2", kind: "cave", shape: { type: "rect", x: 11, y: 1, w: 10, h: 10 } },
      ],
      openings: [{ id: "d", kind: "door", between: ["cav", "c2"] }],
    });
    expect(issues(p, "opening_no_boundary")[0]?.message).toMatch(/free-standing door/);
  });
});

describe("chasm op", () => {
  const p = plan({ areas: [cave()], terrain: [chasm()] });
  const l = L0(p);
  it("cuts a meandering lava trench through the open floor only, deterministically", () => {
    const cut = l.cells.height.map((q, i) => (q === -12 ? i : -1)).filter((i) => i >= 0);
    expect(cut.length).toBeGreaterThan(16 * 3);
    for (const i of cut) {
      expect(l.cells.state[i]).toBe(CELL.OPEN);
      expect(l.materials[(l.cells.material[i] as number) - 1]).toBe("lava");
    }
    // solid ring stays solid
    expect(l.cells.state[at(l, 15, 0)]).toBe(CELL.SOLID);
    expect(resolvePlan(p, bundledPalettes()).hash).toBe(resolvePlan(p, bundledPalettes()).hash);
    // rows differ in where the trench starts (it meanders / its banks wander)
    const starts = new Set<number>();
    for (let y = 1; y < 17; y++) {
      for (let x = 1; x < 31; x++)
        if (l.cells.height[at(l, x, y)] === -12) {
          starts.add(x);
          break;
        }
    }
    expect(starts.size).toBeGreaterThan(1);
  });
  it("lava cannot be walked: the far bank is unreachable without a bridge", () => {
    const pp = plan({
      areas: [
        cave(),
        { id: "west", kind: "cave", key: "1", shape: { type: "rect", x: 1, y: 1, w: 8, h: 16 } },
        { id: "far", kind: "cave", key: "2", shape: { type: "rect", x: 26, y: 6, w: 4, h: 4 } },
      ],
      terrain: [chasm()],
    });
    const codes = checkPlayability(pp, resolvePlan(pp, bundledPalettes())).map((i) => i.code);
    expect(codes).toContain("unreachable");
  });
  it("a chasm through rock only cuts nothing and says so", () => {
    const q = plan({
      areas: [cave({ shape: { type: "rect", x: 1, y: 1, w: 5, h: 5 } })],
      terrain: [chasm()],
    });
    expect(issues(q, "no_effect")[0]?.message).toMatch(/cut nothing/);
  });
});

describe("bridges", () => {
  const p = plan({
    areas: [
      cave(),
      { id: "west", kind: "cave", key: "1", shape: { type: "rect", x: 1, y: 1, w: 8, h: 16 } },
      { id: "far", kind: "cave", key: "2", shape: { type: "rect", x: 26, y: 6, w: 4, h: 4 } },
    ],
    terrain: [chasm({ bridges: [{ at: 0.5, width: 2, crumble: 0.3 }] })],
  });
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  const b = l.bridges?.[0];
  it("lays a deck at rim height over open air, keeping the lava beneath, with railings and crumbled cells", () => {
    expect(b).toBeDefined();
    if (!b) return;
    expect(b.id).toBe("rift~b1");
    expect(b.deck).toBe(0);
    // the floor beneath: the chasm bottom, or a ledge half way down
    expect(b.under).toContain(-12);
    expect(b.under.every((q) => q === -12 || q === -6)).toBe(true);
    expect(b.underMaterial).toContain("lava");
    expect(b.underMaterial.every((m) => m === "lava" || m === "rock")).toBe(true); // rock = a ledge part-way down
    for (const [x, y] of b.cells) {
      const f = l.cells.flags[at(l, x, y)] as number;
      expect(f & CELL_FLAG.BRIDGE).toBeTruthy();
    }
    expect(b.broken.length).toBeGreaterThan(0);
    expect(b.broken.length).toBeLessThanOrEqual(Math.round(0.3 * b.cells.length));
    for (const [x, y] of b.broken)
      expect((l.cells.flags[at(l, x, y)] as number) & CELL_FLAG.NO_FLOOR).toBeTruthy();
    // a stone deck is an arched span with a stone parapet by default
    expect(b.span).toBe("arch");
    const railing = l.wallStyles.indexOf("railing_stone");
    expect(railing).toBeGreaterThanOrEqual(0);
    expect(l.hEdges.ref.some((ref, e) => l.hEdges.kind[e] === EDGE.WALL && ref === railing)).toBe(true);
    const hs = b.cells.map(([x, y]) => l.cells.height[at(l, x, y)] as number);
    expect(Math.max(...hs)).toBeGreaterThan(0);
    expect(Math.min(...hs)).toBe(0);
    // a crumbling bridge sheds rubble at its ends
    expect(l.features.some((f) => f.id.startsWith("rift~b1#rubble") && f.type === "rubble")).toBe(true);
  });
  it("is walkable and connects the banks even when crumbled (playability)", () => {
    const codes = checkPlayability(p, r).map((i) => `${i.code}:${i.elementId ?? ""}`);
    expect(codes.filter((c) => c.startsWith("unreachable"))).toEqual([]);
    expect(issues(p, "bridge_unanchored")).toEqual([]);
  });
  it("an area of kind bridge infers its deck from its ends and gets no area walls", () => {
    const q = plan({
      areas: [
        { id: "a", kind: "room", shape: { type: "rect", x: 1, y: 1, w: 8, h: 8 } },
        {
          id: "pit",
          kind: "room",
          walls: "perimeter",
          shape: { type: "rect", x: 9, y: 1, w: 4, h: 8 },
          floor: "none",
        },
        { id: "b", kind: "room", shape: { type: "rect", x: 13, y: 1, w: 8, h: 8 } },
        {
          id: "br",
          kind: "bridge",
          shape: { type: "rect", x: 9, y: 4, w: 4, h: 2 },
          floor: "wood_plank",
          railing: "railing",
        },
      ],
      openings: [
        { id: "o1", kind: "open", between: ["a", "pit"] },
        { id: "o2", kind: "open", between: ["pit", "b"] },
      ],
    });
    const lq = L0(q);
    const br = lq.bridges?.[0];
    expect(br?.deck).toBe(0);
    expect(br?.underMaterial.every((m) => m === null)).toBe(true);
    // the deck's ends are open to the rooms (no wall from the rooms' auto walls)
    expect(lq.vEdges.kind[4 * 33 + 9]).not.toBe(EDGE.WALL);
    expect(lq.vEdges.kind[4 * 33 + 13]).not.toBe(EDGE.WALL);
  });
  it("a bridge that touches floor at one end only is bridge_unanchored", () => {
    const q = plan({
      areas: [
        cave({ shape: { type: "rect", x: 1, y: 1, w: 8, h: 8 } }),
        { id: "pit", kind: "cave", floor: "none", shape: { type: "rect", x: 9, y: 1, w: 6, h: 8 } },
        { id: "br", kind: "bridge", shape: { type: "rect", x: 9, y: 4, w: 3, h: 1 } },
      ],
    });
    expect(issues(q, "bridge_unanchored")[0]?.elementId).toBe("br");
  });
});

describe("build: cliffs, decks, lava, cave walls at the bounds", () => {
  const p = plan({
    areas: [cave({ shape: { type: "rect", x: 0, y: 0, w: 32, h: 18 } })],
    terrain: [chasm({ bridges: [{ at: 0.5, width: 2, span: "flat" }] })],
  });
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  const set = realize(r, cat);
  // the flat span's piers are the only thing allowed under its deck
  const pierCells = new Set((l.bridges?.[0]?.piers ?? []).map(([x, y]) => `${x},${y}`));
  const pl = set.levels[0]?.placements ?? [];
  const inCell = (x: number, y: number) =>
    pl.filter((q) => q.source.cell?.[0] === x && q.source.cell[1] === y);
  it("a cave filling the level bounds gets its rock walls outside the bounds: no thick_wall_conflict, no gaps", () => {
    expect(set.diagnostics.filter((d) => d.code === "thick_wall_conflict")).toEqual([]);
    expect(inCell(5, -1).some((q) => q.role === "wall")).toBe(true);
    expect(inCell(-1, 5).some((q) => q.role === "wall")).toBe(true);
    const v = verifyBuild(r, set, cat, { plan: p }).diagnostics;
    expect(v.filter((d) => d.code === "verify_wall_gap")).toEqual([]);
  });
  it("the wall at the chasm's end reaches from the chasm floor to the normal wall top", () => {
    const end = l.bridges ? inCell(15, -1).filter((q) => q.role === "wall") : [];
    const ys = end.map((q) => q.y);
    // generator 2: rock walls reach down to the lowest floor of the level (the lava's bottom, -3), never further
    expect(Math.min(...ys)).toBeCloseTo(-3);
    expect(Math.max(...ys) + 2).toBeGreaterThanOrEqual(2.5);
    // every perimeter column starts at the same skirt depth, so nothing below the room pokes out
    const perim = pl.filter(
      (q) => q.role === "wall" && (q.source.cell?.[1] === -1 || q.source.cell?.[0] === -1),
    );
    const bottoms = new Map<string, number>();
    for (const q of perim) {
      const k = String(q.source.cell);
      bottoms.set(k, Math.min(bottoms.get(k) ?? Infinity, q.y));
    }
    expect(new Set(bottoms.values())).toEqual(new Set([-3]));
    // and the tops vary (natural, not a fence)
    const tops = new Map<string, number>();
    for (const q of perim)
      tops.set(String(q.source.cell), Math.max(tops.get(String(q.source.cell)) ?? -Infinity, q.y));
    expect(new Set(tops.values()).size).toBeGreaterThan(1);
  });
  it("rim cells beside the chasm get rock cliff blocks, not stacked floor tiles", () => {
    const ledges = pl.filter((q) => q.role === "ledge");
    expect(ledges.length).toBeGreaterThan(10);
    // whole blocks down to the lava's bottom, the remainder in fill courses: nothing reaches below the lower floor
    expect(
      Math.min(...[...ledges, ...pl.filter((q) => q.role === "fill")].map((q) => q.y)),
    ).toBeGreaterThanOrEqual(-3);
    expect(ledges.every((q) => /Cave Wall/.test(placedName(set, q)))).toBe(true);
  });
  it("bridge cells: deck tile at 0, lava below at -3, nothing in between", () => {
    const cells = l.bridges?.[0]?.cells ?? [];
    expect(cells.length).toBeGreaterThan(4);
    const deckTiles = cells.flatMap(([x, y]) => inCell(x, y)).filter((q) => q.role === "floor" && q.y === 0);
    expect(deckTiles.length).toBeGreaterThan(0);
    for (const [x, y] of cells) {
      const here = inCell(x, y);
      expect(here.filter((q) => q.role === "floor").some((q) => q.y === -3 || q.y === -1.5)).toBe(true);
      if (!pierCells.has(`${x},${y}`))
        expect(here.filter((q) => q.role === "fill" || q.role === "ledge")).toEqual([]);
    }
  });

  it("decoded slab: deck 3 tiles above the lava, open air under the deck, cliff blocks below the rim", () => {
    const bundle = compileResolved(r, cat, slabCodec, { plan: p });
    expect(bundle.chunks).toHaveLength(1);
    const chunk = bundle.chunks[0];
    if (!chunk) return;
    expect(chunk.compressedBytes).toBeLessThan(24 * 1024);
    const dec = slabCodec.decode(chunk.slab);
    const resolve = createRoleResolver(cat);
    const uuids = (role: string): Set<string> =>
      new Set(resolve("cave", role).resolution?.variants.map((v) => v.uuid) ?? []);
    const lava = uuids("floor.lava");
    const deck = uuids("floor.flagstone");
    const cliff = new Set([...uuids("cliff.rock"), ...uuids("wall.cave_rock")]);
    const lavaY = Math.min(...dec.assets.filter((a) => lava.has(a.uuid)).map((a) => a.sy));
    const deckTiles = dec.assets.filter((a) => deck.has(a.uuid));
    // the deck is the highest course of its material (pier remainders may use the same tile lower down)
    const deckY = Math.max(...deckTiles.map((a) => a.sy));
    expect(deckY - lavaY).toBe(300);
    // nothing but the lava tile stands in a deck column between the lava and the deck
    const fillIds = uuids("fill.default");
    for (const d of deckTiles.filter((t) => t.sy === deckY)) {
      const under = dec.assets.filter(
        (a) =>
          !fillIds.has(a.uuid) &&
          !deck.has(a.uuid) && // pier courses of the deck material
          a.sx >= d.sx &&
          a.sx < d.sx + 100 &&
          a.sz >= d.sz &&
          a.sz < d.sz + 100 &&
          a.sy > lavaY &&
          a.sy < deckY,
      );
      expect(under).toEqual([]);
    }
    const cliffs = dec.assets.filter((a) => cliff.has(a.uuid) && a.sy < deckY && a.sy >= lavaY - 100);
    expect(cliffs.length).toBeGreaterThan(10);
  });
});

describe("2D preview and ASCII show depth", () => {
  const p = plan({
    areas: [cave()],
    terrain: [chasm({ bridges: [{ at: 0.5, width: 2, crumble: 0.25 }] })],
  });
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  it("display list: graded depth tint, cliff segments with the low side on the right, a bridge overlay", () => {
    const list = buildDisplayList(l, DEFAULT_DISPLAY_OPTIONS);
    expect(list.items.some((i) => i.style === "height-down-12")).toBe(true);
    const cliff = list.items.find((i) => i.style === "cliff");
    expect(cliff?.geom?.rings.length).toBeGreaterThan(10);
    for (const ring of cliff?.geom?.rings ?? []) {
      const [x0, y0, x1, y1] = ring as [number, number, number, number];
      // right of the direction of travel (screen coords, y down) is (−dy, dx)
      const mx = (x0 + x1) / 2 + -(y1 - y0) * 0.5;
      const my = (y0 + y1) / 2 + (x1 - x0) * 0.5;
      const lx = (x0 + x1) / 2 - -(y1 - y0) * 0.5;
      const ly = (y0 + y1) / 2 - (x1 - x0) * 0.5;
      const low = l.cells.height[at(l, Math.floor(mx), Math.floor(my))] as number;
      const high = l.cells.height[at(l, Math.floor(lx), Math.floor(ly))] as number;
      expect(low).toBeLessThan(high);
    }
    expect(list.items.some((i) => i.style.startsWith("bridge-") && i.ref === "rift~b1")).toBe(true);
    const legend = legendEntries(list).map((e) => e.id);
    expect(legend).toEqual(expect.arrayContaining(["cliff", "bridge", "height-down"]));
  });
  it("ASCII marks lava, the deck and holes, and lists them in the legend", () => {
    const text = asciiView(r, "lv");
    expect(text).toContain("%");
    expect(text).toContain("=");
    expect(text).toMatch(/legend: .*% lava.*= bridge deck/);
  });
});

describe("structure: platforms, stairs, uneven ground, outcrops", () => {
  const p = plan({
    areas: [cave({ key: "1" })],
    terrain: [
      {
        id: "dais",
        op: "platform",
        shape: { type: "circle", cx: 8.5, cy: 9.5, r: 4.5 },
        tiers: 3,
        stairs: ["E"],
      },
      {
        id: "ter",
        op: "platform",
        shape: { type: "rect", x: 20, y: 1, w: 10, h: 3 },
        tiers: 1,
        rise: 1,
        stairs: ["S"],
      },
      { id: "col", op: "outcrop", shape: { type: "rect", x: 25, y: 12, w: 2, h: 2 } },
      {
        id: "rough",
        op: "uneven",
        shape: { type: "rect", x: 14, y: 6, w: 16, h: 11 },
        amount: 1,
        exclude: [{ type: "rect", x: 24, y: 11, w: 4, h: 4 }],
      },
    ],
  });
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  it("a three-tier dais: rings 0.5 apart, top at 1.5, stair edges on the requested side", () => {
    expect(l.cells.height[at(l, 8, 9)]).toBe(6);
    expect(l.cells.height[at(l, 4, 9)]).toBe(2);
    const stairs = [...l.hEdges.kind, ...l.vEdges.kind].filter((k) => k === EDGE.STAIR).length;
    expect(stairs).toBeGreaterThanOrEqual(6);
    expect(asciiView(r, "lv", { region: { x: 2, y: 4, w: 14, h: 12 } })).toMatch(/3/);
  });
  it("a 1-tile terrace is walkable only by its stairs, which get a real stair piece", () => {
    const codes = checkPlayability(p, r).map((i) => i.code);
    expect(codes).not.toContain("unreachable");
    const set = realize(r, cat);
    const steps = (set.levels[0]?.placements ?? []).filter((q) => q.source.elementId === "steps");
    // the terrace's 1-tile rise gets a stair piece; the dais's 0.5 rises get half-height step pieces (step.*)
    // natural ground climbs on rock or earth steps (link.stairs.natural: bg_stairs_01 in a cave), named in lower case
    const stairs = steps.filter((q) => /stairs/i.test(placedName(set, q)));
    expect(stairs.length).toBe(2);
    for (const q of stairs) expect(q.y).toBeCloseTo(0.5);
    expect(steps.length).toBeGreaterThan(stairs.length);
  });
  it("an outcrop is an irregular rock mass: tapered heights, recorded for dressing, built as rock columns", () => {
    const o = l.outcrops?.find((x) => x.id === "col");
    expect(o).toBeDefined();
    const hs = (o?.cells ?? []).map(([x, y]) => l.cells.height[at(l, x, y)] as number);
    expect(Math.min(...hs)).toBeGreaterThanOrEqual(2);
    expect(o?.peak).toBeGreaterThanOrEqual(1);
    const set = realize(r, cat);
    const pl = set.levels[0]?.placements ?? [];
    for (const [x, y] of o?.cells ?? []) {
      const here = pl.filter((q) => q.source.cell?.[0] === x && q.source.cell[1] === y);
      // no floor tile on top: a column of rock pieces reaching the cell's top
      expect(here.filter((q) => q.role === "floor")).toEqual([]);
      expect(here.some((q) => q.role === "ledge" || q.role === "fill")).toBe(true);
    }
  });
  it("uneven ground stays walkable (neighbours ≤ 0.5 apart) and spares the excluded cells", () => {
    let maxStep = 0;
    let changed = 0;
    for (let y = 6; y < 17; y++)
      for (let x = 14; x < 30; x++) {
        const i = at(l, x, y);
        if (l.cells.state[i] !== CELL.OPEN) continue;
        if (x >= 23 && x <= 27 && y >= 10 && y <= 14) continue; // the excluded corner holds the outcrop
        if ((l.cells.height[i] as number) !== 0) changed++;
        const j = at(l, x + 1, y);
        if (x + 1 < 30 && l.cells.state[j] === CELL.OPEN)
          maxStep = Math.max(
            maxStep,
            Math.abs((l.cells.height[i] as number) - (l.cells.height[j] as number)),
          );
      }
    expect(changed).toBeGreaterThan(5);
    expect(maxStep).toBeLessThanOrEqual(2);
    expect(l.cells.height[at(l, 24, 11)]).toBe(0);
  });
  it("2D: stair symbols climb toward the higher cell", () => {
    const list = buildDisplayList(l, DEFAULT_DISPLAY_OPTIONS);
    const steps = list.items.filter((i) => i.style === "steps");
    expect(steps.length).toBeGreaterThan(4);
    expect(steps.some((i) => i.symbol?.rot === 0)).toBe(true); // terrace stairs climb north
  });
  it("a stairs op runs down into a dry chasm", () => {
    const q = plan({
      areas: [cave({ key: "1" })],
      terrain: [
        chasm({ floor: "rock", meander: 0 }),
        { id: "down", op: "stairs", from: [10, 8], to: [15, 8] },
      ],
    });
    const lq = L0(q);
    const hs = [10, 11, 12, 13, 14, 15].map((x) => lq.cells.height[at(lq, x, 8)]);
    expect(hs[0]).toBe(0);
    expect(issues(q, "stairs_invalid")).toEqual([]);
    expect(issues(q, "no_effect")).toEqual([]);
  });
});

describe("generality: an open-air hillside (no walls) with a plateau, a stream and an inclined plank stair", () => {
  const p: MapPlan = {
    ...plan({}),
    theme: "outdoor",
    kind: "outdoor",
    levels: [
      {
        id: "lv",
        name: "Hill",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 24, h: 20 },
        base: { type: "ground", material: "grass" },
        // these tests measure the terrain itself, not the natural board outline
        outline: "rect",
        areas: [
          {
            id: "climb",
            kind: "bridge",
            shape: { type: "rect", x: 18, y: 3, w: 1, h: 7 },
            floor: "bridge_wood",
          },
        ],
        openings: [],
        walls: [],
        features: [],
        terrain: [
          {
            id: "plateau",
            op: "platform",
            shape: { type: "rect", x: 0, y: 0, w: 24, h: 6 },
            tiers: 3,
            rise: 1,
            inset: 2,
            material: "grass",
            stairs: ["S"],
            edge: "clean",
          },
          {
            id: "brook",
            op: "chasm",
            points: [
              [0, 14],
              [23, 15],
            ],
            width: 2,
            depth: 1,
            floor: "water_shallow",
            bridges: [{ at: 0.3, width: 1, span: "plank", floor: "bridge_wood" }],
          },
          { id: "crag", op: "outcrop", shape: { type: "circle", cx: 6.5, cy: 10.5, r: 1.5 }, height: 3 },
        ],
        labels: [],
      },
    ],
  };
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  it("the plateau stays high against the map edge and steps down toward the lowland", () => {
    expect(l.cells.height[at(l, 10, 0)]).toBe(12);
    expect(l.cells.height[at(l, 10, 5)]).toBe(4);
    expect(l.cells.height[at(l, 0, 0)]).toBe(12);
  });
  it("the bridge from the lowland up the plateau is an inclined span, walkable via steps", () => {
    const b = l.bridges?.find((x) => x.id === "climb");
    const hs = (b?.cells ?? []).map(([x, y]) => l.cells.height[at(l, x, y)] as number);
    expect(new Set(hs).size).toBeGreaterThan(3);
    expect(issues(p, "bridge_unanchored")).toEqual([]);
    expect(checkPlayability(p, r).filter((i) => i.severity === "error")).toEqual([]);
  });
  it("no walls anywhere; the stream is a shallow water channel with a plank bridge", () => {
    expect(l.wallStyles.filter((w) => w !== "railing")).toEqual([]);
    const stream = l.cells.height.filter(
      (q, i) => q === -4 && l.materials[(l.cells.material[i] as number) - 1] === "water_shallow",
    );
    expect(stream.length).toBeGreaterThan(20);
    expect(l.bridges?.some((x) => x.span === "plank")).toBe(true);
  });
  it("builds with no cave assumptions and a solid foundation along the border", () => {
    const set = realize(r, cat);
    const pl = set.levels[0]?.placements ?? [];
    expect(pl.length).toBeGreaterThan(100);
    // open-air levels stand on a 2-tile foundation by default (and nothing goes deeper)
    expect(Math.min(...pl.filter((q) => q.role !== "feature").map((q) => q.y))).toBeGreaterThanOrEqual(
      -2 - 1e-6,
    );
    expect(l.foundation).toBe(2);
    // a lowland border cell stands on a foundation down to the stream bed's level
    expect(
      pl.some(
        (q) =>
          q.source.cell?.[0] === 0 && q.source.cell[1] === 18 && (q.role === "fill" || q.role === "ledge"),
      ),
    ).toBe(true);
  });
});

describe("water, mouths, paths, raised decks, risers", () => {
  const brook = (): MapPlan => ({
    ...plan({}),
    theme: "outdoor",
    kind: "outdoor",
    levels: [
      {
        id: "lv",
        name: "Meadow",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 20, h: 14 },
        base: { type: "ground", material: "grass" },
        // these tests measure the terrain itself, not the natural board outline
        outline: "rect",
        areas: [
          { id: "hut", kind: "room", shape: { type: "rect", x: 2, y: 2, w: 4, h: 3 }, floor: "wood_plank" },
          {
            id: "tower",
            kind: "bridge",
            shape: { type: "rect", x: 14, y: 2, w: 3, h: 3 },
            floor: "wood_plank",
            floorHeight: 2,
          },
        ],
        openings: [{ id: "door", kind: "door", between: ["hut", "@outside"] }],
        walls: [],
        features: [{ id: "well", type: "well", at: [10, 11] }],
        terrain: [
          {
            id: "brook",
            op: "chasm",
            points: [
              [0, 8],
              [19, 8],
            ],
            width: 2,
            depth: 1,
            floor: "water_shallow",
            meander: 0,
          },
          { id: "lane", op: "path", connect: ["hut", "well"], width: 1, material: "dirt", kerb: true },
        ],
        labels: [],
      },
    ],
  });
  const p = brook();
  const r = resolvePlan(p, bundledPalettes());
  const l = r.levels[0] as ResolvedLevel;
  const set = realize(r, cat);
  const pl = set.levels[0]?.placements ?? [];
  it("a water channel is floored with its bed (never an open void) and no slab water tile is the only surface", () => {
    const water: Array<[number, number]> = [];
    for (let y = 0; y < 14; y++)
      for (let x = 0; x < 20; x++)
        if (l.materials[(l.cells.material[at(l, x, y)] as number) - 1] === "water_shallow")
          water.push([x, y]);
    expect(water.length).toBeGreaterThan(10);
    for (const [x, y] of water) {
      const here = pl.filter((q) => q.source.cell?.[0] === x && q.source.cell[1] === y && q.role === "floor");
      expect(here.some((q) => q.source.elementId === "bed")).toBe(true);
    }
    const tempWater = pl.filter((q) => /tempWater/i.test(placedName(set, q)));
    expect(tempWater).toEqual([]);
  });
  it("every open cell with a floor has a floor surface in the build", () => {
    const v = verifyBuild(r, set, cat, { plan: p }).diagnostics.filter(
      (d) => d.code === "verify_floor_missing",
    );
    expect(v).toEqual([]);
  });
  it("one water surface per level: recorded, warned when dry floor lies below it, and handed to the GM", () => {
    // the channel is 1 deep (bed top -0.5); the surface aims half a tile below the banks (top 0.5)
    expect(l.waterLevel).toBe(0);
    const bundle = compileResolved(r, cat, slabCodec, { plan: p });
    expect(bundle.waterLevels?.[0]?.levelId).toBe("lv");
    expect(bundle.waterLevels?.[0]?.aboveBase).toBeGreaterThan(0);
    expect(bundle.instructions).toMatch(/water level to about [0-9.]+ tiles/);
    expect(bundle.instructions).toMatch(/surrounded by water/);
    const w = bundle.waterLevels?.[0];
    expect(w && w.min < w.aboveBase && w.aboveBase < w.max).toBe(true);
    expect(w ? w.max - w.min : 0).toBeGreaterThanOrEqual(0.5);
    expect(bundle.diagnostics.some((d) => d.code === "verify_water_level" && d.stage === "verify")).toBe(
      true,
    );
    // a dry pit on the same map would be flooded by the plane
    const q = brook();
    (q.levels[0] as Level).terrain.push({
      id: "pit",
      op: "platform",
      shape: { type: "rect", x: 8, y: 2, w: 3, h: 3 },
      tiers: 1,
      rise: -1,
    });
    expect(issues(q, "water_level")[0]?.severity).toBe("warning");
  });
  it("a path connects named things and gets kerbs where it meets other floor", () => {
    const path = l.cells.flags.filter((f) => (f & CELL_FLAG.PATH) !== 0).length;
    expect(path).toBeGreaterThan(5);
    expect(issues(p, "ref_unknown")).toEqual([]);
    // kerbs are occasional stones: never both sides of one cell
    const sides = new Map<string, Set<string>>();
    for (const k of l.kerbs ?? []) {
      const key = String(k.at);
      sides.set(key, (sides.get(key) ?? new Set()).add(k.side));
    }
    for (const ss of sides.values()) {
      expect(ss.has("N") && ss.has("S")).toBe(false);
      expect(ss.has("E") && ss.has("W")).toBe(false);
    }
  });
  it("a raised deck on supports (watchtower) gets corner posts and open air beneath", () => {
    const t = l.bridges?.find((b) => b.id === "tower");
    expect(t?.piers?.length).toBe(4);
    const posts = pl.filter((q) => q.source.elementId === "pier");
    expect(posts.length).toBeGreaterThanOrEqual(4);
  });
  it("risers of half-tile steps use the floor's own tile, not a foreign fill", () => {
    const q = plan({
      areas: [cave({ key: "1" })],
      terrain: [
        {
          id: "step",
          op: "platform",
          shape: { type: "rect", x: 4, y: 4, w: 6, h: 6 },
          tiers: 1,
          rise: 0.5,
          material: "rock",
        },
      ],
    });
    const rq = resolvePlan(q, bundledPalettes());
    const fills = (realize(rq, cat).levels[0]?.placements ?? []).filter((x) => x.role === "fill");
    expect(fills.length).toBeGreaterThan(0);
    const floorRock = new Set(
      createRoleResolver(cat)("cave", "floor.rock").resolution?.variants.map((v) => v.uuid),
    );
    const fillRock = new Set(
      createRoleResolver(cat)("cave", "fill.rock").resolution?.variants.map((v) => v.uuid),
    );
    expect(fills.every((x) => floorRock.has(x.asset) || fillRock.has(x.asset))).toBe(true);
  });
  it("uneven ground moves in whole half tiles (no quarter-tile cracks)", () => {
    const q = plan({ areas: [cave({ key: "1" })], terrain: [{ id: "u", op: "uneven", amount: 1 }] });
    const lq = L0(q);
    expect(lq.cells.height.every((h) => h % 2 === 0)).toBe(true);
  });
  it("a chasm still splits the room, and the walls across its mouths stand at least a block above their neighbours' minimum", () => {
    const q = plan({
      areas: [cave({ shape: { type: "rect", x: 0, y: 0, w: 32, h: 18 } })],
      terrain: [chasm()],
    });
    const rq = resolvePlan(q, bundledPalettes());
    const lq = rq.levels[0] as ResolvedLevel;
    expect(lq.cells.height[at(lq, 15, 0)]).toBeLessThan(0);
    const walls = (realize(rq, cat).levels[0]?.placements ?? []).filter((x) => x.role === "wall");
    const topAt = (x: number, y: number): number =>
      Math.max(...walls.filter((w) => w.source.cell?.[0] === x && w.source.cell[1] === y).map((w) => w.y));
    // the column above the chasm's north end (outside the bounds) is never one of the low stretches
    const mouthCols = [12, 13, 14, 15, 16, 17, 18]
      .filter((x) => (lq.cells.height[at(lq, x, 0)] as number) < 0)
      .map((x) => topAt(x, -1))
      .filter(Number.isFinite);
    expect(mouthCols.length).toBeGreaterThan(0);
    for (const t of mouthCols) expect(t).toBeGreaterThanOrEqual(2.5);
  });
});

describe("winding paths, intermittent kerbs, ragged ground, watchtower stairs", () => {
  const meadow = (terrain: TerrainOp[], areas: Area[] = []): MapPlan => ({
    ...plan({}),
    theme: "outdoor",
    kind: "outdoor",
    levels: [
      {
        id: "lv",
        name: "Meadow",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 30, h: 20 },
        base: { type: "ground", material: "grass" },
        // these tests measure the terrain itself, not the natural board outline
        outline: "rect",
        areas,
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
      },
    ],
  });
  const pathCells = (l: ResolvedLevel): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < l.bounds.w * l.bounds.h; i++)
      if (((l.cells.flags[i] as number) & CELL_FLAG.PATH) !== 0)
        out.push([i % l.bounds.w, Math.floor(i / l.bounds.w)]);
    return out;
  };
  it("a dirt path winds and varies in width; a paved one stays straight", () => {
    const trail = L0(
      meadow([
        {
          id: "t",
          op: "path",
          points: [
            [0, 10],
            [29, 10],
          ],
          width: 2,
          material: "dirt",
        },
      ]),
    );
    const cells = pathCells(trail);
    const cols = new Map<number, number[]>();
    for (const [x, y] of cells) cols.set(x, [...(cols.get(x) ?? []), y]);
    const centres = [...cols.values()].map((ys) => ys.reduce((a, b) => a + b, 0) / ys.length);
    const widths = [...cols.values()].map((ys) => ys.length);
    expect(Math.max(...centres) - Math.min(...centres)).toBeGreaterThanOrEqual(1.5);
    expect(new Set(widths).size).toBeGreaterThan(1);
    const road = L0(
      meadow([
        {
          id: "r",
          op: "path",
          points: [
            [0, 10],
            [29, 10],
          ],
          width: 2,
          material: "cobble",
        },
      ]),
    );
    expect(new Set(pathCells(road).map(([, y]) => y)).size).toBe(2);
  });
  it("kerbs are broken runs on the verge, never on the path cells", () => {
    const p = meadow([
      {
        id: "t",
        op: "path",
        points: [
          [0, 10],
          [29, 10],
        ],
        width: 2,
        material: "dirt",
        kerb: true,
      },
    ]);
    const r = resolvePlan(p, bundledPalettes());
    const l = r.levels[0] as ResolvedLevel;
    const edges = pathCells(l).length * 2;
    expect(l.kerbs?.length ?? 0).toBeGreaterThan(0);
    expect(l.kerbs?.length ?? 0).toBeLessThan(edges * 0.6);
    const set = realize(r, cat);
    const kerbs = (set.levels[0]?.placements ?? []).filter((q) => q.source.elementId === "kerb");
    const hg = 20;
    for (const q of kerbs) {
      const b = set.placed.get(q)?.box;
      if (!b) continue;
      const cx = Math.floor((b.min.x + b.max.x) / 2);
      const cy = Math.floor(hg - (b.min.z + b.max.z) / 2);
      expect(((l.cells.flags[at(l, cx, cy)] as number) & CELL_FLAG.PATH) === 0).toBe(true);
    }
  });
  it("natural platforms and height ops get wandering contours; built ones stay crisp", () => {
    const mound = L0(
      meadow([
        {
          id: "m",
          op: "platform",
          shape: { type: "rect", x: 2, y: 2, w: 26, h: 8 },
          tiers: 2,
          rise: 0.5,
          inset: 2,
          material: "grass",
        },
      ]),
    );
    // the south edge of tier 1 is not one straight row
    const southRow = (x: number): number => {
      let y = 2;
      while (y < 12 && (mound.cells.height[at(mound, x, y)] as number) > 0) y++;
      return y;
    };
    const rows = new Set(Array.from({ length: 20 }, (_, k) => southRow(k + 4)));
    expect(rows.size).toBeGreaterThan(1);
    const dais = L0(
      meadow([
        {
          id: "d",
          op: "platform",
          shape: { type: "rect", x: 2, y: 2, w: 26, h: 8 },
          tiers: 2,
          rise: 0.5,
          inset: 2,
          material: "marble",
        },
      ]),
    );
    expect(dais.cells.height[at(dais, 10, 9)]).toBe(2);
    expect(dais.cells.height[at(dais, 20, 9)]).toBe(2);
  });
  it("water channels are a tile deep by default (half a tile of tolerance for the water slider)", () => {
    const l = L0(
      meadow([
        {
          id: "b",
          op: "chasm",
          points: [
            [0, 15],
            [29, 15],
          ],
          width: 2,
          floor: "water_shallow",
          meander: 0,
        },
      ]),
    );
    expect(Math.min(...l.cells.height)).toBe(-4);
  });
  it("stairs onto a raised deck (watchtower) anchor it and make it reachable", () => {
    const p = meadow(
      [{ id: "up", op: "stairs", from: [15, 14], to: [15, 10] }],
      [
        {
          id: "yard",
          kind: "courtyard",
          key: "1",
          shape: { type: "rect", x: 5, y: 12, w: 20, h: 6 },
          floor: "grass",
        },
        {
          id: "tower",
          kind: "bridge",
          key: "2",
          shape: { type: "rect", x: 14, y: 8, w: 3, h: 3 },
          floor: "wood_plank",
          floorHeight: 2,
        },
      ],
    );
    const r = resolvePlan(p, bundledPalettes());
    expect(issues(p, "bridge_unanchored")).toEqual([]);
    const codes = checkPlayability(p, r).map((i) => i.code);
    expect(codes).not.toContain("area_sealed");
    expect(codes).not.toContain("unreachable");
    const l = r.levels[0] as ResolvedLevel;
    expect([...l.hEdges.kind, ...l.vEdges.kind].filter((k) => k === EDGE.STAIR).length).toBeGreaterThan(2);
  });
});

describe("winding trails, organic tiers, fitting steps, cracked rifts", () => {
  const open = (terrain: TerrainOp[], seed = 1): MapPlan => ({
    ...plan({}),
    seed,
    theme: "outdoor",
    kind: "outdoor",
    levels: [
      {
        id: "lv",
        name: "Glade",
        elevation: 0,
        bounds: { x: 0, y: 0, w: 40, h: 30 },
        base: { type: "ground", material: "grass" },
        // these tests measure the terrain itself, not the natural board outline
        outline: "rect",
        areas: [],
        openings: [],
        walls: [],
        features: [],
        terrain,
        labels: [],
      },
    ],
  });
  const cellsOf = (l: ResolvedLevel, pred: (i: number) => boolean): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < l.bounds.w * l.bounds.h; i++)
      if (pred(i)) out.push([i % l.bounds.w, Math.floor(i / l.bounds.w)]);
    return out;
  };
  const isPath = (l: ResolvedLevel) => (i: number) => ((l.cells.flags[i] as number) & CELL_FLAG.PATH) !== 0;
  const dogleg: TerrainOp = {
    id: "path",
    op: "path",
    points: [
      [0, 12],
      [20, 12],
      [20, 21],
      [39, 21],
    ],
    width: 2,
    material: "dirt",
  };

  it("a natural trail through dogleg points has no long straight runs (measured on the resolved cells)", () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const l = L0(open([dogleg], seed));
      const cells = cellsOf(l, isPath(l));
      expect(longestStraight(cells)).toBeLessThanOrEqual(8);
      expect(squareCorners(cells, 4)).toBeLessThanOrEqual(2);
    }
    const road = L0(open([{ ...dogleg, style: "straight" }]));
    expect(longestStraight(cellsOf(road, isPath(road)))).toBeGreaterThanOrEqual(15);
  });
  it("a trail widens only a little, and round, where it meets a connect point", () => {
    const l = L0(
      open([
        {
          id: "t",
          op: "path",
          connect: [
            [8, 15],
            [19, 18],
          ],
          width: 2,
          material: "dirt",
        },
      ]),
    );
    for (const [ax, ay] of [
      [8, 15],
      [19, 18],
    ] as const) {
      const near = cellsOf(l, isPath(l)).filter(([x, y]) => Math.abs(x - ax) <= 2 && Math.abs(y - ay) <= 2);
      // a rounded spot one cell wider than the trail, never a filled 5x5 square
      expect(near.length).toBeLessThanOrEqual(21);
    }
  });
  it("a natural 12x12 mound has wandering, rounded tiers; a clean one stays square", () => {
    const mound = (edge?: "ragged" | "clean", seed = 1): Array<[number, number]> => {
      const op: TerrainOp = {
        id: "m",
        op: "platform",
        shape: { type: "rect", x: 10, y: 8, w: 12, h: 12 },
        tiers: 3,
        rise: 0.5,
        inset: 1,
        material: "grass",
        ...(edge ? { edge } : {}),
      };
      const l = L0(open([op], seed));
      return cellsOf(l, (i) => (l.cells.height[i] as number) > 0);
    };
    const clean = mound("clean");
    expect(longestStraight(clean)).toBe(12);
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const m = mound(undefined, seed);
      expect(longestStraight(m)).toBeLessThanOrEqual(5);
      expect(squareCorners(m, 4)).toBeLessThanOrEqual(1);
      expect(boxFill(m)).toBeLessThan(0.8);
    }
  });
  it("no tier step of a ragged mound runs straight for more than 5 cells, stacked tiers included", () => {
    // every step between neighbouring cells, same direction, along one line (rows and columns)
    const longestStep = (l: ReturnType<typeof L0>): number => {
      const W = l.bounds.w;
      const H = l.bounds.h;
      const h = (x: number, y: number): number => l.cells.height[y * W + x] as number;
      let best = 0;
      for (const horiz of [true, false]) {
        const A = horiz ? H : W;
        const B = horiz ? W : H;
        for (let u = 1; u < A; u++) {
          let run = 0;
          let dir = 0;
          for (let v = 0; v < B; v++) {
            const d = horiz ? Math.sign(h(v, u - 1) - h(v, u)) : Math.sign(h(u - 1, v) - h(u, v));
            run = d !== 0 && d === dir ? run + 1 : d !== 0 ? 1 : 0;
            dir = d;
            best = Math.max(best, run);
          }
        }
      }
      return best;
    };
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const op: TerrainOp = {
        id: "m",
        op: "platform",
        shape: { type: "rect", x: 5, y: 5, w: 20, h: 16 },
        tiers: 4,
        rise: 1,
        inset: 1,
        material: "grass",
      };
      expect(longestStep(L0(open([op], seed)))).toBeLessThanOrEqual(5);
    }
  });
  it("a hillside terrace edge wanders instead of running ruler-straight", () => {
    const l = L0(
      open([
        {
          id: "pl",
          op: "platform",
          shape: { type: "rect", x: 0, y: 0, w: 40, h: 9 },
          tiers: 2,
          rise: 1,
          inset: 2,
          material: "grass",
        },
      ]),
    );
    // for each column, the row where the terrace ends; runs of equal rows stay short
    const end = Array.from({ length: 40 }, (_, x) => {
      let y = 0;
      while (y < 30 && (l.cells.height[at(l, x, y)] as number) > 0) y++;
      return y;
    });
    let run = 1;
    let longest = 1;
    for (let x = 1; x < 40; x++) {
      run = end[x] === end[x - 1] ? run + 1 : 1;
      longest = Math.max(longest, run);
    }
    expect(longest).toBeLessThanOrEqual(8);
    expect(new Set(end).size).toBeGreaterThanOrEqual(4);
  });
  it("step pieces taller than the rise are not placed (no blocks standing on the lower floor)", () => {
    const p = open([
      {
        id: "shelf",
        op: "platform",
        shape: { type: "rect", x: 0, y: 0, w: 12, h: 6 },
        tiers: 1,
        rise: 1.5,
        material: "grass",
        edge: "clean",
      },
      { id: "up", op: "stairs", from: [6, 10], to: [6, 5], width: 2 },
    ]);
    const r = resolvePlan(p, bundledPalettes());
    const l = r.levels[0] as ResolvedLevel;
    const set = realize(r, cat);
    const steps = (set.levels[0]?.placements ?? []).filter((q) => q.source.elementId === "steps");
    for (const q of steps) {
      const [x, y] = q.source.cell ?? [0, 0];
      const upper = Math.max(
        ...[
          [x + 1, y],
          [x - 1, y],
          [x, y + 1],
          [x, y - 1],
        ].map(([nx, ny]) => (l.cells.height[at(l, nx as number, ny as number)] as number) / 4),
      );
      // the step's top never stands above the floor it climbs to
      expect(q.y + (set.placed.get(q)?.geom.size.y ?? 0)).toBeLessThanOrEqual(upper + 0.5 + 0.01);
    }
  });
  it("a default rift reads as a crack: width 2..6+, pinched ends, ledges part-way down", () => {
    const q = plan({
      areas: [cave({ shape: { type: "rect", x: 0, y: 0, w: 32, h: 18 } })],
      terrain: [
        chasm({
          points: [
            [15, 0],
            [17, 9],
            [14, 17],
          ],
          meander: 0.6,
        }),
      ],
    });
    const l = L0(q);
    const rows = new Map<number, number>();
    for (let i = 0; i < l.bounds.w * l.bounds.h; i++)
      if ((l.cells.height[i] as number) < 0)
        rows.set(Math.floor(i / l.bounds.w), (rows.get(Math.floor(i / l.bounds.w)) ?? 0) + 1);
    const widths = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, n]) => n);
    expect(Math.max(...widths) - Math.min(...widths)).toBeGreaterThanOrEqual(3);
    const mid = widths.slice(4, -4);
    expect(Math.min(widths[0] as number, widths[widths.length - 1] as number)).toBeLessThan(Math.max(...mid));
    expect(l.cells.height.some((h) => h === -6)).toBe(true); // a ledge half way down
  });
  it("the 2D water label uses the paste note's wording (above the slab bottom)", () => {
    const p: MapPlan = open([
      {
        id: "b",
        op: "chasm",
        points: [
          [0, 15],
          [39, 15],
        ],
        width: 2,
        floor: "water_shallow",
        meander: 0,
      },
    ]);
    const l = L0(p);
    const label = buildDisplayList(l, DEFAULT_DISPLAY_OPTIONS).items.find((i) => i.ref === "water-level");
    expect(label?.text?.value).toMatch(/above the slab bottom/);
    const bundle = compileResolved(resolvePlan(p, bundledPalettes()), cat, slabCodec, { plan: p });
    const figure = bundle.waterLevels?.[0]?.aboveBase;
    expect(label?.text?.value).toContain(String(figure));
  });
});
