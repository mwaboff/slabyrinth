/**
 * A mesh source held to a memory budget: the meshes another source answers are kept, in asset-id order, until their
 * bytes reach the budget; every later one is a box of its real size with reason "budget". A huge map then still shows
 * every piece, its detail limited, instead of running the host out of memory.
 */
import type { MeshLookup, MeshSource } from "../types/index";

export interface BudgetedSource extends MeshSource {
  /** Bytes of the meshes kept by the last load, and whether the budget cut any. */
  readonly last: { bytes: number; cut: number };
}

export function budgetedSource(inner: MeshSource, maxBytes: number): BudgetedSource {
  const last = { bytes: 0, cut: 0 };
  return {
    label: inner.label,
    last,
    async load(uuids) {
      const got = await inner.load(uuids);
      const out = new Map<string, MeshLookup>();
      last.bytes = 0;
      last.cut = 0;
      for (const uuid of [...got.keys()].sort()) {
        const hit = got.get(uuid);
        if (!hit) continue;
        if (hit.kind === "mesh") {
          const bytes = hit.mesh.positions.byteLength + hit.mesh.indices.byteLength;
          if (last.bytes + bytes > maxBytes) {
            last.cut++;
            out.set(uuid, { kind: "box", reason: "budget" });
            continue;
          }
          last.bytes += bytes;
        }
        out.set(uuid, hit);
      }
      return out;
    },
  };
}
