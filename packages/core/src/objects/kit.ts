/**
 * The kit an object recipe builds with: the theme's stand-ins (objects/lexicon.ts, memoized), a seeded piece choice
 * among a stand-in's near candidates, and the record of what stood in for what (the proof's and the report's list of
 * stand-ins used, borrowed, simplified and missing).
 */
import type { ThemeId } from "../contracts/plan";
import type { ArrangePiece } from "../arrange/piece";
import type { PlanRoles } from "../palette/planRoles";
import { hashUnitMixed } from "../util/hash";
import { findStandIn, STAND_INS, type StandIn, type StandInDef, type StandInId } from "./lexicon";

export interface ObjectKit {
  readonly theme: ThemeId;
  /** The generator the kit's roles are seen by (its palette roles' `minGenerator`; a recipe's switches read it). */
  readonly generator: number;
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

/**
 * The kit stand-in when the palettes have its pieces (the ship kit, objects/lexicon.ts `kit`), else today's stand-in:
 * the id a recipe asks for, so a recipe without the kit asks exactly as it did before (same ids, same seeded picks).
 */
export function kitOr<K extends StandInId, F extends StandInId>(kit: ObjectKit, want: K, today: F): K | F {
  return kit.standIn(want) ? want : today;
}

/**
 * The kit families each object recipe prefers (data, not recipe code): a stand-in with a form in a preferred family
 * (objects/lexicon.ts `forms`) takes that form when the palettes have it. Empty: the plain stand-ins.
 */
export const OBJECT_KITS: Readonly<Record<string, readonly string[]>> = {
  platform: ["ship"],
};

/**
 * A kit for the theme, preferring the kit families `prefer` (an object's own, `OBJECT_KITS`). The memo lives as long
 * as the kit (one build).
 */
export function createKit(roles: PlanRoles, theme: ThemeId, prefer: readonly string[] = []): ObjectKit {
  const asked = new Map<StandInId, StandIn | null>();
  const formOf = (id: StandInId): StandIn | null => {
    const forms: Readonly<Record<string, string>> | undefined = (STAND_INS[id] as StandInDef).forms;
    for (const family of prefer) {
      const alt = forms?.[family];
      const found = alt !== undefined ? findStandIn(roles, theme, alt as StandInId) : null;
      // the form answers for the stand-in asked (its id), so a recipe never sees which family supplied it
      if (found) return { ...found, id };
    }
    return null;
  };
  const standIn = (id: StandInId): StandIn | null => {
    if (!asked.has(id)) asked.set(id, formOf(id) ?? findStandIn(roles, theme, id));
    return asked.get(id) ?? null;
  };
  const mix = (id: StandInId): readonly ArrangePiece[] => {
    const s = standIn(id);
    return s ? s.pieces.slice(0, Math.max(1, s.near)) : [];
  };
  return {
    theme,
    generator: roles.generator,
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
