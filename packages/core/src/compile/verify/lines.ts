/**
 * Overhead lines (generator 3): a line's pieces hang from its anchors, not from the floor. A piece is exempt from the
 * floating test only when its line (ResolvedLevel.lines) holds at both ends: a wall or roof piece at the line's height
 * beside the anchor cell, or a post piece of the line that reaches it.
 *
 * Emits `verify_line_unanchored` (warning) once per line that does not hold, when the prop check first asks about one of
 * its pieces (so it lands among the prop diagnostics); that line's pieces still fire `verify_prop_floating`.
 */
import type { ResolvedLevel } from "../../contracts/resolved";
import type { VerifyReport } from "./context";
import type { SolidIndex } from "./grid";
import { LINE_HEIGHT_TOLERANCE } from "./limits";
import { fmt, round2 } from "./words";

export class OverheadLines {
  private readonly holds = new Map<string, boolean>();

  constructor(
    private readonly solids: SolidIndex,
    private readonly report: VerifyReport,
  ) {}

  /** Does the line the piece `featureId` belongs to hold at both ends? (A piece hung at `y`; memoized per line.) */
  held(L: ResolvedLevel, featureId: string | undefined, y: number): boolean {
    const lineId = (featureId ?? "").split("#")[0] ?? "";
    const ln = (L.lines ?? []).find((q) => q.id === lineId);
    if (!ln) return false;
    const key = `${L.id}|${ln.id}`;
    const hit = this.holds.get(key);
    if (hit !== undefined) return hit;
    // the rope's own height (absolute): a hung piece sits lower than the line
    const lineY =
      L.features.find((f) => f.id.startsWith(`${ln.id}#`) && f.type === "overhead")?.baseHeight ?? y;
    const holds = ln.anchors.every((an) => {
      // the wall stands on the cell's edge, hosted in this cell or the one beside it: look at the cell and its neighbours
      const near = [-1, 0, 1].flatMap((dx) =>
        [-1, 0, 1].flatMap((dy) => this.solids.near(an.at[0] + dx + 0.5, an.at[1] + dy + 0.5)),
      );
      return near.some((q) => {
        if (q.levelId !== L.id) return false;
        if (an.kind === "post")
          return (
            q.role === "feature" &&
            (q.p.source.elementId ?? "").startsWith(`${ln.id}#post`) &&
            q.box.max.y >= lineY - LINE_HEIGHT_TOLERANCE
          );
        return (
          q.role !== "floor" &&
          q.role !== "fill" &&
          q.role !== "feature" &&
          q.role !== "link" &&
          q.box.max.y >= lineY - LINE_HEIGHT_TOLERANCE &&
          q.box.min.y <= lineY + LINE_HEIGHT_TOLERANCE
        );
      });
    });
    this.holds.set(key, holds);
    if (!holds)
      this.report.add({
        severity: "warning",
        code: "verify_line_unanchored",
        levelId: L.id,
        elementId: ln.id,
        message: `Overhead line "${ln.id}" is not held at both ends: no wall or post reaches its height (${round2(lineY)}) beside ${fmt(ln.a)} and ${fmt(ln.b)}.`,
        hint: `Raise the posts or end the line against a taller wall, or lower the line's height.`,
      });
    return holds;
  }
}
