import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { ConfigError, DEFAULTS, loadConfig, resolveDevTokensFile } from "../../src/config/config.js";
import { makeTempDir, validTokenFile } from "../helpers/devTokens.js";

const DB_PASSWORD = "s3cret-db-password";
const tmp = makeTempDir();
const tokenFile = validTokenFile();
const tokenPath = tmp.write("dev-tokens.json", tokenFile);
after(() => tmp.cleanup());

function validEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    AUTH_MODE: "dev",
    DATABASE_URL: `postgresql://cbdc:${DB_PASSWORD}@localhost:5432/cbdc`,
    DEV_TOKENS_FILE: tokenPath,
    ...overrides,
  };
}

function problemsFor(env: NodeJS.ProcessEnv, cwd?: string): readonly string[] {
  try {
    loadConfig(env, { cwd });
  } catch (error) {
    assert.ok(error instanceof ConfigError, `expected ConfigError, got ${String(error)}`);
    return error.problems;
  }
  assert.fail("expected loadConfig to throw ConfigError");
}

describe("loadConfig: valid configurations", () => {
  it("applies the documented defaults (API contract §8)", () => {
    const config = loadConfig(validEnv());
    assert.equal(config.inference.url, DEFAULTS.inferenceUrl);
    assert.equal(config.inference.url, "http://inference:8000");
    assert.equal(config.inference.mode, "live");
    assert.equal(config.inference.timeoutMs, 15000);
    assert.equal(config.auth.mode, "dev");
    assert.equal(config.auth.devTokensFile, tokenPath);
    assert.equal(config.auth.users.length, 2);
    assert.equal(config.databaseUrl, validEnv().DATABASE_URL);
  });

  it("accepts every variable overridden", () => {
    const config = loadConfig(
      validEnv({
        INFERENCE_URL: "http://127.0.0.1:8000/",
        INFERENCE_MODE: "mock",
        INFERENCE_TIMEOUT_MS: "20000",
        DATABASE_URL: "postgres://localhost/cbdc",
      }),
    );
    assert.equal(config.inference.url, "http://127.0.0.1:8000", "trailing slash removed");
    assert.equal(config.inference.mode, "mock");
    assert.equal(config.inference.timeoutMs, 20000);
    assert.equal(config.databaseUrl, "postgres://localhost/cbdc");
  });

  for (const nodeEnv of [undefined, "", "development", "test"]) {
    it(`allows NODE_ENV=${JSON.stringify(nodeEnv)}`, () => {
      assert.doesNotThrow(() => loadConfig(validEnv({ NODE_ENV: nodeEnv })));
    });
  }

  it("treats blank optional values as unset and trims whitespace", () => {
    const config = loadConfig(validEnv({ INFERENCE_MODE: "  ", INFERENCE_TIMEOUT_MS: "", AUTH_MODE: " dev " }));
    assert.equal(config.inference.mode, "live");
    assert.equal(config.inference.timeoutMs, 15000);
  });

  it("resolves a relative DEV_TOKENS_FILE against cwd, defaulting to ./dev-tokens.json", () => {
    const env = validEnv({ DEV_TOKENS_FILE: undefined });
    assert.equal(loadConfig(env, { cwd: tmp.dir }).auth.devTokensFile, path.join(tmp.dir, "dev-tokens.json"));
  });

  it("resolveDevTokensFile follows the same rules as loadConfig", () => {
    assert.equal(resolveDevTokensFile({}, tmp.dir), path.join(tmp.dir, "dev-tokens.json"));
    assert.equal(resolveDevTokensFile({ DEV_TOKENS_FILE: "  " }, tmp.dir), path.join(tmp.dir, "dev-tokens.json"));
    assert.equal(resolveDevTokensFile({ DEV_TOKENS_FILE: " sub/t.json " }, tmp.dir), path.join(tmp.dir, "sub", "t.json"));
    assert.equal(resolveDevTokensFile({ DEV_TOKENS_FILE: tokenPath }, tmp.dir), tokenPath);
  });

  it("returns a frozen object", () => {
    const config = loadConfig(validEnv());
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.inference));
    assert.ok(Object.isFrozen(config.auth.users));
    assert.ok(Object.isFrozen(config.auth.users[0]));
  });
});

describe("loadConfig: development-only auth restrictions", () => {
  for (const nodeEnv of ["production", "Production", " production "]) {
    it(`rejects NODE_ENV=${JSON.stringify(nodeEnv)}`, () => {
      assert.deepEqual(problemsFor(validEnv({ NODE_ENV: nodeEnv })), [
        "NODE_ENV=production is not allowed: Phase 2 authentication is development-only (arch §8.1)",
      ]);
    });
  }

  for (const authMode of [undefined, "", "   "]) {
    it(`rejects a missing AUTH_MODE (${JSON.stringify(authMode)})`, () => {
      assert.deepEqual(problemsFor(validEnv({ AUTH_MODE: authMode })), ['AUTH_MODE is required and must be "dev"']);
    });
  }

  for (const authMode of ["prod", "DEV", "oidc", "none"]) {
    it(`rejects AUTH_MODE=${authMode}`, () => {
      assert.deepEqual(problemsFor(validEnv({ AUTH_MODE: authMode })), [
        'AUTH_MODE must be "dev"; no other authentication mode is supported in Phase 2',
      ]);
    });
  }

  it("rejects a missing token file", () => {
    const missing = path.join(tmp.dir, "missing.json");
    assert.deepEqual(problemsFor(validEnv({ DEV_TOKENS_FILE: missing })), [
      `DEV_TOKENS_FILE: token file not found: ${missing}`,
    ]);
  });

  it("rejects an empty token file", () => {
    const empty = tmp.write("empty.json", "");
    assert.deepEqual(problemsFor(validEnv({ DEV_TOKENS_FILE: empty })), ["DEV_TOKENS_FILE: token file is empty"]);
  });

  it("rejects a token file with a malformed hash", () => {
    const file = validTokenFile();
    file.users[1]!.tokenSha256 = "not-a-hash";
    const bad = tmp.write("bad-hash.json", file);
    assert.deepEqual(problemsFor(validEnv({ DEV_TOKENS_FILE: bad })), [
      "DEV_TOKENS_FILE: users[1].tokenSha256 must be a SHA-256 hash: 64 hexadecimal characters",
    ]);
  });

  it("rejects the committed example file, whose hashes are placeholders", () => {
    const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dev-tokens.example.json");
    const problems = problemsFor(validEnv({ DEV_TOKENS_FILE: example }));
    assert.equal(problems.length, 2);
    assert.ok(problems.every((p) => p.includes("tokenSha256 must be a SHA-256 hash")));
  });
});

describe("loadConfig: other variables", () => {
  for (const value of [undefined, "", "  "]) {
    it(`treats DATABASE_URL as optional (${JSON.stringify(value)})`, () => {
      assert.equal(loadConfig(validEnv({ DATABASE_URL: value })).databaseUrl, undefined);
    });
  }

  for (const value of ["not a url", "mysql://u:p@localhost/db", "http://localhost:5432", "postgresql://"]) {
    it(`rejects DATABASE_URL ${JSON.stringify(value)}`, () => {
      assert.deepEqual(problemsFor(validEnv({ DATABASE_URL: value })), [
        "DATABASE_URL must be a postgresql:// or postgres:// URL with a host",
      ]);
    });
  }

  for (const value of ["not a url", "ftp://inference:8000", "inference:8000"]) {
    it(`rejects INFERENCE_URL ${JSON.stringify(value)}`, () => {
      assert.deepEqual(problemsFor(validEnv({ INFERENCE_URL: value })), [
        "INFERENCE_URL must be a valid http:// or https:// URL",
      ]);
    });
  }

  it("rejects INFERENCE_URL with credentials", () => {
    assert.deepEqual(problemsFor(validEnv({ INFERENCE_URL: "http://user:pw@inference:8000" })), [
      "INFERENCE_URL must not contain credentials; the inference service has no auth",
    ]);
  });

  it("rejects INFERENCE_URL with a query string", () => {
    assert.deepEqual(problemsFor(validEnv({ INFERENCE_URL: "http://inference:8000/?x=1" })), [
      "INFERENCE_URL must be a base URL without a query string or fragment",
    ]);
  });

  for (const value of ["fake", "LIVE", "Mock"]) {
    it(`rejects INFERENCE_MODE=${value}`, () => {
      assert.deepEqual(problemsFor(validEnv({ INFERENCE_MODE: value })), ['INFERENCE_MODE must be "live" or "mock"']);
    });
  }

  for (const value of ["abc", "0", "-5", "1.5", "1e4", "15000ms", "99999999999999999999"]) {
    it(`rejects INFERENCE_TIMEOUT_MS=${value}`, () => {
      assert.deepEqual(problemsFor(validEnv({ INFERENCE_TIMEOUT_MS: value })), [
        "INFERENCE_TIMEOUT_MS must be a positive whole number of milliseconds",
      ]);
    });
  }
});

describe("loadConfig: error reporting", () => {
  it("reports every problem at once", () => {
    const problems = problemsFor({
      NODE_ENV: "production",
      AUTH_MODE: "prod",
      INFERENCE_MODE: "fake",
      INFERENCE_TIMEOUT_MS: "0",
      DATABASE_URL: "mysql://localhost/cbdc",
      DEV_TOKENS_FILE: path.join(tmp.dir, "missing.json"),
    });
    assert.equal(problems.length, 6);
  });

  it("formats the error message as a list", () => {
    try {
      loadConfig(validEnv({ AUTH_MODE: "prod" }));
      assert.fail("expected ConfigError");
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(
        error.message,
        'Invalid backend configuration:\n  - AUTH_MODE must be "dev"; no other authentication mode is supported in Phase 2',
      );
    }
  });

  it("never includes the database URL, its password or token hashes in messages", () => {
    const badDbUrl = `mysql://cbdc:${DB_PASSWORD}@localhost/cbdc`;
    const file = validTokenFile();
    file.users[1] = { ...file.users[0] };
    const dupes = tmp.write("dupes.json", file);
    const env = validEnv({ NODE_ENV: "production", DATABASE_URL: badDbUrl, DEV_TOKENS_FILE: dupes });
    let message = "";
    try {
      loadConfig(env);
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      message = `${error.message}\n${error.problems.join("\n")}`;
    }
    assert.ok(message.length > 0);
    assert.ok(!message.includes(DB_PASSWORD));
    assert.ok(!message.includes(badDbUrl));
    assert.ok(!message.includes(file.users[0]!.tokenSha256 as string));
  });
});
