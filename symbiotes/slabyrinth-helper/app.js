/**
 * Slabyrinth Helper: the page. Wires the TaleSpire Symbiote API (v0.1) to the sequencer and the DOM.
 *
 * A classic script: TaleSpire calls the manifest's subscription handlers by global name, so the handlers below are
 * top-level function declarations (the docs say a handler in a scoped variable is not visible to the API).
 * When the `TS` object is absent (a plain browser), a clearly labelled fake stands in and nothing reaches TaleSpire.
 */
/* exported handleStateChange, handleVisibility, handleSlabCopied, handleClientEvent, handlePickingEvent */
/* global SlabyrinthSequencer, SLABYRINTH_TEST_PAIR */
"use strict";

const Seq = SlabyrinthSequencer;
const DEFAULT_PORT = 48731;
const LOG_LIMIT = 200;

let api = null; // the real TS object or the fake
let preview = false;
let apiReady = false;
let maxBytes = Seq.DEFAULT_MAX_BYTES;
let state = Seq.initialState();
const events = [];

// ── API access ──

/** A preview stand-in for TS: answers like TaleSpire would, sends nothing anywhere. */
function makeFakeApi() {
  const wait = (v) => new Promise((r) => setTimeout(() => r(v), 150));
  return {
    slabs: {
      sendSlabToHand: () => wait(undefined),
      getMaxSlabSizeInBytes: () => wait(30720),
      getDataSize: (s) => wait(Math.floor((s.length / 4) * 3)),
    },
    clients: {
      whoAmI: () => wait({ id: "preview-client" }),
      getMoreInfo: () => wait([{ id: "preview-client", clientMode: "gm" }]),
      isMe: () => wait(true),
    },
  };
}

/** The cause of a failed call, or null on success. Handles both a resolved `{ cause }` and a rejected promise. */
function causeOf(result) {
  if (result && typeof result === "object" && !Array.isArray(result) && "cause" in result)
    return String(result.cause);
  return null;
}

async function call(path, ...args) {
  if (!api) return { ok: false, cause: "noApi" };
  if (!apiReady) return { ok: false, cause: "notInitialized" };
  const parts = path.split(".");
  let fn = api;
  for (const p of parts) fn = fn ? fn[p] : undefined;
  if (typeof fn !== "function") return { ok: false, cause: "missing function " + path };
  const thisArg = parts.slice(0, -1).reduce((o, p) => (o ? o[p] : undefined), api);
  try {
    const value = await fn.apply(thisArg, args);
    const cause = causeOf(value);
    return cause ? { ok: false, cause, raw: value } : { ok: true, value };
  } catch (e) {
    const cause = causeOf(e) || (e && e.message) || String(e);
    return { ok: false, cause, raw: e };
  }
}

// ── event log ──

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** A short, safe text of an event payload (slab strings abbreviated). */
function summarise(payload) {
  try {
    const text = JSON.stringify(payload, (k, v) =>
      typeof v === "string" && v.length > 100 ? `${v.slice(0, 24)}… (${v.length} chars)` : v,
    );
    return text === undefined ? "" : text.length > 300 ? text.slice(0, 300) + "…" : text;
  } catch {
    return String(payload);
  }
}

function logEvent(source, kind, payload, mine = false) {
  events.unshift({ at: stamp(), source, kind, detail: summarise(payload), mine });
  if (events.length > LOG_LIMIT) events.length = LOG_LIMIT;
  renderLog();
}

// ── subscription handlers (names match manifest.json) ──

function handleStateChange(e) {
  logEvent("symbiote.onStateChangeEvent", e && e.kind, e && e.payload);
  if (e && e.kind === "hasInitialized") onApiReady();
}

function handleVisibility(e) {
  logEvent("symbiote.onVisibilityEvent", e && e.kind, e && e.payload);
}

function handleSlabCopied(e) {
  logEvent("slabs.onSlabCopied", e && e.kind, e && e.payload);
  if (!e || e.kind !== "slabCopied" || !e.payload) return;
  const p = e.payload;
  setText("copied-status", String(p.status));
  setText("copied-size", `${p.dataSize} bytes (limit ${maxBytes})`);
  setText("copied-length", typeof p.slab === "string" ? `${p.slab.length} characters` : "none");
  setText("copied-at", stamp());
  el("copied-slab").value = typeof p.slab === "string" ? p.slab : "";
}

function handleClientEvent(e) {
  logEvent("clients.onClientEvent", e && e.kind, e && e.payload);
  if (e && e.kind === "clientModeChanged") void refreshMode();
}

function handlePickingEvent(e) {
  logEvent("picking.onPickingEvent", e && e.kind, e && e.payload);
}

// ── start-up ──

async function onApiReady() {
  if (apiReady) return;
  // hasInitialized may arrive before DOMContentLoaded when the page loads fast; take the API object here too
  if (!api && typeof window.TS === "object" && window.TS) api = window.TS;
  apiReady = true;
  if (!el("banner")) return; // start() renders the rest once the DOM is there
  renderBanner();
  const max = await call("slabs.getMaxSlabSizeInBytes");
  if (max.ok && typeof max.value === "number") maxBytes = max.value;
  setText("diag-max", max.ok ? `${max.value} bytes` : `not available (${max.cause})`);
  await refreshMode();
  render();
}

async function refreshMode() {
  const me = await call("clients.whoAmI");
  if (!me.ok || !me.value) return setText("diag-mode", `unknown (${me.ok ? "no client" : me.cause})`);
  const info = await call("clients.getMoreInfo", [me.value.id]);
  const mode = info.ok && Array.isArray(info.value) && info.value[0] ? info.value[0].clientMode : null;
  setText(
    "diag-mode",
    mode ? (mode === "gm" ? "gm (GM mode)" : `${mode} (not GM mode)`) : `unknown (${info.cause})`,
  );
}

function start() {
  const ts = typeof window.TS === "object" && window.TS ? window.TS : null;
  preview = !ts;
  api = ts || makeFakeApi();
  setText("diag-api-version", "0.1 (from manifest.json; the API has no version getter)");
  setText("diag-namespaces", ts ? Object.keys(ts).sort().join(", ") : "none (preview)");
  setText("diag-origin", location.href);
  el("port").value = String(DEFAULT_PORT);
  bindUi();
  renderKeys();
  renderBanner();
  render();
  if (preview) void onApiReady();
  else if (apiReady) {
    // the API started before the DOM: fill in what onApiReady skipped
    apiReady = false;
    void onApiReady();
  }
}

// ── chunk flow ──

function dispatch(action) {
  const { state: next, effect } = Seq.reduce(state, action);
  state = next;
  render();
  if (effect && effect.type === "send") void sendChunk(effect.index);
}

async function sendChunk(index) {
  const chunk = state.set.chunks[index];
  logEvent("helper", `sendSlabToHand chunk ${index + 1}`, { label: chunk.label, bytes: chunk.bytes }, true);
  const r = await call("slabs.sendSlabToHand", chunk.slab);
  logEvent("helper", r.ok ? "sendSlabToHand ok" : "sendSlabToHand failed", r.ok ? r.value : r.cause, true);
  dispatch({ type: "sent", index, ok: r.ok, cause: r.cause });
}

function loadText(text, source) {
  const parsed = Seq.parseChunkSet(text, maxBytes);
  if (!parsed.ok) {
    setText("load-error", parsed.error);
    el("load-error").hidden = false;
    return;
  }
  el("load-error").hidden = true;
  logEvent("helper", `loaded ${parsed.set.chunks.length} chunks (${source})`, parsed.set.name, true);
  dispatch({ type: "load", set: parsed.set });
}

// ── local connection test ──

async function testLocal() {
  const port = Number(el("port").value);
  const out = el("local-result");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    out.textContent = "Type a port between 1024 and 65535.";
    return;
  }
  const lines = [`Page origin: ${location.origin || "(none)"}`];
  const show = () => (out.textContent = lines.join("\n"));
  show();
  const url = `http://127.0.0.1:${port}/probe`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `fetch from Slabyrinth Helper at ${location.href}`,
      signal: ctl.signal,
    });
    clearTimeout(timer);
    lines.push(`HTTP fetch ${url}: status ${res.status}, reply "${(await res.text()).slice(0, 120)}"`);
  } catch (e) {
    lines.push(
      `HTTP fetch ${url}: FAILED (${e && e.name ? e.name + ": " : ""}${e && e.message ? e.message : e})`,
    );
  }
  show();
  lines.push(await new Promise((resolve) => wsProbe(port, resolve)));
  show();
}

function wsProbe(port, resolve) {
  const url = `ws://127.0.0.1:${port}/`;
  let done = false;
  const finish = (text) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve(`WebSocket ${url}: ${text}`);
  };
  const timer = setTimeout(() => finish("FAILED (no answer in 4 s)"), 4000);
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    finish(`FAILED (${e && e.message ? e.message : e})`);
    return;
  }
  ws.onopen = () => ws.send("hello from Slabyrinth Helper");
  ws.onmessage = (m) => {
    finish(`open, reply "${String(m.data).slice(0, 120)}"`);
    ws.close();
  };
  ws.onerror = () => finish("FAILED (error event; see the server window for whether it connected)");
  ws.onclose = (c) => finish(`closed before a reply (code ${c.code})`);
}

// ── rendering ──

function el(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

function renderBanner() {
  const b = el("banner");
  b.hidden = !preview && apiReady;
  b.className = preview ? "banner preview" : "banner";
  b.textContent = preview
    ? "Preview: the TaleSpire API is not here. Nothing is being sent to TaleSpire; a fake answers instead."
    : "Waiting for TaleSpire's API to start…";
}

function render() {
  const s = Seq.statusLine(state);
  const status = el("status");
  status.textContent = s.text;
  status.className = `status ${s.tone}`;
  const p = Seq.progress(state);
  el("progress").max = Math.max(p.total, 1);
  el("progress").value = p.placed;
  setText("progress-text", p.total ? `${p.placed} of ${p.total} placed` : "No chunks loaded");
  setText("set-name", state.set ? state.set.name : "");
  const c = Seq.controls(state);
  for (const [id, b] of [
    ["btn-send", c.send],
    ["btn-next", c.next],
    ["btn-back", c.back],
  ]) {
    el(id).disabled = !b.enabled;
    el(id).textContent = b.label;
  }
  // one highlighted button: the step the status line asks for
  el("btn-send").classList.toggle("primary", state.phase !== "inHand");
  el("btn-next").classList.toggle("primary", state.phase === "inHand");
  const list = el("chunk-list");
  list.replaceChildren();
  if (state.set)
    state.set.chunks.forEach((ch, i) => {
      const li = document.createElement("li");
      const mark = i < p.placed ? "placed" : i === state.index ? "current" : "waiting";
      li.className = mark;
      li.textContent = `${ch.label} — ${ch.bytes} bytes`;
      if (i === state.index && state.phase !== "done") li.setAttribute("aria-current", "step");
      list.append(li);
    });
}

function renderLog() {
  const list = el("event-log");
  if (!list) return;
  list.replaceChildren(
    ...events.map((e) => {
      const li = document.createElement("li");
      if (e.mine) li.className = "mine";
      li.textContent = `${e.at}  ${e.source}  ${e.kind || ""}  ${e.detail}`;
      return li;
    }),
  );
}

function showTab(name) {
  for (const t of ["main", "log", "diag"]) {
    el(`tab-${t}`).setAttribute("aria-selected", String(t === name));
    el(`panel-${t}`).hidden = t !== name;
  }
}

function bindUi() {
  el("btn-load").addEventListener("click", () => loadText(el("blob").value, "pasted"));
  el("btn-test-pair").addEventListener("click", () => {
    const pair = typeof SLABYRINTH_TEST_PAIR === "object" ? SLABYRINTH_TEST_PAIR : null;
    if (!pair) {
      setText("load-error", "The bundled test pair (test-pair.js) is missing from this folder.");
      el("load-error").hidden = false;
      return;
    }
    loadText(JSON.stringify(pair), "bundled test pair");
  });
  el("btn-send").addEventListener("click", () => dispatch({ type: "send" }));
  el("btn-next").addEventListener("click", () => dispatch({ type: "next" }));
  el("btn-back").addEventListener("click", () => dispatch({ type: "back" }));
  el("btn-clear-log").addEventListener("click", () => {
    events.length = 0;
    renderLog();
  });
  el("btn-local").addEventListener("click", () => void testLocal());
  for (const t of ["main", "log", "diag"]) el(`tab-${t}`).addEventListener("click", () => showTab(t));
  for (const which of ["next", "back"])
    el(`key-${which}`).addEventListener("click", () => {
      capturing = which;
      renderKeys();
    });
  // capture phase, so a focused button or text box cannot swallow the key first
  window.addEventListener("keydown", onKey, true);
  // focus moves tell us whether the panel still has the keyboard after a click on the board
  window.addEventListener("focus", () =>
    logEvent("window", "focus", { hasFocus: document.hasFocus() }, true),
  );
  window.addEventListener("blur", () => logEvent("window", "blur", { hasFocus: document.hasFocus() }, true));
  document.addEventListener("visibilitychange", () =>
    logEvent("document", "visibilitychange", { visibilityState: document.visibilityState }, true),
  );
}

// ── keys ──
// The symbiote API has no hotkey or keyboard API, so these are ordinary page key events: they only arrive while
// the symbiote panel has keyboard focus. The Diagnostics tab shows the last key that arrived, to find out.

const KEYS_STORE = "slabyrinth-helper.keys";
let keys = loadKeys();
let capturing = null; // "next" | "back" while the GM is choosing a key

function loadKeys() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(KEYS_STORE) || "null");
    if (saved && typeof saved.next === "string" && typeof saved.back === "string") return saved;
  } catch {
    // storage blocked or damaged: use the defaults
  }
  return { ...Seq.DEFAULT_KEYS };
}

function saveKeys() {
  try {
    window.localStorage.setItem(KEYS_STORE, JSON.stringify(keys));
  } catch {
    // not saved; the keys still work until the panel reloads
  }
}

function onKey(e) {
  const combo = Seq.keyCombo(e);
  if (!combo) return;
  let did = "nothing";
  if (capturing) {
    if (combo === "Escape") did = "key choice cancelled";
    else {
      keys = { ...keys, [capturing]: combo };
      saveKeys();
      did = `set as the ${capturing === "next" ? "Next" : "Back"} key`;
    }
    capturing = null;
    e.preventDefault();
  } else {
    const action = Seq.keyAction(e, keys);
    if (action) {
      e.preventDefault();
      const enabled = Seq.controls(state)[action].enabled;
      did = enabled
        ? `pressed ${action === "next" ? "Next" : "Back"}`
        : `${action} key, but that button is off now`;
      if (enabled) dispatch({ type: action });
    }
  }
  setText("key-last", combo);
  setText("key-at", stamp());
  setText("key-focus", document.hasFocus() ? "yes" : "no");
  setText("key-did", did);
  logEvent("keyboard", combo, did, true);
  renderKeys();
}

function renderKeys() {
  for (const which of ["next", "back"])
    el(`key-${which}`).textContent = capturing === which ? "Press a key… (Esc cancels)" : keys[which];
  setText("keys-hint", `Keys: ${keys.next} = Next, ${keys.back} = Back (while this panel has the keyboard).`);
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
