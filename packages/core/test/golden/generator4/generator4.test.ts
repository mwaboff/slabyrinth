/**
 * GENERATOR 4 IS RELEASED (0.3.0) AND FROZEN. A saved plan with `generator: 4` must resolve and build to exactly the
 * same bytes in every later version of the app. This was the open golden until generator 5 opened; its files
 * (__golden__/generator4.txt and generator4.detail.txt) are now read, never written, and have no update script. They
 * were written by the generator-4 update script at 0.3.0 and are left exactly as released.
 *
 * It pins every run at generator 4 (27): the stored plans written for generator 4, and every older stored plan
 * forced to generator 4 (`<dir>/<plan>@4`). Each is built through the same pipeline the open golden uses
 * (../goldenRecord.ts) and must match the release in its build (resolved hash, asset count, diagnostic counts,
 * slabs, or the error: FROZEN_FIELDS) and in what it built (the detail lines: pieces, layers, parts, features and
 * diagnostic codes). The design review is advice, not the build, so the review fields and review detail lines are not
 * compared (review policy, src/plan/generator.ts). The runs at generators 1 to 3 in the file are pinned by the open
 * golden (generator6/) and the generator-2 and generator-3 goldens.
 *
 * The palettes generator 4 sees are pinned by test/fixtures/released-palettes-0.3.0.json
 * (test/unit/palette/released.test.ts); sp-1.13.0, dp-1.3.0 and tools-1.9.0 by test/unit/agent/tools.test.ts.
 *
 * If this test fails you changed what generator 4 produces. Do not update the golden. Put the change behind a switch
 * of the open generator's profile (src/plan/generator.ts), off in the released profiles.
 */
import { describe, expect, it } from "vitest";
import { GENERATOR_TEST_PLANS, loadPlan, type StoredPlan } from "../../fixtures";
import {
  changesBuild,
  goldenRecord,
  lineDiff,
  lineGenerator,
  readDetailFile,
  readGoldenFile,
  type Run,
} from "../goldenRecord";

const GOLDEN = readGoldenFile(new URL("__golden__/generator4.txt", import.meta.url));
const DETAIL = readDetailFile(new URL("__golden__/generator4.detail.txt", import.meta.url));

/** The run a golden line names: `<dir>/<plan>` at the plan's own generator, `<dir>/<plan>@4` forced to 4. */
function runNamed(name: string): Run {
  const [path = "", at] = name.split("@");
  const [dir, stored] = path.split("/") as [string, StoredPlan];
  if ((dir === "gen") !== (GENERATOR_TEST_PLANS as readonly string[]).includes(stored))
    throw new Error(`${name}: no stored plan ${stored} in ${dir}/`);
  return { name, plan: at === undefined ? loadPlan(stored) : loadPlan(stored, { generator: 4 }) };
}

/** Detail lines that describe the build (the review's lines are advice and may move). */
const buildDetail = (lines: readonly string[] = []): string[] => lines.filter((l) => !/^\S+ review /.test(l));

const RUNS = [...GOLDEN].filter(([, line]) => lineGenerator(line) === 4).map(([name]) => runNamed(name));

describe("generator 4 is frozen: every run at generator 4 builds as released in 0.3.0", () => {
  it("the golden holds its 27 runs at generator 4", () => {
    expect(RUNS).toHaveLength(27);
    for (const run of RUNS) expect(run.plan.generator, run.name).toBe(4);
  });

  // one test per run, so a failure names the plan and one slow build cannot time out the others
  it.each(RUNS.map((r) => [r.name, r] as const))("%s", (name, run) => {
    const was = GOLDEN.get(name) ?? "";
    const { line: now, detail } = goldenRecord(run);
    expect(
      changesBuild(was, now),
      `generator 4's build changed (${lineDiff(was, now).join("; ")}). It is frozen: put the change behind a ` +
        `switch of the open generator (src/plan/generator.ts). Never update this golden.`,
    ).toBe(false);
    expect(buildDetail(detail), "what generator 4 built changed; it is frozen").toEqual(
      buildDetail(DETAIL.get(name)),
    );
  });
});
