# Contributing

Read `docs/decisions.md` first, then `docs/architecture.md`. Where they disagree, `decisions.md` wins.

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

**Contract changes go through the lead** and are recorded in `docs/decisions.md`. Edit `docs/contracts/` first, then update every copy in the same change.
Copies must match the originals byte for byte, apart from import paths. Do not reformat or lint-fix them (they are excluded from Prettier, and three documentation-style lint rules are off for them).

## Dependencies

There is one lockfile for all workspaces. Add a dependency with `npm install <pkg> -w <workspace> --save-exact` and say why in the pull request.

## Rules enforced by tooling

- `packages/core/src/**` must not import `electron`, `react` or Node built-ins, except in `src/cli/` (ESLint `no-restricted-imports`; core's tsconfig has no DOM or Node types).
- Directories of `packages/core/src` import only lower layers: the order is the `CORE_LAYERS` table in `eslint.config.js` (rule `slabyrinth/core-layers`); a new directory must be placed there. No core module is imported for its side effects.
- Renderer colours, fonts, radii and shadows come only from theme tokens in `apps/desktop/src/renderer/styles/tokens.css`.
- Before a pull request: `npm run lint && npm run typecheck && npm test && npm run build`.
