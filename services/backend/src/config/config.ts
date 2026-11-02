import path from "node:path";
import { readDevTokensFile, type DevUser } from "./devTokens.js";

// Centralised backend configuration (API contract §8). loadConfig() validates
// every variable and reports all problems at once. Problem messages never
// include a variable's value: DATABASE_URL carries credentials, and the token
// file carries token hashes.

export type InferenceMode = "live" | "mock";

export interface Config {
  // Optional until PostgreSQL connectivity is implemented; validated whenever it
  // is set. Prisma's command-line tools read DATABASE_URL on their own.
  databaseUrl: string | undefined;
  inference: {
    url: string;
    mode: InferenceMode;
    timeoutMs: number;
  };
  auth: {
    mode: "dev";
    devTokensFile: string;
    users: readonly DevUser[];
  };
}

export const DEFAULTS = {
  inferenceUrl: "http://inference:8000",
  inferenceMode: "live",
  inferenceTimeoutMs: 15000,
  devTokensFile: "./dev-tokens.json",
} as const;

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid backend configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * The absolute path of the development token file: DEV_TOKENS_FILE (blank
 * counts as unset) or the default, resolved against cwd. Shared with the seed.
 */
export function resolveDevTokensFile(env: NodeJS.ProcessEnv, cwd: string = process.cwd()): string {
  const value = env.DEV_TOKENS_FILE?.trim();
  return path.resolve(cwd, value ? value : DEFAULTS.devTokensFile);
}

export function loadConfig(env: NodeJS.ProcessEnv, options: { cwd?: string } = {}): Config {
  const cwd = options.cwd ?? process.cwd();
  const problems: string[] = [];
  // Empty or blank values count as unset.
  const read = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value ? value : undefined;
  };

  // Development-only authentication (arch §8.1).
  if (read("NODE_ENV")?.toLowerCase() === "production") {
    problems.push(
      "NODE_ENV=production is not allowed: Phase 2 authentication is development-only (arch §8.1)",
    );
  }
  const authMode = read("AUTH_MODE");
  if (authMode === undefined) {
    problems.push('AUTH_MODE is required and must be "dev"');
  } else if (authMode !== "dev") {
    problems.push('AUTH_MODE must be "dev"; no other authentication mode is supported in Phase 2');
  }

  const databaseUrl = read("DATABASE_URL");
  if (databaseUrl !== undefined && !isPostgresUrl(databaseUrl)) {
    problems.push("DATABASE_URL must be a postgresql:// or postgres:// URL with a host");
  }

  const inferenceUrl = read("INFERENCE_URL") ?? DEFAULTS.inferenceUrl;
  const inferenceUrlProblem = checkInferenceUrl(inferenceUrl);
  if (inferenceUrlProblem) problems.push(inferenceUrlProblem);

  const inferenceMode = read("INFERENCE_MODE") ?? DEFAULTS.inferenceMode;
  if (inferenceMode !== "live" && inferenceMode !== "mock") {
    problems.push('INFERENCE_MODE must be "live" or "mock"');
  }

  const timeoutRaw = read("INFERENCE_TIMEOUT_MS");
  const timeoutMs = timeoutRaw === undefined ? DEFAULTS.inferenceTimeoutMs : Number(timeoutRaw);
  if (timeoutRaw !== undefined && !(/^\d+$/.test(timeoutRaw) && Number.isSafeInteger(timeoutMs) && timeoutMs > 0)) {
    problems.push("INFERENCE_TIMEOUT_MS must be a positive whole number of milliseconds");
  }

  const devTokensFile = resolveDevTokensFile(env, cwd);
  const tokens = readDevTokensFile(devTokensFile);
  problems.push(...tokens.problems.map((p) => `DEV_TOKENS_FILE: ${p}`));

  if (problems.length > 0) throw new ConfigError(problems);

  return deepFreeze({
    databaseUrl,
    inference: {
      url: inferenceUrl.replace(/\/+$/, ""),
      mode: inferenceMode as InferenceMode,
      timeoutMs,
    },
    auth: {
      mode: "dev" as const,
      devTokensFile,
      users: tokens.users,
    },
  });
}

function isPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "postgresql:" || url.protocol === "postgres:") && url.hostname !== "";
  } catch {
    return false;
  }
}

function checkInferenceUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "INFERENCE_URL must be a valid http:// or https:// URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "INFERENCE_URL must be a valid http:// or https:// URL";
  }
  if (url.username || url.password) {
    return "INFERENCE_URL must not contain credentials; the inference service has no auth";
  }
  if (url.search || url.hash) {
    return "INFERENCE_URL must be a base URL without a query string or fragment";
  }
  return undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
