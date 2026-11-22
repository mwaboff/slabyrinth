/**
 * Modifiers over the pieces of an arrangement, after the operators have placed them: `vary` (imperfection: shifts,
 * turns, flips, gaps, heights), `pick` (which piece each place gets) and `tier` (what a budget drops first). Every draw is
 * `hashUnit(seed, what, index)`, so the same parameters give the same result and another modifier never moves it.
 */
import { hashUnit } from "../util/hash";
import { rotateXZ } from "../util/turn";
import { snapYaw, type ArrangePiece, type Arrangement, type Placed } from "./piece";

export interface VaryParams {
  readonly seed: string | number;
  /** ± shift along each piece's own x (its length, for a module laid lengthwise), tiles. */
  readonly along?: number;
  /** ± shift along each piece's own z, tiles. */
  readonly across?: number;
  /** ± change of height, tiles. */
  readonly height?: number;
  /** ± turn, degrees (in 15° steps). */
  readonly yaw?: number;
  /** Share of pieces turned 180°. */
  readonly flip?: number;
  /** Share of pieces left out ... */
  readonly empty?: number;
  /** ... never more than this many in a row (default 1). */
  readonly maxEmptyRun?: number;
}

/** Each piece moved, turned, flipped or left out a little, by its own draws (a hand-built look, never a pattern). */
export function vary(a: Arrangement, p: VaryParams): Arrangement {
  const draw = (what: string, i: number): number => hashUnit(p.seed, "vary", what, i);
  const signed = (what: string, i: number, max: number): number => (draw(what, i) * 2 - 1) * max;
  const out: Placed[] = [];
  let emptyRun = 0;
  a.forEach((q, i) => {
    if (draw("empty", i) < (p.empty ?? 0) && emptyRun < (p.maxEmptyRun ?? 1)) {
      emptyRun++;
      return;
    }
    emptyRun = 0;
    const shift = rotateXZ(signed("along", i, p.along ?? 0), signed("across", i, p.across ?? 0), q.yaw);
    const steps = Math.round((p.yaw ?? 0) / 15);
    const turn = (Math.floor(draw("yaw", i) * (2 * steps + 1)) - steps) * 15;
    const flip = draw("flip", i) < (p.flip ?? 0) ? 180 : 0;
    out.push({
      ...q,
      x: q.x + shift.x,
      z: q.z + shift.z,
      y: q.y + signed("height", i, p.height ?? 0),
      yaw: snapYaw(q.yaw + turn + flip),
    });
  });
  return out;
}

/** How each place chooses its piece from the candidates. */
export type PickPolicy =
  /** One choice for every place. */
  | { readonly kind: "same" }
  /** Any candidate at each place, but never the same one more than `noRun` times in a row (default 3). */
  | { readonly kind: "mix"; readonly noRun?: number }
  /** The first candidate, and now and then (`rate`) one of the others. */
  | { readonly kind: "odd"; readonly rate: number }
  /** The first candidate below `split` (0..1) of the arrangement's height, the second above (bigger stones low). */
  | { readonly kind: "byHeight"; readonly split: number };

export interface PickParams {
  readonly from: readonly ArrangePiece[];
  readonly policy: PickPolicy;
  readonly seed: string | number;
}

/**
 * Each place given a piece from `from` by the policy, keeping its centre, bottom and turn; a candidate whose long side
 * lies on the other axis than the piece it replaces is turned a quarter more, so a run stays a run.
 */
export function pick(a: Arrangement, p: PickParams): Arrangement {
  const n = p.from.length;
  if (n === 0) return a;
  const draw = (what: string, i: number): number => hashUnit(p.seed, "pick", what, i);
  const any = (what: string, i: number): number => Math.floor(draw(what, i) * n);
  const choose = chooser(a, p, any);
  return a.map((q, i) => {
    const c = p.from[choose(i)] ?? p.from[0];
    if (c === undefined) return q;
    const from = q.piece.measures.runAxis;
    const to = c.measures.runAxis;
    const quarter = from !== null && to !== null && from !== to ? 90 : 0;
    return { ...q, piece: c, yaw: snapYaw(q.yaw + quarter) };
  });
}

/** The index of the candidate each place takes, by the policy (asked for the places in order: `mix` counts runs). */
function chooser(
  a: Arrangement,
  p: PickParams,
  any: (what: string, i: number) => number,
): (i: number) => number {
  const n = p.from.length;
  const policy = p.policy;
  switch (policy.kind) {
    case "same": {
      const one = any("same", 0);
      return () => one;
    }
    case "odd":
      return (i) =>
        n > 1 && hashUnit(p.seed, "pick", "odd", i) < policy.rate ? 1 + (any("other", i) % (n - 1)) : 0;
    case "byHeight": {
      const bottom = a.reduce((m, q) => Math.min(m, q.y), Infinity);
      const top = a.reduce((m, q) => Math.max(m, q.y + q.piece.variant.geom.size.y), bottom);
      const cut = bottom + policy.split * (top - bottom);
      return (i) => ((a[i]?.y ?? bottom) < cut ? 0 : Math.min(1, n - 1));
    }
    case "mix": {
      const noRun = Math.max(1, policy.noRun ?? 3);
      const chosen: number[] = [];
      return (i) => {
        let c = any("mix", i);
        const recent = chosen.slice(-noRun);
        if (n > 1 && recent.length === noRun && recent.every((r) => r === c)) c = (c + 1) % n;
        chosen.push(c);
        return c;
      };
    }
  }
}

/** Every piece marked with a budget tier (0 kept longest .. 3 dropped first). */
export function tier(a: Arrangement, p: { readonly tier: number }): Arrangement {
  return a.map((q) => ({ ...q, tier: p.tier }));
}
