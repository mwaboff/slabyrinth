# Changelog

All notable changes to Slabyrinth are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). The section for a tagged version becomes the GitHub
Release notes, which the app shows under "What's new" when it offers that update.

## [Unreleased]

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

[Unreleased]: https://github.com/mwaboff/slabyrinth/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/mwaboff/slabyrinth/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mwaboff/slabyrinth/releases/tag/v0.1.0
