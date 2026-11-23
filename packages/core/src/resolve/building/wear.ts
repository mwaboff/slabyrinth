/**
 * Wear of a worn or ramshackle building (generator 5, plan §11.1 P20, P21, P23): what a building that is used but not
 * kept up shows in its structure, each a treatment option drawn once per building (treatments.ts STRUCTURE_TREATMENTS)
 * with its amount drawn per building, so two houses of one street differ.
 *
 *   roof patches  (switch `roofPatches`) one to three patches of its pitched roofs re-laid in a second roof kit
 *                 (compile/realize/structures/roofs.ts picks the kit): about 10-20 % of the roof worn, 30-45 %
 *                 ramshackle. Never over a roof hole.
 *   porch sag     (switch `porchWear`) a roofed porch's outer row sits one step (0.25) lower; the building's own eave
 *                 never sags (structure stays square everywhere else).
 *   mixed posts   (switch `porchWear`) a porch stands on posts of two kinds.
 *
 * Reads the building's condition state (its plan condition refined by its words, gen/buildingCondition.ts). Writes the
 * porches' `sag` and `posts`, and returns the patched roof cells (null: none).
 */
import { SIDE_STEP as STEP, SIDES } from "../../gen/gridGeometry";
import { hashUnitMixed } from "../../util/hash";
import { ROOF_KITS, nearKits, roofKitInfo } from "../roofKits";
import { isPitchedRoof } from "../roofTypes";
import { drawStructureOption, type Subject } from "../recipes/treatments";
import type { RuinProfile } from "../ruin";
import type { BuildingCtx } from "./context";
import { cellOf, key } from "./footprint";
import type { Porch, VolumePlan } from "./types";

/** Share of the pitched roof re-laid, by state (a building's draw within the range). */
const PATCH_SHARE = { worn: [0.1, 0.2], ramshackle: [0.3, 0.45] } as const;
/** The most patches a roof takes. */
const PATCHES = 3;
/** A sagging porch's outer row is this much lower (one step). */
export const PORCH_SAG = 0.25;
/** (roofKitFacts) Cells of one small patch, about. */
const SMALL_PATCH = 3;

/** Whether a roof of `kit` can be patched as a repair: the kit has worn pieces, or another kit reads like it. */
export function patchable(kit: string): boolean {
  if (roofKitInfo(kit)?.weathered === true) return true;
  return Object.keys(ROOF_KITS).some((k) => k !== kit && ROOF_KITS[k]?.pitched === true && nearKits(k, kit));
}

export function applyWear(
  b: BuildingCtx,
  vplans: readonly VolumePlan[],
  porches: Porch[],
  ruin: RuinProfile | null,
  s: Subject,
): Array<[number, number]> | null {
  if (s.state !== "worn" && s.state !== "ramshackle") return null;
  // (named by the building's id too: two houses of one variety seed wear differently)
  const seed = `${b.seed}|${b.st.id}`;
  if (b.gen.porchWear)
    for (const p of porches) {
      if (!p.roof) continue;
      if (drawStructureOption("porchSag", s, `${seed}|${p.id}`) === "sag") p.sag = PORCH_SAG;
      if (drawStructureOption("porchPosts", s, `${seed}|${p.id}`) === "mixed") p.posts = "mixed";
    }
  if (!b.gen.roofPatches || drawStructureOption("roofPatch", s, seed) !== "patched") return null;
  const u = (...what: Array<string | number>): number => hashUnitMixed(seed, "roofPatch", ...what);
  const holes = new Set((ruin?.roofHoles ?? []).map(([x, y]) => key(x, y)));
  // the top storey cells of every volume under a pitched roof (no volume standing on it)
  const roofed = vplans.filter(
    (v) => isPitchedRoof(v.roof.layers[0]?.type) && !vplans.some((o) => o.on === v.id),
  );
  const cells = new Set(
    roofed
      .flatMap((v) => v.storeys[v.storeys.length - 1]?.cells ?? [])
      .map(([x, y]) => key(x, y))
      .filter((k) => !holes.has(k)),
  );
  if (cells.size < 4) return null;
  // generator 5 (`roofKitFacts`): a patch is a repair of the same roof (the kit's own weathered pieces, or a kit of its
  // tone and family); a roof with neither is not patched (a patch in another colour reads as a fault)
  if (b.gen.roofKitFacts && !roofed.every((v) => patchable(v.roof.layers[0]?.style ?? ""))) return null;
  const range = PATCH_SHARE[s.state];
  const want = Math.max(2, Math.round(cells.size * (range[0] + (range[1] - range[0]) * u("share"))));
  const sorted = [...cells].sort();
  // (roofKitFacts: small irregular groups of SMALL_PATCH cells, scattered, instead of one to three large ones)
  const n = b.gen.roofKitFacts
    ? Math.max(1, Math.round(want / SMALL_PATCH))
    : 1 + Math.floor(u("count") * PATCHES);
  const patch = new Set<string>();
  // each patch grows from a drawn cell, cell by cell, toward its own neighbours (a compact, ragged patch)
  for (let i = 0; i < n && patch.size < want; i++) {
    const start = sorted[Math.floor(u("start", i) * sorted.length)] as string;
    if (patch.has(start)) continue;
    const own = new Set([start]);
    const quota = Math.ceil((want - patch.size) / (n - i));
    for (let t = 0; own.size < quota && t < 4 * quota; t++) {
      const front: string[] = [];
      for (const k of [...own].sort()) {
        const [x, y] = cellOf(k);
        for (const sd of SIDES) {
          const nk = key(x + STEP[sd][0], y + STEP[sd][1]);
          if (cells.has(nk) && !own.has(nk) && !patch.has(nk)) front.push(nk);
        }
      }
      if (front.length === 0) break;
      own.add(front[Math.floor(u("grow", i, t) * front.length)] as string);
    }
    for (const k of own) patch.add(k);
  }
  return patch.size > 0 ? [...patch].sort().map(cellOf) : null;
}
