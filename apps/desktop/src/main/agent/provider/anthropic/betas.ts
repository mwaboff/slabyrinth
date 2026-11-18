/**
 * Per-feature beta flags (decisions.md #3, architecture §3.10). Every beta feature is on by default and switches
 * itself off for the rest of the session when the API rejects it with a 400 that names its header value or its
 * request field; the step is then retried once without it. The core loop works with every flag off.
 */

export type BetaFeature = "fallbacks" | "bindingControls" | "compaction" | "perMessageEffort";

export interface BetaSpec {
  feature: BetaFeature;
  header: string;
  /** Substrings of a 400 message that attribute the rejection to this feature. */
  markers: RegExp;
  description: string;
}

export const BETA_SPECS: readonly BetaSpec[] = [
  {
    feature: "fallbacks",
    header: "server-side-fallback-2026-07-01",
    markers: /server-side-fallback|\bfallbacks\b/i,
    description: 'server-side refusal fallback (fallbacks: "default")',
  },
  {
    feature: "bindingControls",
    header: "thinking-binding-controls-2026-08-01",
    markers: /thinking-binding-controls|block_binding|prefix_mismatch_behavior/i,
    description: "thinking block binding controls (prefix_mismatch_behavior)",
  },
  {
    feature: "compaction",
    header: "compact-2026-01-12",
    markers: /compact-2026-01-12|compact_20260112|context_management/i,
    description: "server-side compaction (context_management compact_20260112)",
  },
  {
    feature: "perMessageEffort",
    header: "mid-conversation-output-config-2026-07-01",
    markers: /mid-conversation-output-config|output_config\.effort requires|messages\.\d+\.output_config/i,
    description: "per-message effort (effort-only system messages)",
  },
];

export class BetaFlags {
  private readonly disabled = new Set<BetaFeature>();
  constructor(initiallyDisabled: readonly BetaFeature[] = []) {
    for (const f of initiallyDisabled) this.disabled.add(f);
  }
  enabled(f: BetaFeature): boolean {
    return !this.disabled.has(f);
  }
  disable(f: BetaFeature): void {
    this.disabled.add(f);
  }
  disabledList(): BetaFeature[] {
    return [...this.disabled].sort();
  }
}

/**
 * The enabled feature a 400 message blames, or null. `active` restricts the search to features the failed request
 * actually used.
 */
export function blamedFeature(message: string, active: readonly BetaFeature[]): BetaFeature | null {
  for (const spec of BETA_SPECS) {
    if (active.includes(spec.feature) && spec.markers.test(message)) return spec.feature;
  }
  return null;
}

export function headerOf(f: BetaFeature): string {
  const spec = BETA_SPECS.find((s) => s.feature === f);
  if (!spec) throw new Error(`unknown beta feature ${f}`);
  return spec.header;
}
