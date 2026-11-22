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
    return { ok: true, set: { name: data.name.trim(), chunks: chunks } };
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
              ? which + " is ready. Press “Put in hand”, then place it in TaleSpire."
              : which + " is ready. Press “Put in hand”. Keep the camera where it is.",
        };
      case "sending":
        return { tone: "wait", text: "Sending " + which.toLowerCase() + " to your hand…" };
      case "inHand":
        return {
          tone: "action",
          text:
            n === 1
              ? which +
                " is in your hand. Click the spot to place it (hold the click briefly), then press " +
                nextWord +
                ". Do not move the camera after this."
              : which +
                " is in your hand. Without moving the camera, click the same spot as chunk 1, then press " +
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
            " chunks are placed. Right-click to empty your hand, then delete the two alignment pillars.",
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
        enabled: loaded && !busy && state.phase !== "done" && state.phase !== "ready",
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

  root.SlabyrinthSequencer = {
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
