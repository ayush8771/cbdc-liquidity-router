import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } from "../../src/audit/auditLog.js";
import { createPrismaComparisonStore, type NewComparison } from "../../src/db/comparisons.js";
import { engineCompareResponse, engineResult, engineSkipped } from "../helpers/comparisons.js";

// The Prisma ComparisonStore with a fake client that records the operations
// handed to $transaction. Real atomicity and the real constraints are checked
// against PostgreSQL in test/integration/transactions.test.ts.

interface Op {
  model: string;
  args: { data: Record<string, any>; select?: unknown };
  /** For $executeRaw: the statement with each bound value replaced by "?". */
  sql?: string;
  /** For $executeRaw: the bound values, in order. */
  params?: unknown[];
}

const NOW = new Date("2026-11-16T09:00:00.123Z");

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-00000000000${++n}`;
}

function fakeClient({ transactionError, row }: { transactionError?: Error; row?: unknown } = {}) {
  const batches: Op[][] = [];
  const reads: Array<{ model: string; args: any }> = [];
  const client = {
    comparison: {
      create: (args: Op["args"]): Op => ({ model: "comparison", args }),
      async findUnique(args: unknown) {
        reads.push({ model: "comparison", args });
        return row ?? null;
      },
    },
    auditLog: { create: (args: Op["args"]): Op => ({ model: "auditLog", args }) },
    // A tagged template, as Prisma's is. It records the statement and its bound values
    // so a test can check which row is rewritten and with what (src/db/exactEngineResponse.ts).
    $executeRaw: (strings: TemplateStringsArray, ...params: unknown[]): Op => ({
      model: "$executeRaw",
      args: { data: {} },
      sql: strings.join("?"),
      params,
    }),
    user: {
      async findUnique(args: { where: { id: string } }) {
        reads.push({ model: "user", args });
        return args.where.id === "u-analyst-1" ? { id: "u-analyst-1" } : null;
      },
    },
    async $transaction(ops: Op[]) {
      batches.push(ops);
      if (transactionError) throw transactionError;
      return ops.map((op) => ({ id: op.args.data.id, createdAt: op.args.data.createdAt }));
    },
  };
  return { client: client as unknown as PrismaClient, batches, reads };
}

const ENGINE = engineCompareResponse([engineResult("waterfall")], [engineSkipped("ppo_projected")]);

function input(overrides: Partial<NewComparison> = {}): NewComparison {
  return {
    userId: "u-analyst-1",
    requestId: "req-1",
    request: {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000.0,
      state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" },
      policies: ["ppoProjected", "waterfall"],
      clientReference: "demo-001",
    },
    corridor: "GBR->PHL",
    engineResponse: ENGINE,
    ...overrides,
  };
}

describe("createPrismaComparisonStore().save", () => {
  it("writes the Comparison and its SUCCESS audit row in one database transaction", async () => {
    const { client, batches } = fakeClient();
    const saved = await createPrismaComparisonStore(client, { newId: ids(), now: () => NOW }).save(input());
    assert.deepEqual(saved, { id: "00000000-0000-4000-8000-000000000001", createdAt: NOW });
    assert.equal(batches.length, 1);
    // Three operations now: the comparison, the audit row, and the statement that
    // rewrites engineResponse without Prisma's 16-significant-digit rounding (§3.6, §6.1).
    assert.equal(batches[0]!.length, 3);
    const [comparison, audit] = batches[0]!;
    assert.equal(comparison!.model, "comparison");
    assert.deepEqual(comparison!.args.data, {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: NOW,
      createdById: "u-analyst-1",
      senderCountry: "GBR",
      receiverCountry: "PHL",
      corridor: "GBR->PHL",
      amountUsd: 300000.0,
      simulationDate: new Date("2024-06-14T00:00:00.000Z"),
      clientReference: "demo-001",
      stateMode: "scenario",
      stateSpec: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" },
      // The resolved list, in the caller's order.
      policies: ["ppoProjected", "waterfall"],
      engineResponse: ENGINE,
    });
    assert.equal(audit!.model, "auditLog");
    assert.deepEqual(audit!.args.data, {
      id: "00000000-0000-4000-8000-000000000002",
      at: NOW,
      userId: "u-analyst-1",
      action: "COMPARISON_CREATE",
      requestId: "req-1",
      entityType: "Comparison",
      entityId: "00000000-0000-4000-8000-000000000001",
      outcome: "SUCCESS",
    });
    assert.equal(AUDIT_ACTIONS.comparisonCreate, "COMPARISON_CREATE");
    assert.equal(AUDIT_ENTITY_TYPES.comparison, "Comparison");

    // The third operation rewrites this comparison's engineResponse from text.
    const exact = batches[0]![2]!;
    assert.equal(exact.model, "$executeRaw");
    assert.equal(exact.sql, 'UPDATE "Comparison" SET "engineResponse" = ?::jsonb WHERE "id" = ?::uuid');
    assert.deepEqual(exact.params, [JSON.stringify(ENGINE), "00000000-0000-4000-8000-000000000001"]);
    assert.deepEqual(JSON.parse(exact.params![0] as string), ENGINE);
  });

  it("writes no transaction, decision or allocation: only the comparison, its audit row and the exact-json statement", async () => {
    const { client, batches } = fakeClient();
    await createPrismaComparisonStore(client, { newId: ids(), now: () => NOW }).save(input());
    assert.deepEqual(batches[0]!.map((op) => op.model), ["comparison", "auditLog", "$executeRaw"]);
    assert.ok(!("transactionId" in batches[0]![0]!.args.data));
  });

  it("stores corridor null and the explicit reference date", async () => {
    const { client, batches } = fakeClient();
    const state = { mode: "explicit" as const, referenceDate: "2024-07-01", venues: [] };
    await createPrismaComparisonStore(client, { newId: ids(), now: () => NOW }).save(
      input({ corridor: null, request: { ...input().request, state, clientReference: null } }),
    );
    const data = batches[0]![0]!.args.data;
    assert.equal(data.corridor, null);
    assert.equal(data.clientReference, null);
    assert.equal(data.stateMode, "explicit");
    assert.deepEqual(data.simulationDate, new Date("2024-07-01T00:00:00.000Z"));
  });

  it("propagates a failed transaction: nothing is reported as saved", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "6.19.3" });
    const { client, batches } = fakeClient({ transactionError: error });
    await assert.rejects(createPrismaComparisonStore(client, { newId: ids(), now: () => NOW }).save(input()), error);
    assert.equal(batches.length, 1); // no retry, no second attempt
  });

  it("gives each save its own IDs, so a repeated request is a new record", async () => {
    const { client, batches } = fakeClient();
    const store = createPrismaComparisonStore(client, { newId: ids(), now: () => NOW });
    const first = await store.save(input());
    const second = await store.save(input());
    assert.notEqual(first.id, second.id);
    assert.equal(batches.length, 2);
    assert.equal(batches[1]![1]!.args.data.entityId, second.id);
  });

  it("refuses an empty policy list before writing", async () => {
    const { client, batches } = fakeClient();
    await assert.rejects(
      createPrismaComparisonStore(client).save(input({ request: { ...input().request, policies: [] } })),
      /no policies/,
    );
    assert.equal(batches.length, 0);
  });
});

describe("createPrismaComparisonStore() reads", () => {
  it("finds a comparison by ID, reading only the Comparison row", async () => {
    const row = { id: "x" };
    const { client, reads } = fakeClient({ row });
    const found = await createPrismaComparisonStore(client).findById("00000000-0000-4000-8000-000000000001");
    assert.equal(found, row);
    assert.equal(reads.length, 1);
    assert.equal(reads[0]!.model, "comparison");
    assert.deepEqual(reads[0]!.args.where, { id: "00000000-0000-4000-8000-000000000001" });
    assert.deepEqual(Object.keys(reads[0]!.args.select).sort(), [
      "amountUsd", "clientReference", "corridor", "createdAt", "createdById", "engineResponse", "id", "policies",
      "receiverCountry", "senderCountry", "simulationDate", "stateMode", "stateSpec",
    ]);
    assert.equal(await createPrismaComparisonStore(fakeClient().client).findById("00000000-0000-4000-8000-000000000002"), null);
  });

  it("reports whether the seeded User row exists, creating nothing", async () => {
    const { client, batches } = fakeClient();
    const store = createPrismaComparisonStore(client);
    assert.equal(await store.userExists("u-analyst-1"), true);
    assert.equal(await store.userExists("u-missing"), false);
    assert.equal(batches.length, 0);
  });
});
