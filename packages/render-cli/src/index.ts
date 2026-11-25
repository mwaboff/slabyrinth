#!/usr/bin/env node
/**
 * The render command, a developer tool for looking at generations without pasting them into TaleSpire:
 * `npm run render -- 3d …` (usage in render3d.ts). Node is allowed here only; the scene and the renderer are
 * @slabyrinth/scene3d. Exit codes as core's CLI: 0 ok, 1 errors in the input, 2 usage.
 */
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { UsageError, parseArgs } from "./args";
import { USAGE_3D, render3d, type Io, type RenderEnv } from "./render3d";
import { USAGE_RESTS, renderRests } from "./rests";

export type RenderIo = Io;

const defaultIo: Io = {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
};

export const USAGE = `${USAGE_3D}\n\n${USAGE_RESTS}`;

/** Relative paths are read from npm's INIT_CWD (where `npm run render` was typed), else the working directory. */
const defaultEnv = (): RenderEnv => ({
  cwd: process.env["INIT_CWD"] ?? process.cwd(),
  appData: process.env["APPDATA"] ?? null,
});

export async function runRender(
  argv: string[],
  io: Io = defaultIo,
  env: RenderEnv = defaultEnv(),
): Promise<number> {
  try {
    const a = parseArgs(argv);
    if (a._[0] === "3d") return await render3d(a, io, env);
    if (a._[0] === "rests") return await renderRests(a, io, env);
    io.err(USAGE);
    return a.flags.has("help") ? 0 : 2;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`usage: ${e.message}\n\n${USAGE}`);
      return 2;
    }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolvePath(process.argv[1])).href : "";
if (import.meta.url === invoked) {
  void runRender(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
