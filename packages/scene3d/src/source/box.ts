/** The mesh source that has no meshes: every piece stands as a box of its real collider size. */
import type { FallbackReason, MeshLookup, MeshSource } from "../types/index";

/** Boxes for every asset, reported with `reason` ("boxes-requested" for --boxes, "no-install" when none was found). */
export function boxMeshSource(reason: FallbackReason = "boxes-requested", label = "boxes only"): MeshSource {
  const answer: MeshLookup = { kind: "box", reason };
  return {
    label,
    load(uuids) {
      return Promise.resolve(new Map(uuids.map((u) => [u, answer])));
    },
  };
}
