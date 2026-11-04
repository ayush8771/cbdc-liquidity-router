import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FailureCode, Prisma, PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import type { TransactionPersistence } from "../../src/db/transactionPersistence.js";
import {
  createPrismaTransactionRepository,
  type TransactionDetailRow,
  type TransactionRepository,
} from "../../src/db/transactions.js";
import { createInferenceClient } from "../../src/inferenceClient/client.js";
import { FAILURE_MESSAGES } from "../../src/routes/transactions.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import { engineRegulatoryRejection, engineRouteResponse, requestBody } from "../helpers/transactions.js";

// GET /api/v1/transactions/:id (API contract §3.4) with a fake repository:
// no database and no network.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];

const ROUTED_ID = "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f"; // a v5 UUID, as in 200_get_routed.json
const FAILED_ID = "a121dc5c-b250-5b30-8025-f9e07e76d4e0"; // as in 200_get_failed.json
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const CREATED_AT = new Date("2026-11-02T10:00:00.123Z");

function routedRow(overrides: Partial<TransactionDetailRow> = {}, engine = engineRouteResponse()): TransactionDetailRow {
  return {
    id: ROUTED_ID,
    createdAt: CREATED_AT,
    createdById: "u-analyst-1",
    senderCountry: "GBR",
    receiverCountry: "PHL",
    amountUsd: 300000.0,
    stateSpec: { mode: "historicalReplay", date: "2024-06-14" },
    simulationDate: new Date("2024-06-14T00:00:00.000Z"),
    requestedPolicy: "waterfall",
    status: "routed",
    failureCode: null,
    clientReference: null,
    decision: { engineResponse: engine as Prisma.JsonValue },
    ...overrides,
  };
}

function failedRow(failureCode: FailureCode | null, overrides: Partial<TransactionDetailRow> = {}): TransactionDetailRow {
  return { ...routedRow(), id: FAILED_ID, status: "failed", failureCode, decision: null, ...overrides };
}

function fakeRepository(rows: TransactionDetailRow[] = [], error?: Error) {
  const lookups: string[] = [];
  const repository: TransactionRepository = {
    async list() {
      throw new Error("not used");
    },
    async findById(id) {
      lookups.push(id);
      if (error) throw error;
      return rows.find((r) => r.id === id.toLowerCase()) ?? null;
    },
  };
  return { repository, lookups };
}

/** Throws on any write, to prove GET writes nothing (no audit row, §6.2). */
const noWrites: TransactionPersistence = {
  userExists: async () => assert.fail("GET must not touch persistence"),
  saveRouted: async () => assert.fail("GET must not write"),
  saveFailed: async () => assert.fail("GET must not write"),
};

async function get(
  path: string,
  { repository, token = analystToken, method = "GET", logger = silentLogger }:
    { repository?: TransactionRepository; token?: string; method?: string; logger?: typeof silentLogger } = {},
) {
  const app = createApp({
    logger,
    users,
    ...(repository !== undefined && { transactions: repository }),
    transactionPersistence: noWrites,
  });
  const server = await startServer(app);
  try {
    const res = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: { "X-Request-Id": "req-d", ...(token !== "" && { Authorization: `Bearer ${token}` }) },
    });
    const text = await res.text();
    return { res, text, body: text === "" ? undefined : (JSON.parse(text) as Record<string, any>) };
  } finally {
    await server.close();
  }
}

const KEYS = ["id", "createdAt", "createdBy", "status", "transaction", "failure", "decision"];

describe("GET /api/v1/transactions/:id: routed", () => {
  it("rebuilds the 201 body from the stored engine response (200_get_routed shape)", async () => {
    const { repository, lookups } = fakeRepository([routedRow()]);
    const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository });
    assert.equal(res.status, 200);
    assert.deepEqual(lookups, [ROUTED_ID]);
    assert.deepEqual(Object.keys(body!), KEYS);
    assert.equal(body!.id, ROUTED_ID);
    assert.equal(body!.createdAt, "2026-11-02T10:00:00.123Z");
    assert.equal(body!.createdBy, "u-analyst-1");
    assert.equal(body!.status, "routed");
    assert.equal(body!.failure, null);
    assert.deepEqual(body!.transaction, {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000.0,
      corridor: "GBR->PHL",
      simulationDate: "2024-06-14",
      clientReference: null,
    });
    assert.deepEqual(Object.keys(body!.decision), [
      "decisionId", "policy", "policyStatus", "feasibility", "allocations", "totals", "metrics", "diagnostics", "provenance",
      "warnings",
    ]);
    assert.equal(body!.decision.provenance.stateMode, "historicalReplay");
    assert.equal(body!.decision.metrics.feeCostUsd, 5100.0);
    assert.equal(body!.decision.allocations.length, 3);
  });

  it("returns exactly the body the POST returned for the same transaction", async () => {
    // POST with a capturing persistence, then GET the row built from what was saved.
    let saved: Parameters<TransactionPersistence["saveRouted"]>[0] | undefined;
    const persistence: TransactionPersistence = {
      userExists: async () => true,
      saveRouted: async (input) => ((saved = input), { id: ROUTED_ID, createdAt: CREATED_AT }),
      saveFailed: async () => assert.fail("not failed"),
    };
    const engine = engineRouteResponse({ clientReference: "ref-7" });
    const inferenceClient = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      { logger: silentLogger, mockHandler: () => ({ status: 200, body: engine }) },
    );
    const server = await startServer(createApp({ logger: silentLogger, users, inferenceClient, transactionPersistence: persistence }));
    let posted: Record<string, unknown>;
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${analystToken}` },
        body: JSON.stringify(requestBody({ clientReference: "ref-7" })),
      });
      assert.equal(res.status, 201);
      posted = (await res.json()) as Record<string, unknown>;
    } finally {
      await server.close();
    }
    assert.ok(saved);
    const row = routedRow(
      { clientReference: saved.request.clientReference, stateSpec: saved.request.state as never },
      saved.engineResponse,
    );
    const { body } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository: fakeRepository([row]).repository });
    assert.deepEqual(body, posted);
    assert.deepEqual(Object.keys(posted), KEYS);
  });

  it("returns a regulatory rejection as routed, with its decision", async () => {
    const { repository } = fakeRepository([routedRow({}, engineRegulatoryRejection())]);
    const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository });
    assert.equal(res.status, 200);
    assert.equal(body!.status, "routed");
    assert.equal(body!.failure, null);
    assert.equal(body!.decision.feasibility.allowed, false);
    assert.deepEqual(body!.decision.allocations, []);
    assert.equal(body!.decision.metrics.feeCostUsd, 0);
  });

  it("rebuilds an explicit-state ppoProjected transaction against its stored state", async () => {
    const venues = [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1, congestion: 0.1, history: null }];
    const engine = engineRouteResponse({ policy: "ppo_projected", policyStatus: "experimental", stateMode: "explicit" });
    const row = routedRow(
      { requestedPolicy: "ppoProjected", stateSpec: { mode: "explicit", referenceDate: "2024-06-14", venues } },
      engine,
    );
    const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository: fakeRepository([row]).repository });
    assert.equal(res.status, 200);
    assert.equal(body!.decision.policy, "ppoProjected");
    assert.equal(body!.decision.provenance.stateMode, "explicit");
  });
});

describe("GET /api/v1/transactions/:id: failed", () => {
  for (const code of ["INFERENCE_ERROR", "INFERENCE_UNAVAILABLE", "ENGINE_BUSY", "ENGINE_TIMEOUT"] as const) {
    it(`returns ${code} as failure, with decision and corridor null`, async () => {
      const { repository } = fakeRepository([failedRow(code)]);
      const { res, body } = await get(`/api/v1/transactions/${FAILED_ID}`, { repository });
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(body!), KEYS);
      assert.equal(body!.status, "failed");
      assert.equal(body!.decision, null);
      assert.deepEqual(body!.failure, { code, message: FAILURE_MESSAGES[code] });
      assert.deepEqual(body!.transaction, {
        senderCountry: "GBR",
        receiverCountry: "PHL",
        corridor: null,
        amountUsd: 300000.0,
        simulationDate: "2024-06-14",
        clientReference: null,
      });
    });
  }

  it("matches 200_get_failed.json exactly (ENGINE_BUSY)", async () => {
    const { repository } = fakeRepository([failedRow("ENGINE_BUSY", { createdAt: new Date("2026-11-02T10:05:00.000Z") })]);
    const { body } = await get(`/api/v1/transactions/${FAILED_ID}`, { repository });
    assert.deepEqual(body, {
      id: FAILED_ID,
      createdAt: "2026-11-02T10:05:00.000Z",
      createdBy: "u-analyst-1",
      status: "failed",
      transaction: {
        senderCountry: "GBR",
        receiverCountry: "PHL",
        corridor: null,
        amountUsd: 300000.0,
        simulationDate: "2024-06-14",
        clientReference: null,
      },
      failure: { code: "ENGINE_BUSY", message: "The routing engine is busy. Try again later." },
      decision: null,
    });
  });

  it("uses the agreed fixed messages: the live-service INFERENCE_UNAVAILABLE text, INFERENCE_ERROR unchanged", () => {
    assert.deepEqual(FAILURE_MESSAGES, {
      INFERENCE_ERROR: "The inference service returned an invalid response.",
      INFERENCE_UNAVAILABLE: "The inference service is unavailable.",
      ENGINE_BUSY: "The routing engine is busy. Try again later.",
      ENGINE_TIMEOUT: "The routing engine did not finish in time.",
    });
  });

  it("returns failure: null for a historical failed row with no failureCode, inventing nothing (interim)", async () => {
    const { repository } = fakeRepository([failedRow(null, { clientReference: "old-1" })]);
    const { res, body } = await get(`/api/v1/transactions/${FAILED_ID}`, { repository });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(body!), KEYS);
    assert.equal(body!.status, "failed");
    assert.equal(body!.failure, null);
    assert.equal(body!.decision, null);
    assert.equal(body!.transaction.corridor, null);
    assert.equal(body!.transaction.clientReference, "old-1");
  });
});

describe("GET /api/v1/transactions/:id: IDs", () => {
  it("returns 404 NOT_FOUND with the standard envelope for an unknown UUID", async () => {
    const { repository, lookups } = fakeRepository([routedRow()]);
    const { res, body } = await get(`/api/v1/transactions/${UNKNOWN_ID}`, { repository });
    assert.equal(res.status, 404);
    assert.deepEqual(body, { error: { code: "NOT_FOUND", message: "Unknown resource.", details: {}, requestId: "req-d" } });
    assert.deepEqual(lookups, [UNKNOWN_ID]);
  });

  for (const id of [
    "abc",
    "123",
    "56d0d70862d659aaaa8d4df8d9b8d37f", // no hyphens
    "{56d0d708-62d6-59aa-aa8d-4df8d9b8d37f}",
    "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f0",
    "56d0d708-62d6-59aa-aa8d-4df8d9b8d37",
    "56d0d708-62d6-59aa-aa8d-4df8d9b8d37g",
    "56d0d708_62d6_59aa_aa8d_4df8d9b8d37f",
    "%20",
    "null",
    "x".repeat(500),
  ]) {
    it(`returns the same 404 for the malformed ID ${JSON.stringify(id.length > 40 ? `${id.slice(0, 8)}…` : id)}, without a lookup`, async () => {
      const { repository, lookups } = fakeRepository([routedRow()]);
      const { res, body, text } = await get(`/api/v1/transactions/${id}`, { repository });
      assert.equal(res.status, 404);
      assert.deepEqual(body, { error: { code: "NOT_FOUND", message: "Unknown resource.", details: {}, requestId: "req-d" } });
      assert.deepEqual(lookups, []);
      if (id.length > 3) assert.doesNotMatch(text, new RegExp(id.slice(0, 20).replace(/[{}%]/g, "\\$&")));
    });
  }

  it("accepts any UUID version and upper case", async () => {
    const { repository, lookups } = fakeRepository([routedRow()]);
    const upper = ROUTED_ID.toUpperCase();
    const { res, body } = await get(`/api/v1/transactions/${upper}`, { repository });
    assert.equal(res.status, 200);
    assert.equal(body!.id, ROUTED_ID);
    assert.deepEqual(lookups, [upper]);
  });

  it("returns 404 for a malformed ID even without a database, and 500 for a valid one", async () => {
    assert.equal((await get("/api/v1/transactions/abc")).res.status, 404);
    const { res, body } = await get(`/api/v1/transactions/${UNKNOWN_ID}`);
    assert.equal(res.status, 500);
    assert.equal(body!.error.code, "INTERNAL_ERROR");
  });
});

describe("GET /api/v1/transactions/:id: auth, methods and faults", () => {
  it("requires a token: 401 without one or with an unknown one, and no lookup", async () => {
    for (const token of ["", "nonsense"]) {
      const { repository, lookups } = fakeRepository([routedRow()]);
      const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository, token });
      assert.equal(res.status, 401);
      assert.equal(body!.error.code, "UNAUTHENTICATED");
      assert.deepEqual(lookups, []);
    }
  });

  it("checks auth before the ID: a malformed ID without a token is 401", async () => {
    const { res } = await get("/api/v1/transactions/abc", { repository: fakeRepository().repository, token: "" });
    assert.equal(res.status, 401);
  });

  it("lets any authenticated user read any user's transaction, including a viewer reading an analyst's", async () => {
    const venues = [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1, congestion: 0.1, history: null }];
    const row = routedRow(
      { createdById: "u-analyst-1", requestedPolicy: "ppoProjected", stateSpec: { mode: "explicit", referenceDate: "2024-06-14", venues } },
      engineRouteResponse({ policy: "ppo_projected", policyStatus: "experimental", stateMode: "explicit" }),
    );
    const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, {
      repository: fakeRepository([row, failedRow("ENGINE_BUSY")]).repository,
      token: viewerToken,
    });
    assert.equal(res.status, 200);
    assert.equal(body!.createdBy, "u-analyst-1");
    const failed = await get(`/api/v1/transactions/${FAILED_ID}`, {
      repository: fakeRepository([failedRow("ENGINE_BUSY")]).repository,
      token: viewerToken,
    });
    assert.equal(failed.res.status, 200);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    it(`${method} -> 405 with Allow: GET, HEAD, naming the route pattern, not the ID`, async () => {
      const { repository, lookups } = fakeRepository([routedRow()]);
      const { res, body, text } = await get(`/api/v1/transactions/${ROUTED_ID}`, { repository, method });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
      assert.deepEqual(body!.error, {
        code: "METHOD_NOT_ALLOWED",
        message: `Method ${method} is not allowed on /api/v1/transactions/:id.`,
        details: {},
        requestId: "req-d",
      });
      assert.doesNotMatch(text, new RegExp(ROUTED_ID));
      assert.deepEqual(lookups, []);
    });
  }

  it("still returns 404 for a deeper unknown path", async () => {
    const { res } = await get(`/api/v1/transactions/${ROUTED_ID}/extra`, { repository: fakeRepository().repository });
    assert.equal(res.status, 404);
  });

  it("answers HEAD through the GET route", async () => {
    const { res } = await get(`/api/v1/transactions/${ROUTED_ID}`, {
      repository: fakeRepository([routedRow()]).repository,
      method: "HEAD",
    });
    assert.equal(res.status, 200);
  });

  it("returns 500 INTERNAL_ERROR, not 502, when a stored response no longer maps; logs field paths only", async () => {
    const stale = { ...engineRouteResponse(), metrics: null }; // saved before metrics became required
    const capture = captureLogger();
    const { res, body, text } = await get(`/api/v1/transactions/${ROUTED_ID}`, {
      repository: fakeRepository([routedRow({}, stale)]).repository,
      logger: capture.logger,
    });
    assert.equal(res.status, 500);
    assert.deepEqual(body!.error, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      details: {},
      requestId: "req-d",
    });
    assert.doesNotMatch(text, /metrics/);
    const entry = capture.entries().find((e) => e.msg === "stored route response no longer maps");
    assert.ok(entry, capture.lines.join("\n"));
    assert.deepEqual(entry.problems, ["metrics: must be an object"]);
    assert.equal(entry.transactionId, ROUTED_ID);
  });

  it("returns 500 for a routed row without its decision row", async () => {
    const { res } = await get(`/api/v1/transactions/${ROUTED_ID}`, {
      repository: fakeRepository([routedRow({ decision: null })]).repository,
    });
    assert.equal(res.status, 500);
  });

  it("returns 500 INTERNAL_ERROR when the database read fails", async () => {
    const { res, body } = await get(`/api/v1/transactions/${ROUTED_ID}`, {
      repository: fakeRepository([], new Error("connection reset")).repository,
    });
    assert.equal(res.status, 500);
    assert.equal(body!.error.code, "INTERNAL_ERROR");
  });
});

describe("Prisma transaction repository: findById", () => {
  it("looks up by primary key, reading only, with exactly the detail fields", async () => {
    const calls: Array<{ op: string; args: unknown }> = [];
    const client = {
      transactionRequest: {
        findUnique: async (args: unknown) => (calls.push({ op: "findUnique", args }), null),
        create: async () => assert.fail("no writes"),
        update: async () => assert.fail("no writes"),
      },
      auditLog: { create: async () => assert.fail("no audit row on GET") },
      $transaction: async () => assert.fail("no transaction needed"),
    } as unknown as PrismaClient;
    assert.equal(await createPrismaTransactionRepository(client).findById(ROUTED_ID), null);
    assert.equal(calls.length, 1);
    const args = calls[0]!.args as { where: unknown; select: Record<string, unknown> };
    assert.deepEqual(args.where, { id: ROUTED_ID });
    assert.deepEqual(Object.keys(args.select), [
      "id", "createdAt", "createdById", "senderCountry", "receiverCountry", "amountUsd", "stateSpec", "simulationDate",
      "requestedPolicy", "status", "failureCode", "clientReference", "decision",
    ]);
    assert.deepEqual(args.select.decision, { select: { engineResponse: true } });
  });
});
