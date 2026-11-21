import type { CompileEstimate, ExportBundle, LevelId } from "@slabyrinth/core";
import type { CompileInput, CompileStage } from "../ports/compile";

/** Messages between CompileService (main thread) and compile.worker. */
export type WorkerRequest =
  | { type: "compile"; id: number; input: CompileInput }
  | { type: "estimate"; id: number; input: CompileInput; levels?: LevelId[] };

export type WorkerResponse =
  | { type: "progress"; id: number; stage: CompileStage; done: number; total: number }
  | { type: "compiled"; id: number; bundle: ExportBundle }
  | { type: "estimated"; id: number; estimate: CompileEstimate }
  | { type: "error"; id: number; message: string };
