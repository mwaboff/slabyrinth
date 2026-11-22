/**
 * Realize, one building: volume by volume, storey by storey (upper floors, the seam a set-in storey leaves on the one
 * below, walls with their openings and posts), then the lips between volumes, each volume's stacked roof, and what the
 * building carries (chimneys, porches, lights, a shopfront, details, dressing, roof furniture).
 *
 * Ground-floor openings belong to the synthetic area's footprint and are built by the volume whose face they are on; a
 * face another volume covers over most of the storey's height gets no wall (no wall between joined volumes), and a
 * building earlier in the level's list that stands against this one builds the shared wall.
 *
 * Geometry (verified in game, forest shack test 2026-11-20): walls in the outer half of the ring cells; storey =
 * footing course + wall course; attic deck on the wall top, the 45° roof on the deck; courses one cell in and one tile
 * up; gable ends filled up to the underside of each course; chimney breast in the wall line rising past the ridge.
 * Placements carry a paste layer: "storey:<n>" for storey n, "roof" for the deck, roof, gable fill and attachment
 * roofs (absent = site).
 *
 * Hand-offs (returned by their step, passed to the readers below): the storey faces each opening takes (openings.ts),
 * the windows the courses built (read by the window lights), the volumes' flat tops (read by the roof furniture).
 */
import type { ResolvedStructure, ResolvedVolume } from "../../../contracts/resolved";
import { floorRole } from "../../../palette/roles";
import { designDoorFamily } from "../../../resolve/building/parts";
import {
  chimneyWalls,
  foreignCells,
  mainVolumeId,
  storeyWallFaces,
  structureNeighbours,
  volumeTag,
  volumesOf,
} from "../../../resolve/structureFaces";
import type { RealizeLevel } from "../level";
import {
  layChimneys,
  layDoorLights,
  layEntranceStrips,
  layPorches,
  layShopfront,
  layWindowLights,
} from "./attachments";
import { buildingCtx, type StructureCtx } from "./context";
import { layCourses, type LitWindow } from "./courses";
import { layDetails } from "./details";
import { layDebris, layGrowth, layRuinFragments, layWallTopRubble } from "./dressing";
import { GROUND_FACES, openingsByStorey, storeyFaces, type StoreyOpening } from "./openings";
import { faceKey, layTiles, ringOf8, setOf } from "./pieces";
import { layRoofFurniture } from "./rooftop";
import { layRoof, roofValleys, type FlatTop } from "./roofs";
import { layLips, laySeam } from "./seams";

/** The building as its steps share it: its volumes, the main one, the faces its chimneys and openings take. */
interface BuildingShape {
  vols: ResolvedVolume[];
  mainId: string;
  /** Element id prefix of a volume's pieces (the main volume's is the building's id). */
  tagOf: (volume: string) => string;
  /** Wall faces ("x,y,face") a chimney breast stands in: no wall there. */
  chimneyWall: ReadonlySet<string>;
  /** Cells of every other building of the level: no parapet, detail or balcony stands against them. */
  foreign: ReadonlySet<string>;
  ruined: boolean;
}

/** The building's steps, in the order their placements are emitted. */
export function layBuilding(lv: RealizeLevel, st: ResolvedStructure): void {
  const b = buildingCtx(lv, st);
  const shape = shapeOf(b);
  const windows = layStoreys(b, shape);
  if (!shape.ruined) layLips(b, shape.vols);
  const roofs = layRoofs(b, shape);
  if (!shape.ruined) layChimneys(b, roofs.mainTop);
  layPorches(b);
  layDoorLights(b);
  layWindowLights(b, windows);
  layEntranceStrips(b);
  layShopfront(b);
  layDebris(b);
  layDetails(b, shape.vols, shape.foreign);
  if (st.ruin) layRuinFragments(b);
  layWallTopRubble(b);
  layGrowth(b);
  layRoofFurniture(b, clearUnderVolumes(roofs.flatTops, shape.vols));
}

function shapeOf(b: StructureCtx): BuildingShape {
  const { st, lv } = b;
  const vols = volumesOf(st);
  const mainId = mainVolumeId(vols);
  return {
    vols,
    mainId,
    tagOf: (vid) => volumeTag(st, mainId, vid),
    chimneyWall: chimneyWalls(st),
    foreign: foreignCells(lv.L, st),
    ruined: st.condition === "ruined",
  };
}

/**
 * Every storey of every volume: its floor (upper storeys; the ground floor is the area's own), the seam a set-in storey
 * leaves on the one below, and its walls. A weathered or ruined building's wall columns stop at their surviving tops,
 * and its fallen floor cells stay open. Returns the windows built.
 */
function layStoreys(b: StructureCtx, shape: BuildingShape): LitWindow[] {
  const { st, lv } = b;
  const { vols, mainId, tagOf, chimneyWall, ruined } = shape;
  const opsBy = openingsByStorey(st, lv.L.openings, vols, mainId, tagOf);
  const nb = structureNeighbours(lv.L, st, vols);
  const caps = st.ruin
    ? new Map(st.ruin.columns.map((c) => [faceKey(c.at[0], c.at[1], c.side), c.top]))
    : undefined;
  const holesOf = new Map(
    (st.ruin?.holes ?? []).map((h) => [storeyFaces(h.volume, h.storey), setOf(h.cells)]),
  );
  const arches = st.ruin?.arches
    ? new Set(st.ruin.arches.map((q) => faceKey(q.at[0], q.at[1], q.side)))
    : undefined;
  const doorUse = designDoorFamily(st);
  const windows: LitWindow[] = [];
  for (const v of vols) {
    const tag = tagOf(v.id);
    v.storeys.forEach((sp, s) => {
      const ground = s === 0 && v.on === null;
      const own = setOf(sp.cells);
      const ops = opsBy.get(ground ? GROUND_FACES : storeyFaces(v.id, s)) ?? new Map<string, StoreyOpening>();
      const layer = `storey:${s}`;
      const fallen = holesOf.get(storeyFaces(v.id, s));
      if (!ground)
        layTiles(
          b,
          [floorRole(sp.floor)],
          fallen ? new Set([...own].filter((k) => !fallen.has(k))) : own,
          sp.floorTop - 0.5,
          "floor",
          { id: `${tag}~floor${s}`, layer },
        );
      const prev = v.storeys[s - 1];
      if (prev && sp.seam && !ruined) laySeam(b, prev, sp, `${tag}~seam${s}`);
      if (sp.walls === null) return;
      const faces = storeyWallFaces(st, nb, v, sp);
      layCourses(b, {
        s,
        faces,
        own,
        ops,
        floorTop: sp.floorTop,
        top: sp.wallTop,
        footing: ground ? sp.footing : null,
        walls: sp.walls,
        ground,
        layer,
        chimneyWall,
        tag,
        windows,
        openTop: ruined,
        ...(caps ? { caps } : {}),
        ...(arches ? { arches } : {}),
        ...(doorUse !== undefined ? { doorUse } : {}),
      });
    });
  }
  return windows;
}

/** Each volume's roof, the valleys merged first (generator 3); the main volume's top and the flat tops. */
function layRoofs(b: StructureCtx, shape: BuildingShape): { mainTop: number; flatTops: FlatTop[] } {
  const { st } = b;
  const { vols, mainId, tagOf, chimneyWall, foreign } = shape;
  let mainTop = vols[0]?.storeys[vols[0].storeys.length - 1]?.wallTop ?? 0;
  const flatTops: FlatTop[] = [];
  // generator 3: roofs that meet are merged into valleys (the higher surface owns each cell)
  const merge = st.valleys ? roofValleys(st, vols) : undefined;
  for (const v of vols) {
    const top = v.storeys[v.storeys.length - 1];
    if (!top) continue;
    const res = layRoof(b, v, top, chimneyWall, tagOf(v.id), foreign, merge);
    if (v.id === mainId) mainTop = res.top;
    if (res.flat) flatTops.push(res.flat);
  }
  return { mainTop, flatTops };
}

/** A volume standing on a flat top (a tower on its podium) takes its cells and wall ring off that roof. */
function clearUnderVolumes(tops: FlatTop[], vols: readonly ResolvedVolume[]): FlatTop[] {
  for (const t of tops)
    for (const v of vols)
      for (const sp of v.storeys)
        if (sp.floorTop > t.y - 0.6 && sp.floorTop < t.y + 0.6) {
          const own = setOf(sp.cells);
          for (const k of [...own, ...ringOf8(own)]) t.cells.delete(k);
        }
  return tops;
}
