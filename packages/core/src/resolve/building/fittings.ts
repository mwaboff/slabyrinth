/**
 * What a building is fitted with once its faces and condition are settled: lights beside its doors, a plinth, roof
 * furniture and window lighting (phase 2 stream `prng2`; the roof hut on `prng3`), and the cells kept free of dressing.
 */
import type { Material, Vec2 } from "../../contracts/plan";
import { SIDE_STEP as STEP } from "../../gen/gridGeometry";
import { isPassage, isSecret } from "../../gen/openingKinds";
import type { RuinProfile } from "../ruin";
import type { BuildingCtx } from "./context";
import { type BuildingFaces, GROUND_FACES } from "./faces";
import { alongFace, cellOf, faceKey, faceRuns, key, ringOf } from "./footprint";
import type { BuildingPlan, Chimney, GroundOpening, Porch } from "./types";
import type { GroundFootprint } from "./volumes";
import { characterAt, lightIndex } from "../character";

/**
 * The face of a plinth when neither the plan nor the building style names one. Neither the palette nor the theme
 * defaults (resolve/themes.ts) have a plinth face, and a theme's floor default would change released buildings, so it
 * is a named constant; a style states its own in `plinth.face`.
 */
const PLINTH_FACE_DEFAULT: Material = "flagstone";

/** A light beside each door (not a secret one), in the first free face cell after it, else before it. */
export function placeDoorLights(
  fp: GroundFootprint,
  faces: BuildingFaces,
  doorLights: boolean,
): BuildingPlan["lights"] {
  const lights: BuildingPlan["lights"] = [];
  if (!doorLights) return lights;
  for (const g of faces.ground) {
    if (!isPassage(g.kind) || isSecret(g.kind)) continue;
    const run = faceRuns(fp.cellSet, g.side).find((r) =>
      r.cells.some((c) => c[0] === g.at[0] && c[1] === g.at[1]),
    );
    if (!run) continue;
    const di = run.cells.findIndex((c) => c[0] === g.at[0] && c[1] === g.at[1]);
    const cand = [di + g.width, di - 1]
      .map((i) => run.cells[i])
      .find((c) => c && !faces.isTaken(GROUND_FACES, 0, faceKey(c[0], c[1], g.side)));
    if (cand) lights.push({ at: [cand[0], cand[1]], side: g.side });
  }
  return lights;
}

/**
 * The plinth (written, or drawn from the style: prng2): the footprint grown by its margin (out from given faces only:
 * a stoop toward the street), never into a neighbour's plot or the ring its walls stand in; cells past the level edge
 * or in another building are left off with a warning.
 */
export function drawPlinth(b: BuildingCtx, fp: GroundFootprint): BuildingPlan["plinth"] {
  const { st, profile, prng2 } = b;
  const pp = profile.plinth;
  const pIn =
    st.plinth ??
    (pp && prng2.chance(pp.chance)
      ? {
          height: Math.round((pp.height[0] + (pp.height[1] - pp.height[0]) * prng2.next()) * 2) / 2,
          margin: pp.margin,
          face: pp.face,
          rim: pp.rim ?? "none",
        }
      : null);
  if (!pIn) return null;
  const { cellSet } = fp;
  const margin = pIn.margin ?? pp?.margin ?? 1;
  let pcells = new Set(cellSet);
  const sides = pIn.sides;
  for (let m = 0; m < margin; m++) {
    if (!sides) pcells = new Set([...pcells, ...ringOf(pcells)]);
    else {
      // out from the given faces only (a stoop toward the street)
      const next = new Set(pcells);
      for (const k of pcells) {
        const [x, y] = cellOf(k);
        for (const sd of sides) next.add(key(x + STEP[sd][0], y + STEP[sd][1]));
      }
      pcells = next;
    }
  }
  // a base never reaches into a neighbour's plot or the ring its walls stand in (party walls, alleys)
  const neighbourRing = new Set<string>();
  for (const [k, o] of b.work.neighbours)
    if (o !== st.id) {
      const [x, y] = cellOf(k);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) neighbourRing.add(key(x + dx, y + dy));
    }
  const inside: Vec2[] = [];
  let clipped = false;
  for (const k of [...pcells].sort()) {
    const [x, y] = cellOf(k);
    if (!cellSet.has(k) && neighbourRing.has(k)) continue;
    if (!b.inBounds(x, y) || (fp.occupied.has(k) && !cellSet.has(k))) clipped = true;
    else inside.push([x, y]);
  }
  if (clipped)
    b.issue(
      "warning",
      `building "${st.id}": its plinth reaches past the level edge or into another building; the cells outside are left off`,
      "move the building in, or lower the plinth margin",
    );
  return {
    height: pIn.height,
    margin,
    face: pIn.face ?? pp?.face ?? PLINTH_FACE_DEFAULT,
    rim: pIn.rim === "none" ? null : (pIn.rim ?? pp?.rim ?? null),
    approach: pIn.approach ?? "steps",
    cells: inside.sort((p, q) => p[1] - q[1] || p[0] - q[0]),
  };
}

/** Roof furniture (written, else drawn: prng2; the hut on prng3). A weathered building's mast is gone (generator 3). */
export function drawRoofFurniture(b: BuildingCtx, ruin: RuinProfile | null): BuildingPlan["furniture"] {
  const { st, profile, prng2, prng3 } = b;
  const pf = profile.furniture ?? { dormers: 0, clutter: [0, 0] as const, mast: 0, finial: true };
  const furniture = {
    dormers: st.roofFurniture?.dormers ?? prng2.chance(pf.dormers),
    clutter:
      st.roofFurniture?.clutter ??
      Math.round((pf.clutter[0] + (pf.clutter[1] - pf.clutter[0]) * prng2.next()) * 100) / 100,
    mast: st.roofFurniture?.mast ?? prng2.chance(pf.mast),
    finial: st.roofFurniture?.finial ?? pf.finial,
    ...(pf.hut !== undefined || st.roofFurniture?.hut !== undefined
      ? { hut: st.roofFurniture?.hut ?? prng3.chance(pf.hut ?? 0) }
      : {}),
  };
  if (b.gen.legibleCondition && ruin?.weather && furniture.mast) {
    furniture.mast = false;
    ruin.weather.lost.push("mast");
  }
  return furniture;
}

/**
 * Window lighting (written, else drawn: prng2). A dark-walled design lights more of its windows, so they read; nobody
 * lives in a ruin; a weathered building has fewer lights on.
 */
export function drawLighting(
  b: BuildingCtx,
  condition: BuildingPlan["condition"],
  doorLights: boolean,
): BuildingPlan["lighting"] {
  const { st, profile, prng2, designed } = b;
  const pl = profile.lighting ?? {
    windows: "none" as const,
    lit: [0, 0] as const,
    colours: ["warm"],
    strips: 0,
  };
  const lighting = {
    windows: st.lighting?.windows ?? pl.windows,
    colour: st.lighting?.colour ?? pl.colours[prng2.int(Math.max(1, pl.colours.length))] ?? "warm",
    lit: Math.max(
      Math.round((pl.lit[0] + (pl.lit[1] - pl.lit[0]) * prng2.next()) * 100) / 100,
      designed && profile.design?.tones?.[designed.design.material] === "dark"
        ? (profile.design.darkLit ?? 0)
        : 0,
    ),
    doors: doorLights,
    strips: st.lighting?.strips ?? prng2.chance(pl.strips),
  };
  // generator 5 (characterCascade): its light level, not its upkeep, scales the share of windows lit (worn is not dark;
  // a ruin still has nobody in it)
  const ch = characterAt(b.work, st.id);
  if (condition === "ruined") {
    lighting.windows = "none";
    lighting.strips = false;
  } else if (ch !== null)
    lighting.lit = Math.min(1, Math.round(lighting.lit * WINDOWS_LIT_BY_LIGHT[lightIndex(ch)] * 100) / 100);
  else if (condition === "weathered")
    // most windows dark
    lighting.lit = Math.round(lighting.lit * (b.gen.legibleCondition ? 15 : 30)) / 100;
  return lighting;
}

/** A building's lit-window share multiplier by its light level (dark .. flooded). */
export const WINDOWS_LIT_BY_LIGHT = [0.25, 0.6, 1, 1.4, 1.8] as const;

/** Whether a building of this light level has lights at its doors (generator 5): none at dark unless the plan asks. */
export function doorLightsByLight(b: BuildingCtx, drawn: boolean): boolean {
  const ch = characterAt(b.work, b.st.id);
  if (ch === null || b.st.lighting?.doors !== undefined) return drawn;
  const level = lightIndex(ch);
  return level === 0 ? false : level >= 3 ? true : drawn;
}

/**
 * Cells kept free of generated dressing: the wall ring, each door's approach (two cells out, past the plinth), the
 * chimneys, the porches with a ring around them, and the plinth.
 */
export function reservedCells(
  fp: GroundFootprint,
  ground: readonly GroundOpening[],
  chimneys: readonly Chimney[],
  porches: readonly Porch[],
  plinth: BuildingPlan["plinth"],
): Set<string> {
  const reserve = new Set<string>(ringOf(fp.cellSet));
  for (const g of ground) {
    if (!isPassage(g.kind)) continue;
    const [dx, dy] = STEP[g.side];
    const reach = 2 + (plinth ? plinth.margin + Math.ceil(plinth.height) : 0);
    for (let k = 0; k < g.width; k++) {
      const [ax, ay] = alongFace(g.at, g.side, k);
      for (let d = 1; d <= reach; d++) reserve.add(key(ax + dx * d, ay + dy * d));
    }
  }
  for (const c of chimneys) reserve.add(key(c.at[0], c.at[1]));
  for (const p of porches) {
    const ps = new Set(p.cells.map(([x, y]) => key(x, y)));
    for (const k of ps) reserve.add(k);
    for (const k of ringOf(ps)) reserve.add(k);
  }
  if (plinth) for (const [x, y] of plinth.cells) reserve.add(key(x, y));
  return reserve;
}
