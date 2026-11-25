/** Chat thread (UX §5.2–5.6): messages, question cards, plan update cards, build card, system lines, live stream, errors. */
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PlanDiff } from "@slabyrinth/core";
import type { AppError, OutstandingIssues, ProjectSnapshot } from "../../../shared/ipc";
import type { ChatMessageMeta } from "../../../shared/project";
import type { ChatItem, ModelSelection } from "../../../main/agent/provider/types";
import { Icon, Mark } from "../../ui/Icon";
import { useDismiss } from "../../ui/dismiss";
import { useChat } from "../../stores/chat";
import { answersFor, pendingQuestions, type Question, type TurnState } from "../../stores/chatReducer";
import { useProject, latestBuild, versionCosts, type VersionRow } from "../../stores/project";
import { EFFORT_LABEL, shortModelName, useSettings } from "../../stores/settings";
import { useMap } from "../../stores/map";
import { useApp } from "../../stores/app";
import { tryCall } from "../../bridge/client";
import { duration, money, relativeTime } from "../../lib/format";
import { approve, run, undo } from "../../app/actions";
import { RichText, withRefs } from "./RichText";
import { STARTERS } from "./starters";
import { RevisionLimitCard } from "./RevisionLimitCard";
import { WorkingCard } from "./WorkingCard";
import { selectRoom } from "../stage/selectRoom";
import {
  IssueList,
  SeverityMark,
  askToFix,
  issueWhere,
  showIssue,
  type ListItem,
  type Locatable,
} from "../stage/Issues";

// ───────────── helpers ─────────────

function metaLine(
  m: ChatMessageMeta | undefined,
  models: Parameters<typeof shortModelName>[1],
): string | null {
  if (!m) return null;
  const parts = [shortModelName(m.servedBy.modelId, models)];
  if (m.effortUsed) parts.push(EFFORT_LABEL[m.effortUsed] ?? m.effortUsed);
  parts.push(duration(m.durationMs));
  if (m.cost) parts.push(money(m.cost.amount));
  return parts.join(" · ");
}

const diffCache = new Map<string, Promise<PlanDiff | null>>();
function useDiff(from: number, to: number, projectId: string): PlanDiff | null {
  const key = `${projectId}:${from}:${to}`;
  const [d, setD] = useState<{ key: string; diff: PlanDiff | null } | null>(null);
  useEffect(() => {
    if (from <= 0) return;
    let p = diffCache.get(key);
    if (!p) {
      p = tryCall("plan:diff", { from, to }).then((r) => (r.ok ? r.value : null));
      diffCache.set(key, p);
    }
    let alive = true;
    void p.then((v) => {
      if (alive) setD({ key, diff: v });
    });
    return () => {
      alive = false;
    };
  }, [from, to, projectId, key]);
  return d?.key === key ? d.diff : null;
}

// ───────────── cards ─────────────

/**
 * End-of-turn summary (ChatEvent turn_finished/turn_failed .outstandingIssues): what the plan check still finds
 * after a turn that changed the plan. Hidden once the head moves past that version or the current head is clean.
 * Messages are shown verbatim; hints only travel inside the pre-filled "Ask Claude to fix" request.
 */
function OutstandingSummary({ o }: { o: OutstandingIssues }) {
  const snap = useProject((s) => s.snap);
  const headIssues = useMap((s) => s.issues);
  if (!snap?.plan || snap.head !== o.version) return null;
  if (!headIssues.some((i) => i.severity !== "info")) return null;
  const plan = snap.plan;
  const n = o.errors + o.warnings;
  const locs = o.items.map((i) => {
    const l: Locatable = { message: i.message };
    if (i.levelId !== undefined) l.levelId = i.levelId;
    if (i.elementId !== undefined) l.elementId = i.elementId;
    if (i.cell) l.cell = i.cell;
    if (i.hint !== undefined) l.hint = i.hint;
    return l;
  });
  const items: ListItem[] = o.items.map((i, k) => {
    const loc = locs[k] as Locatable;
    const it: ListItem = {
      key: `${i.code}-${k}`,
      severity: i.severity,
      message: i.message,
      where: issueWhere(plan, loc),
    };
    if (i.levelId !== undefined || i.cell)
      it.onShow = () => {
        showIssue(plan, loc);
      };
    it.onFix = () => {
      askToFix(plan, [loc]);
    };
    return it;
  });
  return (
    <div className="msg-ai">
      <span aria-hidden="true" />
      <div className="card outstanding" role="status">
        <div className="upd__h">
          <SeverityMark s={o.errors > 0 ? "error" : "warning"} />
          <span className="upd__t">
            {n} issue{n === 1 ? "" : "s"} remain{n === 1 ? "s" : ""} in v{o.version}
            {o.errors > 0 ? ` · ${o.errors} must be fixed before approving` : ""}
          </span>
        </div>
        <IssueList items={items} labels={{ error: "Problems", warning: "Warnings", info: "Notes" }} />
        <div className="card-actions">
          <button
            className="btn btn--sm"
            onClick={() => {
              askToFix(plan, locs);
            }}
          >
            <Icon name="at" size="sm" />
            Ask Claude to fix {n === 1 ? "it" : "these"}
          </button>
        </div>
      </div>
    </div>
  );
}

function PlanUpdateCard({ v, meta }: { v: VersionRow; meta: ChatMessageMeta | undefined }) {
  const snap = useProject((s) => s.snap);
  const diff = useDiff(v.parentNumber, v.number, snap?.projectId ?? "");
  if (!snap) return null;
  const cost = versionCosts(snap.versions, snap.conversation.items).get(v.number);
  const latest = snap.versions.at(-1)?.number === v.number && snap.head === v.number;
  const areaIds = diff ? [...diff.areas.added, ...diff.areas.changed] : [];
  const showOnMap = (): void => {
    const plan = snap.plan;
    const level = plan?.levels.find((l) => l.areas.some((a) => areaIds.includes(a.id)));
    const m = useMap.getState();
    m.setTab("map");
    if (level) m.setLevel(level.id);
    m.pulseRooms(areaIds);
  };
  return (
    <div className="card upd">
      <div className="upd__h">
        <span className="vbadge">v{v.number}</span>
        <span className="upd__t">{withRefs(v.summary, `s${v.number}`)}</span>
        <span className="upd__m">
          {meta ? duration(meta.durationMs) : ""}
          {cost !== undefined ? ` · ${money(cost)}` : ""}
        </span>
      </div>
      {v.changeSummary.length > 0 && (
        <ul>
          {v.changeSummary.map((c, i) => (
            <li key={i}>{withRefs(c, `c${v.number}-${i}`)}</li>
          ))}
        </ul>
      )}
      {diff && (
        <div className="upd__count">
          {diff.areas.added.length} added · {diff.areas.changed.length} changed · {diff.areas.removed.length}{" "}
          removed
        </div>
      )}
      <div className="card-actions">
        <button className="btn btn--sm" onClick={showOnMap}>
          Show on map
        </button>
        {v.parentNumber > 0 && (
          <button
            className="btn btn--sm"
            onClick={() => {
              useMap.getState().setTab("map");
              useMap.getState().setCompare({ on: true, against: v.parentNumber });
            }}
          >
            <Icon name="compare" size="sm" />
            Compare with v{v.parentNumber}
          </button>
        )}
        {latest && v.parentNumber > 0 && (
          <button className="btn btn--sm btn--ghost" onClick={() => void undo()}>
            <Icon name="retry" size="sm" />
            Undo
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionCard({ callId, questions, live }: { callId: string; questions: Question[]; live: boolean }) {
  const items = useChat((s) => s.items);
  const answers = useChat((s) => s.answers);
  const pick = useChat((s) => s.pickAnswer);
  const send = useChat((s) => s.send);
  const busy = useChat((s) => s.live !== null);
  const given = answersFor(items, callId);
  if (given !== null) {
    const text = questions.map((q) => {
      const a = given.find((x) => x.id === q.id)?.answer ?? null;
      return a === null || a === "you_decide" ? `You decide (${q.text.replace(/\?$/, "").toLowerCase()})` : a;
    });
    return (
      <div className="answered">
        <Icon name="check" size="sm" /> Answered: {text.join(" · ")}
      </div>
    );
  }
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement)) void send();
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const chips = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".chip")];
      const i = chips.indexOf(document.activeElement as HTMLButtonElement);
      if (i < 0) return;
      e.preventDefault();
      chips[(i + (e.key === "ArrowRight" ? 1 : chips.length - 1)) % chips.length]?.focus();
    }
  };
  return (
    <div className="card qcard" role="group" aria-label="Clarifying questions" onKeyDown={onKey}>
      {questions.map((q) => (
        <div key={q.id} className="q">
          <div className="q__t" id={`q-${callId}-${q.id}`}>
            {q.text} <span>I'll assume {q.default}.</span>
          </div>
          <div className="chips" role="group" aria-labelledby={`q-${callId}-${q.id}`}>
            {[...q.options, null].map((o) => {
              const on = q.id in answers && answers[q.id] === o;
              return (
                <button
                  key={o ?? "_you"}
                  className={`chip${o === null ? " chip--ghost" : ""}`}
                  aria-pressed={on}
                  onClick={() => {
                    pick(q.id, o);
                  }}
                >
                  {on && <Icon name="check" size="sm" />}
                  {o ?? "You decide"}
                </button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="card-actions">
        <button className="btn btn--primary btn--sm" disabled={busy || live} onClick={() => void send()}>
          Send answers
        </button>
        <button
          className="btn btn--ghost btn--sm"
          disabled={busy || live}
          onClick={() => void send({ text: "Skip the questions — draw it now.", intent: "plan" })}
        >
          Skip — draw it now
        </button>
      </div>
    </div>
  );
}

function BuildCard({ version, slabs, at }: { version: number; slabs: number; at: string }) {
  return (
    <div className="msg-ai">
      <Mark size={24} className="avatar" />
      <div className="card buildcard">
        <div className="upd__h">
          <span className="okpill">
            <Icon name="check" size="xs" />
            Built
          </span>
          <span className="upd__t">
            v{version} · {slabs === 1 ? "one slab" : `${slabs} slabs`}
          </span>
          <span className="upd__m">{relativeTime(at)} · no API cost</span>
        </div>
        <p className="buildcard__p">
          Ready for TaleSpire.{" "}
          {slabs === 1
            ? "Copy the slab and paste it with Ctrl+V."
            : "The paste checklist copies each slab in order."}
        </p>
        <div className="card-actions">
          <button
            className="btn btn--sm"
            onClick={() => {
              useMap.getState().setTab("build");
            }}
          >
            Open build
          </button>
        </div>
      </div>
    </div>
  );
}

function errorCopy(err: AppError): {
  title: string;
  body: string;
  actions: Array<"retry" | "settings" | "switch" | "console" | "repair">;
} {
  const k = err.provider?.kind;
  if (err.code === "no_api_key")
    return {
      title: "Add your Anthropic API key to start.",
      body: "Slabyrinth uses your own key; it stays on this computer.",
      actions: ["settings"],
    };
  if (k === "auth")
    return {
      title: "Your API key was rejected.",
      body: "It may have been revoked or mistyped. Your message is kept — fix the key and press Retry.",
      actions: ["settings", "retry"],
    };
  if (k === "rate_limit" || k === "overloaded")
    return {
      title: "Anthropic is busy.",
      body: "Try again in a minute, or switch model.",
      actions: ["retry", "switch"],
    };
  if (k === "permission")
    return {
      title: "Your Anthropic account can't make requests right now.",
      body: "This usually means credit has run out.",
      actions: ["console", "retry"],
    };
  if (k === "network" || k === "timeout")
    return { title: "Connection lost while drafting.", body: "Nothing was changed.", actions: ["retry"] };
  if (k === "malformed_output")
    return {
      title: "That plan came back incomplete, so I didn't apply it.",
      body: "Your map is unchanged. Very large maps cause this — try again, or ask for one level at a time.",
      actions: ["retry", "repair"],
    };
  if (k === "not_found")
    return {
      title: "That model is no longer available on your key.",
      body: "Pick another model to continue; your project is unchanged.",
      actions: ["switch"],
    };
  return { title: "Something went wrong with that reply.", body: "Nothing was changed.", actions: ["retry"] };
}

function ErrorCard({ turn }: { turn: TurnState }) {
  const [details, setDetails] = useState(false);
  const retry = useChat((s) => s.retry);
  if (!turn.error) return null;
  const c = errorCopy(turn.error);
  const p = turn.error.provider;
  return (
    <div className="card errcard" role="alert">
      <div className="upd__h">
        <Icon name="error" className="errcard__icon" />
        <span className="upd__t">{c.title}</span>
      </div>
      <p className="errcard__body">{c.body}</p>
      {details && (
        <pre className="errcard__details">
          {[
            p?.httpStatus !== undefined ? `HTTP ${p.httpStatus}` : null,
            p?.requestId !== undefined ? `Request ${p.requestId}` : null,
            turn.error.message,
          ]
            .filter(Boolean)
            .join("\n")}
        </pre>
      )}
      <div className="card-actions">
        {c.actions.includes("retry") && turn.canRetry && (
          <button className="btn btn--sm" onClick={() => void retry()}>
            <Icon name="retry" size="sm" />
            Retry
          </button>
        )}
        {c.actions.includes("settings") && (
          <button
            className="btn btn--sm"
            onClick={() => {
              useApp.getState().openSettings("ai");
            }}
          >
            Open settings
          </button>
        )}
        {c.actions.includes("switch") && (
          <button className="btn btn--sm" onClick={() => window.dispatchEvent(new CustomEvent("slab:model"))}>
            Switch model
          </button>
        )}
        {c.actions.includes("console") && (
          <button
            className="btn btn--sm"
            onClick={() =>
              void run(
                "shell:openExternal",
                { url: "https://console.anthropic.com" },
                "Couldn't open the page.",
              )
            }
          >
            Open Anthropic Console
          </button>
        )}
        <button
          className="btn btn--sm btn--ghost"
          aria-expanded={details}
          onClick={() => {
            setDetails(!details);
          }}
        >
          Details {details ? "▾" : "▸"}
        </button>
        {details && (
          <button
            className="btn btn--sm btn--ghost"
            onClick={() =>
              void run(
                "clipboard:writeText",
                { text: `${turn.error?.message ?? ""} ${p?.requestId ?? ""}` },
                "Couldn't copy.",
              )
            }
          >
            Copy details
          </button>
        )}
      </div>
    </div>
  );
}

function RetryMenu({ itemText }: { itemText: string }) {
  const [open, setOpen] = useState(false);
  const models = useSettings((s) => s.models);
  const sel = useChat((s) => s.selection);
  const retry = useChat((s) => s.retry);
  const busy = useChat((s) => s.live !== null || s.inFlight);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismiss(
    open,
    [btn, menu],
    () => {
      setOpen(false);
    },
    btn,
  );
  const options: ModelSelection[] = models.flatMap((m) =>
    (m.effort.supported
      ? (["medium", "high", "xhigh"] as const).filter(
          (e) => m.effort.supported && m.effort.levels.includes(e),
        )
      : [null]
    ).map((effort) => ({ providerId: m.providerId, modelId: m.modelId, effort })),
  );
  return (
    <span className="msgtools">
      <button className="btn btn--ghost btn--sm" disabled={busy} onClick={() => void retry()}>
        <Icon name="retry" size="sm" />
        Retry
      </button>
      <button
        ref={btn}
        className="iconbtn iconbtn--sm"
        aria-label="Retry with another model or effort"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon name="down" size="sm" />
      </button>
      <button
        className="btn btn--ghost btn--sm"
        onClick={() =>
          void run("clipboard:writeText", { text: itemText }, "Couldn't copy.", () => {
            useApp.getState().toast({ lead: "Copied the reply." });
          })
        }
      >
        <Icon name="copy" size="sm" />
        Copy text
      </button>
      {open && (
        <div ref={menu} className="menu msgtools__menu" role="menu">
          <div className="menu__head eyebrow">Retry with…</div>
          {options.map((o) => (
            <button
              key={`${o.modelId}-${o.effort ?? "x"}`}
              role="menuitem"
              className="menu__item"
              onClick={() => {
                setOpen(false);
                void retry(o);
              }}
            >
              {shortModelName(o.modelId, models)}
              {o.effort ? ` · ${EFFORT_LABEL[o.effort] ?? ""}` : ""}
              {sel?.modelId === o.modelId && sel.effort === o.effort && (
                <span className="menu__accel">current</span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

// ───────────── thread model ─────────────

type Entry =
  | { kind: "user"; item: Extract<ChatItem, { type: "user" }> }
  | { kind: "ai"; items: Array<Extract<ChatItem, { type: "assistant" }>>; turnId: string }
  | { kind: "sys"; id: string; text: ReactNode }
  | { kind: "build"; id: string; version: number; slabs: number; at: string }
  | { kind: "recap"; id: string };

export function buildEntries(
  items: readonly ChatItem[],
  versions: readonly VersionRow[],
  builds: ProjectSnapshot["builds"],
  models: Parameters<typeof shortModelName>[1],
): Entry[] {
  type Timed = { at: string; order: number; e: Entry };
  const out: Timed[] = [];
  let order = 0;
  for (const it of items) {
    if (it.type === "user" && it.text.trim() === "" && (it.selection?.areaIds.length ?? 0) === 0) continue; // answers-only turn: the Question card shows them
    if (it.type === "user") out.push({ at: it.createdAt, order: order++, e: { kind: "user", item: it } });
    else if (it.type === "assistant") {
      const prev = out.at(-1);
      if (prev?.e.kind === "ai" && prev.e.turnId === it.turnId) prev.e.items.push(it);
      else out.push({ at: it.createdAt, order: order++, e: { kind: "ai", items: [it], turnId: it.turnId } });
    } else if (it.type === "marker") {
      const sel = it.selection;
      out.push({
        at: it.createdAt,
        order: order++,
        e: {
          kind: "sys",
          id: it.id,
          text: `Now using ${shortModelName(sel.modelId, models)}${sel.effort ? ` · ${EFFORT_LABEL[sel.effort] ?? ""}` : ""}`,
        },
      });
    }
  }
  // The transcript keeps its own order (timestamps of items in one turn can tie or interleave); system lines for
  // user edits/restores and build cards are slotted in by time.
  const extras: Timed[] = [];
  for (const v of versions) {
    if (v.author === "ai") continue;
    const text = v.causeType === "restore" ? `${v.summary} as v${v.number}` : `${v.summary} · v${v.number}`;
    extras.push({
      at: v.createdAt,
      order: order++,
      e: { kind: "sys", id: `v${v.number}`, text: withRefs(text, `sv${v.number}`) },
    });
  }
  for (const b of builds) {
    const slabs = new Set(b.levels.flatMap((l) => l.chunks.map((c) => c.id))).size;
    extras.push({
      at: b.createdAt,
      order: order++,
      e: { kind: "build", id: b.id, version: b.versionNumber, slabs, at: b.createdAt },
    });
  }
  extras.sort((a, b) => a.at.localeCompare(b.at) || a.order - b.order);
  const merged: Entry[] = [];
  let k = 0;
  for (const t of out) {
    while (k < extras.length && (extras[k] as Timed).at < t.at) merged.push((extras[k++] as Timed).e);
    merged.push(t.e);
  }
  while (k < extras.length) merged.push((extras[k++] as Timed).e);
  return merged;
}

function AiMessage({
  items,
  isLastTurn,
}: {
  items: Array<Extract<ChatItem, { type: "assistant" }>>;
  isLastTurn: boolean;
}) {
  const snap = useProject((s) => s.snap);
  const meta = useChat((s) => s.meta);
  const models = useSettings((s) => s.models);
  const allItems = useChat((s) => s.items);
  const live = useChat((s) => s.live);
  const lastTurn = useChat((s) => s.last);
  if (!snap) return null;
  const last = items.at(-1);
  const m = last ? meta[last.id] : undefined;
  const stopped = items.some((i) => i.stopReason === "cancelled") || m?.status === "stopped";
  const pq = pendingQuestions(allItems);
  const blocks: ReactNode[] = [];
  const texts: string[] = [];
  for (const it of items) {
    for (const [pi, p] of it.parts.entries()) {
      const key = `${it.id}-${pi}`;
      if (p.type === "text" && p.text.trim() !== "") {
        // the same intro text is repeated in the step's final item; show each distinct block once
        if (texts.includes(p.text)) continue;
        texts.push(p.text);
        blocks.push(
          <div key={key} className="msg-ai__text">
            <RichText text={p.text} />
          </div>,
        );
      } else if (p.type === "tool_call" && p.name === "ask_questions") {
        const qs = (p.input as { questions?: Question[] } | null)?.questions ?? [];
        blocks.push(
          <QuestionCard
            key={key}
            callId={p.callId}
            questions={qs}
            live={live !== null && pq?.callId !== p.callId}
          />,
        );
      } else if (p.type === "tool_call" && (p.name === "create_plan" || p.name === "edit_plan")) {
        for (const v of snap.versions.filter((x) => x.messageId === it.id))
          blocks.push(<PlanUpdateCard key={`${key}-v${v.number}`} v={v} meta={m} />);
      } else if (p.type === "tool_call" && p.name === "update_brief") {
        const set = (p.input as { set?: Record<string, unknown> } | null)?.set ?? {};
        const names = Object.keys(set).map(
          (k) =>
            ({
              mapType: "Map type",
              system: "Game",
              party: "Party",
              footprint: "Footprint",
              levels: "Levels",
              tone: "Tone",
              mustInclude: "Must include",
              avoid: "Avoid",
              theme: "Theme",
            })[k] ?? k,
        );
        if (names.length > 0)
          blocks.push(
            <div key={key} className="briefnote">
              Brief updated: {names.join(", ")}
            </div>,
          );
      } else if (p.type === "notice") {
        blocks.push(
          <div key={key} className="notice">
            {p.text}
          </div>,
        );
      }
    }
  }
  const line = metaLine(m, models);
  return (
    <div className="msg-ai">
      <Mark size={24} className="avatar" />
      <div className="msg-ai__body">
        {blocks}
        {(line !== null || stopped) && (
          <div className="meta">
            {stopped && <span className="meta__stopped">Stopped</span>}
            {stopped && line !== null && " · "}
            {line}
          </div>
        )}
        {isLastTurn && live === null && lastTurn?.canRetry !== false && (
          <RetryMenu itemText={texts.join("\n\n")} />
        )}
      </div>
    </div>
  );
}

function RecapCard() {
  const snap = useProject((s) => s.snap);
  const draft = useChat((s) => s.draft);
  if (!snap) return null;
  const build = latestBuild(snap);
  const lastVersion = snap.versions.find((v) => v.number === snap.head);
  const lastAt = [
    ...snap.conversation.items.map((i) => i.createdAt),
    ...snap.versions.map((v) => v.createdAt),
  ]
    .sort()
    .at(-1);
  const levels = snap.plan?.levels.length ?? 0;
  let text: ReactNode;
  let actions: ReactNode;
  if (snap.head === 0) {
    text = "We were settling the brief. Next step: draw the first plan.";
    actions = null;
  } else if (
    build &&
    snap.approvedVersion !== null &&
    build.versionNumber === snap.approvedVersion &&
    snap.head === build.versionNumber
  ) {
    const slabs = new Set(build.levels.flatMap((l) => l.chunks.map((c) => c.id)));
    const pasted = new Set(build.levels.flatMap((l) => l.chunks.filter((c) => c.pasted).map((c) => c.id)));
    text =
      slabs.size === 1
        ? `Build of v${build.versionNumber} · one slab, ${pasted.size === 1 ? "pasted" : "not pasted yet"}.`
        : `Build of v${build.versionNumber} · ${pasted.size} of ${slabs.size} slabs pasted.`;
    actions = (
      <button
        className="btn btn--sm"
        onClick={() => {
          useMap.getState().setTab("build");
        }}
      >
        {slabs.size === 1 ? "Open build" : "Resume paste checklist"}
      </button>
    );
  } else if (build && snap.head !== build.versionNumber) {
    text = `Plan changed after the last build (v${build.versionNumber} → v${snap.head}).`;
    actions = (
      <button className="btn btn--sm" onClick={() => void approve(snap.head, true)}>
        Approve v{snap.head} & rebuild
      </button>
    );
  } else {
    text = (
      <>
        Plan v{snap.head} of {levels} level{levels === 1 ? "" : "s"},{" "}
        {snap.approvedVersion === snap.head ? "approved" : "not yet approved"}. Last change:{" "}
        {withRefs(lastVersion?.summary ?? "", "rc")}.
        {draft.trim() !== "" && " Your unsent message is still in the box below."}
      </>
    );
    actions = (
      <>
        <button
          className="btn btn--sm"
          onClick={() => {
            useMap.getState().setTab("map");
          }}
        >
          Show the map
        </button>
        {snap.approvedVersion !== snap.head && (
          <button
            className="btn btn--sm"
            onClick={() => {
              useMap.getState().setTab("map");
              useMap.getState().setApprove(true);
            }}
          >
            Approve v{snap.head}
          </button>
        )}
      </>
    );
  }
  return (
    <div className="card recap" role="note" aria-label="Where we left off">
      <div className="upd__h">
        <Icon name="history" className="recap__icon" />
        <span className="upd__t">
          Where we left off{lastAt !== undefined ? ` · ${relativeTime(lastAt)}` : ""}
        </span>
      </div>
      <p className="recap__p">{text}</p>
      {actions !== null && <div className="card-actions">{actions}</div>}
    </div>
  );
}

function LiveTurn({ turn }: { turn: TurnState }) {
  const showReasoning = useSettings((s) => s.settings?.showReasoning ?? false);
  return (
    <div className="msg-ai" aria-busy="true">
      <Mark size={24} className="avatar" />
      <div className="msg-ai__body">
        {showReasoning && turn.reasoning !== "" && (
          <details className="reasoning">
            <summary>Thinking…</summary>
            <p>{turn.reasoning}</p>
          </details>
        )}
        {turn.text !== "" && (
          <div className="msg-ai__text">
            <RichText text={turn.text} />
            <span className="caret" aria-hidden="true" />
          </div>
        )}
        {turn.questions ? (
          <QuestionCard callId={turn.questions.callId} questions={turn.questions.questions} live />
        ) : (
          <WorkingCard turn={turn} />
        )}
        {turn.notices.map((n, i) => (
          <div key={i} className="notice">
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}

export function Thread() {
  const retryError = useChat((s) => s.retryError);
  const snap = useProject((s) => s.snap);
  const items = useChat((s) => s.items);
  const live = useChat((s) => s.live);
  const last = useChat((s) => s.last);
  const models = useSettings((s) => s.models);
  const setDraft = useChat((s) => s.setDraft);
  const focus = useChat((s) => s.focusComposer);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // The recap sits at the session boundary: after the items that existed when the project was opened.
  // (Thread mounts once per opened project, so this is computed at open time.)
  const [recap] = useState<{ id: string | null; show: boolean } | null>(() => {
    if (!snap) return null;
    const lastAt = [
      ...snap.conversation.items.map((i) => i.createdAt),
      ...snap.versions.map((v) => v.createdAt),
    ]
      .sort()
      .at(-1);
    const show =
      lastAt !== undefined &&
      Date.now() - new Date(lastAt).getTime() > 6 * 3600_000 &&
      snap.conversation.items.some((i) => i.type === "user");
    return { id: snap.conversation.items.at(-1)?.id ?? null, show };
  });
  const entries = useMemo(
    () => buildEntries(items, snap?.versions ?? [], snap?.builds ?? [], models),
    [items, snap?.versions, snap?.builds, models],
  );
  const hasUser = items.some((i) => i.type === "user");
  const lastAiTurn = [...entries].reverse().find((e) => e.kind === "ai");

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const onScroll = (): void => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  const recapIndex =
    recap?.show === true
      ? entries.findIndex(
          (e) => (e.kind === "user" ? e.item.id : e.kind === "ai" ? e.items.at(-1)?.id : null) === recap.id,
        )
      : -2;

  return (
    <div
      ref={ref}
      className="thread"
      role="log"
      aria-label="Conversation"
      aria-live="off"
      onScroll={onScroll}
    >
      {entries.length === 0 && (
        <div className="msg-ai">
          <Mark size={24} className="avatar" />
          <div className="msg-ai__body">
            <div className="msg-ai__text">
              <RichText text="**Let's build a map.** Tell me what you're running — a dungeon, a tower, a town, a stretch of forest — and anything you already know: the game, the party, the mood. I'll sketch a plan you can poke at before anything goes into TaleSpire." />
            </div>
          </div>
        </div>
      )}
      {entries.map((e, i) => (
        <Fragment key={e.kind === "user" ? e.item.id : e.kind === "ai" ? (e.items[0]?.id ?? `ai${i}`) : e.id}>
          {e.kind === "user" && (
            <div className="msg-user">
              {e.item.selection && e.item.selection.areaIds.length > 0 && (
                <span className="msg-user__refs">
                  {e.item.selection.areaIds.map((id) => {
                    const a = snap?.plan?.levels.flatMap((l) => l.areas).find((x) => x.id === id);
                    return (
                      <button
                        key={id}
                        className="ref"
                        onClick={() => {
                          if (e.item.selection) selectRoom(e.item.selection.levelId, id);
                        }}
                      >
                        {a?.key !== undefined && <span className="badge">{a.key}</span>}
                        {a?.name ?? id}
                      </button>
                    );
                  })}{" "}
                </span>
              )}
              <RichText text={e.item.text} />
            </div>
          )}
          {e.kind === "ai" && (
            <>
              <AiMessage items={e.items} isLastTurn={e === lastAiTurn && hasUser} />
              {i === 0 && !hasUser && (
                <div className="starters">
                  {STARTERS.map((s) => (
                    <button
                      key={s.title}
                      className="starter"
                      onClick={() => {
                        setDraft(s.prompt);
                        focus();
                      }}
                    >
                      <b>{s.title}</b>
                      {s.short}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          {e.kind === "sys" && <div className="sys">{e.text}</div>}
          {e.kind === "build" && <BuildCard version={e.version} slabs={e.slabs} at={e.at} />}
          {i === recapIndex && (
            <>
              <div className="sys">Today</div>
              <RecapCard />
            </>
          )}
        </Fragment>
      ))}
      {live && <LiveTurn turn={live} />}
      {last?.outstanding && <OutstandingSummary o={last.outstanding} />}
      {last?.status === "failed" && <ErrorCard turn={last} />}
      {last?.stopReason === "revision_limit" && <RevisionLimitCard key={last.turnId} turn={last} />}
      {retryError !== null && live === null && (
        <p className="notice retrynote" role="status">
          {retryError}
        </p>
      )}
      {last?.status === "stopped" && last.canRetry && (
        <div className="sys">
          Stopped. A partial plan is never applied.{" "}
          <button className="btn btn--link" onClick={() => void useChat.getState().retry()}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
