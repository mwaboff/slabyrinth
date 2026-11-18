import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { runCli, type CliIo } from "../../../src/cli/index";
import { decode } from "../../../src/slab";

const plans = fileURLToPath(new URL("../../fixtures/plans/", import.meta.url));
const calibration = fileURLToPath(new URL("../../../../../data/calibration-slab.txt", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "slabyrinth-cli-"));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function run(args: string[], stdin = ""): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const io: CliIo = { out: (s) => (out += s + "\n"), err: (s) => (err += s + "\n"), readStdin: () => stdin };
  const code = await runCli(args, io);
  return { code, out, err };
}

describe("slabyrinth CLI", () => {
  it("prints usage for unknown commands", async () => {
    expect((await run(["nope"])).code).toBe(2);
    expect((await run(["decode"])).code).toBe(2);
  });

  it("decode prints layouts with palette names; --json is machine-readable", async () => {
    const r = await run(["decode", `@${calibration}`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/v2: 6 layouts, 130 assets/);
    expect(r.out).toMatch(/Dungeon Stairs/);
    const j = await run(["decode", "-", "--json"], readFileSync(calibration, "utf8"));
    expect((JSON.parse(j.out) as { assets: unknown[] }).assets).toHaveLength(130);
  });

  it("encode accepts tile coordinates and decode --json output (round trip)", async () => {
    const f = join(tmp, "assets.json");
    writeFileSync(
      f,
      JSON.stringify({
        assets: [{ uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", x: 3, y: 0.5, z: 2, rot: 90 }],
      }),
    );
    const e = await run(["encode", f]);
    expect(e.code).toBe(0);
    expect(decode(e.out.trim()).assets).toEqual([
      { uuid: "e62c6746-cecf-46bf-8b20-f81738f1d220", sx: 300, sy: 50, sz: 200, rot: 6 },
    ]);
    const j = await run(["decode", e.out.trim(), "--json"]);
    const again = await run(["encode", "-", "--fenced"], j.out);
    expect(again.out.trim().startsWith("```")).toBe(true);
    expect(decode(again.out).assets).toEqual(decode(e.out).assets);
  });

  it("calibration regenerates the probe slab", async () => {
    const r = await run(["calibration"]);
    expect(decode(r.out.trim()).assets).toEqual(decode(readFileSync(calibration, "utf8")).assets);
  });

  it("validate / ascii / compile work headless on a fixture plan", async () => {
    expect((await run(["validate", join(plans, "single-room.json")])).out).toMatch(/OK/);
    expect((await run(["ascii", join(plans, "single-room.json")])).out).toMatch(/#/);
    const out = join(tmp, "build");
    const c = await run(["compile", join(plans, "multi-level-stairs.json"), "--out", out]);
    expect(c.code).toBe(0);
    const files = readdirSync(out).sort();
    expect(files).toContain("report.json");
    expect(files).toContain("PASTE.md");
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as {
      chunks: Array<{ id: string; slab: string }>;
    };
    for (const ch of report.chunks)
      expect(decode(readFileSync(join(out, ch.slab), "utf8")).assets.length).toBeGreaterThan(0);
  });

  it("compile refuses invalid plans", async () => {
    const f = join(tmp, "bad.json");
    writeFileSync(f, JSON.stringify({ schema: "slabyrinth/plan@1" }));
    expect((await run(["compile", f])).code).toBe(1);
  });

  it("compile prints verify diagnostics with fixes, writes nothing on errors, and --force overrides", async () => {
    // A valid plan (two-rooms-door passes validation) built with a user palette override whose door geometry is
    // wrong (origin "center" instead of the tile's min corner): only the verify stage can see that the built door
    // is not in its wall's half-cell.
    const palDir = join(tmp, "palettes");
    mkdirSync(palDir, { recursive: true });
    const sd = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../data/palettes/stone_dungeon.json", import.meta.url)),
        "utf8",
      ),
    ) as { roles: Record<string, { variants: Array<{ geom: { originAt: string } }> }> };
    const door = sd.roles["opening.door"];
    if (!door) throw new Error("fixture: stone_dungeon has no opening.door");
    for (const v of door.variants) v.geom.originAt = "center";
    writeFileSync(
      join(palDir, "stone_dungeon.json"),
      JSON.stringify({
        schema: "slabyrinth/palette@1",
        id: "stone_dungeon",
        overrides: true,
        roles: { "opening.door": door },
      }),
    );
    const planFile = join(plans, "two-rooms-door.json");
    expect((await run(["validate", planFile])).code).toBe(0);
    const out = join(tmp, "bad-door");
    const refused = await run(["compile", planFile, "--palettes", palDir, "--out", out]);
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(
      /error verify_door_misplaced \[l1 \(\d+,\d+\) [NESW]\]: The Door - Dungeon for opening door1 is not inside its wall's half-cell\./,
    );
    expect(refused.err).toMatch(/fix: Check the palette geometry/);
    expect(refused.err).toMatch(/nothing written/);
    expect(() => readdirSync(out)).toThrow();
    const forced = await run(["compile", planFile, "--palettes", palDir, "--out", out, "--force"]);
    expect(forced.code).toBe(0);
    expect(readdirSync(out)).toContain("report.json");
    // the default palettes build the same plan cleanly
    expect((await run(["compile", planFile])).code).toBe(0);
  });
});
