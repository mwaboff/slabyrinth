/** list_catalog: the installed themes, the plan's vocabularies, and which features a theme has assets for. */
import { DRESS_PRESETS, FEATURE_TYPES, MATERIALS, WALL_STYLES } from "../../contracts/plan";
import { validateToolInput } from "../inputs";
import type { ToolOutcome } from "../tools";
import type { AgentToolContext } from "./ports";
import { fail, textResult } from "./results";

export function runListCatalog(ctx: AgentToolContext, input: unknown): ToolOutcome {
  const v = validateToolInput("list_catalog", input);
  if (!v.ok) return fail("list_catalog", ctx.head, v.errors);
  switch (v.value.what) {
    case "themes":
      return textResult(JSON.stringify({ themes: ctx.catalog.themes }));
    case "materials":
      return textResult(JSON.stringify({ materials: MATERIALS }));
    case "wall_styles":
      return textResult(JSON.stringify({ wall_styles: WALL_STYLES }));
    case "presets":
      return textResult(JSON.stringify({ presets: DRESS_PRESETS }));
    case "features": {
      const theme = v.value.theme;
      if (theme === undefined) return textResult(JSON.stringify({ features: FEATURE_TYPES }));
      if (!ctx.catalog.themes.some((t) => t.id === theme)) {
        return fail("list_catalog", ctx.head, [
          {
            code: "theme_unknown",
            path: "/theme",
            msg: `no installed theme "${theme}"`,
            hint: `themes: ${ctx.catalog.themes.map((t) => t.id).join(", ")}`,
          },
        ]);
      }
      const coverage = ctx.catalog.featureCoverage(theme);
      const withAssets = FEATURE_TYPES.filter((f) => coverage[f] === true);
      const without = FEATURE_TYPES.filter((f) => coverage[f] !== true);
      return textResult(JSON.stringify({ theme, withAssets, withoutAssets: without }));
    }
  }
}
