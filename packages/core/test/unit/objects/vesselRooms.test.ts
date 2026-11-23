/**
 * Rooms aboard (Part B of the vessel-rooms round): a vessel placed as a site (resolve/objectSite.ts) is a place. The
 * harbour fixture (test/fixtures/harbour.ts: a brig and a barge moored at a wharf) is resolved with its object specs
 * and checked: every room is reachable from the main deck and from the wharf; no furniture pokes through the hull
 * (true turned footprints); deck props leave the hatches and the gangway clear; the hull's footprint keeps other
 * features out; the build is deterministic, within its piece budgets and verify-clean.
 */
import { describe, expect, it } from "vitest";
import { ARRANGE_LIMITS, planPointOf } from "../../../src/arrange";
import { realize } from "../../../src/compile";
import { verifyBuild } from "../../../src/compile/verify/verify";
import type { MapPlan } from "../../../src/contracts/plan";
import { CELL, type ResolvedPlan } from "../../../src/contracts/resolved";
import { loadPalettes } from "../../../src/palette";
import { WalkGraph, walkReachability } from "../../../src/resolve";
import { expandObjectSites, resolveWithObjects, type ObjectSite } from "../../../src/resolve/objectSite";
import type { MeterPiece } from "../../../src/review";
import { cloneJson } from "../../../src/util/canonical";
import { overlapArea, turnedFootprint, type PlanPoint } from "../../../src/util/turn";
import { HARBOUR_SPECS, QUAY_EDGE, harbourPlan } from "../../fixtures/harbour";
import { piecesOf as meterPiecesOf } from "../../fixtures/quality";

const cat = loadPalettes();
const harbour = resolveWithObjects(harbourPlan(), HARBOUR_SPECS, cat);
const site = (id: string): ObjectSite => {
  const s = harbour.sites.find((x) => x.spec.id === id);
  if (!s) throw new Error(`no site ${id}`);
  return s;
};
const key = (c: readonly [number, number]): string => `${c[0]},${c[1]}`;
/** Plan elements of a site's hull: its instances ("brig", "brig#2", "brig@quay", ...). */
const isHull = (s: ObjectSite, id: string): boolean =>
  id === s.spec.id || id.startsWith(`${s.spec.id}#`) || id.startsWith(`${s.spec.id}@`);

describe("a vessel placed as a site has rooms aboard", () => {
  it("lays the brig out by its programme: hold, berth and galley below; captain's cabin aft; forecastle forward", () => {
    const names = site("brig").rooms.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(["Hold", "Crew berth", "Galley", "Captain's cabin", "Forecastle berth"]),
    );
    const below = site("brig").rooms.filter((r) => r.level === "harbour");
    expect(below.map((r) => r.name)).toEqual(expect.arrayContaining(["Hold", "Crew berth", "Galley"]));
    expect(site("brig").decks.map((d) => d.name)).toEqual(["Main deck", "Quarterdeck", "Forecastle deck"]);
  });

  it("gives the barge a cabin aft and one open hold", () => {
    expect(
      site("barge")
        .rooms.map((r) => r.name)
        .sort(),
    ).toEqual(["Bargee's cabin", "Open hold"]);
  });

  it("furnishes every room aboard like any room of its kind", () => {
    for (const s of harbour.sites)
      for (const r of s.rooms) {
        const lv = harbour.resolved.levels.find((l) => l.id === r.level);
        const area = lv?.areas.find((a) => a.id === r.id);
        expect(area?.purpose, r.id).toBeDefined();
        expect(lv?.features.filter((f) => f.area === r.id).length, r.id).toBeGreaterThan(0);
      }
  });

  it("reaches every room from the main deck, and the main deck from the wharf", () => {
    const g = new WalkGraph(harbour.resolved);
    for (const s of harbour.sites) {
      const deck = s.decks.find((d) => d.id === s.mainDeck);
      const li = harbour.resolved.levels.findIndex((l) => l.id === deck?.level);
      const lv = harbour.resolved.levels[li];
      if (!deck || !lv) throw new Error("no main deck");
      const idx = (c: readonly [number, number]): number =>
        (c[1] - lv.bounds.y) * lv.bounds.w + (c[0] - lv.bounds.x);
      const { reached } = g.floodWithParents(
        deck.cells.map((c) => [li, idx(c)] as [number, number]),
        { secret: true },
      );
      for (const r of s.rooms) {
        const ri = harbour.resolved.levels.findIndex((l) => l.id === r.level);
        const rl = harbour.resolved.levels[ri];
        if (!rl) throw new Error("no level");
        const hit = r.cells.some(
          (c) => reached[ri]?.[(c[1] - rl.bounds.y) * rl.bounds.w + (c[0] - rl.bounds.x)] === 1,
        );
        expect(hit, `${r.name} from the ${deck.name}`).toBe(true);
      }
    }
    const fromWharf = walkReachability(harbour.plan, harbour.resolved);
    for (const s of harbour.sites)
      for (const r of s.rooms) {
        const rl = harbour.resolved.levels.find((l) => l.id === r.level);
        if (!rl) throw new Error("no level");
        const hit = r.cells.some(
          (c) => fromWharf.get(r.level)?.[(c[1] - rl.bounds.y) * rl.bounds.w + (c[0] - rl.bounds.x)] === 1,
        );
        expect(hit, `${r.name} from the wharf`).toBe(true);
      }
  });

  it("steps every mast on a deck (never over the barge's open hold)", () => {
    for (const s of harbour.sites) {
      const decks = new Set(s.decks.flatMap((d) => d.cells.map(key)));
      for (const p of s.built.parts.filter((x) => /^mast \d+$/.test(x.name))) {
        const foot = [...p.pieces].sort((a, b) => a.y - b.y)[0];
        if (!foot) continue;
        const [px, py] = planPointOf(s.anchor.at, s.anchor.turn, foot.x, foot.z);
        expect(decks.has(key([Math.floor(px), Math.floor(py)])), `${s.spec.id} ${p.name}`).toBe(true);
      }
    }
  });

  it("lands every gangway on the wharf", () => {
    for (const s of harbour.sites) {
      const landing = s.gangway[s.gangway.length - 1];
      expect(landing?.[1], s.spec.id).toBeLessThanOrEqual(QUAY_EDGE);
    }
  });
});

/** A piece's plan footprint in world x-z: its true turned rectangle off the quarter turns, else its box. */
function footprint(p: MeterPiece): PlanPoint[] {
  const cx = (p.box.min.x + p.box.max.x) / 2;
  const cz = (p.box.min.z + p.box.max.z) / 2;
  const r = ((p.rot % 90) + 90) % 90;
  if (p.size !== undefined && Math.min(r, 90 - r) > 0.5)
    return turnedFootprint(cx, cz, p.size.x, p.size.z, p.rot);
  return [
    [p.box.min.x, p.box.min.z],
    [p.box.max.x, p.box.min.z],
    [p.box.max.x, p.box.max.z],
    [p.box.min.x, p.box.max.z],
  ];
}

describe("the hull holds what is aboard", () => {
  const set = realize(harbour.resolved, cat);

  it("no furniture of a room aboard pokes through the hull (true turned footprints)", () => {
    for (const s of harbour.sites) {
      const roomIds = new Set(s.rooms.map((r) => r.id));
      const furniture = new Set(
        harbour.resolved.levels.flatMap((l) =>
          l.features.filter((f) => f.area !== undefined && roomIds.has(f.area)).map((f) => f.id),
        ),
      );
      const things = meterPiecesOf(set, (id) => furniture.has(id));
      const hull = meterPiecesOf(set, (id) => isHull(s, id));
      expect(things.length).toBeGreaterThan(5);
      const pokes: string[] = [];
      for (const t of things)
        for (const h of hull) {
          const dy = Math.min(t.box.max.y, h.box.max.y) - Math.max(t.box.min.y, h.box.min.y);
          if (dy <= 0.02) continue;
          if (overlapArea(footprint(t), footprint(h)) > 0.01) pokes.push(`${t.asset} into ${h.asset}`);
        }
      expect(pokes, s.spec.id).toEqual([]);
    }
  });

  it("deck props keep the hatches' ladders and the gangway clear", () => {
    for (const s of harbour.sites) {
      const deck = s.decks.find((d) => d.id === s.mainDeck);
      if (!deck) continue;
      const onDeck = new Set(deck.cells.map(key));
      const lanes = new Set<string>(s.gangway.map(key));
      const near = (c: readonly [number, number]): Array<[number, number]> => [
        [c[0], c[1]],
        [c[0] + 1, c[1]],
        [c[0] - 1, c[1]],
        [c[0], c[1] + 1],
        [c[0], c[1] - 1],
      ];
      // the hatches' ladders up onto the main deck, and the deck cells where the gangway comes aboard
      for (const l of harbour.resolved.links)
        if (l.id.startsWith(`${s.spec.id}~`) && l.toLevel === deck.level)
          for (const c of near(l.arrival)) if (onDeck.has(key(c))) lanes.add(key(c));
      const first = s.gangway[0];
      if (first) for (const c of near(first)) if (onDeck.has(key(c))) lanes.add(key(c));
      const lv = harbour.resolved.levels.find((l) => l.id === deck.level);
      const blocking = (lv?.arrangements ?? [])
        .filter((a) => isHull(s, a.id))
        .flatMap((a) =>
          a.pieces
            .map((p) => {
              const [px, py] = planPointOf(a.at, a.turn, p.x, p.z);
              return { cell: key([Math.floor(px), Math.floor(py)]), y: a.base + p.y, asset: p.asset };
            })
            // a piece standing on the deck there (masts' rigging high above is not in the way)
            .filter((p) => lanes.has(p.cell) && p.y < (lv?.elevation ?? 0) + 0.5 + 1.8),
        );
      expect(blocking, s.spec.id).toEqual([]);
    }
  });

  it("keeps the plan's own and generated features out of the hull's footprint", () => {
    const plan: MapPlan = cloneJson(harbourPlan());
    const [basin, wharf] = plan.levels;
    if (!basin || !wharf) throw new Error("fixture levels");
    basin.features.push({ id: "in_hull", type: "crate", at: [21, 14] });
    wharf.features.push({ id: "in_ring", type: "barrel", at: [21, QUAY_EDGE] });
    basin.terrain.push({
      id: "rocks",
      op: "scatter",
      feature: "rock",
      shape: { type: "rect", x: 0, y: 0, w: 72, h: 26 },
      density: 0.08,
      minSpacing: 1,
    });
    const r = resolveWithObjects(plan, HARBOUR_SPECS, cat);
    for (const s of r.sites) {
      const blocked = new Set(s.blocked.map(key));
      const own = new Set([...s.areas.values()].flatMap((x) => [...x]));
      for (const lv of r.resolved.levels)
        for (const f of lv.features) {
          if (f.area !== undefined && own.has(f.area)) continue;
          const cells: string[] = [];
          for (let y = 0; y < f.size[1]; y++)
            for (let x = 0; x < f.size[0]; x++) cells.push(key([f.at[0] + x, f.at[1] + y]));
          expect(
            cells.some((c) => blocked.has(c)),
            `${f.id} in ${s.spec.id}`,
          ).toBe(false);
        }
    }
    expect(r.resolved.levels.flatMap((l) => l.features).some((f) => f.id === "in_hull")).toBe(false);
  });
});

describe("the harbour builds clean", () => {
  it("is deterministic", () => {
    const again = resolveWithObjects(harbourPlan(), HARBOUR_SPECS, cat);
    expect(again.resolved.hash).toBe(harbour.resolved.hash);
  });

  it("holds every vessel to its piece budget and every instance and level to its cap", () => {
    for (const s of harbour.sites) {
      expect(s.built.over, s.spec.id).toBe(false);
      expect(s.built.count).toBeLessThanOrEqual(s.built.budget);
    }
    for (const lv of harbour.resolved.levels) {
      const mine = (lv.arrangements ?? []).filter((a) => harbour.sites.some((s) => isHull(s, a.id)));
      for (const a of mine) expect(a.pieces.length).toBeLessThanOrEqual(ARRANGE_LIMITS.piecesPerInstance);
      const all = (lv.arrangements ?? []).reduce((n, a) => n + a.pieces.length, 0);
      expect(all).toBeLessThanOrEqual(ARRANGE_LIMITS.piecesPerLevel);
    }
  });

  it("verifies with no warning or error", () => {
    const found = verifyBuild(harbour.resolved, realize(harbour.resolved, cat), cat).diagnostics.filter(
      (d) => d.severity !== "info",
    );
    expect(found.map((d) => `${d.code} ${d.elementId ?? ""} ${d.message}`)).toEqual([]);
  });

  it("stands a brig the other way round on its own as well (rooms reached, nothing broken)", () => {
    const plan = cloneJson(harbourPlan());
    const turned = expandObjectSites(
      plan,
      [
        {
          id: "west",
          kind: "vessel",
          level: "quay",
          at: [36, 17],
          heading: 270,
          size: 26,
          options: { kind: "ship" },
        },
      ],
      cat,
    );
    const names = turned.sites[0]?.rooms.map((r) => r.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["Hold", "Captain's cabin"]));
    const r = resolveWithObjects(
      plan,
      turned.sites.map((s) => s.spec),
      cat,
    ).resolved;
    const errors = verifyBuild(r, realize(r, cat), cat).diagnostics.filter((d) => d.severity === "error");
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
    expect(isOpen(r, "quay", [36, 17])).toBe(true);
  });
});

function isOpen(r: ResolvedPlan, level: string, c: readonly [number, number]): boolean {
  const lv = r.levels.find((l) => l.id === level);
  if (!lv) return false;
  return lv.cells.state[(c[1] - lv.bounds.y) * lv.bounds.w + (c[0] - lv.bounds.x)] === CELL.OPEN;
}
