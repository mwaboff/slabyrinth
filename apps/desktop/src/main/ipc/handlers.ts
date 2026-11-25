import type { IpcRequests } from "../../shared/ipc";
import { isAllowedExternalUrl } from "../externalUrls";
import type { Logger } from "../logger";
import type { ConversationEngine } from "../ports/engine";
import type { BuildPalettes } from "../services/buildPalettes";
import type { BuildService } from "../services/buildService";
import type { ClipboardService } from "../services/clipboardService";
import type { Dialogs } from "../services/dialogs";
import type { ExportService } from "../services/exportService";
import type { PaletteService } from "../services/paletteService";
import type { ProjectService } from "../services/projectService";
import type { SecretStore } from "../services/secretStore";
import type { SettingsStore } from "../services/settingsStore";
import type { CatalogService } from "../services/talespire/catalogService";
import type { TaleSpireLinkService } from "../services/talespire/link/linkService";
import type { TaleSpireService } from "../services/talespire/taleSpireService";
import type { UpdateService } from "../services/updateService";
import { AppFailure } from "../util/errors";
import { checkLocalPath, pathKey } from "../util/safePath";
import type { Handlers } from "./router";
import { view3dHandlers, type MeshesApi, type View3dApi } from "./view3dHandlers";

/** The services the IPC handlers delegate to (composition root: main/app.ts). */
export interface HandlerServices {
  appInfo: IpcRequests["app:getInfo"]["res"];
  settings: SettingsStore;
  secrets: SecretStore;
  projects: ProjectService;
  engine: () => ConversationEngine | null;
  catalog: CatalogService;
  talespire: TaleSpireService;
  clipboard: ClipboardService;
  build: BuildService;
  exporter: ExportService;
  palettes: PaletteService;
  /** The palettes builds compile with, which the 2D preview resolves against too. */
  buildPalettes: Pick<BuildPalettes, "data">;
  /** Native dialogs (inert in smoke/e2e runs). */
  dialogs: Dialogs;
  openExternal: (url: string) => Promise<void>;
  /** Update notice (status, manual check, skip). */
  updates: Pick<UpdateService, "status" | "check" | "skip">;
  /** The TaleSpire add-on and its link. */
  link: Pick<
    TaleSpireLinkService,
    | "addonStatus"
    | "install"
    | "chooseFolder"
    | "uninstall"
    | "openFolder"
    | "dismissPrompt"
    | "linkStatus"
    | "send"
    | "stop"
  >;
  /** The 3D view's scenes (the scene worker) and the 3D piece cache. */
  view3d: View3dApi;
  meshes: MeshesApi;
  logger: Logger;
}

export function createHandlers(s: HandlerServices): Handlers {
  const engine = (): ConversationEngine => {
    const e = s.engine();
    if (!e) throw new AppFailure("internal", "Chat couldn't start. Details are in the log.");
    return e;
  };
  const requireProject = (): void => {
    if (!s.projects.isOpen) throw new AppFailure("no_project", "No map is open.");
  };
  /**
   * Folders the renderer may hand back (talespire:setPath, settings projects.folder): only ones main
   * produced — a native folder pick (dialog:pickFolder), a talespire:locate result, or the current
   * setting — and only as absolute, local, normalised paths.
   */
  const grantedFolders = new Set<string>();
  const grantFolder = (p: string): string => {
    grantedFolders.add(pathKey(p));
    return p;
  };
  const acceptFolder = (raw: string, current: string | null): string => {
    const p = checkLocalPath(raw);
    const key = pathKey(p);
    if (!grantedFolders.has(key) && (current === null || pathKey(current) !== key)) {
      throw new AppFailure("validation", "Choose the folder with the folder picker.");
    }
    return p;
  };
  /** Copy tracking: never fails the copy itself (the build may have been replaced meanwhile). */
  const markCopied = (chunk: { buildId: string; chunkId: string } | undefined): void => {
    if (!chunk || !s.projects.isOpen) return;
    if (!s.projects.markCopied(chunk.buildId, chunk.chunkId))
      s.logger.info("copied chunk not in the open project's builds");
  };

  return {
    "app:getInfo": () => s.appInfo,
    "settings:get": () => s.settings.get(),
    "settings:update": async (req) => {
      const folder = req.projects?.folder;
      if (folder !== undefined) acceptFolder(folder, s.settings.get().projects.folder);
      return s.settings.update(req);
    },

    "secrets:setApiKey": async (req) => {
      const res = await s.secrets.setApiKey(req.providerId, req.apiKey, req.storage ?? "auto");
      if (req.verify !== true) return res;
      // One flow in main: store, check with the provider, and drop a key the provider rejects as unauthorized.
      // A network or other failure keeps the key (it may well be fine); the UI says it couldn't be checked.
      let check: IpcRequests["providers:check"]["res"];
      try {
        check = await engine().checkProvider(req.providerId);
      } catch {
        check = {
          ok: false,
          error: { kind: "network", retryable: true, message: "Couldn't check the key." },
        };
      }
      // only the provider itself rejecting the key (HTTP 401) removes it
      if (!check.ok && check.error.kind === "auth" && check.error.httpStatus === 401) {
        await s.secrets.clearApiKey(req.providerId);
        s.logger.info("api key rejected by the provider; removed", { providerId: req.providerId });
        return { stored: false, backend: res.backend, check };
      }
      return { ...res, check };
    },
    "secrets:storeWeak": (req) => s.secrets.storeWeak(req.providerId),
    "secrets:clearApiKey": (req) => s.secrets.clearApiKey(req.providerId),
    "secrets:status": () => s.secrets.status(),

    "providers:list": () => engine().listProviders(),
    "providers:check": (req) => engine().checkProvider(req.providerId),
    "models:list": (req) => engine().listModels(req.providerId, req.refresh === true),

    "project:new": async (req) => s.projects.handedToRenderer(await s.projects.create(req)),
    "project:open": async (req) => s.projects.handedToRenderer(await s.projects.open(req)),
    "project:saveCopyAs": () => s.projects.saveCopyAs(),
    "project:rename": (req) => s.projects.rename(req.name),
    "project:duplicate": (req) => s.projects.duplicate(req.path),
    "project:trash": (req) => s.projects.trash(req.path),
    "project:revealInFolder": (req) => {
      s.projects.revealInFolder(req.path);
    },
    "project:close": (req) => s.projects.close(req),
    "project:snapshot": () => s.projects.handedToRenderer(s.projects.snapshot()),
    "project:setUiState": (req) => {
      s.projects.setUiStateFromRenderer(req);
    },
    "project:list": () => s.projects.list(),
    "project:importPlan": async () => s.projects.handedToRenderer(await s.projects.importPlan()),
    "project:exportPlan": () => s.projects.exportPlan(),

    "plan:applyOps": (req) => s.projects.applyOps(req),
    "plan:undo": () => s.projects.undo(),
    "plan:redo": () => s.projects.redo(),
    "plan:restore": (req) => s.projects.restore(req.version),
    "plan:getVersion": (req) => s.projects.getVersion(req.version),
    "plan:diff": (req) => s.projects.diff(req.from, req.to),
    "plan:approve": (req) => s.projects.approve(req.version),
    "plan:editText": (req) => s.projects.editText(req),
    "brief:update": (req) => s.projects.updateBrief(req.set),

    "chat:send": (req) => {
      requireProject();
      return engine().send(req);
    },
    "chat:estimate": (req) => engine().estimate(req),
    "chat:cancel": (req) => engine().cancel(req.turnId),
    "chat:retry": (req) => {
      requireProject();
      return engine().retry(req);
    },
    "chat:selectAlternative": (req) => engine().selectAlternative(req),
    "chat:continue": (req) => {
      requireProject();
      return engine().continue(req ?? {});
    },
    "chat:previewSwitch": (req) => engine().previewSwitch(req.selection),
    "chat:setSelection": (req) => engine().setSelection(req.selection),
    "chat:setEffort": (req) => engine().setEffort(req.effort),
    "chat:newConversation": (req) => {
      engine();
      return s.projects.newConversation(req.selection);
    },

    "compile:estimate": (req) => s.build.estimateOpen(req.levels),
    "compile:run": (req) => s.build.run(req),
    "compile:cancel": () => {
      s.build.cancel();
    },
    "build:setPasted": (req) => {
      s.projects.setPasted(req.buildId, req.chunkId, req.pasted);
    },
    "build:saveChunk": (req) => s.build.saveChunk(req.buildId, req.chunkId),

    "export:savePng": (req) => s.exporter.savePng(req),
    "export:roomKeyMarkdown": (req) => s.exporter.roomKeyMarkdown(req),

    "clipboard:writeText": (req) => {
      s.clipboard.writeText(req.text);
      markCopied(req.chunk);
    },

    "dialog:pickFolder": async (req) => {
      const settings = s.settings.get();
      const current = req.purpose === "talespire" ? settings.talespire.installPath : settings.projects.folder;
      const picked = await s.dialogs.chooseFolder({
        title:
          req.purpose === "talespire" ? "Locate the TaleSpire folder" : "Choose the folder for your maps",
        ...(current ? { defaultPath: current } : {}),
      });
      if (picked === null) return null;
      grantFolder(picked);
      if (req.purpose === "talespire") return s.talespire.checkInstall(picked);
      return { path: picked, valid: true as const };
    },
    "talespire:locate": async () => {
      const r = await s.talespire.locate(true);
      for (const f of r.found) grantFolder(f.path);
      return r;
    },
    "talespire:setPath": async (req) => {
      const dir = req.path === null ? null : acceptFolder(req.path, s.settings.get().talespire.installPath);
      const r = await s.talespire.setPath(dir);
      if (r.valid) {
        void s.catalog
          .refresh(false)
          .then(() => s.catalog.watch())
          .catch(() => undefined);
      }
      return r;
    },
    "catalog:status": () => s.catalog.status(),
    "catalog:refresh": (req) => s.catalog.refresh(req.force === true),
    "talespire:copyAndOpen": async (req) => {
      const r = await s.talespire.copyAndOpen(req.text);
      if (r.copied) markCopied(req.chunk);
      return r;
    },
    "talespire:isRunning": async () => ({ running: (await s.talespire.isRunning()).running }),
    "talespire:openUrl": (req) => s.talespire.openUrl(req.url),

    "palettes:list": () => s.palettes.list(),
    "palettes:reload": () => s.palettes.load(),
    "palettes:openFolder": () => s.palettes.openFolder(),
    "palettes:resolveData": () => s.buildPalettes.data(),

    "shell:openExternal": async (req) => {
      if (!isAllowedExternalUrl(req.url)) {
        s.logger.info("external url refused");
        return { opened: false };
      }
      await s.openExternal(req.url);
      return { opened: true };
    },

    "updates:status": () => s.updates.status(),
    "updates:check": (req) => s.updates.check(req),
    "updates:skip": (req) => s.updates.skip(req.version),

    "addon:status": () => s.link.addonStatus(),
    "addon:install": () => s.link.install(),
    "addon:chooseFolder": (req) => s.link.chooseFolder(req.reset === true),
    "addon:uninstall": (req) => s.link.uninstall(req.elsewhere === true),
    "addon:openFolder": (req) => s.link.openFolder(req.which),
    "addon:dismissPrompt": (req) => s.link.dismissPrompt(req.version),
    "link:status": () => s.link.linkStatus(),
    "link:send": (req) => {
      requireProject();
      return s.link.send(req.buildId);
    },
    "link:stop": () => {
      s.link.stop();
    },
    ...view3dHandlers(s),
  };
}
