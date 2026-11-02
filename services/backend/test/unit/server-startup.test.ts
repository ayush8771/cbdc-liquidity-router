import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { makeTempDir, validTokenFile } from "../helpers/devTokens.js";

// These start the real server entry point and check that it refuses to start.
// Every case fails before the port is opened, so none of them needs port 4000.

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DB_PASSWORD = "s3cret-db-password";
const CONFIG_VARS = ["NODE_ENV", "AUTH_MODE", "DATABASE_URL", "INFERENCE_URL", "INFERENCE_MODE", "INFERENCE_TIMEOUT_MS", "DEV_TOKENS_FILE"];

const tmp = makeTempDir();
const tokenFile = validTokenFile();
const tokenPath = tmp.write("dev-tokens.json", tokenFile);
after(() => tmp.cleanup());

function startServer(overrides: Record<string, string | undefined>): { status: number | null; output: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of CONFIG_VARS) delete env[name];
  Object.assign(env, {
    AUTH_MODE: "dev",
    DATABASE_URL: `postgresql://cbdc:${DB_PASSWORD}@localhost:5432/cbdc`,
    DEV_TOKENS_FILE: tokenPath,
  });
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: backendDir,
    env,
    encoding: "utf8",
    timeout: 30000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function assertRefused(result: { status: number | null; output: string }, expected: string): void {
  assert.equal(result.status, 1, `expected exit code 1; output:\n${result.output}`);
  assert.ok(result.output.includes("Failed to start backend. Invalid backend configuration:"), result.output);
  assert.ok(result.output.includes(expected), result.output);
  assert.ok(!result.output.includes("Backend listening"), result.output);
  assert.ok(!result.output.includes(DB_PASSWORD), "database password leaked");
  for (const user of tokenFile.users) {
    assert.ok(!result.output.includes(user.tokenSha256 as string), "token hash leaked");
  }
}

describe("server startup refusal", () => {
  it("refuses NODE_ENV=production", () => {
    assertRefused(startServer({ NODE_ENV: "production" }), "NODE_ENV=production is not allowed");
  });

  it("refuses a missing AUTH_MODE", () => {
    assertRefused(startServer({ AUTH_MODE: undefined }), 'AUTH_MODE is required and must be "dev"');
  });

  it("refuses AUTH_MODE other than dev", () => {
    assertRefused(startServer({ AUTH_MODE: "oidc" }), 'AUTH_MODE must be "dev"');
  });

  it("refuses a missing token file", () => {
    assertRefused(startServer({ DEV_TOKENS_FILE: path.join(tmp.dir, "missing.json") }), "token file not found");
  });

  it("refuses an empty token file", () => {
    assertRefused(startServer({ DEV_TOKENS_FILE: tmp.write("empty.json", "") }), "token file is empty");
  });

  it("refuses a malformed token file", () => {
    assertRefused(startServer({ DEV_TOKENS_FILE: tmp.write("bad.json", "{not json") }), "token file is not valid JSON");
  });

  it("refuses an invalid DATABASE_URL without printing it", () => {
    const result = startServer({ DATABASE_URL: `mysql://cbdc:${DB_PASSWORD}@localhost/cbdc` });
    assertRefused(result, "DATABASE_URL must be a postgresql:// or postgres:// URL");
  });
});
