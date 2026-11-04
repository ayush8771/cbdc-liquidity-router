import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient, type Policy, type StateMode } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import {
  createPrismaTransactionPersistence,
  transactionRequestData,
  type RoutedTransaction,
} from "../../src/db/transactionPersistence.js";
import { createPrismaTransactionRepository, type TransactionRepository } from "../../src/db/transactions.js";
import { createPrismaExplanationStore, type ExplanationStore } from "../../src/db/explanations.js";
import { createInferenceClient, type InferenceRequest, type MockResponse } from "../../src/inferenceClient/client.js";
import { mapRouteResponse } from "../../src/mappers/routeResponse.js";
import { FAILURE_MESSAGES } from "../../src/routes/transactions.js";
import { validateTransactionRequest, type TransactionRequest } from "../../src/validation/transactionRequest.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { silentLogger, startServer } from "../helpers/server.js";
import {
  engineError,
  engineExplainResponse,
  engineRegulatoryRejection,
  engineRouteResponse,
  requestBody,
} from "../helpers/transactions.js";

// GET and POST /api/v1/transactions against a real PostgreSQL database. Both
// suites are in this one file so they run one after the other: each empties
// the tables, and node --test runs separate files in parallel.
//
// Runs only when CBDC_TEST_DATABASE_URL is set, so `npm test` needs no
// database. The database must be disposable: this test EMPTIES every table
// before and after it runs. As a guard, its name must end in "_test".
// Apply the migrations to it first; the test never changes the schema:
//   DATABASE_URL=<the same URL> npx prisma migrate deploy
// Then: CBDC_TEST_DATABASE_URL=<url> npm test

const url = process.env.CBDC_TEST_DATABASE_URL?.trim() || undefined;

function guard(value: string | undefined): string | undefined {
  if (value === undefined) return "CBDC_TEST_DATABASE_URL is not set";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("CBDC_TEST_DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("CBDC_TEST_DATABASE_URL must be a postgresql:// URL");
  }
  // Fails rather than skips: a configured but unsafe URL must not go unnoticed.
  if (!/_test$/.test(decodeURIComponent(parsed.pathname.slice(1)))) {
    throw new Error('CBDC_TEST_DATABASE_URL must name a disposable database whose name ends in "_test"');
  }
  return undefined;
}

const skip = guard(url);
const TABLES = ['"AuditLog"', '"Explanation"', '"Allocation"', '"RoutingDecision"', '"Comparison"', '"TransactionRequest"', '"User"'];

describe("GET /api/v1/transactions (PostgreSQL integration)", { skip }, () => {
  let prisma: PrismaClient;
  let repository: TransactionRepository;
  const token = newToken();
  const users: DevUser[] = [
    { userId: "it-analyst", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(token) },
  ];

  // Five transactions. t4 and t5 share createdAt, so id (DESC) decides their order.
  const rows: Array<{
    id: string;
    at: string;
    corridor: string | null;
    policy: Policy;
    stateMode: StateMode;
    completed?: boolean;
  }> = [
    { id: "00000000-0000-4000-8000-000000000001", at: "2026-11-01T10:00:00.000Z", corridor: "GBR->PHL", policy: "waterfall", stateMode: "historicalReplay", completed: true },
    { id: "00000000-0000-4000-8000-000000000002", at: "2026-11-01T11:00:00.000Z", corridor: "USA->IND", policy: "cheapestFeasible", stateMode: "scenario", completed: false },
    { id: "00000000-0000-4000-8000-000000000003", at: "2026-11-01T12:00:00.000Z", corridor: null, policy: "ppoProjected", stateMode: "explicit" },
    { id: "00000000-0000-4000-8000-000000000004", at: "2026-11-01T13:00:00.000Z", corridor: "ARE->MEX", policy: "waterfall", stateMode: "historicalReplay", completed: true },
    { id: "00000000-0000-4000-8000-000000000005", at: "2026-11-01T13:00:00.000Z", corridor: "ARE->MEX", policy: "waterfall", stateMode: "historicalReplay", completed: true },
  ];
  const id = (n: number) => rows[n - 1]!.id;

  async function truncate(): Promise<void> {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  }

  async function list(query: string): Promise<{ items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number }> {
    const server = await startServer(createApp({ logger: silentLogger, users, transactions: repository }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions${query}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200, await res.clone().text());
      return (await res.json()) as { items: Array<Record<string, unknown>>; page: number; pageSize: number; total: number };
    } finally {
      await server.close();
    }
  }
  const ids = (body: { items: Array<Record<string, unknown>> }) => body.items.map((item) => item.id);

  before(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const [schema] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('"TransactionRequest"') IS NOT NULL AS exists`;
    if (!schema?.exists) throw new Error("The test database has no schema; run `prisma migrate deploy` against it first");
    repository = createPrismaTransactionRepository(prisma);
    await truncate();
    await prisma.user.create({ data: { id: "it-analyst", email: "analyst@example.test", role: "analyst" } });
    for (const row of rows) {
      await prisma.transactionRequest.create({
        data: {
          id: row.id,
          createdAt: new Date(row.at),
          createdById: "it-analyst",
          senderCountry: "GBR",
          receiverCountry: "PHL",
          corridor: row.corridor,
          amountUsd: 1000,
          stateMode: row.stateMode,
          stateSpec: { test: true },
          simulationDate: new Date("2024-06-14T00:00:00Z"),
          requestedPolicy: row.policy,
          status: row.completed === undefined ? "failed" : "routed",
          ...(row.completed !== undefined && {
            decision: {
              create: {
                decisionId: "sha256:test",
                policy: row.policy,
                policyStatus: "default",
                allowed: true,
                completed: row.completed,
                completionRatio: row.completed ? 1 : 0.5,
                executedUsd: row.completed ? 1000 : 500,
                unroutedEnvUsd: 0,
                unroutedAmountBasedUsd: row.completed ? 0 : 500,
                rewardAmountBased: -0.25,
                valuesProvenance: "synthetic_simulation",
                stateFrameSha256: "test",
                knowledgeSha256: "test",
                gitCommit: "test",
                engineResponse: { test: true },
              },
            },
          }),
        },
      });
    }
  });

  after(async () => {
    if (prisma === undefined) return;
    try {
      await truncate();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("lists newest first, breaking createdAt ties by id DESC, with the total", async () => {
    const body = await list("");
    assert.equal(body.total, 5);
    assert.deepEqual(ids(body), [id(5), id(4), id(3), id(2), id(1)]);
  });

  it("pages through every row exactly once", async () => {
    const seen: unknown[] = [];
    for (const page of [1, 2, 3]) {
      const body = await list(`?pageSize=2&page=${page}`);
      assert.equal(body.total, 5);
      seen.push(...ids(body));
    }
    assert.deepEqual(seen, [id(5), id(4), id(3), id(2), id(1)]);
    assert.deepEqual((await list("?pageSize=2&page=4")).items, []);
  });

  it("maps a failed row with null decision fields, and a routed row from its decision", async () => {
    const items = (await list("")).items;
    const failed = items.find((item) => item.id === id(3))!;
    assert.deepEqual(failed, {
      id: id(3),
      createdAt: "2026-11-01T12:00:00.000Z",
      createdBy: "it-analyst",
      corridor: null,
      amountUsd: 1000,
      simulationDate: "2024-06-14",
      stateMode: "explicit",
      policy: "ppoProjected",
      policyStatus: null,
      status: "failed",
      allowed: null,
      completed: null,
      completionRatio: null,
      executedUsd: null,
      rewardAmountBased: null,
    });
    const routed = items.find((item) => item.id === id(2))!;
    assert.equal(routed.completed, false);
    assert.equal(routed.completionRatio, 0.5);
    assert.equal(routed.executedUsd, 500);
    assert.equal(routed.rewardAmountBased, -0.25);
  });

  it("filters by corridor, policy (requestedPolicy, including failed rows) and stateMode", async () => {
    assert.deepEqual(ids(await list("?corridor=GBR-%3EPHL")), [id(1)]);
    assert.deepEqual(ids(await list("?policy=ppoProjected")), [id(3)]);
    assert.deepEqual(ids(await list("?stateMode=historicalReplay")), [id(5), id(4), id(1)]);
  });

  it("filters completed on decisions only, so failed rows match neither value", async () => {
    assert.deepEqual(ids(await list("?completed=true")), [id(5), id(4), id(1)]);
    const incomplete = await list("?completed=false");
    assert.deepEqual(ids(incomplete), [id(2)]);
    assert.equal(incomplete.total, 1);
  });

  it("treats from as inclusive and to as exclusive", async () => {
    assert.deepEqual(ids(await list("?from=2026-11-01T13:00:00Z")), [id(5), id(4)]);
    assert.deepEqual(ids(await list("?to=2026-11-01T13:00:00Z")), [id(3), id(2), id(1)]);
    assert.deepEqual(ids(await list("?from=2026-11-01T11:00:00Z&to=2026-11-01T12:00:00Z")), [id(2)]);
    assert.deepEqual(ids(await list("?from=2026-11-01T11:00:00Z&to=2026-11-01T11:00:00Z")), []);
    assert.deepEqual(ids(await list("?from=2026-11-01T11:00:00.001Z&to=2026-11-01T12:00:00.001Z")), [id(3)]);
  });
});

describe("POST /api/v1/transactions (PostgreSQL integration)", { skip }, () => {
  let prisma: PrismaClient;
  const token = newToken();
  // A valid token whose user was never seeded: no User row.
  const unseededToken = newToken();
  const users: DevUser[] = [
    { userId: "it-analyst", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(token) },
    { userId: "it-unseeded", email: "unseeded@example.test", role: "analyst", tokenSha256: sha256Hex(unseededToken) },
  ];

  async function truncate(): Promise<void> {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  }

  async function counts(): Promise<Record<string, number>> {
    return {
      transactions: await prisma.transactionRequest.count(),
      decisions: await prisma.routingDecision.count(),
      allocations: await prisma.allocation.count(),
      audits: await prisma.auditLog.count(),
    };
  }

  async function post(
    answer: MockResponse | undefined,
    { authToken = token, body = requestBody() }: { authToken?: string; body?: Record<string, unknown> } = {},
  ): Promise<{ status: number; body: Record<string, any>; inferenceCalls: number }> {
    let inferenceCalls = 0;
    const inferenceClient = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      {
        logger: silentLogger,
        mockHandler: (_request: Readonly<InferenceRequest>) => {
          inferenceCalls += 1;
          return answer;
        },
      },
    );
    const app = createApp({
      logger: silentLogger,
      users,
      inferenceClient,
      transactionPersistence: createPrismaTransactionPersistence(prisma),
    });
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${authToken}`, "X-Request-Id": "it-req" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any>, inferenceCalls };
    } finally {
      await server.close();
    }
  }

  async function getById(id: string): Promise<{ status: number; body: Record<string, any> }> {
    const app = createApp({ logger: silentLogger, users, transactions: createPrismaTransactionRepository(prisma) });
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions/${id}`, {
        headers: { Authorization: `Bearer ${token}`, "X-Request-Id": "it-get" },
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    } finally {
      await server.close();
    }
  }

  describe("GET /api/v1/transactions/:id (PostgreSQL)", () => {
    it("returns a routed transaction exactly as the POST returned it, writing nothing", async () => {
      const posted = await post({ status: 200, body: engineRouteResponse() });
      assert.equal(posted.status, 201);
      const before = await counts();
      const res = await getById(posted.body.id);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, posted.body);
      assert.equal(res.body.failure, null);
      assert.deepEqual(await counts(), before); // no audit row on GET
    });

    it("returns a regulatory rejection as routed, as the POST returned it", async () => {
      const posted = await post({ status: 200, body: engineRegulatoryRejection() });
      const res = await getById(posted.body.id);
      assert.deepEqual(res.body, posted.body);
      assert.equal(res.body.decision.feasibility.allowed, false);
    });

    for (const [name, answer, code] of [
      ["ENGINE_BUSY", { status: 503, body: engineError("ENGINE_BUSY") }, "ENGINE_BUSY"],
      ["NOT_READY", { status: 503, body: engineError("NOT_READY") }, "INFERENCE_UNAVAILABLE"],
      ["INTERNAL_ERROR", { status: 500, body: engineError("INTERNAL_ERROR") }, "INFERENCE_ERROR"],
    ] as const) {
      it(`returns a failed transaction (${name}) with failure ${code}, decision and corridor null`, async () => {
        const posted = await post(answer);
        const id = posted.body.error.details.transactionId as string;
        const res = await getById(id);
        assert.equal(res.status, 200);
        assert.equal(res.body.status, "failed");
        assert.equal(res.body.decision, null);
        assert.equal(res.body.transaction.corridor, null);
        assert.equal(res.body.failure.code, code);
        assert.equal(res.body.failure.message, FAILURE_MESSAGES[code]);
      });
    }

    it("returns failure: null for a historical failed row whose failureCode is NULL", async () => {
      const id = randomUUID();
      await prisma.transactionRequest.create({
        data: {
          ...transactionRequestData(
            { userId: "it-analyst", requestId: "it-historical", request: validated() },
            { id, createdAt: new Date("2026-11-01T09:00:00.000Z") },
            "failed",
            null,
            null, // as saved before the failureCode migration
          ),
        },
      });
      const res = await getById(id);
      assert.equal(res.status, 200);
      assert.equal(res.body.status, "failed");
      assert.equal(res.body.failure, null);
      assert.equal(res.body.decision, null);
      assert.equal(res.body.transaction.corridor, null);
    });

    it("returns 404 NOT_FOUND for an unknown UUID, and the same for a malformed ID", async () => {
      for (const id of ["00000000-0000-4000-8000-000000000000", "not-a-uuid"]) {
        const res = await getById(id);
        assert.equal(res.status, 404, id);
        assert.deepEqual(res.body.error, { code: "NOT_FOUND", message: "Unknown resource.", details: {}, requestId: "it-get" });
      }
    });

    it("finds an upper-case UUID", async () => {
      const posted = await post({ status: 200, body: engineRouteResponse() });
      const res = await getById((posted.body.id as string).toUpperCase());
      assert.equal(res.status, 200);
      assert.equal(res.body.id, posted.body.id);
    });
  });

  function validated(): TransactionRequest {
    const result = validateTransactionRequest(requestBody());
    assert.ok(result.ok);
    return result.value;
  }

  function routedInput(engine = engineRouteResponse()): RoutedTransaction {
    const request = validated();
    const { columns } = mapRouteResponse(engine, request);
    return {
      userId: "it-analyst",
      requestId: "it-direct",
      request,
      corridor: columns.corridor,
      decision: columns.decision,
      allocations: columns.allocations,
      engineResponse: engine,
    };
  }

  before(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    await truncate();
    await prisma.user.create({ data: { id: "it-analyst", email: "analyst@example.test", role: "analyst" } });
  });

  after(async () => {
    if (prisma === undefined) return;
    try {
      await truncate();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("saves a routed transaction, its decision, every allocation and a SUCCESS audit row", async () => {
    const engine = engineRouteResponse();
    const res = await post({ status: 200, body: engine });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await prisma.transactionRequest.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { decision: { include: { allocations: { orderBy: { slot: "asc" } } } } },
    });
    assert.equal(res.body.createdAt, row.createdAt.toISOString());
    assert.equal(row.createdById, "it-analyst");
    assert.equal(row.status, "routed");
    assert.equal(row.corridor, "GBR->PHL");
    assert.equal(row.stateMode, "historicalReplay");
    assert.deepEqual(row.stateSpec, { mode: "historicalReplay", date: "2024-06-14" });
    assert.equal(row.simulationDate.toISOString(), "2024-06-14T00:00:00.000Z");
    assert.equal(row.requestedPolicy, "waterfall");
    assert.equal(row.clientReference, null);
    assert.equal(row.failureCode, null);

    const decision = row.decision!;
    assert.equal(decision.feeCostUsd, 5100);
    assert.equal(decision.decisionId, "sha256:9f2c");
    assert.equal(decision.policy, "waterfall");
    assert.equal(decision.allowed, true);
    assert.equal(decision.executedUsd, 300000);
    assert.equal(decision.rewardAmountBased, -0.3078);
    assert.equal(decision.latencyTerm, 0.265);
    assert.equal(decision.checkpointSha256, null);
    assert.deepEqual(decision.engineResponse, engine);
    assert.deepEqual(
      decision.allocations.map((a) => [a.slot, a.bridgeUid, a.amountExecutedUsd, a.shareBeforeProjection]),
      [
        [0, "GBR->PHL#0", 150000, null],
        [1, "GBR->PHL#1", 150000, null],
        [2, "GBR->PHL#2", 0, null],
      ],
    );

    const audits = await prisma.auditLog.findMany({ where: { entityId: row.id } });
    assert.equal(audits.length, 1);
    const { id: auditId, ...audit } = audits[0]!;
    assert.match(auditId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(audit, {
      at: row.createdAt,
      userId: "it-analyst",
      action: "TRANSACTION_CREATE",
      requestId: "it-req",
      entityType: "TransactionRequest",
      entityId: row.id,
      outcome: "SUCCESS",
    });
  });

  it("saves a regulatory rejection as routed, with no allocations and feeCostUsd 0", async () => {
    const res = await post({ status: 200, body: engineRegulatoryRejection() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = await prisma.transactionRequest.findUniqueOrThrow({
      where: { id: res.body.id },
      include: { decision: { include: { allocations: true } } },
    });
    assert.equal(row.status, "routed");
    assert.equal(row.decision!.allowed, false);
    assert.equal(row.decision!.rewardEnv, 0);
    assert.equal(row.decision!.feeCostUsd, 0);
    assert.equal(row.failureCode, null);
    assert.deepEqual(row.decision!.allocations, []);
    assert.deepEqual(row.decision!.engineResponse, engineRegulatoryRejection());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: row.id } });
    assert.equal(audit.outcome, "SUCCESS");
  });

  it("saves an inference failure as a failed transaction with a FAILED audit row and no decision", async () => {
    const res = await post(undefined);
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, "INFERENCE_UNAVAILABLE");
    const id = res.body.error.details.transactionId as string;
    const row = await prisma.transactionRequest.findUniqueOrThrow({ where: { id }, include: { decision: true } });
    assert.equal(row.status, "failed");
    assert.equal(row.failureCode, "INFERENCE_UNAVAILABLE");
    assert.equal(row.corridor, null);
    assert.equal(row.decision, null);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: id } });
    assert.equal(audit.outcome, "FAILED");
    assert.equal(audit.entityType, "TransactionRequest");
    assert.deepEqual(audit.at, row.createdAt);
  });

  for (const [name, answer, status, code] of [
    ["NOT_READY", { status: 503, body: engineError("NOT_READY") }, 503, "INFERENCE_UNAVAILABLE"],
    ["ENGINE_BUSY", { status: 503, body: engineError("ENGINE_BUSY") }, 503, "ENGINE_BUSY"],
    ["ENGINE_TIMEOUT", { status: 504, body: engineError("ENGINE_TIMEOUT") }, 504, "ENGINE_TIMEOUT"],
    ["INTERNAL_ERROR", { status: 500, body: engineError("INTERNAL_ERROR") }, 502, "INFERENCE_ERROR"],
  ] as const) {
    it(`stores failureCode ${code} for inference ${name}`, async () => {
      const res = await post(answer);
      assert.equal(res.status, status);
      assert.equal(res.body.error.code, code);
      const row = await prisma.transactionRequest.findUniqueOrThrow({ where: { id: res.body.error.details.transactionId } });
      assert.equal(row.status, "failed");
      assert.equal(row.failureCode, code);
    });
  }

  it("rejects a failure code on a routed row (CHECK constraint from the migration)", async () => {
    const res = await post({ status: 200, body: engineRouteResponse() });
    assert.equal(res.status, 201);
    await assert.rejects(
      prisma.transactionRequest.update({ where: { id: res.body.id }, data: { failureCode: "ENGINE_BUSY" } }),
      /TransactionRequest_failureCode_failed_only|check constraint/i,
    );
  });

  for (const [name, answer, status] of [
    ["engine 422", { status: 422, body: engineError("DATE_IN_GAP_BUFFER") }, 422],
    ["409 POLICY_DISABLED", { status: 409, body: engineError("POLICY_DISABLED") }, 409],
  ] as const) {
    it(`saves and audits nothing for ${name}`, async () => {
      const before = await counts();
      const res = await post(answer, { body: requestBody({ policy: "ppoProjected" }) });
      assert.equal(res.status, status);
      assert.deepEqual(await counts(), before);
    });
  }

  it("refuses a user without a User row before inference, saving nothing", async () => {
    const before = await counts();
    const res = await post({ status: 200, body: engineRouteResponse() }, { authToken: unseededToken });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    assert.equal(res.inferenceCalls, 0);
    assert.deepEqual(await counts(), before);
    assert.equal(await prisma.user.count({ where: { id: "it-unseeded" } }), 0);
  });

  describe("rollback", () => {
    // An audit ID that already exists, so the audit insert (the last write) fails.
    async function existingAuditId(): Promise<string> {
      return (await prisma.auditLog.findFirstOrThrow()).id;
    }
    function idsThenDuplicate(duplicate: string): () => string {
      let n = 0;
      return () => (++n === 1 ? randomUUID() : duplicate);
    }
    const uniqueViolation = (error: unknown) => (error as { code?: unknown }).code === "P2002";

    it("rolls back the transaction, decision and allocations when the SUCCESS audit insert fails", async () => {
      const before = await counts();
      const persistence = createPrismaTransactionPersistence(prisma, { newId: idsThenDuplicate(await existingAuditId()) });
      await assert.rejects(persistence.saveRouted(routedInput()), uniqueViolation);
      assert.deepEqual(await counts(), before);
    });

    it("rolls back the failed transaction when the FAILED audit insert fails", async () => {
      const before = await counts();
      const persistence = createPrismaTransactionPersistence(prisma, { newId: idsThenDuplicate(await existingAuditId()) });
      await assert.rejects(
        persistence.saveFailed({
          userId: "it-analyst",
          requestId: "it-direct",
          request: validated(),
          failureCode: "INFERENCE_ERROR",
        }),
        uniqueViolation,
      );
      assert.deepEqual(await counts(), before);
    });

    it("rolls back the transaction and decision when an allocation insert fails", async () => {
      const before = await counts();
      const input = routedInput();
      const duplicateSlot = { ...input, allocations: [input.allocations[0]!, input.allocations[0]!] };
      await assert.rejects(createPrismaTransactionPersistence(prisma).saveRouted(duplicateSlot), uniqueViolation);
      assert.deepEqual(await counts(), before);
    });

    it("saves nothing when the User row is missing at write time", async () => {
      const before = await counts();
      await assert.rejects(createPrismaTransactionPersistence(prisma).saveRouted({ ...routedInput(), userId: "it-unseeded" }));
      assert.deepEqual(await counts(), before);
    });
  });

  describe("GET /api/v1/transactions/:id/explanation (PostgreSQL)", () => {
    async function explanationCounts(): Promise<{ explanations: number; audits: number }> {
      return {
        explanations: await prisma.explanation.count(),
        audits: await prisma.auditLog.count({ where: { action: "EXPLANATION_CREATE" } }),
      };
    }

    async function explain(
      id: string,
      { answer = { status: 200, body: engineExplainResponse() } as MockResponse | undefined, store }:
        { answer?: MockResponse | undefined; store?: ExplanationStore } = {},
    ): Promise<{ status: number; body: Record<string, any>; inferenceCalls: number }> {
      let inferenceCalls = 0;
      const inferenceClient = createInferenceClient(
        { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
        { logger: silentLogger, mockHandler: () => (inferenceCalls++, answer) },
      );
      const app = createApp({
        logger: silentLogger,
        users,
        inferenceClient,
        explanations: store ?? createPrismaExplanationStore(prisma),
      });
      const server = await startServer(app);
      try {
        const res = await fetch(`${server.baseUrl}/api/v1/transactions/${id}/explanation`, {
          headers: { Authorization: `Bearer ${token}`, "X-Request-Id": "it-explain" },
        });
        return { status: res.status, body: (await res.json()) as Record<string, any>, inferenceCalls };
      } finally {
        await server.close();
      }
    }

    it("stores the first explanation with one audit row, and returns it on repeat without inference", async () => {
      const posted = await post({ status: 200, body: engineRouteResponse() });
      const before = await explanationCounts();
      const first = await explain(posted.body.id);
      assert.equal(first.status, 200);
      assert.equal(first.body.transactionId, posted.body.id);
      assert.deepEqual(await explanationCounts(), { explanations: before.explanations + 1, audits: before.audits + 1 });
      const decision = await prisma.routingDecision.findUniqueOrThrow({
        where: { transactionId: posted.body.id },
        include: { explanation: true },
      });
      assert.deepEqual(decision.explanation?.engineResponse, engineExplainResponse());
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: decision.explanation!.id } });
      assert.equal(audit.entityType, "Explanation");
      assert.equal(audit.outcome, "SUCCESS");
      assert.equal(audit.requestId, "it-explain");
      assert.equal(audit.at.getTime(), decision.explanation!.createdAt.getTime());

      const repeat = await explain(posted.body.id, { answer: undefined });
      assert.equal(repeat.status, 200);
      assert.equal(repeat.inferenceCalls, 0);
      assert.deepEqual(repeat.body, first.body);
      assert.deepEqual(await explanationCounts(), { explanations: before.explanations + 1, audits: before.audits + 1 });
    });

    it("stores one explanation and one audit row for concurrent first requests", async () => {
      const posted = await post({ status: 200, body: engineRouteResponse() });
      const before = await explanationCounts();
      const real = createPrismaExplanationStore(prisma);
      // Both requests pass the "no stored explanation" read before either saves.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let arrived = 0;
      const gated: ExplanationStore = {
        ...real,
        async save(input) {
          if (++arrived === 2) release();
          await gate;
          return real.save(input);
        },
      };
      const [a, b] = await Promise.all([explain(posted.body.id, { store: gated }), explain(posted.body.id, { store: gated })]);
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);
      assert.deepEqual(a.body, b.body);
      assert.deepEqual(await explanationCounts(), { explanations: before.explanations + 1, audits: before.audits + 1 });
    });

    it("stores nothing for a failed transaction, a decision mismatch or an inference error", async () => {
      const failed = await post({ status: 500, body: engineError("INTERNAL_ERROR") });
      const routed = await post({ status: 200, body: engineRouteResponse() });
      const before = await explanationCounts();
      const failedRes = await explain(failed.body.error.details.transactionId);
      assert.equal(failedRes.status, 409);
      assert.equal(failedRes.body.error.code, "TRANSACTION_FAILED");
      assert.equal(failedRes.inferenceCalls, 0);
      const mismatch = await explain(routed.body.id, {
        answer: { status: 200, body: engineExplainResponse({ decision_id: "sha256:other" }) },
      });
      assert.equal(mismatch.body.error.code, "DECISION_MISMATCH");
      const busy = await explain(routed.body.id, { answer: { status: 503, body: engineError("ENGINE_BUSY") } });
      assert.equal(busy.body.error.code, "ENGINE_BUSY");
      assert.deepEqual(await explanationCounts(), before);
    });

    it("rolls back the Explanation when its audit insert fails", async () => {
      const routed = await post({ status: 200, body: engineRouteResponse() });
      const decision = await prisma.routingDecision.findUniqueOrThrow({ where: { transactionId: routed.body.id } });
      const duplicateAuditId = (await prisma.auditLog.findFirstOrThrow()).id;
      let n = 0;
      const store = createPrismaExplanationStore(prisma, { newId: () => (++n === 1 ? randomUUID() : duplicateAuditId) });
      const before = await explanationCounts();
      await assert.rejects(
        store.save({ routingDecisionId: decision.id, engineResponse: engineExplainResponse(), userId: "it-analyst", requestId: "it" }),
        (error: unknown) => (error as { code?: unknown }).code === "P2002",
      );
      assert.deepEqual(await explanationCounts(), before);
    });
  });
});
