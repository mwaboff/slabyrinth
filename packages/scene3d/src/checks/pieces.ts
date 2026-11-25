/**
 * What a placed piece is to the checks, by general rules over its role, layer, owner and measured facts (never a list
 * of names): structure that carries (floors, walls, stairs, roofs, an object's own body), loose things that stand on
 * it, and things that hang on a wall.
 */
import { pieceFacts } from "@slabyrinth/core";
import { objectOf } from "@slabyrinth/core/objects";
import type { SceneInstance } from "../types/index";
import type { PlanFacts } from "./plan";
import { CHECK_THRESHOLDS as T } from "./thresholds";
import type { FindingPiece } from "./types";

const STRUCTURE_ROLES: ReadonlySet<string> = new Set([
  "floor",
  "fill",
  "ledge",
  "wall",
  "wall_post",
  "opening",
  "link",
]);
const GROUND_ROLES: ReadonlySet<string> = new Set(["floor", "fill", "ledge"]);

/** Is the piece part of an object's own body (its hull, decks, rails, masts), not a thing in one of its rooms? */
export function bodyPiece(inst: SceneInstance, plan: PlanFacts | null): boolean {
  // the build marks an object's body instances (plan.bodies, from core isObjectBody); what furnishes its rooms is not
  return inst.elementId !== null && (plan?.bodies.has(inst.elementId) ?? false);
}

/** Classes of built pieces (the scene's one classifier, scene/classify.ts: role, palette roles, catalog, shape). */
const BUILT_CLASSES: ReadonlySet<string> = new Set(["wall", "floor", "roof", "stairs", "opening", "terrain"]);

/**
 * Does the piece carry others (structure), as the build places it? Its role says so, or it is a roof, an object's
 * body, an overhead line, or a built piece by its catalog facts (a stall's posts and canopy are a feature's parts).
 */
export function structural(inst: SceneInstance, plan: PlanFacts | null): boolean {
  if (BUILT_CLASSES.has(inst.colourClass)) return true;
  if (inst.role === null) return false;
  return (
    STRUCTURE_ROLES.has(inst.role) || inst.layer === "roof" || bodyPiece(inst, plan) || spanPiece(inst, plan)
  );
}

/** Is the piece part of an overhead line the plan strings between two anchors? */
export function spanPiece(inst: SceneInstance, plan: PlanFacts | null): boolean {
  const owner = objectOf(inst.elementId ?? undefined);
  return owner !== null && (plan?.spans.has(owner) ?? false);
}

/** Is the piece ground or deck others stand on? */
export function groundPiece(inst: SceneInstance): boolean {
  if (inst.colourClass === "floor" || inst.colourClass === "terrain") return true;
  return inst.role !== null && GROUND_ROLES.has(inst.role);
}

/** Does the piece hang on a wall or from above (its facts say so, the plan mounts it, or it is a door or window)? */
export function hangs(inst: SceneInstance, plan: PlanFacts | null): boolean {
  const on = pieceFacts(inst.name).setting?.on;
  if (on === "wall" || on === "hanging") return true;
  if (inst.role === "opening" || spanPiece(inst, plan)) return true;
  return inst.elementId !== null && (plan?.mounted.has(inst.elementId) ?? false);
}

/**
 * Is the piece organic dressing (a plant, a rock, a cliff face, vines)? A planned feature's own trait decides (a
 * pitcher a palette lists among natural small details is still the clutter feature it was placed as); any other piece
 * by its class.
 */
export function organic(inst: SceneInstance, plan: PlanFacts | null): boolean {
  const id = inst.elementId;
  if (id !== null && plan?.features.has(id)) return plan.organic.has(id);
  return inst.colourClass === "plant";
}

/** Is the piece flat cover (a rug, a decal) things stand on by design? */
export const flatCover = (inst: SceneInstance): boolean => inst.aabb.max.y - inst.aabb.min.y < T.flatCover;

/** Is the piece a hollow shell that encloses what stands in it (a hull's planking)? */
export const shellPiece = (inst: SceneInstance): boolean => pieceFacts(inst.name).shell === true;

export function findingPiece(inst: SceneInstance, index: number): FindingPiece {
  return { index, name: inst.name, uuid: inst.uuid, elementId: inst.elementId };
}
