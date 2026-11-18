import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import { createAuthenticator, parseBearerToken } from "../../src/auth/devAuth.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, startServer } from "../helpers/server.js";

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  // An upper-case hash in the file still matches (Step 2 stores it lower-case).
  { userId: "u-viewer-1", email: "Viewer@Example.Test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const UNAUTHENTICATED = { code: "UNAUTHENTICATED", message: "Missing or invalid bearer token.", details: {} };

describe("parseBearerToken", () => {
  const token = newToken();

  for (const header of [`Bearer ${token}`, `bearer ${token}`, `BEARER ${token}`, `BeArEr ${token}`, `Bearer   ${token}`]) {
    it(`accepts ${JSON.stringify(header.replace(token, "<token>"))}`, () => {
      assert.equal(parseBearerToken(header), token);
    });
  }

  it("accepts an upper-case hex token as sent", () => {
    assert.equal(parseBearerToken(`Bearer ${token.toUpperCase()}`), token.toUpperCase());
  });

  const malformed: Array<[string, string | undefined]> = [
    ["missing header", undefined],
    ["empty header", ""],
    ["scheme only", "Bearer"],
    ["scheme and space", "Bearer "],
    ["token without scheme", token],
    ["another scheme", `Basic ${token}`],
    ["two tokens", `Bearer ${token} ${token}`],
    ["63 characters", `Bearer ${token.slice(1)}`],
    ["65 characters", `Bearer ${token}0`],
    ["non-hex characters", `Bearer ${"g".repeat(64)}`],
    ["the MSW mock token", "Bearer mock-analyst"],
    ["a tab separator", `Bearer\t${token}`],
    ["no separator", `Bearer${token}`],
  ];
  for (const [name, header] of malformed) {
    it(`rejects ${name}`, () => {
      assert.equal(parseBearerToken(header), undefined);
    });
  }
});

describe("createAuthenticator", () => {
  const authenticate = createAuthenticator(users);

  it("returns the matching user without the hash", () => {
    assert.deepEqual(authenticate(`Bearer ${analystToken}`), {
      userId: "u-analyst-1",
      email: "analyst@example.test",
      role: "analyst",
    });
    assert.equal(authenticate(`Bearer ${viewerToken}`)?.userId, "u-viewer-1");
  });

  it("matches a hash stored in upper case", () => {
    const upper = createAuthenticator([{ ...users[0]!, tokenSha256: users[0]!.tokenSha256.toUpperCase() }]);
    // Step 2 normalises hashes; this checks the comparison itself is on bytes.
    assert.equal(upper(`Bearer ${analystToken}`)?.userId, "u-analyst-1");
  });

  it("returns undefined for an unknown token", () => {
    assert.equal(authenticate(`Bearer ${newToken()}`), undefined);
  });

  it("returns undefined for the hash itself used as a token", () => {
    assert.equal(authenticate(`Bearer ${users[0]!.tokenSha256}`), undefined);
  });

  it("hashes the token as sent, so an upper-cased token is unknown", () => {
    assert.equal(authenticate(`Bearer ${analystToken.toUpperCase()}`), undefined);
  });

  it("rejects everything when there are no users", () => {
    assert.equal(createAuthenticator([])(`Bearer ${analystToken}`), undefined);
  });
});

describe("protected routes over HTTP", () => {
  const capture = captureLogger();
  let server: Awaited<ReturnType<typeof startServer>>;
  before(async () => {
    server = await startServer(createApp({ logger: capture.logger, users }));
  });
  after(() => server.close());

  const get = (path: string, authorization?: string, method = "GET") =>
    fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { "X-Request-Id": "auth-test", ...(authorization === undefined ? {} : { Authorization: authorization }) },
    });

  it("GET /api/v1/auth/me returns the analyst's identity and permissions", async () => {
    const res = await get("/api/v1/auth/me", `Bearer ${analystToken}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      userId: "u-analyst-1",
      email: "analyst@example.test",
      role: "analyst",
      authMode: "dev",
      permissions: { experimentalPolicies: true },
    });
  });

  it("GET /api/v1/auth/me returns experimentalPolicies false for a viewer, email as written", async () => {
    const res = await get("/api/v1/auth/me", `bearer ${viewerToken}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      userId: "u-viewer-1",
      email: "Viewer@Example.Test",
      role: "viewer",
      authMode: "dev",
      permissions: { experimentalPolicies: false },
    });
  });

  const rejected: Array<[string, string | undefined]> = [
    ["a missing header", undefined],
    ["an empty header", ""],
    ["a malformed token", "Bearer abc"],
    ["the wrong scheme", `Basic ${analystToken}`],
    ["the MSW mock-analyst token", "Bearer mock-analyst"],
    ["the MSW mock-viewer token", "Bearer mock-viewer"],
    ["an unknown 64-hex token", `Bearer ${newToken()}`],
  ];
  for (const [name, authorization] of rejected) {
    it(`returns 401 UNAUTHENTICATED for ${name}`, async () => {
      const res = await get("/api/v1/auth/me", authorization);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("x-request-id"), "auth-test");
      assert.deepEqual(await res.json(), { error: { ...UNAUTHENTICATED, requestId: "auth-test" } });
    });
  }

  it("keeps /api/v1/health public, with or without a token", async () => {
    // This app has no database, so readiness is 503 with the Health body, never 401 (§3.9).
    for (const authorization of [undefined, "Bearer nonsense", `Bearer ${analystToken}`]) {
      const res = await get("/api/v1/health", authorization);
      assert.equal(res.status, 503);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, "unavailable");
      assert.equal("error" in body, false);
    }
  });

  it("returns 404 for unknown routes, even without a token", async () => {
    for (const authorization of [undefined, "Bearer nonsense", `Bearer ${analystToken}`]) {
      const res = await get("/api/v1/unknown", authorization);
      assert.equal(res.status, 404);
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, "NOT_FOUND");
    }
  });

  it("has no login or logout endpoints", async () => {
    for (const [method, path] of [
      ["POST", "/api/v1/auth/login"],
      ["POST", "/api/v1/auth/logout"],
    ] as const) {
      assert.equal((await get(path, `Bearer ${analystToken}`, method)).status, 404, `${method} ${path}`);
    }
    // /auth/me exists, so another method is 405, not 404 (§4).
    const me = await get("/api/v1/auth/me", `Bearer ${analystToken}`, "POST");
    assert.equal(me.status, 405);
    assert.equal(me.headers.get("allow"), "GET, HEAD");
  });

  it("never logs the token or its hash", () => {
    const output = capture.lines.join("\n");
    assert.ok(capture.lines.length > 0);
    for (const secret of [analystToken, viewerToken, users[0]!.tokenSha256, users[1]!.tokenSha256]) {
      assert.ok(!output.includes(secret), "secret found in logs");
    }
  });

  it("never returns the hash in a response", async () => {
    const text = await (await get("/api/v1/auth/me", `Bearer ${analystToken}`)).text();
    assert.ok(!text.includes(users[0]!.tokenSha256));
    assert.ok(!text.includes(analystToken));
  });
});

describe("app without users", () => {
  it("returns 401 for every token", async () => {
    const server = await startServer(createApp({ logger: captureLogger().logger }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/auth/me`, { headers: { Authorization: `Bearer ${analystToken}` } });
      assert.equal(res.status, 401);
    } finally {
      await server.close();
    }
  });
});
