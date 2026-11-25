/** The shot rules on synthetic things nobody built before, and their shot lists on stored fixtures. */
import type { PlacementRole } from "@slabyrinth/core";
import { describe, expect, it } from "vitest";
import {
  assembleScene,
  boxMeshSource,
  contactSheet,
  frontOf,
  interiorShots,
  planShots,
  thingsOf,
  type PieceLookup,
  type ScenePiece,
} from "../src/index";
import { fixtureScene } from "./helpers";

const SIZE = { width: 160, height: 120 };
const BLOCK = "20000000-0000-4000-8000-000000000001";
const LOW = "20000000-0000-4000-8000-000000000002";
const FLAT = "20000000-0000-4000-8000-000000000003";
const lookup: PieceLookup = {
  info: (uuid) => {
    const h = uuid === LOW ? 0.5 : uuid === FLAT ? 0.1 : 2;
    return {
      name: "block",
      geom: { size: { x: 1, y: h, z: 1 }, originAt: "minCorner", boundsCenter: { x: 0.5, y: h / 2, z: 0.5 } },
      facts: null,
    };
  },
};

const piece = (
  x: number,
  z: number,
  role: PlacementRole,
  elementId: string,
  layer = "storey:0",
): ScenePiece => ({
  uuid: BLOCK,
  stored: { x, y: 0, z },
  rotDeg: 0,
  levelId: "g",
  layer,
  role,
  elementId,
  cell: null,
  material: null,
  geom: null,
  name: null,
});

/** A 5 x 5 ring of wall blocks round (10..14, 10..14), less the sides in `open`, a door at `door`. */
function hut(id: string, open: string[], door?: [number, number]): ScenePiece[] {
  const out: ScenePiece[] = [];
  for (let x = 10; x <= 14; x++)
    for (let z = 10; z <= 14; z++) {
      const edge = { south: z === 10, north: z === 14, west: x === 10, east: x === 14 };
      const on = Object.entries(edge)
        .filter(([, v]) => v)
        .map(([k]) => k);
      if (on.length === 0 || on.some((s) => open.includes(s))) continue;
      const isDoor = door !== undefined && door[0] === x && door[1] === z;
      out.push(piece(x, z, isDoor ? "opening" : "wall", `${id}~wall`));
    }
  // something low inside (hidden behind the walls but from an open side), and ground all round
  out.push({ ...piece(12, 12, "feature", `${id}~table`), uuid: LOW });
  for (let x = 0; x < 25; x++)
    for (let z = 0; z < 25; z++) out.push({ ...piece(x, z, "floor", "ground", "site"), uuid: FLAT });
  return out;
}

const scene = (pieces: ScenePiece[]) =>
  assembleScene("build", pieces, [{ id: "g", name: "Ground" }], lookup, boxMeshSource());

describe("shot rules", () => {
  it("finds the things of a scene: not the ground, not a piece or two", async () => {
    const s = await scene([...hut("hut", [], [14, 12]), piece(1, 1, "feature", "lone")]);
    expect(thingsOf(s).map((t) => t.id)).toEqual(["hut"]);
  });

  it("looks at a thing from the side its door faces", async () => {
    const s = await scene(hut("hut", [], [14, 12]));
    const [t] = thingsOf(s);
    expect(t && frontOf(s, t)).toEqual({ side: "east", bearing: 90, by: "openings" });
  });

  it("looks at a thing with no openings from where most of it shows (the probe)", async () => {
    // walls on three sides, open to the south: from the south the inside shows too
    const s = await scene(hut("pen", ["south"]));
    const [t] = thingsOf(s);
    expect(t && frontOf(s, t)).toEqual({ side: "south", bearing: 180, by: "probe" });
  });

  it("ranks overview, interiors, fronts, levels and keeps the budget", async () => {
    const s = await scene(hut("hut", [], [14, 12]));
    expect(planShots(s, { size: SIZE }).map((x) => x.id)).toEqual([
      "overview",
      "interior-hut-s0",
      "front-hut",
    ]);
    expect(planShots(s, { size: SIZE, max: 2 }).map((x) => x.rule)).toEqual(["overview", "interior"]);
  });

  it("frames an interior on its shell, not on a post or lamp it puts out in the street", async () => {
    const s = await scene([
      ...hut("hut", [], [14, 12]),
      piece(3, 12, "wall_post", "hut~porch"),
      { ...piece(1, 12, "feature", "hut~lamp"), uuid: LOW },
    ]);
    const [t] = thingsOf(s);
    if (!t) throw new Error("no thing");
    const [inside] = interiorShots(s, t, frontOf(s, t), SIZE);
    // the hut's walls stand on 10..15 in x and z: the camera looks at their middle
    expect(inside?.camera.target.x).toBeCloseTo(12.5, 0);
    expect(inside?.camera.target.z).toBeCloseTo(12.5, 0);
  });

  it("plans the same shots for a stored fixture every time", async () => {
    const s = await fixtureScene("market-street-v3");
    const ids = planShots(s, { size: SIZE }).map((x) => x.id);
    expect(planShots(await fixtureScene("market-street-v3"), { size: SIZE })).toEqual(
      planShots(s, { size: SIZE }),
    );
    expect(ids).toMatchInlineSnapshot(`
      [
        "overview",
        "interior-apothecary-s0",
        "interior-baker-s0",
        "interior-baker-s1",
        "interior-butcher-s0",
        "interior-butcher-s1",
        "interior-cobbler-s0",
        "interior-cooper-s0",
        "interior-inn-s0",
        "interior-reeve-s0",
        "interior-reeve-s1",
        "interior-shop-s0",
        "interior-shop-s1",
        "interior-smith-s0",
        "interior-smith-s1",
        "interior-tailor-s0",
        "front-apothecary",
        "front-baker",
        "front-butcher",
        "front-cobbler",
        "front-cooper",
        "front-inn",
        "front-market",
        "front-reeve",
        "front-shop",
        "front-smith",
        "front-tailor",
      ]
    `);
  });

  it("puts shots on one contact sheet with captions", () => {
    const pic = { width: 100, height: 50, rgba: new Uint8Array(100 * 50 * 4).fill(200) };
    const sheet = contactSheet(
      [0, 1, 2].map((i) => ({ picture: pic, caption: `shot ${i}` })),
      { tileWidth: 100 },
    );
    expect([sheet.width, sheet.height]).toEqual([8 + 2 * 108, 8 + 2 * (50 + 14 + 8 + 8)]);
  });
});
