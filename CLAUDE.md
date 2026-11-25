# Slabyrinth

A desktop app (Electron + React) where a GM designs a TaleSpire map by chatting with Claude. The model writes a map
plan (JSON IR); core resolves it into a grid, compiles it into TaleSpire slab strings, and reviews the design.
Read `docs/decisions.md` (wins on conflict) and `docs/architecture.md` before changing behaviour.

Pipeline: plan → `resolve` (plan + palettes → resolved grid) → `compile` (realize → verify → chunk → encode) → slab;
`review` reads the build and advises the model.

- `packages/core/src`: pure TypeScript (Node only in `cli/`); directory layers in `eslint.config.js` `CORE_LAYERS`.
- `packages/render-canvas`: the 2D map painter. `apps/desktop/src`: `main`, `renderer`, `preload`, `shared`.
- Stage lists, each a plain ordered list: `resolve/level.ts`, `compile/realize.ts`, `compile/verify/verify.ts`,
  `compile/realize/structures.ts` (`layBuilding`), `review/review.ts` (`reviewDesign`), `resolve/recipes/table.ts`
  (`RECIPES`), `resolve/recipes/treatments.ts` (`TREATMENTS`).
- `docs/contracts/*.ts` are normative; core and the app hold byte copies (`CONTRIBUTING.md`). Contract and IPC
  changes go through the project owner.

## Checks

- Every change: `npm run format:check && npm run lint && npm run typecheck && npm test` (~20 s of tests).
- Generation or build change: `npm run test:golden:gen5:update` prints what moved per plan (hash fields, then the
  `generator5.detail.txt` lines); `npm run test:sweep -- 30` builds every stored plan under many seeds (CI runs 120).
- Look at a build in 3D: `npm run render -- 3d --fixture <name>` (or `--plan`, `--slab`); PNGs + `index.json` under
  `docs/internal/renders/` (CONTRIBUTING.md "Rendering a map in 3D").
- App, IPC or CI change: `npm run test:e2e`. Before a PR also `npm run build`.
- Windows Git Bash: `export PATH="/c/Program Files/nodejs:$PATH"` first.

The lints and tests are the rules; their messages say what to do. If one blocks a reasonable design, change the guard
in the same PR and say why.

## Frozen output

- Generators 1–4 and the released prompt, principles and tool texts (`agent/*.frozen*.ts`, the versions marked
  released in `agent/prompt.ts`) are byte-frozen; their goldens are never regenerated. Generator 5 and the working
  text versions (sp-1.14.0, dp-1.4.0, tools-1.10.0) are open. (When generator 5 is released, this line moves on to
  generator 6.)
- A behaviour difference between generators is a new switch in `plan/generator.ts` `SWITCHES`, read where it differs.
- A generator-5 golden change is deliberate: commit it with one line of reason per changed plan.

## Never

- Hand-edit the generated palettes (`packages/core/data/palettes/*.json`, `palette/bundled.ts`): change the script's
  inputs (`scripts/palette-*.json`, the mapping table) and run `packages/core/scripts/import-palette-draft.ts` (the
  owner allowed palette updates on 2026-11-23); new roles carry a `minGenerator`, and the diff holds only what moved.
- Launch the app any way but `npm run test:e2e`, or let a test touch the real user data dir, the game install, the
  real clipboard or the network.
- Commit `docs/internal/`, or copy community slab designs into the repo.
- Link a worktree's `node_modules` to another checkout, or remove a worktree with `git worktree remove` / `rm -rf`
  (git follows the links and deletes the other checkout's files; a worktree runs its own `npm ci`).

## Habits no check holds

- Ask the thing itself, not its neighbour: a cell's theme from `themeAt`/`cellTheme`, not the level's; a piece's size
  from the palette it is built with; a resolved element's theme from `elementTheme`; "may this plan go on" from
  `plan/gate.ts`; a place's light, condition and wealth from `characterAt` / `elementCharacter`, never its words.
- Before writing a walk, list or lookup, find the shared one: `resolve/levelGrid.ts` (cells, edges, themes),
  `resolve/wallFaces.ts`, `resolve/anchors/` (zones, faces, frames), `resolve/recipes/keepClear.ts`,
  `resolve/recipes/footing.ts`, `palette/planRoles.ts`, `palette/roles.ts`, `palette/filters.ts`, `palette/traits.ts`,
  `palette/traitPools.ts`, `objects/lexicon.ts` (stand-ins), `util/hash.ts`, `util/turn.ts`, `util/visibleCover.ts`,
  `util/sunk.ts`, and the trait tables (`gen/catalog.ts`, `gen/openingKinds.ts`, `gen/wallStyles.ts`,
  `resolve/materials.ts`, `resolve/roofTypes.ts`, `plan/links.ts`, `gen/roomPurpose.ts`, `gen/roomTraits.ts`,
  `gen/pieceFacts.ts`, `resolve/roofKits.ts`, `resolve/themes.ts`, `gen/buildingProgramme.ts`,
  `gen/buildingCondition.ts`, `resolve/wealthLooks.ts`).
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
