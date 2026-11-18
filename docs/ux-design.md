# Slabyrinth — UX & UI Design Spec

Status: v1 design for implementation · Owner: Product/UX · Date: 2026-11-18
Companion mockup: `docs/mockups/app-mockup.html` (open from disk; the strip at the top switches states and themes; it is not part of the app).

Slabyrinth is a packaged **Electron desktop app** (Windows + Linux), single user, no accounts. A GM chats with Claude (on their own API key) to agree a map brief, reviews a deterministic 2D plan of one or more levels, approves it, and gets TaleSpire slabs out. This document specifies everything the user sees and does. The slab format and the system architecture are owned by other people; places where this design depends on them are marked **[DEP: slab]** or **[DEP: arch]**.

---

## 1. Design principles

1. **The plan is the product.** The AI never draws. It edits a structured plan; the 2D map and the slabs are both compiled from that plan. The UI keeps repeating one promise: what you see on the map is what gets built.
2. **One workspace, not a wizard.** Brief, plan and build are phases of one project, shown as a progress indicator, not separate screens you march through. You can always go back to talking.
3. **Point, don't describe.** Rooms have numbers and names. Clicking a room puts a reference into the chat. Nobody should have to type "the second room from the left at the top".
4. **Every AI change is a version, and every version is reversible.** Undo is one keystroke; nothing the AI does is destructive.
5. **Money is visible.** The key is the user's; the cost of each action and of the project is always on screen, and expensive actions show an estimate first.
6. **Teach the paste.** If TaleSpire only takes clipboard paste, pasting is the most fragile step in the journey. It gets a guided step-by-step mode, not a wall of copy buttons.
7. **A tool for a GM's desk, not a fantasy theme park.** Cartographic restraint: paper, ink, one red accent. The fantasy is in the content, not the chrome.

---

## 2. User journey and states

### 2.1 Project phases (emergent, but visible)

Phases come from the data. No "Next" button sets them:

| Phase | Condition | What the screen emphasises |
|---|---|---|
| **Brief** | No plan version exists | Chat + Brief card; the map stage shows the empty state, and a "Draw the first plan" CTA once the brief has a map type |
| **Plan** | ≥1 plan version, current version not approved | Map stage with the plan, room key and version controls; primary button "Approve plan vN" |
| **Build** | An approved version exists | Build tab enabled; primary button becomes "Build for TaleSpire" / "Open build" |
| **Stale** (sub-state of Build) | The plan has moved on from the version that was built | Build tab shows an amber banner, "Built from v7 — plan is now v9", with "Approve v9 & rebuild" |

The **phase stepper** in the title bar shows `Brief › Plan v7 › Build`, and each step is clickable:
- Brief: expands the Brief card and focuses the composer.
- Plan: switches the stage to the **Map** tab.
- Build: switches the stage to the **Build** tab. It is disabled until a version is approved, with the tooltip "Approve a plan version first".

A step gets a check when it is complete: Brief ✓ once a plan exists, Plan ✓ when the current version is approved, Build ✓ when a non-stale build exists for the approved version.

### 2.2 Journey (happy path)

1. **First launch**: the **Setup** window opens (§8.1). Step 1 asks for the API key and validates it. Step 2 finds the TaleSpire install. Then you land in a new project called "Untitled map".
2. **Brief**: a welcome message and four starter prompts. The user types or clicks a starter. The AI replies briefly, fills in the Brief card, and asks at most one round of up to 3 clarifying questions as a **Question card** with chips. The user clicks chips, or ignores them and types. **Draw the first plan** is available as soon as the brief has a map type.
3. **First plan**: the AI generates plan v1. Progress streams in the thread, with an overlay on the map stage. The map appears with level tabs, room numbers, and a room key with GM notes.
4. **Revise**: the user clicks room 4, and the chip `④ Hall of Pillars` appears in the composer. They type "make it bigger and add a balcony". The AI produces v2, and the thread shows a **Plan update card** (what changed, Compare, Undo). Repeat as needed.
5. **Approve**: the user clicks **Approve plan v5**. A popover summarises levels, size and the estimated chunk count. Approval is instant and costs nothing.
6. **Build**: the stage switches to the Build tab and runs the compiler, which is local and deterministic, takes seconds and makes no AI call **[DEP: arch]**. Progress shows per level. The result is a card per level with a copy button per chunk and size bars.
7. **Into TaleSpire**: clipboard only (a board can't be opened or created from outside TaleSpire). The user clicks **Start paste guide**, a guided checklist: "Copy & open TaleSpire" copies chunk 1 and brings the game to the front, the user presses Ctrl+V, click and hold to place it, come back, press Next (which copies the next chunk), and paste it **on the same cell** using the corner markers. Levels go bottom-up, one storey (2.5 tiles) higher each time. The app tracks which chunks have been copied and pasted (§9).
8. **Later**: the project autosaves everything: chat, brief, every version, build and paste progress, and the unsent composer draft. Next launch opens on **Home** with a "Continue" card. Reopening shows a short "Where we left off" recap in the thread (§8.9). The user can keep chatting, revise, re-approve and rebuild, and the build view says which chunks changed.

### 2.3 Map stage states

| State | Map stage shows |
|---|---|
| Empty (no plan) | Faint grid paper, a centred message, the brief checklist and the CTA |
| Generating first plan | Grid paper plus a progress card ("Drafting Level 1 of 2 · laying out rooms…") with a Stop button |
| Plan ready | Map canvas, toolbar and room key |
| Revising (AI editing) | The current map stays visible and interactive (read-only). A thin progress bar runs under the toolbar and a "Revising… Stop" pill sits on the canvas. When the edit lands, the canvas cross-fades to the new version and changed rooms pulse once (300 ms) |
| Compare on | The current version, with changed rooms outlined: added (solid outline + "NEW" tag), changed (dashed outline + "Δ" tag), removed (ghosted in hatching + "✕" tag) |
| Viewing an old version | A banner across the top of the canvas: "Viewing v4 (12 min ago), read only. [Restore this version] [Back to latest]" |
| Invalid plan from AI | The previous version stays; an error card appears in the thread (§10) |
| Build tab, never built | Explainer + Build button |
| Building | A progress row per level |
| Built | Level and chunk cards, the paste guide entry point, export notes |
| Built, stale | The same, plus the amber stale banner; changed chunks are badged "Changed" |

---

## 3. Window and layout

### 3.1 Window chrome (Electron)

- **Custom title bar**, 44px, drawn by the app (frameless window, `titleBarStyle: 'hidden'` with `titleBarOverlay` on Windows so the native min/max/close buttons and Snap Layouts still work; on Linux, draw matching min/max/close buttons at the right). One consistent look on both OSes, and the phase stepper and cost meter get the top row instead of a wasted native title row. Double-clicking empty title bar space maximises or restores. Drag regions are everything except interactive controls.
- **Minimum window size: 1280×760.** Default first-launch size: 1440×900, centred, or maximised if the screen is ≤1440 wide. The app remembers size, position and maximised state for each display.
- **App menu**: there is no visible menubar. A **☰ menu button** at the far left of the title bar opens the full menu, and `Alt` alone opens it with keyboard focus on File (Windows convention). The same menu is installed as the Electron application menu, so accelerators work globally.
  - **File**: Home `Ctrl+Shift+H` · New project `Ctrl+N` · Open project… `Ctrl+O` (native open dialog) · Open recent ▸ · Save a copy as… `Ctrl+Shift+S` (native save dialog, `.slabyrinth` file) · Export map as PNG… `Ctrl+Shift+E` · Export room key… (Markdown) · Import slab as stamp… (*later*, §17) · Close project `Ctrl+W` (returns to Home) · Settings `Ctrl+,` · Quit `Ctrl+Q`
  - **Edit**: Undo plan change `Ctrl+Z` · Redo `Ctrl+Y` · Cut/Copy/Paste/Select all (text) · Find in room key `Ctrl+F`
  - **View**: Map `Ctrl+1` · Build `Ctrl+2` · Toggle chat pane `Ctrl+\` · Toggle room key `Ctrl+]` · Zoom in/out/fit · Theme ▸ · Actual size / UI zoom (`Ctrl+=`/`Ctrl+-`/`Ctrl+0` at window level when the map is not focused) · Toggle full screen `F11`
  - **Map**: Compare with previous `C` · History `H` · Approve current version `Ctrl+Shift+A` · Build `Ctrl+B` · Model & effort… `Ctrl+M` (§13.2 is the canonical shortcut list)
  - **Help**: Keyboard shortcuts `?` · Paste guide tutorial · Open data folder · View logs · About Slabyrinth (version, check for updates)
- **Single instance**: launching again focuses the existing window. Opening a `.slabyrinth` file from Explorer or the file manager opens it in the running instance; if it is already open, its window comes forward.
- **Close with unsaved state**: there is none, because the app autosaves. Closing while a generation is running asks: "A plan is still being drafted. Quit anyway? The draft will be discarded." [Quit] [Keep working].

### 3.2 Recommended layout: persistent two-pane workspace

```
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│ ☰ [▦] Slabyrinth / The Drowned Abbey ▾ Saved │  Brief ✓ › Plan v7 › Build │ $0.38 ◐ ⚙ │ – □ ✕ │ 44px title bar
├────────────────────────────────┬─────────────────────────────────────────────────────────────┤
│ ┌ BRIEF ─────────────── ▾ ┐    │ [Map] [Build] │ L1 Upper Crypts │ L2 Cistern Depths │ +      │ 44px stage bar
│ │ Dungeon · Daggerheart T2 │   │ ⌖ ✋ ⬚ │ − 100% + ⤢ │ Layers ▾ │ Compare v6 │ History      │ 40px toolbar
│ │ 2 levels · 40×30 sq      │   ├───────────────────────────────────────────┬─────────────────┤
│ │ Gothic, drowned          │   │                                           │ ROOM KEY · L1   │
│ └──────────────────────────┘   │                                           │ ① Collapsed     │
│                                │            2D MAP CANVAS                  │ ② Guardroom     │
│  chat thread                   │       (zoom / pan / select)               │ ④ Hall of  ◀sel │
│  • messages                    │                                           │   Pillars       │
│  • question cards              │                                           │   notes… (edit) │
│  • plan update cards           │                                           │ …               │
│                                │                                           │ ── Legend ──    │
│ ┌────────────────────────────┐ ├───────────────────────────────────────────┴─────────────────┤
│ │[④ Hall of Pillars ×]       │ │ L1 · 40×30 sq (200×150 ft) · 7 rooms · v7 · 2 min ago       │ 48px status bar
│ │ Message Slabyrinth…        │ │                              [History]  [Approve plan v7 →] │
│ │ ~$0.02 · Sonnet     [Send] │ │                                                             │
│ └────────────────────────────┘ │                                                             │
└────────────────────────────────┴─────────────────────────────────────────────────────────────┘
   chat pane 400px (360–520, resizable)              stage: flexible; room key 300px (collapsible)
```

- Below 1500px window width, the room key collapses to a 44px rail (icon + room count) by default and opens as an overlay.
- The chat pane can be resized with a drag handle (360–520px, persisted); double-clicking the handle resets it to 400px.
- `Ctrl+\` collapses the chat to a 56px rail for a full-width map. `/` re-expands it and focuses the composer.
- The stage has two tabs, **Map** and **Build**. Both share the level tabs: picking L2 in Map and switching to Build focuses L2's build card.

### 3.3 Alternatives rejected

- **Step wizard (Brief screen → Plan screen → Export screen).** The user's real loop is talk, look, talk, many times over, and the phases bleed together: you refine the brief while looking at a plan, and you rebuild after a late tweak. Separate screens would hide either the chat or the map exactly when you need both.
- **Map first, with chat in a floating drawer.** Conversation is the main editing tool, and the history reminds the GM what they asked for. Collapsing chat to a rail gives the map-first view when it's wanted.
- **Native OS title bar + menubar.** It's simpler, but it costs a 30px row and splits the chrome into two visual languages. The custom bar keeps native window controls through `titleBarOverlay`.

---

## 4. Title bar (left → right)

1. **☰ App menu** (§3.1).
2. **Mark + wordmark**: the Slabyrinth mark (§11.7) and "Slabyrinth" in Fraunces 600 15px. Clicking goes to **Home** (§8.9).
3. **Project name**, after a slash: click to rename inline (Enter saves, Esc cancels, max 60 chars). The ▾ opens the File menu items that relate to the project.
4. **Save state** in muted text: "Saved" · "Saving…" · "Couldn't save" (danger, with a fix link).
5. **Phase stepper**, centred (§2.1).
6. **Cost meter**: `$0.38 · 41k tok`. Click for a popover with the project total, session total and all-time total, the last 5 calls (action, model, in/out tokens, cost), a link to the Anthropic Console usage page, and the warning thresholds. When the project passes its warning threshold (default $2.00), the meter turns warning-coloured and its text changes to "$2.14 · over $2", so it doesn't rely on colour alone.
7. (No model chip here: model and effort live next to the composer, where they take effect. See §5.8.)
8. **Theme** toggle: switches Dark (default) ↔ Light. "Match system" is in Settings ▸ Appearance. The tooltip names the current state.
9. **Settings** gear (`Ctrl+,`).
10. **Status dot**, shown only when offline or when the key is invalid (§10).
11. **Window controls**: native overlay on Windows, drawn by the app on Linux.

---

## 5. Chat pane

### 5.1 Brief card (pinned at top of chat)

A structured summary of what's been agreed. The user and the AI own it jointly.

| Field | Control | Example |
|---|---|---|
| Map type (needed before drawing) | Select + free text: Dungeon, Cave, Tower, Keep/Castle, Town, Village, Building interior, Wilderness/Forest, Road/encounter site, Ship, Other | Dungeon |
| Game system | Segmented: Daggerheart · D&D 5e · Other/none | Daggerheart |
| Party | Daggerheart: Tier 1–4 + party size; D&D: level 1–20 + party size | Tier 2 · 4 PCs |
| Footprint | Small (≤20×20 squares) · Medium (≤40×40) · Large (≤80×80) · Custom W×H; feet shown alongside (×5) | 40×30 sq (200×150 ft) |
| Levels | Count stepper 1–6 + editable names | 2 · Upper Crypts, Cistern Depths |
| Tone / theme | Free text, 80 chars | Gothic, drowned, melancholy |
| Must include | Tag list | flooded crypt, secret way down, boss room |
| Avoid | Tag list | instant-death traps |

Behaviour:
- **Collapsed** (the default once a plan exists): two or three summary lines. Click or `Ctrl+Shift+B` to expand.
- **Expanded**: inline form fields. User edits save at once and post a small system line in the thread ("You changed Levels: 2 → 3"). They **don't** trigger generation; the next AI turn gets the updated brief. If a plan exists, a hint appears under the card: "Brief changed since v7. Ask Slabyrinth to apply it, or [Redraw from brief]."
- **AI updates** come in as a structured tool call, not parsed from prose. The changed field gets an accent underline for 1.5s, and the AI message ends with a line such as "Brief updated: Levels → 2".
- Fields the AI filled show a small "AI" marker until the user touches them. The user's value always wins.
- **Readiness line** under the card: "Ready to draw" once Map type is set, plus "Optional: footprint, party". It's guidance, not a gate.

### 5.2 Thread content types

| Type | Look | Notes |
|---|---|---|
| User message | Right-aligned bubble on surface-2, max 85% width | Reference chips render inline as tokens |
| AI message | Left-aligned, no bubble, small mark avatar | Markdown subset: paragraphs, bold, italics, lists |
| Question card | Bordered card inside the AI turn | §5.3 |
| Plan update card | Card with version badge and left ink rule | §5.5 |
| Build card | "Built v7 · 2 levels · 5 chunks [Open build]" with a success rule | Posted when a build completes |
| System line | Centred, small, muted | "You changed Levels: 2 → 3", "Restored v4 as v8", "Approved v7" |
| Error card | Danger left rule | §10 |

### 5.3 Clarifying questions without interrogating

Rules for the AI (in its prompt), backed up by the UI:
- At most **one Question card per turn**, with at most **3 questions**, each offering **2–4 answer chips** plus **"You decide"**.
- Each question states the AI's default ("Party tier? I'll assume Tier 2"), so ignoring the card is a valid answer.
- After **one** round, the AI proposes drawing rather than asking more. **Draw the first plan** is always shown once Map type is set, so the user can cut the questions short.

How the card works:
- Clicking a chip selects it (accent tint, check icon). Nothing is sent until the user clicks **Send answers** or presses Enter inside the card. A message typed in the composer while chips are selected sends both together.
- **You decide** delegates that question.
- Once sent, the card collapses to one line: "Answered: Tier 2 · 2 levels · You decide (tone)".
- Keyboard: Tab into the card, arrow keys move between chips, Space toggles, Enter sends.

### 5.4 Welcome and starter prompts

Welcome message:

> **Let's build a map.** Tell me what you're running — a dungeon, a tower, a town, a stretch of forest — and anything you already know: the game, the party, the mood. I'll sketch a plan you can poke at before anything goes into TaleSpire.

Four starter cards follow. Clicking one fills the composer without sending it:
1. **Drowned crypt**: "A two-level crypt under a ruined abbey, half-flooded, for a Tier 2 Daggerheart party."
2. **Wizard's tower**: "A four-storey wizard's tower with a library, a lab and a rooftop observatory."
3. **Market town**: "A small riverside market square with a tavern and a smithy I can walk into."
4. **Forest ambush**: "A forest road ambush site with a ravine, a fallen tree and archer cover."

### 5.5 Map updates in the thread (Plan update card)

```
┌ Plan v7 · Level 1 ──────────────────────────── 0:42 · $0.04 ┐
│ • Enlarged ④ Hall of Pillars 2 squares east                  │
│ • Added a secret door between ③ and ⑤                        │
│ • Rewrote GM notes for ④                                     │
│ 1 added · 2 changed · 0 removed                              │
│ [Show on map]  [Compare with v6]  [Undo]                     │
└──────────────────────────────────────────────────────────────┘
```
- The bullets come from the version's AI-written `changeSummary` (max 6). The count line is computed by the app from the actual diff, so the user can trust it.
- **Show on map** switches to the right level and pulses the changed rooms.
- **Compare with v6** turns on compare mode.
- **Undo** appears only on the latest card and does the same as `Ctrl+Z`.
- Room numbers in the card (④) are links that select the room.

### 5.6 Streaming, stop and retry

- AI text streams in token by token. While a plan is being produced, a **progress row** sits under the message text: spinner, current step and elapsed time. Steps: "Reading the brief", "Laying out Level 1", "Placing doors and stairs", "Furnishing", "Writing GM notes", "Checking the plan". **[DEP: arch]** The app must emit step events; without them, show "Drafting the plan…" and the elapsed time.
- The Send button becomes **Stop** in the same place, and Esc in the composer also stops. Stopping keeps any streamed text, labels the message "Stopped" and offers **Retry**. A partial plan is never applied.
- Hover toolbar on every AI message: **Retry** (re-runs the turn; the earlier answer stays reachable through a "‹ 1/2 ›" switcher) and **Copy text**.
- The user can keep typing during a generation, but can't send.
- After 60s the progress row adds "Large plans can take up to 2 minutes."

### 5.7 Composer

- Multiline; it grows to 8 lines, then scrolls. Enter sends, Shift+Enter adds a new line.
- **Reference chips** appear in a row above the text: number badge + name + ×, up to 8. They are sent as structured ids alongside the text.
- Footer (12px): the **Model & effort pill** on the left (§5.8), then the **estimate hint** "~$0.02 · ~15 s", then "Enter to send" on the right. If the cost estimate is above the per-action warning (default $0.25), the hint turns warning-coloured and Send asks to confirm (§10.13).
- Placeholder by phase: Brief: "Describe the map you want…" · Plan: "Ask for changes — click a room to point at it…" · Build: "Ask for changes (you'll re-approve and rebuild)…".
- Typing `#4` and then a space turns into the chip for room 4.

### 5.8 Model and effort (first-class control)

**Placement: both.** A quick switch sits next to the composer, because that's where the choice takes effect: it applies to the *next* message. The defaults for new projects live in Settings ▸ AI provider (§8.4). The current choice is **saved per project**, so a big dungeon project can stay on a stronger model while quick encounter maps use a cheaper one.

**The pill** (composer footer, left): `[◆ Sonnet · Balanced ▾]`. Model short name, then the effort name. Click it, or press `Ctrl+M`, to open the popover. Tooltip: "Model and effort for your next message".

**The popover** (360px wide, opens upward from the pill):

```
┌ Next message uses ───────────────────────────────────────────┐
│ MODEL                                                        │
│ ( ) Haiku     Quick drafts and chat        $    ⚡⚡⚡         │
│ (●) Sonnet    Recommended for most maps    $$   ⚡⚡    ✓    │
│ ( ) Opus      Best layouts and notes       $$$$ ⚡           │
│                                                              │
│ EFFORT  How hard Claude thinks before answering              │
│ [ Quick | Balanced | Thorough | Extra | Max ]                │
│   Balanced: good for most edits. Thorough is worth it for a  │
│   first plan or a big multi-level change.                    │
│                                                              │
│ Next plan on this setting ≈ $0.06 · about 40 s               │
│ Provider: Anthropic · Change default in Settings             │
└──────────────────────────────────────────────────────────────┘
```

- **Model rows**: name (Fraunces 15px), a plain-language line, a **relative cost** in `$` glyphs (1–4, from the pricing table) and a **relative speed** in ⚡ glyphs (1–3). Each glyph group carries text for screen readers ("cost: low", "speed: fast"). A small "Recommended" tag marks the app's default. Rows come from the provider's model list, filtered to models the app supports; unknown new models appear under "Other models ▸" with "No guidance yet".
- **Effort** is a segmented control with plain names. The API value only shows in the tooltip:

  | UI label | API value | One-line explanation (shown when selected) |
  |---|---|---|
  | Quick | `low` | Fastest and cheapest. Fine for small tweaks and chat. |
  | Balanced | `medium` | Good for most edits. |
  | Thorough | `high` | Worth it for a first plan or a big multi-level change. |
  | Extra | `xhigh` | Slower. For large, intricate maps. |
  | Max | `max` | Slowest and most expensive. Use when nothing else gets it right. |

  Levels the selected model doesn't support are **hidden**, not disabled, so the control only offers what's real. If the current effort isn't available on a newly picked model, it snaps to that model's default, and the popover says so in a line: "Opus doesn't offer Quick — using Balanced."
- **Defaults** (overridable in Settings): model = the recommended mid-tier model; effort = that model's API default if there is one, otherwise Balanced. **Smart effort** (Settings, on by default): plain chat turns (brief questions, answers with no plan change) use at most Balanced, whatever is selected, and the pill reads "Thorough for plans". The point is that you don't pay Thorough prices for "sounds good, go ahead". It's explained in the popover footer when active: "Chat-only replies use Balanced to save cost."
- **Trade-off hint**, the line at the bottom of the popover and the composer hint: "≈ $0.06 · about 40 s". It's computed from model pricing × (current context tokens + expected output for the likely action, i.e. a plan vs a chat reply) × an effort multiplier. The multiplier is learned from this user's own past turns (median per model/effort), falling back to a built-in table. Ranges are rounded (`< $0.01`, `$0.02`, `$0.05`, `$0.10`, …; `~10 s`, `~30 s`, `~1 min`, `1–2 min`) so they never look falsely precise. Tooltip: "Estimate based on your recent turns. Actual cost appears on each reply."
- **Changing mid-conversation**: it takes effect on the next message. Nothing is re-run. A system line is posted in the thread: "Now using Opus · Thorough". Every AI message's meta line (muted, 11px, under the message) records what produced it: "Sonnet · Balanced · 14 s · $0.03". The hover **Retry** button has a split menu: **Retry with… ▸** (model/effort list), so you can re-run one disappointing turn on a stronger setting without changing the project default.
- **Keyboard**: `Ctrl+M` opens the popover; arrow keys move within a group; `Tab` moves between the Model and Effort groups; `Enter` or `Esc` closes it (the choice applies immediately; there is no confirm).

**When the provider has no models, cost or effort** (local providers, §8.4): every element degrades by **disappearing or switching to a neutral statement**, never by showing a disabled control:
- No effort support: the Effort group and the "· Balanced" part of the pill are not rendered.
- No cost: `$` glyphs, the cost part of hints, the title-bar cost meter and spend warnings are hidden. The title-bar meter is replaced by a neutral chip, "Local · no API cost". The hint shows time only ("about 1 min"); if there isn't enough history to estimate time, the hint is omitted.
- No speed data: ⚡ glyphs are hidden.
- Model list fetched at runtime: rows show the server's model ids with no guidance line, plus a **Refresh** button.

---

## 6. Map panel

### 6.1 Rendering

- An SVG renderer draws the plan deterministically. One grid square is 24px at 100% zoom. The level's origin is top-left and north is up (a small "N" marker sits at the top right of the canvas).
- Layer order, bottom to top: rock/void → terrain → floor (with grid) → walls → openings → stairs and level links → features → room tint (hover/select/compare) → labels → selection bar.
- Wall technique for rectangle unions: draw the floor shapes with a thick ink stroke, then draw the same shapes again, fill only, on top. Only the outer boundary survives as a wall. Explicit interior walls are drawn from the plan's wall segments.

### 6.2 Cartographic vocabulary

Sizes are at 100% zoom (24px squares). Colours are the map tokens in §11.2.

| Element | Drawing | Non-colour cue |
|---|---|---|
| Floor | `--map-floor` fill; 1px `--map-grid` line every square | Grid |
| Rock / unbuilt | `--map-paper` fill + 45° hatch, 1px `--map-hatch`, 6px spacing | Hatching |
| Exterior wall | `--map-ink`, 4px outside the floor edge | Heavy line |
| Interior wall | `--map-ink`, 3px centred | Line |
| Door | Wall gap + 6×14px rectangle across it, floor fill, 1.5px ink stroke | Shape |
| Locked door | Door + 3px ink dot in the centre | Dot |
| Secret door | Wall drawn dashed (4/3) for the door width + bold serif **S** beside it | Letter |
| Archway / opening | Wall gap with a 4×4px ink post at each end | Posts |
| Portcullis / bars | Wall gap + a row of 4 ink dots across it | Dots |
| Window | Wall with a 1px floor-coloured slit along its length | Slit |
| Stairs | 1.5px ink treads across the footprint, the down end shaded darker; a 12px chevron pointing up the stairs | Treads + arrow |
| Level-link badge | 18px tag with an ink outline: "▲ L2", "▼ L2" or "▲ Surface". Click jumps to that level and pulses the matching stair | Text |
| Ladder / trapdoor | Rails + rungs / square with an X, each with a level-link badge | Shape |
| Shallow water | `--map-water` at 30% + 1px wavy lines every 8px | Waves |
| Deep water | `--map-water` at 60% + denser waves | Wave density |
| Tree | Scalloped circle (r 0.6–1 square), `--map-forest` 25% fill, 1.5px stroke, centre dot | Shape |
| Undergrowth / difficult | `--map-forest` stipple | Stipple |
| Rubble | Ink dots + small polygons | Stipple |
| Chasm / pit | `--map-void` fill, 2px edge | Fill |
| Pillar | Filled ink circle, r 0.35 square | Shape |
| Statue | Circle with an inner 5-point star | Shape |
| Table / bench | Rounded rectangle, floor fill, ink outline | Shape |
| Bed | Rectangle with a pillow line at one end | Shape |
| Chest | Small rectangle with a lid line | Shape |
| Altar | Double-outline rectangle | Shape |
| Sarcophagus | Coffin hexagon with a centre line | Shape |
| Brazier / light | Circle with 6 short rays, `--map-light` | Rays |
| Barrel / crate | Circle with ring / square with X | Shape |
| Bookshelf / rack | Long thin rectangle with ticks | Shape |
| Bones / debris | Ink dot cluster | Stipple |
| Trap (GM layer) | Triangle with **T**, accent | Letter |
| Other feature | Rounded square with "?"; its name in the tooltip | Letter |

Labels:
- **Room number**: a 20px circle badge in surface fill with a 1.5px ink stroke and the number in Fraunces 600 12px. It sits at the plan's `labelAnchor` or at the room's visual centre.
- **Room name** (Layers ▸ Room names; hidden below 75% zoom): 10px uppercase, letter-spaced, under the badge.
- **Numbering is per project and continues across levels** (L1 is rooms 1–7, L2 is 8–13), so "room 9" in chat is never ambiguous. Corridors have no numbers unless they're named.

Layers menu (toggles saved per project): Grid · Room numbers · Room names · Furniture · GM layer (traps, the "S" on secret doors; turning it off gives a player view) · Legend overlay.

### 6.3 Legend

A collapsible "Legend" section at the bottom of the room key. It shows only the symbols on the current level ("Show all" reveals the rest), each a 32×24px swatch drawn by the real renderer, with a label. It's also available as a canvas overlay (`L`).

### 6.4 Zoom and pan

- Zoom runs from 25% to 400% in steps of 25/50/75/100/150/200/300/400. Mouse wheel zooms around the cursor; Shift+wheel pans horizontally; touchpad two-finger scroll (deltaX present without Ctrl) pans. `+`/`-` zoom on the centre, `0` fits the level, `1` goes to 100%.
- Pan by dragging the canvas with the Pan tool, or with Space+drag or a middle-button drag in any tool. Arrow keys pan by 2 squares when the canvas has focus.
- The view **fits** the level on first open, and again when a new version changes the level's bounds.
- **Rulers** with column letters (A–Z, AA…) and row numbers appear at zoom ≥ 75%. The status bar shows the hovered square: "H12 · 35 ft E, 55 ft S". That lets a user say "put a fountain at H12".

### 6.5 Hover and selection

- **Hover a room**: an 8% accent tint and, after 400ms, a tooltip: "④ Hall of Pillars · 60×45 ft · 4 exits".
- **Hover a feature**: an accent outline and a tooltip: "Sarcophagus (in ③)".
- **Click a room** to select it: a 2px accent outline, a 12% tint, and the room key scrolls to the room and expands it. A floating **selection bar** appears above the room: `④ Hall of Pillars [Reference in chat] [Edit notes] [⋯]`.
- **Click a feature** to select it: `Pillar · in ④ [Reference] [⋯]`.
- Shift+click adds to the selection. Esc clears it. **Double-clicking a room** references it in chat straight away and focuses the composer.

### 6.6 Pointing at things in chat

- **Reference in chat** (button, `R`, Enter, or double-click) adds a chip, such as `④ Hall of Pillars ×` or `Pillar · ④`. The AI gets structured ids.
- **Region select (v1.1)**: the Region tool (`G`) or Alt+drag draws a rectangle snapped to squares and produces a chip such as `Area C3–H9 · L1`.
- **Typed references**: `#4` (§5.7). Free text like "room 4" also works, because the AI has the room index in context.
- Room key entries offer **Reference** on hover.

### 6.7 Direct manipulation in v1: text only, geometry via chat

The MVP lets the user edit **room names, level names and GM notes** directly. All geometry changes go through chat.

Why:
- The compiler and the AI both depend on a valid plan: closed walls, doors on walls, stairs linked across levels. An editor that enforces all of that interactively is a second product.
- Chat plus good pointing (click to reference, coordinates) covers the common requests ("bigger", "move the door", "add a pillar at H12") for a few cents each.
- GM notes are the most-edited text and the riskiest to round-trip through the AI. Editing them directly is cheap and very valuable.

v1.1 adds direct edits that can't break validity: delete a feature, move a feature within its room, change a door's type. "Later" covers resizing rooms and drawing walls.

### 6.8 Room key panel

A 300px panel on the right of the stage, headed "Room key · L1 Upper Crypts". It has a collapse button and a filter field (`Ctrl+F`).

- **Collapsed entry**: number badge, name (Fraunces 15px), size ("60×45 ft"), and a one-line preview of the notes (muted, ellipsised).
- **Expanded entry** (the selected room): **Read-aloud** (italic, optional), **GM notes**, **Encounter** (optional and system-flavoured, e.g. "Daggerheart: 3× Skeleton Warrior (Standard). Difficulty 14 to lift the portcullis"), and **Exits**, generated from the plan ("W door → ②, E door → ⑤"). The pencil turns fields into textareas; Ctrl+Enter saves and Esc cancels.
- Manual edits create a version ("v8 · You edited notes for ④"). Edits to the same room within 2 minutes merge into one version.
- The key lists only the current level; level tabs switch the key and the map together.
- Footer: **Legend** and **Copy room key** (Markdown to the clipboard).

### 6.9 Level tabs

- The tabs sit in the stage bar: "L1 Upper Crypts", "L2 Cistern Depths". Their order follows elevation, entry level first. The tooltip shows dimensions and room count.
- `Alt+1…9` jumps to a level; PgUp/PgDn move up or down a level.
- **+** pre-fills the composer with "Add a level below L2: ". Only the AI creates levels in the MVP.
- Double-click a tab to rename it (creates a version).
- Level-link badges on the map jump to the destination level.
- **v1.1**: a ghost underlay of the level above or below at 15% opacity, for checking stair alignment.

### 6.10 Export map as PNG (MVP)

An **Export PNG** button sits in the map toolbar (and in File ▸ Export map as PNG…, `Ctrl+Shift+E`). It opens a 320px popover anchored to the button. Each GM has one sensible default, and four toggles cover the real variations:

```
┌ Export PNG ────────────────────────────────┐
│ Levels     (●) This level  ( ) All levels  │
│ Version    [ GM | Player-safe ]            │
│ Style      [ Print (light) | As on screen ]│
│ Size       [ 70 px per square ▾ ]  2800×2100│
│ [✓] Grid   [✓] Room numbers  [ ] Room names │
│                     [Cancel] [Export…]      │
└─────────────────────────────────────────────┘
```

- **Levels**: "This level" exports one file. "All levels" writes one file per level into a folder you choose (native folder dialog), named `<Project> – L1 Upper Crypts – GM.png`.
- **Version**: **GM** (default) shows everything on screen. **Player-safe** hides traps, the "S" on secret doors (drawn as plain wall), GM-only features and room names that are marked secret; room numbers stay unless turned off. Notes are never drawn on the image in the MVP.
- **Style**: **Print (light)** (default, even in the dark theme: it's what you'd print or drop into another VTT) or **As on screen** (current theme).
- **Size**: pixels per square: 50 / 70 (default; common VTT size) / 100 / 140. The resulting pixel size is shown live. Over 8000px on either side shows a warning: "Very large image (11,200×8,400). Some apps can't open images this big."
- Toggles: Grid (on), Room numbers (on), Room names (off).
- **Export…** opens the native save dialog (or a folder dialog for all levels), then shows a toast: "Exported L1 Upper Crypts (GM) — [Show in folder]".
- The last-used options are remembered per project.
- v1.1: include the room key as a side panel on the image, a legend strip, and a one-page PDF.

---

## 7. Revision flow

### 7.1 Versions

- Every event that changes the plan creates an immutable, numbered version (v1, v2, …): AI generations, AI edits, manual text edits and restores. Numbers are never reused.
- **History panel** (`H`, toolbar button): slides over the room key, newest first. Each entry shows the number, time, author (AI / You), a one-line summary, the cost for AI versions, and Approved / Built badges. Clicking an entry previews it read-only (the banner in §2.3). Actions: **Preview**, **Compare with current**, **Restore**.
- **Restore** never deletes anything. Restoring v4 creates v9, a copy of v4 summarised as "Restored v4". The chat's references to v5–v8 still make sense.

### 7.2 Undo / redo

- `Ctrl+Z` (outside text fields) moves the **head** back one version, making v7 current again after v8. `Ctrl+Y` / `Ctrl+Shift+Z` moves it forward. A system line is posted ("Undid v8 · back to v7").
- If a new version is created while the head is back, the "future" versions stay in History, marked "undone", and the new version takes the next number. Nothing is lost.
- The **Undo** button on the latest Plan update card does the same as `Ctrl+Z`.

### 7.3 Compare

- The **Compare** toolbar toggle compares with the previous version by default; a dropdown picks any version.
- MVP: room-level compare. A room counts as added, changed or removed by its id, and "changed" covers its shape, openings, features or notes. It's drawn as in §2.3, with a chip row ("1 added · 2 changed · 0 removed") that cycles through the rooms when clicked.
- v1.1: a square-level overlay (hatched green for added floor, dashed red for removed) and a side-by-side split.

### 7.4 Branching

There's no branching in the MVP or v1.1. To try a wild alternative and keep the original, **Duplicate project** (File menu). Branches would double the cognitive load in a history that is mostly linear tweaks.

### 7.5 Approval gate

- The primary button in the status bar reads **Approve plan v7**. It's disabled while a generation is running.
- Clicking it opens a popover:
  > **Approve v7 for building?**
  > 2 levels · 13 rooms · about 5 slab chunks.
  > You can still change the plan afterwards; you'll just approve and rebuild.
  > [Approve & build] [Approve only] [Cancel]
- Only one version holds the **Approved** badge at a time; approving another version moves it.
- "Approve & build" is the default (Enter). It switches to Build and starts the build.
- **Pre-approval checks** are local and instant. **Blocking** problems (stairs that link nowhere, unreachable rooms, a level beyond the hard size limit) are listed with "Ask Slabyrinth to fix", which sends a prepared message. **Warnings** (a dead-end corridor, a room with no notes) can be approved anyway.

### 7.6 Changing the plan after building

- Chat stays fully usable, and new versions are created as usual. The approved/built version keeps its badges.
- The Build tab shows the **stale banner**: "This build is from v7. The plan is now v9. [Compare v7 → v9] [Approve v9 & rebuild]".
- After a rebuild, chunks whose content hash changed are badged **Changed** and the others **Unchanged**; Unchanged chunks keep their "Pasted" tick. Message: §12.4. MVP has the badges; a paste guide mode for "only changed chunks" is v1.1.

---

## 8. Setup, settings and trust

### 8.1 First-run Setup (dedicated window state, 640×560, centred card over the empty app)

Three steps with a dot progress indicator. Back and Next are always available; only the key step blocks.

**Step 1 · Connect Claude**
- A password field (monospace, eye toggle; placeholder `sk-ant-…`) and **Check key**. Pasting checks automatically.
- States:
  - Idle: "Paste your Anthropic API key. Slabyrinth uses it to talk to Claude; the key is stored in your system's secure storage."
  - Checking: spinner, "Checking key…"
  - Valid: success, "Key works." Masked as `sk-ant-…a1B2`.
  - Rejected (401): "Anthropic rejected that key. Check you copied all of it, or create a new one in the Console."
  - Network: "Couldn't reach Anthropic. Check your connection and try again."
  - Billing/permission: "The key is valid, but your account can't make requests right now (usually credit). Check the Anthropic Console."
- Link: "Get a key at console.anthropic.com" opens in the default browser via `shell.openExternal`.
- "Skip for now" leaves the app in the no-key state (§10.1).

**Step 2 · Find TaleSpire and its assets**
Slabyrinth builds from the asset catalog in the user's own TaleSpire install. Official content packs only; community and mod.io packs aren't supported yet. Auto-detection runs as soon as the step appears **[DEP: arch]**: Steam library folders (Windows registry `Steam\InstallPath` + `libraryfolders.vdf`; Linux `~/.steam/steam`, `~/.local/share/Steam`), then reading the official packs' index files.
- Scanning: a progress line, "Looking for TaleSpire… / Reading asset catalog…".
- Found:
  > ✓ **TaleSpire found** · `D:\SteamLibrary\steamapps\common\TaleSpire`
  > ✓ **4,812 assets** from 6 official content packs (game build Nov 2026)
  > ⓘ 154 community packs found. They aren't supported yet, so maps use official assets only.
  > [Change folder…] [Rescan]
- Not found (a warning, never a blocker):
  > ⚠ **TaleSpire wasn't found on this PC.**
  > Slabyrinth will use its **built-in asset set** (about 125 common tiles and props), so you can still design maps and copy slabs into TaleSpire. You won't get the newest tiles and props until Slabyrinth can read your install.
  > [Locate TaleSpire folder…] [Continue without it]

  Locate opens a native folder dialog and validates the folder ("That folder doesn't look like a TaleSpire install — pick the folder that contains `TaleSpire.exe`"). "Continue without it" is the default button, so pressing Enter moves on.
- Catalog unreadable (e.g. a game update changed the format): "Found TaleSpire, but couldn't read its asset library — a recent game update may have changed it. Using the built-in asset set for now." [Copy details] [Continue].
- Startup behaviour is in §8.6.1.

**Step 3 · How you play**
- Default game system (Daggerheart / D&D 5e / Other) and theme (Dark, the default, / Light / Match system). Then [Start mapping].

### 8.2 Settings dialog

A modal (760×560) with left navigation: **AI provider** (provider, key, model and effort defaults) · **Spending** · **TaleSpire & assets** · **Projects & storage** · **Appearance** · **About**.

### 8.3 API key and storage

- Same field and states as Setup Step 1, plus [Replace key] and [Remove key].
- The key is stored with **OS secure storage** (Electron `safeStorage`: DPAPI on Windows, libsecret/kwallet on Linux) **[DEP: arch]**. Trust copy, always shown:
  > Your key is encrypted with your system's secure storage and is only ever sent to api.anthropic.com. It is never written into project files.
- Linux without a keyring: "No system keyring found, so your key would be stored with weak protection. [Store anyway] [Don't store — ask each session]".

### 8.4 AI provider (built for more than one provider)

The section opens with a **provider picker**: a row of selectable cards. v1 has one active provider, but the picker is already there so adding one later is a new card, not a redesign.

```
┌ AI provider ──────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐  ┌──────────────────────────────────┐    │
│ │ ◉ Anthropic (Claude)         │  │ ○ LM Studio (local)   LATER      │    │
│ │   Cloud · your API key       │  │   Runs on this PC · no API cost   │    │
│ │   ● Connected                │  │   Coming in a later update        │    │
│ └──────────────────────────────┘  └──────────────────────────────────┘    │
│                                                                            │
│ CONNECTION   API key  [sk-ant-…a1B2      👁] [Replace] [Remove]  ✓ Works   │
│ DEFAULT MODEL      (●) Sonnet  ( ) Opus  ( ) Haiku   [rows as in §5.8]      │
│ DEFAULT EFFORT     [ Quick | Balanced | Thorough | Extra | Max ]            │
│ [✓] Smart effort — use Balanced for chat-only replies                       │
│ New projects start with these. Each project remembers its own choice.       │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Provider cards**: name, a one-line nature ("Cloud · your API key" / "Runs on this PC · no API cost") and a status ("Connected", "Not set up", "Server not running", or "Coming in a later update" in v1). In v1 the LM Studio card is shown muted and is not selectable, with a "Later" tag and the tooltip "Local models via LM Studio are planned for a later update." (Product decision: show it, so users know it's coming. Hide it if marketing prefers.)
- The area below the cards is **driven by provider capabilities**. Each provider declares: `needsKey`, `hasServerUrl`, `modelSource` (`catalog` | `fetched`), `supportsEffort` (+ levels per model), `hasCost`, `hasSpeedGuidance`. The UI renders only the sections that apply:

| Section | Anthropic (v1) | LM Studio (later) |
|---|---|---|
| Connection | API key field + validation (§8.3) | Server URL field (default `http://localhost:1234`) + **Test connection** ("Connected — 3 models loaded" / "Can't reach LM Studio at that address. Is the server running? In LM Studio: Developer ▸ Start server.") |
| Default model | Curated rows with guidance, cost and speed | Model ids fetched from `/v1/models` on the server, with **Refresh**; no guidance, cost or speed; note: "Load a model in LM Studio for it to appear." |
| Default effort | Segmented control (levels per model) | Not rendered |
| Smart effort | Checkbox | Not rendered |
| Spending (nav item) | Shown | Shown, but only for Anthropic usage; if the active provider is local, a note at the top: "Local models don't cost anything per message." |
| Quality note | — | "Local models vary a lot. Slabyrinth checks every plan and won't apply a broken one, but you may need more retries." |

- **Switching provider** (later): it applies to new messages only, posts a system line in the thread ("Now using LM Studio · qwen2.5-32b-instruct"), and is saved per project like the model.
- Per-task models (one for chat, one for plans) are v1.1 and would appear as a "Use a different model for plan generation" disclosure under Default model.

### 8.5 Spending

- Totals for the session, the project and all time, with a note: "Estimates from token counts; your Anthropic bill is authoritative."
- "Ask me before a single action over [$0.25]".
- "Warn me when a project passes [$2.00]".
- v1.1: a daily cap ("Stop and ask after $X per day").

### 8.6 TaleSpire & assets

#### 8.6.1 Asset library (MVP)

TaleSpire updates often and adds tiles and props, so the asset library is a visible, refreshable thing with a quiet indicator in the status bar.

**Settings ▸ TaleSpire & assets ▸ Asset library**

```
┌ ASSET LIBRARY ──────────────────────────────────────────────────────────────┐
│ Source        ● Your TaleSpire install                                       │
│               D:\SteamLibrary\steamapps\common\TaleSpire   [Change folder…]  │
│ Game content  Build of 12 Nov 2026 · last scanned today 21:02               │
│ Assets        4,854 tiles and props · 6 official packs                       │
│               ⓘ 154 community packs found — not supported yet                │
│ Used by maps  125 assets in 5 themes (dungeon, cave, tavern, town, forest)  │
│               [Refresh asset library]                                        │
│ THEMES & ROLES  dungeon wall → Dungeon Wall 01 · dungeon floor → …           │
│               [Edit roles…]  (later — palette editor)                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Refresh asset library** rescans the install, with a progress line, and then reports: "Asset library refreshed — 42 new assets, 0 removed." or "Already up to date."
- **Themes & roles** is read-only in v1: each theme lists its roles (dungeon wall, dungeon floor, door, torch, …) and the asset assigned to each. **Edit roles…** is a *later* palette editor, where new assets can be assigned to roles. The row is there now so the area doesn't need redesigning.

**Startup**
- Install found: the library is read (or loaded from cache) at startup. If the game's build has changed since the last scan, the app rescans automatically in the background and then shows a toast: "**TaleSpire was updated — 42 new assets found.** [View]" (View opens this panel). If nothing changed, nothing is shown.
- Install not found: a **non-blocking warning banner** under the title bar on the first launch of each session (never a modal):
  > ⚠ **TaleSpire wasn't found.** Using Slabyrinth's built-in asset set, so the newest tiles and props aren't available. You can still create and export maps. [Locate TaleSpire folder…] [Continue without it]

  "Continue without it" dismisses the banner for this session. A checkbox in the banner, "Don't remind me", stops it appearing at all.

**Quiet indicator** (status bar, right side, in every project state): a small chip.
- Normal: `▣ Assets · 4,854 · today` (muted). Click opens Asset library.
- Built-in set: `▣ Built-in assets` with a warning dot. Tooltip: "TaleSpire not found — using the built-in asset set. Click to locate it."
- Scanning: `▣ Updating assets…` with a spinner.

**When a theme references an asset that no longer exists** (renamed or removed by a game update): the build **still succeeds**, using a substitute (the closest asset with the same role and footprint, or the built-in fallback). The build result shows a warning row, never an error:
> ⚠ **2 assets used by this map aren't in TaleSpire any more, so substitutes were used.** "Dungeon Wall 03" → "Dungeon Wall 01" (38 places); "Iron Brazier" → "Brazier" (4 places). [Show on map] [Asset library]

The same notice appears once in Settings ▸ Asset library ("2 theme assets are missing — substitutes in use"), where the later palette editor would let the user choose replacements.

#### 8.6.2 TaleSpire options

- Install path and asset library: §8.6.1.
- **Levels in TaleSpire**: **Stacked** (default: each level pasted one storey higher, 2.5 tiles per storey) or **Side by side** (all levels at ground height, laid out next to each other with a gap; easier to see at the table). Open question for the user (§15).
- **Corner markers**: always included when a level has more than one chunk. A checkbox makes them optional for single-chunk levels.
- **Copy format**: Plain (default) / Wrapped in ``` (for pasting into Discord or forums).
- Export method: "Clipboard paste" (the only method in v1). A greyed row reads "In-game helper (Symbiote) — planned" (§9.5).

### 8.7 Projects and storage

- **Projects are files.** Each project is one `.slabyrinth` file (JSON, optionally zipped **[DEP: arch]**) in the projects folder, by default `Documents\Slabyrinth` on Windows and `~/Documents/Slabyrinth` on Linux; the folder can be changed. The file holds the brief, the chat transcript, every plan version, approvals and build metadata. It never holds the API key, and the slabs are not stored because they're recompiled.
- **Autosave** writes atomically (temp file + rename) on every change. There is no Save command. "Save a copy as…" uses the native save dialog.
- **Home** (§8.9) is the project browser. `Ctrl+O` opens the native open dialog filtered to `*.slabyrinth`, for files outside the projects folder.
- **Delete** moves the file to the OS recycle bin/trash (`shell.trashItem`). Confirm: "Move 'The Drowned Abbey' to the Recycle Bin? You can restore it from there." [Move to Recycle Bin] [Cancel].
- Opening a file with a newer schema: "This project was made with a newer version of Slabyrinth. Update the app to open it." Opening an invalid file: "That file isn't a Slabyrinth project."
- Opening a file that's already open focuses it. Opening a copy of an open project (same id, different path) opens it as a separate project with " (copy)" added to the name.
- App data (settings, logs) lives in the Electron `userData` folder. Help ▸ Open data folder shows it.

### 8.8 Appearance

Theme: **Dark (default)** / Light / Match system. Map style: Parchment (default) / Ink-on-white (v1.1, higher contrast). PNG export has its own Print style (§6.10).

### 8.9 Home screen and resuming

Every map is a project that autosaves its chat, brief, all plan versions, approvals, build and paste progress, map view (level, zoom, pan), and the unsent composer draft. Resuming has to feel like you never left.

**Home** (shown on launch; also via the wordmark, File ▸ Home, or `Ctrl+W` closing a project). It fills the window under the title bar; the stepper and cost meter are hidden.

```
┌ ☰ [▦] Slabyrinth ─────────────────────────────────────────────── $4.12 this month  ◐ ⚙ – □ ✕ ┐
│  Good evening.                                                  [+ New map]  [Open file…]   │
│  ┌ CONTINUE ─────────────────────────────────────────────────────────────────────────────┐  │
│  │ [ L1 thumbnail ]  The Drowned Abbey                                Plan v7 · not approved│  │
│  │                   Dungeon · Daggerheart T2 · 2 levels · 13 rooms · edited 2 days ago    │  │
│  │                   Last: "Enlarged ④ Hall of Pillars; secret door ③→⑤"                    │  │
│  │                   [Continue ⏎]                                                          │  │
│  └─────────────────────────────────────────────────────────────────────────────────────────┘  │
│  RECENT                                         [Search maps…]  Sort: Last edited ▾          │
│  [thumb] Saltmarsh Watchtower   [thumb] Thornwood Ambush   [thumb] Market at Lowbridge  …   │
│  Built · pasted 5/5             Brief · no plan yet          Plan v3                         │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Continue card**: the most recently edited project, with a thumbnail of the level last viewed, its phase badge, a one-line description, "edited 2 days ago", and the latest change summary. **Enter** continues (the card's button has focus on load).
- **Project cards** (grid, 220px wide): thumbnail (or a grid-paper placeholder with the mark for brief-only projects), name (Fraunces), phase badge (Brief / Plan vN / Approved vN / Built · pasted 3/5 / Stale), last edited, and spend. Hover ⋯ menu: **Open** · **Rename** · **Duplicate** · **Export PNG…** · **Save a copy as…** · **Show in folder** · **Move to Recycle Bin**. F2 renames, Delete moves to the recycle bin (with confirm, §8.7), Ctrl+D duplicates.
- **Search** filters by name, brief and room names. **Sort**: last edited (default), name, created.
- **Empty Home** (first run, after Setup): "No maps yet." + the four starter prompts as large cards; clicking one creates a project with that prompt in the composer.
- Setting: "On launch: Show Home (default) / Reopen last project".

**Reopening a project** restores the exact view: the same tab, level, zoom/pan, room key scroll, expanded brief state, and the draft in the composer. The thread is scrolled to the bottom. If more than 6 hours have passed since the last activity, a **"Where we left off" card** is inserted at the session boundary. It is generated by the app from project data (no AI call, no cost):

```
┌ Where we left off · 2 days ago ─────────────────────────────────────┐
│ Plan v7 of 2 levels, not yet approved.                              │
│ Last change: enlarged ④ Hall of Pillars; secret door ③ → ⑤.          │
│ Your unsent message is still in the box below.                      │
│ [Show the map]  [Approve v7]                                        │
└──────────────────────────────────────────────────────────────────────┘
```
Variants: brief only ("We were settling the brief. Next step: draw the first plan."); built ("Build of v7 · 3 of 5 chunks pasted. [Resume paste guide]"); stale ("Plan changed after the last build. [Approve v9 & rebuild]"); interrupted ("Your last request was interrupted when Slabyrinth closed. Nothing was changed. [Retry]").

- **Conversation continuity**: the AI gets the conversation and the current plan when chatting resumes. If the history is long, older turns are summarised for the model **[DEP: arch]**. When that happens, a system line says once: "Older messages are summarised for Claude to keep costs down. The full chat is still here." Nothing is ever deleted from the visible thread.
- Paste-guide progress (copied/pasted ticks and current step) is part of the project, so "Resume paste guide" continues at the right step.

---

## 9. Build and export

**Ground truth from the format research** (`docs/talespire-slab-format.md`): a board can't be opened or created from outside TaleSpire, so **v1 export is copy to clipboard only**. A pasted slab goes "in hand" and follows the cursor, snapped to the grid; the app can't control where it lands. The size limit is **30 KB** (30,720 bytes of compressed data). A level too big for one slab is split into chunks that **all share an identical bounding box**, because the app adds two small **corner marker tiles** (at the north-west and south-east corners, just outside the map) to every chunk. That means every chunk of a level is pasted **on the same cell**. Upper levels are separate slabs pasted **one storey (2.5 tiles) higher**.

### 9.1 Build tab before and during a build

- Nothing approved: "Approve a plan to build it for TaleSpire." [Go to plan].
- Approved but not built: an explainer (§12.3) and **Build v7 for TaleSpire**.
- TaleSpire not found: Build still works with the built-in asset set. The build header says "Built with the built-in asset set · [Locate TaleSpire folder…]".
- Building: overall progress, then a row per level: "L1 Upper Crypts — placing tiles · 2,314 assets" → "Splitting into chunks · 3" → "✓ Ready". [Cancel]. "Building happens on this PC and doesn't use your API key."

### 9.2 Build result: the paste checklist

The result is a **checklist in paste order**: levels bottom-up (with Stacked levels; plan order with Side by side), then chunks within each level. Each step has a number shown on its Copy button, so the user always knows what's next.

```
┌ Built from v7 ✓ · 2 levels · 5 slabs · 21:41 ────────────────────────────── [Rebuild] [⋯] ┐
│ ┌ Get it into TaleSpire ───────────────────────────────────────────────────────────────┐   │
│ │ [▶ Paste guide · step 6 of 8]  Copies each slab in order, opens TaleSpire, and tells  │   │
│ │                                you where to paste it. You paste with Ctrl+V.          │   │
│ └────────────────────────────────────────────────────────────────────────────────────────┘ │
│ ① L2 Cistern Depths · ground level · 2 chunks                              2/2 pasted ✓   │
│ ② L1 Upper Crypts · +1 storey (2.5 up) · 3 chunks                           1/3 pasted     │
│ [mini] [3 Copy & open TaleSpire][Copy]  Chunk 1 · West · cols A–N · copied 21:44  ☑ Pasted │
│                                         21.4 / 30 KB ▓▓▓▓▓▓▓░░░                             │
│        [4 Copied ✓ · TaleSpire opened][Copy] Chunk 2 · Centre · copied just now   ☐ Pasted │
│                                         27.9 / 30 KB ▓▓▓▓▓▓▓▓▓░ near limit                  │
│        [5 Copy & open TaleSpire][Copy]  Chunk 3 · East · not copied                ☐ Pasted │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Level header**: order number, level name, placement ("ground level" / "+1 storey (2.5 up)" / "side by side: 10 squares east of L2"), chunk count, and pasted progress ("1/3 pasted" with a bar; "✓" when complete).

**Chunk row**:
- **Copy & open TaleSpire** (primary) and **Copy** (secondary) buttons (§9.4). The primary button carries the global step number ("3"). States: `Copy & open TaleSpire` → **`Copied ✓ · TaleSpire opened`** (success styling for 2.5 s; the row stays marked as the current chunk) → back to normal. If a whole level fits in one slab, the row reads "Whole level".
- **Label line**: "Chunk 2 · Centre · cols O–AB · copied 21:44". The column range maps back to the 2D map; hovering the row highlights its region on the mini-map.
- **Size gauge** under the label line, against 30 KB: "27.9 / 30 KB". Ink fill below 80%; warning fill from 80% with the text "near limit". The compiler guarantees every chunk is under the limit. If one somehow isn't, the row shows "Over the 30 KB limit — TaleSpire will refuse it. [Rebuild with smaller chunks]" and Copy is disabled.
- **Copy tracking** (automatic): "not copied" → "Copied 21:44". This answers "did I already grab this one?".
- **Pasted checkbox** (manual, because the app can't see into TaleSpire). Ticking it also marks it copied. The paste guide ticks it when you press Next.
- ⋯ menu: **Show slab text** (read-only monospace, Select all) · **Save as .txt…** · **Copy wrapped in ```**.

### 9.3 Paste guide (MVP; the primary path)

The paste guide is a focused stepper docked on the right of the build checklist (380px). On windows under 1500px wide it replaces the checklist; **Exit guide** or Esc returns to it. Starting the guide copies the first slab immediately. Progress dots show all steps; the current one is accent-coloured.

**Steps for the sample project** (2 levels, stacked): 1 Prepare · 2 L2 chunk 1 · 3 L2 chunk 2 · 4 Go up a storey · 5 L1 chunk 1 · 6 L1 chunk 2 · 7 L1 chunk 3 · 8 Tidy up.

Step copy (target wording; key presses to be confirmed in game **[DEP: slab: anchor point and height behaviour, research §4 open items]**):

**Prepare**
> Open your board in TaleSpire and switch to build mode. Find a flat, empty area of at least 42×32 squares (the map plus a border for the markers). Don't build anything on it yet.
> [Open TaleSpire] [Next: copy the first slab & open TaleSpire]

**First chunk of the first level**
> **L2 · Chunk 1 of 2** — ✓ On your clipboard
> 1. In TaleSpire, press **Ctrl+V**. The slab follows your cursor.
> 2. Move it where you want the map. **Press and hold left-click** to place it.
> 3. Right-click to let go of the slab.
> 4. Note the two **gravel markers** at its corners. Every other chunk lines up on them.
> [Next: copy chunk 2]

**Following chunks of the same level**
> **L2 · Chunk 2 of 2** — ✓ On your clipboard
> 1. Press **Ctrl+V**.
> 2. Point at the **same marker cell** as before. The new chunk's markers should sit exactly on top of the old ones.
> 3. Press and hold left-click to place it, then right-click to let go.
> Tip: don't move the camera between chunks. Aim at the marker or the empty ground outside the map, not at walls you've already placed (aiming at tiles can lift the paste).

**Going up a storey** (Stacked only)
> **Up one storey for L1 Upper Crypts**
> Upper levels sit one storey higher: **2.5 tiles**. Raise your build height by 2.5 (in TaleSpire: raise the build plane with **G**) and line L1's corner markers up above L2's markers. If you're unsure, paste L1 next to L2 instead; you can switch to Side by side in the build options.
> (Side-by-side variant: "Paste L1 with its north-west marker 10 squares east of L2's south-east marker.")

**Tidy up**
> **Done — 5 of 5 slabs pasted.** Delete the gravel corner markers (2 per level) in TaleSpire. If a chunk landed wrong, select it in TaleSpire, delete it, and paste it again from the checklist.
> [Back to build] [Copy room key] [Export PNG]

Controls: [◀ Back] [Copy again] … [**Next: copy chunk 3 & open TaleSpire ▶**]. `N` or `Ctrl+Shift+C` presses Next. Next ticks the current chunk Pasted and copies the next one. Back doesn't untick anything.

### 9.4 "Copy & open TaleSpire" (the per-chunk primary action)

Nothing outside the game can open a board or put a build into it. What the app *can* do is copy the slab and then bring TaleSpire to the front, so the user's next action is Ctrl+V. Each chunk row therefore has two buttons:

- **Primary: `[4] Copy & open TaleSpire`.** It copies the slab to the clipboard, then launches TaleSpire or brings it to the front. The primary style goes on the next unpasted chunk; the other rows show the same button in secondary style. Tooltip: "Copies this slab, then brings TaleSpire to the front. Paste it there with Ctrl+V in build mode."
- **Secondary: `Copy`** (icon + short label): copies only, for users who keep TaleSpire on another monitor.

The wording never says "import", "send to board" or "open board". The confirmation always ends with the user's action: "press Ctrl+V".

| Situation | What happens | Toast copy |
|---|---|---|
| TaleSpire running | Copy, then bring its window to the front **[DEP: arch: window focus on Windows; best effort on Linux]** | **Slab 4 of 5 copied.** In TaleSpire, press Ctrl+V in build mode. |
| Installed, not running | Copy, then launch via Steam. The clipboard stays filled while the game starts | **Slab 4 of 5 copied. Starting TaleSpire…** Open your board, switch to build mode, and press Ctrl+V. |
| Running, but focusing isn't possible (some Linux setups) | Copy only | **Slab 4 of 5 copied.** Switch to TaleSpire (Alt+Tab) and press Ctrl+V. |
| Launch failed | Copy succeeded; launch didn't | **Slab copied, but TaleSpire didn't start.** Start it from Steam, then press Ctrl+V in build mode. |
| TaleSpire not found on this PC | The primary button becomes **`[4] Copy slab`**, with a small "TaleSpire not found" hint and [Locate TaleSpire folder…] | **Slab 4 of 5 copied.** Paste it in TaleSpire with Ctrl+V in build mode. |

The paste guide uses the same action. Its Next button reads "**Next: copy chunk 3 & open TaleSpire**" (or "Next: copy chunk 3" when not found). A "Prepare" step that has nothing to copy offers a plain **Open TaleSpire** button.

### 9.5 Later: in-game helper (Symbiote)

A companion **TaleSpire Symbiote** (the official in-game mod panel) could take each slab straight into the user's hand in game, so there's no clipboard round-trip: a "Next chunk" button would sit inside TaleSpire. The slab still lands in hand, so placement and the marker technique stay the same. Design hooks now: Settings ▸ TaleSpire shows an "Export method" row (Clipboard / In-game helper), and the paste guide's step copy is written so "Press Ctrl+V" can become "Click **Next** in the Slabyrinth panel in TaleSpire".

### 9.6 Isometric / 3D preview

**Later.** The 2D map is a faithful preview, and the compile is deterministic, so the 3D result is predictable. A 3D/iso preview is costly, and a rough approximation could mislead. In v1.1, a **Build stats** panel per level (asset counts by type, wall height, total tiles) does the scale check much more cheaply.

### 9.7 Plan too large

If a level would produce more than 6 chunks: "Level 2 is very large (160×120 squares → 9 slabs). That's a lot of pasting. [Build anyway] [Ask Slabyrinth to shrink it]".

### 9.8 Rebuilding after changes

After a rebuild, chunks whose content changed are badged **Changed**, and the others **Unchanged** (their Pasted tick carries over). Because every chunk of a level shares one bounding box, re-pasting a changed chunk on the markers puts it back in exactly the right place. The user only needs to delete the old tiles in that chunk's area first (§12.4).

## 10. Errors and edge states (copy)

Errors tied to a chat turn use the **Error card** (danger left rule, icon, title, body, actions). App-wide problems use a **banner** under the title bar. Confirmations use **toasts** (bottom centre of the stage, 4s, `aria-live=polite`). Raw errors are never shown; "Details ▸" reveals the HTTP status, request id and message, with Copy details.

| # | Situation | Where | Copy | Actions |
|---|---|---|---|---|
| 10.1 | No API key | Banner; composer disabled | **Add your Anthropic API key to start.** Slabyrinth uses your own key; it stays on this computer. | [Add key] |
| 10.2 | Key rejected (401) | Banner + card on the failed turn | **Your API key was rejected.** It may have been revoked or mistyped. Your message is kept — fix the key and press Retry. | [Open settings] [Retry] |
| 10.3 | Rate limited (429) / overloaded (529) | Card; auto-retry with backoff | **Anthropic is busy — retrying in 12s.** After 3 tries: **Still busy.** Try again in a minute, or switch model. | [Retry now] [Switch model] [Cancel] |
| 10.4 | Billing / credit | Card | **Your Anthropic account can't make requests right now.** This usually means credit has run out. | [Open Anthropic Console] [Retry] |
| 10.5 | Model refusal | The AI text as returned + a muted note | "The plan wasn't changed." | [Rephrase] |
| 10.6 | Truncated / invalid plan | Card; map unchanged | **That plan came back incomplete, so I didn't apply it.** Your map is still v7. Very large maps cause this — try again, or ask for one level at a time. Details ▸ | [Try again] [Repair it] (sends the validation errors back to the AI) |
| 10.7 | Clipboard write fails | Inline on the button + toast | **Couldn't copy to the clipboard.** Use Show text and press Ctrl+C, or save it as a file. | [Show text] [Save as file…] |
| 10.8 | Offline | Persistent banner + title bar dot | **You're offline.** You can browse plans, edit notes and build; chatting needs a connection. | (clears itself) |
| 10.9 | Connection drops mid-stream | Card | **Connection lost while drafting.** Nothing was changed. | [Retry] |
| 10.10 | Plan too large | Build tab | §9.7 | |
| 10.11 | Save fails (disk full, permissions, folder moved) | Danger banner | **Couldn't save "The Drowned Abbey".** Slabyrinth can't write to the projects folder. Your work is kept in memory — choose another location. | [Save a copy as…] [Change projects folder] |
| 10.12 | Can't open a file | Dialog | **That file isn't a Slabyrinth project** / **was made by a newer version of Slabyrinth**. | [OK] |
| 10.13 | Spend warning | Confirm popover on Send | **This will cost about $0.31.** That's over your $0.25 per-action limit. | [Send] [Cancel] [Change limit] |
| 10.14 | Generation over 3 min | Progress row | **Still working (3:10).** Large plans can take a while. You can stop and ask for a smaller map. | [Stop] |
| 10.15 | Copy & open: TaleSpire won't launch or focus | Toast | §9.4 table (the copy always succeeds first) | — |
| 10.15b | TaleSpire not found / library unreadable | Non-blocking banner + status chip | §8.6.1 | [Locate TaleSpire folder…] [Continue without it] |
| 10.15c | Theme asset missing after a game update | Build result warning row | §8.6.1 (substitutes used; the build succeeds) | [Show on map] [Asset library] |
| 10.15d | PNG export fails (disk, permissions) | Toast | **Couldn't save the image.** Choose another folder and try again. | [Export again…] |
| 10.16 | Secure storage unavailable (Linux) | Settings | §8.3 | |
| 10.17 | Saved model no longer offered (retired or unavailable to this key) | Pill shows warning outline; card on next send | **Sonnet 4.x is no longer available on your key.** Pick another model to continue; your project is unchanged. | [Choose model] |
| 10.18 | Effort rejected by the API for this model | Silent fallback + system line | "Opus didn't accept Max effort — used Extra instead." | — |
| 10.19 | (Later) Local server not reachable | Card | **Can't reach LM Studio at localhost:1234.** Start the server in LM Studio, or switch provider. | [Retry] [Open AI settings] |

---

## 11. Visual design

### 11.1 Direction: "Surveyor's desk"

Warm drafting paper, iron-gall ink, and one cinnabar red: the cartographer's correction pencil. The UI is quiet and typographic, and the map is the hero. Fantasy flavour is limited to the serif used for names and to the cartographic hatching. No parchment textures, no scroll borders, no runes.

**Dark is the default theme and was designed first** ("night survey": a lamp-lit desk; warm charcoal surfaces, bone-coloured ink, and a lighter cinnabar so it reads on dark). In dark, the map is still clearly a *map*: the rock is near-black with a faint warm hatch, floors are a lifted warm grey, and walls are drawn in bone ink, so rooms read as light shapes cut out of darkness, like a lantern's view of a dungeon. Light theme is the same system on paper. Neither theme uses pure black or pure white surfaces.

### 11.2 Colour tokens

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F3EEE4` | `#14120F` | App background, stage surround (dark = default) |
| `--surface` | `#FBF8F2` | `#1C1915` | Panels, chat pane, cards |
| `--surface-2` | `#EFE8DB` | `#26221D` | User bubbles, hovers, inputs |
| `--surface-3` | `#E6DDCC` | `#302B25` | Pressed, selected list items |
| `--line` | `#DDD3C2` | `#37312A` | Borders, dividers |
| `--line-strong` | `#C7BBA6` | `#4A4239` | Input and button borders |
| `--ink` | `#1E1A15` | `#EDE6D9` | Primary text |
| `--ink-2` | `#4E463C` | `#C3B9A8` | Secondary text |
| `--muted` | `#71675A` | `#978D7E` | Tertiary text, placeholders |
| `--accent` | `#B4412C` | `#E2765C` | Primary buttons, selection, links |
| `--accent-hover` | `#963321` | `#EC8C74` | |
| `--accent-tint` | `rgba(180,65,44,.10)` | `rgba(226,118,92,.14)` | Selection fills, selected chips |
| `--on-accent` | `#FFFFFF` | `#1A0E0A` | Text on accent |
| `--success` | `#3E7449` | `#7BBF86` | Copied, valid |
| `--warning` | `#9A6410` | `#E0AE55` | Near limit, stale, spend warnings |
| `--danger` | `#AE2A20` | `#F07C70` | Errors |
| `--info` | `#2F6A80` | `#79B8CC` | Informational |
| `--focus` | `#1D5FD1` | `#7DA8FF` | Focus ring (deliberately not the accent) |

Map tokens:

| Token | Parchment · light | Parchment · dark ("night survey") | Ink-on-white (v1.1) |
|---|---|---|---|
| `--map-paper` (rock) | `#E8DFCE` | `#181511` | `#FFFFFF` |
| `--map-hatch` | `#BCAE94` | `#3A332A` | `#A0A0A0` |
| `--map-floor` | `#FCF8EF` | `#2B261F` | `#FFFFFF` |
| `--map-grid` | `#E6DCCB` | `#3A332B` | `#E2E2E2` |
| `--map-ink` | `#2A231B` | `#E6DCCB` | `#000000` |
| `--map-water` | `#3F7F8F` | `#5DA3B4` | `#3F7F8F` |
| `--map-forest` | `#4D6B37` | `#86A86A` | `#3E5A2B` |
| `--map-light` | `#C08A1E` | `#E5B54E` | `#A0700F` |
| `--map-void` | `#14110D` | `#050403` | `#000000` |

### 11.3 Typography

- **UI**: "IBM Plex Sans", falling back to `"Segoe UI", Ubuntu, system-ui, sans-serif`; weights 400/500/600.
- **Display / names** (wordmark, project, room and level names, dialog titles, room badges): "Fraunces" 500–600, falling back to `Georgia, "DejaVu Serif", serif`.
- **Mono** (slab text, sizes, coordinates, costs, keys): "IBM Plex Mono", falling back to `Consolas, "DejaVu Sans Mono", monospace`.
- All fonts are **bundled in the app** (OFL), with no network fonts. (The mockup loads them from Google Fonts, with the same fallbacks.)

Scale (px/line-height): 11/16 caps label (600, +0.06em) · 12/16 meta · 13/20 small UI · 14/22 body · 15/22 room names (Fraunces) · 18/24 panel titles (Fraunces) · 22/28 dialog titles · 28/34 empty-state headline.

### 11.4 Spacing, radii, elevation, sizes

- Spacing: 4 · 8 · 12 · 16 · 20 · 24 · 32 · 48.
- Radii: `--r-sm` 4px (tags, reference chips) · `--r-md` 6px (buttons, inputs) · `--r-lg` 10px (cards, panels) · `--r-xl` 14px (dialogs) · pill 999px (quick-reply chips).
- Borders do most of the work. Shadows are only for floating things: `--shadow-pop: 0 8px 24px rgba(30,20,10,.14), 0 1px 2px rgba(30,20,10,.08)`, or `0 8px 24px rgba(0,0,0,.5)` in dark.
- Heights: buttons 32px (sm 26, lg 40) · inputs 32px · tabs 36px · title bar 44px · status bar 48px.

### 11.5 Components

- **Primary button**: accent fill, on-accent text, 600 weight, r-md; accent-hover on hover; disabled at 40% opacity.
- **Secondary button**: surface fill, 1px line-strong border, ink text; surface-2 on hover.
- **Icon button**: 32×32, transparent, surface-2 on hover. Always has a tooltip and an aria-label.
- **Quick-reply chip**: pill, 28px, line-strong border. Selected: accent-tint fill, accent border, check icon.
- **Reference chip**: r-sm, surface-3 fill, number badge + name + ×.
- **Cards**: surface, 1px line, r-lg, 12–16px padding. A 3px left rule marks the type: ink for plan updates, success for builds, danger for errors, warning for stale.
- **Tabs**: text with a 2px ink indicator underneath. The accent is reserved for actions and selection.
- **Focus ring**: 2px `--focus` outline, 2px offset, on every focusable element; never removed.
- **Toast**: inverted (ink background, surface text), r-md, icon + text + an optional action.
- **Size bar**: 6px tall with 3px radius; surface-3 track, ink-2 fill (warning fill at 80% and over), always with a numeric label.

### 11.6 Motion

150ms ease-out for hovers and popovers, 250ms cross-fade between map versions, a single 300ms pulse on changed rooms, and nothing over 400ms. With `prefers-reduced-motion`, a static outline shows for 2s instead of the pulse, and there are no cross-fades.

### 11.7 Brand mark and icons

- **Mark**: a rounded square "slab" (r 4 at 24px) with a three-ring labyrinth cut into it in ink. One short path segment to the centre is in accent: the route through. It's legible at 16px (taskbar), where it simplifies to two rings plus the accent path. App icon: the same mark in ink on `#F3EEE4` paper, with dark and light variants for Linux.
- **Wordmark**: "Slabyrinth" in Fraunces 600, tracking −0.01em.
- **Icons**: Lucide-style, 1.5px stroke, 16/20px, bundled as SVG.

---

## 12. Copy deck

### 12.1 Empty map stage
> **No map yet**
> Chat on the left to settle the brief. When you're ready, I'll draw a plan here — every room numbered, with notes for you.
> [Draw the first plan] (enabled once Map type is set; otherwise muted: "Tell me what kind of place it is first.")

### 12.2 First plan tip (once, dismissible, above the status bar)
> Click a room to point at it in chat. Ask for changes in plain words — "make ④ bigger", "add a secret door from ③ to ⑤". When it looks right, **Approve** it.

### 12.3 Build explainer
> **Ready to build v7**
> Slabyrinth turns the approved plan into TaleSpire slabs: text you copy here and paste into TaleSpire. Big levels are split into a few chunks that all paste on the same spot, lined up by two small corner markers. The paste guide walks you through it.

### 12.4 Rebuild after changes
> **2 of 5 chunks changed.** In TaleSpire, delete the tiles in those chunks' areas, then paste the new chunks on the same corner markers. Unchanged chunks can stay.

### 12.5 Copy toast
> **Slab 4 of 5 copied** (L1 · Chunk 2). Switch to TaleSpire and press Ctrl+V.

---

## 13. Accessibility and keyboard

### 13.1 Focus order

Title bar (menu → wordmark → project name → stepper → cost → model → theme → settings) → chat (brief card → thread → reference chips → composer → send) → stage bar (Map/Build → level tabs) → toolbar → canvas → room key → status bar (approve). `F6` cycles through these regions; there are also skip shortcuts (`/` composer, `Ctrl+1` map).

### 13.2 Shortcuts (canonical)

| Keys | Action |
|---|---|
| `/` | Focus composer |
| `Enter` / `Shift+Enter` (composer) | Send / new line |
| `Esc` | Stop generation (composer) · clear selection · close popover · exit paste guide |
| `Ctrl+Z` / `Ctrl+Y`, `Ctrl+Shift+Z` | Undo / redo plan version (outside text fields) |
| `Ctrl+N` / `Ctrl+O` / `Ctrl+Shift+S` / `Ctrl+W` | New / Open / Save a copy as / Close project (to Home) |
| `Ctrl+Shift+H` | Home |
| `Ctrl+Shift+E` | Export map as PNG |
| `F2` · `Ctrl+D` · `Delete` (Home, card focused) | Rename · Duplicate · Move to Recycle Bin |
| `Ctrl+,` | Settings |
| `Ctrl+1` / `Ctrl+2` | Map tab / Build tab |
| `Ctrl+\` / `Ctrl+]` | Toggle chat pane / room key |
| `Ctrl+Shift+B` | Toggle Brief card |
| `Ctrl+B` | Build (when approved) |
| `Ctrl+Shift+A` | Approve current version (opens popover) |
| `Ctrl+F` | Filter room key |
| `Ctrl+M` | Model & effort popover |
| `Alt+1…9`, `PgUp/PgDn` | Switch level |
| `V` · Space (hold) · `G` | Select tool · temporary pan · region tool (v1.1) |
| `+` `-` `0` `1` | Zoom in / out / fit / 100% |
| Arrows (canvas) | Pan 2 squares; `Tab`/`Shift+Tab` cycle rooms when one is selected |
| `R` or `Enter` (room selected) | Reference in chat |
| `E` (room selected) | Edit notes |
| `C` · `H` · `L` | Compare · History · Legend overlay |
| `N`, `Ctrl+Shift+C` | Paste guide: next chunk |
| `F11` | Full screen |
| `?` | Shortcut sheet |
| `Alt` | Open app menu |

### 13.3 Map accessibility

- The canvas has `role="application"` and the label "Map of Level 1, Upper Crypts, 7 rooms". Rooms are focusable (roving tabindex), labelled e.g. "Room 4, Hall of Pillars, 60 by 45 feet, exits west, north, east, south".
- The room key, with its exits, is the accessible equivalent of the map: the whole workflow can be done from it.
- No meaning relies on colour alone: water has waves, rock has hatching, door types differ by shape or letter, compare uses NEW/Δ/✕ tags and line styles, selection is outline + tint + selection bar, and warnings always carry text.
- Contrast: body text ≥ 4.5:1 in both themes; map ink on floor ≥ 10:1; accent on surface ≥ 4.5:1 (light `#B4412C` on `#FBF8F2` ≈ 5.6:1; dark `#E2765C` on `#1C1915` ≈ 6.1:1).
- Screen readers don't hear streaming token by token. When a reply completes, "Slabyrinth replied" is announced, plus the update card's summary. Toasts are polite; errors are assertive.
- Hit targets are at least 28px; map features get an invisible 12px hit halo.

---

## 14. Scope

| Feature | MVP | v1.1 | Later |
|---|:-:|:-:|:-:|
| Custom title bar, app menu, min size, single instance, file association | ● | | |
| First-run Setup (key, TaleSpire detection + asset catalog read, defaults) | ● | | |
| Community / mod.io content packs in the catalog | | | ● |
| Two-pane workspace, phase stepper | ● | | |
| Chat: streaming, stop, retry, markdown subset | ● | | |
| Welcome, starter prompts | ● | | |
| Brief card (AI + user editable) | ● | | |
| Question cards with chips | ● | | |
| Plan update cards (AI summary + computed counts) | ● | | |
| Generation progress steps | ● | Progressive map render while streaming | |
| 2D renderer, full §6.2 vocabulary, legend | ● | | |
| Level tabs, clickable level links | ● | Ghost underlay | |
| Zoom/pan/fit, rulers, coordinates | ● | | |
| Room numbers, room key, edit names/notes | ● | | |
| Click → reference chip, `#n` references | ● | | |
| Region select reference | | ● | |
| Safe direct edits (move/delete feature, door type) | | ● | |
| Geometry editing | | | ● |
| Versions, history, restore, undo/redo | ● | | |
| Compare (room level) | ● | Square overlay, side by side | |
| Branching | | | ● (Duplicate project for now) |
| Approve gate with pre-checks | ● | | |
| Build: progress, paste-order checklist, numbered Copy slab buttons, 30 KB gauges, copied/pasted tracking | ● | | |
| Paste guide (same-cell marker technique, storey step, tidy-up) | ● | "Only changed chunks" mode; always-on-top mini guide | |
| Changed/Unchanged badges after rebuild | ● | | |
| Show text / save as .txt / copy wrapped in ``` | ● | | |
| "Copy & open TaleSpire" per chunk (+ plain Copy) | ● (launch via Steam; focus on Windows) | Focus on Linux | |
| Asset library: scan at startup, auto-rescan after game updates, Refresh, status chip, substitute warnings | ● | | |
| Built-in asset set fallback when TaleSpire isn't found (non-blocking warning) | ● | | |
| Palette editor (assign assets to roles) | | | ● |
| Open a board or import content from outside the game | — not possible (format research) | | |
| In-game helper Symbiote (slab straight to hand) | | | ● |
| Export map as PNG (level/all, GM/player-safe, print/screen style, px per square, grid/numbers/names) | ● | Room key + legend on image, PDF | |
| Home with Continue card, recent projects, rename/duplicate/delete | ● | | |
| Resume exactly where you left off (view, draft, paste progress) + "Where we left off" card | ● | | |
| Import slab as stamp (§17) | | | ● |
| Build stats | | ● | |
| Isometric/3D preview | | | ● |
| Key in OS secure storage, spend warnings, cost meter | ● | Daily cap | |
| Model & effort pill + popover, per-project choice, Retry with…, per-turn meta line | ● | | |
| Smart effort (lighter effort for chat-only turns) | ● | | |
| Learned cost/time estimates (from own history) | ● (built-in table fallback) | | |
| Settings ▸ AI provider with provider picker (Anthropic active, LM Studio shown as "Later") | ● | | |
| Per-task models (chat vs plan) | | ● | |
| LM Studio (local) provider: server URL, fetched models, no key/cost/effort | | | ● |
| Projects as `.slabyrinth` files, autosave, native dialogs | ● | | |
| Copy room key as Markdown | ● | | |
| Dark theme (default) + Light + Match system | ● | Ink-on-white map style | |
| Auto-update | | ● **[DEP: arch]** | |
| Command palette, sketch upload | | | ● |

The MVP covers the four-step workflow end to end: chat to a brief, iterate on a numbered 2D plan with real pointing and undo, approve, and paste into TaleSpire with a guide that makes it reliable.

---

## 15. Open questions for the user

1. **Levels in TaleSpire: stacked a storey apart (2.5 tiles), or side by side?** Stacked is immersive (the default in this design). Side by side is easier to paste and to see at the table.
2. **How much should the GM notes contain?** Description only, or also read-aloud text and system-specific encounters (Daggerheart adversaries and Difficulty, D&D CR)? More content costs more per plan.
3. **Spending comfort**: what per-action and per-project amounts should trigger a warning?
4. **Asset style**: pick TaleSpire tile sets per map (e.g. stone dungeon vs cave), or let the plan's terrain choose?
5. **PNG defaults**: should PNG export default to the light Print style or match the dark screen, and what pixels-per-square does your other tooling expect (70 is assumed)?
6. **On launch**: open on Home (designed default) or jump straight back into the last map?

---

## 16. Requirements on the data model (for the architect)

The UI depends on the following. The names are suggestions; the semantics are requirements.

**Project**
- `id` (stable; used to detect duplicates when opening), `name`, `createdAt`, `updatedAt`, `schemaVersion`, `appVersion`.
- `brief`: `{ mapType, system: "daggerheart"|"dnd5e"|"other", party: {tier?|level?, size}, footprint: {preset, widthSq, heightSq}, levels: {count, names[]}, tone, mustInclude[], avoid[] }`, with a `source: "ai"|"user"` flag per field.
- `ai`: the project's current `{ providerId, modelId, effort|null }`.
- `messages[]`: `id`, `role`, `content`, `createdAt`, `references[]` (structured `{type: room|feature|area|level, id, levelId}`), `attachedVersionNumber`, `usage {providerId, model, effort|null, inputTokens, outputTokens, durationMs, costEstimate|null}`, `status` (complete / stopped / error + error code), `alternatives[]` (for Retry), and an optional `questionCard {questions[{id, text, default, options[]}], answers}`.
- `versions[]` (immutable): `number` (monotonic), `parentNumber`, `createdAt`, `author: "ai"|"user"|"restore"`, `summary` (one line), `changeSummary[]` (≤6, from the AI), `messageId`, `cost`, `plan`.
- `headVersionNumber` (for undo/redo), `undoneVersionNumbers[]`, `approvedVersionNumber?`.
- `builds[]`: `{ versionNumber, createdAt, catalogVersion, settings {stacking, gapSq, markers, copyFormat}, levels: [{ levelId, pasteOrder, placement {kind: "ground"|"storeys-up"|"side-by-side", storeys?, offsetSq?}, chunks: [{ index, globalStep, label, region {x0,y0,x1,y1}, sizeBytes, limitBytes (30720), contentHash, copiedAt?, pasted, changedSinceBuild? }] }], unmatchedAssets[] }`. Slab strings can be recompiled rather than stored.
- `pasteGuide`: `{ buildId, currentStep }` so the guide resumes at the right step.
- Build results also need `assetSource: "install"|"builtin"` and `substitutions[{ role, wanted, used, count }]` (§8.6.1).
- App-level (not per project): `assetLibrary { source, installPath?, gameBuild?, scannedAt, assetCount, packCount, communityPackCount, newSinceLastScan, themes[{ id, roles[{ role, assetId, missing? }] }] }`.
- `ui` (resume state): `{ tab, levelId, zoom, pan, roomKeyScroll, briefExpanded, composerDraft {text, references[]}, lastActivityAt }`.
- `pngExport`: last-used options `{ scope, version, style, pxPerSquare, grid, numbers, names }`.
- `thumbnail`: a small PNG of the last-viewed level for Home (or regenerated on demand).
- `spend`: per project; global totals are kept in app settings.
- `stamps[]` (*later*, §17): `{ id, name, description, slabString, sizeSq {w,h}, heightTiles, assetInventory[], silhouette (cells), entrances[{edge, offset, width}], placements[{levelId, x, y, rotation}] }`.

**Plan**
- `levels[]`: `id` (**stable across versions**), `name`, `elevationIndex` (0 = entry; negative = below; the build pastes bottom-up, 2.5 tiles per storey), `widthSq`, `heightSq`, `origin` (a shared grid origin so levels and their corner markers line up vertically).
- `rooms[]` per level (also used for outdoor `areas` and corridors):
  - `id` (**stable across versions**: essential for compare, references, keeping notes and detecting changed chunks),
  - `number` (unique within the project and continuous across levels; kept for the same room across versions; `null` for unnamed corridors),
  - `name`, `kind` (room, corridor, area, cave, yard, …), `shape` (rectangle or polygon in squares), `labelAnchor?`,
  - `notes: { readAloud?, gm, encounter? }`, `tags[]`.
- `walls[]`: explicit interior walls and any non-derivable walls, with `type` (wall, window).
- `openings[]`: grid-edge position, `width`, `type` (door, locked, secret, archway, portcullis, window), `connects: [roomId, roomId]`.
- `levelLinks[]`: `id`, `kind` (stairs, ladder, trapdoor, shaft), footprint, `direction`, `fromLevelId`, `toLevelId`, `pairedLinkId`.
- `terrain[]`: region + `type` (shallow water, deep water, grass, dense trees, undergrowth, rubble, chasm, road, cobbles, …).
- `features[]`: `id` (stable), `type` from a fixed enum (pillar, statue, table, bench, bed, chest, altar, sarcophagus, brazier, barrel, crate, bookshelf, rack, bones, tree, trap, …, or `other` + `label`), position, footprint, rotation (0/90/180/270), `roomId`, `gmOnly`.
- `validation[]` (computed by the app, not the AI): `{severity: "blocking"|"warning", message, refs[]}`.

**From the generation pipeline**: progress step events, token usage and duration per call, and an unambiguous success/failure per plan (partial plans are never applied), plus an estimate of a request's cost and time before it is sent.

**Provider abstraction** (needed for §5.8 / §8.4): each provider exposes `{ id, displayName, needsKey, hasServerUrl, modelSource: "catalog"|"fetched", hasCost, hasSpeedGuidance }`, and each model exposes `{ id, displayName, guidance?, costTier? (1–4), speedTier? (1–3), supportsEffort, effortLevels[], defaultEffort?, pricing? }`. A missing field means "not applicable", and the UI hides the corresponding element.

---

## 17. Later: importing a slab as a "stamp"

*Not in the MVP or v1.1; sketched here so the layout leaves room for it.*

A **stamp** is an existing TaleSpire build (a community creation, or something the GM built by hand) imported from its slab string. It's placed on the 2D map as a fixed block that the AI designs around and that is included in the export.

**Where "Import slab" lives**
- File ▸ **Import slab as stamp…** and a **+ Import slab** button at the top of a **Stamps** tab in the right-hand panel. The panel header becomes a two-tab switch, `Rooms | Stamps`, so the room key keeps its full height and stamps get their own list. In v1 the switch isn't rendered; the panel header leaves room for it.
- Pasting a slab string anywhere in the app (Ctrl+V with the map or panel focused) offers "Import this slab as a stamp?".

**Import dialog** (560px):
1. **Paste** the slab string into a monospace field. Wrapping ``` fences are fine. It's validated as you type: "Valid slab · 18.4 KB" or "That isn't a TaleSpire slab".
2. **What's in it**: the size in squares and tiles high, an asset inventory grouped by kind ("212 tiles · 46 props · 3 unknown community assets"), and a **top-down silhouette** drawn in the map's style: occupied cells in floor colour, tall pieces darker, walls in ink. Unknown assets are listed and drawn as "?" cells. They will still paste in TaleSpire if the GM has that pack installed.
3. **Describe it**: name, a one-line description for the AI ("A ruined chapel with a collapsed bell tower"), and optional GM notes.
4. **Entrances** (optional): click silhouette edges to mark doorways (they snap to grid edges and show as small triangles pointing inward). The AI connects corridors to these.
5. [Add to map] places it on the current level at the view centre. [Save to library only] keeps it for other projects (a later "Stamp library" on Home).

**On the map**
- Drawn as its silhouette with a distinct treatment, so it never reads as AI-planned space: a **double outline** (ink plus an inset 1px dashed line), cells filled with a fine cross-hatch over the floor colour, and a square **tag badge** in the top-left corner (square, not round like room numbers) with "S1" and its name.
- It's **directly manipulable**, unlike the rest of the plan: drag to move (snapping to squares), `[`/`]` or a rotate handle to turn it 90°, and Delete to remove it from the map. This is safe because it's an opaque block. Moving it creates a version ("You moved S1 Ruined Chapel").
- Entrances show as small inward triangles on the outline. When the AI connects to one, a door/opening glyph is drawn at that spot.
- Selecting it shows the selection bar: `S1 Ruined Chapel [Reference in chat] [Rotate] [⋯]`. References work like rooms (`S1` chip), so "put the graveyard around S1" works.
- Collisions with planned rooms show a red dashed overlap and a validation warning ("S1 overlaps ④ by 6 squares").

**In the right-hand panel**: the Stamps tab lists stamps in use on this level, each with the square badge, name, size, asset count, entrance count, notes, and the actions Reference, Rotate and Remove from map. Stamps also appear in the room key's **Exits** lines ("E door → S1").

**On export**: stamp contents are merged into the level's chunks at their placed position and rotation, so the paste guide doesn't change. If a stamp is close to 30 KB by itself, the build warns that it may force extra chunks.
