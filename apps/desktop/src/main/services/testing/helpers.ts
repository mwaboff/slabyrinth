import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { bundledPalettes, planRules } from "@slabyrinth/core";
import type { MapPlan, PlanIssue, PlanRules } from "@slabyrinth/core";
import { memoryLogger } from "../../logger";
import { createPlanCorePort, type PlanCorePort } from "../../ports/core";
import type { Dialogs } from "../dialogs";
import { recordingEmitter } from "../events";
import { ProjectService } from "../projectService";
import { SettingsStore } from "../settingsStore";
import type { LockEnv } from "../projectLock";

/** Test doubles shared by the main-process service tests (Electron is never loaded). */

export async function tempDir(prefix = "slab-"): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** The plan rules of the bundled palettes (what the service tests build with). */
export const BUNDLED_RULES: PlanRules = planRules(bundledPalettes());

/** The real core port with the bundled palettes; a test may replace the validator or the migration. */
export function corePort(
  opts: { validate?: (p: MapPlan) => PlanIssue[]; migrate?: (j: unknown) => unknown } = {},
): PlanCorePort {
  return createPlanCorePort(() => BUNDLED_RULES, {
    ...(opts.validate ? { validatePlan: opts.validate } : {}),
    ...(opts.migrate ? { migrateProject: opts.migrate } : {}),
  });
}

export interface ScriptedDialogs extends Dialogs {
  next: { openFile: string | null; saveFile: string | null; chooseFolder: string | null; confirm: boolean };
  asked: string[];
}

export function scriptedDialogs(): ScriptedDialogs {
  const d: ScriptedDialogs = {
    next: { openFile: null, saveFile: null, chooseFolder: null, confirm: false },
    asked: [],
    openFile: (o) => {
      d.asked.push(`open:${o.title}`);
      return Promise.resolve(d.next.openFile);
    },
    saveFile: (o) => {
      d.asked.push(`save:${o.title}`);
      return Promise.resolve(d.next.saveFile);
    },
    chooseFolder: (o) => {
      d.asked.push(`folder:${o.title}`);
      return Promise.resolve(d.next.chooseFolder);
    },
    confirm: (o) => {
      d.asked.push(`confirm:${o.title}`);
      return Promise.resolve(d.next.confirm);
    },
  };
  return d;
}

export interface ProjectRig {
  dir: string;
  settings: SettingsStore;
  projects: ProjectService;
  emit: ReturnType<typeof recordingEmitter>;
  dialogs: ScriptedDialogs;
  logger: ReturnType<typeof memoryLogger>;
  trashed: string[];
}

export async function projectRig(
  opts: { core?: PlanCorePort; lockEnv?: LockEnv; autosaveDelayMs?: number; dir?: string } = {},
): Promise<ProjectRig> {
  const dir = opts.dir ?? (await tempDir("slab-proj-"));
  const logger = memoryLogger();
  const settings = new SettingsStore({
    file: path.join(dir, "settings.json"),
    defaultProjectsFolder: path.join(dir, "Projects"),
    logger,
  });
  await settings.load();
  const emit = recordingEmitter();
  const dialogs = scriptedDialogs();
  const trashed: string[] = [];
  const projects = new ProjectService({
    settings,
    core: opts.core ?? corePort(),
    dialogs,
    emit,
    logger,
    appVersion: "0.1.0-test",
    trashItem: async (f) => {
      trashed.push(f);
      await fsp.rm(f, { force: true });
    },
    showItemInFolder: () => undefined,
    ...(opts.lockEnv ? { lockEnv: opts.lockEnv } : {}),
    autosaveDelayMs: opts.autosaveDelayMs ?? 20,
  });
  return { dir, settings, projects, emit, dialogs, logger, trashed };
}
