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
import { createPrismaDashboardRepository, type DashboardRepository } from "../../src/db/dashboard.js";
import { createPrismaComparisonStore, type ComparisonStore, type NewComparison } from "../../src/db/comparisons.js";
import { createPrismaExplanationStore, type ExplanationStore } from "../../src/db/explanations.js";
import { createInferenceClient, type InferenceRequest, type MockResponse } from "../../src/inferenceClient/client.js";
import { mapRouteResponse } from "../../src/mappers/routeResponse.js";
import { DASHBOARD_NOTE } from "../../src/routes/dashboard.js";
import { FAILURE_MESSAGES } from "../../src/routes/transactions.js";
import { validateTransactionRequest, type TransactionRequest } from "../../src/validation/transactionRequest.js";
import {
  comparisonBody,
  ENGINE_SKIP_MESSAGE,
  engineCompareResponse,
  engineResult,
  engineSkipped,
  type EnginePolicy,
} from "../helpers/comparisons.js";
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

/*
 * Doubles that need all 17 significant digits, taken from a real engine response
 * (GBR->PHL, 300000, replay 2024-06-14).
 *
 * The round-trip tests below depend on them. Prisma's Json serialisation rounds every
 * double to 16 significant digits, which moves each of these by one unit in the last
 * place, so a stored record stopped matching the body the API had returned (§3.4, §3.6,
 * §3.5, and the §6.1 rule that the inference response is stored verbatim). The other
 * fixtures use round decimals such as 150000.0 and 0.5, which survive that rounding
 * unchanged, which is why they never caught it.
 *
 * Every total stays exact: the two amounts sum to 300000.0 and the two shares to 1.0.
 */
const PRECISE = {
  /** Only here so the two shares still sum to exactly 1.0; it fits in 16 digits. */
  share0: 0.5440011024475098,
  share1: 0.45599889755249023,
  amount0: 163200.33073425293,
  amount1: 136799.66926574707,
  costTerm: 1.8827359927571405,
  latencyTerm: 3.4453462330645177,
  reward: -1.5626102406404494,
  baselineCostPct: 0.061200000000000004,
};

/** The values that carry the test: each is changed by a round trip through 16 digits. */
const SEVENTEEN_DIGIT_KEYS = ["share1", "amount0", "amount1", "costTerm", "latencyTerm", "reward", "baselineCostPct"] as const;

/** True when a 16-significant-digit round trip would move the value, as Prisma's did. */
function needsSeventeenDigits(value: number): boolean {
  return Number(value.toPrecision(16)) !== value;
}

/**
 * A /v1/route-shaped body with PRECISE substituted into the allocations and metrics,
 * keeping the totals consistent with them.
 */
function withPreciseNumbers(body: Record<string, unknown>): Record<string, unknown> {
  const allocations = (body.allocations as Array<Record<string, unknown>>).map((allocation, index) => {
    if (index > 1) return { ...allocation };
    const share = index === 0 ? PRECISE.share0 : PRECISE.share1;
    const amount = index === 0 ? PRECISE.amount0 : PRECISE.amount1;
    return { ...allocation, share_requested: share, amount_requested_usd: amount, amount_executed_usd: amount };
  });
  return {
    ...body,
    allocations,
    totals: { ...(body.totals as Record<string, unknown>), requested_usd: 300000.0, executed_usd: 300000.0 },
    metrics: {
      ...(body.metrics as Record<string, unknown>),
      cost_term: PRECISE.costTerm,
      latency_term: PRECISE.latencyTerm,
      reward_env: PRECISE.reward,
      reward_amount_based: PRECISE.reward,
      baseline_cost_pct: PRECISE.baselineCostPct,
    },
  };
}

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

    // D1: the engine's numbers must survive the round trip through the database.
    it("returns the engine's numbers unchanged when they need all 17 significant digits (§3.4, §6.1)", async () => {
      for (const key of SEVENTEEN_DIGIT_KEYS) {
        assert.ok(needsSeventeenDigits(PRECISE[key]), `${key} must need the 17th digit for this test to mean anything`);
      }
      // The totals the fixture states must still be reachable from the shares and amounts.
      assert.equal(PRECISE.amount0 + PRECISE.amount1, 300000.0);
      assert.equal(PRECISE.share0 + PRECISE.share1, 1.0);
      const engine = withPreciseNumbers(engineRouteResponse());
      const posted = await post({ status: 200, body: engine });
      assert.equal(posted.status, 201, JSON.stringify(posted.body));

      const got = await getById(posted.body.id);
      assert.equal(got.status, 200);
      // Every value, compared strictly: deepStrictEqual uses SameValue on numbers, so a
      // one-ulp difference fails it. Not a text comparison — jsonb does not preserve key
      // order, so the stored record serialises its keys in a different order than the 201
      // body did, with the same values. That ordering is PostgreSQL's and is not a defect.
      assert.deepEqual(got.body, posted.body);

      // And the exact doubles, named, so a failure says which value moved.
      const allocations = got.body.decision.allocations as Array<Record<string, number>>;
      assert.equal(allocations[0]!.amountRequestedUsd, PRECISE.amount0);
      assert.equal(allocations[0]!.amountExecutedUsd, PRECISE.amount0);
      assert.equal(allocations[1]!.amountRequestedUsd, PRECISE.amount1);
      assert.equal(allocations[1]!.shareRequested, PRECISE.share1);
      assert.equal(got.body.decision.metrics.costTerm, PRECISE.costTerm);
      assert.equal(got.body.decision.metrics.latencyTerm, PRECISE.latencyTerm);
      assert.equal(got.body.decision.metrics.rewardAmountBased, PRECISE.reward);
      assert.equal(got.body.decision.metrics.baselineCostPct, PRECISE.baselineCostPct);

      // The stored jsonb itself, so this cannot pass by both sides being rounded alike.
      const row = await prisma.routingDecision.findFirstOrThrow({ where: { transactionId: posted.body.id } });
      const stored = row.engineResponse as { allocations: Array<Record<string, number>>; metrics: Record<string, number> };
      assert.equal(stored.allocations[0]!.amount_executed_usd, PRECISE.amount0);
      assert.equal(stored.metrics.reward_amount_based, PRECISE.reward);
      assert.deepEqual(stored, engine);
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

    // D1: the first explanation comes from the engine and every later one is read back
    // from the stored row, so the two must agree to the last digit (§3.5, §6.1).
    it("returns the same explanation on the first and later requests when a value needs 17 digits", async () => {
      const base = engineExplainResponse();
      const feasibility = base.feasibility as Record<string, unknown>;
      const facts = (feasibility.active_facts as Array<Record<string, unknown>>).map((fact) => ({
        ...fact,
        value: PRECISE.amount0,
      }));
      const engine = { ...base, feasibility: { ...feasibility, active_facts: facts } };

      const posted = await post({ status: 200, body: engineRouteResponse() });
      const first = await explain(posted.body.id, { answer: { status: 200, body: engine } });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.inferenceCalls, 1);

      // No answer at all: a second call must be served from the stored row.
      const second = await explain(posted.body.id, { answer: undefined });
      assert.equal(second.status, 200);
      assert.equal(second.inferenceCalls, 0);
      // The explain mapper rebuilds the body with its own key order, so here the text does
      // match; the values are what matter either way.
      assert.deepEqual(second.body, first.body);
      assert.equal(second.body.feasibility.activeFacts[0].value, PRECISE.amount0);

      const stored = await prisma.explanation.findFirstOrThrow();
      const row = stored.engineResponse as { feasibility: { active_facts: Array<{ value: number }> } };
      assert.equal(row.feasibility.active_facts[0]!.value, PRECISE.amount0);
    });

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

// GET /api/v1/dashboard/summary (API contract §3.8). In this file, not its own,
// because it empties the same tables and node --test runs files in parallel.
describe("GET /api/v1/dashboard/summary (PostgreSQL integration)", { skip }, () => {
  let prisma: PrismaClient;
  let dashboard: DashboardRepository;
  const analystToken = newToken();
  const viewerToken = newToken();
  const users: DevUser[] = [
    { userId: "it-analyst", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
    { userId: "it-viewer", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
  ];
  const PATH = "/api/v1/dashboard/summary";

  // Every row in one day, plus one at the next midnight for the exclusive `to`.
  // A null fee, reward, latency or risk is a legacy row saved before metrics
  // were required.
  type Row = {
    n: number;
    at: string;
    policy: Policy;
    corridor?: string;
    decision?: {
      allowed: boolean;
      completed: boolean;
      executedUsd: number;
      feeCostUsd: number | null;
      rewardAmountBased: number | null;
      latencyTerm: number | null;
      riskTerm: number | null;
    };
  };
  const rows: Row[] = [
    { n: 1, at: "2026-11-01T10:00:00.000Z", policy: "waterfall", corridor: "GBR->PHL",
      decision: { allowed: true, completed: true, executedUsd: 1000, feeCostUsd: 15, rewardAmountBased: -0.2, latencyTerm: 0.3, riskTerm: 0 } },
    { n: 2, at: "2026-11-01T11:00:00.000Z", policy: "waterfall", corridor: "GBR->PHL",
      decision: { allowed: true, completed: false, executedUsd: 500, feeCostUsd: 10, rewardAmountBased: -0.4, latencyTerm: 0.1, riskTerm: 0.1 } },
    // Regulatory rejection: excluded from allowedRouted, completionRate and every mean.
    { n: 3, at: "2026-11-01T12:00:00.000Z", policy: "waterfall", corridor: "GBR->PHL",
      decision: { allowed: false, completed: false, executedUsd: 0, feeCostUsd: 0, rewardAmountBased: -1, latencyTerm: 0, riskTerm: 0 } },
    { n: 4, at: "2026-11-01T13:00:00.000Z", policy: "waterfall" }, // failed
    // Allowed but nothing executed: counts in the means, not in meanFeeCostPct.
    { n: 5, at: "2026-11-01T14:00:00.000Z", policy: "cheapestFeasible", corridor: "USA->IND",
      decision: { allowed: true, completed: false, executedUsd: 0, feeCostUsd: 0, rewardAmountBased: -0.9, latencyTerm: 0.2, riskTerm: 0.05 } },
    // Legacy NULLs: skipped by each mean (approved rule), not treated as 0.
    { n: 6, at: "2026-11-01T15:00:00.000Z", policy: "ppoProjected", corridor: "ARE->MEX",
      decision: { allowed: true, completed: true, executedUsd: 2000, feeCostUsd: null, rewardAmountBased: null, latencyTerm: 0.4, riskTerm: null } },
    { n: 7, at: "2026-11-01T16:00:00.000Z", policy: "ppoProjected", corridor: "ARE->MEX",
      decision: { allowed: true, completed: true, executedUsd: 1000, feeCostUsd: 20, rewardAmountBased: -0.3, latencyTerm: 0.2, riskTerm: 0 } },
    { n: 8, at: "2026-11-02T00:00:00.000Z", policy: "ppoProjected" }, // failed
  ];
  const uuid = (n: number) => `00000000-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;

  async function truncate(): Promise<void> {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  }

  type Reply = { status: number; headers: Headers; text: string; body: Record<string, any> };
  async function call(
    query = "",
    init: { method?: string; headers?: Record<string, string> } = { headers: { Authorization: `Bearer ${viewerToken}` } },
  ): Promise<Reply> {
    const server = await startServer(createApp({ logger: silentLogger, users, dashboard }));
    try {
      const res = await fetch(`${server.baseUrl}${PATH}${query}`, init);
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: text === "" ? {} : JSON.parse(text) };
    } finally {
      await server.close();
    }
  }
  async function summary(query = ""): Promise<Record<string, any>> {
    const res = await call(query);
    assert.equal(res.status, 200, res.text);
    return res.body;
  }

  /** deepEqual with key order, numbers compared to 1e-12 (PostgreSQL may sum in another order). */
  function close(got: unknown, want: unknown, path = "body"): void {
    if (typeof want === "number") {
      assert.equal(typeof got, "number", path);
      assert.ok(Math.abs((got as number) - want) < 1e-12, `${path}: ${String(got)} vs ${want}`);
    } else if (want !== null && typeof want === "object") {
      assert.ok(got !== null && typeof got === "object", path);
      assert.deepEqual(Object.keys(got as object), Object.keys(want), path);
      for (const key of Object.keys(want)) close((got as never)[key], (want as never)[key], `${path}.${key}`);
    } else {
      assert.equal(got, want, path);
    }
  }
  const mean = (...xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const ZERO = { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 };

  before(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const [schema] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('"TransactionRequest"') IS NOT NULL AS exists`;
    if (!schema?.exists) throw new Error("The test database has no schema; run `prisma migrate deploy` against it first");
    dashboard = createPrismaDashboardRepository(prisma);
    await truncate();
    await prisma.user.createMany({
      data: [
        { id: "it-analyst", email: "analyst@example.test", role: "analyst" },
        { id: "it-viewer", email: "viewer@example.test", role: "viewer" },
      ],
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    try {
      await truncate();
    } finally {
      await prisma.$disconnect();
    }
  });

  describe("empty database", () => {
    it("returns zero totals, empty groups and null window bounds", async () => {
      assert.deepEqual(await summary(), {
        window: { from: null, to: null },
        totals: ZERO,
        byPolicy: [],
        byCorridor: [],
        note: DASHBOARD_NOTE,
      });
    });

    it("does the same with every filter set", async () => {
      const body = await summary("?from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z&corridor=GBR->PHL&policy=waterfall");
      assert.deepEqual(body, {
        window: { from: "2026-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z" },
        totals: ZERO,
        byPolicy: [],
        byCorridor: [],
        note: DASHBOARD_NOTE,
      });
    });
  });

  describe("seeded", () => {
    before(async () => {
      for (const row of rows) {
        const d = row.decision;
        await prisma.transactionRequest.create({
          data: {
            id: uuid(row.n),
            createdAt: new Date(row.at),
            createdById: "it-analyst",
            senderCountry: "GBR",
            receiverCountry: "PHL",
            corridor: row.corridor ?? null,
            amountUsd: 1000,
            stateMode: "historicalReplay",
            stateSpec: { test: true },
            simulationDate: new Date("2024-06-14T00:00:00Z"),
            requestedPolicy: row.policy,
            status: d === undefined ? "failed" : "routed",
            ...(d !== undefined && {
              decision: {
                create: {
                  decisionId: "sha256:test",
                  policy: row.policy,
                  policyStatus: "default",
                  allowed: d.allowed,
                  completed: d.completed,
                  completionRatio: d.completed ? 1 : 0,
                  executedUsd: d.executedUsd,
                  unroutedEnvUsd: 0,
                  unroutedAmountBasedUsd: 0,
                  rewardAmountBased: d.rewardAmountBased,
                  latencyTerm: d.latencyTerm,
                  riskTerm: d.riskTerm,
                  feeCostUsd: d.feeCostUsd,
                  valuesProvenance: "synthetic_simulation",
                  stateFrameSha256: "test",
                  knowledgeSha256: "test",
                  gitCommit: "test",
                  engineResponse: { test: true },
                  // An allocation that disagrees with the decision: never read (§3.8).
                  allocations: {
                    create: [
                      {
                        slot: 0,
                        bridgeUid: "b",
                        shareRequested: 1,
                        amountRequestedUsd: 9e9,
                        amountExecutedUsd: 9e9,
                        amountClippedUsd: 0,
                        liquidityUsd: 9e9,
                        congestion: 0,
                        risk: 0,
                      },
                    ],
                  },
                },
              },
            }),
          },
        });
      }
      // A comparison in the window: never counted (§3.6, §3.8).
      await prisma.comparison.create({
        data: {
          createdAt: new Date("2026-11-01T12:30:00Z"),
          createdById: "it-analyst",
          senderCountry: "GBR",
          receiverCountry: "PHL",
          corridor: "GBR->PHL",
          amountUsd: 1000,
          simulationDate: new Date("2024-06-14T00:00:00Z"),
          stateMode: "historicalReplay",
          stateSpec: { test: true },
          policies: ["waterfall"],
          engineResponse: { test: true },
        },
      });
    });

    const waterfall = {
      policy: "waterfall",
      count: 4, // routed, rejected and failed alike
      allowedRouted: 2,
      completionRate: 0.5,
      meanRewardAmountBased: mean(-0.2, -0.4),
      meanFeeCostPct: 100 * mean(15 / 1000, 10 / 500),
      meanLatencyTerm: mean(0.3, 0.1),
      meanRiskTerm: mean(0, 0.1),
    };
    const cheapest = {
      policy: "cheapestFeasible",
      count: 1,
      allowedRouted: 1,
      completionRate: 0,
      meanRewardAmountBased: -0.9,
      meanFeeCostPct: null, // its only allowed decision executed nothing
      meanLatencyTerm: 0.2,
      meanRiskTerm: 0.05,
    };
    const ppo = {
      policy: "ppoProjected",
      count: 3,
      allowedRouted: 2,
      completionRate: 1,
      meanRewardAmountBased: -0.3, // row 6's NULL skipped
      meanFeeCostPct: 100 * (20 / 1000), // row 6's NULL fee skipped
      meanLatencyTerm: mean(0.4, 0.2),
      meanRiskTerm: 0, // row 6's NULL skipped
    };

    it("aggregates every stored transaction with the §3.8 formulas", async () => {
      close(await summary(), {
        window: { from: null, to: null },
        totals: { transactions: 8, routed: 6, failed: 2, rejectedByFeasibility: 1 },
        byPolicy: [waterfall, cheapest, ppo],
        byCorridor: [
          { corridor: "ARE->MEX", routed: 2, allowedRouted: 2, completionRate: 1 },
          { corridor: "GBR->PHL", routed: 3, allowedRouted: 2, completionRate: 0.5 },
          { corridor: "USA->IND", routed: 1, allowedRouted: 1, completionRate: 0 },
        ],
        note: DASHBOARD_NOTE,
      });
    });

    it("returns the same body to a viewer and an analyst", async () => {
      const viewer = await call("", { headers: { Authorization: `Bearer ${viewerToken}` } });
      const analyst = await call("", { headers: { Authorization: `Bearer ${analystToken}` } });
      assert.equal(viewer.status, 200);
      assert.equal(analyst.status, 200);
      assert.deepEqual(viewer.body, analyst.body);
    });

    it("gives null completionRate and null means for a group with no allowed routed decision", async () => {
      // Only row 3 (rejected) and row 4 (failed).
      close(await summary("?from=2026-11-01T12:00:00Z&to=2026-11-01T14:00:00Z"), {
        window: { from: "2026-11-01T12:00:00Z", to: "2026-11-01T14:00:00Z" },
        totals: { transactions: 2, routed: 1, failed: 1, rejectedByFeasibility: 1 },
        byPolicy: [
          {
            policy: "waterfall",
            count: 2,
            allowedRouted: 0,
            completionRate: null,
            meanRewardAmountBased: null,
            meanFeeCostPct: null,
            meanLatencyTerm: null,
            meanRiskTerm: null,
          },
        ],
        byCorridor: [{ corridor: "GBR->PHL", routed: 1, allowedRouted: 0, completionRate: null }],
        note: DASHBOARD_NOTE,
      });
    });

    it("treats from as inclusive and to as exclusive, echoing each bound as sent", async () => {
      const window = await summary("?from=2026-11-01T11:00:00Z&to=2026-11-02T00:00:00Z");
      assert.deepEqual(window.window, { from: "2026-11-01T11:00:00Z", to: "2026-11-02T00:00:00Z" });
      assert.deepEqual(window.totals, { transactions: 6, routed: 5, failed: 1, rejectedByFeasibility: 1 }); // rows 2-7
      const plusOne = await summary("?to=2026-11-02T00:00:00.001Z");
      assert.deepEqual(plusOne.window, { from: null, to: "2026-11-02T00:00:00.001Z" });
      assert.equal(plusOne.totals.transactions, 8);
      const justAfter = await summary("?from=2026-11-01T10:00:00.001Z");
      assert.deepEqual(justAfter.window, { from: "2026-11-01T10:00:00.001Z", to: null });
      assert.equal(justAfter.totals.transactions, 7);
      const empty = await summary("?from=2026-11-01T11:00:00Z&to=2026-11-01T11:00:00Z");
      assert.deepEqual(empty.totals, ZERO);
      assert.deepEqual(empty.byPolicy, []);
      assert.deepEqual(empty.byCorridor, []);
    });

    it("filters by corridor on the stored corridor, so failed rows never match", async () => {
      close(await summary("?corridor=GBR->PHL"), {
        window: { from: null, to: null },
        totals: { transactions: 3, routed: 3, failed: 0, rejectedByFeasibility: 1 },
        byPolicy: [{ ...waterfall, count: 3 }],
        byCorridor: [{ corridor: "GBR->PHL", routed: 3, allowedRouted: 2, completionRate: 0.5 }],
        note: DASHBOARD_NOTE,
      });
    });

    it("filters by requested policy, failed rows included", async () => {
      close(await summary("?policy=ppoProjected"), {
        window: { from: null, to: null },
        totals: { transactions: 3, routed: 2, failed: 1, rejectedByFeasibility: 0 },
        byPolicy: [ppo],
        byCorridor: [{ corridor: "ARE->MEX", routed: 2, allowedRouted: 2, completionRate: 1 }],
        note: DASHBOARD_NOTE,
      });
    });

    it("combines filters", async () => {
      const body = await summary("?policy=waterfall&corridor=USA->IND");
      assert.deepEqual(body.totals, ZERO);
      assert.deepEqual(body.byPolicy, []);
      assert.deepEqual(body.byCorridor, []);
    });

    it("returns 401 without a token, 422 for a bad query, HEAD 200 with no body and 405 for POST", async () => {
      assert.equal((await call("", {})).status, 401);
      const invalid = await call("?from=2026-11-02T00:00:00Z&to=2026-11-01T00:00:00Z");
      assert.equal(invalid.status, 422);
      assert.equal(invalid.body.error.code, "VALIDATION_ERROR");
      const head = await call("", { method: "HEAD", headers: { Authorization: `Bearer ${viewerToken}` } });
      assert.equal(head.status, 200);
      assert.equal(head.text, "");
      // Authentication comes first (§10 Q14): 401 without a token, 405 with one.
      assert.equal((await call("", { method: "POST" })).status, 401);
      const post = await call("", { method: "POST", headers: { Authorization: `Bearer ${viewerToken}` } });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get("allow"), "GET, HEAD");
    });

    it("writes nothing", async () => {
      const counts = async () => ({
        transactions: await prisma.transactionRequest.count(),
        decisions: await prisma.routingDecision.count(),
        audits: await prisma.auditLog.count(),
      });
      const before = await counts();
      await summary();
      assert.deepEqual(await counts(), before);
    });
  });
});

// POST /api/v1/comparisons and GET /api/v1/comparisons/:id (API contract §3.6,
// §6.2; owner decisions Q18). In this file, not its own, because it empties the same tables and
// node --test runs files in parallel.
describe("comparisons (PostgreSQL integration)", { skip }, () => {
  let prisma: PrismaClient;
  const analystToken = newToken();
  const viewerToken = newToken();
  // A valid token whose user was never seeded: no User row.
  const unseededToken = newToken();
  const users: DevUser[] = [
    { userId: "it-analyst", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
    { userId: "it-viewer", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
    { userId: "it-unseeded", email: "unseeded@example.test", role: "analyst", tokenSha256: sha256Hex(unseededToken) },
  ];
  const CHECKPOINT = "a".repeat(64);

  type Answer = MockResponse | undefined | ((request: Readonly<InferenceRequest>) => MockResponse | undefined);
  type Answers = Partial<Record<string, Answer>>;

  /** Every requested policy answered with a result; ppo_projected from an approved checkpoint. */
  const allResults: Answer = (request) => ({
    status: 200,
    body: engineCompareResponse(
      (request.body!.policies as EnginePolicy[]).map((policy) =>
        engineResult(policy, { checkpointSha256: policy === "ppo_projected" ? CHECKPOINT : null }),
      ),
    ),
  });
  /** ppo_projected disabled: skipped by the engine, the others answered. */
  const ppoSkipped: Answer = (request) => {
    const policies = request.body!.policies as EnginePolicy[];
    return {
      status: 200,
      body: engineCompareResponse(
        policies.filter((p) => p !== "ppo_projected").map((p) => engineResult(p)),
        policies.filter((p) => p === "ppo_projected").map((p) => engineSkipped(p)),
      ),
    };
  };
  const ENABLED: Answers = { "/v1/compare": allResults };
  const DISABLED: Answers = { "/v1/compare": ppoSkipped };

  async function truncate(): Promise<void> {
    await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.join(", ")} CASCADE`);
  }

  async function counts(): Promise<Record<string, number>> {
    return {
      comparisons: await prisma.comparison.count(),
      audits: await prisma.auditLog.count(),
      transactions: await prisma.transactionRequest.count(),
      decisions: await prisma.routingDecision.count(),
      allocations: await prisma.allocation.count(),
    };
  }

  interface CallOptions {
    method?: string;
    body?: Record<string, unknown>;
    token?: string;
    answers?: Answers;
    store?: ComparisonStore;
  }

  async function call(
    path: string,
    { method = "GET", body, token = analystToken, answers = ENABLED, store = createPrismaComparisonStore(prisma) }: CallOptions = {},
  ): Promise<{ status: number; body: Record<string, any>; compareCalls: number; paths: string[] }> {
    let compareCalls = 0;
    const paths: string[] = [];
    const inferenceClient = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      {
        logger: silentLogger,
        mockHandler: (request: Readonly<InferenceRequest>) => {
          paths.push(request.path);
          if (request.path === "/v1/compare") compareCalls += 1;
          const answer = answers[request.path];
          return typeof answer === "function" ? answer(request) : answer;
        },
      },
    );
    const app = createApp({
      logger: silentLogger,
      users,
      inferenceClient,
      comparisons: store,
      transactions: createPrismaTransactionRepository(prisma),
    });
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "X-Request-Id": "it-compare",
          ...(body !== undefined && { "Content-Type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any>, compareCalls, paths };
    } finally {
      await server.close();
    }
  }
  const post = (body: Record<string, unknown>, options: CallOptions = {}) =>
    call("/api/v1/comparisons", { method: "POST", body, ...options });

  function directInput(overrides: Partial<NewComparison> = {}): NewComparison {
    return {
      userId: "it-analyst",
      requestId: "it-direct",
      request: {
        senderCountry: "GBR",
        receiverCountry: "PHL",
        amountUsd: 300000.0,
        state: { mode: "historicalReplay", date: "2024-06-14" },
        policies: ["waterfall"],
        clientReference: null,
      },
      corridor: "GBR->PHL",
      engineResponse: engineCompareResponse([engineResult("waterfall")]),
      ...overrides,
    };
  }

  before(async () => {
    prisma = new PrismaClient({ datasourceUrl: url });
    const [schema] = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT to_regclass('"Comparison"') IS NOT NULL AS exists`;
    if (!schema?.exists) throw new Error("The test database has no schema; run `prisma migrate deploy` against it first");
    await truncate();
    await prisma.user.createMany({
      data: [
        { id: "it-analyst", email: "analyst@example.test", role: "analyst" },
        { id: "it-viewer", email: "viewer@example.test", role: "viewer" },
      ],
    });
  });

  after(async () => {
    if (prisma === undefined) return;
    try {
      await truncate();
    } finally {
      await prisma.$disconnect();
    }
  });

  it("saves the comparison and one SUCCESS audit row, and no transaction, decision or allocation", async () => {
    const before = await counts();
    const body = comparisonBody({ policies: ["ppoProjected", "waterfall", "cheapestFeasible"], clientReference: null });
    const res = await post(body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(await counts(), { ...before, comparisons: before.comparisons! + 1, audits: before.audits! + 1 });

    const row = await prisma.comparison.findUniqueOrThrow({ where: { id: res.body.id } });
    assert.equal(row.createdById, "it-analyst");
    assert.equal(row.createdAt.toISOString(), res.body.createdAt);
    assert.equal(row.senderCountry, "GBR");
    assert.equal(row.receiverCountry, "PHL");
    assert.equal(row.corridor, "GBR->PHL");
    assert.equal(row.amountUsd, 300000.0);
    assert.equal(row.simulationDate.toISOString(), "2024-06-14T00:00:00.000Z");
    assert.equal(row.clientReference, null);
    assert.equal(row.stateMode, "historicalReplay");
    assert.deepEqual(row.stateSpec, { mode: "historicalReplay", date: "2024-06-14" });
    // The array column keeps the caller's order.
    assert.deepEqual(row.policies, ["ppoProjected", "waterfall", "cheapestFeasible"]);
    // The /v1/compare body, verbatim (jsonb doesn't keep key order, so compared by value).
    assert.deepEqual(
      row.engineResponse,
      engineCompareResponse([
        engineResult("ppo_projected", { checkpointSha256: CHECKPOINT }),
        engineResult("waterfall"),
        engineResult("cheapest_feasible"),
      ]),
    );

    const audits = await prisma.auditLog.findMany({ where: { entityId: res.body.id } });
    assert.equal(audits.length, 1);
    const { id: _id, ...audit } = audits[0]!;
    assert.deepEqual(audit, {
      at: row.createdAt,
      userId: "it-analyst",
      action: "COMPARISON_CREATE",
      requestId: "it-compare",
      entityType: "Comparison",
      entityId: res.body.id,
      outcome: "SUCCESS",
    });
  });

  it("returns a stored comparison exactly as the POST returned it, to any role, writing nothing", async () => {
    const posted = await post(comparisonBody({ policies: ["ppoProjected", "waterfall"] }));
    assert.equal(posted.status, 201, JSON.stringify(posted.body));
    assert.deepEqual(posted.body.policies, ["ppoProjected", "waterfall"]);
    assert.deepEqual(posted.body.results.map((r: { policy: string }) => r.policy), ["ppoProjected", "waterfall"]);
    assert.deepEqual(posted.body.state, { mode: "historicalReplay", date: "2024-06-14" });

    const before = await counts();
    for (const token of [analystToken, viewerToken]) {
      // No inference answers: the read never calls the engine or /v1/version.
      const got = await call(`/api/v1/comparisons/${posted.body.id}`, { token, answers: {} });
      assert.equal(got.status, 200);
      assert.deepEqual(got.body, posted.body);
    }
    const upper = await call(`/api/v1/comparisons/${String(posted.body.id).toUpperCase()}`);
    assert.equal(upper.status, 200);
    assert.deepEqual(await counts(), before);
  });

  // D1: the same round trip for a comparison record (§3.6).
  it("returns a stored comparison with the engine's 17-significant-digit numbers unchanged (§3.6, §6.1)", async () => {
    const precise: Answers = {
      "/v1/compare": (request) => ({
        status: 200,
        body: engineCompareResponse(
          (request.body!.policies as EnginePolicy[]).map((policy) => withPreciseNumbers(engineResult(policy))),
        ),
      }),
    };
    const posted = await post(comparisonBody({ policies: ["waterfall", "cheapestFeasible"] }), { answers: precise });
    assert.equal(posted.status, 201, JSON.stringify(posted.body));

    const got = await call(`/api/v1/comparisons/${posted.body.id}`, { answers: {} });
    assert.equal(got.status, 200);
    // Strictly on values, not on text: jsonb does not preserve key order (see the
    // transaction round-trip test above).
    assert.deepEqual(got.body, posted.body);

    for (const result of got.body.results as Array<Record<string, any>>) {
      assert.equal(result.allocations[0].amountExecutedUsd, PRECISE.amount0);
      assert.equal(result.allocations[1].shareRequested, PRECISE.share1);
      assert.equal(result.metrics.rewardAmountBased, PRECISE.reward);
    }

    const row = await prisma.comparison.findUniqueOrThrow({ where: { id: posted.body.id } });
    const stored = row.engineResponse as { results: Array<Record<string, any>> };
    assert.equal(stored.results[0]!.allocations[0].amount_executed_usd, PRECISE.amount0);
    assert.equal(stored.results[0]!.metrics.reward_amount_based, PRECISE.reward);
  });

  it("uses the default list for an omitted policies, by role, and stores the list sent", async () => {
    const analyst = await post(comparisonBody());
    assert.equal(analyst.status, 201, JSON.stringify(analyst.body));
    assert.deepEqual(analyst.body.policies, ["waterfall", "cheapestFeasible", "ppoProjected"]);
    const viewer = await post(comparisonBody(), { token: viewerToken });
    assert.equal(viewer.status, 201, JSON.stringify(viewer.body));
    assert.deepEqual(viewer.body.policies, ["waterfall", "cheapestFeasible"]);
    assert.equal(viewer.body.createdBy, "it-viewer");

    const rows = await prisma.comparison.findMany({ where: { id: { in: [analyst.body.id, viewer.body.id] } } });
    const stored = new Map(rows.map((row) => [row.id, row.policies]));
    assert.deepEqual(stored.get(analyst.body.id), ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(stored.get(viewer.body.id), ["waterfall", "cheapestFeasible"]);
  });

  it("saves a comparison with a skipped policy, and one with every policy skipped (corridor NULL)", async () => {
    const partial = await post(comparisonBody(), { answers: DISABLED });
    assert.equal(partial.status, 201, JSON.stringify(partial.body));
    assert.deepEqual(partial.body.results.map((r: { policy: string }) => r.policy), ["waterfall", "cheapestFeasible"]);
    // The engine's message, unchanged.
    assert.deepEqual(partial.body.skipped, [{ policy: "ppoProjected", code: "POLICY_DISABLED", message: ENGINE_SKIP_MESSAGE }]);
    assert.deepEqual(partial.paths, ["/v1/compare"]); // no /v1/version, no checkpoint check
    const partialRow = await prisma.comparison.findUniqueOrThrow({ where: { id: partial.body.id } });
    assert.deepEqual((partialRow.engineResponse as { skipped: unknown }).skipped, [
      { policy: "ppo_projected", code: "POLICY_DISABLED", message: ENGINE_SKIP_MESSAGE },
    ]);
    assert.deepEqual((await call(`/api/v1/comparisons/${partial.body.id}`)).body, partial.body);

    const none = await post(comparisonBody({ policies: ["ppoProjected"] }), { answers: DISABLED });
    assert.equal(none.status, 201, JSON.stringify(none.body));
    assert.deepEqual(none.body.results, []);
    assert.equal(none.body.transaction.corridor, null);
    const row = await prisma.comparison.findUniqueOrThrow({ where: { id: none.body.id } });
    assert.equal(row.corridor, null);
    assert.deepEqual(row.policies, ["ppoProjected"]);
    assert.equal(await prisma.auditLog.count({ where: { entityId: none.body.id } }), 1);

    const got = await call(`/api/v1/comparisons/${none.body.id}`);
    assert.deepEqual(got.body, none.body);
  });

  const nothingSaved: Array<[string, CallOptions, number, string]> = [
    ["a validation error", { body: comparisonBody({ policies: ["waterfall", "waterfall"] }) }, 422, "VALIDATION_ERROR"],
    ["a non-positive amount", { body: comparisonBody({ amountUsd: 0 }) }, 422, "INVALID_AMOUNT"],
    ["a viewer listing ppoProjected", { body: comparisonBody({ policies: ["ppoProjected"] }), token: viewerToken }, 403, "FORBIDDEN_POLICY"],
    ["a viewer listing ppoProjected with aliases", { body: comparisonBody({ policies: ["baseline", "ruleBased", "ppoProjected"] }), token: viewerToken }, 403, "FORBIDDEN_POLICY"],
    ["an engine 422", { answers: { ...ENABLED, "/v1/compare": { status: 422, body: engineError("UNSUPPORTED_CORRIDOR") } } }, 422, "UNSUPPORTED_CORRIDOR"],
    ["an unreachable engine", { answers: { ...ENABLED, "/v1/compare": undefined } }, 503, "INFERENCE_UNAVAILABLE"],
    ["503 ENGINE_BUSY", { answers: { ...ENABLED, "/v1/compare": { status: 503, body: engineError("ENGINE_BUSY") } } }, 503, "ENGINE_BUSY"],
    ["504 ENGINE_TIMEOUT", { answers: { ...ENABLED, "/v1/compare": { status: 504, body: engineError("ENGINE_TIMEOUT") } } }, 504, "ENGINE_TIMEOUT"],
    ["an engine 500", { answers: { ...ENABLED, "/v1/compare": { status: 500, body: engineError("INTERNAL_ERROR") } } }, 502, "INFERENCE_ERROR"],
    ["an engine 409 POLICY_DISABLED", { answers: { ...ENABLED, "/v1/compare": { status: 409, body: engineError("POLICY_DISABLED") } } }, 502, "INFERENCE_ERROR"],
    ["a 200 body that doesn't validate", { answers: { ...ENABLED, "/v1/compare": { status: 200, body: { results: [] } } } }, 502, "INFERENCE_ERROR"],
    ["a result whose provenance contradicts the state", { answers: { "/v1/compare": { status: 200, body: engineCompareResponse([
      { ...engineResult("waterfall"), provenance: { ...(engineResult("waterfall").provenance as object), state_date: "2024-06-13" } },
      engineResult("cheapest_feasible"), engineResult("ppo_projected", { checkpointSha256: CHECKPOINT })]) } } }, 502, "INFERENCE_ERROR"],
    ["an alias that names the same policy twice", { body: comparisonBody({ policies: ["baseline", "waterfall"] }) }, 422, "VALIDATION_ERROR"],
    ["a non-200 success status", { answers: { ...ENABLED, "/v1/compare": { status: 201, body: engineCompareResponse([]) } } }, 502, "INFERENCE_ERROR"],
  ];
  for (const [name, options, status, code] of nothingSaved) {
    it(`saves and audits nothing for ${name}`, async () => {
      const before = await counts();
      const res = await post(options.body ?? comparisonBody(), options);
      assert.equal(res.status, status, JSON.stringify(res.body));
      assert.equal(res.body.error.code, code);
      assert.ok(!("transactionId" in res.body.error.details));
      assert.deepEqual(await counts(), before);
    });
  }

  it("refuses a user without a User row before inference, saving nothing", async () => {
    const before = await counts();
    const res = await post(comparisonBody(), { token: unseededToken });
    assert.equal(res.status, 500);
    assert.equal(res.body.error.code, "INTERNAL_ERROR");
    assert.equal(res.compareCalls, 0);
    assert.deepEqual(await counts(), before);
  });

  it("stores and returns canonical names for aliases, in the caller's order", async () => {
    const res = await post(comparisonBody({ policies: ["ruleBased", "ppoProjected", "baseline"] }));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.policies, ["cheapestFeasible", "ppoProjected", "waterfall"]);
    assert.deepEqual(res.body.results.map((r: { policy: string }) => r.policy), ["cheapestFeasible", "ppoProjected", "waterfall"]);
    const row = await prisma.comparison.findUniqueOrThrow({ where: { id: res.body.id } });
    assert.deepEqual(row.policies, ["cheapestFeasible", "ppoProjected", "waterfall"]);
    const got = await call(`/api/v1/comparisons/${res.body.id}`, { answers: {} });
    assert.deepEqual(got.body, res.body);
    assert.ok(!JSON.stringify(got.body).includes("ruleBased"));
  });

  it("stores and returns the effective state: an explicit state with history defaulted, and a scenario", async () => {
    const explicit = {
      mode: "explicit",
      referenceDate: "2024-06-14",
      venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1000, congestion: 0.1 }],
    };
    const scenario = { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" };
    const cases = [
      { state: explicit, effective: { ...explicit, venues: [{ ...explicit.venues[0], history: null }] },
        result: engineResult("waterfall", { stateMode: "explicit" }), mode: "explicit" },
      { state: scenario, effective: scenario,
        result: engineResult("waterfall", { stateMode: "scenario", scenarioId: "cheapest_venue_outage" }), mode: "scenario" },
    ];
    for (const { state, effective, result, mode } of cases) {
      const res = await post(comparisonBody({ policies: ["waterfall"], state }), {
        answers: { "/v1/compare": { status: 200, body: engineCompareResponse([result]) } },
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.deepEqual(res.body.state, effective);
      const row = await prisma.comparison.findUniqueOrThrow({ where: { id: res.body.id } });
      assert.equal(row.stateMode, mode);
      assert.deepEqual(row.stateSpec, effective);
      assert.equal(row.simulationDate.toISOString(), "2024-06-14T00:00:00.000Z");
      const got = await call(`/api/v1/comparisons/${res.body.id}`, { answers: {} });
      assert.equal(got.status, 200);
      assert.deepEqual(got.body, res.body);
    }
  });

  it("saves a ppoProjected result whatever checkpoint the engine reports, without reading /v1/version", async () => {
    const res = await post(comparisonBody({ policies: ["ppoProjected"] }), {
      answers: { "/v1/compare": { status: 200, body: engineCompareResponse([engineResult("ppo_projected", { checkpointSha256: "b".repeat(64) })]) } },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.paths, ["/v1/compare"]);
    assert.equal(res.body.results[0].provenance.checkpoint.sha256, "b".repeat(64));
  });

  it("returns 404 NOT_FOUND for an unknown UUID and for a malformed ID", async () => {
    for (const id of [randomUUID(), "not-a-uuid", "1"]) {
      const res = await call(`/api/v1/comparisons/${id}`);
      assert.equal(res.status, 404, id);
      assert.equal(res.body.error.code, "NOT_FOUND");
    }
  });

  it("saves the same request sent concurrently as independent records, each with one audit row", async () => {
    const before = await counts();
    const body = comparisonBody({ policies: ["waterfall"] });
    const responses = await Promise.all([post(body), post(body), post(body)]);
    for (const res of responses) assert.equal(res.status, 201, JSON.stringify(res.body));
    const ids = responses.map((res) => res.body.id as string);
    assert.equal(new Set(ids).size, 3);
    assert.deepEqual(await counts(), { ...before, comparisons: before.comparisons! + 3, audits: before.audits! + 3 });
    for (const id of ids) {
      assert.equal(await prisma.auditLog.count({ where: { entityType: "Comparison", entityId: id, action: "COMPARISON_CREATE" } }), 1);
    }
  });

  it("never lists a comparison among the transactions", async () => {
    await post(comparisonBody({ policies: ["waterfall"] }));
    assert.equal(await prisma.transactionRequest.count(), 0);
    const list = await call("/api/v1/transactions");
    assert.equal(list.status, 200);
    assert.equal(list.body.total, 0);
  });

  describe("atomicity and constraints", () => {
    const uniqueViolation = (error: unknown) => (error as { code?: unknown }).code === "P2002";

    it("rolls back the Comparison when its audit insert fails", async () => {
      await post(comparisonBody({ policies: ["waterfall"] }));
      const duplicateAuditId = (await prisma.auditLog.findFirstOrThrow()).id;
      // Odd draws are comparison IDs; even draws are the audit ID, which already exists.
      let n = 0;
      const store = createPrismaComparisonStore(prisma, { newId: () => (++n % 2 === 1 ? randomUUID() : duplicateAuditId) });
      const before = await counts();
      await assert.rejects(store.save(directInput()), uniqueViolation);
      assert.deepEqual(await counts(), before);

      // Through the endpoint: 500, and still nothing saved.
      const res = await post(comparisonBody({ policies: ["waterfall"] }), { store });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.deepEqual(await counts(), before);
    });

    it("writes no audit row when the Comparison insert fails", async () => {
      const posted = await post(comparisonBody({ policies: ["waterfall"] }));
      const before = await counts();
      // The comparison ID already exists, so the first insert fails.
      const store = createPrismaComparisonStore(prisma, { newId: () => posted.body.id as string });
      await assert.rejects(store.save(directInput()), uniqueViolation);
      assert.deepEqual(await counts(), before);
    });

    it("saves nothing when the User row is missing at write time (foreign key)", async () => {
      const before = await counts();
      await assert.rejects(createPrismaComparisonStore(prisma).save(directInput({ userId: "it-unseeded" })));
      assert.deepEqual(await counts(), before);
    });

    it("rejects NULL policies and an unknown policy value (column constraints)", async () => {
      const before = await counts();
      const insert = (policies: string) =>
        prisma.$executeRawUnsafe(
          `INSERT INTO "Comparison" ("id", "createdById", "senderCountry", "receiverCountry", "amountUsd", "simulationDate", "stateMode", "stateSpec", "policies", "engineResponse")
           VALUES ('${randomUUID()}', 'it-analyst', 'GBR', 'PHL', 1, DATE '2024-06-14', 'historicalReplay', '{}'::jsonb, ${policies}, '{}'::jsonb)`,
        );
      await assert.rejects(insert("NULL"));
      await assert.rejects(insert(`ARRAY['ppo']::"Policy"[]`));
      assert.deepEqual(await counts(), before);
    });

    it("keeps a user who created a comparison (ON DELETE RESTRICT)", async () => {
      await post(comparisonBody({ policies: ["waterfall"] }), { token: viewerToken });
      await assert.rejects(prisma.user.delete({ where: { id: "it-viewer" } }));
      assert.equal(await prisma.user.count({ where: { id: "it-viewer" } }), 1);
    });
  });
});
