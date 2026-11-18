/**
 * Paste checklist + paste guide state machine (UX §9.2–9.3, adjusted by the 2026-11-18 export ruling).
 * Pure: (state, event) → { state, effects }. Effects are performed by the build store (copy through
 * talespire:copyAndOpen / clipboard, build:setPasted, project:setUiState).
 *
 * The guide exists only for chunked builds: Prepare → Part 1 … Part n → Tidy up. "Next" on a part ticks it
 * Pasted and copies the following part; "Back" never unticks; ticking a part also marks it copied.
 */
export type GuideStep =
  { kind: "prepare" } | { kind: "slab"; slabId: string; index: number; count: number } | { kind: "tidy" };

export interface PasteState {
  steps: GuideStep[];
  /** Index into steps (the guide's current step). */
  current: number;
  pasted: Record<string, boolean>;
  copied: Record<string, string>;
}

export type PasteEvent =
  | { type: "next"; at: string }
  | { type: "back" }
  | { type: "copy_again"; at: string }
  | { type: "goto"; index: number; at: string }
  | { type: "tick"; slabId: string; pasted: boolean; at: string }
  | { type: "copied"; slabId: string; at: string };

export type PasteEffect =
  | { type: "copy"; slabId: string }
  | { type: "set_pasted"; slabId: string; pasted: boolean }
  | { type: "save_step"; step: number };

export function guideSteps(slabIds: readonly string[]): GuideStep[] {
  if (slabIds.length <= 1) return [];
  return [
    { kind: "prepare" },
    ...slabIds.map((slabId, i): GuideStep => ({ kind: "slab", slabId, index: i + 1, count: slabIds.length })),
    { kind: "tidy" },
  ];
}

export function initPaste(
  slabs: ReadonlyArray<{ id: string; pasted: boolean; copiedAt: string | null }>,
  savedStep?: number,
): PasteState {
  const steps = guideSteps(slabs.map((s) => s.id));
  const pasted: Record<string, boolean> = {};
  const copied: Record<string, string> = {};
  for (const s of slabs) {
    pasted[s.id] = s.pasted;
    if (s.copiedAt !== null) copied[s.id] = s.copiedAt;
  }
  const firstOpen = steps.findIndex((st) => st.kind === "slab" && pasted[st.slabId] !== true);
  const fallback = firstOpen < 0 ? Math.max(0, steps.length - 1) : Math.max(0, firstOpen);
  const current =
    savedStep !== undefined && savedStep >= 0 && savedStep < steps.length
      ? savedStep
      : steps.length > 0 && Object.values(pasted).some(Boolean)
        ? fallback
        : 0;
  return { steps, current, pasted, copied };
}

/** The next slab the user should paste (first not pasted, in order), or null when all are done. */
export function nextSlab(state: PasteState, order: readonly string[]): string | null {
  return order.find((id) => state.pasted[id] !== true) ?? null;
}

export function currentStep(state: PasteState): GuideStep | null {
  return state.steps[state.current] ?? null;
}

function slabAt(state: PasteState, index: number): string | null {
  const st = state.steps[index];
  return st?.kind === "slab" ? st.slabId : null;
}

export function pasteReducer(
  state: PasteState,
  e: PasteEvent,
): { state: PasteState; effects: PasteEffect[] } {
  const effects: PasteEffect[] = [];
  switch (e.type) {
    case "next": {
      if (state.current >= state.steps.length - 1) return { state, effects };
      let pasted = state.pasted;
      let copied = state.copied;
      const here = slabAt(state, state.current);
      if (here !== null && pasted[here] !== true) {
        pasted = { ...pasted, [here]: true };
        effects.push({ type: "set_pasted", slabId: here, pasted: true });
      }
      const current = state.current + 1;
      const there = slabAt(state, current);
      if (there !== null) {
        copied = { ...copied, [there]: e.at };
        effects.push({ type: "copy", slabId: there });
      }
      effects.push({ type: "save_step", step: current });
      return { state: { ...state, current, pasted, copied }, effects };
    }
    case "back": {
      if (state.current === 0) return { state, effects };
      const current = state.current - 1;
      effects.push({ type: "save_step", step: current });
      return { state: { ...state, current }, effects };
    }
    case "copy_again": {
      const here = slabAt(state, state.current);
      if (here === null) return { state, effects };
      effects.push({ type: "copy", slabId: here });
      return { state: { ...state, copied: { ...state.copied, [here]: e.at } }, effects };
    }
    case "goto": {
      if (e.index < 0 || e.index >= state.steps.length) return { state, effects };
      const there = slabAt(state, e.index);
      let copied = state.copied;
      if (there !== null) {
        copied = { ...copied, [there]: e.at };
        effects.push({ type: "copy", slabId: there });
      }
      effects.push({ type: "save_step", step: e.index });
      return { state: { ...state, current: e.index, copied }, effects };
    }
    case "tick": {
      const pasted = { ...state.pasted, [e.slabId]: e.pasted };
      const copied =
        e.pasted && state.copied[e.slabId] === undefined
          ? { ...state.copied, [e.slabId]: e.at }
          : state.copied;
      effects.push({ type: "set_pasted", slabId: e.slabId, pasted: e.pasted });
      return { state: { ...state, pasted, copied }, effects };
    }
    case "copied":
      return { state: { ...state, copied: { ...state.copied, [e.slabId]: e.at } }, effects };
  }
}
