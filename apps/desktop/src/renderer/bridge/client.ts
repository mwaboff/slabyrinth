/**
 * The renderer's only door to main: `window.slabyrinth` as typed by shared/ipc.ts.
 * When the preload bridge is absent (plain browser, Vite dev server, tests) or `?fake` is in the URL,
 * app/boot.ts installs the fake bridge (bridge/fake) behind the very same interface.
 */
import type { AppError, IpcEvents, IpcRequests, IpcSends, Result, SlabyrinthApi } from "../../shared/ipc";

export type Req<C extends keyof IpcRequests> = IpcRequests[C]["req"];
export type Res<C extends keyof IpcRequests> = IpcRequests[C]["res"];

export class BridgeError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = "BridgeError";
    this.appError = appError;
  }
}

let current: SlabyrinthApi | null = null;

export function setBridge(api: SlabyrinthApi): void {
  current = api;
}

export function hasBridge(): boolean {
  return current !== null;
}

export function bridge(): SlabyrinthApi {
  if (current === null) throw new Error("Bridge not installed (boot.ts runs before the app renders).");
  return current;
}

/** invoke and unwrap: resolves with the value, rejects with BridgeError. */
export async function call<C extends keyof IpcRequests>(channel: C, req: Req<C>): Promise<Res<C>> {
  const r: Result<Res<C>> = await bridge().invoke(channel, req);
  if (r.ok) return r.value;
  throw new BridgeError(r.error);
}

/** invoke without throwing. */
export function tryCall<C extends keyof IpcRequests>(channel: C, req: Req<C>): Promise<Result<Res<C>>> {
  return bridge().invoke(channel, req);
}

export function on<C extends keyof IpcEvents>(
  channel: C,
  listener: (payload: IpcEvents[C]) => void,
): () => void {
  return bridge().on(channel, listener);
}

export function send<C extends keyof IpcSends>(channel: C, payload: IpcSends[C]): void {
  bridge().send(channel, payload);
}

export function errorMessage(e: unknown): string {
  if (e instanceof BridgeError) return e.appError.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
