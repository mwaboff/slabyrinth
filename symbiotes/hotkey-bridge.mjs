/**
 * Slabyrinth Helper hotkey bridge (experiment): system-wide shortcuts that drive the helper symbiote, so the GM can
 * keep the mouse on the spot in TaleSpire: click, hotkey, click, hotkey.
 *
 * A windowless Electron main script (no BrowserWindow, renderer or preload): Electron's globalShortcut is the only
 * system-wide hotkey available without native dependencies. Run from the repo root:
 *
 *   npx electron symbiotes/hotkey-bridge.mjs [--set=path/to/chunks.json] [--port=48731]
 *                                            [--next=Ctrl+Alt+D] [--back=Ctrl+Alt+A] [--again=Ctrl+Alt+S]
 *
 * Hotkeys are Ctrl/Alt/Shift plus A-Z, 0-9, F1-F24, Space, arrows, Insert, Delete, Home, End, PageUp or PageDown,
 * with Ctrl or Alt required. Hotkeys set in the helper replace these once it connects. Ctrl+C stops the bridge.
 * Everything but the globalShortcut calls lives in link-bridge.mjs (plain Node, unit-tested).
 */
import { app, globalShortcut } from "electron";
import {
  HOTKEY_ACTIONS,
  createHotkeyManager,
  parseBridgeArgs,
  readChunkSet,
  startLinkServer,
} from "./link-bridge.mjs";

const time = () => new Date().toISOString().slice(11, 23);
const log = (msg) => console.log(`${time()}  ${msg}`);

// Options are what follows this script's path (Electron puts its own executable and the script first).
const argv = process.argv;
const at = argv.findIndex((a) => /hotkey-bridge\.mjs$/.test(a));
const opts = parseBridgeArgs(at >= 0 ? argv.slice(at + 1) : []);
if (opts.errors.length) {
  for (const e of opts.errors) console.error(e);
  console.error("Options: --set=FILE --port=N --next=KEYS --back=KEYS --again=KEYS");
  process.exit(2);
}
let set = null;
if (opts.setPath) {
  try {
    set = readChunkSet(opts.setPath);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

// No windows: nothing to quit for. The app keeps running until Ctrl+C or the process is ended.
app.on("window-all-closed", () => {});
if (!app.requestSingleInstanceLock()) {
  console.error("Another hotkey bridge is already running.");
  app.exit(1);
}
app.dock?.hide(); // macOS only: no dock icon for a terminal tool

let link = null;
const LABELS = { next: "Next", back: "Back", again: "Put in hand again" };
const hotkeys = createHotkeyManager({
  register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
  unregister: (accelerator) => globalShortcut.unregister(accelerator),
  onCommand: (action) => link?.send(action),
  log,
});

app.whenReady().then(async () => {
  try {
    link = await startLinkServer({ port: opts.port, set, hotkeys, log });
  } catch (e) {
    console.error(`Could not listen on 127.0.0.1:${opts.port}: ${e.message}`);
    app.exit(1);
    return;
  }
  log(`Listening on ws://127.0.0.1:${opts.port} (this computer only).`);
  if (set) log(`Will load "${set.name}" (${set.chunks.length} chunks) into the helper when it connects.`);
  const state = hotkeys.apply(opts.shortcuts, "the command line");
  log("Hotkeys:");
  for (const a of HOTKEY_ACTIONS) {
    const s = state[a];
    log(
      s.status === "refused"
        ? `  ${LABELS[a]}: ${s.wanted} COULD NOT REGISTER (${s.reason}); pick another with --${a}=... or in the helper.`
        : `  ${LABELS[a]}: ${s.combo ?? "none"}`,
    );
  }
  log("In the helper, turn on Link (same port). Ctrl+C here to stop.");
});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  globalShortcut.unregisterAll();
  if (link) await link.close();
  log("Stopped.");
  app.quit();
}
app.on("will-quit", () => globalShortcut.unregisterAll());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
