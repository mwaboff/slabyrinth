/**
 * Facing, the build's own rule held to the scene: core objects/facing.ts `frontCosine` (the rule `facingFaults` holds a
 * recipe to) over the placed meshes. A piece with a measured front (core `frontVector`, from gen/pieceFacts.ts) faces
 * where its job says: a gun ("outboard") away from the centre line of the body it is mounted on (the segment along the
 * body's travel through the middle of its footprint, as long as the footprint is longer than wide); a helm ("travel")
 * the way the body travels (the planned object's heading). The body is every piece of the element's owner; its travel
 * is the plan's heading, else its footprint's long axis (then only "outboard" is judged).
 */
import { emptyBox, growBox, maxOf, pieceFacts } from "@slabyrinth/core";
import { FACING, frontCosine, frontVector, objectOf } from "@slabyrinth/core/objects";
import { findingPiece } from "./pieces";
import { dirToWorld } from "./space";
import type { Finding, SceneCheck } from "./types";
import { r2 } from "./util";

export const facingCheck: SceneCheck = {
  code: "facing",
  needsPlan: false,
  run({ scene, plan }) {
    const fronted = scene.instances
      .map((inst, i) => ({ inst, i, front: pieceFacts(inst.name).front, f0: frontVector(inst.name) }))
      .filter((x) => x.front !== undefined && x.f0 !== null);
    if (fronted.length === 0) return [];
    // each owner's footprint box
    const bodies = new Map<string, ReturnType<typeof emptyBox>>();
    for (const inst of scene.instances) {
      const o = objectOf(inst.elementId ?? undefined);
      if (o === null) continue;
      let b = bodies.get(o);
      if (!b) bodies.set(o, (b = emptyBox()));
      growBox(b, inst.aabb);
    }
    const out: Finding[] = [];
    for (const { inst, i, front, f0 } of fronted) {
      if (!front || !f0) continue;
      const owner = objectOf(inst.elementId ?? undefined);
      const body = owner !== null ? bodies.get(owner) : undefined;
      if (owner === null || !body) continue;
      const f = dirToWorld(inst, { x: f0[0], y: 0, z: f0[1] });
      const heading = plan?.objects.find((o) => o.id === owner)?.heading ?? null;
      if (front.faces === "travel" && !heading) continue;
      const lx = body.max.x - body.min.x;
      const lz = body.max.z - body.min.z;
      const travel = heading ?? (lx >= lz ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 });
      const cx = (body.min.x + body.max.x) / 2;
      const cz = (body.min.z + body.max.z) / 2;
      const along = (x: number, z: number): number => (x - cx) * travel.x + (z - cz) * travel.z;
      const across = (x: number, z: number): number => Math.abs((x - cx) * travel.z - (z - cz) * travel.x);
      // the body's length and width along and across its travel (from its box corners)
      const corners = [
        [body.min.x, body.min.z],
        [body.max.x, body.min.z],
        [body.min.x, body.max.z],
        [body.max.x, body.max.z],
      ] as const;
      const length = 2 * maxOf(corners.map(([x, z]) => Math.abs(along(x, z))));
      const width = 2 * maxOf(corners.map(([x, z]) => across(x, z)));
      const px = (inst.aabb.min.x + inst.aabb.max.x) / 2;
      const pz = (inst.aabb.min.z + inst.aabb.max.z) / 2;
      const cos = frontCosine(front.faces, [f.x, f.z], [px, pz], {
        centre: [cx, cz],
        travel: [travel.x, travel.z],
        reach: Math.max(0, (length - width) / 2),
      });
      if (cos === null || cos > FACING.cos) continue;
      const way = cos < -FACING.cos;
      const fault =
        front.faces === "travel"
          ? `${inst.name} faces ${way ? "against" : "across"} ${owner}'s travel (its operator should face the way it goes)`
          : `${inst.name} points ${way ? "inboard, at" : "along, not out from"} ${owner}'s body (it should point outboard)`;
      out.push({
        code: "facing",
        severity: cos < 0 ? "fault" : "warn",
        where: {
          levelId: inst.levelId,
          levelIndex: inst.levelIndex,
          box: inst.aabb,
          cells: inst.cell ? [inst.cell] : [],
          elementId: inst.elementId,
        },
        pieces: [findingPiece(inst, i)],
        measure: { cos: r2(cos), turn: r2((Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI) },
        message: fault,
      });
    }
    return out;
  },
};
