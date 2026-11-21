/** The characters openings are drawn with, and the legend under the map: only what the drawn map showed. */
import type { OpeningKind } from "../../contracts/plan";
import type { AsciiSeen } from "./context";

export const OPENING_CHAR: Record<OpeningKind, string> = {
  door: "d",
  double_door: "D",
  locked_door: "L",
  secret_door: "s",
  archway: "a",
  open: " ",
  window: "w",
  arrow_slit: "w",
  portcullis: "p",
  bars: "p",
};

const OPENING_NAME: Record<string, string> = {
  d: "door",
  D: "double door",
  L: "locked door",
  s: "secret door",
  a: "archway",
  w: "window/arrow slit",
  p: "portcullis/bars",
};

/** Legend entries in this order (opening characters, then the cell characters with their own line). */
const LEGEND_OPENINGS = ["d", "D", "L", "s", "a", "w", "p"];

/** Heights in quarter tiles as tiles ("-0.5 +1"). */
const fmtH = (qs: ReadonlySet<number>): string =>
  [...qs]
    .sort((a, b) => a - b)
    .map((q) => (q > 0 ? "+" : "") + String(q / 4))
    .join(" ");

/** The legend line (when anything needs one), then the link notes and the issue notes. */
export function legendLines(
  seen: AsciiSeen,
  featLegend: ReadonlyArray<readonly [string, string]>,
  linkNotes: readonly string[],
  markNotes: readonly string[],
): string[] {
  const lines: string[] = [];
  const parts: string[] = [];
  for (const ch of LEGEND_OPENINGS)
    if (seen.edgeChars.has(ch)) parts.push(`${ch} ${OPENING_NAME[ch] as string}`);
  if (seen.ledge) parts.push(": ledge/cliff (height step between cells)");
  const base = seen.base;
  if (seen.low.size > 0 && base.has("_")) parts.push(`_ floor below the level floor (${fmtH(seen.low)})`);
  const digits = [...base].filter((ch) => /^[1-9]$/.test(ch)).sort();
  if (digits.length > 0) parts.push(`${digits.join("")} raised floor in half tiles (1 = +0.5, 2 = +1 …)`);
  if (seen.high.size > 0 && base.has("^")) parts.push(`^ raised floor (${fmtH(seen.high)})`);
  if (seen.stair) parts.push("/ steps (walkable stair between heights)");
  if (base.has("%")) parts.push("% lava");
  if (base.has("~")) parts.push("~ shallow water");
  if (base.has("W")) parts.push("W deep water");
  if (base.has("=")) parts.push("= bridge deck");
  if (base.has("O")) parts.push("O hole / no floor");
  for (const [ch, name] of featLegend) parts.push(`${ch} ${name}`);
  if (parts.length > 0) lines.push(`legend: ${parts.join(", ")}`);
  for (const n of linkNotes) lines.push(`link ${n}`);
  for (const n of markNotes) lines.push(n);
  return lines;
}
