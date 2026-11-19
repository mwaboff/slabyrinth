/** Version history (UX §7.1–7.2): newest first; preview, compare, restore; undo/redo move the head pointer. */
import { Icon } from "../../ui/Icon";
import { useMap } from "../../stores/map";
import { useProject, versionCosts, type VersionRow } from "../../stores/project";
import { useChat } from "../../stores/chat";
import { money, relativeTime } from "../../lib/format";
import { redo, restoreVersion, undo } from "../../app/actions";
import { withRefs } from "../chat/RichText";
import type { ProjectSnapshot } from "../../../shared/ipc";

export interface HistoryRowModel {
  v: VersionRow;
  current: boolean;
  approved: boolean;
  built: boolean;
  undone: boolean;
}

/** Pure: rows newest first with pointer badges. */
export function historyRows(
  snap: Pick<ProjectSnapshot, "versions" | "head" | "undone" | "approvedVersion" | "builds">,
): HistoryRowModel[] {
  const built = new Set(snap.builds.map((b) => b.versionNumber));
  return [...snap.versions]
    .sort((a, b) => b.number - a.number)
    .map((v) => ({
      v,
      current: v.number === snap.head,
      approved: v.number === snap.approvedVersion,
      built: built.has(v.number),
      undone: snap.undone.includes(v.number),
    }));
}

/** Pure: can undo when the head has a parent; redo when an undone version's parent is the head (core semantics). */
export function pointerState(snap: Pick<ProjectSnapshot, "versions" | "head" | "undone">): {
  canUndo: boolean;
  canRedo: boolean;
  redoTo: number | null;
} {
  const head = snap.versions.find((v) => v.number === snap.head);
  const canUndo = head !== undefined && head.parentNumber !== 0;
  let redoTo: number | null = null;
  for (let i = snap.undone.length - 1; i >= 0; i--) {
    const n = snap.undone[i];
    if (snap.versions.find((v) => v.number === n)?.parentNumber === snap.head) {
      redoTo = n ?? null;
      break;
    }
  }
  return { canUndo, canRedo: redoTo !== null, redoTo };
}

const AUTHOR: Record<string, string> = { ai: "Slabyrinth", user: "You", restore: "Restore", system: "App" };

export function HistoryPanel() {
  const snap = useProject((s) => s.snap);
  const preview = useMap((s) => s.previewVersion);
  const setPreview = useMap((s) => s.preview);
  const setCompare = useMap((s) => s.setCompare);
  const close = useMap((s) => s.setHistory);
  const busy = useChat((s) => s.live !== null);
  if (!snap) return null;
  const rows = historyRows(snap);
  const costs = versionCosts(snap.versions, snap.conversation.items);
  const ptr = pointerState(snap);
  return (
    <aside className="key history" aria-label="Version history">
      <div className="key__h">
        <h3>
          History<small>{rows.length} versions</small>
        </h3>
        <button
          className="iconbtn iconbtn--sm"
          aria-label="Close history (H)"
          title="Close history (H)"
          onClick={() => {
            close(false);
          }}
        >
          <Icon name="x" />
        </button>
      </div>
      <div className="history__ptr">
        <button
          className="btn btn--sm"
          disabled={!ptr.canUndo || busy}
          onClick={() => void undo()}
          title="Undo plan change (Ctrl+Z)"
        >
          <Icon name="left" size="sm" />
          Undo
        </button>
        <button
          className="btn btn--sm"
          disabled={!ptr.canRedo || busy}
          onClick={() => void redo()}
          title="Redo (Ctrl+Y)"
        >
          Redo
          <Icon name="right" size="sm" />
        </button>
        <span className="muted">Nothing is ever deleted.</span>
      </div>
      <ol className="vlist">
        {rows.map(({ v, current, approved, built, undone }) => (
          <li
            key={v.number}
            className={`vrow${current ? " vrow--current" : ""}${preview === v.number ? " vrow--preview" : ""}${undone ? " vrow--undone" : ""}`}
          >
            <div className="vrow__h">
              <span className="vbadge">v{v.number}</span>
              <span className="vrow__sum">{withRefs(v.summary, `h${v.number}`)}</span>
            </div>
            <div className="vrow__meta">
              {AUTHOR[v.author] ?? v.author} · {relativeTime(v.createdAt)}
              {costs.has(v.number) ? ` · ${money(costs.get(v.number) ?? 0)}` : ""}
            </div>
            <div className="vrow__badges">
              {current && <span className="okpill">Current</span>}
              {approved && <span className="phase phase--plan">Approved</span>}
              {built && <span className="phase phase--build">Built</span>}
              {undone && <span className="tag">Undone</span>}
            </div>
            {!current && (
              <div className="vrow__actions">
                <button
                  className="btn btn--sm btn--ghost"
                  aria-pressed={preview === v.number}
                  onClick={() => {
                    setPreview(preview === v.number ? null : v.number);
                  }}
                >
                  <Icon name="eye" size="sm" />
                  {preview === v.number ? "Previewing" : "Preview"}
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  onClick={() => {
                    setCompare({ on: true, against: v.number });
                  }}
                >
                  <Icon name="compare" size="sm" />
                  Compare
                </button>
                <button
                  className="btn btn--sm btn--ghost"
                  disabled={busy}
                  onClick={() => void restoreVersion(v.number)}
                >
                  <Icon name="retry" size="sm" />
                  Restore
                </button>
              </div>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
