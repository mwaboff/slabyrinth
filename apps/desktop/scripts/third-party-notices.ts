/**
 * Generates third-party/THIRD-PARTY-NOTICES.txt: the copyright notices and licence texts of everything
 * third-party that ships inside the packaged app (fonts and the npm packages bundled into out/**).
 * electron-builder copies the file next to the app (electron-builder.yml, extraFiles). No dependencies:
 * Node runs this file directly.
 *
 *   npm run notices -w @slabyrinth/desktop            regenerate after adding or upgrading a dependency
 *   node apps/desktop/scripts/third-party-notices.ts --check     exit 1 when the committed file is stale
 *
 * third-party-notices.test.ts fails when the file is stale, when the app imports a package that is not
 * listed here, or when a listed package depends on one that is neither listed nor known to be type-only.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = path.dirname(path.dirname(APP_ROOT));
export const NOTICES_FILE = path.join(APP_ROOT, "third-party", "THIRD-PARTY-NOTICES.txt");

/**
 * npm packages whose code is bundled into out/main, out/preload or out/renderer (electron-vite bundles
 * every dependency; check with `electron-vite build --sourcemap` and the `sources` of out/**\/*.map).
 */
export const BUNDLED_PACKAGES = [
  "@anthropic-ai/sdk",
  "@opentelemetry/api",
  "@stablelib/base64",
  "fast-sha256",
  "fflate",
  "react",
  "react-dom",
  "scheduler",
  "standardwebhooks",
  "zod",
  "zustand",
] as const;

/** Runtime dependencies of bundled packages that contribute no code to the bundle (types only). */
export const NOT_BUNDLED: Readonly<Record<string, string>> = {
  "json-schema-to-ts": "@anthropic-ai/sdk imports it for types only",
};

/**
 * The bundled fonts. Their licence files are the ones the landing page serves next to its copies of the
 * same fonts (site/assets/fonts), so the app and the site carry the same notices. Source: the font
 * families' OFL.txt in github.com/google/fonts (ofl/cinzel, ofl/lora, ofl/sourcesans3).
 */
export const FONTS = [
  { family: "Cinzel", pkg: "@fontsource/cinzel", licence: "site/assets/fonts/OFL-Cinzel.txt" },
  { family: "Lora", pkg: "@fontsource/lora", licence: "site/assets/fonts/OFL-Lora.txt" },
  {
    family: "Source Sans 3",
    pkg: "@fontsource/source-sans-3",
    licence: "site/assets/fonts/OFL-SourceSans3.txt",
  },
] as const;

/** Packages published without a licence file: the upstream licence, copied verbatim into the repository. */
const LICENCE_OVERRIDES: Readonly<Record<string, { file: string; source: string }>> = {
  standardwebhooks: {
    file: "apps/desktop/third-party/licenses/standardwebhooks-LICENSE.txt",
    source: "https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/LICENSE",
  },
};

interface PackageJson {
  name: string;
  version: string;
  license?: string;
  author?: string | { name?: string };
  homepage?: string;
  repository?: string | { url?: string };
  dependencies?: Record<string, string>;
}

export function packageDir(name: string): string {
  for (const base of [path.join(APP_ROOT, "node_modules"), path.join(REPO_ROOT, "node_modules")]) {
    const dir = path.join(base, ...name.split("/"));
    if (existsSync(path.join(dir, "package.json"))) return dir;
  }
  throw new Error(`package not installed: ${name} (run npm ci)`);
}

export function readPackageJson(name: string): PackageJson {
  return JSON.parse(readFileSync(path.join(packageDir(name), "package.json"), "utf8")) as PackageJson;
}

function text(file: string): string {
  const lines = readFileSync(file, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  return trimBlankLines(lines.map((l) => l.trimEnd()).join("\n"));
}

/** Drops leading and trailing blank lines, keeping the first line's indentation. */
function trimBlankLines(t: string): string {
  return t.replace(/^\n+/, "").trimEnd();
}

/** Licence and notice files of an installed package (LICENSE, LICENSE-MIT, NOTICE, COPYING, …). */
function licenceFiles(name: string): string[] {
  const override = LICENCE_OVERRIDES[name];
  if (override) return [path.join(REPO_ROOT, override.file)];
  const dir = packageDir(name);
  const files = readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)([.\-_].*)?$/i.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no licence file in ${name}; add a LICENCE_OVERRIDES entry`);
  return files.map((f) => path.join(dir, f));
}

/** A copyright notice line ("Copyright (c) 2019 …", "Copyright 2023 …"), not licence prose that mentions copyright. */
const COPYRIGHT_LINE = /^\s*(copyright\s+(\(c\)|©|\d{4}|\[yyyy\])|\(c\)\s+\d{4}|©\s*\d{4})/i;

/** Splits a licence file into its copyright lines (shown per package) and the licence text (grouped). */
function splitCopyright(t: string): { copyright: string[]; body: string } {
  const copyright: string[] = [];
  const body: string[] = [];
  for (const line of t.split("\n")) {
    if (COPYRIGHT_LINE.test(line)) {
      // The Apache-2.0 appendix template line is not a notice.
      if (!line.includes("[yyyy]")) copyright.push(line.trim());
    } else body.push(line);
  }
  return { copyright, body: trimBlankLines(body.join("\n").replace(/\n{3,}/g, "\n\n")) };
}

/** Splits an OFL.txt into the font's notice (copyright, Reserved Font Names) and the licence itself. */
function splitOfl(t: string): { notice: string; body: string } {
  const i = t.indexOf("SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007");
  if (i < 0) return { notice: "", body: t };
  const start = t.lastIndexOf("\n", t.lastIndexOf("\n", i) - 1); // the dashed rule above the title
  const cut = start < 0 ? i : start;
  return { notice: t.slice(0, cut).trim(), body: t.slice(cut).trim() };
}

function repoUrl(p: PackageJson): string {
  const r = typeof p.repository === "string" ? p.repository : p.repository?.url;
  if (r) {
    const gh = /^(?:github:)?([\w.-]+\/[\w.-]+)$/.exec(r);
    if (gh) return `https://github.com/${gh[1]}`;
    return r.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  return p.homepage ?? "";
}

function authorOf(p: PackageJson): string {
  const a = typeof p.author === "string" ? p.author : p.author?.name;
  return (a ?? "")
    .replace(/\s*<[^>]*>/, "")
    .replace(/\s*\([^)]*\)/, "")
    .trim();
}

function licenceTitle(body: string, fallback: string | undefined): string {
  if (/Apache License\s+Version 2\.0/.test(body)) return "Apache License 2.0";
  if (/unlicense\.org/i.test(body)) return "The Unlicense";
  if (/Permission is hereby granted, free of charge/.test(body)) return "MIT License";
  return fallback ?? "Licence";
}

const RULE = "=".repeat(78);
const THIN = "-".repeat(78);

interface Group {
  title: string;
  body: string;
  members: string[];
}

function addToGroup(groups: Group[], title: string, body: string, member: string): number {
  let g = groups.findIndex((x) => x.body === body);
  if (g < 0) g = groups.push({ title, body, members: [] }) - 1;
  const group = groups[g];
  if (group) group.members.push(member);
  return g;
}

export function generateNotices(): string {
  const out: string[] = [];
  out.push(
    "Slabyrinth: third-party notices",
    "",
    "Slabyrinth is released under the MIT License (https://github.com/mwaboff/slabyrinth/blob/main/LICENSE).",
    "It includes the fonts and open-source packages listed below, each under its own licence.",
    "Electron's and Chromium's licences are in LICENSE.electron.txt and LICENSES.chromium.html,",
    "next to this file.",
    "",
    "Generated by apps/desktop/scripts/third-party-notices.ts; do not edit by hand.",
  );

  // Fonts: each font's own notice, then the licence text once per distinct text.
  const fontGroups: Group[] = [];
  const fontEntries: string[] = [];
  for (const f of FONTS) {
    const p = readPackageJson(f.pkg);
    const { notice, body } = splitOfl(text(path.join(REPO_ROOT, f.licence)));
    const g = addToGroup(fontGroups, "SIL Open Font License 1.1", body, f.family);
    fontEntries.push(
      [
        f.family,
        `  Bundled from: ${p.name} ${p.version} (${p.license ?? "OFL-1.1"})`,
        `  Licence: SIL Open Font License 1.1, text [F${g + 1}] below`,
        "",
        ...notice.split("\n").map((l) => (l === "" ? "" : `  ${l}`)),
      ].join("\n"),
    );
  }
  out.push("", RULE, "FONTS", RULE, "", fontEntries.join("\n\n"));
  fontGroups.forEach((g, i) =>
    out.push("", THIN, `[F${i + 1}] ${g.title} (${g.members.join(", ")})`, THIN, "", g.body),
  );

  // npm packages: name, version, licence, copyright lines; then each distinct licence text once.
  const groups: Group[] = [];
  const entries: string[] = [];
  for (const name of [...BUNDLED_PACKAGES].sort()) {
    const p = readPackageJson(name);
    const refs: string[] = [];
    const copyright: string[] = [];
    for (const file of licenceFiles(name)) {
      const split = splitCopyright(text(file));
      copyright.push(...split.copyright.filter((c) => !copyright.includes(c)));
      const g = addToGroup(groups, licenceTitle(split.body, p.license), split.body, name);
      refs.push(`[L${g + 1}]`);
    }
    const lines = [
      `${name} ${p.version}`,
      `  Licence: ${p.license ?? "see text"}, text ${refs.join(" and ")} below`,
    ];
    const url = repoUrl(p);
    if (url) lines.push(`  Source: ${url}`);
    const override = LICENCE_OVERRIDES[name];
    if (override) lines.push(`  Licence file (not in the npm package) from: ${override.source}`);
    if (copyright.length > 0) lines.push(...copyright.map((c) => `  ${c}`));
    else if (authorOf(p)) lines.push(`  Author: ${authorOf(p)}`);
    entries.push(lines.join("\n"));
  }
  out.push("", RULE, "NPM PACKAGES", RULE, "", entries.join("\n\n"));
  groups.forEach((g, i) =>
    out.push("", THIN, `[L${i + 1}] ${g.title} (${g.members.join(", ")})`, THIN, "", g.body),
  );
  return `${out.join("\n")}\n`;
}

function main(argv: string[]): void {
  const next = generateNotices();
  if (argv.includes("--check")) {
    const current = existsSync(NOTICES_FILE) ? readFileSync(NOTICES_FILE, "utf8").replace(/\r\n/g, "\n") : "";
    if (current !== next) {
      process.stderr.write(`${NOTICES_FILE} is stale: run npm run notices -w @slabyrinth/desktop\n`);
      process.exit(1);
    }
    return;
  }
  writeFileSync(NOTICES_FILE, next);
  process.stdout.write(`wrote ${path.relative(REPO_ROOT, NOTICES_FILE)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
