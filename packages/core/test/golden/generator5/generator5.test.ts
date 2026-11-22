/**
 * GENERATOR 5 IS OPEN (opened after 0.3.0). This golden follows it, as test/golden/generator4 followed generator 4
 * until 0.3.0.
 *
 * Two kinds of golden live in test/golden/:
 * - Frozen goldens (generator2/, generator3/, generator4/, resolve/, compile/, text/, gen/) pin released output. They
 *   are read, never written, and never updated: a failure there means a released map changed, and the fix is in the
 *   code.
 * - This open golden pins what generator 5 builds today, so a refactor can prove "no output change" on CI, and a
 *   deliberate change shows up as a reviewable diff instead of slipping through property tests.
 *
 * What it covers (runs.ts): every plan in test/fixtures/plans/ and test/unit/gen/fixtures/ at its own generator, and
 * every plan of a released generator forced to generator 5. Each run goes through the CLI's pipeline (resolve
 * against the compile palettes, compile, design review with and without the build: ../goldenRecord.ts) and is reduced
 * to one line in __golden__/generator5.txt: resolved hash, asset count, diagnostic counts, and short sha256 hashes of
 * the slabs, the diagnostics and both reviews. Beside it, __golden__/generator5.detail.txt says what each run built,
 * one fact per line (pieces per level by role, layer and structure part; features by type; diagnostic and review codes
 * with counts: see goldenRecord.ts runDetail), so a diff of it reads "the apothecary's chimney went" rather than "the
 * slab hash changed". Runs at a released generator (RELEASED_GENERATOR in runs.ts) have frozen builds: only their
 * review fields and review detail lines may move (review policy, src/plan/generator.ts).
 *
 * This test never writes. If it fails:
 * - You meant to change generator-5 output: run `npm run test:golden:gen5:update`. It prints the per-plan
 *   before/after diff (hash fields and detail lines) and rewrites both files; commit them with the change and give
 *   one line of reason per changed plan in the message.
 * - You did not (a refactor): the diff is a bug in the refactor. Do not update the golden.
 * - A run at a released generator changed its build: that output is frozen; the update script refuses it. Put the
 *   change behind a switch of the open generator (src/plan/generator.ts).
 * - You added or removed a fixture plan: run the update script; it adds or drops the plan's lines.
 *
 * When generator 5 is released: set RELEASED_GENERATOR in runs.ts to 5 (every run is then frozen). When generator 6
 * opens: freeze this golden the way generator4/ was frozen (a read-only test of its runs at generator 5, no update
 * script), and open one like this for generator 6 (generator6/, OPEN_GENERATOR 6).
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSIONS } from "../../../src/contracts/plan";
import { detailDiff, goldenRecord, lineDiff } from "../goldenRecord";
import { changesReleasedOutput, goldenRuns, OPEN_GENERATOR, readDetail, readGolden } from "./runs";

const RUNS = goldenRuns();
const GOLDEN = readGolden();
const DETAIL = readDetail();
/** Detail lines shown in a failure message (the update script prints them all). */
const SHOWN = 30;
const UPDATE = "npm run test:golden:gen5:update";

describe("generator 5 output matches the committed golden", () => {
  it("the golden follows the newest generator", () => {
    expect(OPEN_GENERATOR, "a new generator opened: freeze this golden (header of this file)").toBe(
      Math.max(...GENERATOR_VERSIONS),
    );
  });

  it("the golden lists exactly the runs, in order", () => {
    expect(
      [...GOLDEN.keys()],
      `the fixture plans changed: run \`${UPDATE}\` to add or drop their lines, and commit the golden`,
    ).toEqual(RUNS.map((r) => r.name));
    expect([...DETAIL.keys()], `the detail file is out of step: run \`${UPDATE}\``).toEqual(
      RUNS.map((r) => r.name),
    );
  });

  // one test per run, so a failure names the plan and one slow build cannot time out the others
  it.each(RUNS.map((r) => [r.name, r] as const))("%s", (name, run) => {
    const { line: now, detail } = goldenRecord(run);
    const was = GOLDEN.get(name);
    const moved = detailDiff(DETAIL.get(name), detail);
    if (now === was && moved.length === 0) return;
    const shown = moved.slice(0, SHOWN).join("\n  ");
    const more = moved.length > SHOWN ? `\n  ... ${String(moved.length - SHOWN)} more` : "";
    const diff = `${lineDiff(was, now).join("; ")}${moved.length ? `\n  ${shown}${more}\n` : ""}`;
    const advice =
      was !== undefined && changesReleasedOutput(was, now)
        ? `a released generator's build changed (${diff}). That output is frozen: put the change behind a switch ` +
          `of the open generator (src/plan/generator.ts). Do not update the golden.`
        : `generator-5 output changed (${diff}). If you meant it, run \`${UPDATE}\`, check the printed diff and ` +
          `commit the golden with the change. If this is a refactor, the change is a bug: do not update the golden.`;
    expect([now, ...detail], advice).toEqual([was, ...(DETAIL.get(name) ?? [])]);
  });
});
