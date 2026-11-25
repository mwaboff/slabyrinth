#!/usr/bin/env node
/**
 * The render command, a developer tool: `npm run render -- 3d …` (usage below). Node is allowed here only.
 */
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export interface RenderIo {
  out: (s: string) => void;
  err: (s: string) => void;
}

const defaultIo: RenderIo = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
};

export const USAGE = `usage: npm run render -- 3d (--fixture <name> | --plan <file.json> | --slab <file.txt>) [options]
  (3D pictures of a build; see CONTRIBUTING.md "Rendering a map in 3D")`;

export function runRender(argv: string[], io: RenderIo = defaultIo): Promise<number> {
  io.err(USAGE);
  return Promise.resolve(argv[0] === "--help" ? 0 : 2);
}

const invoked = process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  void runRender(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
