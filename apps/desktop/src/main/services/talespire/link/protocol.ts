/**
 * The `slabyrinth-link` protocol between the app and Slabyrinth Helper (symbiotes/slabyrinth-helper), app side.
 * The helper is plain JavaScript with no build step, so it cannot import this file; protocol.contract.test.ts runs
 * the helper's own code (sequencer.js) against these schemas and builders, so the two sides cannot drift.
 *
 * App -> helper:  { protocol, version, type, id, ... }
 *   load {set}                 a chunk set (ChunkSet below), shown and fed to the GM's hand one chunk at a time
 *   next | back | again        the hotkeys (and the app's own buttons, if any)
 *   status                     asks for a state reply
 *   unload                     drops the set
 *   hotkeys-result {replyTo, results}   the hotkeys the app holds, answering a "hotkeys" request or on its own
 * Helper -> app:
 *   hello {token, addon}       first message: the pairing token from slabyrinth-link.json, and the add-on version
 *   state {replyTo, setName, chunk, total, phase, status, cause, error}   after every command and every change
 *   hotkeys {id, hotkeys}      the GM's hotkey choices ({ next?, back?, again? }, "Ctrl+Alt+D")
 *
 * Everything from the socket is untrusted: parsed with zod, sizes capped, unknown keys dropped.
 */
import { z } from "zod";

export const LINK_PROTOCOL = "slabyrinth-link";
export const LINK_VERSION = 1;
export const DEFAULT_LINK_PORT = 48731;
/** The pairing file the app writes into the installed add-on (the helper fetches it from its own origin). */
export const LINK_CONFIG_FILE = "slabyrinth-link.json";
/** Largest message the helper accepts (sequencer.js LINK_MAX_CHARS): 500 chunks of a full 30 KB slab fit. */
export const LINK_MAX_CHARS = 24 * 1024 * 1024;
/** Largest message the app accepts from the helper (its messages are a few hundred bytes). */
export const HELPER_MAX_BYTES = 64 * 1024;
/** Chunks per set (sequencer.js MAX_CHUNKS). */
export const MAX_CHUNKS = 500;

export const APP_COMMANDS = ["next", "back", "again", "status", "unload"] as const;
export type AppCommand = (typeof APP_COMMANDS)[number];
/** Every type the app sends (the helper's LINK_TYPES must list the same). */
export const APP_MESSAGE_TYPES = ["load", ...APP_COMMANDS, "hotkeys-result"] as const;
/** Every type the helper sends. */
export const HELPER_MESSAGE_TYPES = ["hello", "state", "hotkeys"] as const;

export const HOTKEY_ACTIONS = ["next", "back", "again"] as const;
export type HotkeyAction = (typeof HOTKEY_ACTIONS)[number];
export const DEFAULT_HOTKEYS: Record<HotkeyAction, string> = {
  next: "Ctrl+Alt+D",
  back: "Ctrl+Alt+A",
  again: "Ctrl+Alt+S",
};
export const SET_PHASES = ["empty", "ready", "sending", "inHand", "failed", "done"] as const;

/** The `slabyrinth-chunks` v1 set the helper loads (its parseChunkSet checks it again). */
export interface ChunkSet {
  format: "slabyrinth-chunks";
  version: 1;
  name: string;
  size?: { w: number; h: number };
  levels?: number;
  chunks: Array<{ label: string; slab: string }>;
}

const id = z.union([z.number(), z.string().max(64)]).nullable();
/** A text cut to a length rather than refused (a TaleSpire cause can be a whole .NET stack trace). */
const capped = (n: number) => z.string().transform((s) => s.slice(0, n));
const envelope = { protocol: z.literal(LINK_PROTOCOL), version: z.literal(LINK_VERSION) };

const helloSchema = z.object({
  ...envelope,
  type: z.literal("hello"),
  token: z.string().min(1).max(128),
  addon: z.string().max(32).nullable().optional(),
});
const stateSchema = z.object({
  ...envelope,
  type: z.literal("state"),
  replyTo: id.optional(),
  setName: capped(200).nullable(),
  chunk: z.number().int().min(0).max(MAX_CHUNKS),
  total: z.number().int().min(0).max(MAX_CHUNKS),
  phase: z.enum(SET_PHASES),
  status: capped(1000),
  cause: capped(300).nullable().optional(),
  error: capped(1000).nullable().optional(),
});
const hotkeysSchema = z.object({
  ...envelope,
  type: z.literal("hotkeys"),
  id: id.optional(),
  hotkeys: z.object({
    next: z.string().max(40).optional(),
    back: z.string().max(40).optional(),
    again: z.string().max(40).optional(),
  }),
});
const helperMessageSchema = z.discriminatedUnion("type", [helloSchema, stateSchema, hotkeysSchema]);
export type HelperMessage = z.infer<typeof helperMessageSchema>;
export type HelperState = z.infer<typeof stateSchema>;

/** A message from the helper, or null when it is malformed, too big or of an unknown type. */
export function parseHelperMessage(text: string): HelperMessage | null {
  if (text.length > HELPER_MAX_BYTES) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const r = helperMessageSchema.safeParse(raw);
  return r.success ? r.data : null;
}

export interface HotkeyResult {
  status: "active" | "standby" | "refused" | "none";
  combo: string | null;
  wanted?: string;
  reason?: string;
}

type AppMessage =
  | { type: "load"; set: ChunkSet }
  | { type: AppCommand }
  | { type: "hotkeys-result"; replyTo: string | number | null; results: Record<HotkeyAction, HotkeyResult> };

/** An app message as the text sent on the socket. */
export function appMessage(id: number, m: AppMessage): string {
  return JSON.stringify({ protocol: LINK_PROTOCOL, version: LINK_VERSION, id, ...m });
}

// ── hotkeys ──
// Combos are written "Ctrl+Alt+D". Only this allow-list is ever turned into an Electron accelerator: a string from
// the socket is never passed through. sequencer.js checkHotkey is the same rule (the contract test compares them).

const MODIFIERS = { Ctrl: "Control", Alt: "Alt", Shift: "Shift" } as const;
type Modifier = keyof typeof MODIFIERS;
const MODIFIER_ORDER: Modifier[] = ["Ctrl", "Alt", "Shift"];
const NAMED_KEYS = new Set([
  "Space",
  "Insert",
  "Delete",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Up",
  "Down",
  "Left",
  "Right",
]);

function isAllowedKey(k: string): boolean {
  return /^[A-Z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED_KEYS.has(k);
}

export type HotkeyCheck = { ok: true; combo: string; accelerator: string } | { ok: false; reason: string };

/** Whether a combo may be a global hotkey, with its canonical form and Electron accelerator. */
export function checkHotkey(combo: unknown): HotkeyCheck {
  if (typeof combo !== "string" || combo.length === 0 || combo.length > 40)
    return { ok: false, reason: "empty" };
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const mods: Modifier[] = [];
  for (const m of parts) {
    if (!Object.hasOwn(MODIFIERS, m))
      return { ok: false, reason: `${m} is not allowed (use Ctrl, Alt, Shift)` };
    if (mods.includes(m as Modifier)) return { ok: false, reason: `repeats ${m}` };
    mods.push(m as Modifier);
  }
  if (!isAllowedKey(key))
    return { ok: false, reason: `${key} is not an allowed key (A-Z, 0-9, F1-F24, Space, arrows...)` };
  if (!mods.includes("Ctrl") && !mods.includes("Alt"))
    return { ok: false, reason: "needs Ctrl or Alt, so it does not block normal typing" };
  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return {
    ok: true,
    combo: [...ordered, key].join("+"),
    accelerator: [...ordered.map((m) => MODIFIERS[m]), key].join("+"),
  };
}
