/**
 * GENERATOR 5 IS RELEASED (0.4.0) AND FROZEN. A saved plan with `generator: 5` must resolve and build to exactly the
 * same bytes in every later version of the app. This was the open golden until generator 6 opened; its files
 * (__golden__/generator5.txt, generator5.detail.txt and generator5.quality.txt) are now read, never written, and have
 * no update script. They were written by the generator-5 update script and are left exactly as released in 0.4.0;
 * the quality baseline is kept as the 0.4.0 record and is not compared (it measures the build, which this test pins).
 *
 * It pins every run at generator 5 (38): the stored plans written for generator 5, and every older stored plan
 * forced to generator 5 (`<dir>/<plan>@5`). Each is built through the same pipeline the open golden uses
 * (../goldenRecord.ts) and must match the release in its build (resolved hash, asset count, diagnostic counts,
 * slabs, or the error: FROZEN_FIELDS) and in what it built (the detail lines: pieces, layers, parts, features and
 * diagnostic codes). The design review is advice, not the build, so the review fields and review detail lines are not
 * compared (review policy, src/plan/generator.ts). The runs at generators 1 to 4 in the file are pinned by the open
 * golden (generator6/) and the generator-2 to generator-4 goldens.
 *
 * The palettes generator 5 sees are pinned by test/fixtures/released-palettes-0.4.0.json
 * (test/unit/palette/released.test.ts); sp-1.14.0, dp-1.4.0 and tools-1.10.0 by test/unit/agent/tools.test.ts.
 *
 * If this test fails you changed what generator 5 produces. Do not update the golden. Put the change behind a switch
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

const GOLDEN = readGoldenFile(new URL("__golden__/generator5.txt", import.meta.url));
const DETAIL = readDetailFile(new URL("__golden__/generator5.detail.txt", import.meta.url));

/** The run a golden line names: `<dir>/<plan>` at the plan's own generator, `<dir>/<plan>@5` forced to 5. */
function runNamed(name: string): Run {
  const [path = "", at] = name.split("@");
  const [dir, stored] = path.split("/") as [string, StoredPlan];
  if ((dir === "gen") !== (GENERATOR_TEST_PLANS as readonly string[]).includes(stored))
    throw new Error(`${name}: no stored plan ${stored} in ${dir}/`);
  return { name, plan: at === undefined ? loadPlan(stored) : loadPlan(stored, { generator: 5 }) };
}

/** Detail lines that describe the build (the review's lines are advice and may move). */
const buildDetail = (lines: readonly string[] = []): string[] => lines.filter((l) => !/^\S+ review /.test(l));

const RUNS = [...GOLDEN].filter(([, line]) => lineGenerator(line) === 5).map(([name]) => runNamed(name));

describe("generator 5 is frozen: every run at generator 5 builds as released in 0.4.0", () => {
  it("the golden holds its 38 runs at generator 5", () => {
    expect(RUNS).toHaveLength(38);
    for (const run of RUNS) expect(run.plan.generator, run.name).toBe(5);
  });

  // one test per run, so a failure names the plan and one slow build cannot time out the others
  it.each(RUNS.map((r) => [r.name, r] as const))("%s", (name, run) => {
    const was = GOLDEN.get(name) ?? "";
    const { line: now, detail } = goldenRecord(run);
    expect(
      changesBuild(was, now),
      `generator 5's build changed (${lineDiff(was, now).join("; ")}). It is frozen: put the change behind a ` +
        `switch of the open generator (src/plan/generator.ts). Never update this golden.`,
    ).toBe(false);
    expect(buildDetail(detail), "what generator 5 built changed; it is frozen").toEqual(
      buildDetail(DETAIL.get(name)),
    );
  });
});
