import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PrismaClient } from "@prisma/client";
import { auditLogData } from "../../src/audit/auditLog.js";
import { createPrismaTransactionPersistence, type RoutedTransaction } from "../../src/db/transactionPersistence.js";
import { InvalidRouteResponseError, mapRouteResponse } from "../../src/mappers/routeResponse.js";
import { validateTransactionRequest, type TransactionRequest } from "../../src/validation/transactionRequest.js";
import { engineRegulatoryRejection, engineRouteResponse, requestBody } from "../helpers/transactions.js";

// The Prisma implementation of TransactionPersistence, with a fake client that
// records the operations handed to $transaction. Real atomicity is checked in
// test/integration/transactions.test.ts against PostgreSQL.

interface Op {
  model: string;
  args: { data: Record<string, any>; select?: unknown };
}

function fakeClient({ transactionError, user = true }: { transactionError?: Error; user?: boolean } = {}) {
  const batches: Op[][] = [];
  const lookups: unknown[] = [];
  const client = {
    transactionRequest: { create: (args: Op["args"]): Op => ({ model: "transactionRequest", args }) },
    auditLog: { create: (args: Op["args"]): Op => ({ model: "auditLog", args }) },
    user: {
      async findUnique(args: unknown) {
        lookups.push(args);
        return user ? { id: "u-analyst-1" } : null;
      },
    },
    async $transaction(ops: Op[]) {
      batches.push(ops);
      if (transactionError) throw transactionError;
      return ops.map((op) => ({ id: op.args.data.id, createdAt: op.args.data.createdAt }));
    },
  };
  return { client: client as unknown as PrismaClient, batches, lookups };
}

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-00000000000${++n}`;
}
const NOW = new Date("2026-11-03T08:00:00.123Z");
const options = () => ({ newId: ids(), now: () => NOW });

function validated(body: Record<string, unknown> = requestBody()): TransactionRequest {
  const result = validateTransactionRequest(body);
  assert.ok(result.ok);
  return result.value;
}

function routed(engine = engineRouteResponse(), request = validated()): RoutedTransaction {
  const { columns } = mapRouteResponse(engine, request);
  return {
    userId: "u-analyst-1",
    requestId: "req-1",
    request,
    corridor: columns.corridor,
    decision: columns.decision,
    allocations: columns.allocations,
    engineResponse: engine,
  };
}

const AUDIT_KEYS = ["id", "at", "userId", "action", "requestId", "entityType", "entityId", "outcome"];

describe("createPrismaTransactionPersistence: saveRouted", () => {
  it("writes the transaction with its decision and allocations, then the SUCCESS audit row, in one batch", async () => {
    const fake = fakeClient();
    const input = routed();
    const saved = await createPrismaTransactionPersistence(fake.client, options()).saveRouted(input);
    assert.deepEqual(saved, { id: "00000000-0000-4000-8000-000000000001", createdAt: NOW });

    assert.equal(fake.batches.length, 1);
    const [tx, audit] = fake.batches[0]!;
    assert.equal(fake.batches[0]!.length, 2);
    assert.equal(tx!.model, "transactionRequest");
    const { decision, ...row } = tx!.args.data;
    assert.deepEqual(row, {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: NOW,
      createdById: "u-analyst-1",
      senderCountry: "GBR",
      receiverCountry: "PHL",
      corridor: "GBR->PHL",
      amountUsd: 300000.0,
      stateMode: "historicalReplay",
      stateSpec: { mode: "historicalReplay", date: "2024-06-14" },
      simulationDate: new Date("2024-06-14T00:00:00.000Z"),
      requestedPolicy: "waterfall",
      status: "routed",
      failureCode: null,
      clientReference: null,
    });
    const { engineResponse, allocations, ...columns } = decision.create;
    assert.deepEqual(columns, input.decision);
    assert.equal(columns.feeCostUsd, 5100.0); // metrics.fee_cost_usd
    // The same object the route received: stored as returned.
    assert.equal(engineResponse, input.engineResponse);
    assert.deepEqual(allocations, { createMany: { data: input.allocations } });
    assert.equal(allocations.createMany.data.length, 3);

    assert.equal(audit!.model, "auditLog");
    assert.deepEqual(audit!.args.data, {
      id: "00000000-0000-4000-8000-000000000002",
      at: NOW,
      userId: "u-analyst-1",
      action: "TRANSACTION_CREATE",
      requestId: "req-1",
      entityType: "TransactionRequest",
      entityId: "00000000-0000-4000-8000-000000000001",
      outcome: "SUCCESS",
    });
    assert.deepEqual(Object.keys(audit!.args.data), AUDIT_KEYS);
  });

  it("writes a regulatory rejection with no allocation rows, feeCostUsd 0 and its metrics copied (§2.8)", async () => {
    const fake = fakeClient();
    await createPrismaTransactionPersistence(fake.client, options()).saveRouted(routed(engineRegulatoryRejection()));
    const data = fake.batches[0]![0]!.args.data;
    const create = data.decision.create;
    assert.equal(create.allowed, false);
    assert.equal(create.feeCostUsd, 0);
    assert.equal(create.rewardEnv, 0);
    assert.equal(create.rewardAmountBased, -1);
    assert.equal(create.riskTerm, 0);
    assert.equal(data.failureCode, null);
    assert.equal("allocations" in create, false);
    assert.equal(fake.batches[0]![1]!.args.data.outcome, "SUCCESS");
  });

  it("stores every metric column non-null; a body without full metrics never reaches saveRouted", async () => {
    const fake = fakeClient();
    await createPrismaTransactionPersistence(fake.client, options()).saveRouted(routed());
    const create = fake.batches[0]![0]!.args.data.decision.create;
    for (const key of ["feeCostUsd", "latencyTerm", "riskTerm", "rewardEnv", "rewardAmountBased"]) {
      assert.equal(typeof create[key], "number", key);
    }
    // The mapper rejects these, so the route saves them as failed instead (§2.8).
    for (const metrics of [null, undefined, { reward_env: -0.3 }]) {
      const engine = { ...engineRouteResponse(), metrics };
      if (metrics === undefined) delete (engine as Record<string, unknown>).metrics;
      assert.throws(() => routed(engine), InvalidRouteResponseError, JSON.stringify(metrics));
    }
  });

  it("stores the validated explicit state and takes simulationDate from referenceDate", async () => {
    const fake = fakeClient();
    const venues = [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1, congestion: 0.1 }];
    const request = validated(
      requestBody({ state: { mode: "explicit", referenceDate: "2023-02-28", venues }, clientReference: "ref-9" }),
    );
    await createPrismaTransactionPersistence(fake.client, options()).saveFailed({
      userId: "u-analyst-1",
      requestId: "r",
      request,
      failureCode: "ENGINE_BUSY",
    });
    const data = fake.batches[0]![0]!.args.data;
    assert.deepEqual(data.stateSpec, {
      mode: "explicit",
      referenceDate: "2023-02-28",
      venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1, congestion: 0.1, history: null }],
    });
    assert.deepEqual(data.simulationDate, new Date("2023-02-28T00:00:00.000Z"));
    assert.equal(data.stateMode, "explicit");
    assert.equal(data.clientReference, "ref-9");
  });

  it("refuses a decision whose policy differs from the requested one, before any write", async () => {
    const fake = fakeClient();
    const input = routed();
    await assert.rejects(
      createPrismaTransactionPersistence(fake.client, options()).saveRouted({
        ...input,
        decision: { ...input.decision, policy: "cheapestFeasible" },
      }),
      /differs from the requested policy/,
    );
    assert.equal(fake.batches.length, 0);
  });

  it("propagates a failed database transaction", async () => {
    const fake = fakeClient({ transactionError: new Error("rolled back") });
    await assert.rejects(createPrismaTransactionPersistence(fake.client, options()).saveRouted(routed()), /rolled back/);
  });
});

describe("createPrismaTransactionPersistence: saveFailed", () => {
  it("writes a failed transaction with no decision and corridor null, then the FAILED audit row, in one batch", async () => {
    const fake = fakeClient();
    const saved = await createPrismaTransactionPersistence(fake.client, options()).saveFailed({
      userId: "u-viewer-1",
      requestId: "req-2",
      request: validated(requestBody({ policy: "cheapestFeasible" })),
      failureCode: "INFERENCE_UNAVAILABLE",
    });
    assert.deepEqual(saved, { id: "00000000-0000-4000-8000-000000000001", createdAt: NOW });
    const [tx, audit] = fake.batches[0]!;
    assert.equal(fake.batches[0]!.length, 2);
    assert.equal(tx!.args.data.status, "failed");
    assert.equal(tx!.args.data.failureCode, "INFERENCE_UNAVAILABLE");
    assert.equal(tx!.args.data.corridor, null);
    assert.equal(tx!.args.data.requestedPolicy, "cheapestFeasible");
    assert.equal("decision" in tx!.args.data, false);
    assert.deepEqual(audit!.args.data, {
      id: "00000000-0000-4000-8000-000000000002",
      at: NOW,
      userId: "u-viewer-1",
      action: "TRANSACTION_CREATE",
      requestId: "req-2",
      entityType: "TransactionRequest",
      entityId: "00000000-0000-4000-8000-000000000001",
      outcome: "FAILED",
    });
  });

  it("propagates a failed database transaction", async () => {
    const fake = fakeClient({ transactionError: new Error("rolled back") });
    await assert.rejects(
      createPrismaTransactionPersistence(fake.client, options()).saveFailed({
        userId: "u-analyst-1",
        requestId: "r",
        request: validated(),
        failureCode: "INFERENCE_ERROR",
      }),
      /rolled back/,
    );
  });

  for (const failureCode of ["INFERENCE_ERROR", "INFERENCE_UNAVAILABLE", "ENGINE_BUSY", "ENGINE_TIMEOUT"] as const) {
    it(`stores failureCode ${failureCode}`, async () => {
      const fake = fakeClient();
      await createPrismaTransactionPersistence(fake.client, options()).saveFailed({
        userId: "u",
        requestId: "r",
        request: validated(),
        failureCode,
      });
      assert.equal(fake.batches[0]![0]!.args.data.failureCode, failureCode);
    });
  }

  for (const failureCode of ["NOT_READY", "POLICY_DISABLED", "", "engine_busy"]) {
    it(`refuses the unstorable code ${JSON.stringify(failureCode)} before any write`, async () => {
      const fake = fakeClient();
      await assert.rejects(
        createPrismaTransactionPersistence(fake.client, options()).saveFailed({
          userId: "u",
          requestId: "r",
          request: validated(),
          failureCode: failureCode as "ENGINE_BUSY",
        }),
        /Unknown failure code/,
      );
      assert.equal(fake.batches.length, 0);
    });
  }

  it("uses random UUIDs and the current time by default", async () => {
    const fake = fakeClient();
    const before = Date.now();
    await createPrismaTransactionPersistence(fake.client).saveFailed({
      userId: "u",
      requestId: "r",
      request: validated(),
      failureCode: "ENGINE_TIMEOUT",
    });
    const [tx, audit] = fake.batches[0]!;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    assert.match(tx!.args.data.id, uuid);
    assert.match(audit!.args.data.id, uuid);
    assert.notEqual(tx!.args.data.id, audit!.args.data.id);
    assert.ok(tx!.args.data.createdAt.getTime() >= before);
    assert.equal(audit!.args.data.at, tx!.args.data.createdAt);
  });
});

describe("createPrismaTransactionPersistence: userExists", () => {
  it("looks the user up by id, selecting only the id", async () => {
    const fake = fakeClient();
    assert.equal(await createPrismaTransactionPersistence(fake.client).userExists("u-analyst-1"), true);
    assert.deepEqual(fake.lookups, [{ where: { id: "u-analyst-1" }, select: { id: true } }]);
    assert.equal(await createPrismaTransactionPersistence(fakeClient({ user: false }).client).userExists("x"), false);
  });
});

describe("auditLogData", () => {
  it("sets both entity fields or neither", () => {
    const base = { id: "a", at: NOW, userId: "u", action: "TRANSACTION_CREATE", requestId: "r", outcome: "FAILED" } as const;
    const none = auditLogData({ ...base, entity: null });
    assert.equal(none.entityType, null);
    assert.equal(none.entityId, null);
    const both = auditLogData({ ...base, entity: { type: "TransactionRequest", id: "t" } });
    assert.equal(both.entityType, "TransactionRequest");
    assert.equal(both.entityId, "t");
  });
});
