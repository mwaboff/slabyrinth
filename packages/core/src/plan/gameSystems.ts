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
