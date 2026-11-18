/**
 * Provider-neutral error type thrown by ChatProvider methods (contract `ProviderError`).
 */
import type { ProviderError, ProviderErrorInfo, ProviderErrorKind } from "./types";

export class ProviderFailure extends Error implements ProviderError {
  readonly info: ProviderErrorInfo;
  constructor(info: ProviderErrorInfo) {
    super(info.message);
    this.name = "ProviderFailure";
    this.info = info;
  }
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  "rate_limit",
  "overloaded",
  "server",
  "network",
  "timeout",
]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export function providerError(
  kind: ProviderErrorKind,
  message: string,
  extra: Partial<ProviderErrorInfo> = {},
): ProviderFailure {
  return new ProviderFailure({ kind, retryable: isRetryableKind(kind), message, ...extra });
}

/** The ProviderErrorInfo carried by `err`, if it is a provider error (duck-typed so other providers' classes work). */
export function errorInfo(err: unknown): ProviderErrorInfo | null {
  if (typeof err !== "object" || err === null || !("info" in err)) return null;
  const info = err.info;
  if (typeof info !== "object" || info === null) return null;
  const i = info as Partial<ProviderErrorInfo>;
  return typeof i.kind === "string" && typeof i.message === "string" ? (info as ProviderErrorInfo) : null;
}
