import { describe, expect, it } from "vitest";
import { runRender } from "../src/index";

describe("render command", () => {
  it("prints its usage and exits 2 without a command", async () => {
    const err: string[] = [];
    const code = await runRender([], { out: () => undefined, err: (s) => err.push(s) });
    expect(code).toBe(2);
    expect(err.join("\n")).toContain("npm run render -- 3d");
  });
});
