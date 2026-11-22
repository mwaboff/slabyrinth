/**
 * Tests only: the add-on's own protocol code (symbiotes/slabyrinth-helper/sequencer.js, loaded as TaleSpire loads it:
 * a classic script defining one global) driven over a real socket, the way app.js drives it, with TaleSpire's
 * sendSlabToHand answering at once. The link tests run the app's real server against this.
 */
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { HotkeyResult } from "../protocol";
import { connect, type TestClient } from "./wsClient";

export const HELPER_DIR = new URL("../../../../../../../../symbiotes/slabyrinth-helper/", import.meta.url);

/** The parts of the add-on's state the tests read. */
export interface HelperSet {
  name: string;
  chunks: Array<{ label: string; slab: string; bytes: number }>;
  size: { w: number; h: number } | null;
  levels: number | null;
  anchor: { side: string; clearanceCells: number; farMarkerCells: number } | null;
}
export interface HelperState {
  set: HelperSet | null;
  index: number;
  phase: string;
  cause: string | null;
}
export interface HelperLinkMessage {
  type: string;
  id: string | number | null;
  replyTo?: string | number | null;
  set?: unknown;
  results?: Record<string, HotkeyResult & { wanted: string | null; reason: string | null }>;
}
interface HelperAction {
  type: string;
  [k: string]: unknown;
}

/** sequencer.js as the tests use it (the helper is untyped browser JavaScript; this is its shape). */
export interface Sequencer {
  LINK_PROTOCOL: string;
  LINK_VERSION: number;
  LINK_TYPES: string[];
  LINK_MAX_CHARS: number;
  LINK_CONFIG_FILE: string;
  LINK_CLOSE_PAIRING: number;
  MAX_CHUNKS: number;
  DEFAULT_MAX_BYTES: number;
  HOTKEY_ACTIONS: string[];
  DEFAULT_HOTKEYS: Record<string, string>;
  initialState(): HelperState;
  reduce(s: HelperState, a: HelperAction): { state: HelperState; effect?: { type: string; index: number } };
  linkReply(s: HelperState, replyTo: string | number | null, error?: string): Record<string, unknown>;
  helloMessage(token: string, addonVersion: string | null): Record<string, unknown>;
  hotkeysMessage(wanted: Record<string, string>, id: number): Record<string, unknown>;
  parseLinkMessage(text: string): HelperLinkMessage | null;
  linkCommand(
    m: HelperLinkMessage,
    maxBytes?: number,
  ): { action?: HelperAction & { set?: HelperSet }; error?: string };
  parseChunkSet(text: string, maxBytes?: number): { ok: boolean; set: HelperSet; error?: string };
  parseLinkConfig(text: string): { port: number; token: string } | null;
  checkHotkey(combo: string): { ok: boolean; combo?: string; reason?: string };
  slabHasRoomForAnAsset(slab: string): boolean;
  mapInfo(set: HelperSet): { title: string; meta: string } | null;
  statusLine(s: HelperState): { tone: string; text: string };
  guide(
    s: HelperState,
    opts: { linked?: boolean; keys?: Record<string, string> | null },
  ): { tone: string; step: string; title: string; detail: string };
}

/** sequencer.js, loaded fresh in its own context. */
export function loadSequencer(): Sequencer {
  const ctx = createContext({});
  runInContext(readFileSync(new URL("sequencer.js", HELPER_DIR), "utf8"), ctx, { filename: "sequencer.js" });
  return (ctx as { SlabyrinthSequencer: Sequencer }).SlabyrinthSequencer;
}

export interface FakeAddon {
  ws: TestClient;
  seq: Sequencer;
  state(): HelperState;
  /** Slabs TaleSpire was asked to put in the hand, in order (chunk labels). */
  hand: string[];
  /** The last hotkeys-result the app sent. */
  hotkeys(): HelperLinkMessage["results"] | null;
  /** A button in the panel (as app.js dispatch, which tells the app). */
  press(action: "next" | "back" | "send"): void;
  /** Waits until the add-on's state passes `test`. */
  until(test: (s: HelperState) => boolean, timeoutMs?: number): Promise<void>;
}

export async function connectAddon(
  port: number,
  token: string,
  opts: { version?: string; hotkeys?: Record<string, string> } = {},
): Promise<FakeAddon> {
  const seq = loadSequencer();
  const c = await connect(port);
  if ("refused" in c) throw new Error(`refused ${String(c.refused)}`);
  let state = seq.initialState();
  let hk: HelperLinkMessage["results"] | null = null;
  const hand: string[] = [];
  const send = (obj: unknown): void => {
    c.send(JSON.stringify(obj));
  };
  const dispatch = (action: HelperAction): void => {
    const r = seq.reduce(state, action);
    const changed = r.state !== state;
    state = r.state;
    if (changed) send(seq.linkReply(state, null));
    if (r.effect?.type === "send") {
      const index = r.effect.index;
      const chunk = state.set?.chunks[index];
      const ok = chunk !== undefined && seq.slabHasRoomForAnAsset(chunk.slab);
      if (ok) hand.push(chunk.label);
      dispatch({ type: "sent", index, ok, cause: ok ? null : "emptySlab" });
    }
    if (r.effect?.type === "clearHand")
      dispatch({ type: "cleared", method: "picking", ok: true, cause: null });
  };
  send(seq.helloMessage(token, opts.version ?? "0.2.0"));
  send(seq.linkReply(state, null));
  if (opts.hotkeys) send(seq.hotkeysMessage(opts.hotkeys, 1));
  const pump = (): void => {
    for (;;) {
      const text = c.messages.shift();
      if (text === undefined) break;
      const msg = seq.parseLinkMessage(text);
      if (!msg) continue;
      if (msg.type === "hotkeys-result") {
        hk = msg.results ?? null;
        continue;
      }
      const cmd = seq.linkCommand(msg, seq.DEFAULT_MAX_BYTES);
      if (cmd.error !== undefined) {
        send(seq.linkReply(state, msg.id, cmd.error));
        continue;
      }
      if (cmd.action) dispatch(cmd.action);
      send(seq.linkReply(state, msg.id));
    }
  };
  const timer = setInterval(pump, 5);
  timer.unref();
  return {
    ws: c,
    seq,
    state: () => state,
    hand,
    hotkeys: () => {
      pump();
      return hk;
    },
    press: (action) => {
      dispatch({ type: action });
    },
    until: (test, timeoutMs = 3000) =>
      new Promise((resolve, reject) => {
        const t0 = Date.now();
        const check = (): void => {
          pump();
          if (test(state)) resolve();
          else if (Date.now() - t0 > timeoutMs) reject(new Error("add-on state never matched"));
          else setTimeout(check, 5);
        };
        check();
      }),
  };
}
