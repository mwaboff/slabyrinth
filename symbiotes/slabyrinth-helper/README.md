# Slabyrinth Helper (experiment)

A TaleSpire symbiote that puts a big Slabyrinth map in your hand **one chunk at a time** and always says what to do
next. It is an **experiment that has not been tried in the game yet**: its job is to find out whether placing every
chunk on the same spot, without moving the camera, lines the chunks up.

How it works: TaleSpire's symbiote API cannot place a slab at a position; it can only put a slab in the GM's hand
(`slabs.sendSlabToHand`). Every chunk Slabyrinth makes carries the same two alignment pillars, so all chunks of one
map have exactly the same bounding box. If you click the same spot for each chunk, they should assemble.

It is plain HTML, CSS and JavaScript with no build step. It sends nothing anywhere except to TaleSpire's own API,
and, only when you press "Test local connection", to a test program on your own computer.

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

Opening `index.html` in an ordinary browser shows a **preview**: a yellow banner says the TaleSpire API is not there
and nothing is sent to TaleSpire; a fake answers instead.

## Using it

- **Load test pair** loads the bundled two-chunk pair (`test-pair.js`): Slabyrinth's single-room test plan (one small walled
  room with a few props) split down the middle into a west half and an east half.
- Or paste a chunk set and press **Load pasted set**. The format:

  ```json
  {
    "format": "slabyrinth-chunks",
    "version": 1,
    "name": "My map",
    "chunks": [
      { "label": "West half", "slab": "H4sI..." },
      { "label": "East half", "slab": "H4sI..." }
    ]
  }
  ```

- The large line at the top always says what to do now. **Put in hand** sends the current chunk to your hand. After
  you place it, press **Next**: the next chunk goes straight to your hand. **Back** goes back one chunk and puts it in
  your hand. **Put in hand again** resends the current chunk.
- TaleSpire does not tell a symbiote when a slab is placed, so the helper cannot move on by itself; press Next, or
  **Ctrl+Space** (Back: **Ctrl+Shift+Space**). Keys only work while the panel has the keyboard; Test F finds out
  whether it keeps it after you click the board.
- **Event log** lists every TaleSpire event the helper listens to, with times, and its own calls (marked ▸).
- **Diagnostics** shows the API's slab size limit, your client mode, the last slab you copied in game, and the local
  connection test.

## Test procedure

Use a scratch board, in GM mode. Report back for each test what you saw; screenshots help.

### Test A: same spot, build plane raised

1. Load test pair. Press **Put in hand**.
2. Press `G` to raise the build plane. Point the camera so you can see an empty area, then do not move it again.
3. Click one spot to place chunk 1 (hold the click briefly).
4. Press **Next**. Click exactly the same spot without moving the camera or the mouse more than needed.

Look for: do the west and east halves meet in one room with no gap, overlap or step? A one-cell slip shows as a
doubled or missing column of floor and a broken wall line along the seam. The two alignment pillars of chunk 2 should
sit exactly inside those of chunk 1 (one clear cell outside the south-west and north-east corners).
Report: lined up or not; if not, by how many cells, in which direction (north/south/east/west, up/down).

### Test B: same spot, no build plane

The same as Test A on flat ground, without pressing `G`.
Look for: the same as A, and whether chunk 2 ends up higher than chunk 1 (aiming onto placed tiles can raise it).
Report: lined up or not, and any height difference.

### Test C: does the next chunk replace the one in hand?

After placing chunk 1, press **Next** without right-clicking.
Look for: is chunk 2 now in your hand, or is chunk 1 still there (or both)? Does a right-click first make a
difference?
Report: what was in your hand after Next, with and without a right-click before it.

### Test D: does anything signal a placement?

Open **Event log**, press **Clear**, put a chunk in hand and place it. Also try Ctrl+C on a selection.
Look for: any line that appears when you place (not when you copy). Copying should add a `slabs.onSlabCopied` line,
and **Diagnostics > Copied slab** should show its status and size.
Report: every line that appeared and what you did just before it. If placing adds nothing, the helper must keep its
Next button.

### Test E: local connection

1. In a terminal in the Slabyrinth folder: `node symbiotes/local-test-server.mjs` (it listens on 127.0.0.1:48731,
   this computer only; Ctrl+C stops it). Use another port as `node symbiotes/local-test-server.mjs 50123` and type the
   same port in the helper.
2. In the helper: **Diagnostics > Test local connection**.

Look for: the helper's result box shows the page origin and one line each for HTTP fetch and WebSocket; the
terminal prints what it received, with an `Origin:` header.
Report: both result lines, the terminal output, and the page address shown under Diagnostics. Restart TaleSpire once
and report whether the page address's port changed.

### Test F: does a key reach the helper after clicking the board?

The official symbiote API has no hotkey or keyboard API, so the helper listens for ordinary key presses in its panel:
**Ctrl+Space = Next**, **Ctrl+Shift+Space = Back** (change them under **Diagnostics > Keys**).

1. Load test pair, **Put in hand**, and place chunk 1 by clicking the board.
2. Without touching the panel, press Ctrl+Space.

Look for: does the helper advance (status line says chunk 2 is in your hand)? Then open **Diagnostics > Keys**: "Last
key" and "At" show the last key the panel received, and "Panel had focus" whether it had the keyboard. The event log
also shows `window blur` / `focus` lines when the keyboard moves between the board and the panel.
Report: whether it advanced; the "Last key" time compared with when you pressed it; whether a `blur` line appeared when
you clicked the board; and whether Ctrl+Space does anything in TaleSpire itself.

Also report if any button showed an error in the status line (for example "not in GM mode", "not on a board",
"sending too fast", "over the slab size limit"), and what you were doing.
