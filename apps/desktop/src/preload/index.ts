import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { SlabyrinthApi } from "../shared/ipc";
import { EVENT_CHANNELS, REQUEST_CHANNELS, SEND_CHANNELS } from "../shared/channels";

/**
 * Preload (sandboxed, bundled to one CJS file). Exposes ONLY `window.slabyrinth`, typed by
 * shared/ipc.ts. Every call is checked against the contract's channel allowlists; ipcRenderer
 * itself, the IPC event object and the sender never reach the page.
 */
const requests = new Set<string>(REQUEST_CHANNELS);
const events = new Set<string>(EVENT_CHANNELS);
const sends = new Set<string>(SEND_CHANNELS);

const api: SlabyrinthApi = {
  invoke: (channel, req) => {
    if (typeof channel !== "string" || !requests.has(channel)) {
      return Promise.resolve({
        ok: false,
        error: { code: "unsupported", message: `Unknown IPC channel "${channel}"` },
      });
    }
    // Main always answers with Result<T>; it never throws across IPC.
    return ipcRenderer.invoke(channel, req) as ReturnType<SlabyrinthApi["invoke"]>;
  },
  on: (channel, listener) => {
    if (typeof channel !== "string" || !events.has(channel) || typeof listener !== "function") {
      return () => undefined;
    }
    const wrapped = (_event: IpcRendererEvent, payload: unknown): void => {
      (listener as (p: unknown) => void)(payload);
    };
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
  send: (channel, payload) => {
    if (typeof channel !== "string" || !sends.has(channel)) return;
    ipcRenderer.send(channel, payload);
  },
};

contextBridge.exposeInMainWorld("slabyrinth", Object.freeze(api));
