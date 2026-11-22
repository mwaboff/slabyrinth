/**
 * Slabyrinth Helper as a package: its manifest against TaleSpire's documented format (manifest v1,
 * https://symbiote-docs.talespire.com/manifest_doc_v1.html), the metadata the owner pinned, and a static check that
 * the add-on makes no request off this computer.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DIR = new URL("../slabyrinth-helper/", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("manifest.json", DIR), "utf8"));
const LICENSE = readFileSync(new URL("../../LICENSE", import.meta.url), "utf8");

/** A local path in a manifest: starts with "/" and stays inside the add-on's folder. */
function localFile(p) {
  expect(typeof p).toBe("string");
  expect(p.startsWith("/")).toBe(true);
  expect(p.split("/")).not.toContain("..");
  expect(statSync(new URL(`.${p}`, DIR)).isFile()).toBe(true);
}

describe("manifest.json (TaleSpire manifest v1)", () => {
  it("has the fields TaleSpire needs to load it", () => {
    expect(manifest.manifestVersion).toBe(1);
    expect(typeof manifest.name).toBe("string");
    expect(manifest.name.length).toBeGreaterThan(0);
    expect(manifest.name.length).toBeLessThanOrEqual(80);
    localFile(manifest.entryPoint);
    expect(manifest.kind ?? "webView").toBe("webView");
  });

  it("keeps the documented limits and shapes of the optional fields", () => {
    expect(manifest.summary.length).toBeLessThanOrEqual(250);
    localFile(manifest.descriptionFilePath);
    expect(manifest.about.website).toMatch(/^https:\/\/[a-z0-9.-]+\.[a-z]{2,}$/);
    expect(Array.isArray(manifest.about.authors)).toBe(true);
    expect(manifest.api.version).toBe("0.1");
    expect(manifest.environment.webViewBackgroundColor).toMatch(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
    for (const c of manifest.environment.capabilities) expect(["playAudio", "runInBackground"]).toContain(c);
    const known = [
      "manifestVersion",
      "name",
      "summary",
      "descriptionFilePath",
      "entryPoint",
      "version",
      "license",
      "about",
      "kind",
      "icons",
      "controls",
      "api",
      "environment",
    ];
    for (const k of Object.keys(manifest)) expect(known).toContain(k);
  });

  it("names every subscription handler the page defines", () => {
    const page = readFileSync(new URL("app.js", DIR), "utf8");
    for (const events of Object.values(manifest.api.subscriptions))
      for (const handler of Object.values(events))
        expect(page).toMatch(new RegExp(`^function ${handler}\\(`, "m"));
  });

  it("carries the owner's metadata: the app's licence, author, website, a version the app can compare", () => {
    expect(LICENSE.startsWith("MIT License")).toBe(true);
    expect(manifest.license).toBe("MIT");
    expect(manifest.about.authors).toEqual(["Michael Aboff"]);
    expect(manifest.about.website).toBe("https://slabyrinth.aboff.com");
    // the app compares versions as semver (apps/desktop/src/main/services/semver.ts); 0.2.0 is the first paired one
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    const [maj, min] = manifest.version.split(".").map(Number);
    expect(maj > 0 || min >= 2).toBe(true);
    expect(JSON.stringify(manifest)).not.toMatch(/@/); // no email address
  });
});

describe("the add-on talks to nothing off this computer", () => {
  const files = readdirSync(DIR).filter((f) => /\.(js|html|css|json)$/.test(f));

  it("names no external URL in its code, page or styles", () => {
    expect(files).toEqual(expect.arrayContaining(["app.js", "index.html", "sequencer.js", "style.css"]));
    for (const f of files) {
      if (f === "manifest.json") continue; // the website field is metadata TaleSpire shows, not a request
      const text = readFileSync(new URL(f, DIR), "utf8");
      const urls = [...text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>]*/g)].map((m) => m[0]);
      const external = urls.filter(
        (u) => !/^(?:https?|wss?):\/\/(?:127\.0\.0\.1|localhost)(?:[:/$]|$)/.test(u),
      );
      expect([f, external]).toEqual([f, []]);
      // no remote stylesheets, fonts or scripts
      expect(text).not.toMatch(/@import\s+url\(\s*["']?(?:https?:)?\/\//);
      expect(text).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=["'](?:https?:)?\/\//);
    }
  });

  it("only ever opens sockets and fetches to 127.0.0.1 or its own folder", () => {
    const app = readFileSync(new URL("app.js", DIR), "utf8");
    for (const m of app.matchAll(/new WebSocket\(([^)]*)\)/g))
      expect(m[1]).toMatch(/^`ws:\/\/127\.0\.0\.1:|^url$/);
    for (const m of app.matchAll(/fetch\(([^,)]*)/g))
      expect(m[1]).toMatch(/^(Seq\.LINK_CONFIG_FILE|"manifest\.json"|url)$/);
    expect(app).toMatch(/const url = `http:\/\/127\.0\.0\.1:\$\{port\}\/probe`;/);
    expect(app).toMatch(/const url = `ws:\/\/127\.0\.0\.1:\$\{port\}\/probe`;/);
  });

  it("writes text into the page with textContent only", () => {
    for (const f of ["app.js", "sequencer.js"]) {
      const text = readFileSync(new URL(f, DIR), "utf8");
      expect(text).not.toMatch(/\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write\(/);
    }
  });
});
