/**
 * The 3D view's services: the piece cache (MeshService, its reader in mesh.worker) and the scenes (View3dService,
 * scene.worker). Both workers are bundled next to the main entry (electron.vite.config.ts).
 */
import { Worker } from "node:worker_threads";
import { agentSettings } from "../../shared/agentSettings";
import type { Logger } from "../logger";
import type { AppPaths } from "../paths";
import type { EmitEvent } from "../services/events";
import { MeshService } from "../services/meshes/meshService";
import type { PaletteService } from "../services/paletteService";
import type { ProjectService } from "../services/projectService";
import type { SettingsStore } from "../services/settingsStore";
import type { CatalogService } from "../services/talespire/catalogService";
import type { TaleSpireService } from "../services/talespire/taleSpireService";
import { View3dService } from "../services/view3d/view3dService";

/** The scene worker's heap: a huge map's scene of boxes stays well under it (design §2.7). */
export const SCENE_HEAP_MB = 3072;
/** The mesh reader's heap: one bundle unpacked at a time (~100 MB peak, design §0). */
export const MESH_HEAP_MB = 1024;

export interface View3dWiring {
  meshes: MeshService;
  view3d: View3dService;
}

export function startView3d(d: {
  paths: AppPaths;
  settings: SettingsStore;
  projects: ProjectService;
  palettes: PaletteService;
  catalog: CatalogService;
  talespire: TaleSpireService;
  emit: EmitEvent;
  logger: Logger;
}): View3dWiring {
  const sceneUrl = new URL("./scene.worker.js", import.meta.url);
  const meshUrl = new URL("./mesh.worker.js", import.meta.url);
  const meshes = new MeshService({
    cacheDir: d.paths.meshesDir,
    installPath: () => d.talespire.resolveInstall(),
    enabled: () => agentSettings(d.settings.get()).view3d,
    spawn: () => new Worker(meshUrl, { resourceLimits: { maxOldGenerationSizeMb: MESH_HEAP_MB } }),
    emit: d.emit,
    logger: d.logger.child("meshes"),
  });
  const view3d = new View3dService({
    spawn: () => new Worker(sceneUrl, { resourceLimits: { maxOldGenerationSizeMb: SCENE_HEAP_MB } }),
    projects: d.projects,
    inputs: () => {
      const { userPalettes, orientationOverride } = d.palettes.compileInputs();
      return { userPalettes, orientationOverride, catalog: d.catalog.current() };
    },
    meshes,
    emit: d.emit,
    logger: d.logger.child("view3d"),
  });
  return { meshes, view3d };
}
