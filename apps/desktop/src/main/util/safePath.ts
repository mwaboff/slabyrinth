import * as path from "node:path";
import { AppFailure } from "./errors";

/**
 * Shape check for a path that came from the renderer. It must be absolute, local (no UNC
 * `\\server\share` or `//host/...`, no `\\?\` / `\\.\` device paths, no Windows device names or
 * alternate data streams), already normalised (no `.`/`..` segments, no doubled separators) and,
 * when `ext` is given, end with that extension. Returns the path; throws AppFailure("validation").
 * This is only the SHAPE check: callers must also require that main handed the path out.
 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)$/i;

export function checkLocalPath(raw: string, opts: { ext?: string; platform?: NodeJS.Platform } = {}): string {
  const platform = opts.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const bad = (why: string): never => {
    throw new AppFailure("validation", `That path isn't allowed (${why}).`);
  };
  if (raw.length === 0 || raw.includes("\0")) bad("empty or NUL");
  if (/^[\\/]{2}/.test(raw)) bad("network or device path");
  if (platform === "win32" && !/^[A-Za-z]:\\/.test(raw)) bad("not an absolute local path");
  if (!p.isAbsolute(raw)) bad("relative path");
  if (raw.split(/[\\/]/).some((seg) => seg === ".." || seg === ".")) bad("path traversal");
  if (p.normalize(raw) !== raw) bad("not a normalised path");
  if (platform === "win32") {
    if (raw.indexOf(":", 2) !== -1) bad("alternate data stream");
    const stem = p.basename(raw).split(".")[0] ?? "";
    if (WINDOWS_DEVICE.test(stem)) bad("device name");
  }
  if (opts.ext !== undefined && !raw.toLowerCase().endsWith(opts.ext.toLowerCase()))
    bad(`not a ${opts.ext} file`);
  return raw;
}

/** Case-insensitive on Windows; used for the sets of paths main has handed out. */
export function pathKey(p: string, platform: NodeJS.Platform = process.platform): string {
  const r = platform === "win32" ? path.win32.resolve(p) : path.posix.resolve(p);
  return platform === "win32" ? r.toLowerCase() : r;
}
