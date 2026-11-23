/**
 * The kit an object recipe builds with: the theme's stand-ins (objects/lexicon.ts, memoized), a seeded piece choice
 * among a stand-in's near candidates, and the record of what stood in for what (the proof's and the report's list of
 * stand-ins used, borrowed, simplified and missing).
 */
import type { ThemeId } from "../contracts/plan";
import type { ArrangePiece } from "../arrange/piece";
import type { PlanRoles } from "../palette/planRoles";
import { hashUnitMixed } from "../util/hash";
import { findStandIn, type StandIn, type StandInId } from "./lexicon";

export interface ObjectKit {
  readonly theme: ThemeId;
  /** The stand-in, or null when nothing stands in for it (the part is skipped). */
  standIn(id: StandInId): StandIn | null;
  /** The best candidate of a stand-in, or null. */
  piece(id: StandInId): ArrangePiece | null;
  /** One of the stand-in's near candidates, named by hash parts (variety without a stream), or null. */
  pick(id: StandInId, ...parts: ReadonlyArray<string | number>): ArrangePiece | null;
  /** The near candidates of a stand-in (the mix a `pick` arrangement operator may vary over), best first. */
  mix(id: StandInId): readonly ArrangePiece[];
  /** Every stand-in asked so far and what it found, in asking order. */
  readonly asked: ReadonlyMap<StandInId, StandIn | null>;
}

/** A kit for the theme. The memo lives as long as the kit (one build). */
export function createKit(roles: PlanRoles, theme: ThemeId): ObjectKit {
  const asked = new Map<StandInId, StandIn | null>();
  const standIn = (id: StandInId): StandIn | null => {
    if (!asked.has(id)) asked.set(id, findStandIn(roles, theme, id));
    return asked.get(id) ?? null;
  };
  const mix = (id: StandInId): readonly ArrangePiece[] => {
    const s = standIn(id);
    return s ? s.pieces.slice(0, Math.max(1, s.near)) : [];
  };
  return {
    theme,
    standIn,
    piece: (id) => standIn(id)?.pieces[0] ?? null,
    pick: (id, ...parts) => {
      const m = mix(id);
      return m[Math.floor(hashUnitMixed("standin", id, ...parts) * m.length)] ?? null;
    },
    mix,
    asked,
  };
}
