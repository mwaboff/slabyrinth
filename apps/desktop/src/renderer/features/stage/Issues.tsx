/**
 * Plan issues (playability sense-check, decisions.md): a count chip by the level tabs, a compact list grouped by
 * severity, map markers (MapView), the same list in the approve popover, and "Ask Claude to fix", which drops a
 * pre-filled message into the composer (never sends silently). The message is shown verbatim; the AI hint never is.
 * IssueList is generic so the Build screen's notes (compiler diagnostics) use the same component.
 */
import { useRef, type ReactNode } from "react";
import type { MapPlan } from "@slabyrinth/core";
import { Icon } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { emptySel, useMap, type Sel } from "../../stores/map";
import { useChat } from "../../stores/chat";
import { levelShort } from "../../stores/project";
import { cellName } from "../../lib/format";
import type { UiIssue } from "../../../shared/resolveCore";

export type Severity = "error" | "warning" | "info";

export interface ListItem {
  key: string;
  severity: Severity;
  message: string;
  where?: string;
  /** e.g. "auto-repaired" (compiler diagnostics). */
  tag?: string;
  onShow?: () => void;
  onFix?: () => void;
}

/** Severity glyph: shape + symbol, never colour alone (UX §13.3). */
export function SeverityMark({ s }: { s: Severity }) {
  return (
    <span
      className={`sev sev--${s}`}
      role="img"
      aria-label={s === "error" ? "Problem" : s === "warning" ? "Warning" : "Note"}
    >
      {s === "info" ? "i" : "!"}
    </span>
  );
}

function Row({ it }: { it: ListItem }) {
  return (
    <li className={`issue issue--${it.severity}`}>
      <SeverityMark s={it.severity} />
      <div className="issue__body">
        {it.onShow ? (
          <button className="issue__msg" onClick={it.onShow} title="Show on the map">
            {it.message}
          </button>
        ) : (
          <span className="issue__msg">{it.message}</span>
        )}
        {(it.where !== undefined || it.tag !== undefined) && (
          <span className="issue__where">
            {it.where}
            {it.tag !== undefined && <span className="tag">{it.tag}</span>}
          </span>
        )}
      </div>
      {it.onFix && (
        <button
          className="btn btn--ghost btn--sm issue__fix"
          onClick={it.onFix}
          title="Put a message for Claude in the composer"
        >
          Ask Claude to fix
        </button>
      )}
    </li>
  );
}

export function IssueList({
  items,
  labels = { error: "Must fix before approving", warning: "Worth a look", info: "Notes" },
  onFixAll,
  empty,
}: {
  items: readonly ListItem[];
  labels?: Record<Severity, string>;
  onFixAll?: () => void;
  empty?: ReactNode;
}) {
  const by = (s: Severity): ListItem[] => items.filter((i) => i.severity === s);
  const errors = by("error");
  const warnings = by("warning");
  const infos = by("info");
  if (items.length === 0) return empty !== undefined ? <>{empty}</> : null;
  return (
    <div className="issuelist">
      {errors.length > 0 && (
        <section aria-label={labels.error}>
          <h4 className="eyebrow issuelist__h">
            {labels.error} · {errors.length}
          </h4>
          <ul>
            {errors.map((it) => (
              <Row key={it.key} it={it} />
            ))}
          </ul>
        </section>
      )}
      {warnings.length > 0 && (
        <section aria-label={labels.warning}>
          <h4 className="eyebrow issuelist__h">
            {labels.warning} · {warnings.length}
          </h4>
          <ul>
            {warnings.map((it) => (
              <Row key={it.key} it={it} />
            ))}
          </ul>
        </section>
      )}
      {infos.length > 0 && (
        <details className="issuelist__notes">
          <summary className="eyebrow">
            {labels.info} · {infos.length}
          </summary>
          <ul>
            {infos.map((it) => (
              <Row key={it.key} it={it} />
            ))}
          </ul>
        </details>
      )}
      {onFixAll && errors.length + warnings.length > 1 && (
        <div className="issuelist__all">
          <button className="btn btn--sm" onClick={onFixAll}>
            <Icon name="at" size="sm" />
            Ask Claude to fix all
          </button>
        </div>
      )}
    </div>
  );
}

// ───────────── plan issues → list items ─────────────

function elementSel(plan: MapPlan, id: string | undefined): Sel {
  const s = emptySel();
  if (id === undefined) return s;
  for (const l of plan.levels) {
    if (l.areas.some((a) => a.id === id)) s.areaIds = [id];
    else if (l.features.some((f) => f.id === id)) s.featureIds = [id];
    else if (l.openings.some((o) => o.id === id)) s.openingIds = [id];
  }
  if (plan.links.some((k) => k.id === id)) s.linkIds = [id];
  return s;
}

/** Anything with a GM-facing message and an optional location: plan issues and compiler diagnostics alike. */
export type Locatable = Pick<UiIssue, "message" | "levelId" | "elementId"> & {
  cell?: readonly [number, number];
  /** AI-facing hint (end-of-turn summaries carry it): never shown, only passed on in the pre-filled request. */
  hint?: string;
};

export function issueWhere(plan: MapPlan, i: Locatable): string {
  const parts: string[] = [];
  const level = plan.levels.find((l) => l.id === i.levelId);
  if (level) parts.push(`${levelShort(plan, level.id)} ${level.name}`);
  if (i.cell && level) parts.push(cellName(i.cell[0] - level.bounds.x, i.cell[1] - level.bounds.y));
  return parts.join(" · ");
}

export function showIssue(plan: MapPlan, i: Locatable): void {
  const m = useMap.getState();
  m.setIssuesOpen(false);
  m.setTab("map");
  if (i.levelId !== undefined) m.setLevel(i.levelId);
  m.select(elementSel(plan, i.elementId));
  const cell = i.cell;
  if (cell) {
    // let the Map tab mount before centring
    setTimeout(
      () => window.dispatchEvent(new CustomEvent("slab:revealCell", { detail: [cell[0], cell[1]] })),
      60,
    );
  }
}

/** Drops a pre-filled request into the composer; the user reads it and sends it. */
export function askToFix(plan: MapPlan, issues: readonly Locatable[]): void {
  const chat = useChat.getState();
  const lines = issues.map(
    (i) =>
      `- ${i.message}${issueWhere(plan, i) !== "" ? ` (${issueWhere(plan, i)})` : ""}${i.hint !== undefined ? ` — suggested fix: ${i.hint}` : ""}`,
  );
  const text =
    issues.length === 1
      ? `Please fix this problem in the plan: ${lines[0]?.slice(2) ?? ""}`
      : `Please fix these problems in the plan:\n${lines.join("\n")}`;
  chat.setDraft(chat.draft.trim() === "" ? text : `${chat.draft.trim()}\n\n${text}`);
  for (const i of issues) {
    const level = plan.levels.find((l) => l.id === i.levelId);
    const a = level?.areas.find((x) => x.id === i.elementId);
    if (level && a)
      chat.addRef({
        type: "room",
        id: a.id,
        levelId: level.id,
        label: a.name ?? `Room ${a.key ?? ""}`,
        ...(a.key !== undefined ? { key: a.key } : {}),
      });
  }
  useMap.getState().setIssuesOpen(false);
  chat.focusComposer();
}

export function issueItems(plan: MapPlan, issues: readonly UiIssue[], withFix: boolean): ListItem[] {
  return issues.map((i, n) => {
    const it: ListItem = {
      key: `${i.code}-${i.elementId ?? ""}-${n}`,
      severity: i.severity,
      message: i.message,
      where: issueWhere(plan, i),
    };
    if (i.levelId !== undefined || i.elementId !== undefined)
      it.onShow = () => {
        showIssue(plan, i);
      };
    if (withFix && i.severity !== "info")
      it.onFix = () => {
        askToFix(plan, [i]);
      };
    return it;
  });
}

export function IssuesChip({ plan }: { plan: MapPlan }) {
  const issues = useMap((s) => s.issues);
  const open = useMap((s) => s.issuesOpen);
  const setOpen = useMap((s) => s.setIssuesOpen);
  const btn = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, pop],
    () => {
      setOpen(false);
    },
    btn,
  );
  const errors = issues.filter((i) => i.severity === "error").length;
  const warnings = issues.filter((i) => i.severity === "warning").length;
  if (errors + warnings === 0) return null; // quiet when the map is clean
  const actionable = issues.filter((i) => i.severity !== "info");
  return (
    <span className="toolwrap issueswrap">
      <button
        ref={btn}
        className={`issuechip${errors > 0 ? " issuechip--error" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Plan check: problems the party would run into"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <SeverityMark s={errors > 0 ? "error" : "warning"} />
        {[
          errors > 0 ? `${errors} problem${errors === 1 ? "" : "s"}` : "",
          warnings > 0 ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </button>
      {open && (
        <div ref={pop} className="popover issuespop" role="dialog" aria-label="Plan issues">
          <div className="issuespop__h">
            <span className="issuespop__t">Plan check</span>
            <span className="muted">Things the party would run into at the table.</span>
          </div>
          <IssueList
            items={issueItems(plan, issues, true)}
            onFixAll={() => {
              askToFix(plan, actionable);
            }}
          />
        </div>
      )}
    </span>
  );
}
