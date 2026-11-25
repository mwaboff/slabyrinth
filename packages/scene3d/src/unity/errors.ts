/** Failures of the game-file readers; the mesh source turns each into a box with its reason. */

/** A container, serialized-file version or layout the readers were not written for (the game changed its files). */
export class UnsupportedFormat extends Error {
  override name = "UnsupportedFormat";
}

/** Bytes that do not decode as their format says (corrupt, truncated, or a reader fault). */
export class DecodeError extends Error {
  override name = "DecodeError";
}
