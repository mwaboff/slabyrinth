# Slabyrinth Helper (experiment)

A TaleSpire symbiote that puts a big Slabyrinth map in your hand **one chunk at a time** and always says what to do
next. It is an **experiment**. Its job is to find out how far "click the same spot for every chunk" carries.

How it works: TaleSpire's symbiote API cannot place a slab at a position; it can only put a slab in the GM's hand
(`slabs.sendSlabToHand`). Every chunk Slabyrinth makes carries the same two alignment pillars, so all chunks of one
map have exactly the same bounding box. If you click the same spot for each chunk, they assemble.

The owner's first tests showed:

- Same-spot placement lines up **with the build plane raised (`G`)**; without it, later chunks land a little higher.
- WebSocket from the symbiote to the local computer works.
- Keys only reach the panel while it has focus, and while a slab is in hand the game hides the cursor. So the
  recommended flow now uses a small **hotkey bridge** on your computer: system-wide hotkeys that advance the helper
  while you keep the mouse on the spot.

It is plain HTML, CSS and JavaScript with no build step. The helper talks only to TaleSpire's API and, when Link is on,
to the bridge on `127.0.0.1` (this computer only).

## Install

1. In TaleSpire, turn on symbiotes in the settings (the official docs show this as the first step).
2. Copy this folder into TaleSpire's symbiotes folder. In PowerShell, from the Slabyrinth folder:

   ```powershell
   Copy-Item -Recurse -Force symbiotes\slabyrinth-helper "$env:USERPROFILE\AppData\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\"
   ```

   That is the folder the official docs give as `%AppData%\..\LocalLow\BouncyRock Entertainment\TaleSpire\Symbiotes\`.
   `manifest.json` must sit directly inside `Symbiotes\slabyrinth-helper\`.

3. Open the symbiotes panel in TaleSpire and pick **Slabyrinth Helper**. TaleSpire reloads it when files in its folder
   change.

Opening `index.html` from disk in an ordinary browser shows a **preview**: a yellow banner says the TaleSpire API is
not there and nothing is sent to TaleSpire; a fake answers instead. Inside TaleSpire the helper never uses the fake:
it waits for TaleSpire's API (a "Waiting for TaleSpire's API" banner that disappears within a second or two), and if
the API never comes it says so in red. **Developer tools > Diagnostics > TaleSpire API** shows the mode, whether and
when the API object and its init event appeared, and the namespaces.

## The panel

From the top, everything the GM needs at a glance, then closed sections:

- **Two lights.** The link: "Connected to Slabyrinth", "Connecting to Slabyrinth…", "Not connected to Slabyrinth"
  (the bridge is not running; it retries on its own) or "Link is off". The slabs: "No slabs loaded", "Slabs are ready
  to paste", or "Blocked: …" naming the cause (not in GM mode, not on a board, TaleSpire's API missing). Each light
  has an icon and words as well as a colour.
- **The map:** its name (long names are cut short; hover for the whole name), chunks, size and levels, and a progress
  bar with one segment per chunk (a plain bar above 40 chunks), the chunk in hand half-lit, and the number placed.
- **Now:** the one thing to do, as a short headline ("Press G to raise the build plane", "Click the same spot",
  "Right-click to clear your hand") with a line of detail. While the link is up it names your hotkeys; otherwise
  the buttons. It flashes briefly on each new step (no flash with the system's "reduce motion" setting).
- **Back, Put in hand again, Next:** the fallback for the hotkeys, each showing its hotkey while the link is up. The
  highlighted one is the step the now block asks for. They are hidden until a map is loaded.
- **Chunks** (closed): every chunk, placed ones ticked, the one in hand marked.
- **Link and hotkeys** (closed): the Link switch and port, and the three hotkeys.
- **Developer tools** (closed): Load (test pair, pasted JSON), Event log, Diagnostics (including the panel-only
  keys) and Design.

TaleSpire injects its colour variables (the `colorStyles` extra) and its OptimusPrinceps font (the `fonts` extra).

### Design preview (temporary)

**Developer tools > Design** switches between four looks over the same panel, so they can be judged in game next to
the board. The choice is remembered in the panel.

- **Instrument** (the default): high contrast, big numbers, a segmented gauge and signal colours, read from the
  corner of the eye.
- **Native**: TaleSpire's own colours (black, dark grey, TaleSpire blue buttons) and its OptimusPrinceps face, so the
  helper reads as part of the game.
- **Lantern**: warm, quiet and roomy, with serif names; it steps back until it is needed.
- **Slabyrinth**: the desktop app's own look, so the helper reads as the same product. Its colours, radii, outline
  and gold primary buttons, key chips, eyebrows and status tints are copied from the app's dark theme
  (`apps/desktop/src/renderer/styles/tokens.css` and `base.css`; keep them in step by hand). The app's bundled fonts
  cannot be loaded here: Cinzel falls back to TaleSpire's OptimusPrinceps (set in small capitals), Lora to Georgia and
  Source Sans 3 to Segoe UI.

## Recommended flow: the hotkey bridge

1. In a terminal in the Slabyrinth folder, start the bridge (it uses the Electron already installed for Slabyrinth's
   development; no window opens):

   ```
   npx electron symbiotes/hotkey-bridge.mjs
   ```

   To have it load a chunk set into the helper as soon as they connect:
   `npx electron symbiotes/hotkey-bridge.mjs --set=path\to\my-map.json`. Other options: `--port=48731`,
   `--next=Ctrl+Alt+D`, `--back=Ctrl+Alt+A`, `--again=Ctrl+Alt+S`. It prints the active hotkeys, every command it
   sends and the helper's answer. **Ctrl+C** in the terminal stops it and releases the hotkeys.

2. In the helper, **Link** is on by default (port 48731): within a few seconds the top light turns to "Connected to
   Slabyrinth". "Not connected to Slabyrinth" means the bridge is not running and the helper is retrying; "Link is
   off" means the switch under **Link and hotkeys** is off. (Developer tools > Diagnostics > "Test local connection"
   is only a one-off test, not the link.)
3. Load the chunks: the bridge's `--set` file, or under **Developer tools > Load**, the test pair or a pasted set.
4. In TaleSpire, **press G to raise the build plane** first (without it, later chunks land a little higher). Point the
   camera at an empty area and do not move it again.
5. Press **Ctrl+Alt+D** (Next): chunk 1 goes to your hand. Click one spot (hold the click briefly).
6. Keep the mouse where it is and press **Ctrl+Alt+D** again: the next chunk goes to your hand. Click the same spot.
   Repeat until the panel says all chunks are placed, then right-click to clear your hand and delete the two
   alignment pillars.

Hotkeys (left hand only, the right stays on the mouse):

| Hotkey     | Does                                          |
| ---------- | --------------------------------------------- |
| Ctrl+Alt+D | Next (and, with nothing in hand yet, chunk 1) |
| Ctrl+Alt+A | Back one chunk, and put it in your hand       |
| Ctrl+Alt+S | Put the current chunk in your hand again      |

You can change them in the helper: click a hotkey under **Link and hotkeys** and press the new combination (Ctrl or
Alt plus a letter, digit, F-key, Space or arrow). The helper sends it to the bridge, which answers "Active" or why it
refused (for example "taken by another program"); a refused hotkey keeps the previous one. Hotkeys set in the helper are
remembered and win over the bridge's command-line ones each time they connect. **Reset hotkeys to defaults** goes back
to Ctrl+Alt+D, A and S. If the link is down, a change applies when the bridge connects.

**This link is an experiment:** anything on this computer, including a web page in any browser, could connect to
the bridge's port. A product version would add a pairing token and an `Origin` check, and would live inside the
Slabyrinth app.

## Without the bridge

The buttons do the same: **Next** (puts chunk 1 in hand first, then each next chunk), **Back**, **Put in hand
again**. The panel also has keys (Ctrl+Space Next, Ctrl+Shift+Space Back; set under Developer tools > Diagnostics),
but they only work while the panel has the keyboard, which it loses when you click the board.

## Chunk-set format

```json
{
  "format": "slabyrinth-chunks",
  "version": 1,
  "name": "My map",
  "size": { "w": 64, "h": 48 },
  "levels": 2,
  "chunks": [
    { "label": "West half", "slab": "H4sI..." },
    { "label": "East half", "slab": "H4sI..." }
  ]
}
```

`size` (in cells) and `levels` are optional; the header shows them when present. The bundled test pair
(`test-pair.js`) is Slabyrinth's single-room test plan (one small walled room with a few props) split down the
middle into a west half and an east half.

## Developer tools

- **Load** loads the bundled test pair or a pasted chunk set.
- **Event log** lists every TaleSpire event the helper listens to, with times, and its own and the link's activity
  (marked ▸).
- **Diagnostics** shows the API's slab size limit, your client mode, the last slab you copied in game, the panel
  keys and the last key the panel received, and the local connection test.
- **Design** is the temporary design preview (above).

## Test procedure

Use a scratch board, in GM mode. Report back for each test what you saw; screenshots help.

### Results so far

- Test A (same spot, build plane): lines up.
- Test B (no build plane): a fight to line up; the second slab sat a little higher. The build plane is required.
- Test E (local connection): WebSocket works.
- Test F (panel keys): they work only after clicking the panel; with a slab in hand the cursor is hidden until a
  right-click.

### Test G: the bridge flow

With the bridge running and Link on, follow the recommended flow: place chunk 1, keep the mouse still, press
Ctrl+Alt+D, click again.
Look for: do the halves line up without touching the panel or moving the mouse?
Report: lined up or not (if not, by how many cells and which way), and anything that made you move the mouse.

### Test H: does the next chunk replace the one in hand?

When the hotkey sends chunk 2 while chunk 1 is still in your hand as a stamp:
Look for: is chunk 2 now in your hand, or chunk 1 still (or both)? Is a right-click needed first? Does the slab in
hand stay under the cursor?
Report: what was in your hand after the hotkey, and whether it stayed under the cursor.

### Test I: does the hotkey fire while TaleSpire has focus?

Try the hotkeys while TaleSpire is in front, in windowed mode and in fullscreen.
Look for: the bridge's terminal prints "Sent: next" and the helper advances. Does TaleSpire itself also react to
Ctrl+Alt+D, A or S?
Report: windowed yes or no, fullscreen yes or no, and any reaction in TaleSpire.

### Test J: pressing quickly

Load a larger set (several chunks) and press Ctrl+Alt+D several times quickly.
Look for: does the status line ever say TaleSpire is limiting the helper for sending too fast? Does any chunk get
skipped?
Report: what the status line and the bridge's terminal showed.

### Test D (again): does anything signal a placement?

Open **Developer tools > Event log**, press **Clear**, put a chunk in hand and place it. Also try Ctrl+C on a
selection.
Look for: any line that appears when you place (not when you copy). Copying should add a `slabs.onSlabCopied` line,
and **Diagnostics > Copied slab** should show its status and size.
Report: every line that appeared and what you did just before it. If placing adds nothing, advancing stays manual
(hotkey or button).

Also report if the status line showed an error (for example "not in GM mode", "not on a board", "sending too fast",
"over the slab size limit"), and what you were doing.
