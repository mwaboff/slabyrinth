# Slabyrinth Helper

A TaleSpire symbiote (add-on) that puts a big Slabyrinth map in your hand **one chunk at a time** and always says what
to do next. The Slabyrinth app ships it, installs and updates it, sends maps to it and holds its global hotkeys.

How it works: TaleSpire's symbiote API cannot place a slab at a position; it can only put a slab in the GM's hand
(`slabs.sendSlabToHand`). Every chunk Slabyrinth makes carries the same two alignment pillars, so all chunks of one
map have exactly the same bounding box. If you click the same spot for each chunk, they assemble.

The owner's first tests showed:

- Same-spot placement lines up **with the build plane raised (`G`)**; without it, later chunks land a little higher.
- WebSocket from the symbiote to the local computer works.
- Keys only reach the panel while it has focus, and while a slab is in hand the game hides the cursor. So the app
  holds **system-wide hotkeys** that advance the helper while you keep the mouse on the spot.

It is plain HTML, CSS and JavaScript with no build step. The helper talks only to TaleSpire's API and, when Link is on,
to the Slabyrinth app on `127.0.0.1` (this computer only). It sets every text with `textContent`.

## Install

1. In TaleSpire, turn on symbiotes in the settings (the official docs show this as the first step).
2. In the Slabyrinth app, install the add-on (the TaleSpire part of the settings). The app finds TaleSpire's Symbiotes
   folder, copies this folder into it as `Symbiotes/slabyrinth-helper/` and writes `slabyrinth-link.json` beside it:
   the port and a pairing key that only this app knows. You can also choose the folder by hand, open it, or get a
   paired copy to copy in yourself. The app updates an installed older copy by itself when it starts.
3. Open the symbiotes panel in TaleSpire and pick **Slabyrinth Helper**. TaleSpire picks up added, changed and removed
   add-ons while it runs (official docs), so no restart is needed.

A copy made by hand from this repository has no `slabyrinth-link.json`, so the app refuses its link and the panel says
"Not paired with Slabyrinth". For development, run the app from the repository (`npm run dev`; in a PowerShell that
blocks `.ps1` scripts, `npm.cmd run dev`) and install from it: in development the app installs this folder as it is.
There is no separate bridge or test server any more; the app is the other end of the link.

Opening `index.html` from disk in an ordinary browser shows a **preview**: a yellow banner says the TaleSpire API is
not there and nothing is sent to TaleSpire; a fake answers instead. Inside TaleSpire the helper never uses the fake:
it waits for TaleSpire's API (a "Waiting for TaleSpire's API" banner that disappears within a second or two), and if
the API never comes it says so in red. **Developer tools > Diagnostics > TaleSpire API** shows the mode, whether and
when the API object and its init event appeared, and the namespaces.

## The panel

From the top, everything the GM needs at a glance, then closed sections:

- **Two lights.** The link: "Connected to Slabyrinth", "Connecting to Slabyrinth…", "Not connected to Slabyrinth"
  (the app is not running; it retries on its own), "Not paired with Slabyrinth" (install it again from the app) or
  "Link is off". The slabs: "No slabs loaded", "Slabs are ready
  to paste", or "Blocked: …" naming the cause (not in GM mode, not on a board, TaleSpire's API missing). Each light
  has an icon and words as well as a colour.
- **The map:** its name (long names are cut short; hover for the whole name), chunks, size and levels, and a progress
  bar with one segment per chunk (a plain bar above 40 chunks), the chunk in hand half-lit, and the number placed.
- **Now:** the one thing to do, as a short headline ("Press G to raise the build plane", "Click the same spot",
  "Right-click to clear your hand") with a line of detail. While the link is up it names your hotkeys; otherwise
  the buttons. It flashes briefly on each new step (no flash with the system's "reduce motion" setting).
- **Back, Put in hand again, Next:** the fallback for the hotkeys, each showing its hotkey while the link is up. The
  highlighted one is the step the now block asks for. They are hidden until a map is loaded. After the last chunk,
  Put in hand again becomes **Start over**.
- **Chunks** (closed): every chunk, placed ones ticked, the one in hand marked.
- **Link and hotkeys** (closed): the Link switch and port, the three hotkeys, and the end-of-map picking-tool switch.
- **Appearance** (closed): the look, Slabyrinth or Native.
- **Developer tools** (closed): Load (test pair, pasted JSON), Event log and Diagnostics (including the panel-only
  keys).

TaleSpire injects its colour variables (the `colorStyles` extra) and its OptimusPrinceps font (the `fonts` extra).

### Appearance

**Appearance** (a closed section under Link and hotkeys) picks one of two looks over the same panel. The choice is
kept in the panel's own storage and applied before the panel paints the next time it opens; reinstalling or updating
the add-on from Slabyrinth does not change it. A stored look that no longer exists falls back to Slabyrinth.

- **Slabyrinth** (the default): the desktop app's own look, so the helper reads as the same product. Its colours,
  radii, outline and gold primary buttons, key chips, eyebrows and status tints are copied from the app's dark theme
  (`apps/desktop/src/renderer/styles/tokens.css` and `base.css`; keep them in step by hand). The app's bundled fonts
  cannot be loaded here: Cinzel falls back to TaleSpire's OptimusPrinceps (set in small capitals), Lora to Georgia and
  Source Sans 3 to Segoe UI.
- **Native**: TaleSpire's own colours (black, dark grey, TaleSpire blue buttons) and its OptimusPrinceps face, so the
  helper reads as part of the game.

## Placing a map

1. Run Slabyrinth. In the helper, **Link** is on by default: within a few seconds the top light turns to "Connected
   to Slabyrinth". "Not connected to Slabyrinth" means the app is not running and the helper is retrying; "Link is
   off" means the switch under **Link and hotkeys** is off. (Developer tools > Diagnostics > "Test local connection"
   is only a one-off test, not the link.)
2. Send the map from Slabyrinth's build page (or, for testing, **Developer tools > Load**: the test pair or a pasted
   set). While a map is being placed the app holds the hotkeys; it releases them when you finish, when the add-on
   closes and when the app quits.
3. If the app could not register a hotkey (another program has it, or some Linux Wayland desktops refuse or ask
   first), the setting says so; the buttons in the panel always work.
4. In TaleSpire, **press G to raise the build plane** first (without it, later chunks land a little higher). Point the
   camera at an empty area and do not move it again.
5. Press **Ctrl+Alt+D** (Next): chunk 1 goes to your hand. Click one spot (hold the click briefly).
6. Keep the mouse where it is and press **Ctrl+Alt+D** again: the next chunk goes to your hand. Click the same spot.
   Repeat until the panel says all chunks are placed, then right-click to clear your hand if a slab is still in it,
   and delete the two alignment pillars.

The last chunk stays in your hand as a stamp after you place it, so another click would paste it again. The symbiote
API has no call that clears the hand, so when you press Next (Finish) on the last chunk the helper **switches to
TaleSpire's picking tool**, which drops the slab (Test K). The panel says "Switched to the picking tool": another click
won't paste. Click the board or dismiss the tool to leave it; the helper ignores whatever that click picks. The switch
for this is under **Link and hotkeys** ("After the last chunk, switch to the picking tool…"); turned off, the panel
asks you to right-click instead. The helper does not touch the clipboard: `sendSlabToHand` does not go through it.

After the end:

- **Start over** (the Again button and hotkey) goes back to the first step with nothing placed and **puts nothing in
  your hand** until you press Next, so a stray press is harmless.
- **Back** selects the last chunk **without putting it in your hand** (a slab in hand hides the cursor while you are
  on the panel); Next or Put in hand then sends it. Mid-map, Back still puts the previous chunk straight in your hand,
  because you are on the board then.

Hotkeys (left hand only, the right stays on the mouse):

| Hotkey     | Does                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| Ctrl+Alt+D | Next (and, with nothing in hand yet, puts the current chunk there)            |
| Ctrl+Alt+A | Back one chunk, and put it in your hand (after the end: select it only)       |
| Ctrl+Alt+S | Put the current chunk in your hand again (after the end: Start over, no send) |

You can change them in the helper: click a hotkey under **Link and hotkeys** and press the new combination (Ctrl or
Alt plus a letter, digit, F-key, Space or arrow). The helper sends it to the app, which answers "Active" (or "Ready"
while no map is being placed) or why it refused (for example "taken by another program"); a refused hotkey keeps the
previous one. Hotkeys set in the helper are remembered and win over the defaults each time they connect. **Reset
hotkeys to defaults** goes back to Ctrl+Alt+D, A and S. If the link is down, a change applies when the app connects.

**Trust:** the app listens on 127.0.0.1 only, accepts only a page from TaleSpire's local server (`Origin`
`http://localhost:<port>`) that names the app's own address, and closes any connection whose first message does not
carry the pairing key from `slabyrinth-link.json`. Everything the helper sends is checked and size-capped; a hotkey
from the helper is only ever registered from a fixed allow-list.

## Without the app's hotkeys

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
- **Diagnostics** shows the last API error in full (the status line only names it), what happened at the end of
  the map, the API's slab size limit, your client mode, the last slab you copied in game, the panel keys and the last
  key the panel received, and the local connection test.

## Test procedure

Use a scratch board, in GM mode. Report back for each test what you saw; screenshots help.

### Results so far

- Test A (same spot, build plane): lines up.
- Test B (no build plane): a fight to line up; the second slab sat a little higher. The build plane is required.
- Test E (local connection): WebSocket works.
- Test F (panel keys): they work only after clicking the panel; with a slab in hand the cursor is hidden until a
  right-click.
- Test K (clear the hand at the end): **an empty slab (no assets) crashes TaleSpire's slab spawn**
  (`System.DivideByZeroException` in `Slab.Init`, from `sendSlabToHand`). The helper therefore never sends one: a
  chunk set with a slab too small to hold an asset is refused on load (the size is read from the gzip trailer), and
  the send path checks again. **Starting the picking tool drops the slab in hand** ("worked perfectly"), so the helper
  does that after the last chunk.
- Raw TaleSpire errors (a .NET exception with its stack trace) are never shown in the status line: it says
  "TaleSpire reported an error" and the whole text is under **Developer tools > Diagnostics > Last API error** and in
  the event log.

### Test G: the hotkey flow

With Slabyrinth running and Link on, send a map and place it: place chunk 1, keep the mouse still, press
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
Look for: the helper advances (its event log shows "received next"). Does TaleSpire itself also react to
Ctrl+Alt+D, A or S?
Report: windowed yes or no, fullscreen yes or no, and any reaction in TaleSpire.

### Test J: pressing quickly

Load a larger set (several chunks) and press Ctrl+Alt+D several times quickly.
Look for: does the status line ever say TaleSpire is limiting the helper for sending too fast? Does any chunk get
skipped?
Report: what the status line and the event log showed.

### Test L: the end of the map, Start over and Back

Place every chunk and press Finish.
Look for: the panel says "Switched to the picking tool" and a click on the board pastes nothing; the event log has
`end of map:` lines and, after your click, "end-of-map picking tool closed". Then press **Back** (Ctrl+Alt+A): chunk 6
(or the last) is selected, the cursor stays visible and nothing is in your hand until Next. Finish again, then press
**Start over** (Ctrl+Alt+S): the panel returns to "Press G to raise the build plane" with nothing in your hand.
Report: anything that put a slab in your hand when it should not have, and any wording that was unclear.

### Test D (again): does anything signal a placement?

Open **Developer tools > Event log**, press **Clear**, put a chunk in hand and place it. Also try Ctrl+C on a
selection.
Look for: any line that appears when you place (not when you copy). Copying should add a `slabs.onSlabCopied` line,
and **Diagnostics > Copied slab** should show its status and size.
Report: every line that appeared and what you did just before it. If placing adds nothing, advancing stays manual
(hotkey or button).

Also report if the status line showed an error (for example "not in GM mode", "not on a board", "sending too fast",
"over the slab size limit"), and what you were doing.
