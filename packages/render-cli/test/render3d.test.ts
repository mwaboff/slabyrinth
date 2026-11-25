/**
 * The render command end to end, in temporary folders, never touching the install or the app's data: boxes only
 * (--boxes, or an --install folder that holds no game), each kind of input, and the run's index.json.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { degreesToRot, encode, toScaled } from "@slabyrinth/core";
import { afterAll, describe, expect, it } from "vitest";
import { USAGE, runRender } from "../src/index";
import { FIXTURE_DIRS } from "../src/inputs";

const tmp = mkdtempSync(join(tmpdir(), "render3d-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runRender(
    argv,
    { out: (s) => out.push(s), err: (s) => err.push(s) },
    { cwd: tmp, appData: null },
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

interface IndexJson {
  meshSource: string;
  note: string;
  renders: Array<{
    input: string;
    folder: string;
    instances: number;
    boxes: number;
    plan?: { seed: number; generator: number };
    fallbacks: Array<{ reason: string; count: number }>;
    shots: Array<{ id: string; file: string; rule: string; instancesDrawn: number }>;
  }>;
}
const readIndex = (dir: string): IndexJson =>
  JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as IndexJson;

describe("render 3d", () => {
  it("prints its usage and exits 2 without a command or an input", async () => {
    expect((await run([])).code).toBe(2);
    const r = await run(["3d"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(USAGE.split("\n")[0]);
  });

  it("draws a fixture as boxes and writes what each picture shows", async () => {
    const out = join(tmp, "boxes");
    const r = await run([
      "3d",
      "--fixture",
      "multi-level-stairs",
      "--boxes",
      "--size",
      "160x120",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const index = readIndex(out);
    expect(index.note).toContain("box of its real size");
    const render = index.renders[0];
    expect(render?.boxes).toBe(render?.instances);
    expect(render?.fallbacks.every((f) => f.reason === "boxes-requested")).toBe(true);
    expect(render?.shots.map((s) => s.id)).toEqual([
      "overview",
      "level-ground",
      "level-study-lvl",
      "level-roof",
    ]);
    for (const s of render?.shots ?? []) expect(existsSync(join(out, s.file))).toBe(true);
  });

  it("says in plain words when TaleSpire is not there, and still draws", async () => {
    const out = join(tmp, "noinstall");
    const r = await run([
      "3d",
      "--fixture",
      "single-room",
      "--install",
      tmp,
      "--size",
      "64x48",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain("TaleSpire isn't installed on this PC");
    expect(readIndex(out).renders[0]?.fallbacks.every((f) => f.reason === "no-install")).toBe(true);
  });

  it("reads a plan file, re-seeds it per --seeds and builds it at another generator", async () => {
    const plan = readFileSync(join(FIXTURE_DIRS[0] ?? "", "two-rooms-door.json"), "utf8");
    writeFileSync(
      join(tmp, "mine.json"),
      JSON.stringify({ format: "slabyrinth/plan-export@1", plan: JSON.parse(plan) as unknown }),
    );
    const out = join(tmp, "planfile");
    const r = await run([
      "3d",
      "--plan",
      "mine.json",
      "--seeds",
      "1..2",
      "--generator",
      "4",
      "--boxes",
      "--shots",
      "top",
      "--size",
      "64x48",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const index = readIndex(out);
    expect(index.renders.map((x) => [x.input, x.plan?.seed, x.plan?.generator, x.folder])).toEqual([
      ["mine", 1, 4, "mine/s1"],
      ["mine", 2, 4, "mine/s2"],
    ]);
  });

  it("reads a slab file, one chunk per line, and adds explicit cameras", async () => {
    const floor = "4c4e9e0b-8b6c-4e1f-9b7b-6a5b9e3e2f11";
    const slab = encode(
      [0, 1, 2].map((i) => ({ uuid: floor, sx: toScaled(i), sy: 0, sz: 0, rot: degreesToRot(i * 90) })),
    ).slab;
    writeFileSync(join(tmp, "s.txt"), "```\n" + slab + "\n```\n");
    const out = join(tmp, "slab");
    const r = await run([
      "3d",
      "--slab",
      "s.txt",
      "--boxes",
      "--shots",
      "overview",
      "--camera",
      "0,30;90,30",
      "--eye",
      "1,5,-6",
      "--target",
      "1,0,0",
      "--size",
      "64x48",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const render = readIndex(out).renders[0];
    expect(render?.instances).toBe(3);
    // an unknown piece still stands as a small box, reported
    expect(render?.fallbacks).toEqual([expect.objectContaining({ reason: "no-geometry", count: 3 })]);
    expect(render?.shots.map((s) => s.id)).toEqual(["overview", "camera-1", "camera-2", "eye"]);
  });

  it("batches fixtures with the shot rules under a budget, with contact sheets", async () => {
    const out = join(tmp, "batch");
    const r = await run([
      "3d",
      "--fixture",
      "two-rooms-door,single-room",
      "--shots",
      "all",
      "--max-shots",
      "2",
      "--sheet",
      "--boxes",
      "--size",
      "96x72",
      "--out",
      out,
    ]);
    expect(r.code).toBe(0);
    const index = readIndex(out);
    expect(index.renders.map((x) => x.input)).toEqual(["two-rooms-door", "single-room"]);
    // two ranked shots, then the top view
    for (const x of index.renders) expect(x.shots.map((s) => s.rule).slice(0, 1)).toEqual(["overview"]);
    expect(existsSync(join(out, "run-sheet.png"))).toBe(true);
    expect(existsSync(join(out, index.renders[0]?.folder ?? "", "sheet.png"))).toBe(true);
  });

  it("refuses bad options with a usage error", async () => {
    expect((await run(["3d", "--fixture", "single-room", "--size", "big"])).code).toBe(2);
    expect((await run(["3d", "--fixture", "no-such-plan", "--boxes"])).code).toBe(2);
    expect((await run(["3d", "--fixture", "single-room", "--plan", "x.json"])).code).toBe(2);
  });
});
