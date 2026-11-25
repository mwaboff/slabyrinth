/**
 * Part-level rules of the object engine (objects/facing.ts), held on every object a recipe builds, not on a ship: a
 * mounted piece faces out from the body (its front read from its mesh, gen/pieceFacts.ts `front`), a control faces the
 * way the body travels, and a deck covers its body's whole outline at its level. Proven on two different objects with
 * no path of their own: the ship-kit brig and the gun platform. The checks fail on the faults they are for.
 */
import { describe, expect, it } from "vitest";
import {
  WAY_GAP,
  buildObject,
  bulwarkOpening,
  createKit,
  facingFaults,
  openDeckCells,
  openDeckEdges,
  piecesOf,
  columnTo,
  OBJECT_KITS,
  platform,
  uncappedCells,
  vessel,
  yawFacing,
  type BuiltObject,
} from "../../../src/objects";
import { placedBox } from "../../../src/arrange";
import { insideOrNear } from "../../../src/objects/outline";
import { loadPalettes } from "../../../src/palette";
import { createPlanRoles } from "../../../src/palette/planRoles";
import { resolveWithObjects } from "../../../src/resolve/objectSite";
import { HARBOUR_SPECS, harbourPlan } from "../../fixtures/harbour";

const kit = createKit(createPlanRoles(loadPalettes(), 5), "wood_town");
const brig = buildObject(vessel, { size: 30, seed: "rules", kind: "ship" }, kit);
// the platform's own kit data (objects/kit.ts OBJECT_KITS) prefers the ship family's forms
const battery = buildObject(
  platform,
  { size: 6, seed: "rules" },
  createKit(createPlanRoles(loadPalettes(), 5), "wood_town", OBJECT_KITS.platform),
);
const named = (o: BuiltObject, n: string) => piecesOf(o).filter((q) => q.piece.role === n);

describe("part-level rules hold on two different objects", () => {
  it("every gun faces out from its body and every control faces the way it travels", () => {
    expect(named(brig, "ship.cannon").length).toBeGreaterThan(0);
    expect(named(brig, "ship.helm")).toHaveLength(1);
    expect(named(battery, "ship.cannon")).toHaveLength(4);
    expect(facingFaults(brig)).toEqual([]);
    expect(facingFaults(battery)).toEqual([]);
  });

  it("every deck covers its body's outline (the raised deck to its end wall, the deck under it to the hull's end)", () => {
    expect(brig.surfaces.map((s) => s.id)).toEqual(
      expect.arrayContaining(["deck", "quarterdeck", "under the raised deck"]),
    );
    expect(openDeckCells(brig)).toEqual([]);
    expect(openDeckCells(battery)).toEqual([]);
    // the body itself is capped at each deck level (the open stern of round 4 was a deck outline short of the hull)
    const main = brig.surfaces.find((s) => s.id === "deck");
    expect(main && uncappedCells(brig, main.y)).toEqual([]);
    expect(uncappedCells(battery, 2.5)).toEqual([]);
    // and the body as laid: every cell of the square stern quarters (a shell, round 4's open tub) under some deck
    const sternCells = piecesOf(brig)
      .filter((q) => q.piece.role === "ship.hull_stern")
      .flatMap((q) => {
        const b = placedBox(q);
        const cells: Array<[number, number]> = [];
        for (let x = Math.round(b.min.x); x < Math.round(b.max.x); x++)
          for (let z = Math.round(b.min.z); z < Math.round(b.max.z); z++) cells.push([x + 0.5, z + 0.5]);
        return cells;
      });
    expect(sternCells.length).toBeGreaterThan(0);
    const decked = (c: readonly [number, number]): boolean =>
      brig.surfaces.some((s) => insideOrNear(s.polygon, c[0], c[1], 0.55));
    expect(sternCells.filter((c) => !decked(c))).toEqual([]);
  });

  it("a deck outline short of its body is uncapped", () => {
    const short: BuiltObject = {
      ...battery,
      surfaces: battery.surfaces.map((s) => ({
        ...s,
        polygon: s.polygon.map(([x, z]) => [x, Math.min(z, 1)] as const),
      })),
    };
    expect(uncappedCells(short, 2.5).length).toBeGreaterThan(0);
  });
});

describe("the checks catch the faults they are for", () => {
  it("a gun turned to face its body, or a helm turned aft, is a fault", () => {
    const turned = (o: BuiltObject, role: string): BuiltObject => ({
      ...o,
      parts: o.parts.map((p) => ({
        ...p,
        pieces: p.pieces.map((q) => (q.piece.role === role ? { ...q, yaw: (q.yaw + 180) % 360 } : q)),
      })),
    });
    expect(facingFaults(turned(battery, "ship.cannon"))).toHaveLength(4);
    expect(facingFaults(turned(brig, "ship.helm"))).toEqual([
      "Ship floor Steering wheel faces against travel",
    ]);
  });

  it("a deck with tiles missing is open", () => {
    const holed: BuiltObject = {
      ...battery,
      parts: battery.parts.map((p) => (p.name === "deck" ? { ...p, pieces: p.pieces.slice(1) } : p)),
    };
    expect(openDeckCells(holed).length).toBeGreaterThan(0);
  });

  it("turns a piece by its own front, not a table: the same rule for any direction", () => {
    const gun = named(battery, "ship.cannon")[0]?.piece;
    if (!gun) throw new Error("no gun");
    const yaws = (
      [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
      ] as const
    ).map((d) => yawFacing(gun, d));
    expect(new Set(yaws).size).toBe(4);
  });
});

describe("the platform names no kit: its kit comes from data", () => {
  const roles = createPlanRoles(loadPalettes(), 5);
  const build = (prefer: readonly string[]) =>
    buildObject(platform, { size: 6, seed: "kits" }, createKit(roles, "wood_town", prefer));

  it("builds from the ship kit's forms when its kit prefers them, from plain pieces when not", () => {
    const shipRoles = (o: BuiltObject) =>
      [...new Set(piecesOf(o).map((q) => q.piece.role))].filter((r) => r.startsWith("ship."));
    expect(shipRoles(build(["ship"]))).toEqual(expect.arrayContaining(["ship.deck", "ship.cannon"]));
    const plain = build([]);
    expect(shipRoles(plain)).toEqual([]);
    // the plain build still caps its body (the catalog has no gun outside a kit, so it carries none)
    expect(openDeckCells(plain)).toEqual([]);
    expect(uncappedCells(plain, 2.5)).toEqual([]);
  });

  it("stands its posts on the ground and under the deck, whatever post the kit has", () => {
    for (const prefer of [["ship"], []]) {
      const posts = build(prefer).parts.find((p) => p.name === "posts")?.pieces ?? [];
      expect(posts.length).toBeGreaterThan(0);
      for (const q of posts) {
        expect(q.y).toBeGreaterThanOrEqual(0);
        expect(q.y + q.piece.variant.geom.size.y).toBeLessThanOrEqual(2.0 + 0.02);
      }
    }
  });

  it("a column never reaches below the ground or above its height, a post taller than it is left out", () => {
    const post = piecesOf(battery).find((q) => q.piece.measures.kind === "prop")?.piece;
    if (!post) throw new Error("no prop");
    const tall = {
      ...post,
      variant: { ...post.variant, geom: { ...post.variant.geom, size: { ...post.variant.geom.size, y: 3 } } },
    };
    const short = {
      ...post,
      variant: {
        ...post.variant,
        geom: { ...post.variant.geom, size: { ...post.variant.geom.size, y: 0.75 } },
      },
    };
    expect(columnTo([tall], 2)).toEqual([]);
    const col = columnTo([tall, short], 2);
    expect(col.map((c) => c.y)).toEqual([0, 0.75]);
    expect(col.every((c) => c.y >= 0 && c.y + c.piece.variant.geom.size.y <= 2.02)).toBe(true);
  });
});

describe("a raised walking surface is railed wherever it drops (generator 6, railedDeckEdges)", () => {
  const at = (generator: 5 | 6, options: object = {}): BuiltObject =>
    buildObject(
      vessel,
      { size: 30, seed: "rails", kind: "ship", ...options },
      createKit(createPlanRoles(loadPalettes(), generator), "wood_town"),
    );

  it("the check finds a raised deck's open break: generator 5 leaves the quarterdeck's forward edge open", () => {
    expect(openDeckEdges(at(5)).length).toBeGreaterThan(0);
  });

  it("generator 6 rails it; the gun platform's railing holds too", () => {
    expect(openDeckEdges(at(6))).toEqual([]);
    expect(openDeckEdges(battery)).toEqual([]);
  });

  it("a gangway opens the rail by its own cell and no more, never through a long piece", () => {
    const plain = at(6);
    const sides = piecesOf(plain).filter((q) => q.piece.role === "ship.rail");
    if (sides.length === 0) throw new Error("fixture: the brig has the kit's side rails");
    // a station over the straight side rail, in the recipe's frame (the built object's z)
    const mid = sides.reduce((s, q) => s + q.z, 0) / sides.length;
    const x = Math.round(mid) + 0.5;
    expect(bulwarkOpening(plain, x, 1)).toBeLessThanOrEqual(WAY_GAP);
    expect(openDeckEdges(at(6, { gangway: { x, side: 1 } }))).toEqual([]);
    // the curved bow fence is one long piece: a way through it would open all of it
    const bow = piecesOf(plain).find((q) => q.piece.role === "ship.rail_bow");
    if (!bow) throw new Error("fixture: the brig has the kit's bow fence");
    expect(bulwarkOpening(plain, bow.z, bow.x < 0 ? 1 : -1)).toBeGreaterThan(WAY_GAP);
  });
});

describe("a gangway crosses the bulwark only where it takes away one short piece (generator 6)", () => {
  /** The barge's curved bow fences, as the harbour site builds it. */
  const bowFences = (generator: 5 | 6): number => {
    const r = resolveWithObjects({ ...harbourPlan(), generator }, HARBOUR_SPECS, loadPalettes());
    return r.resolved.levels
      .flatMap((l) => l.arrangements ?? [])
      .filter((a) => a.id.includes("barge"))
      .flatMap((a) => a.pieces)
      .filter((p) => p.role === "ship.rail_bow").length;
  };

  it("generator 5 cut the barge's port bow fence for its gangway; generator 6 keeps both halves", () => {
    expect(bowFences(5)).toBe(1);
    expect(bowFences(6)).toBe(2);
  });
});
