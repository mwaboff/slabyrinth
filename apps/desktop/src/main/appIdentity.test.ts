import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_ID } from "./appIdentity";

const appDir = fileURLToPath(new URL("../../", import.meta.url));
const builderYml = readFileSync(path.join(appDir, "electron-builder.yml"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(appDir, "package.json"), "utf8")) as { desktopName?: string };

/** The value of `key:` in the top-level `section:` block of electron-builder.yml (or the top level). */
function yml(key: string, section?: string): string | undefined {
  let lines = builderYml.split(/\r?\n/);
  if (section !== undefined) {
    const start = lines.findIndex((l) => l === `${section}:`);
    if (start < 0) return undefined;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\S/.test(l));
    lines = (end < 0 ? rest : rest.slice(0, end)).map((l) => l.replace(/^ {2}/, ""));
  }
  const line = lines.find((l) => l.startsWith(`${key}:`));
  return line
    ?.slice(key.length + 1)
    .replace(/#.*$/, "")
    .trim();
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(file: string): [number, number] {
  const b = readFileSync(file);
  expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

describe("app identity and icons (electron-builder.yml)", () => {
  it("the runtime AppUserModelID is the builder appId", () => {
    expect(yml("appId")).toBe(APP_ID);
  });

  it("Windows exe, installer and uninstaller use the generated .ico with every small size", () => {
    for (const [key, section] of [
      ["icon", "win"],
      ["installerIcon", "nsis"],
      ["uninstallerIcon", "nsis"],
    ] as const) {
      expect(yml(key, section), `${section}.${key}`).toBe("build/icon.ico");
    }
    const ico = readFileSync(path.join(appDir, "build/icon.ico"));
    const count = ico.readUInt16LE(4);
    const sizes = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256);
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });

  it("the Linux icon set has every size the desktop entry and AppImage use", () => {
    expect(yml("icon", "linux")).toBe("build/icons");
    for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) {
      expect(pngSize(path.join(appDir, `build/icons/${String(s)}x${String(s)}.png`))).toEqual([s, s]);
    }
  });

  it("the Linux desktop file, StartupWMClass and the window's WM_CLASS agree", () => {
    expect(yml("syncDesktopName", "linux")).toBe("true");
    expect(pkg.desktopName).toBe(`${String(yml("executableName", "linux"))}.desktop`);
  });
});
