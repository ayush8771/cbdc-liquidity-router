// Minimal JSON-lines logger. Every field passes through redact(), so an
// Authorization header, a token or a token hash is never written out
// (arch §8.2: "Request logging redacts Authorization").

export type LogLevel = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;
export type LogWriter = (line: string, level: LogLevel) => void;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const REDACTED = "[REDACTED]";
// Compared case-insensitively.
const SECRET_KEYS = new Set(["authorization", "token", "tokensha256"]);

export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value !== "object" || value === null) return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = SECRET_KEYS.has(key.toLowerCase()) ? REDACTED : redact(child, seen);
  }
  return result;
}

const writeToConsole: LogWriter = (line, level) => {
  (level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
};

export function createLogger(write: LogWriter = writeToConsole): Logger {
  const log = (level: LogLevel, message: string, fields: LogFields = {}) => {
    const entry = { time: new Date().toISOString(), level, msg: message, ...(redact(fields) as LogFields) };
    write(JSON.stringify(entry), level);
  };
  return {
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
  };
}
