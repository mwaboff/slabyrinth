/**
 * TEST ONLY (Playwright e2e): the real ConversationEngine with a scripted, network-free ChatProvider registered in
 * place of Anthropic. Steps come from a JSON file (ScriptedStep[]); each request the engine sends is summarised as
 * one JSON line in the optional log file so the test can check what the model would have seen. Loaded only when
 * main/engineWiring.ts selects the "scripted" engine (safe mode + SLABYRINTH_E2E_PROVIDER_SCRIPT).
 */
import * as fsp from "node:fs/promises";
import { appendFileSync } from "node:fs";
import type { EngineFactory } from "../../ports/engine";
import { SlabyrinthConversationEngine } from "../engine";
import { DefaultProviderRegistry } from "../provider/registry";
import type { StepRequest } from "../provider/types";
import { ScriptedProvider, type ScriptedStep } from "./scriptedProvider";

/** Marker the packaged smoke run searches for: it must never appear in a production bundle. */
export const TEST_ONLY_MARKER = "SLABYRINTH-TEST-ONLY-E2E-PROVIDER";

export interface LoggedRequest {
  turnId: string;
  modelId: string;
  effort: string | null;
  /** One entry per transcript item: its type, plus the text of user items. */
  transcript: Array<{ type: string; text?: string }>;
  tools: string[];
}

function summarise(req: StepRequest): LoggedRequest {
  return {
    turnId: req.turnId,
    modelId: req.selection.modelId,
    effort: req.effort,
    transcript: req.transcript.map((i) =>
      i.type === "user" ? { type: i.type, text: i.text } : { type: i.type },
    ),
    tools: req.tools.map((t) => t.name),
  };
}

export async function createScriptedEngineFactory(
  scriptFile: string,
  logFile?: string,
): Promise<EngineFactory> {
  const steps = JSON.parse(await fsp.readFile(scriptFile, "utf8")) as ScriptedStep[];
  if (!Array.isArray(steps)) throw new Error(`${TEST_ONLY_MARKER}: the script must be a JSON array of steps`);
  // A restarted app continues the script where the previous run stopped (one log line per step served).
  const start = logFile
    ? await fsp.readFile(logFile, "utf8").then(
        (t) => t.split("\n").filter(Boolean).length,
        () => 0,
      )
    : 0;
  const provider = new ScriptedProvider((req, i) => {
    if (logFile) appendFileSync(logFile, `${JSON.stringify(summarise(req))}\n`);
    const step = steps[start + i];
    if (!step) throw new Error(`e2e provider script exhausted at step ${String(start + i)}`);
    return step;
  });
  return (host) =>
    new SlabyrinthConversationEngine(host, { registry: new DefaultProviderRegistry([provider]) });
}
