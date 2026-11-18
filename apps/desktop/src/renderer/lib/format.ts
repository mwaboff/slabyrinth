/** Small pure formatting helpers shared across the UI (and the fake bridge). */

/** Ruler column letters: 0 → A, 25 → Z, 26 → AA. */
export function colLetters(i: number): string {
  let n = Math.max(0, Math.floor(i));
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Square reference like "H12" (column letters + 1-based row) in level-local coordinates. */
export function cellName(lx: number, ly: number): string {
  return `${colLetters(lx)}${ly + 1}`;
}

export const FEET_PER_SQ = 5;

export function sqSize(w: number, h: number): string {
  return `${w}×${h} sq (${w * FEET_PER_SQ}×${h * FEET_PER_SQ} ft)`;
}

export function ftSize(w: number, h: number): string {
  return `${w * FEET_PER_SQ}×${h * FEET_PER_SQ} ft`;
}

/** UX §5.8 rounding so estimates never look falsely precise. */
export function roundCost(usd: number): string {
  if (usd < 0.01) return "< $0.01";
  const steps = [0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, 1.5, 2, 3, 5];
  const v = steps.find((s) => usd <= s * 1.15) ?? Math.ceil(usd);
  return `$${v.toFixed(2)}`;
}

export function roundSeconds(s: number): string {
  if (s < 15) return "~10 s";
  if (s < 45) return "~30 s";
  if (s < 50) return "about 40 s";
  if (s < 90) return "~1 min";
  return "1–2 min";
}

export function money(usd: number, digits = 2): string {
  return `$${usd.toFixed(digits)}`;
}

export function tokens(n: number): string {
  if (n < 1000) return `${n} tok`;
  return `${Math.round(n / 1000)}k tok`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function clock(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const diff = Math.max(0, now - new Date(iso).getTime());
  const m = Math.round(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  const w = Math.round(d / 7);
  if (w === 1) return "last week";
  if (d < 30) return `${w} weeks ago`;
  const mo = Math.round(d / 30);
  return mo <= 1 ? "last month" : `${mo} months ago`;
}

export function kb(bytes: number): string {
  return (bytes / 1024).toFixed(1);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return "Good evening.";
  if (h < 12) return "Good morning.";
  if (h < 18) return "Good afternoon.";
  return "Good evening.";
}

/**
 * Pre-build slab count from `compile:estimate`, always worded as an estimate: the estimate has no real gzip and may
 * over-count by one near the 30,720-byte limit (decisions.md, contract rulings).
 */
export function slabEstimate(n: number): string {
  return n <= 1 ? "about one slab" : `about ${n} slab parts`;
}
