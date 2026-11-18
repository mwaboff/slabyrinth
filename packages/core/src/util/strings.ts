/** Small string helpers for model-facing hints ("did you mean …?"). */

/** Levenshtein edit distance (iterative, O(|a|·|b|)). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/**
 * Closest candidate to `input` (case-insensitive edit distance; substring matches count as distance 1),
 * or undefined when nothing is reasonably close (distance > max(2, 40% of the input length)).
 * Ties keep the earlier candidate, so results are deterministic.
 */
export function nearest(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: string | undefined;
  let bestScore = Infinity;
  for (const c of candidates) {
    const hay = c.toLowerCase();
    let score = editDistance(needle, hay);
    if (needle.length >= 3 && hay.length >= 3 && (hay.includes(needle) || needle.includes(hay))) {
      score = Math.min(score, 1);
    }
    if (score < bestScore) {
      bestScore = score;
      best = c;
    }
  }
  const limit = Math.max(2, Math.floor(needle.length * 0.4));
  return bestScore <= limit ? best : undefined;
}

/** Join a list for messages, truncating after `max` items ("a, b, c … (+4 more)"). */
export function listForHint(items: readonly string[], max = 12): string {
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown} … (+${items.length - max} more)` : shown;
}
