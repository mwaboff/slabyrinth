/**
 * What `settings:update` takes and how it is applied, for main (SettingsStore), the renderer's settings store
 * (optimistic update) and the fake bridge alike.
 *
 * The request schema (`settingsPatchSchema`) accepts only the fields the renderer may change, in strict nested objects.
 * `SettingsUpdate` is that schema's input type with every other field of AppSettings, at every depth, typed `?: never`,
 * so a patch spread from the stored settings (`{ talespire: { ...s.talespire, alignmentMarkers } }`, which carries the
 * main-owned `installPath` and `lastScanAt`) does not compile. TypeScript does not check spread properties as excess
 * properties, so the input type alone would let it through, and main then refused it (0.3.0: the pillar box and the
 * level layout could not be saved). Send only what changed; nested objects are merged.
 */
import type { z } from "zod";
import type { AppSettings } from "./project";
import type { settingsPatchSchema } from "./schemas/settings";

/** P with every key F has and P lacks forbidden, recursively through plain objects (arrays are left as they are). */
type NoExtra<P, F> = P extends readonly unknown[]
  ? P
  : P extends object
    ? NonNullable<F> extends readonly unknown[]
      ? P
      : NonNullable<F> extends object
        ? { [K in keyof P]: K extends keyof NonNullable<F> ? NoExtra<P[K], NonNullable<F>[K]> : P[K] } & {
            [K in Exclude<keyof NonNullable<F>, keyof P>]?: never;
          }
        : P
    : P;

/** A `settings:update` request as the renderer may build it. */
export type SettingsUpdate = NoExtra<z.input<typeof settingsPatchSchema>, AppSettings>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep merge of plain objects; arrays and scalars replace; `undefined` is skipped. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isRecord(out[k]) && isRecord(v) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/** The settings after a patch: nested objects merged, `defaultSystem` replaced whole. */
export function applySettingsPatch(
  settings: AppSettings,
  patch: z.output<typeof settingsPatchSchema> | SettingsUpdate,
): AppSettings {
  const { defaultSystem, ...rest } = patch;
  const next = deepMerge(settings, rest);
  // Replaced whole, never merged (a stale otherName must not survive a switch to another system).
  if (defaultSystem !== undefined)
    next.defaultSystem =
      defaultSystem === null
        ? null
        : defaultSystem.otherName === undefined
          ? { system: defaultSystem.system }
          : { system: defaultSystem.system, otherName: defaultSystem.otherName };
  return next;
}
