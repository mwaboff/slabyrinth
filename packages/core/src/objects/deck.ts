/**
 * A walkable floor over a convex outline in an object's frame (a deck, a raised deck, a cart bed), from floor tiles,
 * which stay on quarter turns: the whole cells inside take 2 x 2 tiles where four are free, else 1 x 1; the sloping
 * margins between them and the outline take 1 x 1 tiles set off the cell grid (still square to the frame), each pushed
 * out until its outermost corner touches the outline, every 0.4 along it. Margin tiles sit 0.04 to 0.12 below the top in
 * a cycle of three, so no two flat tops lie within 0.02 of each other (flicker) and the step hardly reads. The top of
 * every tile is at `y` (the surface a mini stands on).
 */
import type { ArrangePiece, Placed, XZ } from "../arrange/piece";
import { maxOf, minOf } from "../util/lists";
import { signedArea } from "../util/turn";
import { insideOrNear } from "./outline";
import type { ObjectKit } from "./kit";

const MARGIN_PITCH = 0.4;
const MARGIN_DROP = [0.04, 0.08, 0.12] as const;

/** Floor tiles over the polygon with their tops at `y` (see the file header); empty when the kit has no floor tile. */
export function floorOver(poly: readonly XZ[], y: number, kit: ObjectKit, seed: string): Placed[] {
  const small = kit.standIn("deckSmall");
  const one = small?.pieces[0];
  if (!one) return [];
  const big = kit.standIn("deck");
  const two = big && big.id === "deck" ? big : null;
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const x0 = Math.floor(minOf(xs));
  const z0 = Math.floor(minOf(zs));
  const x1 = Math.ceil(maxOf(xs));
  const z1 = Math.ceil(maxOf(zs));
  const key = (x: number, z: number): string => `${x},${z}`;
  const whole = new Set<string>();
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++)
      if (
        insideOrNear(poly, x, z, 0.02) &&
        insideOrNear(poly, x + 1, z, 0.02) &&
        insideOrNear(poly, x, z + 1, 0.02) &&
        insideOrNear(poly, x + 1, z + 1, 0.02)
      )
        whole.add(key(x, z));
  const out: Placed[] = [];
  const tile = (piece: ArrangePiece, cx: number, cz: number, top: number): Placed => ({
    piece,
    x: cx,
    y: top - piece.variant.geom.size.y,
    z: cz,
    yaw: 0,
  });
  const used = new Set<string>();
  for (let z = z0; z < z1; z++)
    for (let x = x0; x < x1; x++) {
      if (!whole.has(key(x, z)) || used.has(key(x, z))) continue;
      const block = [key(x, z), key(x + 1, z), key(x, z + 1), key(x + 1, z + 1)];
      if (two && block.every((k) => whole.has(k) && !used.has(k))) {
        block.forEach((k) => used.add(k));
        const p = kit.pick("deck", seed, x, z) ?? two.pieces[0];
        if (p) out.push(tile(p, x + 1, z + 1, y));
      } else {
        used.add(key(x, z));
        out.push(tile(kit.pick("deckSmall", seed, x, z) ?? one, x + 0.5, z + 0.5, y));
      }
    }
  // margins: along every side, 1 x 1 tiles pushed out to touch the outline with a corner
  const covered = (x: number, z: number): boolean => used.has(key(Math.floor(x), Math.floor(z)));
  let k = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as XZ;
    const b = poly[(i + 1) % poly.length] as XZ;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 1e-6) continue;
    const ux = (b[0] - a[0]) / len;
    const uz = (b[1] - a[1]) / len;
    // inward normal of an anticlockwise polygon: left of travel
    const area = signedArea(poly);
    const nx = area > 0 ? -uz : uz;
    const nz = area > 0 ? ux : -ux;
    const reach = 0.5 * Math.abs(nx) + 0.5 * Math.abs(nz);
    const n = Math.max(1, Math.ceil(len / MARGIN_PITCH));
    for (let j = 0; j <= n; j++) {
      const t = (j / n) * len;
      const cx = a[0] + ux * t + nx * reach;
      const cz = a[1] + uz * t + nz * reach;
      const corners: XZ[] = [
        [cx - 0.5, cz - 0.5],
        [cx + 0.5, cz - 0.5],
        [cx - 0.5, cz + 0.5],
        [cx + 0.5, cz + 0.5],
      ];
      if (!corners.every(([px, pz]) => insideOrNear(poly, px, pz, 0.02))) continue;
      if (
        corners.every(([px, pz]) => covered(px + 1e-3 * Math.sign(cx - px), pz + 1e-3 * Math.sign(cz - pz)))
      )
        continue;
      const drop = MARGIN_DROP[k % MARGIN_DROP.length] ?? 0.03;
      k++;
      out.push(tile(kit.pick("deckSmall", seed, "margin", i, j) ?? one, cx, cz, y - drop));
    }
  }
  return out;
}
