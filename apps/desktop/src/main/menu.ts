import type { MenuItemConstructorOptions } from "electron";
import type { IpcEvents } from "../shared/ipc";

/**
 * Application menu template (emits menu:command to the renderer). Text-editing roles keep native
 * behaviour in inputs; map undo/redo are separate items so Ctrl+Z inside a text field never
 * rewinds the map by accident (the renderer owns the map shortcuts, UX §13.2).
 */
export type MenuCommand = IpcEvents["menu:command"]["command"];

export interface MenuActions {
  command(c: MenuCommand): void;
  openDataFolder(): void;
  openLogsFolder(): void;
  flush(): void;
  isDev: boolean;
  platform: NodeJS.Platform;
}

export function buildMenuTemplate(a: MenuActions): MenuItemConstructorOptions[] {
  const cmd = (c: MenuCommand) => () => {
    a.command(c);
  };
  const view: MenuItemConstructorOptions[] = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  if (a.isDev) view.push({ type: "separator" }, { role: "reload" }, { role: "toggleDevTools" });
  return [
    {
      label: "&File",
      submenu: [
        { label: "New map", accelerator: "CmdOrCtrl+N", click: cmd("new") },
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: cmd("open") },
        {
          label: "Save now",
          accelerator: "CmdOrCtrl+S",
          click: () => {
            a.flush();
            a.command("save");
          },
        },
        { label: "Save a copy as…", accelerator: "CmdOrCtrl+Shift+S", click: cmd("saveAs") },
        { label: "Export map as PNG…", accelerator: "CmdOrCtrl+E", click: cmd("export") },
        { type: "separator" },
        { label: "Settings…", accelerator: "CmdOrCtrl+,", click: cmd("settings") },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Undo map change", click: cmd("undo") },
        { label: "Redo map change", click: cmd("redo") },
      ],
    },
    { label: "&View", submenu: view },
    {
      label: "&Help",
      submenu: [
        {
          label: "Open data folder",
          click: () => {
            a.openDataFolder();
          },
        },
        {
          label: "Open logs folder",
          click: () => {
            a.openLogsFolder();
          },
        },
      ],
    },
  ];
}
