/** chatStore (architecture §6.3): transcript + live stream (chatReducer), composer, question answers, estimate. */
import { create } from "zustand";
import type { MapSelection } from "@slabyrinth/core";
import type { ChatEvent } from "../../shared/ipc";
import type { ChatMessageMeta } from "../../shared/project";
import type { ChatItem, Cost, EffortLevel, ModelSelection } from "../../main/agent/provider/types";
import { BridgeError, call, tryCall } from "../bridge/client";
import { addCosts, chatReducer, emptyChat, pendingQuestions, type ChatState } from "./chatReducer";

export interface ComposerRef {
  type: "room" | "feature" | "opening" | "link" | "level";
  id: string;
  levelId: string;
  label: string;
  key?: string;
}

interface ChatStore extends ChatState {
  meta: Record<string, ChatMessageMeta>;
  selection: ModelSelection | null;
  draft: string;
  refs: ComposerRef[];
  /** Chips picked on the open Question card: question id → answer (null = "You decide"). */
  answers: Record<string, string | null>;
  estimate: { costUsd: number | null; seconds: number | null } | null;
  focusTick: number;
  /**
   * A chat:send / retry / continue is on its way and no turn_started has arrived yet. Guards against double
   * clicks and Enter key-repeat starting two turns (the live turn only exists once turn_started lands).
   */
  inFlight: boolean;
  /** User-facing reason a Retry was refused (e.g. the map changed after that reply). */
  retryError: string | null;
  /**
   * After "Keep going" at the revision limit: the changes made and the money spent by the earlier turns of the same
   * GM message, so the next limit card counts from that message. Cleared when the GM sends a new message.
   */
  carried: { changes: number; cost: Cost | null } | null;
  hydrate: (
    items: ChatItem[],
    meta: Record<string, ChatMessageMeta>,
    selection: ModelSelection,
    busyTurn: string | null,
  ) => void;
  setMeta: (meta: Record<string, ChatMessageMeta>, items: ChatItem[]) => void;
  dispatch: (e: ChatEvent) => void;
  setDraft: (t: string) => void;
  addRef: (r: ComposerRef) => void;
  removeRef: (id: string) => void;
  clearRefs: () => void;
  pickAnswer: (qid: string, answer: string | null) => void;
  focusComposer: () => void;
  setSelectionLocal: (s: ModelSelection) => void;
  setEstimate: (e: ChatStore["estimate"]) => void;
  /** Sends the composer (and any picked answers). Returns false when nothing was sent. */
  send: (opts?: { text?: string; intent?: "chat" | "plan" | "auto" }) => Promise<boolean>;
  stop: () => Promise<void>;
  retry: (selection?: ModelSelection) => Promise<void>;
  /** Continue; allowance = the new turn's revision limit ("Keep going" on the limit card). */
  continueTurn: (allowance?: number) => Promise<void>;
  changeSelection: (s: ModelSelection) => Promise<void>;
  changeEffort: (effort: EffortLevel | null) => Promise<void>;
}

export function refsToSelection(refs: readonly ComposerRef[]): MapSelection | undefined {
  if (refs.length === 0) return undefined;
  const sel: MapSelection = {
    levelId: refs[0]?.levelId ?? "",
    areaIds: [],
    featureIds: [],
    openingIds: [],
    linkIds: [],
  };
  for (const r of refs) {
    if (r.type === "room") sel.areaIds.push(r.id);
    else if (r.type === "feature") sel.featureIds.push(r.id);
    else if (r.type === "opening") sel.openingIds.push(r.id);
    else if (r.type === "link") sel.linkIds.push(r.id);
  }
  return sel;
}

let inFlightTimer: ReturnType<typeof setTimeout> | null = null;
/** If turn_started never arrives (lost event), release the guard so the user is not stuck. */
function armInFlightTimeout(): void {
  if (inFlightTimer !== null) clearTimeout(inFlightTimer);
  inFlightTimer = setTimeout(() => {
    if (useChat.getState().inFlight && useChat.getState().live === null)
      useChat.setState({ inFlight: false });
  }, 15_000);
}

export const useChat = create<ChatStore>((set, get) => ({
  ...emptyChat(),
  meta: {},
  selection: null,
  draft: "",
  refs: [],
  answers: {},
  estimate: null,
  focusTick: 0,
  inFlight: false,
  retryError: null,
  carried: null,
  hydrate: (items, meta, selection, busyTurn) => {
    const base = emptyChat(items);
    // Nothing from the previous project carries over (chips would go out as that project's <selection>).
    set({
      ...base,
      meta,
      selection,
      answers: {},
      refs: [],
      draft: "",
      estimate: null,
      inFlight: false,
      retryError: null,
      carried: null,
    });
    if (busyTurn !== null) {
      set({ live: chatReducer(base, { type: "turn_started", turnId: busyTurn, selection }).live });
    }
  },
  setMeta: (meta, items) => {
    // keep live-only items that the snapshot may not have yet
    const ids = new Set(items.map((i) => i.id));
    const extra = get().items.filter((i) => !ids.has(i.id));
    set({ meta, items: [...items, ...extra] });
  },
  dispatch: (e) => {
    const next = chatReducer(get(), e);
    if (next !== get()) set({ items: next.items, live: next.live, last: next.last });
    if (e.type === "turn_started") set({ selection: e.selection, inFlight: false, retryError: null });
  },
  setDraft: (draft) => {
    set({ draft });
  },
  addRef: (r) => {
    const refs = get().refs;
    if (refs.some((x) => x.id === r.id) || refs.length >= 8) return;
    set({ refs: [...refs, r] });
  },
  removeRef: (id) => {
    set({ refs: get().refs.filter((r) => r.id !== id) });
  },
  clearRefs: () => {
    set({ refs: [] });
  },
  pickAnswer: (qid, answer) => {
    const cur = get().answers;
    const same = qid in cur && cur[qid] === answer;
    set({
      answers: same
        ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== qid))
        : { ...cur, [qid]: answer },
    });
  },
  focusComposer: () => {
    set({ focusTick: get().focusTick + 1 });
  },
  setSelectionLocal: (selection) => {
    set({ selection });
  },
  setEstimate: (estimate) => {
    set({ estimate });
  },
  send: async (opts = {}) => {
    const st = get();
    if (st.live || st.inFlight) return false;
    const text = (opts.text ?? st.draft).trim();
    const pq = pendingQuestions(st.items);
    const picked = Object.keys(st.answers).length > 0;
    if (text === "" && !(pq && (picked || opts.text !== undefined))) return false;
    const req: Parameters<typeof call<"chat:send">>[1] = { text };
    const selection = refsToSelection(st.refs);
    if (selection) req.selection = selection;
    if (opts.intent) req.intent = opts.intent;
    if (pq)
      req.answers = {
        callId: pq.callId,
        answers: pq.questions.map((q) => ({
          id: q.id,
          answer: q.id in st.answers ? (st.answers[q.id] ?? null) : null,
        })),
      };
    set({ inFlight: true });
    const r = await tryCall("chat:send", req);
    if (!r.ok) {
      set({ inFlight: false });
      if (r.error.code === "busy") return false; // a turn is already running: quiet, the draft stays
      throw new BridgeError(r.error);
    }
    armInFlightTimeout();
    set({
      draft: opts.text === undefined ? "" : st.draft,
      refs: opts.text === undefined ? [] : st.refs,
      answers: {},
      carried: null,
    });
    return true;
  },
  stop: async () => {
    const live = get().live;
    if (live) await call("chat:cancel", { turnId: live.turnId });
  },
  retry: async (selection) => {
    if (get().live || get().inFlight) return;
    set({ inFlight: true, retryError: null });
    const r = await tryCall("chat:retry", selection ? { selection } : {});
    if (r.ok) {
      armInFlightTimeout();
      // Main has cut the retried turn's replies from the conversation: drop them here too, keeping anything
      // the new turn has already appended (setMeta at turn end would otherwise keep them as "live-only").
      const fresh = await tryCall("project:snapshot", undefined);
      if (fresh.ok) {
        const kept = new Set(fresh.value.conversation.items.map((i) => i.id));
        set({
          items: get().items.filter((i) => kept.has(i.id) || ("turnId" in i && i.turnId === r.value.turnId)),
        });
      }
      return;
    }
    set({ inFlight: false });
    if (r.error.code === "busy") return;
    // e.g. "You changed the map after this reply" — shown inline under the reply
    set({ retryError: r.error.message });
  },
  continueTurn: async (allowance) => {
    const st = get();
    if (st.live || st.inFlight) return;
    const last = st.last;
    const carried =
      last?.stopReason === "revision_limit"
        ? {
            changes: (st.carried?.changes ?? 0) + last.newVersions.length,
            cost: addCosts(st.carried?.cost, last.turnCost),
          }
        : null;
    set({ inFlight: true });
    const r = await tryCall("chat:continue", allowance === undefined ? undefined : { allowance });
    if (r.ok) {
      armInFlightTimeout();
      set({ carried });
    } else set({ inFlight: false });
  },
  changeSelection: async (s) => {
    const r = await call("chat:setSelection", { selection: s });
    set({ selection: r.selection });
  },
  changeEffort: async (effort) => {
    const r = await call("chat:setEffort", { effort });
    set({ selection: r.selection });
  },
}));
