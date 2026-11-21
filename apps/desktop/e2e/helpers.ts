/**
 * Shared launch helpers for the e2e specs that drive the real app. Every launch is hidden
 * (SLABYRINTH_E2E=1: no window shown, no dialogs, memory clipboard, no TaleSpire lookup or launch),
 * uses a throwaway userData folder and the scripted provider instead of Anthropic.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import type { IpcRequests, Result } from "../src/shared/ipc";

export const mainEntry = fileURLToPath(new URL("../out-test/main/index.js", import.meta.url));

export interface Run {
  dir: string;
  userData: string;
  script: string;
  log: string;
}

export function newRun(prefix: string, steps: unknown[]): Run {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const run = {
    dir,
    userData: path.join(dir, "userData"),
    script: path.join(dir, "steps.json"),
    log: path.join(dir, "requests.jsonl"),
  };
  writeFileSync(run.script, JSON.stringify(steps));
  return run;
}

export function cleanRun(run: Run): void {
  rmSync(run.dir, { recursive: true, force: true });
}

export async function launch(
  run: Run,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  expect(
    existsSync(mainEntry),
    `${mainEntry} missing: run npm run build:test -w @slabyrinth/desktop first`,
  ).toBe(true);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env["ANTHROPIC_API_KEY"];
  const app = await electron.launch({
    args: [mainEntry],
    env: {
      ...env,
      SLABYRINTH_E2E: "1",
      SLABYRINTH_USER_DATA: run.userData,
      SLABYRINTH_E2E_PROVIDER_SCRIPT: run.script,
      SLABYRINTH_E2E_PROVIDER_LOG: run.log,
      ...extraEnv,
    },
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  await expect(page.locator("html")).toHaveAttribute("data-slabyrinth-ready", "true");
  return { app, page };
}

export const unwrap = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

export function invoke<C extends keyof IpcRequests>(
  page: Page,
  channel: C,
  req: IpcRequests[C]["req"],
): Promise<Result<IpcRequests[C]["res"]>> {
  return page.evaluate(([c, r]) => window.slabyrinth.invoke(c as never, r as never), [channel, req] as const);
}
