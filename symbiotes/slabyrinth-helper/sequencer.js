/**
 * Slabyrinth Helper: the pure sequencing logic (no DOM, no TaleSpire API).
 *
 * A classic script (TaleSpire calls subscription handlers by global name, so the page uses classic scripts, not
 * modules). It defines one global, `SlabyrinthSequencer`. The unit tests in symbiotes/test load this same file.
 *
 *  - parseChunkSet(text, maxBytes): validates a pasted chunk-set blob.
 *  - reduce(state, action): the next state, plus an effect for the page to run (`{ type: "send", index }`).
 *  - statusLine(state), progress(state), controls(state): what the page shows.
 *  - explainCause(cause): a TaleSpire failure cause in plain words.
 */
(function (root) {
  "use strict";

  var FORMAT = "slabyrinth-chunks";
  var VERSION = 1;
  /** TaleSpire's slab limit: bytes of gzip output, before base64 (the API reports the live value). */
  var DEFAULT_MAX_BYTES = 30720;
  var MAX_CHUNKS = 500;

  /** The bytes a base64 string decodes to. */
  function base64Bytes(s) {
    var pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
    return (s.length / 4) * 3 - pad;
  }

  /** Trims whitespace and the optional triple-backtick fences TaleSpire also accepts. */
  function cleanSlab(s) {
    var t = s.trim();
    if (t.startsWith("```")) t = t.slice(3);
    if (t.endsWith("```")) t = t.slice(0, -3);
    return t.replace(/\s+/g, "");
  }

  function fail(error) {
    return { ok: false, error: error };
  }

  /**
   * Validates a chunk-set blob:
   * { "format": "slabyrinth-chunks", "version": 1, "name": "...", "chunks": [{ "label": "...", "slab": "H4sI..." }] }
   */
  function parseChunkSet(text, maxBytes) {
    var limit = typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
    if (typeof text !== "string" || text.trim() === "")
      return fail("The box is empty. Paste a chunk set first.");
    var data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return fail("This is not valid JSON (" + (e && e.message ? e.message : "parse error") + ").");
    }
    if (data === null || typeof data !== "object" || Array.isArray(data))
      return fail('Expected a JSON object with "format", "version", "name" and "chunks".');
    if (data.format !== FORMAT) return fail('"format" must be "' + FORMAT + '".');
    if (data.version !== VERSION)
      return fail(
        '"version" ' + JSON.stringify(data.version) + " is not supported; this helper reads version 1.",
      );
    if (typeof data.name !== "string" || data.name.trim() === "")
      return fail('"name" must be a non-empty text.');
    if (data.name.length > 200) return fail('"name" is too long (at most 200 characters).');
    // optional descriptive fields (version 1 sets without them still load)
    var size = null;
    if (data.size !== undefined) {
      var s = data.size;
      var dim = function (v) {
        return typeof v === "number" && Math.floor(v) === v && v >= 1 && v <= 10000;
      };
      if (s === null || typeof s !== "object" || !dim(s.w) || !dim(s.h))
        return fail('"size" must be { "w": cells, "h": cells } with whole numbers from 1 to 10000.');
      size = { w: s.w, h: s.h };
    }
    var levels = null;
    if (data.levels !== undefined) {
      if (
        typeof data.levels !== "number" ||
        Math.floor(data.levels) !== data.levels ||
        data.levels < 1 ||
        data.levels > 100
      )
        return fail('"levels" must be a whole number from 1 to 100.');
      levels = data.levels;
    }
    if (!Array.isArray(data.chunks) || data.chunks.length === 0)
      return fail('"chunks" must be a non-empty list.');
    if (data.chunks.length > MAX_CHUNKS)
      return fail("Too many chunks (" + data.chunks.length + "; at most " + MAX_CHUNKS + ").");
    var chunks = [];
    for (var i = 0; i < data.chunks.length; i++) {
      var c = data.chunks[i];
      var n = "Chunk " + (i + 1);
      if (c === null || typeof c !== "object") return fail(n + " must be an object with a label and a slab.");
      if (typeof c.label !== "string" || c.label.trim() === "") return fail(n + ' needs a "label".');
      if (typeof c.slab !== "string") return fail(n + ' needs a "slab" string.');
      var slab = cleanSlab(c.slab);
      if (slab === "") return fail(n + " has an empty slab.");
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(slab) || slab.length % 4 !== 0)
        return fail(n + " is not a slab string (it is not base64).");
      if (!slab.startsWith("H4sI")) return fail(n + " is not a slab string (it is not gzip data).");
      var bytes = base64Bytes(slab);
      if (bytes > limit)
        return fail(n + " is " + bytes + " bytes; TaleSpire accepts at most " + limit + " bytes per slab.");
      chunks.push({ label: c.label.trim(), slab: slab, bytes: bytes });
    }
    return { ok: true, set: { name: data.name.trim(), chunks: chunks, size: size, levels: levels } };
  }

  /** The map's title and a small line of facts for the header, or null with no set. Text only (never HTML). */
  function mapInfo(set) {
    if (!set) return null;
    var n = set.chunks.length;
    var facts = [n + (n === 1 ? " chunk" : " chunks")];
    if (set.size) facts.push(set.size.w + " × " + set.size.h + " cells");
    if (set.levels) facts.push(set.levels + (set.levels === 1 ? " level" : " levels"));
    return { title: set.name, meta: facts.join(" · ") };
  }

  /** Failure causes TaleSpire reports, in plain words, with what to do. */
  var CAUSES = {
    clientIsNotInGmMode: "TaleSpire is not in GM mode. Switch to GM mode",
    notInBoard: "you are not on a board. Open the board you are building on",
    rateLimited: "TaleSpire is limiting this symbiote for sending too fast. Wait a few seconds",
    dataOversized:
      "this chunk is over TaleSpire's slab size limit, so it can never be placed. Rebuild the map with smaller chunks",
    invalidSlabString: "TaleSpire could not read this chunk's slab string. Reload the chunk set",
    spawnFailed: "TaleSpire could not create the slab in your hand. Try again, and note it if it repeats",
    noApi: "the TaleSpire API is not available here",
    notInitialized: "the TaleSpire API has not finished starting. Wait a moment",
  };

  function explainCause(cause) {
    if (typeof cause === "string" && Object.prototype.hasOwnProperty.call(CAUSES, cause))
      return CAUSES[cause];
    return 'TaleSpire reported "' + String(cause || "unknown error") + '". Note this message';
  }

  function initialState() {
    return { set: null, index: 0, phase: "empty", cause: null, sentCount: 0 };
  }

  function sendFrom(state, index) {
    return {
      state: Object.assign({}, state, { index: index, phase: "sending", cause: null }),
      effect: { type: "send", index: index },
    };
  }

  /**
   * Phases: "empty" (nothing loaded), "ready" (current chunk not sent yet), "sending", "inHand" (TaleSpire accepted
   * it), "failed" (TaleSpire refused it; `cause` says why), "done" (the GM pressed Next on the last chunk).
   * Actions: load {set}, send, next, back, sent {index, ok, cause}, unload.
   */
  function reduce(state, action) {
    var total = state.set ? state.set.chunks.length : 0;
    switch (action.type) {
      case "load":
        return { state: { set: action.set, index: 0, phase: "ready", cause: null, sentCount: 0 } };
      case "unload":
        return { state: initialState() };
      case "send":
        if (!state.set || state.phase === "sending" || state.phase === "done") return { state: state };
        return sendFrom(state, state.index);
      case "next":
        if (!state.set || state.phase === "sending" || state.phase === "done") return { state: state };
        // nothing in hand yet: Next puts the current chunk there (so one key drives the whole flow)
        if (state.phase === "ready") return sendFrom(state, state.index);
        if (state.index + 1 >= total)
          return { state: Object.assign({}, state, { phase: "done", cause: null }) };
        return sendFrom(state, state.index + 1);
      case "back":
        if (!state.set || state.phase === "sending") return { state: state };
        if (state.phase === "done") return sendFrom(state, state.index);
        if (state.index === 0) return { state: state };
        return sendFrom(state, state.index - 1);
      case "sent":
        // a late answer for a chunk that is no longer current changes nothing
        if (state.phase !== "sending" || action.index !== state.index) return { state: state };
        if (action.ok)
          return {
            state: Object.assign({}, state, { phase: "inHand", cause: null, sentCount: state.sentCount + 1 }),
          };
        return { state: Object.assign({}, state, { phase: "failed", cause: action.cause || "unknown" }) };
      default:
        return { state: state };
    }
  }

  /** The one line that says what the GM should do now; tone is idle, wait, action, error or done. */
  function statusLine(state) {
    if (!state.set) return { tone: "idle", text: "Load a set of chunks to begin." };
    var total = state.set.chunks.length;
    var n = state.index + 1;
    var which = "Chunk " + n + " of " + total;
    var nextWord = n === total ? "Finish" : "Next";
    switch (state.phase) {
      case "ready":
        return {
          tone: "action",
          text:
            n === 1
              ? which +
                " is ready. First press G in TaleSpire to raise the build plane (without it, later chunks land" +
                " a little higher). Then press Next to put chunk 1 in your hand."
              : which + " is ready. Press Next to put it in your hand. Keep the camera and the mouse still.",
        };
      case "sending":
        return { tone: "wait", text: "Sending " + which.toLowerCase() + " to your hand…" };
      case "inHand":
        return {
          tone: "action",
          text:
            n === 1
              ? which +
                " is in your hand. With the build plane raised (G), click one spot to place it (hold the click" +
                " briefly), then press " +
                nextWord +
                ". Keep the camera and the mouse still from now on."
              : which +
                " is in your hand. Click the same spot again without moving the camera, then press " +
                nextWord +
                ".",
        };
      case "failed":
        return {
          tone: "error",
          text:
            which +
            " did not reach your hand: " +
            explainCause(state.cause) +
            ". Then press “Put in hand again”.",
        };
      case "done":
        return {
          tone: "done",
          text:
            "All " +
            total +
            " chunks are placed. Right-click to clear your hand, then delete the two alignment pillars.",
        };
      default:
        return { tone: "idle", text: "Load a set of chunks to begin." };
    }
  }

  /** Progress: which chunk is current and how many are behind the GM (placed, by their Next presses). */
  function progress(state) {
    if (!state.set) return { current: 0, total: 0, placed: 0, fraction: 0 };
    var total = state.set.chunks.length;
    var placed = state.phase === "done" ? total : state.index;
    return { current: state.index + 1, total: total, placed: placed, fraction: total ? placed / total : 0 };
  }

  /** Which buttons are enabled and what the main one says. */
  function controls(state) {
    var loaded = !!state.set;
    var total = loaded ? state.set.chunks.length : 0;
    var busy = state.phase === "sending";
    var sentOnce = state.phase === "inHand" || state.phase === "failed";
    return {
      send: {
        enabled: loaded && !busy && state.phase !== "done",
        label: sentOnce ? "Put in hand again" : "Put in hand",
      },
      next: {
        enabled: loaded && !busy && state.phase !== "done",
        label: state.index + 1 >= total ? "Finish" : "Next",
      },
      back: { enabled: loaded && !busy && (state.index > 0 || state.phase === "done"), label: "Back" },
    };
  }

  /** Default keys: Next without moving the mouse off the spot, and Back. */
  var DEFAULT_KEYS = { next: "Ctrl+Space", back: "Ctrl+Shift+Space" };
  var MODIFIER_KEYS = ["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "OS"];

  /**
   * A key event as a combo name like "Ctrl+Space" or "Ctrl+Shift+N" (null for a lone modifier key).
   * Takes any object with key, code, ctrlKey, shiftKey, altKey and metaKey.
   */
  function keyCombo(e) {
    if (!e || typeof e.key !== "string" || MODIFIER_KEYS.indexOf(e.key) >= 0) return null;
    var name =
      e.code === "Space" || e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
    var parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(name);
    return parts.join("+");
  }

  /** What a key does: "next", "back" or null, given the configured keys. */
  function keyAction(e, keys) {
    var combo = keyCombo(e);
    if (!combo) return null;
    var k = keys || DEFAULT_KEYS;
    if (combo === k.next) return "next";
    if (combo === k.back) return "back";
    return null;
  }

  // ── the link to the hotkey bridge (symbiotes/link-bridge.mjs) ──

  var LINK_PROTOCOL = "slabyrinth-link";
  var LINK_VERSION = 1;
  var LINK_TYPES = ["next", "back", "again", "status", "load", "hotkeys-result"];
  var LINK_MAX_CHARS = 4 * 1024 * 1024;

  /**
   * A message from the bridge, or null when it is malformed or of an unknown type (the page ignores those).
   * { protocol: "slabyrinth-link", version: 1, type, id?, set? } -> { type, id, set? }
   */
  function parseLinkMessage(text) {
    if (typeof text !== "string" || text.length > LINK_MAX_CHARS) return null;
    var m;
    try {
      m = JSON.parse(text);
    } catch {
      return null;
    }
    if (m === null || typeof m !== "object" || Array.isArray(m)) return null;
    if (m.protocol !== LINK_PROTOCOL || m.version !== LINK_VERSION) return null;
    if (LINK_TYPES.indexOf(m.type) < 0) return null;
    var id = null;
    if (typeof m.id === "number" && isFinite(m.id)) id = m.id;
    else if (typeof m.id === "string" && m.id.length <= 64) id = m.id;
    else if (m.id !== undefined && m.id !== null) return null;
    if (m.type === "hotkeys-result") {
      var results = parseHotkeyResults(m.results);
      if (!results) return null;
      var replyTo = typeof m.replyTo === "number" || typeof m.replyTo === "string" ? m.replyTo : null;
      return { type: "hotkeys-result", id: id, replyTo: replyTo, results: results };
    }
    if (m.type === "load") {
      if (m.set === null || typeof m.set !== "object" || Array.isArray(m.set)) return null;
      return { type: "load", id: id, set: m.set };
    }
    return { type: m.type, id: id };
  }

  /** The sequencer action a link message asks for: { action } (none for "status"), or { error } for a bad set. */
  function linkCommand(msg, maxBytes) {
    switch (msg.type) {
      case "next":
        return { action: { type: "next" } };
      case "back":
        return { action: { type: "back" } };
      case "again":
        return { action: { type: "send" } };
      case "load": {
        var parsed = parseChunkSet(JSON.stringify(msg.set), maxBytes);
        return parsed.ok ? { action: { type: "load", set: parsed.set } } : { error: parsed.error };
      }
      default:
        return {};
    }
  }

  /** The helper's answer to the bridge: where the flow stands and what the status line says. */
  function linkReply(state, replyTo, error) {
    var p = progress(state);
    return {
      protocol: LINK_PROTOCOL,
      version: LINK_VERSION,
      type: "state",
      replyTo: replyTo === undefined ? null : replyTo,
      setName: state.set ? state.set.name : null,
      chunk: p.current,
      total: p.total,
      phase: state.phase,
      status: statusLine(state).text,
      cause: state.phase === "failed" ? state.cause : null,
      error: error || null,
    };
  }

  // ── global hotkeys (registered by the bridge) ──
  // The same rule as link-bridge.mjs `checkHotkey`; the bridge checks again and is the one that decides.

  var HOTKEY_ACTIONS = ["next", "back", "again"];
  var DEFAULT_HOTKEYS = { next: "Ctrl+Alt+D", back: "Ctrl+Alt+A", again: "Ctrl+Alt+S" };
  var HOTKEY_MODIFIERS = ["Ctrl", "Alt", "Shift"];
  var HOTKEY_NAMED = [
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
  var CODE_NAMES = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

  /** A key event as a hotkey combo from the physical key (so Ctrl+Alt+D is "D" on any layout); null for a modifier. */
  function hotkeyCombo(e) {
    if (!e || typeof e.code !== "string" || MODIFIER_KEYS.indexOf(e.key) >= 0) return null;
    var c = e.code;
    if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(c)) return null;
    var name = /^Key[A-Z]$/.test(c) ? c.slice(3) : /^Digit[0-9]$/.test(c) ? c.slice(5) : CODE_NAMES[c] || c;
    var parts = [];
    if (e.ctrlKey) parts.push("Ctrl");
    if (e.altKey) parts.push("Alt");
    if (e.shiftKey) parts.push("Shift");
    if (e.metaKey) parts.push("Meta");
    parts.push(name);
    return parts.join("+");
  }

  function isHotkeyKey(k) {
    return /^[A-Z0-9]$/.test(k) || /^F([1-9]|1[0-9]|2[0-4])$/.test(k) || HOTKEY_NAMED.indexOf(k) >= 0;
  }

  /** Whether a combo may be a global hotkey: { ok, combo (canonical order) } or { ok: false, reason }. */
  function checkHotkey(combo) {
    if (typeof combo !== "string" || combo.length === 0 || combo.length > 40)
      return { ok: false, reason: "empty" };
    var parts = combo.split("+");
    var key = parts.pop();
    var mods = [];
    for (var i = 0; i < parts.length; i++) {
      if (HOTKEY_MODIFIERS.indexOf(parts[i]) < 0)
        return { ok: false, reason: parts[i] + " is not allowed (use Ctrl, Alt, Shift)" };
      if (mods.indexOf(parts[i]) >= 0) return { ok: false, reason: "repeats " + parts[i] };
      mods.push(parts[i]);
    }
    if (!isHotkeyKey(key))
      return { ok: false, reason: key + " is not an allowed key (A-Z, 0-9, F1-F24, Space, arrows...)" };
    if (mods.indexOf("Ctrl") < 0 && mods.indexOf("Alt") < 0)
      return { ok: false, reason: "needs Ctrl or Alt, so it does not block normal typing" };
    var ordered = HOTKEY_MODIFIERS.filter(function (m) {
      return mods.indexOf(m) >= 0;
    });
    return { ok: true, combo: ordered.concat([key]).join("+") };
  }

  /** The helper asks the bridge for these hotkeys (only the ones the GM set; the bridge keeps the others). */
  function hotkeysMessage(wanted, id) {
    var hotkeys = {};
    for (var i = 0; i < HOTKEY_ACTIONS.length; i++) {
      var a = HOTKEY_ACTIONS[i];
      if (wanted && typeof wanted[a] === "string") hotkeys[a] = wanted[a];
    }
    return { protocol: LINK_PROTOCOL, version: LINK_VERSION, type: "hotkeys", id: id, hotkeys: hotkeys };
  }

  /** The `results` of a bridge "hotkeys-result" message, checked field by field; null when malformed. */
  function parseHotkeyResults(r) {
    if (r === null || typeof r !== "object" || Array.isArray(r)) return null;
    var out = {};
    for (var i = 0; i < HOTKEY_ACTIONS.length; i++) {
      var a = HOTKEY_ACTIONS[i];
      var v = r[a];
      if (v === undefined) continue;
      if (v === null || typeof v !== "object") return null;
      if (["active", "refused", "none"].indexOf(v.status) < 0) return null;
      if (v.combo !== null && (typeof v.combo !== "string" || v.combo.length > 40)) return null;
      if (
        v.wanted !== undefined &&
        v.wanted !== null &&
        (typeof v.wanted !== "string" || v.wanted.length > 40)
      )
        return null;
      if (
        v.reason !== undefined &&
        v.reason !== null &&
        (typeof v.reason !== "string" || v.reason.length > 200)
      )
        return null;
      out[a] = { status: v.status, combo: v.combo, wanted: v.wanted || null, reason: v.reason || null };
    }
    return out;
  }

  // ── the state header: two lights (shape + icon + words, not colour alone) ──

  /** The link light. linkStatus: "off" (Link switched off), "connecting" or "connected". */
  function linkLight(linkStatus) {
    if (linkStatus === "connected") return { tone: "good", icon: "●", label: "Connected to Slabyrinth" };
    if (linkStatus === "connecting") return { tone: "wait", icon: "◐", label: "Connecting…" };
    return { tone: "off", icon: "○", label: "Not connected" };
  }

  var BLOCKING = { clientIsNotInGmMode: "not in GM mode", notInBoard: "not on a board" };

  /**
   * The slabs light. `clientMode` is what TaleSpire last reported ("gm", "player", "spectator" or null when unknown);
   * a board problem is only known from a refused send (the API has no "am I on a board" answer used here).
   * Progress is the progress bar's job and "all placed" the status line's, so the light says only loaded or not, or
   * what blocks pasting.
   */
  function slabsLight(state, clientMode) {
    if (!state.set) return { tone: "off", icon: "○", label: "No slabs loaded" };
    var blocked =
      clientMode && clientMode !== "gm"
        ? BLOCKING.clientIsNotInGmMode
        : state.phase === "failed" && Object.prototype.hasOwnProperty.call(BLOCKING, state.cause)
          ? BLOCKING[state.cause]
          : null;
    if (blocked) return { tone: "bad", icon: "⚠", label: "Blocked: " + blocked };
    return { tone: "good", icon: "●", label: "Slabs are ready to paste" };
  }

  root.SlabyrinthSequencer = {
    mapInfo: mapInfo,
    linkLight: linkLight,
    slabsLight: slabsLight,
    HOTKEY_ACTIONS: HOTKEY_ACTIONS,
    DEFAULT_HOTKEYS: DEFAULT_HOTKEYS,
    hotkeyCombo: hotkeyCombo,
    checkHotkey: checkHotkey,
    hotkeysMessage: hotkeysMessage,
    LINK_PROTOCOL: LINK_PROTOCOL,
    LINK_VERSION: LINK_VERSION,
    parseLinkMessage: parseLinkMessage,
    linkCommand: linkCommand,
    linkReply: linkReply,
    FORMAT: FORMAT,
    VERSION: VERSION,
    DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES,
    DEFAULT_KEYS: DEFAULT_KEYS,
    keyCombo: keyCombo,
    keyAction: keyAction,
    parseChunkSet: parseChunkSet,
    explainCause: explainCause,
    initialState: initialState,
    reduce: reduce,
    statusLine: statusLine,
    progress: progress,
    controls: controls,
  };
})(globalThis);
