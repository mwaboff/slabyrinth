/** Building tool outcomes: a rejection in the §3.4 format, a text result, and the rejections several tools share. */
import type { MapPlan } from "../../contracts/plan";
import type { ReportError } from "../inputs";
import { rejection } from "../report";
import type { ToolOutcome } from "../tools";

type ErrorEntry = Extract<ToolOutcome, { ok: false }>["errors"][number];

/** Error codes the outcome carries as they are; any other code is reported to the engine as invalid_input. */
const OUTCOME_CODES = ["stale_version", "invalid_input", "no_plan", "plan_exists", "unavailable"] as const;

/** A rejection: the §3.4 text for the model, the errors for the engine. The plan is unchanged. */
export function fail(tool: string, version: number, errors: ReportError[], extra?: string): ToolOutcome {
  return {
    ok: false,
    content: rejection(tool, version, errors, extra),
    errors: errors.map((e): ErrorEntry => {
      const code = (OUTCOME_CODES as readonly string[]).includes(e.code)
        ? (e.code as (typeof OUTCOME_CODES)[number])
        : "invalid_input";
      const entry: ErrorEntry = { code, message: e.msg };
      if (e.hint !== undefined) entry.hint = e.hint;
      return entry;
    }),
  };
}

export function textResult(text: string): ToolOutcome {
  return { ok: true, content: [{ type: "text", text }] };
}

/** The rejection of a tool that needs a plan when there is none (reported at version 0). */
export function noPlan(tool: string, hint = "call create_plan first"): ToolOutcome {
  return fail(tool, 0, [{ code: "no_plan", msg: "there is no plan yet", hint }]);
}

/** The rejection of a level id the plan does not have; the hint lists the plan's levels. */
export function unknownLevel(
  tool: string,
  version: number,
  plan: MapPlan,
  path: string,
  msg: string,
): ToolOutcome {
  return fail(tool, version, [
    { code: "unknown_level", path, msg, hint: `levels: ${plan.levels.map((l) => l.id).join(", ")}` },
  ]);
}

/** The rejection of a view the ports cannot produce right now. */
export function unavailable(tool: string, version: number, msg: string, hint: string): ToolOutcome {
  return fail(tool, version, [{ code: "unavailable", msg, hint }]);
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64 (core has no Buffer or btoa). */
export function base64(bytes: Uint8Array): string {
  const abc = BASE64;
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      abc.charAt((n >> 18) & 63) +
      abc.charAt((n >> 12) & 63) +
      abc.charAt((n >> 6) & 63) +
      abc.charAt(n & 63);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16;
    out += `${abc.charAt((n >> 18) & 63)}${abc.charAt((n >> 12) & 63)}==`;
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += `${abc.charAt((n >> 18) & 63)}${abc.charAt((n >> 12) & 63)}${abc.charAt((n >> 6) & 63)}=`;
  }
  return out;
}
