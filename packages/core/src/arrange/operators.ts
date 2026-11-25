/**
 * The arrangement operators, by name: pure functions `(arrangement, params) => arrangement` that compose
 * (`ring(twin(lengthwise(beam)), ...)`). Each lives with its kind (transform.ts, copies.ts, repeat.ts, along.ts,
 * support.ts, scatter.ts, modifiers.ts, budget.ts); this table names the set a recipe composes from and what each is for.
 * A new operator is one function in the file of its kind and one row here.
 *
 * Turns are clockwise seen from above (piece.ts); a copy turned off the 15° grid is placed exactly and its piece's yaw
 * snapped to the grid. Every random choice is a hash of its named parts (util/hash.ts), never a shared stream.
 */
import { run, station } from "./along";
import { thin } from "./budget";
import { fan, layer, mirror, ring, twin } from "./copies";
import { pick, tier, vary } from "./modifiers";
import type { Arrangement } from "./piece";
import { array, repeat, stack } from "./repeat";
import { scatter } from "./scatter";
import { rest, sink } from "./support";
import { transform } from "./transform";

/** One operator: what it is for, and the function (its first argument is the arrangement it works on). */
interface OperatorRow {
  readonly doc: string;
  readonly apply: (a: Arrangement, ...rest: never[]) => Arrangement;
}

export const OPERATORS = {
  transform: { doc: "turn about a point and move the whole arrangement", apply: transform },
  repeat: {
    doc: "copies along an axis or a step vector at a pitch, a count or a length to fill (last copy flush)",
    apply: repeat,
  },
  array: {
    doc: "repeat across, centred, pitch = own width (boards, post rows, shelves; crossed: a mesh)",
    apply: array,
  },
  stack: { doc: "repeat up: vertical courses", apply: stack },
  run: {
    doc: "modules end to end along a polyline or arc (15° facets), overlapping, plugs at the joints",
    apply: run,
  },
  twin: {
    doc: "the arrangement and a copy turned 180° (or 90°) at the same centre, optionally offset",
    apply: twin,
  },
  fan: {
    doc: "N copies at one centre in 15° steps (a square post rounded into a column, a slab into a disc)",
    apply: fan,
  },
  ring: { doc: "copies round a point, facing out, to the centre, along the circle or kept", apply: ring },
  layer: { doc: "a second skin 0.02-0.25 proud of or behind the first, shifted half a module", apply: layer },
  scatter: {
    doc: "an area filled at a density: spacing, clusters, edge bias, lanes kept clear, jitter, gaps",
    apply: scatter,
  },
  rest: { doc: "set on the top of another arrangement, or hung from its underside", apply: rest },
  sink: { doc: "lowered by a share of its own height into what it stands on (negative: proud)", apply: sink },
  vary: {
    doc: "imperfection: shifts along and across, height, turns, flips, gaps (never two in a row)",
    apply: vary,
  },
  pick: { doc: "which piece each place gets: same, mix without runs, an odd one, by height", apply: pick },
  tier: { doc: "the budget tier of every piece (0 kept longest .. 3 thinned first)", apply: tier },
  thin: { doc: "thinned deterministically to a piece budget, finest tier first", apply: thin },
  mirror: { doc: "helper: reflected across a line (each piece re-turned, never scaled)", apply: mirror },
  station: { doc: "helper: a kit every N tiles along a path, mirrored on the far side", apply: station },
} as const satisfies Record<string, OperatorRow>;

export type OperatorName = keyof typeof OPERATORS;
