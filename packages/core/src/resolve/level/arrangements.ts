/**
 * Generator 5 (`arrangements`): the level's arrangement instances (ResolvedLevel.arrangements). A stage composes an
 * arrangement (arrange/), makes its element with `toInstance`, and attaches it here; output.ts writes the list. The
 * level's pieces stay within `ARRANGE_LIMITS.piecesPerLevel`: an instance that would pass it is thinned to what is left
 * (the same draw every time), and one with nothing left is not attached.
 * Reads: the generator switch. Writes: this record only.
 */
import type { ResolvedArrangement } from "../../contracts/resolved";
import { ARRANGE_LIMITS, thin } from "../../arrange";
import type { GeneratorProfile } from "../../plan/generator";

export class ArrangementRecords {
  readonly all: ResolvedArrangement[] = [];
  private pieces = 0;

  /**
   * Adds an instance, thinned to the level's remaining budget. Returns what was attached (null when the generator does
   * not build arrangements or the level's budget is spent).
   */
  attach(
    profile: Pick<GeneratorProfile, "arrangements">,
    inst: ResolvedArrangement,
  ): ResolvedArrangement | null {
    if (!profile.arrangements) return null;
    const room = ARRANGE_LIMITS.piecesPerLevel - this.pieces;
    if (room <= 0 || inst.pieces.length === 0) return null;
    const kept =
      inst.pieces.length <= room
        ? inst
        : { ...inst, pieces: [...thin(inst.pieces, room, `${inst.id}:level`)] };
    this.all.push(kept);
    this.pieces += kept.pieces.length;
    return kept;
  }

  /** Pieces attached so far. */
  get pieceCount(): number {
    return this.pieces;
  }
}
