/**
 * Slabyrinth Helper: the page. Wires the TaleSpire Symbiote API (v0.1) to the sequencer and the DOM.
 *
 * A classic script: TaleSpire calls the manifest's subscription handlers by global name, so the handlers below are
 * top-level function declarations (the docs say a handler in a scoped variable is not visible to the API).
 * In a plain browser (file://) a clearly labelled fake stands in and nothing reaches TaleSpire; in TaleSpire the page
 * waits for the API and never fakes it.
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

// ── appearance: the look is a data-theme on <html>, set from the panel's storage before the body paints ──
// (this script runs from <head>; TaleSpire keeps the panel's localStorage outside the add-on folder, so a reinstall or
// update from Slabyrinth keeps the choice; a stored look that no longer exists falls back to the default)

const DESIGN_STORE = "slabyrinth-helper.design";

function loadDesign() {
  try {
    return Seq.pickDesign(window.localStorage.getItem(DESIGN_STORE));
  } catch {
    return Seq.pickDesign(null);
  }
}

function applyDesign(id) {
  document.documentElement.dataset.theme = Seq.pickDesign(id);
}

function saveDesign(id) {
  applyDesign(id);
  for (const d of Seq.DESIGNS) {
    const input = el(`design-${d.id}`);
    if (input) input.checked = d.id === document.documentElement.dataset.theme;
  }
  try {
    window.localStorage.setItem(DESIGN_STORE, id);
  } catch {
    // not remembered; the look still changes now
  }
}

applyDesign(loadDesign());

function renderDesignPicker() {
  const list = el("design-list");
  if (!list) return;
  const current = document.documentElement.dataset.theme;
  list.replaceChildren(
    ...Seq.DESIGNS.map((d) => {
      const label = document.createElement("label");
      label.className = "design";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "design";
      input.id = `design-${d.id}`;
      input.value = d.id;
      input.checked = d.id === current;
      input.addEventListener("change", () => saveDesign(d.id));
      const name = document.createElement("span");
      name.className = "design-name";
      name.textContent = d.name;
      const summary = document.createElement("span");
      summary.className = "design-summary";
      summary.textContent = d.summary;
      label.append(input, name, summary);
      return label;
    }),
  );
}

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
    if (cause) recordApiError(path, cause);
    return cause ? { ok: false, cause, raw: value } : { ok: true, value };
  } catch (e) {
    const cause = causeOf(e) || (e && e.message) || String(e);
    recordApiError(path, cause);
    return { ok: false, cause, raw: e };
  }
}

/**
 * Keeps the full text of the last failed API call for Diagnostics (a cause can be a whole .NET exception with its
 * stack trace). The status line never shows it: it gets Seq.explainCause's plain sentence instead.
 */
function recordApiError(path, cause) {
  const text = String(cause);
  setText("api-error-short", `${stamp()} ${path}: ${Seq.shortError(text, 160)}`);
  setText("api-error-full", text);
  const more = el("api-error-more");
  if (more) more.hidden = text.length <= 160 && !text.includes("\n");
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
  if (e && e.kind === "hasInitialized") {
    apiInfo.initAt = stamp();
    if (el("banner")) checkApi();
    void onApiReady();
  }
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
  // the end-of-map picking tool ending (the GM clicked the board or dismissed it): note it, change nothing else
  const id = e && e.payload && e.payload.id;
  if (endPickId !== null && id === endPickId) {
    endPickId = null;
    const how = e.kind === "pickingCompleted" ? "the GM clicked the board" : "the GM dismissed it";
    logEvent("helper", `end-of-map picking tool closed (${how}); nothing picked is used`, null, true);
    setText("clear-last", `${stamp()}: picking tool closed (${how})`);
  }
}

// ── start-up ──

// TaleSpire starts injecting its API when the page's DOMContentLoaded fires (docs: "Symbiote lifetime"), so the API
// may not exist yet when this page's own DOMContentLoaded handler runs. The page therefore never decides at load:
// it waits for the API object (polling) or the hasInitialized event, and uses the fake only in a plain browser.

const API_WAIT_MS = 15000; // longer than the manifest's initTimeout (10 s)
const apiInfo = {
  foundAt: null,
  via: null,
  initAt: null,
  startedAt: Date.now(),
  mode: "waiting",
  atScript: !!findApi(), // did the API exist when this script ran?
  atDomReady: null, // and when the page's DOMContentLoaded handler ran?
};
let apiPoll = null;

/** TaleSpire's API object, if injected: the documented `TS` alias, or its full name. */
function findApi() {
  /* global TS */
  if (typeof TS === "object" && TS !== null) return { ts: TS, via: "TS" };
  const full = window.com && window.com.bouncyrock && window.com.bouncyrock.talespire;
  if (typeof full === "object" && full !== null) return { ts: full, via: "com.bouncyrock.talespire" };
  return null;
}

/** Looks for the API; switches to it (from the fake too) the moment it appears. */
function checkApi() {
  const found = findApi();
  if (found && (api === null || preview)) {
    api = found.ts;
    preview = false;
    apiInfo.foundAt = stamp();
    apiInfo.via = found.via;
    logEvent("helper", "TaleSpire API found", found.via, true);
  }
  const m = Seq.apiMode(!!found, location.protocol, Date.now() - apiInfo.startedAt, API_WAIT_MS);
  if (m.mode === "preview" && !api) {
    api = makeFakeApi();
    preview = true;
    apiReady = true;
  }
  const changed = m.mode !== apiInfo.mode;
  if (changed) logEvent("helper", `API mode: ${m.mode}`, null, true);
  apiInfo.mode = m.mode;
  renderBanner(m.banner);
  if (changed) renderHeader();
  renderApiDiag();
  if (m.mode === "game" || m.mode === "preview") {
    clearInterval(apiPoll);
    apiPoll = null;
    // TaleSpire's own init event normally makes the API ready; after the wait, use it anyway
    if (m.mode === "preview" || apiInfo.initAt || Date.now() - apiInfo.startedAt > API_WAIT_MS)
      void onApiReady();
    else setTimeout(() => void onApiReady(), Math.max(0, API_WAIT_MS - (Date.now() - apiInfo.startedAt)));
  } else if (m.mode === "missing" && apiPoll) {
    // keep looking, more slowly, and switch the moment it appears
    clearInterval(apiPoll);
    apiPoll = setInterval(checkApi, 2000);
  }
}

function renderApiDiag() {
  setText(
    "diag-api-found",
    apiInfo.foundAt
      ? `yes, as ${apiInfo.via}, at ${apiInfo.foundAt}`
      : preview
        ? "no (plain browser)"
        : "not yet",
  );
  setText("diag-init", apiInfo.initAt ? `fired at ${apiInfo.initAt}` : "not yet");
  const yn = (v) => (v === null ? "-" : v ? "yes" : "no");
  setText(
    "diag-api-timing",
    `at script start: ${yn(apiInfo.atScript)}; at DOMContentLoaded: ${yn(apiInfo.atDomReady)}; ` +
      `TaleSpire web view (window.vuplex): ${yn(typeof window.vuplex === "object" && window.vuplex !== null)}`,
  );
  setText(
    "diag-api-mode",
    {
      game: "TaleSpire",
      preview: "Preview (fake API, plain browser)",
      waiting: "waiting for TaleSpire",
      missing: "API missing",
    }[apiInfo.mode],
  );
  const found = findApi();
  setText("diag-namespaces", found ? Object.keys(found.ts).sort().join(", ") || "(none listed)" : "none");
}

let readyFor = null; // the API object the start-up reads below were done for

/** Reads the limits and client mode once per API object (the fake, then the real one if it appears). */
async function onApiReady() {
  const found = findApi();
  if (found && api !== found.ts) {
    api = found.ts;
    preview = false;
  }
  if (!api || readyFor === api || !el("banner")) return; // start() calls again once the DOM is there
  apiReady = true;
  readyFor = api;
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
  apiInfo.atDomReady = !!findApi();
  setText("diag-api-version", "0.1 (from manifest.json; the API has no version getter)");
  setText("diag-origin", location.href);
  bindUi();
  renderDesignPicker();
  renderClearSetting();
  loadLinkSettings();
  renderLink();
  void Promise.all([loadLinkConfig(), loadAddonVersion()]).then(linkConnect);
  renderKeys();
  render();
  apiPoll = setInterval(checkApi, 250);
  checkApi();
}

// ── chunk flow ──

/** Applies an action; resolves once any slab it sends has been answered by TaleSpire. */
function dispatch(action) {
  const { state: next, effect } = Seq.reduce(state, action);
  const changed = next !== state;
  state = next;
  render();
  // the app follows every change (progress, finished), also the ones made with the panel's own buttons
  if (changed) linkSend(Seq.linkReply(state, null));
  if (effect && effect.type === "send") return sendChunk(effect.index);
  if (effect && effect.type === "clearHand") return clearHand();
  return Promise.resolve();
}

// ── experiment: try to empty the hand after the last chunk (Developer tools > Diagnostics) ──

const CLEAR_STORE = "slabyrinth-helper.clearHand";
let clearMethod = loadClearMethod();

function loadClearMethod() {
  try {
    return Seq.pickClearMethod(window.localStorage.getItem(CLEAR_STORE));
  } catch {
    return Seq.pickClearMethod(null);
  }
}

function saveClearMethod(id) {
  clearMethod = Seq.pickClearMethod(id);
  try {
    window.localStorage.setItem(CLEAR_STORE, clearMethod);
  } catch {
    // not remembered; used until the panel reloads
  }
}

let endPickId = null; // the id picking.startPicking returned after the last chunk, until its tool closes

/** After the last chunk: switch to TaleSpire's picking tool, which drops the slab in hand (Test K). */
async function clearHand() {
  const method = clearMethod;
  let r = { ok: true, cause: null };
  if (method === "picking") {
    logEvent("helper", "end of map: picking.startPicking", null, true);
    r = await call("picking.startPicking");
    endPickId = r.ok && typeof r.value === "string" ? r.value : null;
  }
  const said =
    method === "off"
      ? "switched off; nothing done"
      : r.ok
        ? "picking tool started"
        : `refused: ${Seq.shortError(r.cause, 120)}`;
  if (method !== "off") logEvent("helper", `end of map: ${said}`, r.ok ? r.value : r.cause, true);
  setText("clear-last", `${stamp()}: ${said}`);
  await dispatch({ type: "cleared", method, ok: r.ok, cause: r.cause });
}

function renderClearSetting() {
  const box = el("clear-picking");
  if (box) box.checked = clearMethod === "picking";
}

async function sendChunk(index) {
  const chunk = state.set.chunks[index];
  logEvent("helper", `sendSlabToHand slab ${index + 1}`, { label: chunk.label, bytes: chunk.bytes }, true);
  // never send an empty slab: TaleSpire's slab spawn divides by zero on one (the set check refuses them too)
  const r = Seq.slabHasRoomForAnAsset(chunk.slab)
    ? await call("slabs.sendSlabToHand", chunk.slab)
    : { ok: false, cause: "emptySlab" };
  logEvent("helper", r.ok ? "sendSlabToHand ok" : "sendSlabToHand failed", r.ok ? r.value : r.cause, true);
  await dispatch({ type: "sent", index, ok: r.ok, cause: r.cause });
}

// ── link to the Slabyrinth app ──
// The app sends slab sets and its global hotkeys over a WebSocket on 127.0.0.1; they drive the same actions as the
// buttons. The first message is the pairing token from slabyrinth-link.json, which the app wrote when it installed
// this add-on (it names the port too); the app refuses a copy without it (close code 4001). Reconnects with backoff
// while Link is on, reading the pairing file again before every try (so a reinstall heals an open panel); after close
// code 4000 (another paired panel took the link) it waits for the GM. The switch is remembered in this panel.

const LINK_STORE = "slabyrinth-helper.link";
// on by default: it only talks to 127.0.0.1 and retries quietly; `failed` = a try has failed since the last success;
// `refused` = the app refused the pairing; `replaced` = another panel took the link; `config` = the pairing file
// ({ port, token }), or null
const link = {
  on: true,
  port: DEFAULT_PORT,
  ws: null,
  connected: false,
  failed: false,
  refused: false,
  replaced: false,
  config: null,
  retry: null,
  delay: 1000,
};

/** The link light's state: off, connecting (first try), retrying, unpaired, replaced or connected. */
function linkStatus() {
  if (!link.on) return "off";
  if (link.connected) return "connected";
  if (link.replaced) return "replaced";
  if (link.refused) return "unpaired";
  return link.failed ? "retrying" : "connecting";
}

/** Reads the pairing file from this add-on's own folder (same origin; nothing leaves this computer). */
async function loadLinkConfig() {
  let text = null;
  try {
    const res = await fetch(Seq.LINK_CONFIG_FILE, { cache: "no-store" });
    if (res.ok) text = await res.text();
  } catch {
    // a plain-browser preview (file://) or no pairing file: the app will refuse the link and say so
  }
  link.config = text === null ? null : Seq.parseLinkConfig(text);
  link.port = link.config ? link.config.port : DEFAULT_PORT;
  setText(
    "diag-pairing",
    link.config
      ? `paired (port ${link.config.port})`
      : "no pairing file: install the add-on from the Slabyrinth app",
  );
  renderLink();
}

/** This add-on's version, from its manifest (for the app's "is it up to date"). */
let addonVersion = null;
async function loadAddonVersion() {
  try {
    const res = await fetch("manifest.json", { cache: "no-store" });
    const m = res.ok ? await res.json() : null;
    if (m && typeof m.version === "string") addonVersion = m.version.slice(0, 32);
  } catch {
    // a preview from disk: the app is told no version
  }
}

function loadLinkSettings() {
  try {
    const saved = JSON.parse(window.localStorage.getItem(LINK_STORE) || "null");
    if (saved && typeof saved.on === "boolean") link.on = saved.on;
  } catch {
    // storage blocked or damaged: the defaults stand (Link on)
  }
}

function saveLinkSettings() {
  try {
    window.localStorage.setItem(LINK_STORE, JSON.stringify({ on: link.on }));
  } catch {
    // not saved
  }
}

function linkConnect() {
  clearTimeout(link.retry);
  if (!link.on || link.ws) return;
  let ws;
  try {
    ws = new WebSocket(`ws://127.0.0.1:${link.port}/link`);
  } catch (e) {
    logEvent("link", "could not open", e && e.message, true);
    link.failed = true;
    return linkRetry();
  }
  link.ws = ws;
  renderLink();
  ws.onopen = () => {
    link.connected = true;
    link.failed = false;
    link.delay = 1000;
    logEvent("link", "connected", { port: link.port }, true);
    // pairing first: the app reads nothing else from a connection until it has the token
    linkSend(Seq.helloMessage(link.config ? link.config.token : "unpaired", addonVersion));
    renderLink();
    linkSend(Seq.linkReply(state, null));
    sendHotkeys(); // the hotkeys set here win over the app's defaults
  };
  ws.onmessage = (m) => void onLinkMessage(m.data);
  ws.onclose = (c) => {
    if (link.ws !== ws) return; // an old socket closing after Link was switched off and on
    if (link.connected) logEvent("link", "disconnected", { code: c.code }, true);
    const after = Seq.linkAfterClose(c.code);
    link.ws = null;
    link.connected = false;
    link.failed = true;
    link.refused = after.status === "unpaired";
    link.replaced = after.status === "replaced";
    if (link.replaced) logEvent("link", "another Slabyrinth panel took the link; not retrying", null, true);
    renderLink();
    if (!after.retry) return;
    linkRetry();
    // refused for the pairing: a reinstall may have written a new pairing file, so look now
    if (link.refused) void linkRepair();
  };
  ws.onerror = () => {}; // onclose follows and retries
}

function linkRetry() {
  if (!link.on) return;
  clearTimeout(link.retry);
  link.retry = setTimeout(() => void linkReconnect(), link.delay);
  link.delay = Math.min(link.delay * 2, 15000);
}

/** A try: the pairing file is read again first (a reinstall, or a new token from Slabyrinth). */
async function linkReconnect() {
  if (!link.on || link.ws || link.replaced) return;
  await loadLinkConfig();
  linkConnect();
}

/** After a pairing refusal: read the pairing file now, and connect at once if it changed. */
async function linkRepair() {
  const before = link.config;
  await loadLinkConfig();
  if (!link.on || link.ws || link.replaced || !Seq.pairingChanged(before, link.config)) return;
  logEvent("link", "pairing file changed; connecting again", null, true);
  link.delay = 1000;
  linkConnect();
}

function linkDisconnect() {
  clearTimeout(link.retry);
  link.delay = 1000;
  if (link.ws) link.ws.close();
  link.ws = null;
  link.connected = false;
  link.failed = false;
  link.refused = false;
  link.replaced = false;
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
    // a refused hotkey is not kept: the setting shows what the app still uses
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

// ── global hotkeys: set here, registered by Slabyrinth while a map is being placed ──

const HOTKEYS_STORE = "slabyrinth-helper.hotkeys";
// stored: only the hotkeys the GM set; results: Slabyrinth's last answer; pending: a change not yet answered
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
    // not saved; Slabyrinth still gets the change now
  }
}

/** Sends the GM's hotkeys to Slabyrinth (all three on reset, else only the ones set here). */
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
    } else if (!link.connected) text = "Applies when Slabyrinth connects.";
    else if (hk.pending) text = "Asking Slabyrinth…";
    else if (!r) text = "";
    else if (r.status === "active") {
      text = "Active";
      tone = "good";
    } else if (r.status === "standby") {
      text = "Ready: works while a map is being placed.";
    } else if (r.status === "refused") {
      text = `${r.wanted || "That key"} refused (${r.reason}). ${r.combo ? `Still using ${r.combo}.` : "No hotkey set."}`;
      tone = "bad";
    } else text = r.reason ? `Not set (${r.reason})` : "Not set";
    const out = el(`hk-${a}-result`);
    out.textContent = text;
    out.className = `hk-result ${tone}`;
  }
  renderNow();
}

/** The global hotkeys that work right now (the link is up and Slabyrinth holds them), or null. */
function activeHotkeys() {
  if (!link.connected || !hk.results) return null;
  const out = {};
  for (const a of Seq.HOTKEY_ACTIONS) {
    const r = hk.results[a];
    if (r && r.status === "active" && r.combo) out[a] = r.combo;
  }
  return out;
}

function renderLink() {
  const dot = el("link-state");
  if (!dot) return;
  const text = {
    off: "Off",
    connected: "Connected",
    connecting: "Connecting…",
    retrying: "Not connected",
    unpaired: "Not paired",
    replaced: "Another panel has it",
  }[linkStatus()];
  dot.textContent = text;
  el("link-on").checked = link.on;
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
  logEvent("helper", `loaded ${parsed.set.chunks.length} slabs (${source})`, parsed.set.name, true);
  dispatch({ type: "load", set: parsed.set });
}

// ── local connection test (Diagnostics): does Slabyrinth answer on the paired port? ──

async function testLocal() {
  const out = el("local-result");
  const lines = [`Page origin: ${location.origin || "(none)"}`];
  const show = () => (out.textContent = lines.join("\n"));
  show();
  const url = `http://127.0.0.1:${link.port}/probe`;
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
  lines.push(
    "This was only a one-off test. The switch under Link and hotkeys makes the lasting connection to Slabyrinth.",
  );
  show();
}

// ── rendering ──

function el(id) {
  return document.getElementById(id);
}

function setText(id, text) {
  const node = el(id);
  if (node) node.textContent = text;
}

/** The banner for the API mode (none once TaleSpire's API is in use). */
function renderBanner(banner) {
  const b = el("banner");
  if (!b) return;
  b.hidden = !banner;
  if (!banner) return;
  b.className = `banner ${banner.tone}`;
  b.textContent = banner.text;
}

/** The two lights and the map card at the top: state at a glance (the now block below says what to do). */
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
    "light-link": Seq.linkLight(linkStatus()),
    "light-slabs": Seq.slabsLight(state, clientMode, apiInfo.mode === "missing"),
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
    const detail = node.querySelector(".light-detail");
    detail.textContent = l.detail || "";
    detail.hidden = !l.detail;
  }
}

/** The now block and the three buttons, with the hotkey that does each while the link is up. */
function renderNow() {
  const status = el("status");
  if (!status) return;
  const keys = activeHotkeys();
  const g = Seq.guide(state, { linked: link.connected, keys });
  status.className = `now ${g.tone}${status.classList.contains("flash") ? " flash" : ""}`;
  setText("now-step", g.step);
  el("now-step").hidden = !g.step;
  setText("now-title", g.title);
  setText("now-detail", g.detail);
  el("now-detail").hidden = !g.detail;
  const c = Seq.controls(state);
  for (const [id, b, action] of [
    ["btn-send", c.send, "again"],
    ["btn-next", c.next, "next"],
    ["btn-back", c.back, "back"],
  ]) {
    const button = el(id);
    button.disabled = !b.enabled;
    button.querySelector(".ctl-label").textContent = b.label;
    const kbd = button.querySelector(".ctl-key");
    kbd.textContent = keys && keys[action] ? keys[action] : "";
    kbd.hidden = !kbd.textContent;
  }
  // one highlighted button: the step the now block asks for (and, when narrow, the one on a row of its own)
  el("btn-send").classList.toggle("primary", c.primary === "send");
  el("btn-next").classList.toggle("primary", c.primary === "next");
  el("controls").dataset.primary = c.primary;
  // no map: nothing to press, so the controls step aside
  el("controls").hidden = !state.set;
  el("footnote").hidden = !state.set;
}

let shown = ""; // the step last shown, to flash the now block when it changes

function render() {
  const status = el("status");
  // a brief flash on each new step, noticeable from the corner of the eye while watching the board
  const step = `${state.index}:${state.phase}`;
  status.classList.remove("flash");
  if (step !== shown && state.phase !== "sending" && state.set) {
    void status.offsetWidth; // restart the animation
    status.classList.add("flash");
  }
  shown = step;
  renderNow();
  const p = Seq.progress(state);
  const bar = el("progress");
  bar.setAttribute("aria-valuemax", String(Math.max(p.total, 1)));
  bar.setAttribute("aria-valuenow", String(p.placed));
  el("progress-fill").style.width = `${(p.fraction * 100).toFixed(2)}%`;
  const cur = el("progress-current");
  cur.hidden = !(state.phase === "inHand" || state.phase === "sending");
  if (p.total) {
    cur.style.left = `${((state.index / p.total) * 100).toFixed(3)}%`;
    cur.style.width = `${(100 / p.total).toFixed(3)}%`;
  }
  // one tick between chunks while they stay readable; a plain bar beyond that
  const ticks = el("progress-ticks");
  const n = p.total <= 40 ? p.total : 0;
  if (ticks.childElementCount !== Math.max(n - 1, 0)) {
    ticks.replaceChildren();
    for (let i = 1; i < n; i++) {
      const t = document.createElement("span");
      t.style.left = `${((i / n) * 100).toFixed(3)}%`;
      ticks.append(t);
    }
  }
  setText("progress-placed", String(p.placed));
  setText("progress-total", String(p.total));
  renderHeader();
  el("chunks").hidden = !state.set;
  setText("chunk-count", state.set ? String(state.set.chunks.length) : "");
  const list = el("chunk-list");
  list.replaceChildren();
  if (state.set)
    state.set.chunks.forEach((ch, i) => {
      const li = document.createElement("li");
      const mark = i < p.placed ? "placed" : i === state.index ? "current" : "waiting";
      li.className = mark;
      const label = document.createElement("span");
      label.className = "chunk-label";
      label.textContent = ch.label;
      const size = document.createElement("span");
      size.className = "chunk-size";
      size.textContent = `${(ch.bytes / 1024).toFixed(1)} KB`;
      li.append(label, size);
      if (mark === "placed") li.title = "Placed";
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

const DEV_TABS = ["load", "log", "diag"];

function showTab(name) {
  for (const t of DEV_TABS) {
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
  for (const t of DEV_TABS) el(`tab-${t}`).addEventListener("click", () => showTab(t));
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
  el("clear-picking").addEventListener("change", () =>
    saveClearMethod(el("clear-picking").checked ? "picking" : "off"),
  );
  el("link-on").addEventListener("change", () => {
    link.on = el("link-on").checked;
    saveLinkSettings();
    if (link.on) void linkReconnect();
    else linkDisconnect();
    renderLink();
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
    `Keys that reach the panel only while it has the keyboard (clicking the board takes it): ${keys.next} = Next, ` +
      `${keys.back} = Back. Click a key, then press the one you want. The hotkeys under Link and hotkeys work ` +
      "while you play.",
  );
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
else start();
