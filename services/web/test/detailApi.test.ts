import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, INVALID_RESPONSE, NETWORK_ERROR } from "../src/api/client";
import { isApiExplanation, isTransactionRecord, type ApiExplanation, type TransactionRecord } from "../src/api/types";
import {
  describeDetailError,
  EXPLANATION_MISMATCH,
  fetchExplanation,
  fetchTransactionDetail,
  isNotFound,
  mapExplanation,
  mapTransactionRecord,
} from "../src/features/transactions/detailApi";
import { fixtureExplanations, fixtureRecords } from "./msw/transactionDetail";

const ROUTED = "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f";
const FAILED = "a121dc5c-b250-5b30-8025-f9e07e76d4e0";
const REJECTED = "ab65a498-5f10-50e0-b3be-4e50d3f5b908";
const PARTIAL = "30bfe62e-365d-533c-8da6-3cefa289f713";
const PPO = "80fa54b8-7314-53de-aed4-fa530374768c";

const records = fixtureRecords();
const explanations = fixtureExplanations();
const record = (id: string) => structuredClone(records.get(id)) as unknown as TransactionRecord;
const explanation = (id: string) => structuredClone(explanations.get(id)) as unknown as ApiExplanation;

function clientReturning(body: unknown, init: ResponseInit = {}) {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" }, ...init }));
  return { api: createApiClient({ getToken: () => "t", fetchImpl }), fetchImpl };
}

describe("the contract fixtures", () => {
  it("include every record this screen is tested with", () => {
    for (const id of [ROUTED, FAILED, REJECTED, PARTIAL, PPO]) expect(records.has(id)).toBe(true);
    for (const id of [ROUTED, REJECTED, PPO]) expect(explanations.has(id)).toBe(true);
  });

  it("all pass the shape checks, so the checks and the contract agree", () => {
    for (const r of records.values()) expect(isTransactionRecord(r)).toBe(true);
    for (const e of explanations.values()) expect(isApiExplanation(e)).toBe(true);
  });
});

describe("mapTransactionRecord", () => {
  it("maps a completed transaction: policy, tier, state mode and regime come from the decision", () => {
    const raw = record(ROUTED);
    const view = mapTransactionRecord(raw);
    expect(view).toMatchObject({
      id: ROUTED,
      status: "routed",
      outcome: "completed",
      corridor: "GBR->PHL",
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000,
      simulationDate: "2024-06-14",
      policy: "waterfall",
      policyTier: "default",
      stateMode: "historicalReplay",
      clientReference: raw.transaction.clientReference,
      failure: null,
    });
    const decision = view.decision!;
    expect(decision.decisionId).toBe(raw.decision!.decisionId);
    expect(decision.decisionId).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(decision.regime).toBe(raw.decision!.diagnostics.regime);
    expect(decision.totals).toEqual({
      requestedUsd: raw.decision!.totals.requestedUsd,
      executedUsd: raw.decision!.totals.executedUsd,
      unroutedAmountBasedUsd: raw.decision!.totals.unroutedAmountBasedUsd,
      completionRatio: raw.decision!.totals.completionRatio,
      completed: true,
      bridgesUsed: raw.decision!.totals.bridgesUsed,
    });
    expect(decision.allocations).toHaveLength(raw.decision!.allocations.length);
    expect(decision.allocations[0]).toEqual({
      bridgeUid: raw.decision!.allocations[0]!.bridgeUid,
      dataSourceTag: raw.decision!.allocations[0]!.dataSourceTag,
      feePct: raw.decision!.allocations[0]!.feePct,
      liquidityUsd: raw.decision!.allocations[0]!.liquidityUsd,
      shareRequested: raw.decision!.allocations[0]!.shareRequested,
      amountRequestedUsd: raw.decision!.allocations[0]!.amountRequestedUsd,
      amountExecutedUsd: raw.decision!.allocations[0]!.amountExecutedUsd,
      amountClippedUsd: raw.decision!.allocations[0]!.amountClippedUsd,
    });
    expect(decision.warnings).toEqual(raw.decision!.warnings);
  });

  it("derives the outcome: partial, rejected, completed", () => {
    expect(mapTransactionRecord(record(PARTIAL)).outcome).toBe("partial");
    expect(mapTransactionRecord(record(REJECTED)).outcome).toBe("rejected");
    expect(mapTransactionRecord(record(ROUTED)).outcome).toBe("completed");
  });

  it("keeps a rejection's reason and its empty allocations", () => {
    const view = mapTransactionRecord(record(REJECTED));
    expect(view.decision!.feasibility.allowed).toBe(false);
    expect(view.decision!.feasibility.reason).toBeTruthy();
    expect(view.decision!.allocations).toEqual([]);
  });

  it("carries the experimental tier of a PPO decision", () => {
    expect(mapTransactionRecord(record(PPO))).toMatchObject({ policy: "ppoProjected", policyTier: "experimental" });
  });

  it("maps a failed transaction with no decision, policy, tier or state mode, and no corridor", () => {
    const raw = record(FAILED);
    const view = mapTransactionRecord(raw);
    expect(view).toMatchObject({
      id: FAILED,
      status: "failed",
      outcome: "failed",
      corridor: null,
      policy: null,
      policyTier: null,
      stateMode: null,
      decision: null,
      failure: { code: raw.failure!.code, message: raw.failure!.message },
    });
    expect(view.senderCountry).toBe(raw.transaction.senderCountry);
    expect(view.simulationDate).toBe(raw.transaction.simulationDate);
  });

  it("keeps a failed transaction's missing failure (an old row) as null", () => {
    const raw = record(FAILED);
    raw.failure = null;
    expect(mapTransactionRecord(raw).failure).toBeNull();
  });

  it("shows nothing of a decision on a transaction whose status is failed", () => {
    const raw = record(ROUTED);
    raw.status = "failed";
    expect(mapTransactionRecord(raw)).toMatchObject({ outcome: "failed", decision: null, policy: null });
  });

  it("passes unknown enum values through unchanged (contract §1)", () => {
    const raw = record(ROUTED);
    raw.decision!.policy = "someNewPolicy";
    raw.decision!.policyStatus = "gold";
    raw.decision!.provenance.stateMode = "futureMode";
    expect(mapTransactionRecord(raw)).toMatchObject({ policy: "someNewPolicy", policyTier: "gold", stateMode: "futureMode" });
  });
});

describe("isTransactionRecord", () => {
  it("ignores extra fields", () => {
    const raw = { ...record(ROUTED), extra: 1, createdBy: "u-1" } as unknown;
    expect(isTransactionRecord(raw)).toBe(true);
  });

  it.each([
    ["null", () => null],
    ["a routed transaction with no decision", () => ({ ...record(ROUTED), decision: null })],
    ["an amount that is a string", () => ({ ...record(ROUTED), transaction: { ...record(ROUTED).transaction, amountUsd: "300000" } })],
    ["an allocation without a venue", () => {
      const r = record(ROUTED);
      delete (r.decision!.allocations[0] as unknown as Record<string, unknown>).bridgeUid;
      return r;
    }],
    ["a decision without totals", () => {
      const r = record(ROUTED);
      delete (r.decision as unknown as Record<string, unknown>).totals;
      return r;
    }],
    ["a failure that is not {code, message}", () => ({ ...record(FAILED), failure: { code: 1 } })],
    ["a missing transaction", () => ({ ...record(ROUTED), transaction: undefined })],
  ])("rejects %s", (_name, make) => {
    expect(isTransactionRecord(make())).toBe(false);
  });
});

describe("isApiExplanation and mapExplanation", () => {
  it("maps the waterfall explanation", () => {
    const raw = explanation(ROUTED);
    const view = mapExplanation(raw);
    expect(view.decisionId).toBe(raw.decisionId);
    expect(view.summary).toBe(raw.summary);
    expect(view.venues.map((v) => v.bridgeUid)).toEqual(raw.venueExplanations.map((v) => v.bridgeUid));
    expect(view.venues[0]).toEqual({
      bridgeUid: raw.venueExplanations[0]!.bridgeUid,
      outcome: raw.venueExplanations[0]!.outcome,
      reasonCode: raw.venueExplanations[0]!.reasonCode,
      text: raw.venueExplanations[0]!.text,
    });
    expect(view.feasibility.allowed).toBe(true);
    expect(view.feasibility.provider).toBe("StaticMemoryProvider");
    expect(view.limitations.length).toBeGreaterThan(0);
  });

  it("keeps a PPO decision's policy notes", () => {
    expect(mapExplanation(explanation(PPO)).policyNotes.length).toBeGreaterThan(0);
  });

  it("keeps a rejection's reason and every venue unused", () => {
    const view = mapExplanation(explanation(REJECTED));
    expect(view.feasibility.allowed).toBe(false);
    expect(view.feasibility.reason).toBeTruthy();
    expect(view.venues.every((v) => v.outcome === "unused")).toBe(true);
  });

  it("writes a fact's untyped value as text, whatever it is", () => {
    const raw = explanation(ROUTED);
    const base = raw.feasibility.activeFacts[0]!;
    raw.feasibility.activeFacts = [
      { ...base, factId: "a", value: 500000 },
      { ...base, factId: "b", value: "text" },
      { ...base, factId: "c", value: { nested: [1, 2] } },
      { ...base, factId: "d", value: null },
      { ...base, factId: "e", value: true },
    ];
    expect(mapExplanation(raw).feasibility.facts.map((f) => f.valueText)).toEqual(["500000", "text", '{"nested":[1,2]}', "null", "true"]);
  });

  it("requires a fact's value to be present, accepts extra fields, and rejects other bad shapes", () => {
    expect(isApiExplanation({ ...explanation(ROUTED), extra: 1, semanticContext: null })).toBe(true);
    const noValue = explanation(ROUTED);
    delete (noValue.feasibility.activeFacts[0] as unknown as Record<string, unknown>).value;
    expect(isApiExplanation(noValue)).toBe(false);
    expect(isApiExplanation({ ...explanation(ROUTED), venueExplanations: "x" })).toBe(false);
    expect(isApiExplanation({ ...explanation(ROUTED), limitations: [1] })).toBe(false);
    expect(isApiExplanation(null)).toBe(false);
  });
});

describe("fetchTransactionDetail", () => {
  it("asks for /transactions/<id> and maps the record", async () => {
    const { api, fetchImpl } = clientReturning(records.get(ROUTED));
    const view = await fetchTransactionDetail(api, ROUTED);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/transactions/${ROUTED}`);
    expect(view.id).toBe(ROUTED);
  });

  it("refuses a body that isn't a record, or is for another transaction", async () => {
    const bad = clientReturning({ nope: true });
    await expect(fetchTransactionDetail(bad.api, ROUTED)).rejects.toMatchObject({ code: INVALID_RESPONSE });
    const other = clientReturning(records.get(PARTIAL));
    await expect(fetchTransactionDetail(other.api, ROUTED)).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });

  it("passes a 404 on as an ApiError", async () => {
    const { api } = clientReturning({ error: { code: "NOT_FOUND", message: "x", details: {} } }, { status: 404 });
    const error = await fetchTransactionDetail(api, ROUTED).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isNotFound(error)).toBe(true);
    expect(isNotFound(new ApiError({ status: 500, code: "X", message: "m" }))).toBe(false);
  });
});

describe("fetchExplanation", () => {
  const decisionId = (id: string) => (records.get(id) as unknown as TransactionRecord).decision!.decisionId;

  it("asks for /transactions/<id>/explanation and returns the explanation", async () => {
    const { api, fetchImpl } = clientReturning(explanations.get(ROUTED));
    const view = await fetchExplanation(api, ROUTED, decisionId(ROUTED));
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${window.location.origin}/api/v1/transactions/${ROUTED}/explanation`);
    expect(view.decisionId).toBe(decisionId(ROUTED));
  });

  it("refuses an explanation for another decision", async () => {
    const { api } = clientReturning({ ...explanation(ROUTED), decisionId: decisionId(PPO) });
    await expect(fetchExplanation(api, ROUTED, decisionId(ROUTED))).rejects.toMatchObject({ code: EXPLANATION_MISMATCH });
  });

  it("refuses an explanation for another transaction", async () => {
    const { api } = clientReturning(explanation(PPO));
    await expect(fetchExplanation(api, ROUTED, decisionId(PPO))).rejects.toMatchObject({ code: EXPLANATION_MISMATCH });
  });

  it("compares the transaction ID without regard to letter case", async () => {
    const { api } = clientReturning({ ...explanation(ROUTED), transactionId: ROUTED.toUpperCase() });
    await expect(fetchExplanation(api, ROUTED, decisionId(ROUTED))).resolves.toBeTruthy();
  });

  it("refuses a body that isn't an explanation", async () => {
    const { api } = clientReturning({ summary: "x" });
    await expect(fetchExplanation(api, ROUTED, decisionId(ROUTED))).rejects.toMatchObject({ code: INVALID_RESPONSE });
  });
});

describe("describeDetailError", () => {
  const api = (status: number, code: string, extra: Partial<ConstructorParameters<typeof ApiError>[0]> = {}) =>
    new ApiError({ status, code, message: "BACKEND TEXT", ...extra });

  it("words every case itself, never with the backend's message", () => {
    const errors = [
      api(0, NETWORK_ERROR),
      api(200, INVALID_RESPONSE),
      api(200, EXPLANATION_MISMATCH),
      api(404, "NOT_FOUND"),
      api(409, "TRANSACTION_FAILED"),
      api(409, "POLICY_DISABLED"),
      api(409, "DECISION_MISMATCH"),
      api(503, "ENGINE_BUSY"),
      api(503, "INFERENCE_UNAVAILABLE"),
      api(504, "ENGINE_TIMEOUT"),
      api(502, "INFERENCE_ERROR"),
      api(500, "INTERNAL_ERROR"),
      api(403, "FORBIDDEN_POLICY"),
      api(418, "TEAPOT"),
    ];
    for (const error of errors) expect(describeDetailError(error, "explanation").message).not.toContain("BACKEND TEXT");
  });

  it("offers a retry only where asking again can help", () => {
    const can = (error: ApiError) => describeDetailError(error, "explanation").canRetry;
    for (const retryable of [api(0, NETWORK_ERROR), api(200, INVALID_RESPONSE), api(503, "ENGINE_BUSY"), api(503, "INFERENCE_UNAVAILABLE"), api(504, "ENGINE_TIMEOUT"), api(502, "INFERENCE_ERROR"), api(500, "INTERNAL_ERROR")]) {
      expect(can(retryable)).toBe(true);
    }
    for (const permanent of [api(200, EXPLANATION_MISMATCH), api(404, "NOT_FOUND"), api(409, "TRANSACTION_FAILED"), api(409, "POLICY_DISABLED"), api(409, "DECISION_MISMATCH"), api(403, "FORBIDDEN_POLICY")]) {
      expect(can(permanent)).toBe(false);
    }
  });

  it("says the engine is starting up only for a 503 with cause NOT_READY", () => {
    const starting = describeDetailError(api(503, "INFERENCE_UNAVAILABLE", { details: { cause: "NOT_READY" } }), "explanation");
    const down = describeDetailError(api(503, "INFERENCE_UNAVAILABLE"), "explanation");
    expect(starting.message).toMatch(/starting up/);
    expect(down.message).toMatch(/unavailable/);
    expect(down.message).not.toMatch(/starting up/);
  });

  it("mentions Retry-After seconds when the server gave them", () => {
    expect(describeDetailError(api(503, "ENGINE_BUSY", { retryAfterSeconds: 1 }), "explanation").message).toMatch(/about 1 second\./);
    expect(describeDetailError(api(503, "ENGINE_BUSY", { retryAfterSeconds: 5 }), "explanation").message).toMatch(/about 5 seconds/);
    expect(describeDetailError(api(503, "ENGINE_BUSY"), "explanation").message).toMatch(/in a moment/);
  });

  it("carries the request ID, lists a 422's fields, and copes with a plain Error", () => {
    expect(describeDetailError(api(500, "INTERNAL_ERROR", { requestId: "req-1" }), "transaction").reference).toBe("req-1");
    const unprocessable = describeDetailError(
      api(422, "VALIDATION_ERROR", { details: { errors: [{ field: "id", message: "bad" }, { message: "Form-level." }] } }),
      "transaction",
    );
    expect(unprocessable.details).toEqual(["id: bad", "Form-level."]);
    expect(describeDetailError(new Error("x"), "transaction").message).toMatch(/went wrong/);
  });
});
