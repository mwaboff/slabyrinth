/**
 * What the model is doing right now, derived from the one live turn in chatStore (nothing new is stored).
 * Shared by the working card in the chat, the stepper, the map badge, the status bar and the announcer, so
 * they always agree. The hooks return primitives so a streamed token never re-renders their callers.
 */
import { useChat } from "../../stores/chat";
import type { TurnState } from "../../stores/chatReducer";

/** "idle": no run. "thinking": a run is going but has not started writing a plan. "writing": it has. */
export type RunPhase = "idle" | "thinking" | "writing";

const isPlanTool = (name: string): boolean => name === "create_plan" || name === "edit_plan";

export function runPhase(live: TurnState | null): RunPhase {
  if (live === null) return "idle";
  return live.tools.some((t) => isPlanTool(t.name)) ? "writing" : "thinking";
}

export function useRunPhase(): RunPhase {
  return useChat((s) => runPhase(s.live));
}

/** Plan version numbers a run is moving between: the version it started from and the one it will leave. */
export function versionSpan(head: number, newVersions: number): { from: number; to: number } {
  const from = Math.max(0, head - newVersions);
  return { from, to: newVersions > 0 ? head : from + 1 };
}

/** Card headline, e.g. "Revising plan v3 → v4". */
export function headline(phase: RunPhase, head: number, newVersions: number): string {
  if (phase === "writing") {
    const { from, to } = versionSpan(head, newVersions);
    return from === 0 ? "Drawing the first plan" : `Revising plan v${from} → v${to}`;
  }
  return head > 0 ? `Working on plan v${head}` : "Working on your request";
}

/** One-word state for the stepper, map badge and status bar. */
export function verb(phase: RunPhase, head: number, newVersions = 0): string {
  if (phase === "writing") return versionSpan(head, newVersions).from === 0 ? "Drawing" : "Revising";
  return "Working";
}

const TOOL_LINE: Record<string, string> = {
  update_brief: "Updating the brief",
  view_plan: "Reading the plan",
  view_map_image: "Looking at the map",
  view_build_3d: "Looking at the map in 3D",
  compile_preview: "Checking how it will build",
  list_catalog: "Browsing the asset library",
};

/** The live one-line step: the newest thing the progress events and tool calls say is happening. */
export function stepLine(turn: TurnState): string {
  if (turn.progress) return turn.progress.label;
  const open = turn.tools.filter((t) => !t.done);
  const planOpen = open.find((t) => isPlanTool(t.name));
  if (planOpen) return planOpen.name === "create_plan" ? "Drawing the plan" : "Applying changes to the plan";
  const other = open.at(-1);
  if (other) return TOOL_LINE[other.name] ?? "Working";
  if (turn.text !== "") return "Writing a reply";
  const planDone = turn.tools.filter((t) => isPlanTool(t.name) && t.done).at(-1);
  if (planDone)
    return planDone.ok === false ? "That change didn't apply; trying again" : "Checking the result";
  if (turn.reasoning !== "") return "Thinking it through";
  return turn.step > 0 || turn.servedBy ? "Reading your request" : "Starting";
}

/** Text for the polite live region: said when a run starts and when it ends. */
export function runAnnouncement(
  phase: RunPhase,
  last: Pick<TurnState, "status"> | null,
  head: number,
  hadRun: boolean,
): string {
  if (phase !== "idle")
    return head > 0 ? `Slabyrinth is working on plan v${head}.` : "Slabyrinth is working.";
  if (!hadRun) return "";
  if (last?.status === "failed") return "The revision failed. Nothing was changed.";
  if (last?.status === "stopped") return "Stopped.";
  return head > 0 ? `Slabyrinth finished. The map is at plan v${head}.` : "Slabyrinth finished.";
}
