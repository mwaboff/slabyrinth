/**
 * The tool-input Zod schemas (what the executor enforces, agent/inputs.ts) against the JSON Schema the model is shown
 * (the working tool list, agent/tools.ts): the same properties, the same required ones, and every limit the executor
 * enforces (minimum/maximum, length and item bounds, enums) shown to the model too. A limit the model is not told
 * about makes it fail calls it was never warned of. Plan content (create_plan's `plan`, edit_plan's ops) is held to
 * the plan schema and checked by the plan tests; this walks the tool envelopes.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOL_INPUT_SCHEMAS } from "../../../src/agent/inputs";
import { TOOL_DEFINITIONS } from "../../../src/agent/tools";

type Json = Record<string, unknown>;
const LIMITS = [
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "enum",
  "const",
] as const;

/** Every difference between what the executor enforces (`zod`) and what the model is shown (`shown`), by path. */
function differences(zod: Json, shown: Json, at: string, out: string[]): void {
  for (const k of LIMITS) {
    if (zod[k] === undefined) continue;
    const z1 = JSON.stringify(zod[k]);
    const s1 = shown[k] === undefined ? "nothing" : JSON.stringify(shown[k]);
    if (z1 !== s1) out.push(`${at}: ${k} enforced ${z1}, shown ${s1}`);
  }
  const zp = zod["properties"] as Record<string, Json> | undefined;
  const sp = shown["properties"] as Record<string, Json> | undefined;
  if (zp !== undefined) {
    const zk = Object.keys(zp).sort();
    const sk = Object.keys(sp ?? {}).sort();
    if (JSON.stringify(zk) !== JSON.stringify(sk))
      out.push(`${at}: properties ${zk.join(",")} vs shown ${sk.join(",")}`);
    const zr = [...((zod["required"] as string[] | undefined) ?? [])].sort();
    const sr = [...((shown["required"] as string[] | undefined) ?? [])].sort();
    if (JSON.stringify(zr) !== JSON.stringify(sr))
      out.push(`${at}: required ${zr.join(",")} vs shown ${sr.join(",")}`);
    for (const key of zk) if (sp?.[key]) differences(zp[key] as Json, sp[key], `${at}.${key}`, out);
  }
  const zi = zod["items"] as Json | undefined;
  const si = shown["items"] as Json | undefined;
  if (zi !== undefined && si !== undefined) differences(zi, si, `${at}[]`, out);
}

/** Content the plan schema owns (not part of a tool envelope). */
const PLAN_CONTENT = new Set(["create_plan.plan", "edit_plan.ops"]);

/** z.int()'s safe-integer bounds: not a limit anyone chose. */
const SAFE_INT = /: (minimum|maximum) enforced -?9007199254740991, shown nothing$/;

/**
 * Limits the executor enforces that the working tool text (tools-1.9.0) does not show. Showing them is model-facing
 * text (a tools-version decision for the owner); until then the list is pinned so a NEW unshown limit, or a shown one
 * that changes, fails here. Properties, required fields and enums must already agree everywhere.
 */
const KNOWN_UNSHOWN = [
  ...["avoid", "mustInclude"].flatMap((k) => [
    `update_brief.set.${k}: maxItems enforced 20, shown nothing`,
    `update_brief.set.${k}[]: maxLength enforced 200, shown nothing`,
  ]),
  ...["heightSq", "widthSq"].flatMap((k) => [
    `update_brief.set.footprint.${k}: minimum enforced 1, shown nothing`,
    `update_brief.set.footprint.${k}: maximum enforced 512, shown nothing`,
  ]),
  "update_brief.set.levels.count: minimum enforced 1, shown nothing",
  "update_brief.set.levels.count: maximum enforced 8, shown nothing",
  "update_brief.set.levels.names: maxItems enforced 8, shown nothing",
  "update_brief.set.levels.names[]: maxLength enforced 80, shown nothing",
  "update_brief.set.mapType: minLength enforced 1, shown nothing",
  "update_brief.set.mapType: maxLength enforced 80, shown nothing",
  ...(
    [
      ["level", 30],
      ["size", 12],
      ["tier", 10],
    ] as const
  ).flatMap(([k, max]) => [
    `update_brief.set.party.${k}: minimum enforced 1, shown nothing`,
    `update_brief.set.party.${k}: maximum enforced ${max}, shown nothing`,
  ]),
  "update_brief.set.theme: minLength enforced 1, shown nothing",
  "update_brief.set.theme: maxLength enforced 64, shown nothing",
  "update_brief.set.tone: maxLength enforced 80, shown nothing",
  ...(
    [
      ["default", 200],
      ["id", 40],
      ["text", 300],
    ] as const
  ).flatMap(([k, max]) => [
    `ask_questions.questions[].${k}: minLength enforced 1, shown nothing`,
    `ask_questions.questions[].${k}: maxLength enforced ${max}, shown nothing`,
  ]),
  "ask_questions.questions[].options[]: minLength enforced 1, shown nothing",
  "ask_questions.questions[].options[]: maxLength enforced 80, shown nothing",
  ...["create_plan", "edit_plan"].flatMap((t) => [
    `${t}.changes[]: maxLength enforced 200, shown nothing`,
    `${t}.summary: minLength enforced 1, shown nothing`,
    `${t}.summary: maxLength enforced 80, shown nothing`,
  ]),
  "edit_plan.baseVersion: minimum enforced 0, shown nothing",
  "view_plan.ids: maxItems enforced 200, shown nothing",
  ...["view_plan", "view_map_image"].flatMap((t) => [
    `${t}.region.h: minimum enforced 1, shown nothing`,
    `${t}.region.w: minimum enforced 1, shown nothing`,
  ]),
  "view_map_image.level: minLength enforced 1, shown nothing",
  "compile_preview.levels: maxItems enforced 8, shown nothing",
];

describe("tool input schemas: what is enforced is what the model is shown", () => {
  it("every tool: same properties, required fields and enums; unshown limits are exactly the pinned list", () => {
    const out: string[] = [];
    for (const def of TOOL_DEFINITIONS) {
      const zod = z.toJSONSchema(TOOL_INPUT_SCHEMAS[def.name], { io: "input" }) as Json;
      const shown: Json = def.inputSchema;
      const zp = { ...((zod["properties"] ?? {}) as Record<string, Json>) };
      for (const key of Object.keys(zp)) if (PLAN_CONTENT.has(`${def.name}.${key}`)) zp[key] = {};
      differences({ ...zod, properties: zp }, shown, def.name, out);
    }
    expect(out.filter((d) => !SAFE_INT.test(d)).sort()).toEqual([...KNOWN_UNSHOWN].sort());
  });
});
