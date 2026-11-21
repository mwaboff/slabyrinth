/**
 * Porches: written attachments, or one drawn for the first door (prng); generator 3 (switch `buildingVariety`) draws
 * the entrance instead (none, a hood on two posts, a full-width porch, steps and a landing) from its own stream, never
 * the same as the building drawn before it. A porch stands in front of its door's face, clear of the level edge and
 * of other buildings.
 */
import type { Attachment } from "../../contracts/plan";
import { SIDE_STEP as STEP } from "../../gen/gridGeometry";
import { subSeed } from "../../util/hash";
import { createPrng } from "../../util/prng";
import type { BuildingCtx } from "./context";
import { isPassage } from "../../gen/openingKinds";
import { along, faceRuns, key } from "./footprint";
import type { GroundOpening, Porch } from "./types";
import type { GroundFootprint } from "./volumes";

type PorchSpec = Attachment & { seeded?: true };

/** Generator 3 entrance kinds and their weights. */
const ENTRANCES: Array<[string, number]> = [
  ["none", 0.2],
  ["hood", 0.3],
  ["porch", 0.25],
  ["landing", 0.25],
];
/** Draws of the generator 3 entrance before it keeps one that repeats the building before it. */
const ENTRANCE_TRIES = 8;

export function placePorches(b: BuildingCtx, fp: GroundFootprint, ground: readonly GroundOpening[]): Porch[] {
  const firstDoor = ground.find((g) => isPassage(g.kind));
  // the released porch draw comes first (prng), whether or not the generator 3 entrance replaces it
  const drawn = writtenOrDrawnPorch(b, firstDoor);
  const attachIn = varietyEntrance(b, fp, firstDoor) ?? drawn;
  const porches: Porch[] = [];
  attachIn.forEach((at, ai) => {
    const porch = placePorch(b, fp, ground, at, ai);
    if (porch) porches.push(porch);
  });
  return porches;
}

/** The written attachments, else (prng) a porch two wider than the first door, two deep. */
function writtenOrDrawnPorch(b: BuildingCtx, firstDoor: GroundOpening | undefined): PorchSpec[] {
  const { st, profile, prng } = b;
  const drawnPorch =
    st.attachments === undefined && firstDoor !== undefined
      ? prng.chance(profile.variety.porchChance)
      : false;
  return (
    st.attachments ??
    (firstDoor && drawnPorch
      ? [
          {
            type: "porch" as const,
            side: firstDoor.side,
            width: firstDoor.width + 2,
            depth: 2,
            seeded: true as const,
          },
        ]
      : [])
  );
}

/**
 * Generator 3 (switch `buildingVariety`): the entrance drawn per building (own stream "entrance3"), for buildings with
 * no written attachments whose style has porches; undefined when it does not apply.
 */
function varietyEntrance(
  b: BuildingCtx,
  fp: GroundFootprint,
  firstDoor: GroundOpening | undefined,
): PorchSpec[] | undefined {
  if (
    !b.gen.buildingVariety ||
    b.st.attachments !== undefined ||
    !firstDoor ||
    !(b.profile.variety.porchChance > 0)
  )
    return undefined;
  const ep = createPrng(subSeed(b.seed, "entrance3"));
  const last = b.work.entrances[b.work.entrances.length - 1];
  let kind = "hood";
  for (let t = 0; t < ENTRANCE_TRIES; t++) {
    let r = ep.next() * ENTRANCES.reduce((a, [, w]) => a + w, 0);
    kind = (ENTRANCES.find(([, w]) => (r -= w) < 0) ?? ["hood", 0])[0];
    if (kind !== last) break;
  }
  b.work.entrances.push(kind);
  const frontRun = faceRuns(fp.cellSet, firstDoor.side)[0];
  return kind === "none"
    ? []
    : [
        {
          type: "porch" as const,
          side: firstDoor.side,
          width:
            kind === "porch"
              ? Math.min(frontRun?.cells.length ?? 5, Math.max(firstDoor.width + 4, 5))
              : firstDoor.width + 2,
          depth: kind === "landing" ? 1 : 2,
          ...(kind === "landing" ? { roof: "none" as const } : {}),
          seeded: true as const,
        },
      ];
}

/** One porch: centred on the door of its face (or at its position), its cells in front of the face. */
function placePorch(
  b: BuildingCtx,
  fp: GroundFootprint,
  ground: readonly GroundOpening[],
  at: PorchSpec,
  ai: number,
): Porch | null {
  const { st, profile } = b;
  if (at.type !== "porch") {
    b.issue(
      "warning",
      `building "${st.id}": ${at.type} attachments are not built yet`,
      "use a porch for now",
    );
    return null;
  }
  const seeded = at.seeded === true;
  const run = faceRuns(fp.cellSet, at.side)[0];
  if (!run) return null;
  const width = Math.min(at.width ?? 3, run.cells.length);
  const depth = at.depth ?? 2;
  const door = ground.find((g) => g.side === at.side && isPassage(g.kind));
  let a: number;
  if (door && at.position === undefined) {
    const di = run.cells.findIndex((c) => c[0] === door.at[0] && c[1] === door.at[1]);
    a = Math.max(0, Math.min(run.cells.length - width, di - Math.floor((width - door.width) / 2)));
  } else a = along(run, at.position ?? 0.5, width);
  const [dx, dy] = STEP[at.side];
  const pc: Array<[number, number]> = [];
  let bad = false;
  for (let k = 0; k < width; k++) {
    const c = run.cells[a + k] as [number, number];
    // the wall ring is the first cell out: the porch starts past it
    for (let d = 2; d <= depth + 1; d++) {
      const x = c[0] + dx * d;
      const y = c[1] + dy * d;
      if (!b.inBounds(x, y) || fp.cellSet.has(key(x, y)) || fp.occupied.has(key(x, y))) bad = true;
      pc.push([x, y]);
    }
  }
  if (bad) {
    if (!seeded)
      b.issue(
        "error",
        `building "${st.id}": its ${at.side} porch would leave the level or overlap a building`,
        "make it shallower or use another side",
      );
    return null;
  }
  pc.sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  return {
    id: `${st.id}~porch${ai}`,
    cells: pc,
    side: at.side,
    floor: at.floor ?? profile.floor,
    roof: (at.roof ?? "flat") !== "none",
  };
}
