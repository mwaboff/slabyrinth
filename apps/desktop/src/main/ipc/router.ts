import type { z } from "zod";
import type { AppError, IpcRequests, IpcSends, Result } from "../../shared/ipc";
import { REQUEST_CHANNELS, SEND_CHANNELS } from "../../shared/channels";
import type { Logger } from "../logger";
import { EnginePortError } from "../ports/engine";
import { toAppError } from "../util/errors";

/**
 * IPC router (architecture §6.2 handler rules): every request is
 *   1. checked against the sender frame's URL (the app's own renderer only),
 *   2. validated with its Zod schema (strict; mismatches → "validation"),
 *   3. dispatched to exactly one typed handler, and
 *   4. answered with Result<T>; nothing is ever thrown across IPC.
 * There is no generic "invoke anything" channel: only contract channels are registered.
 */
export type Handler<C extends keyof IpcRequests> = (
  req: IpcRequests[C]["req"],
) => Promise<IpcRequests[C]["res"]> | IpcRequests[C]["res"];
export type Handlers = { [C in keyof IpcRequests]: Handler<C> };
export type SendHandlers = { [C in keyof IpcSends]: (payload: IpcSends[C]) => void };

export interface IpcEventLike {
  senderFrame?: { url: string } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => unknown): void;
  on(channel: string, listener: (event: IpcEventLike, ...args: unknown[]) => void): unknown;
  removeHandler?(channel: string): void;
}

export type SenderCheck = (url: string) => boolean;

function isProviderErrorLike(err: unknown): err is { info: NonNullable<AppError["provider"]> } {
  if (typeof err !== "object" || err === null || !("info" in err)) return false;
  const info = err.info;
  return (
    typeof info === "object" &&
    info !== null &&
    typeof (info as { kind?: unknown }).kind === "string" &&
    typeof (info as { message?: unknown }).message === "string"
  );
}

export function mapError(err: unknown): AppError {
  if (err instanceof EnginePortError) return err.error;
  if (isProviderErrorLike(err)) {
    return {
      code: err.info.kind === "auth" ? "no_api_key" : "provider",
      message: err.info.message,
      provider: err.info,
    };
  }
  return toAppError(err);
}

function describeZod(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const where = first.path.length > 0 ? ` at ${first.path.join(".")}` : "";
  return `Invalid request${where}: ${first.message}`;
}

export type Dispatch = (
  channel: string,
  senderUrl: string | undefined,
  payload: unknown,
) => Promise<Result<unknown>>;

export function createDispatcher(
  handlers: Handlers,
  schemas: { [C in keyof IpcRequests]: z.ZodType },
  isTrustedSender: SenderCheck,
  logger: Logger,
): Dispatch {
  const known = new Set<string>(REQUEST_CHANNELS);
  return async (channel, senderUrl, payload) => {
    if (!known.has(channel))
      return { ok: false, error: { code: "unsupported", message: "Unknown channel." } };
    if (senderUrl === undefined || !isTrustedSender(senderUrl)) {
      logger.warn("ipc request from untrusted sender rejected", { channel });
      return { ok: false, error: { code: "validation", message: "Request from an untrusted page." } };
    }
    const c = channel as keyof IpcRequests;
    const parsed = schemas[c].safeParse(payload);
    if (!parsed.success) {
      logger.info("ipc payload rejected", { channel, issues: parsed.error.issues.length });
      return { ok: false, error: { code: "validation", message: describeZod(parsed.error) } };
    }
    try {
      const handler = handlers[c] as (req: unknown) => unknown;
      const value: unknown = await handler(parsed.data ?? undefined);
      return { ok: true, value };
    } catch (err) {
      const error = mapError(err);
      if (error.code === "internal") logger.error("ipc handler failed", { channel, error: err });
      else logger.info("ipc handler refused", { channel, code: error.code });
      return { ok: false, error };
    }
  };
}

export function registerIpc(
  ipcMain: IpcMainLike,
  dispatch: Dispatch,
  sendHandlers: SendHandlers,
  sendSchemas: { [C in keyof IpcSends]: z.ZodType },
  isTrustedSender: SenderCheck,
  logger: Logger,
): void {
  for (const channel of REQUEST_CHANNELS) {
    ipcMain.handle(channel, (event, payload) => dispatch(channel, event.senderFrame?.url, payload));
  }
  for (const channel of SEND_CHANNELS) {
    ipcMain.on(channel, (event, payload) => {
      const url = event.senderFrame?.url;
      if (url === undefined || !isTrustedSender(url)) return;
      const parsed = sendSchemas[channel].safeParse(payload);
      if (!parsed.success) {
        logger.info("ipc send rejected", { channel });
        return;
      }
      try {
        sendHandlers[channel](parsed.data as IpcSends[typeof channel]);
      } catch (err) {
        logger.error("ipc send handler failed", { channel, error: err });
      }
    });
  }
}

/** Builds the sender check for the bundled renderer (file://…/index.html) or the dev server origin. */
export function makeSenderCheck(rendererUrl: string): SenderCheck {
  const target = new URL(rendererUrl);
  if (target.protocol === "file:") {
    const norm = (p: string): string =>
      process.platform === "win32" ? decodeURIComponent(p).toLowerCase() : decodeURIComponent(p);
    const expected = norm(target.pathname);
    return (url) => {
      try {
        const u = new URL(url);
        return u.protocol === "file:" && norm(u.pathname) === expected;
      } catch {
        return false;
      }
    };
  }
  return (url) => {
    try {
      return new URL(url).origin === target.origin;
    } catch {
      return false;
    }
  };
}
