/**
 * The Slabyrinth Helper link, bridge side, without Electron: the message format, the command line, and a WebSocket
 * server on 127.0.0.1 that sends commands to the connected helper and prints its replies.
 * hotkey-bridge.mjs adds the global shortcuts (Electron); this file runs and is tested in plain Node.
 *
 * Bridge -> helper: { protocol: "slabyrinth-link", version: 1, type, id, set? }
 *   type: "next" | "back" | "again" | "status" | "load" (with `set`, a slabyrinth-chunks v1 object)
 * Helper -> bridge: { protocol, version, type: "state", replyTo, chunk, total, phase, status, cause, setName, error? }
 *                   { protocol, version, type: "hotkeys", id, hotkeys: { next?, back?, again? } }  (e.g. "Ctrl+Alt+D")
 * Bridge -> helper: { protocol, version, type: "hotkeys-result", id, replyTo, results: { next, back, again } },
 *                   each { status: "active" | "refused" | "none", combo, wanted?, reason? }
 *
 * An experiment: there is no pairing token and no origin check. A product version would add both (any local
 * program, or a web page in any browser on this computer, can open a WebSocket to 127.0.0.1).
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { attachWebSocket } from "./ws-lite.mjs";

export const LINK_PROTOCOL = "slabyrinth-link";
export const LINK_VERSION = 1;
export const DEFAULT_PORT = 48731;
/** Rarely taken, and all reachable with the left hand while the right hand stays on the mouse. */
export const DEFAULT_SHORTCUTS = { next: "Ctrl+Alt+D", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" };
export const COMMANDS = ["next", "back", "again", "status", "load"];

export function linkMessage(type, id, extra = {}) {
  return JSON.stringify({ protocol: LINK_PROTOCOL, version: LINK_VERSION, type, id, ...extra });
}

/**
 * Command-line options: --port=N, --next=KEYS, --back=KEYS, --again=KEYS, --set=PATH (also "--port N").
 * Returns { port, shortcuts, setPath, errors }.
 */
export function parseBridgeArgs(args) {
  const out = { port: DEFAULT_PORT, shortcuts: { ...DEFAULT_SHORTCUTS }, setPath: null, errors: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const m = /^--(port|next|back|again|set)(?:=(.*))?$/.exec(a);
    if (!m) {
      out.errors.push(`Unknown option ${a}`);
      continue;
    }
    const value = m[2] ?? args[++i];
    if (value === undefined || value === "") {
      out.errors.push(`--${m[1]} needs a value`);
      continue;
    }
    if (m[1] === "port") {
      const p = Number(value);
      if (!Number.isInteger(p) || p < 1024 || p > 65535) out.errors.push("--port must be from 1024 to 65535");
      else out.port = p;
    } else if (m[1] === "set") out.setPath = value;
    else out.shortcuts[m[1]] = value;
  }
  return out;
}

// ── hotkeys ──
// Combos are written "Ctrl+Alt+D". Only this allow-list is ever turned into an Electron accelerator: a string from
// the socket is never passed through.

export const HOTKEY_ACTIONS = ["next", "back", "again"];
const MODIFIERS = { Ctrl: "Control", Alt: "Alt", Shift: "Shift" };
const MODIFIER_ORDER = ["Ctrl", "Alt", "Shift"];
const NAMED_KEYS = [
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
];

function isAllowedKey(k) {
  return /^[A-Z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || NAMED_KEYS.includes(k);
}

/**
 * Whether a combo may be a global hotkey, and its Electron accelerator:
 * { ok: true, combo (canonical), accelerator } or { ok: false, reason }.
 */
export function checkHotkey(combo) {
  if (typeof combo !== "string" || combo.length === 0 || combo.length > 40)
    return { ok: false, reason: "empty" };
  const parts = combo.split("+");
  const key = parts.pop();
  const mods = [];
  for (const m of parts) {
    if (!Object.hasOwn(MODIFIERS, m))
      return { ok: false, reason: `${m} is not allowed (use Ctrl, Alt, Shift)` };
    if (mods.includes(m)) return { ok: false, reason: `repeats ${m}` };
    mods.push(m);
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

/**
 * Keeps the three global hotkeys registered. `register(accelerator, callback)` returns false when another program
 * owns the key (Electron's globalShortcut.register); `unregister(accelerator)`. `onCommand(action)` runs on a press.
 * `apply(wanted, source)` changes the actions named in `wanted` ({ next: "Ctrl+Alt+D", ... }); a refused change keeps
 * that action's previous hotkey. Returns the state of all three: { action: { status, combo, wanted?, reason? } }.
 */
export function createHotkeyManager({ register, unregister, onCommand, log = () => {} }) {
  const active = Object.fromEntries(HOTKEY_ACTIONS.map((a) => [a, null])); // { combo, accelerator } | null

  function apply(wanted, source) {
    const refused = {};
    const changes = new Map();
    for (const a of HOTKEY_ACTIONS) {
      if (!wanted || typeof wanted[a] !== "string") continue;
      const c = checkHotkey(wanted[a]);
      if (!c.ok) refused[a] = { wanted: wanted[a], reason: `invalid: ${c.reason}` };
      else if (active[a]?.accelerator !== c.accelerator) changes.set(a, c);
    }
    // duplicates between the three actions, judged on the result
    const after = (a) => changes.get(a)?.accelerator ?? active[a]?.accelerator ?? null;
    for (const [a, c] of [...changes]) {
      const other = HOTKEY_ACTIONS.find((b) => b !== a && after(b) === c.accelerator);
      if (other) {
        refused[a] = { wanted: c.combo, reason: `the same key as ${other}` };
        changes.delete(a);
      }
    }
    // free the old keys first (so two actions can swap), then register the new ones
    for (const a of changes.keys()) if (active[a]) unregister(active[a].accelerator);
    for (const [a, c] of changes) {
      let ok = false;
      try {
        ok = register(c.accelerator, () => onCommand(a));
      } catch (e) {
        refused[a] = { wanted: c.combo, reason: `invalid: ${e.message}` };
      }
      if (ok) {
        log(`Hotkey ${a}: ${c.combo}${active[a] ? ` (was ${active[a].combo})` : ""}, from ${source}.`);
        active[a] = c;
        continue;
      }
      refused[a] ??= { wanted: c.combo, reason: "taken by another program" };
      if (active[a]) register(active[a].accelerator, () => onCommand(a)); // keep the previous working one
    }
    for (const [a, r] of Object.entries(refused))
      log(
        `Hotkey ${a}: ${r.wanted} REFUSED (${r.reason}); ${active[a] ? `keeping ${active[a].combo}` : "none set"}.`,
      );
    return state(refused);
  }

  function state(refused = {}) {
    return Object.fromEntries(
      HOTKEY_ACTIONS.map((a) => [
        a,
        refused[a]
          ? {
              status: "refused",
              combo: active[a]?.combo ?? null,
              wanted: refused[a].wanted,
              reason: refused[a].reason,
            }
          : { status: active[a] ? "active" : "none", combo: active[a]?.combo ?? null },
      ]),
    );
  }

  function clear() {
    for (const a of HOTKEY_ACTIONS) if (active[a]) unregister(active[a].accelerator);
    for (const a of HOTKEY_ACTIONS) active[a] = null;
  }

  return { apply, state, clear };
}

/**
 * A message from the helper: { kind: "state", line } for its state, { kind: "hotkeys", id, hotkeys } for a hotkey
 * request (only string values for known actions kept), or null when malformed.
 */
export function parseHelperMessage(text) {
  if (typeof text !== "string" || text.length > 64 * 1024) return null;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object" || m.protocol !== LINK_PROTOCOL || m.version !== LINK_VERSION) return null;
  if (m.type === "state") return { kind: "state", line: describeReply(text) };
  if (m.type === "hotkeys") {
    if (!m.hotkeys || typeof m.hotkeys !== "object" || Array.isArray(m.hotkeys)) return null;
    const hotkeys = {};
    for (const a of HOTKEY_ACTIONS)
      if (typeof m.hotkeys[a] === "string") hotkeys[a] = m.hotkeys[a].slice(0, 40);
    const id = typeof m.id === "number" || (typeof m.id === "string" && m.id.length <= 64) ? m.id : null;
    return { kind: "hotkeys", id, hotkeys };
  }
  return null;
}

/** Reads a chunk-set file; throws with a plain message when it is not a slabyrinth-chunks v1 object. */
export function readChunkSet(path) {
  let data;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`Could not read the chunk set ${path}: ${e.message}`, { cause: e });
  }
  if (!data || data.format !== "slabyrinth-chunks" || data.version !== 1 || !Array.isArray(data.chunks))
    throw new Error(`${path} is not a slabyrinth-chunks version 1 file`);
  return data;
}

/** A helper reply as one printable line, or null when it is not a link state message. */
export function describeReply(text) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  if (!r || r.protocol !== LINK_PROTOCOL || r.type !== "state") return null;
  const where = r.total ? `chunk ${r.chunk} of ${r.total} (${r.phase})` : "no chunks loaded";
  const extra = [r.error ? `error: ${r.error}` : "", r.cause ? `cause: ${r.cause}` : ""]
    .filter(Boolean)
    .join("; ");
  return `${where}: ${r.status}${extra ? `  [${extra}]` : ""}`;
}

/**
 * Starts the link server on 127.0.0.1. `set` (optional) is pushed to every helper that connects; `hotkeys` (a
 * createHotkeyManager) answers the helper's hotkey requests.
 * Resolves to { send(type), helpers(), close() } once listening.
 */
export function startLinkServer({ port = DEFAULT_PORT, set = null, hotkeys = null, log = console.log } = {}) {
  let nextId = 1;
  const server = createServer((req, res) => {
    res.writeHead(426, { "Content-Type": "text/plain" });
    res.end("Slabyrinth Helper link: WebSocket only");
  });
  const helpers = attachWebSocket(server, {
    onOpen: (c) => {
      log(`Helper connected (Origin: ${c.origin}).`);
      if (set) {
        const id = nextId++;
        log(`Sent: load "${set.name}" (${set.chunks.length} chunks) [${id}]`);
        c.send(linkMessage("load", id, { set }));
      }
    },
    onMessage: (c, text) => {
      const m = parseHelperMessage(text);
      if (!m) return log(`Helper sent something unexpected (ignored): ${text.slice(0, 200)}`);
      if (m.kind === "state") return log(`Helper: ${m.line}`);
      // hotkeys the GM set in the helper win over this bridge's command-line ones
      const results = hotkeys ? hotkeys.apply(m.hotkeys, "the helper") : null;
      c.send(
        linkMessage("hotkeys-result", nextId++, {
          replyTo: m.id,
          results:
            results ??
            Object.fromEntries(
              HOTKEY_ACTIONS.map((a) => [
                a,
                { status: "none", combo: null, reason: "this bridge has no hotkeys" },
              ]),
            ),
        }),
      );
    },
    onClose: () => log("Helper disconnected."),
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      resolve({
        helpers: () => helpers.size,
        send: (type) => {
          if (!COMMANDS.includes(type)) throw new Error(`Unknown command ${type}`);
          if (helpers.size === 0) {
            log(`${type}: no helper connected (turn on Link in the helper).`);
            return 0;
          }
          const id = nextId++;
          for (const h of helpers) h.send(linkMessage(type, id));
          log(`Sent: ${type} [${id}]`);
          return helpers.size;
        },
        close: () =>
          new Promise((done) => {
            for (const h of helpers) h.close();
            server.close(() => done());
          }),
      });
    });
  });
}
