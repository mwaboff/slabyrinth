import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { changelogSection } from "./release-notes";

const SAMPLE = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "- not yet",
  "",
  "## [0.2.0] - 2026-12-01",
  "",
  "### Added",
  "",
  "- Stamps",
  "",
  "## [0.1.0] - 2026-11-18",
  "",
  "The first release.",
  "",
  "[Unreleased]: https://github.com/mwaboff/slabyrinth/compare/v0.2.0...HEAD",
  "[0.2.0]: https://github.com/mwaboff/slabyrinth/releases/tag/v0.2.0",
].join("\r\n");

describe("release notes from CHANGELOG.md", () => {
  it("returns the tagged version's section only", () => {
    expect(changelogSection(SAMPLE, "v0.2.0")).toBe("### Added\n\n- Stamps\n");
    expect(changelogSection(SAMPLE, "0.1.0")).toBe("The first release.\n");
  });

  it("returns null for a missing or empty section (the workflow falls back to generated notes)", () => {
    expect(changelogSection(SAMPLE, "v0.3.0")).toBeNull();
    expect(changelogSection(SAMPLE, "v0.2")).toBeNull();
    expect(changelogSection("## [0.4.0]\n\n## [0.3.0]\n- x\n", "0.4.0")).toBeNull();
    expect(changelogSection(SAMPLE, "")).toBeNull();
  });

  it("the repository CHANGELOG has a section for the current app version", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const version = (
      JSON.parse(readFileSync(path.join(root, "apps/desktop/package.json"), "utf8")) as {
        version: string;
      }
    ).version;
    const section = changelogSection(readFileSync(path.join(root, "CHANGELOG.md"), "utf8"), `v${version}`);
    expect(section).not.toBeNull();
  });

  it("runs with plain node as the release workflow does", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "slab-notes-"));
    try {
      const script = fileURLToPath(new URL("./release-notes.ts", import.meta.url));
      writeFileSync(path.join(dir, "CHANGELOG.md"), SAMPLE);
      const out = path.join(dir, "notes.md");
      const run = (tag: string): string =>
        execFileSync(process.execPath, [script, tag, path.join(dir, "CHANGELOG.md"), out], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
      expect(run("v0.2.0")).toBe("found=true\n");
      expect(readFileSync(out, "utf8")).toBe("### Added\n\n- Stamps\n");
      expect(run("v9.9.9")).toBe("found=false\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
