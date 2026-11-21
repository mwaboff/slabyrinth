/**
 * GENERATOR 4 IS OPEN (unreleased): this golden is EXPECTED to change, but only on purpose.
 *
 * Two kinds of golden live in test/golden/:
 * - Frozen goldens (generator2/, generator3/, resolve/, compile/, text/, gen/) pin released output. They are read,
 *   never written, and never updated: a failure there means a released map changed, and the fix is in the code.
 * - This open golden pins what generator 4 builds today, so a refactor can prove "no output change" on CI, and a
 *   deliberate change shows up as a reviewable diff instead of slipping through property tests.
 *
 * What it covers (runs.ts): every plan in test/fixtures/plans/ and test/unit/gen/fixtures/ at its own generator, and
 * every plan of a released generator forced to generator 4. Each run goes through the CLI's pipeline (resolve
 * against the compile palettes, compile, design review with and without the build) and is reduced to one line in
 * __golden__/generator4.txt: resolved hash, asset count, diagnostic counts, and short sha256 hashes of the slabs, the
 * diagnostics and both reviews.
 *
 * This test never writes. If it fails:
 * - You meant to change generator-4 output: run `npm run test:golden:gen4:update`. It prints the per-plan
 *   before/after diff and rewrites the golden; commit the golden with the change and say why in the message.
 * - You did not (a refactor): the diff is a bug in the refactor. Do not update the golden.
 * - A run at a released generator changed its build: that output is frozen; the update script refuses it. Put the
 *   change behind a switch of the open generator (src/plan/generator.ts).
 * - You added or removed a fixture plan: run the update script; it adds or drops the plan's lines.
 *
 * When generator 4 ships: freeze this golden. Copy it to the frozen pattern (generator4/ as a read-only golden like
 * generator3.test.ts, its open-generator runs pinned, no update script), and open a golden like this one for
 * generator 5 by setting OPEN_GENERATOR in runs.ts to 5.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_VERSIONS } from "../../../src/contracts/plan";
import { changesReleasedOutput, goldenLine, goldenRuns, lineDiff, OPEN_GENERATOR, readGolden } from "./runs";

const RUNS = goldenRuns();
const GOLDEN = readGolden();
const UPDATE = "npm run test:golden:gen4:update";

describe("generator 4 output matches the committed golden", () => {
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
  });

  // one test per run, so a failure names the plan and one slow build cannot time out the others
  it.each(RUNS.map((r) => [r.name, r] as const))("%s", (name, run) => {
    const now = goldenLine(run);
    const was = GOLDEN.get(name);
    if (now === was) return;
    const diff = lineDiff(was, now).join("; ");
    const advice =
      was !== undefined && changesReleasedOutput(was, now)
        ? `a released generator's build changed (${diff}). That output is frozen: put the change behind a switch ` +
          `of the open generator (src/plan/generator.ts). Do not update the golden.`
        : `generator-4 output changed (${diff}). If you meant it, run \`${UPDATE}\`, check the printed diff and ` +
          `commit the golden with the change. If this is a refactor, the change is a bug: do not update the golden.`;
    expect(now, advice).toBe(was);
  });
});
