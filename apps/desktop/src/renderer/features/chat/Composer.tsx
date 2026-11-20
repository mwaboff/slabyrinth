/** Composer (UX §5.7) with reference chips, model & effort pill + popover (§5.8), estimate hint, spend warning. */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { useChat } from "../../stores/chat";
import { phaseOf, useProject } from "../../stores/project";
import { EFFORT_LABEL, shortModelName, useSettings } from "../../stores/settings";
import { useApp } from "../../stores/app";
import { call, errorMessage } from "../../bridge/client";
import { roundCost, roundSeconds, money } from "../../lib/format";
import { EffortControl, ModelList, capsOf, snapEffort } from "./ModelControls";
import { findRoomByKey } from "../stage/selectRoom";
import type { EffortLevel } from "../../../main/agent/provider/types";

function ModelPopover({
  onClose,
  anchor,
}: {
  onClose: () => void;
  anchor: React.RefObject<HTMLButtonElement | null>;
}) {
  const models = useSettings((s) => s.models);
  const providers = useSettings((s) => s.providers);
  const smart = useSettings((s) => s.settings?.smartEffort ?? true);
  const sel = useChat((s) => s.selection);
  const est = useChat((s) => s.estimate);
  const changeSelection = useChat((s) => s.changeSelection);
  const changeEffort = useChat((s) => s.changeEffort);
  const busy = useChat((s) => s.live !== null);
  const [snapped, setSnapped] = useState<EffortLevel | null>(null);
  const [switchNote, setSwitchNote] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(true, [ref, anchor], onClose, anchor);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.mrow[aria-checked="true"]')?.focus();
  }, []);
  if (!sel) return null;
  const provider = providers.find((p) => p.id === sel.providerId);
  const caps = capsOf(provider);
  const model = models.find((m) => m.modelId === sel.modelId);
  const pick = async (m: (typeof models)[number]): Promise<void> => {
    if (busy) return;
    const s = snapEffort(m, sel.effort);
    setSnapped(s.snapped ? sel.effort : null);
    const next = { providerId: m.providerId, modelId: m.modelId, effort: s.effort };
    try {
      const impact = m.modelId !== sel.modelId ? await call("chat:previewSwitch", { selection: next }) : null;
      setSwitchNote(impact?.messages[0] ?? null);
      await changeSelection(next);
    } catch (e) {
      useApp.getState().toast({ lead: "Couldn't switch model.", body: errorMessage(e), tone: "error" });
    }
  };
  return (
    <div
      ref={ref}
      className="popover modelpop"
      role="dialog"
      aria-label="Model and effort for your next message"
    >
      <h4 className="eyebrow modelpop__h">Model</h4>
      <ModelList models={models} value={sel.modelId} caps={caps} onPick={(m) => void pick(m)} />
      {switchNote !== null && <p className="modelpop__note">{switchNote}</p>}
      {model?.effort.supported === true && (
        <div className="modelpop__effort">
          <div className="modelpop__effh">
            <h4 className="eyebrow">Effort</h4>
            <span>How hard Claude thinks before answering</span>
          </div>
          <EffortControl
            model={model}
            value={sel.effort}
            snappedFrom={snapped}
            onChange={(e) => {
              setSnapped(null);
              if (!busy) void changeEffort(e);
            }}
          />
        </div>
      )}
      {smart && model?.effort.supported === true && (
        <p className="modelpop__smart">
          Smart effort is on: chat-only replies use Balanced to save cost.{" "}
          <button
            className="btn btn--link"
            onClick={() => {
              onClose();
              useApp.getState().openSettings("ai");
            }}
          >
            Defaults in Settings
          </button>
        </p>
      )}
      {(est?.costUsd !== null || est.seconds !== null) && est && (
        <div className="modelpop__est">
          <span>Next plan change on this setting</span>
          <b>
            {caps.hasCost && est.costUsd !== null ? `≈ ${roundCost(est.costUsd)}` : ""}
            {caps.hasCost && est.costUsd !== null && est.seconds !== null ? " · " : ""}
            {est.seconds !== null ? roundSeconds(est.seconds).replace("~", "about ") : ""}
          </b>
        </div>
      )}
      {busy && <p className="modelpop__note">Changes apply once the current reply finishes.</p>}
    </div>
  );
}

const PLACEHOLDER = {
  brief: "Describe the map you want…",
  plan: "Ask for changes — click a room to point at it…",
  build: "Ask for changes (you'll re-approve and rebuild)…",
};

export function Composer() {
  const snap = useProject((s) => s.snap);
  const draft = useChat((s) => s.draft);
  const setDraft = useChat((s) => s.setDraft);
  const refs = useChat((s) => s.refs);
  const addRef = useChat((s) => s.addRef);
  const removeRef = useChat((s) => s.removeRef);
  const live = useChat((s) => s.live);
  const inFlight = useChat((s) => s.inFlight);
  const sel = useChat((s) => s.selection);
  const est = useChat((s) => s.estimate);
  const setEstimate = useChat((s) => s.setEstimate);
  const answers = useChat((s) => s.answers);
  const focusTick = useChat((s) => s.focusTick);
  const send = useChat((s) => s.send);
  const stop = useChat((s) => s.stop);
  const models = useSettings((s) => s.models);
  const providers = useSettings((s) => s.providers);
  const settings = useSettings((s) => s.settings);
  const hasKey = useSettings((s) => s.secrets[sel?.providerId ?? "anthropic"]?.hasKey ?? true);
  const saveUi = useProject((s) => s.saveUi);
  const [popOpen, setPopOpen] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const pill = useRef<HTMLButtonElement>(null);
  const phase = phaseOf(snap);
  const caps = capsOf(providers.find((p) => p.id === sel?.providerId));

  useEffect(() => {
    if (focusTick > 0) ta.current?.focus();
  }, [focusTick]);
  useEffect(() => {
    const open = (): void => {
      setPopOpen(true);
    };
    window.addEventListener("slab:model", open);
    return () => {
      window.removeEventListener("slab:model", open);
    };
  }, []);
  // estimate (debounced)
  useEffect(() => {
    if (!sel) return;
    const t = setTimeout(() => {
      void call("chat:estimate", {
        text: draft,
        selection: sel,
        intent: phase === "brief" ? "chat" : "auto",
      }).then(
        (r) => {
          setEstimate({ costUsd: r.costUsd, seconds: r.seconds });
        },
        () => {
          setEstimate(null);
        },
      );
    }, 350);
    return () => {
      clearTimeout(t);
    };
  }, [draft, sel, phase, setEstimate]);
  useEffect(() => {
    saveUi({
      composerDraft: {
        text: draft,
        references: refs.map((r) => ({
          type: r.type === "room" ? "room" : r.type,
          id: r.id,
          levelId: r.levelId,
        })),
      },
    });
  }, [draft, refs, saveUi]);
  // grow to 8 lines, then scroll
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 23 * 8 + 4)}px`;
  }, [draft]);

  const model = models.find((m) => m.modelId === sel?.modelId);
  const effortShown = model?.effort.supported === true && sel?.effort !== null && sel?.effort !== undefined;
  const limit = settings?.spending.perActionWarnUsd ?? null;
  const estCost = est?.costUsd ?? null;
  const over = caps.hasCost && limit !== null && estCost !== null && estCost > limit;
  const picked = Object.keys(answers).length > 0;
  const canSend = live === null && !inFlight && hasKey && (draft.trim() !== "" || picked);

  const doSend = async (force = false): Promise<void> => {
    if (!canSend) return;
    if (over && !force) {
      setConfirm(estCost);
      return;
    }
    setConfirm(null);
    try {
      await send();
    } catch (e) {
      useApp.getState().toast({ lead: "Couldn't send.", body: errorMessage(e), tone: "error" });
    }
  };

  const onChange = (v: string): void => {
    // "#4 " becomes the chip for room 4 (UX §5.7)
    const m = /(^|\s)#([A-Za-z]?\d{1,3})\s$/.exec(v);
    if (m) {
      const r = findRoomByKey(m[2] ?? "");
      if (r) {
        addRef({ type: "room", id: r.areaId, levelId: r.levelId, label: r.name, key: m[2] ?? "" });
        setDraft(v.slice(0, v.length - (m[0].length - (m[1] ?? "").length)));
        return;
      }
    }
    setDraft(v);
  };

  const hint = (): string => {
    if (!est) return "";
    const parts: string[] = [];
    if (caps.hasCost && est.costUsd !== null) parts.push(`~${roundCost(est.costUsd).replace("$", "$")}`);
    if (est.seconds !== null) parts.push(roundSeconds(est.seconds));
    return parts.join(" · ").replace("~< ", "< ");
  };

  return (
    <div className="composer">
      {popOpen && (
        <ModelPopover
          anchor={pill}
          onClose={() => {
            setPopOpen(false);
          }}
        />
      )}
      {confirm !== null && limit !== null && (
        <div className="popover spendpop" role="alertdialog" aria-label="Spend warning">
          <p>
            <b>This will cost about {money(confirm)}.</b> That's over your {money(limit)} per-action limit.
          </p>
          <div className="card-actions">
            <button className="btn btn--sm btn--primary" autoFocus onClick={() => void doSend(true)}>
              Send
            </button>
            <button
              className="btn btn--sm"
              onClick={() => {
                setConfirm(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn btn--sm btn--ghost"
              onClick={() => {
                useApp.getState().openSettings("spending");
              }}
            >
              Change limit
            </button>
          </div>
        </div>
      )}
      <div className={`cbox${!hasKey ? " cbox--disabled" : ""}`}>
        {refs.length > 0 && (
          <div className="crefs" aria-label="References">
            {refs.map((r) => (
              <span key={r.id} className="ref">
                {r.key !== undefined && <span className="badge">{r.key}</span>}
                {r.label}
                <button
                  className="ref__x"
                  aria-label={`Remove reference to ${r.label}`}
                  onClick={() => {
                    removeRef(r.id);
                  }}
                >
                  <Icon name="x" size="xs" />
                </button>
              </span>
            ))}
          </div>
        )}
        <label className="sr-only" htmlFor="composer-text">
          Message Slabyrinth
        </label>
        <textarea
          id="composer-text"
          ref={ta}
          className="ctext"
          rows={2}
          value={draft}
          disabled={!hasKey}
          placeholder={hasKey ? PLACEHOLDER[phase] : "Add your API key to start chatting."}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void doSend();
            } else if (e.key === "Escape" && live) {
              e.preventDefault();
              void stop();
            } else if (e.key === "Backspace" && draft === "" && refs.length > 0) {
              const lastRef = refs.at(-1);
              if (lastRef) removeRef(lastRef.id);
            }
          }}
        />
        <div className="cfoot">
          {sel && (
            <button
              ref={pill}
              className={`pill${model === undefined ? " pill--warn" : ""}`}
              aria-haspopup="dialog"
              aria-expanded={popOpen}
              title="Model and effort for your next message (Ctrl+M)"
              onClick={() => {
                setPopOpen(!popOpen);
              }}
            >
              <span className="pill__diamond" aria-hidden="true" />
              {shortModelName(sel.modelId, models)}
              {effortShown && <span className="pill__eff">· {EFFORT_LABEL[sel.effort ?? ""]}</span>}
              <Icon name="down" size="xs" />
            </button>
          )}
          <span
            className={`hint${over ? " hint--warn" : ""}`}
            title="Estimate based on your recent turns. Actual cost appears on each reply."
          >
            {live ? "You can keep typing; send when the reply finishes." : hint()}
          </span>
          {live ? (
            <button
              className="send send--stop"
              aria-label="Stop (Esc)"
              title="Stop the reply (Esc)"
              onClick={() => void stop()}
            >
              <Icon name="stop" />
              <span className="send__label">Stop</span>
            </button>
          ) : (
            <button
              className="send"
              aria-label="Send (Enter)"
              title="Send (Enter)"
              disabled={!canSend}
              onClick={() => void doSend()}
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
