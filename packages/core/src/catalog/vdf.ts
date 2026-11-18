/**
 * Valve KeyValues (VDF/ACF) text parser and the Steam files Slabyrinth reads:
 * `steamapps/libraryfolders.vdf` (both the current nested format and the legacy flat one) and
 * `steamapps/appmanifest_<appid>.acf`. Pure functions over file contents.
 */
export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

export class VdfError extends Error {
  override name = "VdfError";
}

type Tok = { t: "str"; v: string } | { t: "{" } | { t: "}" };

function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] ?? "";
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "﻿") {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "{" || ch === "}") {
      out.push({ t: ch });
      i++;
      continue;
    }
    if (ch === "[") {
      while (i < n && text[i] !== "]") i++;
      i++;
      continue;
    } // conditional like [$WIN32]: ignored
    if (ch === '"') {
      i++;
      let v = "";
      while (i < n && text[i] !== '"') {
        const c = text[i] ?? "";
        if (c === "\\" && i + 1 < n) {
          const e = text[i + 1] ?? "";
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
          i += 2;
        } else {
          v += c;
          i++;
        }
      }
      if (i >= n) throw new VdfError("unterminated string");
      i++;
      out.push({ t: "str", v });
      continue;
    }
    let v = "";
    while (i < n && !/[\s{}"]/.test(text[i] ?? "")) v += text[i++] ?? "";
    out.push({ t: "str", v });
  }
  return out;
}

/** Parses KeyValues text. Keys are kept as written; use `vdfGet` for case-insensitive lookup. Later duplicates win. */
export function parseVdf(text: string): VdfObject {
  const toks = tokenize(text);
  let p = 0;
  const parseObj = (nested: boolean): VdfObject => {
    const o: VdfObject = {};
    while (p < toks.length) {
      const k = toks[p];
      if (!k) break;
      if (k.t === "}") {
        if (!nested) throw new VdfError("unexpected }");
        p++;
        return o;
      }
      if (k.t !== "str") throw new VdfError("expected key");
      p++;
      const v = toks[p];
      if (!v) throw new VdfError(`missing value for "${k.v}"`);
      if (v.t === "{") {
        p++;
        o[k.v] = parseObj(true);
      } else if (v.t === "str") {
        p++;
        o[k.v] = v.v;
      } else throw new VdfError(`unexpected } after "${k.v}"`);
    }
    if (nested) throw new VdfError("unterminated object");
    return o;
  };
  return parseObj(false);
}

export function vdfGet(o: VdfObject | undefined, key: string): VdfValue | undefined {
  if (!o) return undefined;
  const lk = key.toLowerCase();
  for (const k of Object.keys(o)) if (k.toLowerCase() === lk) return o[k];
  return undefined;
}
const asObj = (v: VdfValue | undefined): VdfObject | undefined =>
  v !== undefined && typeof v !== "string" ? v : undefined;

export interface SteamLibrary {
  path: string;
  /** App ids listed in the library's `apps` block (empty for the legacy format). */
  apps: string[];
}

/** Libraries from `libraryfolders.vdf` (new nested and legacy flat formats). */
export function parseLibraryFolders(text: string): SteamLibrary[] {
  const root = parseVdf(text);
  const lf = asObj(vdfGet(root, "libraryfolders")) ?? asObj(vdfGet(root, "LibraryFolders")) ?? root;
  const out: SteamLibrary[] = [];
  for (const [k, v] of Object.entries(lf)) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === "string") out.push({ path: v, apps: [] });
    else {
      const path = vdfGet(v, "path");
      if (typeof path !== "string") continue;
      const apps = asObj(vdfGet(v, "apps"));
      out.push({ path, apps: apps ? Object.keys(apps) : [] });
    }
  }
  return out;
}

export interface AppManifest {
  appid: string;
  name: string;
  installdir: string;
  buildid: string;
}

export function parseAppManifest(text: string): AppManifest | null {
  const st = asObj(vdfGet(parseVdf(text), "AppState"));
  if (!st) return null;
  const s = (k: string): string => {
    const v = vdfGet(st, k);
    return typeof v === "string" ? v : "";
  };
  return { appid: s("appid"), name: s("name"), installdir: s("installdir"), buildid: s("buildid") };
}
