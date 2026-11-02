import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import {
  createPrismaTransactionRepository,
  transactionListWhere,
  type TransactionListQuery,
  type TransactionListRow,
  type TransactionRepository,
} from "../../src/db/transactions.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const routedRow: TransactionListRow = {
  id: "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f",
  createdAt: new Date("2026-11-02T10:00:00.123Z"),
  createdById: "u-analyst-1",
  corridor: "GBR->PHL",
  amountUsd: 300000.0,
  simulationDate: new Date("2024-06-14T00:00:00Z"),
  stateMode: "historicalReplay",
  requestedPolicy: "waterfall",
  status: "routed",
  decision: {
    policyStatus: "default",
    allowed: true,
    completed: true,
    completionRatio: 1.0,
    executedUsd: 300000.0,
    rewardAmountBased: -0.3078,
  },
};
const failedRow: TransactionListRow = {
  id: "11111111-2222-4333-8444-555555555555",
  createdAt: new Date("2026-11-02T09:00:00Z"),
  createdById: "u-viewer-1",
  corridor: null,
  amountUsd: 1000.5,
  simulationDate: new Date("2023-01-05T00:00:00Z"),
  stateMode: "explicit",
  requestedPolicy: "ppoProjected",
  status: "failed",
  decision: null,
};

/** A repository that records each query and answers with fixed rows. */
function fakeRepository(answer: { rows: TransactionListRow[]; total: number } | Error = { rows: [], total: 0 }) {
  const queries: TransactionListQuery[] = [];
  const repository: TransactionRepository = {
    async list(query) {
      queries.push(query);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { repository, queries };
}

async function get(
  transactions: TransactionRepository | undefined,
  path = "/api/v1/transactions",
  init: { method?: string; headers?: Record<string, string> } = { headers: auth(viewerToken) },
  logger = silentLogger,
): Promise<{ status: number; body: Record<string, unknown>; text: string }> {
  const server = await startServer(createApp({ logger, users, transactions }));
  try {
    const res = await fetch(`${server.baseUrl}${path}`, init);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Record<string, unknown>, text };
  } finally {
    await server.close();
  }
}

describe("GET /api/v1/transactions", () => {
  describe("authentication", () => {
    for (const [label, headers] of [
      ["no Authorization header", {}],
      ["a malformed token", { Authorization: "Bearer nope" }],
      ["an unknown token", auth(newToken())],
    ] as const) {
      it(`returns 401 for ${label}, without reading the database`, async () => {
        const { repository, queries } = fakeRepository();
        const res = await get(repository, undefined, { headers });
        assert.equal(res.status, 401);
        assert.equal((res.body.error as { code: string }).code, "UNAUTHENTICATED");
        assert.equal(queries.length, 0);
      });
    }

    for (const [role, token] of [
      ["analyst", analystToken],
      ["viewer", viewerToken],
    ] as const) {
      it(`returns 200 for a ${role}, including other users' and ppoProjected rows`, async () => {
        const { repository } = fakeRepository({ rows: [routedRow, failedRow], total: 2 });
        const res = await get(repository, undefined, { headers: auth(token) });
        assert.equal(res.status, 200);
        assert.equal((res.body.items as unknown[]).length, 2);
      });
    }
  });

  describe("response", () => {
    it("maps a routed row field for field, in §3.3 order", async () => {
      const { repository } = fakeRepository({ rows: [routedRow], total: 1 });
      const res = await get(repository);
      assert.deepEqual(res.body, {
        items: [
          {
            id: "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f",
            createdAt: "2026-11-02T10:00:00.123Z",
            createdBy: "u-analyst-1",
            corridor: "GBR->PHL",
            amountUsd: 300000.0,
            simulationDate: "2024-06-14",
            stateMode: "historicalReplay",
            policy: "waterfall",
            policyStatus: "default",
            status: "routed",
            allowed: true,
            completed: true,
            completionRatio: 1.0,
            executedUsd: 300000.0,
            rewardAmountBased: -0.3078,
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      });
      assert.deepEqual(Object.keys((res.body.items as Array<Record<string, unknown>>)[0]!), [
        "id", "createdAt", "createdBy", "corridor", "amountUsd", "simulationDate", "stateMode", "policy",
        "policyStatus", "status", "allowed", "completed", "completionRatio", "executedUsd", "rewardAmountBased",
      ]);
    });

    it("returns null decision fields for a failed row, and its requested policy", async () => {
      const { repository } = fakeRepository({ rows: [failedRow], total: 1 });
      const res = await get(repository);
      assert.deepEqual((res.body.items as unknown[])[0], {
        id: "11111111-2222-4333-8444-555555555555",
        createdAt: "2026-11-02T09:00:00.000Z",
        createdBy: "u-viewer-1",
        corridor: null,
        amountUsd: 1000.5,
        simulationDate: "2023-01-05",
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
    });

    it("keeps a stored null reward on a routed row", async () => {
      const row = { ...routedRow, decision: { ...routedRow.decision!, allowed: false, completed: false, rewardAmountBased: null } };
      const { repository } = fakeRepository({ rows: [row], total: 1 });
      const item = ((await get(repository)).body.items as Array<Record<string, unknown>>)[0]!;
      assert.equal(item.allowed, false);
      assert.equal(item.completed, false);
      assert.equal(item.rewardAmountBased, null);
    });

    it("returns an empty page with the total and the requested page", async () => {
      const { repository } = fakeRepository({ rows: [], total: 41 });
      const res = await get(repository, "/api/v1/transactions?page=5&pageSize=10");
      assert.deepEqual(res.body, { items: [], page: 5, pageSize: 10, total: 41 });
    });
  });

  describe("query handling", () => {
    it("passes the defaults to the repository", async () => {
      const { repository, queries } = fakeRepository();
      await get(repository);
      assert.deepEqual(queries, [{ page: 1, pageSize: 20, filters: {} }]);
    });

    it("passes every filter, ignoring unknown parameters", async () => {
      const { repository, queries } = fakeRepository();
      const res = await get(
        repository,
        "/api/v1/transactions?page=2&pageSize=50&corridor=USA-%3EIND&policy=ppoProjected&stateMode=explicit" +
          "&completed=true&from=2026-11-01T00:00:00Z&to=2026-11-03T00:00:00Z&sort=createdAt:desc&unknown=x&token=y",
      );
      assert.equal(res.status, 200);
      assert.deepEqual(queries, [
        {
          page: 2,
          pageSize: 50,
          filters: {
            corridor: "USA->IND",
            policy: "ppoProjected",
            stateMode: "explicit",
            completed: true,
            from: new Date("2026-11-01T00:00:00Z"),
            to: new Date("2026-11-03T00:00:00Z"),
          },
        },
      ]);
    });

    it("returns 422 VALIDATION_ERROR with every problem, without reading the database", async () => {
      const { repository, queries } = fakeRepository();
      const res = await get(
        repository,
        "/api/v1/transactions?pageSize=101&sort=createdAt:asc&page=1&page=2&from=2026-11-02",
        { headers: { ...auth(viewerToken), "X-Request-Id": "bad-query" } },
      );
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, {
        error: {
          code: "VALIDATION_ERROR",
          message: "The query parameters are invalid.",
          details: {
            errors: [
              { field: "page", message: "must be given at most once" },
              { field: "pageSize", message: "must be at most 100" },
              { field: "from", message: "must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z" },
              { field: "sort", message: "must be one of: createdAt:desc" },
            ],
          },
          requestId: "bad-query",
        },
      });
      assert.equal(queries.length, 0);
    });

    it("returns 422 when from is later than to", async () => {
      const res = await get(fakeRepository().repository, "/api/v1/transactions?from=2026-11-03T00:00:00Z&to=2026-11-02T00:00:00Z");
      assert.equal(res.status, 422);
    });
  });

  describe("errors", () => {
    it("returns 500 INTERNAL_ERROR on a database error, without its message, logging it safely", async () => {
      const prismaError = new Prisma.PrismaClientKnownRequestError(
        "Can't reach database server at postgresql://user:secret@db:5432/cbdc",
        { code: "P1001", clientVersion: "6.19.3" },
      );
      const capture = captureLogger();
      const res = await get(fakeRepository(prismaError).repository, undefined, { headers: auth(viewerToken) }, capture.logger);
      assert.equal(res.status, 500);
      assert.equal((res.body.error as { code: string }).code, "INTERNAL_ERROR");
      assert.equal((res.body.error as { message: string }).message, "An unexpected error occurred.");
      assert.doesNotMatch(res.text, /secret|postgresql|P1001/);
      const logged = capture.lines.join("\n");
      assert.match(logged, /P1001/);
      assert.doesNotMatch(logged, /secret|postgresql:\/\//);
    });

    it("returns 500 INTERNAL_ERROR when no database is configured", async () => {
      const res = await get(undefined);
      assert.equal(res.status, 500);
      assert.deepEqual(res.body.error && (res.body.error as Record<string, unknown>).details, {});
      assert.equal((res.body.error as { code: string }).code, "INTERNAL_ERROR");
    });

    it("still validates the query when no database is configured", async () => {
      const res = await get(undefined, "/api/v1/transactions?pageSize=0");
      assert.equal(res.status, 422);
    });

    for (const method of ["POST", "PUT", "DELETE"]) {
      it(`returns 404 NOT_FOUND for ${method}`, async () => {
        const { repository, queries } = fakeRepository();
        const res = await get(repository, undefined, { method, headers: auth(analystToken) });
        assert.equal(res.status, 404);
        assert.equal(queries.length, 0);
      });
    }
  });
});

describe("Prisma transaction repository", () => {
  /** Records the arguments Prisma would receive. */
  function fakePrisma(rows: unknown[] = [], total = 0) {
    const calls: Record<string, unknown> = {};
    const client = {
      transactionRequest: {
        findMany: (args: unknown) => ((calls.findMany = args), { op: "findMany" }),
        count: (args: unknown) => ((calls.count = args), { op: "count" }),
      },
      async $transaction(ops: unknown[], options: unknown) {
        calls.ops = ops;
        calls.options = options;
        return [rows, total];
      },
    };
    return { client: client as unknown as PrismaClient, calls };
  }

  it("runs findMany and count in one REPEATABLE READ transaction, newest first, with the page offset", async () => {
    const { client, calls } = fakePrisma([routedRow], 7);
    const filters = { corridor: "GBR->PHL", completed: false };
    const result = await createPrismaTransactionRepository(client).list({ page: 3, pageSize: 10, filters });
    assert.deepEqual(result, { rows: [routedRow], total: 7 });
    assert.deepEqual(calls.ops, [{ op: "findMany" }, { op: "count" }]);
    assert.deepEqual(calls.options, { isolationLevel: "RepeatableRead" });
    const findMany = calls.findMany as Record<string, unknown>;
    assert.deepEqual(findMany.orderBy, [{ createdAt: "desc" }, { id: "desc" }]);
    assert.equal(findMany.skip, 20);
    assert.equal(findMany.take, 10);
    assert.deepEqual(findMany.where, transactionListWhere(filters));
    assert.deepEqual(calls.count, { where: transactionListWhere(filters) });
  });

  it("selects only the fields a history item needs", async () => {
    const { client, calls } = fakePrisma();
    await createPrismaTransactionRepository(client).list({ page: 1, pageSize: 20, filters: {} });
    const select = (calls.findMany as { select: Record<string, unknown> }).select;
    assert.deepEqual(Object.keys(select), [
      "id", "createdAt", "createdById", "corridor", "amountUsd", "simulationDate", "stateMode", "requestedPolicy",
      "status", "decision",
    ]);
    assert.equal("engineResponse" in (select.decision as { select: object }).select, false);
    assert.equal("stateSpec" in select, false);
  });

  it("builds the where clause from the filters", () => {
    const from = new Date("2026-11-01T00:00:00Z");
    const to = new Date("2026-11-02T00:00:00Z");
    assert.deepEqual(transactionListWhere({}), {});
    assert.deepEqual(
      transactionListWhere({ corridor: "USA->IND", policy: "waterfall", stateMode: "scenario", completed: true, from, to }),
      {
        corridor: "USA->IND",
        requestedPolicy: "waterfall",
        stateMode: "scenario",
        decision: { is: { completed: true } },
        createdAt: { gte: from, lt: to },
      },
    );
    assert.deepEqual(transactionListWhere({ from }), { createdAt: { gte: from } });
    assert.deepEqual(transactionListWhere({ to }), { createdAt: { lt: to } });
    assert.deepEqual(transactionListWhere({ completed: false }), { decision: { is: { completed: false } } });
  });
});
