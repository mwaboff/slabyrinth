import type { AppError } from "../../shared/ipc";

/** Throw inside services to produce a typed IPC error (`Result.ok === false`) with a user-safe message. */
export class AppFailure extends Error {
  readonly code: AppError["code"];
  readonly provider: AppError["provider"];

  constructor(code: AppError["code"], message: string, provider?: AppError["provider"]) {
    super(message);
    this.name = "AppFailure";
    this.code = code;
    this.provider = provider;
  }

  toAppError(): AppError {
    return this.provider === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, provider: this.provider };
  }
}

export const fail = (code: AppError["code"], message: string): never => {
  throw new AppFailure(code, message);
};

/** Maps anything thrown to an AppError. Unknown errors become "internal" without leaking details. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppFailure) return err.toAppError();
  if (isNodeError(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
    return { code: "not_found", message: "File or folder not found." };
  }
  if (isNodeError(err) && typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) {
    return { code: "io", message: `File system error (${err.code}).` };
  }
  return { code: "internal", message: "Something went wrong in Slabyrinth. Details are in the log." };
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
