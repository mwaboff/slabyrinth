/**
 * Slabyrinth Helper: the pure sequencing logic (no DOM, no TaleSpire API).
 *
 * A classic script (TaleSpire calls subscription handlers by global name, so the page uses classic scripts, not
 * modules). It defines one global, `SlabyrinthSequencer`. The unit tests in symbiotes/test load this same file.
 *
 *  - parseChunkSet(text, maxBytes): validates a pasted chunk-set blob.
 *  - reduce(state, action): the next state, plus an effect for the page to run (`{ type: "send", index }`).
 *  - statusLine(state), progress(state), controls(state): what the page shows.
 *  - explainCause(cause): a TaleSpire failure cause in plain words (never the raw text of an unknown one).
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

  var B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  /**
   * The uncompressed size of a slab string, read from the gzip trailer (ISIZE: the last 4 bytes, little-endian), or
   * null when it cannot be read. The page cannot inflate gzip synchronously, but this needs only the last 8 base64
   * characters.
   */
  function slabRawSize(slab) {
    if (typeof slab !== "string" || slab.length < 8 || slab.length % 4 !== 0) return null;
    var tail = slab.slice(-8);
    var pad = tail.endsWith("==") ? 2 : tail.endsWith("=") ? 1 : 0;
    var bytes = [];
    for (var i = 0; i < 8; i += 4) {
      var v = 0;
      for (var j = 0; j < 4; j++) {
        var ch = tail.charAt(i + j);
        var d = ch === "=" ? 0 : B64.indexOf(ch);
        if (d < 0) return null;
        v = v * 64 + d;
      }
      bytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
    }
    bytes = bytes.slice(0, 6 - pad);
    if (bytes.length < 4) return null;
    var b = bytes.slice(-4);
    return b[0] + b[1] * 256 + b[2] * 65536 + b[3] * 16777216;
  }

  /**
   * The smallest slab that can hold one asset: header (10 bytes) + one layout (20) + one instance (8) + trailer (2).
   * Anything smaller has no assets, and an empty slab makes TaleSpire's slab spawn divide by zero (Test K).
   */
  var MIN_SLAB_RAW_BYTES = 40;

  /** False for a slab string that cannot hold an asset (or whose size cannot be read): never send it. */
  function slabHasRoomForAnAsset(slab) {
    var size = slabRawSize(slab);
    return size !== null && size >= MIN_SLAB_RAW_BYTES;
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
      if (!slabHasRoomForAnAsset(slab))
        return fail(n + " has no assets. TaleSpire crashes on an empty slab, so this set cannot be used.");
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
    emptySlab: "this chunk has no assets, and TaleSpire crashes on an empty slab. Rebuild the map",
    couldNotSwitchToTool: "TaleSpire could not switch to the picking tool",
    toolInUse: "another symbiote is using the picking tool",
  };

  /**
   * A failure cause in plain words, for the status line. Never the raw text: an unknown cause can be a whole .NET
   * exception with a stack trace, so it is named only as "an error"; the page keeps the full text for Diagnostics and
   * the event log.
   */
  function explainCause(cause) {
    if (typeof cause === "string" && Object.prototype.hasOwnProperty.call(CAUSES, cause))
      return CAUSES[cause];
    return "TaleSpire reported an error (details under Developer tools > Diagnostics)";
  }

  /** A long failure text cut for a one-line readout: the first line, at most `max` characters. */
  function shortError(text, max) {
    var limit = typeof max === "number" && max > 0 ? max : 160;
    var first = String(text === undefined || text === null ? "" : text)
      .split(/\r?\n/)[0]
      .trim();
    return first.length > limit ? first.slice(0, limit - 1) + "…" : first;
  }

  /**
   * `clear` is what the helper does after the last chunk (see CLEAR_METHODS): null before the end, then
   * { status: "trying" | "answered" | "refused" | "off", method, cause }. "answered" means only that TaleSpire took
   * the call without an error; the API cannot say what is in the GM's hand, so nothing ever claims the hand is empty.
   */
  function initialState() {
    return { set: null, index: 0, phase: "empty", cause: null, sentCount: 0, clear: null };
  }

  function sendFrom(state, index) {
    return {
      state: Object.assign({}, state, { index: index, phase: "sending", cause: null, clear: null }),
      effect: { type: "send", index: index },
    };
  }

  /**
   * Phases: "empty" (nothing loaded), "ready" (current chunk not sent yet), "sending", "inHand" (TaleSpire accepted
   * it), "failed" (TaleSpire refused it; `cause` says why), "done" (the GM pressed Next on the last chunk).
   * Actions: load {set}, send, next, back, sent {index, ok, cause}, cleared {method, ok, cause}, unload.
   * Next on the last chunk also asks the page to switch the hand away from the last chunk (effect `clearHand`).
   * `send` (Again) after the end starts over: nothing placed, back to the first step, nothing sent until Next, so an
   * accidental press puts nothing in the hand.
   */
  function reduce(state, action) {
    var total = state.set ? state.set.chunks.length : 0;
    switch (action.type) {
      case "load":
        return {
          state: { set: action.set, index: 0, phase: "ready", cause: null, sentCount: 0, clear: null },
        };
      case "unload":
        return { state: initialState() };
      case "send":
        if (!state.set || state.phase === "sending") return { state: state };
        if (state.phase === "done")
          return { state: Object.assign({}, state, { index: 0, phase: "ready", cause: null, clear: null }) };
        return sendFrom(state, state.index);
      case "next":
        if (!state.set || state.phase === "sending" || state.phase === "done") return { state: state };
        // nothing in hand yet: Next puts the current chunk there (so one key drives the whole flow)
        if (state.phase === "ready") return sendFrom(state, state.index);
        if (state.index + 1 >= total)
          return {
            state: Object.assign({}, state, { phase: "done", cause: null, clear: { status: "trying" } }),
            effect: { type: "clearHand" },
          };
        return sendFrom(state, state.index + 1);
      case "back":
        if (!state.set || state.phase === "sending") return { state: state };
        // after the end, Back selects the last chunk without putting it in hand: a slab in hand hides the cursor,
        // and the GM is on the panel at this point (mid-sequence Back still sends, since the GM is on the board)
        if (state.phase === "done")
          return { state: Object.assign({}, state, { phase: "ready", cause: null, clear: null }) };
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
      case "cleared":
        // the answer to the clear-hand try; ignored once the GM has gone back to a chunk
        if (state.phase !== "done" || !state.clear || state.clear.status !== "trying")
          return { state: state };
        return {
          state: Object.assign({}, state, {
            clear: {
              status: action.method === "off" ? "off" : action.ok ? "answered" : "refused",
              method: action.method,
              cause: action.ok ? null : action.cause || null,
            },
          }),
        };
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

  /**
   * The "now" block: what to do at this moment, as a short eyebrow (`step`), a headline the GM can read at a glance
   * from the side of the screen (`title`) and one line of detail. `opts.linked` says whether the link to Slabyrinth
   * is up; `opts.keys` ({ next, back, again }) are the global hotkeys to name, or null when they do not work now (then
   * the buttons are named instead). Text only (never HTML). statusLine stays the one-sentence form sent over the link.
   */
  function guide(state, opts) {
    var o = opts || {};
    var keys = o.keys || null;
    if (!state.set)
      return o.linked
        ? {
            tone: "idle",
            step: "",
            title: "Waiting for a map",
            detail: "Send one from Slabyrinth and it appears here.",
          }
        : {
            tone: "idle",
            step: "",
            title: "No map loaded",
            detail: "Connect to Slabyrinth to receive one. The link light above says what is missing.",
          };
    var total = state.set.chunks.length;
    var n = state.index + 1;
    var last = n === total;
    var which = "Chunk " + n + " of " + total;
    var c = controls(state);
    var press = function (action) {
      if (keys && keys[action]) return "press " + keys[action];
      return "press " + (action === "again" ? c.send.label : action === "back" ? c.back.label : c.next.label);
    };
    var cap = function (s) {
      return s.charAt(0).toUpperCase() + s.slice(1);
    };
    switch (state.phase) {
      case "ready":
        if (n === 1)
          return {
            tone: "action",
            step: "Before chunk 1",
            title: "Press G to raise the build plane",
            detail:
              "Then " +
              press("next") +
              " to put chunk 1 in your hand. Without the plane, later chunks land too high.",
          };
        // a later chunk selected but not sent (Back after the end)
        return {
          tone: "action",
          step: which + " selected",
          title: cap(press("next")) + " to put chunk " + n + " in your hand",
          detail:
            "It is not in your hand yet (" +
            c.send.label +
            " does the same). Keep the camera and the mouse still.",
        };
      case "sending":
        return { tone: "wait", step: which, title: "Putting chunk " + n + " in your hand…", detail: "" };
      case "inHand":
        return {
          tone: "action",
          step: which + " in hand",
          title: n === 1 ? "Click one spot to place it" : "Click the same spot",
          detail:
            (n === 1 ? "Hold the click briefly, then " : "Don't move the camera. Then ") +
            press("next") +
            (last ? " to finish." : " for chunk " + (n + 1) + ".") +
            (n === 1 ? " Keep the camera and the mouse still from now on." : ""),
        };
      case "failed":
        return {
          tone: "error",
          step: which,
          title: "Chunk " + n + " didn't reach your hand",
          detail: cap(explainCause(state.cause)) + ", then " + press("again") + ".",
        };
      case "done": {
        // never "your hand is clear": the API cannot see the hand, so every wording leaves the right-click to the GM
        var pillars = "Then delete the two alignment pillars.";
        var cl = state.clear;
        var done = { tone: "done", step: "All chunks placed" };
        if (cl && cl.status === "trying")
          return Object.assign(done, {
            title: "Switching to the picking tool…",
            detail: "If a slab is still in your hand, right-click. " + pillars,
          });
        if (cl && cl.status === "answered")
          return Object.assign(done, {
            title: "Switched to the picking tool",
            detail:
              "Another click won't paste the last chunk. Click the board or dismiss the tool to leave it. " +
              pillars,
          });
        if (cl && cl.status === "refused")
          return Object.assign(done, {
            title: "Right-click to clear your hand",
            detail: cap(explainCause(cl.cause)) + ". " + pillars,
          });
        return Object.assign(done, { title: "Right-click to clear your hand", detail: pillars });
      }
      default:
        return { tone: "idle", step: "", title: "No map loaded", detail: "" };
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
      // after the end the Again control starts over (it resets and waits; nothing goes to the hand)
      send: {
        enabled: loaded && !busy,
        label: state.phase === "done" ? "Start over" : sentOnce ? "Put in hand again" : "Put in hand",
      },
      next: {
        enabled: loaded && !busy && state.phase !== "done",
        // Next on a chunk not yet sent puts it in hand, so it says Finish only once the last chunk has been sent
        label: loaded && state.index + 1 >= total && state.phase !== "ready" ? "Finish" : "Next",
      },
      back: { enabled: loaded && !busy && (state.index > 0 || state.phase === "done"), label: "Back" },
      // the one highlighted button: Next drives the flow; after a refused send, putting it in hand again
      primary: state.phase === "failed" ? "send" : "next",
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

  /**
   * The link light. linkStatus: "off" (Link switched off), "connecting" (first try), "retrying" (a try failed: the
   * bridge is not running or not on this port) or "connected".
   */
  function linkLight(linkStatus) {
    if (linkStatus === "connected")
      return { tone: "good", icon: "●", label: "Connected to Slabyrinth", detail: "" };
    if (linkStatus === "connecting")
      return { tone: "wait", icon: "◐", label: "Connecting to Slabyrinth…", detail: "" };
    if (linkStatus === "retrying")
      return {
        tone: "wait",
        icon: "◌",
        label: "Not connected to Slabyrinth",
        detail: "The bridge is not running. Retrying on its own.",
      };
    return { tone: "off", icon: "○", label: "Link is off", detail: "Turn it on under Link and hotkeys." };
  }

  /**
   * Which API the page uses. found: TaleSpire's API object exists; protocol: location.protocol; waitedMs: time since
   * start; timeoutMs: how long to wait for TaleSpire to inject it (it starts injecting at DOMContentLoaded, so a page
   * cannot decide at that moment).
   * -> { mode: "game" | "waiting" | "missing" | "preview", fake, banner: { tone, text } | null }
   * The fake answers only in a plain browser (file://); in TaleSpire a missing API is shown, never faked.
   */
  function apiMode(found, protocol, waitedMs, timeoutMs) {
    if (found) return { mode: "game", fake: false, banner: null };
    if (protocol === "file:")
      return {
        mode: "preview",
        fake: true,
        banner: {
          tone: "preview",
          text: "Preview: the TaleSpire API is not here. Nothing is being sent to TaleSpire; a fake answers instead.",
        },
      };
    if (waitedMs < timeoutMs)
      return {
        mode: "waiting",
        fake: false,
        banner: { tone: "wait", text: "Waiting for TaleSpire's API to start…" },
      };
    return {
      mode: "missing",
      fake: false,
      banner: {
        tone: "error",
        text:
          "TaleSpire's API did not appear, so nothing can be put in your hand. Reload the symbiote; if this stays," +
          " send the readout under Developer tools > Diagnostics.",
      },
    };
  }

  var BLOCKING = { clientIsNotInGmMode: "not in GM mode", notInBoard: "not on a board" };

  /**
   * The slabs light. `clientMode` is what TaleSpire last reported ("gm", "player", "spectator" or null when unknown);
   * a board problem is only known from a refused send (the API has no "am I on a board" answer used here).
   * Progress is the progress bar's job and "all placed" the status line's, so the light says only loaded or not, or
   * what blocks pasting.
   */
  function slabsLight(state, clientMode, apiMissing) {
    if (!state.set) return { tone: "off", icon: "○", label: "No slabs loaded" };
    var blocked = apiMissing
      ? "TaleSpire's API is missing"
      : clientMode && clientMode !== "gm"
        ? BLOCKING.clientIsNotInGmMode
        : state.phase === "failed" && Object.prototype.hasOwnProperty.call(BLOCKING, state.cause)
          ? BLOCKING[state.cause]
          : null;
    if (blocked) return { tone: "bad", icon: "⚠", label: "Blocked: " + blocked };
    return { tone: "good", icon: "●", label: "Slabs are ready to paste" };
  }

  // ── appearance: two looks over one structure (Settings > Appearance), remembered in the panel ──

  // the first is the default
  var DESIGNS = [
    {
      id: "slabyrinth",
      name: "Slabyrinth",
      summary: "The Slabyrinth app's own colours, gold accent and buttons.",
    },
    {
      id: "native",
      name: "Native",
      summary: "TaleSpire's own panel colours and type, so the helper reads as part of the game.",
    },
  ];

  // ── after the last chunk: switch to the picking tool so another click cannot paste it ──
  // The API has no call that clears the hand. Starting the picking tool switches tool, which drops the slab in hand
  // (Test K, in game). Sending an empty slab was tried and crashed TaleSpire's slab spawn (divide by zero), so it is
  // gone, and slabHasRoomForAnAsset keeps any empty slab from being sent.

  // the first is the default
  var CLEAR_METHODS = [
    { id: "picking", name: "Switch to the picking tool so nothing more can be pasted" },
    { id: "off", name: "Do nothing (right-click yourself)" },
  ];

  /** The method to use: a saved id when it is one of CLEAR_METHODS, else the first (the removed "empty" too). */
  function pickClearMethod(saved) {
    for (var i = 0; i < CLEAR_METHODS.length; i++) if (CLEAR_METHODS[i].id === saved) return saved;
    return CLEAR_METHODS[0].id;
  }

  /** The look to show: a saved id when it is one of DESIGNS, else the first (also for a removed look's id). */
  function pickDesign(saved) {
    for (var i = 0; i < DESIGNS.length; i++) if (DESIGNS[i].id === saved) return saved;
    return DESIGNS[0].id;
  }

  root.SlabyrinthSequencer = {
    slabRawSize: slabRawSize,
    slabHasRoomForAnAsset: slabHasRoomForAnAsset,
    shortError: shortError,
    CLEAR_METHODS: CLEAR_METHODS,
    pickClearMethod: pickClearMethod,
    DESIGNS: DESIGNS,
    pickDesign: pickDesign,
    mapInfo: mapInfo,
    apiMode: apiMode,
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
    guide: guide,
    progress: progress,
    controls: controls,
  };
})(globalThis);
