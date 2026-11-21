/**
 * The tool executor (contract `ExecuteTool`): pure core code that turns one validated tool call into a
 * ToolOutcome. It never commits anything itself; the engine commits `newPlan` / `newBrief`.
 *
 * Every input is validated first (inputs.ts). Every rejection uses the §3.4 format and leaves the plan unchanged.
 * Geometry, text views and compile estimates come through injected ports so tests can use fakes; the defaults
 * (`defaultExecutorPorts`) are the real WP1/WP2 functions.
 *
 * One function per tool in agent/toolRun/ (planTools, viewTools, briefTools, catalogTool, compilePreview), each
 * taking the executor's ToolRunCtx (ports, the last design review per plan) when it needs it; results.ts builds the
 * rejections they share, applied.ts the content of an applied create/edit.
 */
import { invalidJsonRaw } from "./inputs";
import { isToolName } from "./serialize";
import type { ToolName, ToolOutcome } from "./tools";
import { runAskQuestions, runUpdateBrief } from "./toolRun/briefTools";
import { runListCatalog } from "./toolRun/catalogTool";
import { runCompilePreview } from "./toolRun/compilePreview";
import { ToolRunCtx } from "./toolRun/context";
import { runCreatePlan, runEditPlan } from "./toolRun/planTools";
import type { AgentExecuteTool, AgentToolContext, ExecutorPorts } from "./toolRun/ports";
import { defaultExecutorPorts } from "./toolRun/ports";
import { fail } from "./toolRun/results";
import { runViewMapImage, runViewPlan } from "./toolRun/viewTools";

export { compilePreviewText, PREVIEW_CAPS } from "./toolRun/compilePreview";
export { completeAuthoredPlan } from "./toolRun/planTools";
export {
  defaultExecutorPorts,
  type AgentExecuteTool,
  type AgentToolContext,
  type ExecutorPorts,
} from "./toolRun/ports";

type ToolRun = (r: ToolRunCtx, ctx: AgentToolContext, input: unknown) => ToolOutcome | Promise<ToolOutcome>;

/** The run of each tool. */
const TOOL_RUNS: Record<ToolName, ToolRun> = {
  update_brief: (_r, ctx, input) => runUpdateBrief(ctx, input),
  ask_questions: (_r, ctx, input) => runAskQuestions(ctx, input),
  create_plan: runCreatePlan,
  edit_plan: runEditPlan,
  view_plan: runViewPlan,
  view_map_image: (_r, ctx, input) => runViewMapImage(ctx, input),
  compile_preview: (_r, ctx, input) => runCompilePreview(ctx, input),
  list_catalog: (_r, ctx, input) => runListCatalog(ctx, input),
};

/** `onError`: told of failures a tool run falls back from (ToolRunCtx), for the host's log. */
export function createToolExecutor(
  ports: ExecutorPorts = defaultExecutorPorts,
  onError?: (what: string, err: unknown) => void,
): AgentExecuteTool {
  const r = new ToolRunCtx(ports, onError);
  return async (ctx, name, input) => {
    if (!isToolName(name)) return unknownTool(ctx, name);
    const raw = invalidJsonRaw(input);
    if (raw !== null) return invalidJson(raw);
    return TOOL_RUNS[name](r, ctx, input);
  };
}

function unknownTool(ctx: AgentToolContext, name: string): ToolOutcome {
  return fail(name, ctx.head, [
    {
      code: "invalid_input",
      msg: `there is no tool "${name}"`,
      hint: "use one of the tools you were given",
    },
  ]);
}

/** The skill's error result for unparseable tool input (eager input streaming). */
function invalidJson(raw: unknown): ToolOutcome {
  return {
    ok: false,
    content: [{ type: "text", text: JSON.stringify({ INVALID_JSON: raw }) }],
    errors: [
      {
        code: "invalid_input",
        message: "tool input was not valid JSON",
        hint: "send the complete input again",
      },
    ],
  };
}

/** Default executor wired to the real core functions. */
export const executeTool: AgentExecuteTool = createToolExecutor();
