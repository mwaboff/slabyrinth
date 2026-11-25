/**
 * view_build_3d (tools-1.11.0 on): the app's 3D pictures of the current build for the model. One picture (a numbered
 * sheet of up to 4 views) with a caption per view and the app's text after it: the faults measured on the pieces in
 * view, and the views worth a look next. The same content carries the one look the engine gives the model after a
 * conversation's first draft (`picturesContent`), so the text is written once, here, with the tool version.
 *
 * The first text block always starts with PICTURES_HEADER and the version shown, so the engine can tell which version
 * a picture in the transcript shows (`pictureVersionOf`) and, once a newer version is built, replace the picture by
 * DROPPED_PICTURE_TEXT (`withoutPicture`): the captions and findings stay, the pixels go.
 */
import type { MapPlan } from "../../contracts/plan";
import { validateToolInput } from "../inputs";
import type { Render3dResult, ToolOutcome, ToolResultContent } from "../tools";
import type { AgentToolContext } from "./ports";
import { base64, fail, noPlan, unavailable, unknownLevel } from "./results";

/** Error code the engine puts on a refusal because this message's pictures are spent (see `pictureRefusal`). */
export const PICTURE_BUDGET_CODE = "picture_budget";

export const PICTURES_HEADER = "3D PICTURE of plan v";
const HEADER_RE = /^3D PICTURE of plan v(\d+)\b/;

/** What a picture becomes in the transcript once a newer version is built. */
export const DROPPED_PICTURE_TEXT =
  "(The picture itself was removed from the conversation after a newer version was built; the captions above are what it showed.)";

/** Why the model got the picture: it asked, or the app's one look after the first draft. */
export type PictureCause = "asked" | "first_draft";

/** The content of a 3D picture result: header and captions, the picture, then the app's findings and suggestions. */
export function picturesContent(
  version: number,
  r: Render3dResult,
  cause: PictureCause,
): ToolResultContent[] {
  const lead =
    cause === "first_draft"
      ? `${PICTURES_HEADER}${String(version)}: the app's one look at your first draft in 3D (flat colours by kind of piece, not the game's look). Check it before you tell the GM the draft is done.`
      : `${PICTURES_HEADER}${String(version)} (flat colours by kind of piece, not the game's look).`;
  const out: ToolResultContent[] = [
    { type: "text", text: [lead, ...r.captions].join("\n") },
    { type: "image", mediaType: "image/png", dataBase64: base64(r.png) },
  ];
  const after = r.suggestions.trim();
  if (after !== "") out.push({ type: "text", text: after });
  return out;
}

/**
 * The plan version the 3D picture in a tool result shows (the text block that starts with PICTURES_HEADER: the whole
 * result of view_build_3d, or the look appended to a first draft's create_plan result), or null when it has none.
 */
export function pictureVersionOf(content: readonly ToolResultContent[]): number | null {
  for (const c of content) {
    if (c.type !== "text") continue;
    const m = HEADER_RE.exec(c.text);
    if (m?.[1] !== undefined) return Number(m[1]);
  }
  return null;
}

/** A 3D picture result with its picture replaced by DROPPED_PICTURE_TEXT (unchanged when it has none). */
export function withoutPicture(content: readonly ToolResultContent[]): ToolResultContent[] {
  return content.map((c) => (c.type === "image" ? { type: "text", text: DROPPED_PICTURE_TEXT } : c));
}

/** The level a level: view names that the plan does not have (null when every named level exists). */
function missingLevel(plan: MapPlan, shots: readonly string[]): string | null {
  for (const s of shots)
    if (s.startsWith("level:")) {
      const id = s.slice("level:".length);
      if (!plan.levels.some((l) => l.id === id)) return id;
    }
  return null;
}

export async function runViewBuild3d(ctx: AgentToolContext, input: unknown): Promise<ToolOutcome> {
  const tool = "view_build_3d";
  const v = validateToolInput(tool, input);
  if (!v.ok) return fail(tool, ctx.head, v.errors);
  const plan = ctx.plan;
  if (plan === null) return noPlan(tool, "there is nothing built to look at yet: call create_plan first");
  const render = ctx.render3d ?? null;
  if (render === null)
    return unavailable(
      tool,
      ctx.head,
      "3D pictures are off: the GM turned them off in Settings › AI › 3D view, or allows none per message",
      'use view_map_image or view_plan with format "ascii" instead; mention it to the GM only if a 3D check matters',
    );
  const shots = v.value.shots ?? [];
  const missing = missingLevel(plan, shots);
  if (missing !== null) return unknownLevel(tool, ctx.head, plan, "/shots", `no level "${missing}"`);
  let result: Render3dResult;
  try {
    result = await render(v.value);
  } catch (err) {
    const budget = (err as { code?: unknown } | null)?.code === PICTURE_BUDGET_CODE;
    const msg = err instanceof Error && err.message !== "" ? err.message : "the 3D picture could not be made";
    return unavailable(
      tool,
      ctx.head,
      msg,
      budget
        ? 'no more pictures until the GM\'s next message: use view_plan (format "ascii") or the results you already have'
        : 'try fewer views, or use view_map_image or view_plan with format "ascii" instead',
    );
  }
  return { ok: true, content: picturesContent(ctx.head, result, "asked") };
}
