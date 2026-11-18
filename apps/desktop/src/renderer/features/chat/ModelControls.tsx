/**
 * Model list + effort control (UX §5.8, §8.4), shared by the composer popover and Settings ▸ AI provider.
 * Everything is driven by provider/model capabilities: a missing capability makes its element disappear
 * (never a disabled control) — no effort support → no Effort group; no cost → no $ tiers; no speed → no pips.
 */
import type { KeyboardEvent } from "react";
import {
  EFFORT_LEVELS,
  type EffortLevel,
  type ModelDescriptor,
  type ProviderInfo,
} from "../../../main/agent/provider/types";
import { EFFORT_LABEL, EFFORT_NOTE, shortModelName } from "../../stores/settings";

export interface Capabilities {
  hasCost: boolean;
  hasSpeed: boolean;
}

export function capsOf(p: Pick<ProviderInfo, "hasCost" | "hasSpeedGuidance"> | undefined): Capabilities {
  return { hasCost: p?.hasCost ?? true, hasSpeed: p?.hasSpeedGuidance ?? true };
}

export function effortLevels(m: ModelDescriptor | undefined): EffortLevel[] {
  if (!m || !m.effort.supported) return [];
  return EFFORT_LEVELS.filter((l) => m.effort.supported && m.effort.levels.includes(l));
}

/** The effort a model will actually use for `wanted` (UX §5.8: snap to the model's default when not offered). */
export function snapEffort(
  m: ModelDescriptor | undefined,
  wanted: EffortLevel | null,
): { effort: EffortLevel | null; snapped: boolean } {
  if (!m || !m.effort.supported) return { effort: null, snapped: false };
  if (wanted !== null && m.effort.levels.includes(wanted)) return { effort: wanted, snapped: false };
  return { effort: m.effort.default, snapped: wanted !== null };
}

function Tiers({ n, of, label, kind }: { n: number; of: number; label: string; kind: "cost" | "speed" }) {
  return (
    <span className={`tiers tiers--${kind}`} role="img" aria-label={label} title={label}>
      {Array.from({ length: of }, (_, i) =>
        kind === "cost" ? (
          <span key={i} className={i < n ? "tiers__on" : "tiers__off"}>
            $
          </span>
        ) : (
          <svg
            key={i}
            className={`tiers__bolt ${i < n ? "tiers__on" : "tiers__off"}`}
            viewBox="0 0 8 12"
            aria-hidden="true"
          >
            <path d="M5 0L0 7h3l-1 5 6-7.5H4.6z" />
          </svg>
        ),
      )}
    </span>
  );
}

const COST_WORD = ["", "low", "medium", "high", "highest"];
const SPEED_WORD = ["", "slower", "medium", "fast"];

export function ModelList({
  models,
  value,
  onPick,
  caps,
  perPlan,
  ariaLabel = "Model",
}: {
  models: readonly ModelDescriptor[];
  value: string;
  onPick: (m: ModelDescriptor) => void;
  caps: Capabilities;
  /** Optional "≈ $0.05 per plan" text per model (Settings). */
  perPlan?: (m: ModelDescriptor) => string | null;
  ariaLabel?: string;
}) {
  const usable = models.filter((m) => m.status !== "unavailable");
  const curated = usable.filter((m) => m.guidance !== undefined);
  const other = usable.filter((m) => m.guidance === undefined);
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = usable.findIndex((m) => m.modelId === value);
    const next = usable[(i + (e.key === "ArrowDown" ? 1 : usable.length - 1)) % usable.length];
    if (next) {
      onPick(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-model="${next.modelId}"]`)?.focus();
    }
  };
  const row = (m: ModelDescriptor) => {
    const on = m.modelId === value;
    const extra = perPlan?.(m) ?? null;
    return (
      <div
        key={m.modelId}
        data-model={m.modelId}
        role="radio"
        aria-checked={on}
        tabIndex={on || (value === "" && m === usable[0]) ? 0 : -1}
        className={`mrow${on ? " mrow--on" : ""}`}
        onClick={() => {
          onPick(m);
        }}
        onKeyDown={(e) => {
          if (e.key === " " || e.key === "Enter") onPick(m);
        }}
      >
        <span className={`radio${on ? " radio--on" : ""}`} aria-hidden="true" />
        <span className="mrow__text">
          <span className="mrow__name">
            {shortModelName(m.modelId, models)}
            {m.status === "recommended" && <span className="rec">Recommended</span>}
            {m.status === "legacy" && <span className="tag">Legacy</span>}
          </span>
          <span className="mrow__desc">
            {(m.guidance ?? "No guidance yet").replace(/^Recommended\.\s*/, "")}
            {extra !== null && ` · ${extra}`}
          </span>
        </span>
        {caps.hasCost && m.costTier !== undefined && (
          <Tiers kind="cost" n={m.costTier} of={4} label={`Cost: ${COST_WORD[m.costTier] ?? ""}`} />
        )}
        {caps.hasSpeed && m.speedTier !== undefined && (
          <Tiers kind="speed" n={m.speedTier} of={3} label={`Speed: ${SPEED_WORD[m.speedTier] ?? ""}`} />
        )}
      </div>
    );
  };
  return (
    <div className="mlist" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKey}>
      {curated.map(row)}
      {other.length > 0 && (
        <>
          <div className="mlist__other eyebrow">Other models</div>
          {other.map(row)}
        </>
      )}
    </div>
  );
}

export function EffortControl({
  model,
  value,
  onChange,
  showNote = true,
  snappedFrom,
}: {
  model: ModelDescriptor | undefined;
  value: EffortLevel | null;
  onChange: (e: EffortLevel) => void;
  showNote?: boolean;
  /** Set when the chosen model doesn't offer the previous effort (shows the snap line). */
  snappedFrom?: EffortLevel | null;
}) {
  const levels = effortLevels(model);
  if (levels.length === 0) return null; // not applicable: the whole group disappears
  const cur = value !== null && levels.includes(value) ? value : null;
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const i = cur === null ? 0 : levels.indexOf(cur);
    const next = levels[Math.max(0, Math.min(levels.length - 1, i + (e.key === "ArrowRight" ? 1 : -1)))];
    if (next) {
      onChange(next);
      e.currentTarget.querySelector<HTMLElement>(`[data-effort="${next}"]`)?.focus();
    }
  };
  return (
    <div className="effort">
      <div className="segctl" role="radiogroup" aria-label="Effort" onKeyDown={onKey}>
        {levels.map((l) => (
          <button
            key={l}
            data-effort={l}
            role="radio"
            aria-checked={cur === l}
            tabIndex={cur === l || (cur === null && l === levels[0]) ? 0 : -1}
            title={`API: ${l}`}
            onClick={() => {
              onChange(l);
            }}
          >
            {EFFORT_LABEL[l]}
          </button>
        ))}
      </div>
      <div className="effscale" aria-hidden="true">
        <span>faster · cheaper</span>
        <span>slower · more careful</span>
      </div>
      {snappedFrom !== undefined && snappedFrom !== null && model && cur !== null && (
        <p className="effnote" role="status">
          {shortModelName(model.modelId, [model])} doesn't offer {EFFORT_LABEL[snappedFrom]} — using{" "}
          {EFFORT_LABEL[cur]}.
        </p>
      )}
      {showNote && cur !== null && (
        <p className="effnote">
          <b>{EFFORT_LABEL[cur]}</b> — {EFFORT_NOTE[cur]}
        </p>
      )}
    </div>
  );
}
