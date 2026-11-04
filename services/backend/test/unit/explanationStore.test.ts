import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createPrismaExplanationStore, isRoutingDecisionConflict } from "../../src/db/explanations.js";
import { engineExplainResponse } from "../helpers/transactions.js";

// The Prisma ExplanationStore with a fake client that records the operations
// handed to $transaction. Real atomicity and the real unique constraint are
// checked against PostgreSQL in test/integration/transactions.test.ts.

interface Op {
  model: string;
  args: { data: Record<string, any>; select?: unknown };
}

const DECISION = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-11-05T08:00:00.123Z");

function ids() {
  let n = 0;
  return () => `00000000-0000-4000-8000-00000000000${++n}`;
}

function uniqueViolation(meta?: Record<string, unknown>): Error {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.19.3",
    ...(meta && { meta }),
  });
}
/** The race: Explanation.routingDecisionId, as Prisma reports it. */
const RACE_META = { modelName: "Explanation", target: ["routingDecisionId"] };

function fakeClient({ transactionError, existing }: { transactionError?: Error; existing?: unknown } = {}) {
  const batches: Op[][] = [];
  const reads: unknown[] = [];
  const client = {
    explanation: {
      create: (args: Op["args"]): Op => ({ model: "explanation", args }),
      async findUnique(args: unknown) {
        reads.push(args);
        return existing === undefined ? null : { engineResponse: existing };
      },
    },
    auditLog: { create: (args: Op["args"]): Op => ({ model: "auditLog", args }) },
    transactionRequest: {
      async findUnique(args: unknown) {
        reads.push(args);
        return null;
      },
    },
    async $transaction(ops: Op[]) {
      batches.push(ops);
      if (transactionError) throw transactionError;
      return ops.map((op) => ({ id: op.args.data.id }));
    },
  };
  return { client: client as unknown as PrismaClient, batches, reads };
}

const input = () => ({
  routingDecisionId: DECISION,
  engineResponse: engineExplainResponse(),
  userId: "u-analyst-1",
  requestId: "req-1",
});

describe("createPrismaExplanationStore().save", () => {
  it("writes the Explanation and its SUCCESS audit row in one database transaction", async () => {
    const { client, batches } = fakeClient();
    const result = await createPrismaExplanationStore(client, { newId: ids(), now: () => NOW }).save(input());
    assert.deepEqual(result, { stored: "created" });
    assert.equal(batches.length, 1);
    const [explanation, audit] = batches[0]!;
    assert.equal(explanation!.model, "explanation");
    assert.deepEqual(explanation!.args.data, {
      id: "00000000-0000-4000-8000-000000000001",
      createdAt: NOW,
      routingDecisionId: DECISION,
      engineResponse: engineExplainResponse(),
    });
    assert.equal(audit!.model, "auditLog");
    assert.deepEqual(audit!.args.data, {
      id: "00000000-0000-4000-8000-000000000002",
      at: NOW,
      userId: "u-analyst-1",
      action: "EXPLANATION_CREATE",
      requestId: "req-1",
      entityType: "Explanation",
      entityId: "00000000-0000-4000-8000-000000000001",
      outcome: "SUCCESS",
    });
  });

  it("returns the explanation stored first when the unique routingDecisionId is violated", async () => {
    const stored = { summary: "stored first" };
    const { client, reads } = fakeClient({ transactionError: uniqueViolation(RACE_META), existing: stored });
    const result = await createPrismaExplanationStore(client).save(input());
    assert.deepEqual(result, { stored: "existing", engineResponse: stored });
    assert.deepEqual(reads, [{ where: { routingDecisionId: DECISION }, select: { engineResponse: true } }]);
  });

  it("rethrows the routingDecisionId violation when no explanation can be reread", async () => {
    const error = uniqueViolation(RACE_META);
    const { client } = fakeClient({ transactionError: error });
    await assert.rejects(createPrismaExplanationStore(client).save(input()), (e) => e === error);
  });

  it("rethrows any other database error without reading", async () => {
    const error = new Prisma.PrismaClientKnownRequestError("FK failed", { code: "P2003", clientVersion: "6.19.3" });
    const { client, reads } = fakeClient({ transactionError: error });
    await assert.rejects(createPrismaExplanationStore(client).save(input()), (e) => e === error);
    assert.deepEqual(reads, []);
  });

  // Other unique violations are rethrown without a reread, even when an
  // explanation exists, so they are never mistaken for the race.
  const unrelated: Array<[string, Record<string, unknown> | undefined]> = [
    ["a duplicate AuditLog id", { modelName: "AuditLog", target: ["id"] }],
    ["a duplicate Explanation id", { modelName: "Explanation", target: ["id"] }],
    ["another Explanation constraint name", { modelName: "Explanation", target: "Explanation_pkey" }],
    ["routingDecisionId on another model", { modelName: "Allocation", target: ["routingDecisionId"] }],
    ["a composite target", { modelName: "Explanation", target: ["routingDecisionId", "id"] }],
    ["a field list without a model name", { target: ["routingDecisionId"] }],
    ["no meta", undefined],
  ];
  for (const [name, meta] of unrelated) {
    it(`rethrows a P2002 for ${name} without rereading`, async () => {
      const error = uniqueViolation(meta);
      const { client, reads } = fakeClient({ transactionError: error, existing: { summary: "stored" } });
      await assert.rejects(createPrismaExplanationStore(client).save(input()), (e) => e === error);
      assert.deepEqual(reads, []);
    });
  }
});

describe("isRoutingDecisionConflict", () => {
  it("accepts the Explanation.routingDecisionId violation as a field list or as the index name", () => {
    assert.equal(isRoutingDecisionConflict(uniqueViolation(RACE_META)), true);
    assert.equal(isRoutingDecisionConflict(uniqueViolation({ modelName: "Explanation", target: "Explanation_routingDecisionId_key" })), true);
    assert.equal(isRoutingDecisionConflict(uniqueViolation({ target: "Explanation_routingDecisionId_key" })), true);
  });

  it("rejects other codes and non-errors", () => {
    const p2003 = new Prisma.PrismaClientKnownRequestError("FK", { code: "P2003", clientVersion: "6.19.3", meta: RACE_META });
    assert.equal(isRoutingDecisionConflict(p2003), false);
    assert.equal(isRoutingDecisionConflict(new Error("x")), false);
    assert.equal(isRoutingDecisionConflict(null), false);
  });
});
