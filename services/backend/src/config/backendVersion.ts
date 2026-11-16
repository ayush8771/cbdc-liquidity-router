import { readFileSync } from "node:fs";

// The backend's version for GET /api/v1/meta (API contract §3.9): the
// "version" field of services/backend/package.json. The path resolves the same
// from src/config (tsx) and dist/config (built).
export const BACKEND_VERSION: string = readBackendVersion();

function readBackendVersion(): string {
  const parsed = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error("services/backend/package.json has no version");
  }
  return parsed.version;
}
