/** Brief card pinned at the top of chat (UX §5.1): expanded form in the brief phase, two-line summary later. */
import { useState } from "react";
import type { DesignBrief, MapPlan } from "@slabyrinth/core";
import { Icon } from "../../ui/Icon";
import { useApp } from "../../stores/app";
import { phaseOf, useProject } from "../../stores/project";
import { useChat } from "../../stores/chat";
import { call, errorMessage } from "../../bridge/client";

const SYSTEMS = [
  ["daggerheart", "Daggerheart"],
  ["dnd5e", "D&D 5e"],
  ["other", "Other"],
] as const;
const PRESETS = { small: [20, 20], medium: [40, 30], large: [80, 60] } as const;
const SYS_NAME: Record<string, string> = { daggerheart: "Daggerheart", dnd5e: "D&D 5e", other: "" };

/**
 * Two summary lines. Once a plan exists, its level count and size come from the plan (the brief only records what
 * was intended at the start and goes stale as the map changes); before that, the brief's intended values.
 */
export function briefSummary(b: DesignBrief, plan?: Pick<MapPlan, "levels"> | null): [string, string] {
  const sys = b.system ? (SYS_NAME[b.system.value] ?? "") : "";
  const party = b.party?.value;
  const partyText = party
    ? [
        party.tier !== undefined
          ? `Tier ${party.tier}`
          : party.level !== undefined
            ? `level ${party.level}`
            : "",
        party.size !== undefined ? `${party.size} PCs` : "",
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
  const line1 = [b.mapType?.value, [sys, partyText.replace(/ · /, " · ")].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(" · ");
  const fromPlan = plan && plan.levels.length > 0 ? plan.levels : null;
  let count = b.levels?.value.count;
  let size: [number, number] | undefined = b.footprint
    ? [b.footprint.value.widthSq, b.footprint.value.heightSq]
    : undefined;
  if (fromPlan) {
    count = fromPlan.length;
    const x0 = Math.min(...fromPlan.map((l) => l.bounds.x));
    const y0 = Math.min(...fromPlan.map((l) => l.bounds.y));
    const x1 = Math.max(...fromPlan.map((l) => l.bounds.x + l.bounds.w));
    const y1 = Math.max(...fromPlan.map((l) => l.bounds.y + l.bounds.h));
    size = [x1 - x0, y1 - y0];
  }
  const line2 = [
    count !== undefined ? `${count} level${count === 1 ? "" : "s"}` : "",
    size ? `${size[0]}×${size[1]} sq (${size[0] * 5}×${size[1] * 5} ft)` : "",
    b.tone?.value ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [line1, line2];
}

function AiMark({ f }: { f: { source: string } | undefined }) {
  if (f?.source !== "ai") return null;
  return (
    <span className="aitag" title="Filled in by Slabyrinth — your edits always win">
      AI
    </span>
  );
}

function TagList({
  items,
  onChange,
  label,
}: {
  items: string[];
  onChange: (v: string[]) => void;
  label: string;
}) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  return (
    <span className="taglist" role="group" aria-label={label}>
      {items.map((t) => (
        <span key={t} className="tag">
          {t}
          <button
            className="ref__x"
            aria-label={`Remove ${t}`}
            onClick={() => {
              onChange(items.filter((x) => x !== t));
            }}
          >
            <Icon name="x" size="xs" />
          </button>
        </span>
      ))}
      {adding ? (
        <input
          className="bfield bfield--tag"
          autoFocus
          aria-label={`Add to ${label}`}
          value={text}
          maxLength={40}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onBlur={() => {
            setAdding(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && text.trim() !== "") {
              onChange([...items, text.trim()]);
              setText("");
            } else if (e.key === "Escape") setAdding(false);
          }}
        />
      ) : (
        <button
          className="tag tag--add"
          onClick={() => {
            setAdding(true);
          }}
        >
          + add
        </button>
      )}
    </span>
  );
}

function TextField({
  value,
  onSave,
  label,
  max,
  wide,
}: {
  value: string;
  onSave: (v: string) => void;
  label: string;
  max: number;
  wide?: boolean;
}) {
  // Callers key this component by value, so an AI update re-seeds it (no effect needed).
  const [v, setV] = useState(value);
  return (
    <input
      className={`bfield${wide === true ? " bfield--wide" : ""}`}
      aria-label={label}
      value={v}
      maxLength={max}
      placeholder="—"
      onChange={(e) => {
        setV(e.target.value);
      }}
      onBlur={() => {
        if (v !== value) onSave(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
    />
  );
}

export function BriefCard() {
  const snap = useProject((s) => s.snap);
  const setBrief = useProject((s) => s.setBrief);
  const open = useApp((s) => s.briefOpen);
  const setOpen = useApp((s) => s.setBriefOpen);
  const [changedSince, setChangedSince] = useState<number | null>(null);
  if (!snap) return null;
  const b = snap.brief;
  const phase = phaseOf(snap);
  const expanded = open ?? phase === "brief";

  const save = async (set: Partial<Record<keyof DesignBrief, unknown>>): Promise<void> => {
    try {
      const next = await call("brief:update", { set });
      setBrief(next);
      if (snap.head > 0) setChangedSince(snap.head);
    } catch (e) {
      useApp.getState().toast({ lead: "Couldn't update the brief.", body: errorMessage(e), tone: "error" });
    }
  };

  const [line1, line2] = briefSummary(b, snap.plan);
  const sys = b.system?.value ?? null;
  const party = b.party?.value ?? {};
  const fp = b.footprint?.value;
  const lv = b.levels?.value;
  const optional = [!fp ? "footprint" : "", !b.party ? "party" : "", !b.tone ? "tone" : ""].filter(Boolean);

  return (
    <section className="brief" aria-label="Brief">
      <div className="brief__h">
        <span className="eyebrow">Brief</span>
        {expanded && <span className="brief__hint">fills in as we talk</span>}
        <span className="brief__sp" />
        {expanded ? (
          <button
            className="iconbtn iconbtn--sm"
            aria-label="Collapse brief (Ctrl+Shift+B)"
            aria-expanded="true"
            onClick={() => {
              setOpen(false);
            }}
          >
            <Icon name="up" size="sm" />
          </button>
        ) : (
          <button
            className="btn btn--ghost btn--sm"
            aria-expanded="false"
            onClick={() => {
              setOpen(true);
            }}
          >
            <Icon name="edit" size="sm" />
            Edit
          </button>
        )}
      </div>
      {!expanded ? (
        <button
          className="brief__sum"
          onClick={() => {
            setOpen(true);
          }}
        >
          {line1 === "" && line2 === "" ? (
            <span className="muted">Nothing agreed yet.</span>
          ) : (
            <>
              <strong>{line1}</strong>
              {line2 !== "" && <span className="brief__line2">{line2}</span>}
            </>
          )}
        </button>
      ) : (
        <dl className="brief__grid">
          <dt>Map type</dt>
          <dd>
            <TextField
              key={`tf-${b.mapType?.value ?? ""}-${b.tone?.value ?? ""}`}
              label="Map type"
              value={b.mapType?.value ?? ""}
              max={60}
              onSave={(v) => void save({ mapType: v === "" ? null : v })}
            />
            <AiMark f={b.mapType} />
          </dd>
          <dt>Game</dt>
          <dd>
            <span className="segctl segctl--xs" role="radiogroup" aria-label="Game system">
              {SYSTEMS.map(([v, l]) => (
                <button
                  key={v}
                  role="radio"
                  aria-checked={sys === v}
                  onClick={() => void save({ system: v })}
                >
                  {l}
                </button>
              ))}
            </span>
          </dd>
          <dt>Party</dt>
          <dd>
            {sys === "dnd5e" ? (
              <label className="bpair">
                Level
                <input
                  className="bfield bfield--num"
                  type="number"
                  min={1}
                  max={20}
                  aria-label="Party level"
                  defaultValue={party.level ?? ""}
                  onBlur={(e) =>
                    e.target.value !== "" && void save({ party: { ...party, level: Number(e.target.value) } })
                  }
                />
              </label>
            ) : (
              <span className="segctl segctl--xs" role="radiogroup" aria-label="Party tier">
                {[1, 2, 3, 4].map((t) => (
                  <button
                    key={t}
                    role="radio"
                    aria-checked={party.tier === t}
                    onClick={() => void save({ party: { ...party, tier: t } })}
                  >
                    Tier {t}
                  </button>
                ))}
              </span>
            )}
            <label className="bpair">
              <input
                className="bfield bfield--num"
                type="number"
                min={1}
                max={8}
                aria-label="Party size"
                defaultValue={party.size ?? ""}
                key={`size-${party.size ?? ""}`}
                onBlur={(e) =>
                  e.target.value !== "" && void save({ party: { ...party, size: Number(e.target.value) } })
                }
              />
              PCs
            </label>
            <AiMark f={b.party} />
          </dd>
          <dt>Footprint</dt>
          <dd>
            <select
              className="select"
              aria-label="Footprint"
              value={fp?.preset ?? ""}
              onChange={(e) => {
                const preset = e.target.value as keyof typeof PRESETS | "custom";
                const size = preset === "custom" ? [fp?.widthSq ?? 40, fp?.heightSq ?? 30] : PRESETS[preset];
                void save({ footprint: { preset, widthSq: size[0], heightSq: size[1] } });
              }}
            >
              <option value="" disabled>
                Choose…
              </option>
              <option value="small">Small · up to 20×20</option>
              <option value="medium">Medium · up to 40×40</option>
              <option value="large">Large · up to 80×80</option>
              <option value="custom">Custom</option>
            </select>
            {fp && (
              <span className="muted">
                {fp.widthSq}×{fp.heightSq} sq · {fp.widthSq * 5}×{fp.heightSq * 5} ft
              </span>
            )}
            <AiMark f={b.footprint} />
          </dd>
          <dt>Levels</dt>
          <dd>
            <span className="stepperctl" role="group" aria-label="Number of levels">
              <button
                className="iconbtn iconbtn--xs"
                aria-label="Fewer levels"
                disabled={(lv?.count ?? 1) <= 1}
                onClick={() =>
                  void save({
                    levels: {
                      count: (lv?.count ?? 1) - 1,
                      names: (lv?.names ?? []).slice(0, (lv?.count ?? 1) - 1),
                    },
                  })
                }
              >
                <Icon name="minus" size="xs" />
              </button>
              <span className="stepperctl__n">{lv?.count ?? 1}</span>
              <button
                className="iconbtn iconbtn--xs"
                aria-label="More levels"
                disabled={(lv?.count ?? 1) >= 6}
                onClick={() => void save({ levels: { count: (lv?.count ?? 1) + 1, names: lv?.names ?? [] } })}
              >
                <Icon name="plus" size="xs" />
              </button>
            </span>
            {(lv?.names ?? []).map((n) => (
              <span key={n} className="tag">
                {n}
              </span>
            ))}
            <AiMark f={b.levels} />
          </dd>
          <dt>Tone</dt>
          <dd>
            <TextField
              key={`tf-${b.mapType?.value ?? ""}-${b.tone?.value ?? ""}`}
              label="Tone"
              wide
              value={b.tone?.value ?? ""}
              max={80}
              onSave={(v) => void save({ tone: v === "" ? null : v })}
            />
            <AiMark f={b.tone} />
          </dd>
          <dt>Must include</dt>
          <dd>
            <TagList
              label="Must include"
              items={b.mustInclude?.value ?? []}
              onChange={(v) => void save({ mustInclude: v })}
            />
          </dd>
          <dt>Avoid</dt>
          <dd>
            <TagList label="Avoid" items={b.avoid?.value ?? []} onChange={(v) => void save({ avoid: v })} />
          </dd>
        </dl>
      )}
      {expanded && (
        <div className="brief__ready" role="status">
          {b.mapType ? (
            <span className="brief__ok">
              <Icon name="check" size="sm" />
              Ready to draw
            </span>
          ) : (
            <span>Tell me what kind of place it is first.</span>
          )}
          {optional.length > 0 && <span>· Optional: {optional.join(", ")}</span>}
        </div>
      )}
      {changedSince !== null && snap.head > 0 && (
        <div className="brief__changed">
          Brief changed since v{changedSince}. Ask Slabyrinth to apply it, or{" "}
          <button
            className="btn btn--link"
            onClick={() => {
              setChangedSince(null);
              void useChat
                .getState()
                .send({ text: "Please redraw the plan from the updated brief.", intent: "plan" });
            }}
          >
            redraw from brief
          </button>
          .
        </div>
      )}
    </section>
  );
}
