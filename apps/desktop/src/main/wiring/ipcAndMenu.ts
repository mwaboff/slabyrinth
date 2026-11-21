/** The IPC router (requests and sends, trusted only from the attached renderer) and the application menu. */
import { ipcMain, Menu, shell } from "electron";
import type { IpcEvents } from "../../shared/ipc";
import { createDispatcher, registerIpc, type Dispatch } from "../ipc/router";
import { createHandlers, type HandlerServices } from "../ipc/handlers";
import { requestSchemas, sendSchemas } from "../ipc/schemas";
import type { Logger } from "../logger";
import { buildMenuTemplate } from "../menu";
import type { AppPaths } from "../paths";
import type { EmitEvent } from "../services/events";
import type { ImageBridge } from "../services/imageBridge";
import type { ProjectService } from "../services/projectService";

/** Registers the IPC handlers and returns the dispatcher. */
export function wireIpc(
  services: HandlerServices,
  imageBridge: ImageBridge,
  isTrusted: (url: string) => boolean,
  logger: Logger,
): Dispatch {
  const handlers = createHandlers(services);
  const dispatch = createDispatcher(handlers, requestSchemas, isTrusted, logger);
  registerIpc(
    ipcMain,
    dispatch,
    {
      "render:imageResult": (r) => {
        imageBridge.handleResult(r);
      },
    },
    sendSchemas,
    isTrusted,
    logger,
  );
  return dispatch;
}

/** The application menu: commands go to the renderer as "menu:command" events. */
export function installMenu(d: {
  emit: EmitEvent;
  projects: ProjectService;
  paths: AppPaths;
  isDev: boolean;
}): void {
  const menuCommand = (command: IpcEvents["menu:command"]["command"]): void => {
    d.emit("menu:command", { command });
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      buildMenuTemplate({
        command: menuCommand,
        flush: () => {
          void d.projects.flush().catch(() => undefined);
        },
        openDataFolder: () => {
          void shell.openPath(d.paths.userData);
        },
        openLogsFolder: () => {
          void shell.openPath(d.paths.logs);
        },
        isDev: d.isDev,
        platform: process.platform,
      }),
    ),
  );
}
