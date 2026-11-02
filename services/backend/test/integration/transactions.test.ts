import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { PrismaClient, type Policy, type StateMode } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import { createPrismaTransactionRepository, type TransactionRepository } from "../../src/db/transactions.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { silentLogger, startServer } from "../helpers/server.js";

// GET /api/v1/transactions against a real PostgreSQL database.
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
