import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  APP_ROOT,
  BUNDLED_PACKAGES,
  FONTS,
  NOT_BUNDLED,
  NOTICES_FILE,
  REPO_ROOT,
  generateNotices,
  readPackageJson,
} from "./third-party-notices";

/** Source trees that electron-vite bundles into the shipped app (tests and test helpers excluded). */
const SHIPPED_SOURCES = [
  path.join(APP_ROOT, "src"),
  path.join(REPO_ROOT, "packages", "core", "src"),
  path.join(REPO_ROOT, "packages", "render-canvas", "src"),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name !== "test" && name !== "__tests__") out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx|css)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

/** Package names imported by shipped source (bare specifiers; node:, electron and workspace packages excluded). */
function importedPackages(): Set<string> {
  const found = new Set<string>();
  const spec = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|@import\s+)["']([^"']+)["']/g;
  for (const dir of SHIPPED_SOURCES) {
    for (const file of sourceFiles(dir)) {
      for (const m of readFileSync(file, "utf8").matchAll(spec)) {
        const s = m[1] ?? "";
        if (s.startsWith(".") || s.startsWith("/") || s.startsWith("node:")) continue;
        const parts = s.split("/");
        const pkg = s.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
        if (pkg === "electron" || pkg.startsWith("@slabyrinth/")) continue;
        found.add(pkg);
      }
    }
  }
  return found;
}

describe("third-party notices", () => {
  const listed = new Set<string>([...BUNDLED_PACKAGES, ...FONTS.map((f) => f.pkg)]);

  it("lists every package the shipped source imports", () => {
    const imported = importedPackages();
    expect(imported.size).toBeGreaterThan(5);
    expect([...imported].filter((p) => !listed.has(p))).toEqual([]);
  });

  it("lists the runtime dependencies of every bundled package", () => {
    const missing: string[] = [];
    for (const name of BUNDLED_PACKAGES) {
      for (const dep of Object.keys(readPackageJson(name).dependencies ?? {})) {
        if (!listed.has(dep) && !(dep in NOT_BUNDLED)) missing.push(`${name} -> ${dep}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("carries each font's notice and the OFL text, shared with the landing page", () => {
    for (const f of FONTS) {
      const file = path.join(REPO_ROOT, f.licence);
      expect(existsSync(file)).toBe(true);
      const t = readFileSync(file, "utf8");
      expect(t).toMatch(/^Copyright /);
      expect(t).toContain("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
    }
  });

  it("is up to date (regenerate with: npm run notices -w @slabyrinth/desktop)", () => {
    const committed = readFileSync(NOTICES_FILE, "utf8").replace(/\r\n/g, "\n");
    expect(committed).toBe(generateNotices());
    for (const name of BUNDLED_PACKAGES) {
      expect(committed).toContain(`\n${name} ${readPackageJson(name).version}\n`);
    }
  });
});
