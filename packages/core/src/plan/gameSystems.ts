/**
 * The game systems a brief can name (DesignBrief.system) and how the app labels them: one table for every schema
 * (update_brief, brief:update, a saved brief, the settings' default system) and every picker. The tool text the model
 * is shown spells the enum out; test/unit/agent/toolSchemas.test.ts keeps it equal to this.
 */
import type { DesignBrief } from "../contracts/plan";

export type GameSystemId = NonNullable<DesignBrief["system"]>["value"];

export const GAME_SYSTEM_IDS = ["daggerheart", "dnd5e", "other"] as const satisfies readonly GameSystemId[];

/** Every system of the contract is listed (a system added to DesignBrief fails to compile here until it is). */
type Missing = Exclude<GameSystemId, (typeof GAME_SYSTEM_IDS)[number]>;
export const GAME_SYSTEMS_ALL_LISTED: [Missing] extends [never] ? true : never = true;

export const GAME_SYSTEM_LABEL: Readonly<Record<GameSystemId, string>> = {
  daggerheart: "Daggerheart",
  dnd5e: "D&D 5e",
  other: "Other",
};

/**
 * How a system measures the party's strength (DesignBrief.party): a character level 1–20 (D&D 5e), or a tier 1–4
 * (Daggerheart; also the default for a system the app does not know).
 */
export const GAME_SYSTEM_PARTY_MEASURE: Readonly<Record<GameSystemId, "level" | "tier">> = {
  daggerheart: "tier",
  dnd5e: "level",
  other: "tier",
};

/** Does the system name itself (a label of its own), or is its name the GM's own text ("other")? */
export const GAME_SYSTEM_NAMED: Readonly<Record<GameSystemId, boolean>> = {
  daggerheart: true,
  dnd5e: true,
  other: false,
};
