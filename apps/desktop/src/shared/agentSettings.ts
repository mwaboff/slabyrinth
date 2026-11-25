/**
 * The AI's working limits (AppSettings.agent): defaults, ranges, and the one reader every caller uses, so a settings
 * file written before the group existed reads as the defaults everywhere (main's engine, the renderer, the fake bridge).
 */
import type { AppSettings } from "./project";

export type AgentSettings = NonNullable<AppSettings["agent"]>;

export const AGENT_DEFAULTS: Readonly<AgentSettings> = Object.freeze({
  maxRevisionsPerTurn: 4,
  view3d: true,
  maxPicturesPerTurn: 6,
});

/** Plan versions the model may commit for one message before the app asks (Settings › AI › Changes per message). */
export const REVISION_LIMIT_RANGE = { min: 1, max: 20 } as const;
/** 3D pictures the model may take for one message. */
export const PICTURES_RANGE = { min: 0, max: 12 } as const;

/** The settings' agent group with every field filled in (absent group or field = the default). */
export function agentSettings(s: Pick<AppSettings, "agent"> | null | undefined): AgentSettings {
  return { ...AGENT_DEFAULTS, ...(s?.agent ?? {}) };
}
