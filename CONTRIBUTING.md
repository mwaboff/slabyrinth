# Contributing

Read `docs/decisions.md` first, then `docs/architecture.md`. Where they disagree, `decisions.md` wins. `CLAUDE.md`
holds the working rules for everyone, people and coding agents alike: the checks to run, what is frozen, what never to
do, and the checklist for adding a new kind of thing.

## Package layout

| Path                                     | What it is                                                                                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`                          | Pure TypeScript: contracts, plan model and ops, history, resolver and generators, text views, display list, palettes, compiler, slab codec, catalog readers, agent tools and prompt, CLI (`src/cli`, the only place with `node:*`) |
| `packages/render-canvas`                 | `drawDisplayList` (Canvas 2D), shared by the map view and PNG export                                                                                                                                                               |
| `apps/desktop/src/main`                  | Electron main: services, IPC, compile worker, the conversation engine and providers (`agent/`)                                                                                                                                     |
| `apps/desktop/src/preload`, `src/shared` | The `window.slabyrinth` bridge and the IPC/project contract copies                                                                                                                                                                 |
| `apps/desktop/src/renderer`              | React UI                                                                                                                                                                                                                           |
| `packages/scene3d`                       | Pure TypeScript: the 3D scene of a build or slab, the game-mesh readers (over bytes), the mesh-source port and cache format, the software renderer and PNG, shot rules                                                             |
| `packages/render-cli`                    | The developer render command (Node): reads the TaleSpire install read-only, caches meshes in `.cache/meshes/`                                                                                                                      |

Each package's public API goes through its folder's `index.ts`; `packages/core/src/index.ts` re-exports it.
Shared test fixtures live in `packages/core/test/fixtures/`.

## Contracts

`docs/contracts/*.ts` are the normative types. The copies are:

- `packages/core/src/contracts/{plan,ops,resolved,compiler}.ts`
- `packages/core/src/agent/toolContract.ts` (copy of `tools.ts`: the tool interface; the model-facing tool definitions are versioned code in `agent/tools.ts`)
- `apps/desktop/src/shared/{ipc,project}.ts`
- `apps/desktop/src/main/agent/provider/types.ts` (copy of `provider.ts`)

**Contract changes go through the project owner** and are recorded in `docs/decisions.md`. Edit `docs/contracts/` first, then update every copy in the same change.
Copies must match the originals byte for byte, apart from import paths. Do not reformat or lint-fix them (they are excluded from Prettier, and three documentation-style lint rules are off for them).

## Dependencies

There is one lockfile for all workspaces. Add a dependency with `npm install <pkg> -w <workspace> --save-exact` and say why in the pull request.

## Style

Renderer colours, fonts, radii and shadows come only from theme tokens in `apps/desktop/src/renderer/styles/tokens.css`.
Everything else the tooling enforces is in `eslint.config.js` (each guard's message says what to do instead) and the
tests; run the checks listed in `CLAUDE.md` before a pull request.

## Rendering a map in 3D

A developer tool for looking at generations without pasting them into TaleSpire (`npm run render -- 3d --help`):

- `npm run render -- 3d --fixture market-street-v3` (also `--fixture a,b` or `all`), `--plan my.json`, `--slab s.txt`
- `--seeds 1..4 --generator 5` re-seed and re-build; `--shots all` (overview, interiors, fronts, levels by the shot rules, and top) with `--max-shots n` and `--sheet`; `--camera 225,35`;
  `--eye x,y,z --target x,y,z`; `--boxes` draws boxes only (no install needed).
- Pictures and `index.json` (what each shows, which pieces are boxes and why) go to `docs/internal/renders/` unless
  `--out`. Meshes are read from the TaleSpire install read-only and cached in `.cache/meshes/` (the first run after a
  game update takes about a minute per 40 bundles). Both folders are git-ignored: nothing from the game is committed.

To measure a visual report before judging it by eye, add `--check`: the scene checks (clashes, gaps, facing, support,
surfaces, ways) put their findings in `index.json`, print a table per render (a summary for a batch) and draw a marked
`finding-<n>.png` per cluster (`--check-pictures n` caps them). `--fixture all --jobs N` renders a batch in N worker
threads with the same output as one thread. `--compare generator:<n>`, `seed:<n>` or `<plan.json>` also builds each plan
that way and writes `compare-<shot>.png` (before | after, same cameras) plus, with `--check`, the findings that are new,
fixed and unchanged. Every option is checked before TaleSpire is looked for or anything is built.

`npm run render -- rests` measures where things set on each piece of the bundled palettes' `feature.*` and `stall.*`
roles rest (its real top surface, not its collider's top) and rewrites core's generated `palette/restHeights.ts`:
numbers by asset id only. The palette import runs it when TaleSpire is installed; a test names any palette piece still
to measure.
