/**
 * Floor families of natural ground, generator 3. A floor role's weighted variants that carry
 * a `variant` name form one family each (untagged variants are the default family). Generator 2 lets a coarse noise
 * field give each cell one family, which in a cave read as a quilt of hard-edged patches (dark cobble, pale slab, peach
 * sand, white gravel). Generator 3 reads like real ground instead:
 *
 *  - one DOMINANT family covers the field (at least about 70% of its cells);
 *  - at most one second family, close to it in tone (a tagged dark floor never meets a tagged light one), grows only
 *    in patches that have a cause: beside water, along a path, at the foot of a rise of a tile or more, round a tree,
 *    camp or set piece;
 *  - the patch edge is feathered by noise and by distance (a round, ragged halo, not a square), never a rectangle.
 *
 * The build (compile/realize.ts) and the design review (review/review.ts, `floor_patchwork`) both use this module, so
 * the review measures the floor as it is laid. Arithmetic and integer-lattice noise only.
 */
import { CELL, CELL_FLAG, type ResolvedLevel } from "../contracts/resolved";
import { ValueNoise } from "../gen/noise";
import { h32 } from "../util/hash";

export interface FloorFamily {
  name: string;
  /** The heaviest variant's weight. */
  share: number;
  /** Tone tag of the family's heaviest variant (dark, mid, light), when known. */
  tone?: string;
}

/** Families that only ever grow where something causes them (leaf litter, worn earth). */
export const CAUSED_FAMILY_NAMES: ReadonlySet<string> = new Set(["lush"]);

/** Features that cause litter and worn ground round them. */
export const GROUND_CAUSE_FEATURES: ReadonlySet<string> = new Set([
  "cluster_tall",
  "tree",
  "pine_tree",
  "dead_tree",
  "tree_large",
  "campfire",
  "fire_pit",
  "tent",
  "statue",
  "monolith",
  "altar",
  "well",
  "fountain",
]);

export interface FamilyVariant {
  variant?: string | undefined;
  weight: number;
  uuid: string;
  tone?: string | undefined;
}

/** The families of a role's variants (weight above zero), sorted by name; tone from the row or the lookup. */
export function familiesOfVariants(
  vs: readonly FamilyVariant[],
  toneOf: (uuid: string) => string | undefined = () => undefined,
): FloorFamily[] {
  const m = new Map<string, { share: number; tone?: string }>();
  for (const v of vs) {
    if (v.weight <= 0) continue;
    const name = v.variant ?? "";
    const e = m.get(name);
    const tone = v.tone ?? toneOf(v.uuid);
    if (!e) m.set(name, { share: v.weight, ...(tone !== undefined ? { tone } : {}) });
    else if (v.weight > e.share) {
      e.share = v.weight;
      if (tone !== undefined) e.tone = tone;
      else delete e.tone;
    }
  }
  return [...m]
    .map(([name, e]) => ({ name, share: e.share, ...(e.tone !== undefined ? { tone: e.tone } : {}) }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

const TONE_RANK: Record<string, number> = { dark: 0, mid: 1, light: 2 };

/** Two tones are close when both are known and no more than one step apart, or when either is unknown. */
export function tonesClose(a: string | undefined, b: string | undefined): boolean {
  const ra = a === undefined ? undefined : TONE_RANK[a];
  const rb = b === undefined ? undefined : TONE_RANK[b];
  if (ra === undefined || rb === undefined) return true;
  return Math.abs(ra - rb) <= 1;
}

/** The dominant family and the one family that may grow in caused patches (null when there is none). */
export function dominantAndCaused(fams: readonly FloorFamily[]): { dominant: string; caused: string | null } {
  if (fams.length === 0) return { dominant: "", caused: null };
  // a family that only grows where caused is never the ground itself
  const base = fams.filter((f) => !CAUSED_FAMILY_NAMES.has(f.name));
  const pool = base.length > 0 ? base : fams;
  const dom = [...pool].sort((a, b) => b.share - a.share || (a.name < b.name ? -1 : 1))[0] as FloorFamily;
  const rest = fams.filter((f) => f.name !== dom.name && tonesClose(dom.tone, f.tone));
  // prefer a family that is caused by nature, then a tone known to be near, then the heaviest
  const score = (f: FloorFamily): number =>
    (CAUSED_FAMILY_NAMES.has(f.name) ? 4 : 0) +
    (f.tone !== undefined && dom.tone !== undefined ? 2 : 0) +
    f.share / 100;
  const second = [...rest].sort((a, b) => score(b) - score(a) || (a.name < b.name ? -1 : 1))[0];
  return { dominant: dom.name, caused: second?.name ?? null };
}

/** Radius (cells) round a cause where the second family may grow. */
const REACH = 3;

/** A feathered, noisy halo round a cause: nearer cells and higher noise take the second family. */
export function inCausedPatch(distance: number, noise: number): boolean {
  if (distance > REACH) return false;
  return noise > 0.45 + 0.5 * (distance / REACH);
}

/**
 * A family chooser for one level (generator 3): `(families, x, y) => family name`. The cause distances (Euclidean,
 * to water, paths, the foot of rises of a tile or more, trees, camps and set pieces) are computed once.
 */
export function createFamilyPicker(
  L: ResolvedLevel,
  seed: number,
): (fams: readonly FloorFamily[], x: number, y: number) => string {
  const { x: bx, y: by, w, h } = L.bounds;
  const dist = new Float64Array(w * h).fill(99);
  const stamp = (cx: number, cy: number): void => {
    for (let dy = -REACH; dy <= REACH; dy++)
      for (let dx = -REACH; dx <= REACH; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const d = Math.sqrt(dx * dx + dy * dy);
        const i = y * w + x;
        if (d < (dist[i] as number)) dist[i] = d;
      }
  };
  const open = (i: number): boolean =>
    L.cells.state[i] === CELL.OPEN && ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) === 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (L.cells.state[i] !== CELL.OPEN) continue;
      const fl = L.cells.flags[i] ?? 0;
      if ((fl & (CELL_FLAG.WATER | CELL_FLAG.PATH)) !== 0) {
        stamp(x, y);
        continue;
      }
      if (!open(i)) continue;
      const hi = L.cells.height[i] ?? 0;
      for (const [nx, ny] of [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ] as const) {
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        // the foot of a rise: this cell is the low one
        if (open(j) && (L.cells.height[j] ?? 0) - hi >= 4) {
          stamp(x, y);
          break;
        }
      }
    }
  for (const f of L.features) {
    if (!GROUND_CAUSE_FEATURES.has(f.type)) continue;
    for (let y = f.at[1]; y < f.at[1] + f.size[1]; y++)
      for (let x = f.at[0]; x < f.at[0] + f.size[0]; x++) stamp(x - bx, y - by);
  }
  const warp = new ValueNoise(h32(`${seed}:floorfamilies:warp`));
  const grain = new ValueNoise(h32(`${seed}:floorfamilies:grain`));
  const memo = new Map<string, { dominant: string; caused: string | null }>();
  // two scales: broad lobes and fine ragged grain, so the halo is neither a ring nor a square
  const noiseAt = (x: number, y: number): number =>
    0.65 * warp.sample(x / 2.5 + 11, y / 2.5 + 3) + 0.35 * grain.sample(x / 1.2, y / 1.2);
  // the laid patches (generator 3): blobs of several cells, never single squares, and a few percent of the open ground
  const mask = new Uint8Array(w * h);
  {
    const margin = new Float64Array(w * h).fill(-1);
    let ground = 0;
    for (let ly = 0; ly < h; ly++)
      for (let lx = 0; lx < w; lx++) {
        const i = ly * w + lx;
        if (!open(i)) continue;
        ground++;
        const d = dist[i] as number;
        if (d > REACH) continue;
        const m = noiseAt(bx + lx, by + ly) - (0.45 + 0.5 * (d / REACH));
        if (m > 0) {
          mask[i] = 1;
          margin[i] = m;
        }
      }
    const prune = (): void => {
      for (let round = 0; round < 8; round++) if (!pruneOnce()) break;
    };
    const pruneOnce = (): boolean => {
      const keep = new Uint8Array(w * h);
      for (let ly = 0; ly < h; ly++)
        for (let lx = 0; lx < w; lx++) {
          if (!mask[ly * w + lx]) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const x = lx + dx;
              const y = ly + dy;
              if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) n++;
            }
          if (n >= PATCH.minNeighbours) keep[ly * w + lx] = 1;
        }
      const changed = keep.some((v, i) => v !== mask[i]);
      mask.set(keep);
      return changed;
    };
    prune();
    const cells: number[] = [];
    for (let i = 0; i < w * h; i++) if (mask[i]) cells.push(i);
    const cap = Math.floor(PATCH.maxShare * ground);
    if (cells.length > cap) {
      // keep the patches the noise and the causes favour most
      cells.sort((a, b) => (margin[b] as number) - (margin[a] as number) || a - b);
      for (const i of cells.slice(cap)) mask[i] = 0;
      prune();
    }
  }
  return (fams, x, y) => {
    if (fams.length <= 1) return fams[0]?.name ?? "";
    const key = fams.map((f) => f.name).join("|");
    let pick = memo.get(key);
    if (!pick) {
      pick = dominantAndCaused(fams);
      memo.set(key, pick);
    }
    if (pick.caused === null) return pick.dominant;
    const lx = x - bx;
    const ly = y - by;
    if (lx < 0 || ly < 0 || lx >= w || ly >= h) return pick.dominant;
    return mask[ly * w + lx] ? pick.caused : pick.dominant;
  };
}

/** Laid patches: a patch cell has at least this many patch neighbours (of 8), and all patches take at most this share of the open ground. */
export const PATCH = { minNeighbours: 3, maxShare: 0.05 } as const;

/**
 * Measures of the laid second family on a level, for the design review and tests: its share of the open ground and
 * the share of its cells with fewer than `PATCH.minNeighbours` patch neighbours (single squares and thin strings).
 */
export function patchStats(
  L: ResolvedLevel,
  seed: number,
  fams: readonly FloorFamily[],
): { share: number; lonely: number; cells: number } {
  const { w, h, x: bx, y: by } = L.bounds;
  const pick = createFamilyPicker(L, seed);
  const { caused } = dominantAndCaused(fams);
  if (caused === null) return { share: 0, lonely: 0, cells: 0 };
  const is = new Uint8Array(w * h);
  let ground = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (L.cells.state[i] !== CELL.OPEN || ((L.cells.flags[i] ?? 0) & CELL_FLAG.NO_FLOOR) !== 0) continue;
    ground++;
    if (pick(fams, bx + (i % w), by + Math.floor(i / w)) === caused) {
      is[i] = 1;
      n++;
    }
  }
  let lonely = 0;
  for (let i = 0; i < w * h; i++) {
    if (!is[i]) continue;
    let k = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const x = (i % w) + dx;
        const y = Math.floor(i / w) + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && is[y * w + x]) k++;
      }
    if (k < PATCH.minNeighbours) lonely++;
  }
  return { share: ground > 0 ? n / ground : 0, lonely: n > 0 ? lonely / n : 0, cells: n };
}
