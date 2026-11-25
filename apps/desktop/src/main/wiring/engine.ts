/**
 * The conversation engine: the host port it is given (project, plan versions, settings, palettes, the compile
 * estimate, images through the bridge), its construction (logged, never fatal) and the project hooks it registers.
 */
import { resolveApiKey, selectEngine, type EngineKind } from "../engineWiring";
import type { Logger } from "../logger";
import type { ConversationEngine, EngineHost } from "../ports/engine";
import type { BuildPalettes } from "../services/buildPalettes";
import type { BuildService } from "../services/buildService";
import type { EmitEvent } from "../services/events";
import type { ImageBridge } from "../services/imageBridge";
import type { PaletteService } from "../services/paletteService";
import type { ProjectService } from "../services/projectService";
import type { SecretStore } from "../services/secretStore";
import type { SettingsStore } from "../services/settingsStore";
import type { CatalogService } from "../services/talespire/catalogService";
import type { View3dService } from "../services/view3d/view3dService";

export interface EngineDeps {
  isDev: boolean;
  safeMode: boolean;
  logger: Logger;
  emit: EmitEvent;
  settings: SettingsStore;
  secrets: SecretStore;
  projects: ProjectService;
  palettes: PaletteService;
  buildPalettes: BuildPalettes;
  catalog: CatalogService;
  build: BuildService;
  imageBridge: ImageBridge;
  /** The scene worker's 3D pictures for the model (absent: no 3D pictures). */
  view3d?: Pick<View3dService, "render3d">;
}

export interface StartedEngine {
  engine: ConversationEngine | null;
  /** "none" only when construction failed (logged); chat then answers "internal". */
  engineKind: EngineKind | "none";
}

/** Builds the engine the settings and environment select and registers its project hooks. */
export async function startEngine(d: EngineDeps): Promise<StartedEngine> {
  const { logger, projects } = d;
  let engine: ConversationEngine | null = null;
  let engineKind: StartedEngine["engineKind"] = "none";
  try {
    const selected = await selectEngine({ isDev: d.isDev, safeMode: d.safeMode, env: process.env });
    engine = selected.factory(engineHost(d));
    engineKind = selected.kind;
  } catch (err) {
    logger.error("engine construction failed", { error: err });
  }
  logger.info("conversation engine", { kind: engineKind });
  const eng = engine;
  projects.setEngineHooks(
    eng
      ? {
          onClosing: () => eng.onProjectClosing(),
          onOpened: () => {
            eng.onProjectOpened();
          },
          conversationDefaults: (sel) => eng.conversationDefaults(sel),
        }
      : null,
  );
  return { engine, engineKind };
}

/** The model's 3D pictures: the tools contract's shot names are the scene rules' names. */
function renderWith(v: Pick<View3dService, "render3d">): NonNullable<EngineHost["render3d"]> {
  return (req, signal) =>
    v.render3d(
      {
        ...(req.shots ? { shots: [...req.shots] } : {}),
        ...(req.max !== undefined ? { max: req.max } : {}),
      },
      signal,
    );
}

function engineHost(d: EngineDeps): EngineHost {
  const { projects, settings, build, catalog, palettes, buildPalettes, imageBridge, secrets } = d;
  return {
    getProject: () => projects.getProject(),
    getPlan: (v) => (projects.isOpen ? projects.getPlan(v) : null),
    commitVersion: (i) => projects.commitVersion(i),
    moveHead: (v) => projects.moveHead(v),
    appendItems: (id, items, meta) => {
      projects.appendItems(id, items, meta);
    },
    updateConversation: (id, fn) => {
      projects.updateConversation(id, fn);
    },
    setBrief: (b) => {
      projects.setBrief(b);
    },
    setBusy: (t) => {
      if (projects.isOpen) projects.setBusy(t);
    },
    addSpend: (u, c) => {
      if (projects.isOpen) projects.addSpend(u, c);
      void settings.addSpend(u, c).catch(() => undefined);
    },
    emit: (e) => {
      d.emit("chat:event", e);
    },
    requestImage: (r, signal) => imageBridge.request(r, signal),
    ...(d.view3d ? { render3d: renderWith(d.view3d) } : {}),
    // ANTHROPIC_API_KEY from the environment: development builds only, never in smoke/e2e runs (§6.5).
    getApiKey: async (id) =>
      resolveApiKey(await secrets.getApiKey(id), id, {
        isDev: d.isDev,
        safeMode: d.safeMode,
        env: process.env,
      }),
    getSettings: () => settings.get(),
    estimateCompile: (plan, levels, signal) => build.estimate(plan, levels, signal),
    getAssetCatalog: () => catalog.current(),
    getPalettes: () => palettes.palettes(),
    getBuildPalettes: () => buildPalettes.current(),
    flush: () => projects.flush(),
    logger: d.logger.child("engine"),
  };
}
