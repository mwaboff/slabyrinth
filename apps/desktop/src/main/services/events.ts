import type { IpcEvents } from "../../shared/ipc";

/** Main → renderer event sink (webContents.send on the app window; a recorder in tests). */
export type EmitEvent = <C extends keyof IpcEvents>(channel: C, payload: IpcEvents[C]) => void;

export function recordingEmitter(): EmitEvent & {
  events: Array<{ channel: keyof IpcEvents; payload: unknown }>;
} {
  const events: Array<{ channel: keyof IpcEvents; payload: unknown }> = [];
  const fn = ((channel, payload) => {
    events.push({ channel, payload });
  }) as EmitEvent;
  return Object.assign(fn, { events });
}
