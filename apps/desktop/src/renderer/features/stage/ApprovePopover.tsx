/**
 * The approve popover (UX §7.5). What blocks approval is core's `planGate(issues, "approve")`, the same call main's
 * `plan:approve` makes, so the popover never offers an approval main then refuses (an `unreachable` warning blocks).
 */
import { useEffect, useRef, useState } from "react";
import { planGate } from "@slabyrinth/core/plan";
import { useDismiss } from "../../ui/dismiss";
import { useMap } from "../../stores/map";
import { roomCount, useProject } from "../../stores/project";
import { useChat } from "../../stores/chat";
import { tryCall } from "../../bridge/client";
import { slabEstimate } from "../../lib/format";
import { approve } from "../../app/actions";
import { IssueList, askToFix, issueItems } from "./Issues";

export function ApprovePopover({
  version,
  anchor,
}: {
  version: number;
  anchor: React.RefObject<HTMLButtonElement | null>;
}) {
  const snap = useProject((s) => s.snap);
  const ref = useRef<HTMLDivElement>(null);
  const [est, setEst] = useState<number | null>(null);
  const [checks, setChecks] = useState<{ blocking: string[]; warnings: string[] } | null>(null);
  const issues = useMap((s) => s.issues);
  const close = (): void => {
    useMap.getState().setApprove(false);
  };
  useDismiss(true, [ref, anchor], close, anchor);
  useEffect(() => {
    void tryCall("compile:estimate", {}).then((r) => {
      if (r.ok) setEst(r.value.estimatedChunks);
    });
    ref.current?.querySelector<HTMLButtonElement>(".btn--primary")?.focus();
  }, []);
  if (!snap?.plan) return null;
  const rooms = roomCount(snap.plan);
  const plan = snap.plan;
  const gate = planGate(issues, "approve");
  const blocking = new Set(gate.blocking);
  const blocked = blocking.size > 0;
  const actionable = issues.filter((i) => i.severity !== "info");
  // a finding that blocks approval is listed as blocking whatever its severity
  const items = issueItems(plan, issues, true).map((it, n) => {
    const i = issues[n];
    return i !== undefined && blocking.has(i) ? { ...it, severity: "error" as const } : it;
  });
  const go = async (build: boolean): Promise<void> => {
    const r = await approve(version, build);
    if (r) setChecks(r);
  };
  return (
    <div ref={ref} className="popover approvepop" role="dialog" aria-label={`Approve v${version}`}>
      <h3>Approve v{version} for building?</h3>
      <p>
        {snap.plan.levels.length} level{snap.plan.levels.length === 1 ? "" : "s"} · {rooms} rooms ·{" "}
        {est === null ? "estimating the slab size…" : slabEstimate(est)}.
      </p>
      <p className="muted">You can still change the plan afterwards; you'll just approve and rebuild.</p>
      {actionable.length > 0 && (
        <div className="approvepop__list">
          <p className={blocked ? "approvepop__block" : "muted"}>
            {blocked
              ? "Fix the problems below before approving — the party couldn't get through as drawn."
              : "These warnings can be approved anyway."}
          </p>
          <IssueList
            items={items}
            labels={{ error: "Blocking", warning: "Warnings", info: "Notes" }}
            onFixAll={() => {
              close();
              askToFix(plan, actionable);
            }}
          />
        </div>
      )}
      {checks && checks.blocking.length > 0 && (
        <div className="approvepop__issues" role="alert">
          <b>Fix these first:</b>
          <ul>
            {checks.blocking.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
          <button
            className="btn btn--sm"
            onClick={() => {
              // pre-fill the composer; never send silently
              close();
              useChat
                .getState()
                .setDraft(
                  `Please fix these problems before I approve:\n${checks.blocking.map((b) => `- ${b}`).join("\n")}`,
                );
              useChat.getState().focusComposer();
            }}
          >
            Ask Claude to fix
          </button>
        </div>
      )}
      <div className="card-actions">
        <button className="btn btn--primary btn--sm" disabled={blocked} onClick={() => void go(true)}>
          Approve & build
        </button>
        <button className="btn btn--sm" disabled={blocked} onClick={() => void go(false)}>
          Approve only
        </button>
        <button className="btn btn--sm btn--ghost" onClick={close}>
          Cancel
        </button>
      </div>
    </div>
  );
}
