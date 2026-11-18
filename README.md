# Slabyrinth

Slabyrinth is a desktop app for TaleSpire game masters.
You describe a map by chatting with Claude, and the app turns the conversation into a map plan.
You review and edit the plan as a 2D map with a room key.
When it looks right, Slabyrinth compiles it into TaleSpire slabs that you paste into the game.
It runs on Windows and Linux (Electron, React, TypeScript).

Slabyrinth is an unofficial fan-made tool. It is not affiliated with, endorsed by or sponsored by
Bouncyrock Entertainment (makers of TaleSpire) or Anthropic (makers of Claude). TaleSpire and Claude
are trademarks of their respective owners. Slabyrinth does not include or redistribute TaleSpire's models,
textures or asset catalog: its built-in palettes list only the ids, names and sizes of the pieces they
use, and the full asset library is read from your own TaleSpire install.

## Prerequisites

- Node.js 26 (see `.nvmrc`) and npm 11
- Git
- To test exports in the game: TaleSpire (optional)

## Commands

```sh
npm ci                # install (one lockfile for all workspaces)
npm run dev           # start the app with hot reload
npm run typecheck     # tsc -b across all projects
npm run lint          # ESLint
npm run format        # Prettier
npm test              # Vitest, all workspaces
npm run build         # compile packages and bundle the app
npm run package       # unpacked app in apps/desktop/release/
npm run dist          # installers for the current OS
npm run test:e2e      # Playwright e2e: builds the test bundle (apps/desktop/out-test) and runs it hidden
npm run smoke:packaged -w @slabyrinth/desktop   # run the unpacked packaged app once (SMOKE_OK)
```

## Installing the unsigned builds

Slabyrinth releases are not code-signed (v1), so your operating system warns you the first time.

**Windows** (installer `Slabyrinth-Setup-x.y.z.exe` or portable `Slabyrinth-x.y.z-portable.exe`).
SmartScreen shows "Windows protected your PC" with an unknown publisher. Click **More info**, check
that the file name matches the release you downloaded from this repository's Releases page, then
click **Run anyway**. The warning goes away once a build has enough downloads to earn reputation,
or once the project uses a code-signing certificate.

**Linux** (`Slabyrinth-x.y.z-x86_64.AppImage`):

```sh
chmod +x Slabyrinth-*.AppImage
./Slabyrinth-*.AppImage
```

AppImages need FUSE 2: `libfuse2` on Ubuntu 22.04, `libfuse2t64` on Ubuntu 24.04 and later
(`sudo apt install libfuse2t64`). Without FUSE, run `./Slabyrinth-*.AppImage --appimage-extract-and-run`.

## Where Slabyrinth keeps your data

- **Maps**: one `.slabyrinth` file per map in `Documents/Slabyrinth` (changeable in Settings). Plain
  JSON, autosaved with crash-safe writes (temp file + rename); the previous good copy is kept as
  `<map>.slabyrinth.bak`. Map files never contain your API key.
- **App data** (Electron `userData`: `%APPDATA%\Slabyrinth` on Windows, `~/.config/Slabyrinth` on
  Linux): `settings.json`, `secret.bin` (your API key, encrypted with the OS keychain through Electron
  `safeStorage`), `catalog/` (the asset library read from your TaleSpire install), `palettes/` (your
  palettes and overrides), `orientation.json` (optional orientation override), `logs/` (5 × 1 MB;
  never contains keys or prompts). Help ▸ Open data folder opens it.
- **Palettes**: the curated palettes and orientation data are built into the app. To change one, put a
  JSON file in `<userData>/palettes/` (Help ▸ Open data folder): a file with `"overrides": true`
  and the id of a built-in palette replaces those roles (`null` deletes one); any other palette file adds a
  new theme. `<userData>/orientation.json` replaces the built-in orientation calibration. Invalid files are
  ignored and listed with their issues.
- **TaleSpire** is only ever read (its asset index files). "Copy & open TaleSpire" copies the slab,
  then starts the game through Steam (`steam://rungameid/720620`) or brings the running game forward.

## Development notes

- **Conversation engine.** Every build runs the real engine (`apps/desktop/src/main/agent`) with the
  Anthropic provider, keyed from the API key stored in Settings (development builds also accept
  `ANTHROPIC_API_KEY` from the environment; smoke and e2e runs never do). Without a key, chat answers
  the typed `no_api_key` error and the UI asks for one. Wiring: `src/main/engineWiring.ts`.
- **Fake engine (dev/test only).** `SLABYRINTH_FAKE_ENGINE=1` in a development or test run, or the
  `fakeEngine` flag under `"x-featureFlags"` in `settings.json` of a development run, swaps in the
  fake engine that replays recorded streams (`src/main/engine/recordings.ts`; send `#ask` or `#fail`
  to see question cards and errors). Packaged builds ignore both.
- **Smoke and e2e.** `SLABYRINTH_SMOKE=1` boots hidden, runs self-checks (including "chat answers
  `no_api_key`" and "packaged build uses the real engine and compiler"), prints `SMOKE_OK` and exits.
  `SLABYRINTH_E2E=1` is the Playwright mode. Both use a throwaway `userData` folder (or
  `SLABYRINTH_USER_DATA`) and inert doubles for every outside effect: no dialogs, a memory clipboard,
  no TaleSpire lookup, launch or focus. `e2e/conversation.spec.ts` drives the real engine through the
  real IPC with a scripted provider (`SLABYRINTH_E2E_PROVIDER_SCRIPT`, test runs only): no network,
  no API cost. It only exists in test builds (`npm run build:test -w @slabyrinth/desktop`, output in
  `apps/desktop/out-test`); production bundles (`out/`, packaged) contain no test code, and the packaged
  smoke run checks that.
- The full asset catalog (`data/talespire-assets.json`) is research data generated locally; it is
  gitignored and never bundled. Only the curated palettes in `packages/core/data` ship with the app.

## Licence

MIT, see [`LICENSE`](LICENSE). Third-party test data and its licence are listed in
[`data/THIRD-PARTY.md`](data/THIRD-PARTY.md).
