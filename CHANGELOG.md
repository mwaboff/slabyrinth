# Changelog

All notable changes to Slabyrinth are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The section for a tagged version becomes the GitHub
Release notes, which the app shows under "What's new" when it offers that update.

## [Unreleased]

## [0.1.2] - 2026-11-20

### Added

- **Buildings.** The AI can now put real buildings on a map: cottages, keeps, town houses, shops, warehouses, city blocks and a wizard's tower, with doors, windows, a roof and one or more storeys. Buildings next to each other come out different, and any building can be asked for as weathered or ruined. The roof builds as its own layer, so you can also paste a see-inside version without it.
- **Yards:** fenced gardens, farmyards and graveyards with a gate.
- **Height and depth.** Raised daises, sunken pits, terraces, hills with bold rock cliffs, chasms and ravines cut into the floor, and bridges across them. Natural cliffs are faced with real rock instead of square blocks.
- **Water and paths.** Rivers and brooks that cross the map, trails that wind, and streets with pavements, kerbs and crossings. The build tells you what water level to set in TaleSpire after pasting.
- **Richer dressing.** Many more props for caves, dungeons, forests and towns; set pieces by name, such as a ritual circle, a campsite, a ruined shrine or mine works; trees and rocks that cluster like real growth; and floors that mix several tiles.
- **New themes:** Forest, and a modern City built from the game's Cyberpunk and Sci-fi pieces.
- **The AI reviews its own maps.** It follows written design principles and, after every change, reads a short review of the map: flat ground, ruler-straight natural edges, lookalike buildings, paths that lead nowhere, and parts of your request the map does not show yet. It fixes what matters and tells you what it could not do.
- Pieces added by TaleSpire updates are used automatically, and asking for something the app has no name for finds the closest piece in your game.

### Changed

- Maps you made with 0.1.1 keep their layout. The new terrain, buildings and dressing are for new maps.
- The 2D map shows heights, cliffs, bridges, roof outlines and the water level.
- Release notes in the update notice are formatted (headings, lists, bold) instead of shown as raw text.
- The app includes the licence notices for its fonts and libraries (Settings ▸ About ▸ Third-party notices).

### Fixed

- The model list no longer fills up with rows that all read "Opus", "Sonnet" or "Fable". Other models show their full name behind a "Show other models" toggle.
- The AI's "look at the map image" step always timed out. It works again.
- Lava was built as ordinary cave floor, low walls and railings were left out, caves at the edge of the map had gaps in their walls, and a watchtower on posts was reported as sealed off.
- Fewer wasted AI turns: the AI is told when part of its plan changed nothing, and it checks every item of your request before saying it is done.

### Known limits

- Natural maps now have a ragged outline by default. Ask for a rectangular board (`outline: "rect"`) to turn it off.
- A "twisted" tower is built from stepped, offset blocks, not truly rotated ones, and "weathered" buildings are subtle.
- Rock ramps have not been tested yet for moving minis up and down.
- Maps saved by 0.1.2 may not open in 0.1.1.

## [0.1.1] - 2026-11-18

### Changed

- The settings icon is now a gear, so it no longer looks like the theme toggle's sun.
- The app now uses the same logo as the website, and the icon is sharper at small sizes.

### Fixed

- On Linux, the app window and taskbar now show the Slabyrinth icon instead of a generic one.
- On Windows, the running app now groups with its pinned taskbar or Start menu shortcut. If you pinned Slabyrinth while using 0.1.0, you may need to unpin it and pin it again.

## [0.1.0] - 2026-11-18

The first release.

### Added

- Describe a dungeon, crypt or tower by chatting with Claude, using your own Anthropic API key. Slabyrinth
  asks a few questions, keeps a design brief, and draws a first plan.
- Review the plan as a 2D map with a numbered room key, on one or several stacked levels. Edit it by
  chatting ("make room 3 bigger") or directly on the map; every change is a version you can undo,
  compare or restore.
- Approve a version and build it: Slabyrinth compiles the plan into TaleSpire slabs and guides you
  through pasting them, with "Copy & open TaleSpire".
- Export the map as a PNG (with or without the room key) and the room key as Markdown.
- Uses the asset catalog of your own TaleSpire install, or a small built-in set of pieces when TaleSpire
  isn't installed.
- Choose the Claude model and effort per conversation, with a cost estimate before you send and spend
  warnings you can set.
- Your API key is encrypted with your system's keychain and only ever sent to api.anthropic.com. Maps are
  plain files in your Documents folder and never contain the key.
- Dark and light themes, keyboard shortcuts, autosave with crash-safe writes.
- An "Update available" notice: at most once a day the app asks GitHub, anonymously, whether a newer
  version exists, and links to its release page. You can turn the check off in Settings ▸ About.
- Windows installer and portable build, Linux AppImage. The builds are not code-signed yet.

[Unreleased]: https://github.com/mwaboff/slabyrinth/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/mwaboff/slabyrinth/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/mwaboff/slabyrinth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mwaboff/slabyrinth/releases/tag/v0.1.0
