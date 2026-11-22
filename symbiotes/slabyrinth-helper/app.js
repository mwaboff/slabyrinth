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
let clientMode = null; // "gm", "player", "spectator" as TaleSpire last reported, or null
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
  clientMode = typeof mode === "string" ? mode : null;
  renderHeader();
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
  loadLinkSettings();
  renderLink();
  linkConnect();
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

/** Applies an action; resolves once any slab it sends has been answered by TaleSpire. */
function dispatch(action) {
  const { state: next, effect } = Seq.reduce(state, action);
  state = next;
  render();
  return effect && effect.type === "send" ? sendChunk(effect.index) : Promise.resolve();
}

async function sendChunk(index) {
  const chunk = state.set.chunks[index];
  logEvent("helper", `sendSlabToHand chunk ${index + 1}`, { label: chunk.label, bytes: chunk.bytes }, true);
  const r = await call("slabs.sendSlabToHand", chunk.slab);
  logEvent("helper", r.ok ? "sendSlabToHand ok" : "sendSlabToHand failed", r.ok ? r.value : r.cause, true);
  await dispatch({ type: "sent", index, ok: r.ok, cause: r.cause });
}

// ── link to the hotkey bridge (symbiotes/hotkey-bridge.mjs) ──
// The bridge's global shortcuts arrive here as messages over a WebSocket on 127.0.0.1 and drive the same actions as
// the buttons. Reconnects with backoff while Link is on; the setting is remembered in this panel.

const LINK_STORE = "slabyrinth-helper.link";
const link = { on: false, port: DEFAULT_PORT, ws: null, connected: false, retry: null, delay: 1000 };

function loadLinkSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LINK_STORE) || "null");
    if (saved && typeof saved.on === "boolean") link.on = saved.on;
    if (saved && Number.isInteger(saved.port)) link.port = saved.port;
  } catch {
    // storage blocked or damaged: Link starts off
  }
}

function saveLinkSettings() {
  try {
    window.localStorage.setItem(LINK_STORE, JSON.stringify({ on: link.on, port: link.port }));
  } catch {
    // not saved
  }
}

function linkConnect() {
  clearTimeout(link.retry);
  if (!link.on || link.ws) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${link.port}/`);
  } catch (e) {
    logEvent("link", "could not open", e && e.message, true);
    return linkRetry();
  }
  link.ws = ws;
  renderLink();
  ws.onopen = () => {
    link.connected = true;
    link.delay = 1000;
    logEvent("link", "connected", { port: link.port }, true);
    renderLink();
    linkSend(Seq.linkReply(state, null));
    sendHotkeys(); // the hotkeys set here win over the bridge's command-line ones
  };
  ws.onmessage = (m) => void onLinkMessage(m.data);
  ws.onclose = () => {
    if (link.ws !== ws) return; // an old socket closing after Link was switched off and on
    if (link.connected) logEvent("link", "disconnected", null, true);
    link.ws = null;
    link.connected = false;
    renderLink();
    linkRetry();
  };
  ws.onerror = () => {}; // onclose follows and retries
}

function linkRetry() {
  if (!link.on) return;
  link.retry = setTimeout(linkConnect, link.delay);
  link.delay = Math.min(link.delay * 2, 15000);
}

function linkDisconnect() {
  clearTimeout(link.retry);
  link.delay = 1000;
  if (link.ws) link.ws.close();
  link.ws = null;
  link.connected = false;
  renderLink();
}

function linkSend(obj) {
  if (link.ws && link.connected) link.ws.send(JSON.stringify(obj));
}

async function onLinkMessage(text) {
  const msg = Seq.parseLinkMessage(typeof text === "string" ? text : "");
  if (!msg) {
    logEvent("link", "ignored a malformed message", String(text).slice(0, 120), true);
    return;
  }
  logEvent("link", `received ${msg.type}`, msg.type === "hotkeys-result" ? msg.results : msg.id, true);
  if (msg.type === "hotkeys-result") {
    hk.results = msg.results;
    hk.pending = false;
    // a refused hotkey is not kept: the setting shows what the bridge still uses
    let changed = false;
    for (const [a, r] of Object.entries(msg.results))
      if (r.status === "refused" && hk.stored[a] === r.wanted) {
        const rest = Object.fromEntries(Object.entries(hk.stored).filter(([k]) => k !== a));
        hk.stored = r.combo ? { ...rest, [a]: r.combo } : rest;
        changed = true;
      }
    if (changed) saveHotkeys();
    renderHotkeys();
    return;
  }
  const cmd = Seq.linkCommand(msg, maxBytes);
  if (cmd.error) {
    linkSend(Seq.linkReply(state, msg.id, cmd.error));
    return;
  }
  if (cmd.action && cmd.action.type === "load") el("load-error").hidden = true;
  if (cmd.action) await dispatch(cmd.action);
  linkSend(Seq.linkReply(state, msg.id));
}

// ── global hotkeys: set here, registered by the bridge ──

const HOTKEYS_STORE = "slabyrinth-helper.hotkeys";
// stored: only the hotkeys the GM set; results: the bridge's last answer; pending: a change not yet answered
const hk = { stored: loadHotkeys(), results: null, pending: false, capturing: null, note: {}, nextId: 1 };

function loadHotkeys() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(HOTKEYS_STORE) || "null");
    const out = {};
    if (saved && typeof saved === "object")
      for (const a of Seq.HOTKEY_ACTIONS) {
        const c = Seq.checkHotkey(saved[a]);
        if (c.ok) out[a] = c.combo;
      }
    return out;
  } catch {
    return {};
  }
}

function saveHotkeys() {
  try {
    if (Object.keys(hk.stored).length) window.localStorage.setItem(HOTKEYS_STORE, JSON.stringify(hk.stored));
    else window.localStorage.removeItem(HOTKEYS_STORE);
  } catch {
    // not saved; the bridge still gets the change now
  }
}

/** Sends the GM's hotkeys to the bridge (all three on reset, else only the ones set here). */
function sendHotkeys(wanted = hk.stored) {
  if (!link.connected) return;
  hk.pending = true;
  linkSend(Seq.hotkeysMessage(wanted, hk.nextId++));
  renderHotkeys();
}

function setHotkey(action, combo) {
  const c = Seq.checkHotkey(combo);
  if (!c.ok) {
    hk.note[action] = `Not allowed: ${c.reason}.`;
    return;
  }
  hk.note[action] = null;
  hk.stored = { ...hk.stored, [action]: c.combo };
  saveHotkeys();
  sendHotkeys();
}

function resetHotkeys() {
  hk.stored = {};
  hk.note = {};
  saveHotkeys();
  sendHotkeys({ ...Seq.DEFAULT_HOTKEYS });
  renderHotkeys();
}

function renderHotkeys() {
  for (const a of Seq.HOTKEY_ACTIONS) {
    const b = el(`hk-${a}`);
    if (!b) return;
    const r = hk.results ? hk.results[a] : null;
    const current = hk.stored[a] || (r && r.combo) || `${Seq.DEFAULT_HOTKEYS[a]}`;
    b.textContent = hk.capturing === a ? "Press keys… (Esc cancels)" : current;
    let text;
    let tone = "";
    if (hk.note[a]) {
      text = hk.note[a];
      tone = "bad";
    } else if (!link.connected) text = "Applies when the bridge connects.";
    else if (hk.pending) text = "Asking the bridge…";
    else if (!r) text = "";
    else if (r.status === "active") {
      text = "Active";
      tone = "good";
    } else if (r.status === "refused") {
      text = `${r.wanted || "That key"} refused (${r.reason}). ${r.combo ? `Still using ${r.combo}.` : "No hotkey set."}`;
      tone = "bad";
    } else text = r.reason ? `Not set (${r.reason})` : "Not set";
    const out = el(`hk-${a}-result`);
    out.textContent = text;
    out.className = `hk-result ${tone}`;
  }
}

function renderLink() {
  const dot = el("link-state");
  if (!dot) return;
  const text = !link.on ? "Off" : link.connected ? "Connected" : link.ws ? "Connecting…" : "Not connected";
  dot.textContent = text;
  dot.className = `link-state ${link.connected ? "on" : link.on ? "waiting" : "off"}`;
  el("link-on").checked = link.on;
  el("link-port").value = String(link.port);
  renderHotkeys();
  renderHeader();
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

/** The two lights at the top: state at a glance (the status line below says what to do). */
function renderHeader() {
  const info = Seq.mapInfo(state.set);
  const box = el("map-info");
  if (box) {
    box.hidden = !info;
    // textContent only: the name comes from a pasted or pushed file
    setText("map-name", info ? info.title : "");
    el("map-name").title = info ? info.title : "";
    setText("map-meta", info ? info.meta : "");
  }
  const lights = {
    "light-link": Seq.linkLight(link.connected ? "connected" : link.on ? "connecting" : "off"),
    "light-slabs": Seq.slabsLight(state, clientMode),
  };
  for (const [id, l] of Object.entries(lights)) {
    const node = el(id);
    if (!node) return;
    const cls = `light ${l.tone}`;
    if (node.className.replace(" changed", "") !== cls) {
      node.className = cls;
      void node.offsetWidth; // restart the brief change highlight
      node.classList.add("changed");
    }
    node.querySelector(".light-icon").textContent = l.icon;
    node.querySelector(".light-label").textContent = l.label;
  }
}

let shown = ""; // the step last shown, to flash the status block when it changes

function render() {
  const s = Seq.statusLine(state);
  const status = el("status");
  status.textContent = s.text;
  status.className = `status ${s.tone}`;
  // a brief flash on each new step, noticeable from the corner of the eye while watching the board
  const step = `${state.index}:${state.phase}`;
  if (step !== shown && state.phase !== "sending" && state.set) {
    void status.offsetWidth; // restart the animation
    status.classList.add("flash");
  }
  shown = step;
  const p = Seq.progress(state);
  el("progress").max = Math.max(p.total, 1);
  el("progress").value = p.placed;
  setText("progress-text", `${p.placed} of ${p.total} placed`);
  renderHeader();
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
  for (const a of Seq.HOTKEY_ACTIONS) {
    el(`hk-${a}`).addEventListener("click", () => {
      hk.capturing = a;
      hk.note[a] = null;
      renderHotkeys();
    });
    el(`hk-${a}`).addEventListener("blur", () => {
      if (hk.capturing === a) hk.capturing = null;
      renderHotkeys();
    });
  }
  el("hk-reset").addEventListener("click", resetHotkeys);
  el("link-on").addEventListener("change", () => {
    link.on = el("link-on").checked;
    saveLinkSettings();
    if (link.on) linkConnect();
    else linkDisconnect();
    renderLink();
  });
  el("link-port").addEventListener("change", () => {
    const p = Number(el("link-port").value);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) return renderLink();
    link.port = p;
    saveLinkSettings();
    linkDisconnect();
    linkConnect();
  });
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
  if (hk.capturing) {
    // recording a global hotkey: wait for a non-modifier key, by physical key
    const hot = Seq.hotkeyCombo(e);
    if (!hot) return;
    e.preventDefault();
    const action = hk.capturing;
    hk.capturing = null;
    if (hot !== "Escape") setHotkey(action, hot);
    renderHotkeys();
    return;
  }
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
  setText(
    "keys-hint",
    `Panel keys (only while this panel has the keyboard): ${keys.next} = Next, ${keys.back} = Back. ` +
      "For keys that work while you play, use the hotkey bridge below.",
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
