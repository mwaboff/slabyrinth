# Slabyrinth

A desktop app (Electron + React) where a GM designs a TaleSpire map by chatting with Claude. The model writes a map
plan (JSON IR); core resolves it into a grid, compiles it into TaleSpire slab strings, and reviews the design.
Read `docs/decisions.md` (wins on conflict) and `docs/architecture.md` before changing behaviour.

Pipeline: plan → `resolve` (plan + palettes → resolved grid) → `compile` (realize → verify → chunk → encode) → slab;
`review` reads the build and advises the model.

- `packages/core/src`: pure TypeScript (Node only in `cli/`); directory layers in `eslint.config.js` `CORE_LAYERS`.
- `packages/render-canvas`: the 2D map painter. `apps/desktop/src`: `main`, `renderer`, `preload`, `shared`.
- Stage lists, each a plain ordered list: `resolve/level.ts`, `compile/realize.ts`, `compile/verify/verify.ts`,
  `compile/realize/structures.ts` (`layBuilding`), `review/review.ts` (`reviewDesign`).
- `docs/contracts/*.ts` are normative; core and the app hold byte copies (`CONTRIBUTING.md`). Contract and IPC
  changes go through the project owner.

## Checks

- Every change: `npm run format:check && npm run lint && npm run typecheck && npm test` (~20 s of tests).
- Generation or build change: `npm run test:golden:gen4:update` prints what moved per plan (hash fields, then the
  `generator4.detail.txt` lines); `npm run test:sweep -- 30` builds every stored plan under many seeds (CI runs 120).
- App, IPC or CI change: `npm run test:e2e`. Before a PR also `npm run build`.
- Windows Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"` first.

The lints and tests are the rules; their messages say what to do. If one blocks a reasonable design, change the guard
in the same PR and say why.

## Frozen output

- Generators 1–4 and the released prompt, principles and tool texts (`agent/*.frozen*.ts`, the versions marked
  released in `agent/prompt.ts`) are byte-frozen; their builds are never regenerated (the generator-4 golden may
  still move its review fields). No generator is open: the next behaviour or model-text change first opens
  generator 5 and new text versions. (When generator 5 is released, this line moves on to generator 6.)
- A behaviour difference between generators is a new switch in `plan/generator.ts` `SWITCHES`, read where it differs.
- A generator-4 golden change is deliberate: commit it with one line of reason per changed plan.

## Never

- Hand-edit the generated palettes (`packages/core/data/palettes/*.json`, `palette/bundled.ts`) or run
  `packages/core/scripts/import-palette-draft.ts`: that script is the owner's to run.
- Launch the app any way but `npm run test:e2e`, or let a test touch the real user data dir, the game install, the
  real clipboard or the network.
- Commit `docs/internal/`, or copy community slab designs into the repo.

## Habits no check holds

- Ask the thing itself, not its neighbour: a cell's theme from `themeAt`/`cellTheme`, not the level's; a piece's size
  from the palette it is built with; a resolved element's theme from `elementTheme`; "may this plan go on" from
  `plan/gate.ts`.
- Before writing a walk, list or lookup, find the shared one: `resolve/levelGrid.ts` (cells, edges, themes),
  `resolve/wallFaces.ts`, `palette/planRoles.ts`, `palette/roles.ts`, `palette/filters.ts`, `util/hash.ts`, and the
  trait tables (`gen/catalog.ts`, `gen/openingKinds.ts`, `gen/wallStyles.ts`, `resolve/materials.ts`,
  `resolve/roofTypes.ts`, `plan/links.ts`, `gen/roomPurpose.ts`).
- Fix a visual report by measuring the build first (a test or the detail golden), not by eye.
- One writer in the working tree at a time; commit each passing unit on a branch.
- Report what you verified separately from what you assumed.

## Adding a new kind of thing

`[c]` the compiler or a test tells you; `[you]` nothing will.

1. The word in its contract list (`contracts/plan.ts`; generator-only words in `plan/generator.ts`). [c]
2. Its row in the trait table and any look table typed over the list (render-canvas, ASCII). [c]
3. Palette roles with fallbacks: ask the owner (palette data is generated). [you]
4. The resolve stage, behind a new switch. [you; lint: no generator numbers]
5. The realize pass. [you; realize-verify agreement test]
6. A verify check and its code (contract, `VERIFY_CODES`). [c]
7. The review heuristic, its note code and its weight in `review/thresholds.ts`. [c]
8. The model text, in the working tool and prompt versions only. [you; hash pins catch an edit of a released one]
9. A fixture plan in `test/fixtures` (it joins the generator-4 golden and the sweep). [c: the lists match the files]
10. A behaviour test that fails without the change. [you]
11. A proof slab for the owner to look at in TaleSpire. [you]
