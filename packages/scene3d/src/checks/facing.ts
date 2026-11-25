/**
 * Facing, the build's own rule held to the scene (core objects/facing.ts `facingFaults`, over the placed meshes): a
 * piece with a measured front (gen/pieceFacts.ts `front`) faces where its job says. A front that faces "outboard" (a
 * gun) points away from the centre line of the body it is mounted on (the segment along the body's travel through the
 * middle of its footprint, as long as the footprint is longer than wide); a front that faces "travel" (a helm) points
 * the way the body travels (the planned object's heading). The body is every piece of the element's owner; its travel
 * is the plan's heading, else its footprint's long axis (then only "outboard" is judged).
 */
import { maxOf, pieceFacts } from "@slabyrinth/core";
import { objectOf } from "@slabyrinth/core/objects";
import type { Vec3 } from "../types/index";
import { findingPiece } from "./pieces";
import { dirToWorld } from "./space";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { Finding, SceneCheck } from "./types";
import { emptyBox, grow, r2 } from "./util";

const AXIS: Readonly<Record<string, Vec3>> = {
  "+x": { x: 1, y: 0, z: 0 },
  "-x": { x: -1, y: 0, z: 0 },
  "+z": { x: 0, y: 0, z: 1 },
  "-z": { x: 0, y: 0, z: -1 },
};

export const facingCheck: SceneCheck = {
  code: "facing",
  needsPlan: false,
  run({ scene, plan }) {
    const fronted = scene.instances
      .map((inst, i) => ({ inst, i, front: pieceFacts(inst.name).front }))
      .filter((x) => x.front !== undefined);
    if (fronted.length === 0) return [];
    // each owner's footprint box
    const bodies = new Map<string, ReturnType<typeof emptyBox>>();
    for (const inst of scene.instances) {
      const o = objectOf(inst.elementId ?? undefined);
      if (o === null) continue;
      let b = bodies.get(o);
      if (!b) bodies.set(o, (b = emptyBox()));
      grow(b, inst.aabb);
    }
    const out: Finding[] = [];
    for (const { inst, i, front } of fronted) {
      if (!front) continue;
      const owner = objectOf(inst.elementId ?? undefined);
      const body = owner !== null ? bodies.get(owner) : undefined;
      if (owner === null || !body) continue;
      const f = dirToWorld(inst, AXIS[front.axis] ?? { x: 0, y: 0, z: 1 });
      const heading = plan?.objects.find((o) => o.id === owner)?.heading ?? null;
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
      let fault: string | null = null;
      let cos: number;
      if (front.faces === "travel") {
        if (!heading) continue;
        cos = f.x * heading.x + f.z * heading.z;
        if (cos <= T.facingCos)
          fault = `${inst.name} faces ${cos < -T.facingCos ? "against" : "across"} ${owner}'s travel (its operator should face the way it goes)`;
      } else {
        const reach = Math.max(0, (length - width) / 2);
        const t = Math.min(reach, Math.max(-reach, along(px, pz)));
        const dx = px - (cx + travel.x * t);
        const dz = pz - (cz + travel.z * t);
        const n = Math.hypot(dx, dz);
        if (n <= T.facingCentre) continue;
        cos = (f.x * dx + f.z * dz) / n;
        if (cos <= T.facingCos)
          fault = `${inst.name} points ${cos < -T.facingCos ? "inboard, at" : "along, not out from"} ${owner}'s body (it should point outboard)`;
      }
      if (!fault) continue;
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
