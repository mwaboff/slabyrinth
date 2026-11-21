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
