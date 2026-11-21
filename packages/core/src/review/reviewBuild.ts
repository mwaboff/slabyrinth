/**
 * The build a design review measures (cave rock mass, roof gaps, and any later note that needs the placed pieces).
 *
 * A note measured on the realized pieces needs a build. The CLI already ran one and hands it in (`given`). The in-app
 * review has none, so a note that needs one asks here, and the realizer runs ONCE per review run however many notes
 * ask: `get()` builds on the first call and returns the same placement set after that. A review whose notes have
 * nothing to measure (no cave level, no pitched roof) never calls it and never builds.
 *
 * Cost: one `realize()` of the whole plan (no verify, no chunking, no encoding): a fraction of a compile, run only by a
 * generator 4 plan that has something to measure. A note decides that itself with its own `wants` test before asking,
 * and a released generator keeps its released behaviour (no build, no note) by saying no there.
 */
import { realize } from "../compile/realize";
import type { PaletteCatalog, PlacementSet } from "../contracts/compiler";
import type { ResolvedPlan } from "../contracts/resolved";

export interface ReviewBuild {
  /** True when the caller supplied the build (the CLI ran it anyway). */
  readonly given: boolean;
  /** The placement set: the given one, else built on the first call and kept. */
  get(): PlacementSet;
  /** How many times this review ran the realizer (0 or 1). */
  readonly built: number;
}

export function reviewBuild(resolved: ResolvedPlan, palettes: PaletteCatalog, given?: PlacementSet): ReviewBuild {
  let set = given;
  let built = 0;
  return {
    given: given !== undefined,
    get() {
      if (!set) {
        set = realize(resolved, palettes, {});
        built++;
      }
      return set;
    },
    get built() {
      return built;
    },
  };
}
