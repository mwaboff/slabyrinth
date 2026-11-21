import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Structured logging to userData/logs (architecture §6.4): JSON lines, rotating 5 × 1 MB.
 * Never logs API keys or prompts: every record passes through `redact`, which drops sensitive
 * keys (apiKey, text, prompt, slab, pngBase64…) and masks anything that looks like a key.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const SENSITIVE_KEYS = new Set([
  "apikey",
  "api_key",
  "key",
  "secret",
  "token",
  "authorization",
  "password",
  "text",
  "prompt",
  "systemprompt",
  "transcript",
  "items",
  "slab",
  "pngbase64",
  "database64",
  "thumbnailpng",
  "markdown",
]);

/** Key-shaped text: provider keys (sk-…), bearer tokens, and values written after an api-key label. */
const KEY_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/\b(sk-(?:[a-z]+-)?)[A-Za-z0-9_-]{8,}/g, "$1…[redacted]"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[redacted]"],
  [/\b((?:x-)?api[-_]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{12,}/gi, "$1[redacted]"],
];

/**
 * THE redaction of text that may carry a secret (log lines, provider error messages, anything forwarded to the
 * renderer). Every place that passes provider or error text on uses this one function.
 */
export function redactString(s: string): string {
  let out = s;
  for (const [pattern, mask] of KEY_PATTERNS) out = out.replace(pattern, mask);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    const masked = redactString(value);
    return masked.length > 2000 ? `${masked.slice(0, 2000)}…[${String(masked.length)} chars]` : masked;
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface FileLoggerOptions {
  dir: string;
  fileName?: string;
  maxBytes?: number;
  maxFiles?: number;
  minLevel?: LogLevel;
  /** Mirror to stderr (development). */
  echo?: boolean;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createFileLogger(options: FileLoggerOptions): Logger {
  const fileName = options.fileName ?? "main.log";
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxFiles = options.maxFiles ?? 5;
  const minLevel = ORDER[options.minLevel ?? "info"];
  const file = path.join(options.dir, fileName);
  let ready = false;
  let size = 0;

  const ensure = (): void => {
    if (ready) return;
    fs.mkdirSync(options.dir, { recursive: true });
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
    ready = true;
  };

  const rotate = (): void => {
    for (let i = maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? file : `${file}.${String(i - 1)}`;
      const to = `${file}.${String(i)}`;
      try {
        fs.renameSync(from, to);
      } catch {
        // missing generation: nothing to rotate
      }
    }
    size = 0;
  };

  const write = (level: LogLevel, scope: string, msg: string, data?: Record<string, unknown>): void => {
    if (ORDER[level] < minLevel) return;
    const record = {
      t: new Date().toISOString(),
      level,
      scope,
      msg: redactString(msg),
      ...(data ? { data: redact(data) } : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    try {
      ensure();
      if (size + line.length > maxBytes) rotate();
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // Logging must never take the app down.
    }
    if (options.echo === true) process.stderr.write(line);
  };

  const make = (scope: string): Logger => ({
    debug: (m, d) => {
      write("debug", scope, m, d);
    },
    info: (m, d) => {
      write("info", scope, m, d);
    },
    warn: (m, d) => {
      write("warn", scope, m, d);
    },
    error: (m, d) => {
      write("error", scope, m, d);
    },
    child: (s) => make(`${scope}.${s}`),
  });
  return make("main");
}

/** Logger that discards everything (tests). */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};

/** Logger that records into an array (tests). */
export function memoryLogger(): Logger & {
  records: Array<{ level: LogLevel; scope: string; msg: string; data?: unknown }>;
} {
  const records: Array<{ level: LogLevel; scope: string; msg: string; data?: unknown }> = [];
  const make = (scope: string): Logger => {
    const rec = (level: LogLevel) => (msg: string, data?: Record<string, unknown>) => {
      records.push(
        data
          ? { level, scope, msg: redactString(msg), data: redact(data) }
          : { level, scope, msg: redactString(msg) },
      );
    };
    return {
      debug: rec("debug"),
      info: rec("info"),
      warn: rec("warn"),
      error: rec("error"),
      child: (s) => make(`${scope}.${s}`),
    };
  };
  return Object.assign(make("main"), { records });
}
