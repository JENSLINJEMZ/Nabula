import { isProduction } from "./config.js";

type Level = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const MIN_LEVEL: Level = (process.env.LOG_LEVEL as Level) ?? (isProduction ? "info" : "debug");

/**
 * Values whose keys match this pattern are redacted before logging. This keeps
 * tokens, passwords and cookies out of log aggregation.
 */
const REDACT_KEY_RE = /(pass(word)?|token|secret|cookie|authorization|csrf|hash|salt|apikey|api_key)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY_RE.test(k) ? "[redacted]" : redact(v, depth + 1);
  }
  return out;
}

export interface LogContext {
  [key: string]: unknown;
}

function emit(level: Level, message: string, context?: LogContext): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...(context ? (redact(context) as Record<string, unknown>) : {}),
  };
  const line = JSON.stringify(entry);
  if (level === "error") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, context?: LogContext) => emit("debug", message, context),
  info: (message: string, context?: LogContext) => emit("info", message, context),
  warn: (message: string, context?: LogContext) => emit("warn", message, context),
  error: (message: string, context?: LogContext) => emit("error", message, context),
  child(bound: LogContext) {
    return {
      debug: (m: string, c?: LogContext) => emit("debug", m, { ...bound, ...c }),
      info: (m: string, c?: LogContext) => emit("info", m, { ...bound, ...c }),
      warn: (m: string, c?: LogContext) => emit("warn", m, { ...bound, ...c }),
      error: (m: string, c?: LogContext) => emit("error", m, { ...bound, ...c }),
    };
  },
};

export type Logger = typeof logger;
