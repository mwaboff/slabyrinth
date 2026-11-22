/**
 * Every behaviour switch of plan/generator.ts is read somewhere in src/ (a switch nothing reads is a generator change
 * that does nothing, or one whose reader was lost in a refactor).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SWITCH_DECLARATIONS, type SwitchName } from "../../../src/plan/generator";

const SRC = fileURLToPath(new URL("../../../src/", import.meta.url));
const TABLE = join(SRC, "plan", "generator.ts");

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("generator switches", () => {
  it("every switch is read outside the table that declares it", () => {
    const text = sources(SRC)
      .filter((f) => f !== TABLE)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    const unread = (Object.keys(SWITCH_DECLARATIONS) as SwitchName[]).filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(text),
    );
    expect(unread).toEqual([]);
  });
});
