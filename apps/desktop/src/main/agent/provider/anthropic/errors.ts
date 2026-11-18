/**
 * Anthropic SDK errors → ProviderErrorInfo (architecture §3.10 "Errors"). The chain is most-specific-first, as the
 * claude-api skill requires: subclasses are tested before their bases (OverloadedError before InternalServerError,
 * APIConnectionTimeoutError before APIConnectionError, every APIError subclass before APIError).
 * Messages shown to the user never contain the key; the API's own message is kept for "Details".
 */
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  AnthropicError,
  AuthenticationError,
  BadRequestError,
  ContentTooLargeError,
  InternalServerError,
  NotFoundError,
  OverloadedError,
  PaymentRequiredError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { redactString } from "../../../logger";
import { ProviderFailure } from "../errors";
import type { ProviderErrorInfo, ProviderErrorKind } from "../types";

/** The SDK's error for tool input JSON it could not parse at all (eager input streaming). Not an APIError. */
export function isToolJsonParseError(err: unknown): boolean {
  return (
    err instanceof AnthropicError &&
    !(err instanceof APIError) &&
    /Unable to parse tool parameter JSON/i.test(err.message)
  );
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const v = headers?.get("retry-after");
  if (v === null || v === undefined) return undefined;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(v);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function info(
  kind: ProviderErrorKind,
  retryable: boolean,
  message: string,
  err?: APIError,
): ProviderErrorInfo {
  // Messages can embed text from the API or the network stack: mask anything key-shaped before it can reach the UI.
  const i: ProviderErrorInfo = { kind, retryable, message: redactString(message) };
  if (err) {
    if (typeof err.status === "number") i.httpStatus = err.status;
    if (err.requestID) i.requestId = err.requestID;
  }
  return i;
}

const PROMPT_TOO_LONG =
  /prompt is too long|context (window|length)|too many (input )?tokens|exceeds the (maximum )?context/i;

export function mapAnthropicError(err: unknown, aborted = false): ProviderErrorInfo {
  if (aborted || err instanceof APIUserAbortError) return info("cancelled", false, "Stopped.");
  if (err instanceof AuthenticationError) return info("auth", false, "Your API key was rejected.", err);
  if (err instanceof PaymentRequiredError) {
    return info(
      "permission",
      false,
      "Your Anthropic account can't make requests right now. This usually means credit has run out.",
      err,
    );
  }
  if (err instanceof PermissionDeniedError)
    return info(
      "permission",
      false,
      `This key can't use that model or feature. ${err.apiMessage ?? ""}`.trim(),
      err,
    );
  if (err instanceof NotFoundError)
    return info(
      "not_found",
      false,
      `The model isn't available on this key. ${err.apiMessage ?? ""}`.trim(),
      err,
    );
  if (err instanceof RateLimitError) {
    const i = info("rate_limit", true, "Anthropic is busy (rate limited).", err);
    const after = retryAfterMs(err.headers);
    if (after !== undefined) i.retryAfterMs = after;
    return i;
  }
  if (err instanceof OverloadedError) return info("overloaded", true, "Anthropic is overloaded.", err);
  if (err instanceof InternalServerError) {
    if (err.status === 529) return info("overloaded", true, "Anthropic is overloaded.", err);
    return info("server", true, "Anthropic had a server error.", err);
  }
  if (err instanceof ContentTooLargeError)
    return info("context_overflow", false, "The conversation is too large for this model.", err);
  if (err instanceof BadRequestError) {
    const msg = err.apiMessage ?? err.message;
    if (PROMPT_TOO_LONG.test(msg))
      return info("context_overflow", false, "The conversation is too large for this model.", err);
    return info("invalid_request", false, `The request was rejected: ${msg}`, err);
  }
  if (err instanceof APIConnectionTimeoutError) return info("timeout", true, "The request timed out.");
  if (err instanceof APIConnectionError) return info("network", true, "Connection lost.");
  if (isStatuslessApiError(err)) return mapStreamError(err);
  if (err instanceof APIError) {
    const status = typeof err.status === "number" ? err.status : 0;
    if (status === 529) return info("overloaded", true, "Anthropic is overloaded.", err);
    if (status >= 500) return info("server", true, "Anthropic had a server error.", err);
    return info("invalid_request", false, `The request was rejected: ${err.apiMessage ?? err.message}`, err);
  }
  if (isToolJsonParseError(err))
    return info("malformed_output", false, "The model sent tool input that could not be parsed.");
  if (err instanceof Error && err.name === "AbortError") return info("cancelled", false, "Stopped.");
  return info("network", true, err instanceof Error ? err.message : "Unknown error.");
}

/** The API error type of an SDK error: `err.type`, else the body's `error.type`. */
function errorTypeOf(err: APIError): string | null {
  if (typeof err.type === "string") return err.type;
  const body = err.error as { error?: { type?: unknown }; type?: unknown } | undefined;
  const t = body?.error?.type ?? body?.type;
  return typeof t === "string" && t !== "error" ? t : null;
}

/**
 * An error delivered as an SSE `error` event mid-stream: the SDK raises a plain APIError with no HTTP status.
 * Map on the API error type; anything unknown is treated as a dropped connection (retryable, within the cap).
 */
function mapStreamError(err: APIError): ProviderErrorInfo {
  const msg = err.apiMessage ?? err.message;
  switch (errorTypeOf(err)) {
    case "overloaded_error":
      return info("overloaded", true, "Anthropic is overloaded.", err);
    case "rate_limit_error":
      return info("rate_limit", true, "Anthropic is busy (rate limited).", err);
    case "api_error":
    case "timeout_error":
      return info("server", true, "Anthropic had a server error.", err);
    case "authentication_error":
      return info("auth", false, "Your API key was rejected.", err);
    case "billing_error":
      return info(
        "permission",
        false,
        "Your Anthropic account can't make requests right now. This usually means credit has run out.",
        err,
      );
    case "permission_error":
      return info("permission", false, `This key can't use that model or feature. ${msg}`.trim(), err);
    case "not_found_error":
      return info("not_found", false, `The model isn't available on this key. ${msg}`.trim(), err);
    case "invalid_request_error":
      return PROMPT_TOO_LONG.test(msg)
        ? info("context_overflow", false, "The conversation is too large for this model.", err)
        : info("invalid_request", false, `The request was rejected: ${msg}`, err);
    default:
      return info("network", true, "The connection dropped while the reply was streaming.", err);
  }
}

export function toProviderFailure(err: unknown, aborted = false): ProviderFailure {
  return new ProviderFailure(mapAnthropicError(err, aborted));
}

/** An APIError with no HTTP status: what the SDK raises for an SSE `error` event mid-stream. */
function isStatuslessApiError(err: unknown): err is APIError {
  return err instanceof APIError && typeof err.status !== "number";
}
