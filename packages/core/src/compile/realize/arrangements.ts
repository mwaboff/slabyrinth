/**
 * Generator 5 (`arrangements`): the level's arrangement instances (ResolvedLevel.arrangements, made by arrange/) as
 * placements. Each piece is looked up by its palette, role and asset; stood with its collider centred where the
 * instance puts it (arrange/instance.ts `planPointOf`, then the world frame) and its bottom at the instance's base plus
 * its own height; stored by the anchor rule of its kind (compile/geometry.ts `storedPosition`: a tile at the min corner
 * of its turned footprint, a prop at its origin); quantised as the slab encoder stores it (0.01 tile on each axis, 15°
 * turns), so the box verify measures is the one TaleSpire gets. Every piece of an instance carries the instance's id as
 * its element, so verify treats the instance as one element (its pieces may overlap). A wall-mounted instance (`mount`)
 * is built as wall structure (role wall_post: held by its wall, never judged as a prop standing on a floor), in its
 * paste layer.
 *
 * A piece is placed by its collider in its own axes: the variant's correction `rot` and `offset` (role conventions for
 * placing it by role) do not apply.
 * Reads: the level's arrangements and the role answers. Writes: placements through `emit`, and a `role_missing`
 * warning per instance whose piece the palettes cannot supply (the piece is dropped).
 */
import type { ResolvedArrangement, ResolvedArrangementPiece } from "../../contracts/resolved";
import { planPointOf, snapYaw } from "../../arrange";
import type { ResolvedVariant } from "../../palette/resolve";
import { toScaled } from "../../slab/codec";
import { quarterTurn } from "../../util/turn";
import { storedPosition } from "../geometry";
import type { RealizeLevel } from "./level";

const NO_OFFSET = { x: 0, y: 0, z: 0 } as const;

/** A coordinate as the slab stores it (hundredths of a tile). */
const quantise = (v: number): number => toScaled(v) / 100;

export function layArrangements(lv: RealizeLevel): void {
  if (!lv.ctx.profile.arrangements) return;
  const { L, emit } = lv;
  const { frame, orientation } = lv.ctx;
  for (const inst of L.arrangements ?? []) {
    // a wall-mounted instance (a post, a band) is wall structure, held by the wall; any other stands as a prop
    const role = inst.mount === "wall" ? "wall_post" : "feature";
    for (const piece of inst.pieces) {
      const v = pieceVariant(lv, inst, piece);
      if (!v) continue;
      const [px, py] = planPointOf(inst.at, inst.turn, piece.x, piece.z);
      const c = frame.point(px, py);
      const yaw = snapYaw(frame.planDegreesToWorld(inst.turn + piece.yaw));
      // generator 6 (`tilesStoredByFootprint`): the game draws a tile at quarter turns only (util/turn.ts)
      const deg =
        lv.ctx.profile.tilesStoredByFootprint && v.geom.originAt === "minCorner" ? quarterTurn(yaw) : yaw;
      const pos = storedPosition(v.geom, c.x, inst.base + piece.y, c.z, deg * orientation.rotSense);
      emit(
        { ...v, offset: NO_OFFSET },
        role,
        quantise(pos.x),
        quantise(pos.y),
        quantise(pos.z),
        deg,
        { cell: [Math.floor(px), Math.floor(py)], elementId: inst.id },
        inst.layer,
      );
    }
  }
}

/** The variant a piece names (by the asset its palette lists, or the one used in its place), or undefined. */
function pieceVariant(
  lv: RealizeLevel,
  inst: ResolvedArrangement,
  piece: ResolvedArrangementPiece,
): ResolvedVariant | undefined {
  const res = lv.ctx.lookup(lv.L.id, piece.palette, [piece.role], undefined, true);
  const asset = piece.asset.toLowerCase();
  const v = res?.variants.find((q) => q.wanted.toLowerCase() === asset || q.uuid.toLowerCase() === asset);
  if (!v)
    lv.ctx.addDiag({
      severity: "warning",
      code: "role_missing",
      message: `Arrangement ${inst.id} (${inst.recipe}): palette "${piece.palette}" has no usable "${piece.asset}" in role "${piece.role}"; that piece was dropped`,
      levelId: lv.L.id,
      role: piece.role,
      elementId: inst.id,
    });
  return v;
}
