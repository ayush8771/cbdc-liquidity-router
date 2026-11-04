import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import type { ExplanationStore, ExplanationTarget, NewExplanation } from "../../src/db/explanations.js";
import { createInferenceClient, type InferenceRequest, type MockResponse } from "../../src/inferenceClient/client.js";
import { DECISION_MISMATCH_MESSAGE, TRANSACTION_FAILED_MESSAGE } from "../../src/routes/explanations.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import { appExplanation, engineError, engineExplainResponse } from "../helpers/transactions.js";

// GET /api/v1/transactions/:id/explanation (API contract §3.5) with a fake
// store and the mock inference client: no database and no network. The real
// Prisma store, its atomic batch and the unique-constraint race are tested in
// explanationStore.test.ts and against PostgreSQL in the integration suite.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];

const ROUTED_ID = "56d0d708-62d6-59aa-aa8d-4df8d9b8d37f";
const PPO_ID = "6f1c2a9e-0b7d-4c3e-9a51-2d8e7f4b6c10";
const FAILED_ID = "a121dc5c-b250-5b30-8025-f9e07e76d4e0";
const UNKNOWN_ID = "00000000-0000-4000-8000-000000000000";
const CHECKPOINT = "a".repeat(64);
const ROUTE_BODY = {
  transaction: { sender_country: "GBR", receiver_country: "PHL", amount_usd: 300000.0 },
  state: { mode: "historical_replay", date: "2024-06-14" },
  policy: "waterfall",
};

function routedTarget(overrides: Partial<ExplanationTarget> = {}): ExplanationTarget {
  return {
    id: ROUTED_ID,
    status: "routed",
    senderCountry: "GBR",
    receiverCountry: "PHL",
    amountUsd: 300000.0,
    stateSpec: { mode: "historicalReplay", date: "2024-06-14" },
    requestedPolicy: "waterfall",
    clientReference: null,
    decision: { id: "11111111-1111-4111-8111-111111111111", decisionId: "sha256:9f2c", checkpointSha256: null, explanation: null },
    ...overrides,
  };
}

function ppoTarget(explanation: { engineResponse: Prisma.JsonValue } | null = null): ExplanationTarget {
  return routedTarget({
    id: PPO_ID,
    requestedPolicy: "ppoProjected",
    decision: { id: "22222222-2222-4222-8222-222222222222", decisionId: "sha256:9f2c", checkpointSha256: CHECKPOINT, explanation },
  });
}

function failedTarget(): ExplanationTarget {
  return routedTarget({ id: FAILED_ID, status: "failed", decision: null });
}

/** An in-memory store. save() behaves like the unique routingDecisionId: the first save wins. */
function fakeStore(targets: ExplanationTarget[], options: { saveError?: Error; userExists?: boolean } = {}) {
  const lookups: string[] = [];
  const saves: NewExplanation[] = [];
  const stored = new Map<string, Prisma.JsonValue>();
  const store: ExplanationStore = {
    async findTarget(id) {
      lookups.push(id);
      const target = targets.find((t) => t.id === id.toLowerCase());
      if (target === undefined) return null;
      const body = target.decision && stored.get(target.decision.id);
      return body === undefined || target.decision === null
        ? structuredClone(target)
        : { ...structuredClone(target), decision: { ...target.decision, explanation: { engineResponse: body } } };
    },
    async userExists() {
      return options.userExists ?? true;
    },
    async save(input) {
      saves.push(input);
      if (options.saveError) throw options.saveError;
      const existing = stored.get(input.routingDecisionId);
      if (existing !== undefined) return { stored: "existing", engineResponse: existing };
      stored.set(input.routingDecisionId, structuredClone(input.engineResponse) as Prisma.JsonValue);
      return { stored: "created" };
    },
  };
  return { store, lookups, saves, stored };
}

type Answers = Partial<Record<string, MockResponse | undefined>>;

function mockClient(answers: Answers) {
  const calls: InferenceRequest[] = [];
  const client = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        calls.push(request as InferenceRequest);
        return answers[request.path];
      },
    },
  );
  return { client, calls };
}

const OK: Answers = { "/v1/explain": { status: 200, body: engineExplainResponse() } };

async function request(
  id: string,
  {
    store,
    answers = OK,
    token = analystToken,
    method = "GET",
    logger = silentLogger,
    requestId = "req-explain",
  }: { store?: ExplanationStore; answers?: Answers; token?: string | null; method?: string; logger?: typeof silentLogger; requestId?: string } = {},
) {
  const { client, calls } = mockClient(answers);
  const app = createApp({ logger, users, inferenceClient: client, ...(store && { explanations: store }) });
  const server = await startServer(app);
  try {
    const res = await fetch(`${server.baseUrl}/api/v1/transactions/${id}/explanation`, {
      method,
      headers: { "X-Request-Id": requestId, ...(token !== null && { Authorization: `Bearer ${token}` }) },
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : undefined, calls };
  } finally {
    await server.close();
  }
}

function assertError(res: { status: number; body?: Record<string, any> }, status: number, code: string) {
  assert.equal(res.status, status);
  assert.deepEqual(Object.keys(res.body!), ["error"]);
  assert.deepEqual(Object.keys(res.body!.error), ["code", "message", "details", "requestId"]);
  assert.equal(res.body!.error.code, code);
  assert.equal(res.body!.error.requestId, "req-explain");
}

describe("GET /api/v1/transactions/:id/explanation: first request", () => {
  it("calls /v1/explain with the stored request, stores the result and returns the Explanation", async () => {
    const { store, saves } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, { store });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { transactionId: ROUTED_ID, ...appExplanation() });
    assert.deepEqual(Object.keys(res.body!), [
      "transactionId", "decisionId", "policy", "summary", "feasibility", "venueExplanations", "policyNotes",
      "semanticContext", "limitations",
    ]);
    assert.equal(res.calls.length, 1);
    assert.equal(res.calls[0]!.method, "POST");
    assert.equal(res.calls[0]!.path, "/v1/explain");
    assert.deepEqual(res.calls[0]!.body, ROUTE_BODY);
    assert.equal(res.calls[0]!.requestId, "req-explain");
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0], {
      routingDecisionId: "11111111-1111-4111-8111-111111111111",
      engineResponse: engineExplainResponse(),
      userId: "u-analyst-1",
      requestId: "req-explain",
    });
  });

  it("sends the stored state and client reference, mapped to engine spelling", async () => {
    const target = routedTarget({
      requestedPolicy: "cheapestFeasible",
      clientReference: "demo-001",
      stateSpec: { mode: "scenario", date: "2024-06-14", scenarioId: "liquidity_minus30" },
    });
    const { store } = fakeStore([target]);
    const res = await request(ROUTED_ID, {
      store,
      answers: { "/v1/explain": { status: 200, body: engineExplainResponse({ policy: "cheapest_feasible" }) } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body!.policy, "cheapestFeasible");
    assert.deepEqual(res.calls[0]!.body, {
      transaction: { sender_country: "GBR", receiver_country: "PHL", amount_usd: 300000.0, client_reference: "demo-001" },
      state: { mode: "scenario", date: "2024-06-14", scenario_id: "liquidity_minus30" },
      policy: "cheapest_feasible",
    });
  });

  it("drops unknown engine fields from the body but stores the engine response verbatim", async () => {
    const engine = engineExplainResponse({
      extra_top: 1,
      feasibility: { ...(engineExplainResponse().feasibility as object), extra: true },
    });
    const { store, saves } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, { store, answers: { "/v1/explain": { status: 200, body: engine } } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { transactionId: ROUTED_ID, ...appExplanation() });
    assert.deepEqual(saves[0]!.engineResponse, engine);
  });

  it("keeps unknown outcome and reason_code values rather than failing (§1)", async () => {
    const engine = engineExplainResponse({
      venue_explanations: [{ bridge_uid: "GBR->PHL#0", outcome: "partial", reason_code: "NEW_CODE", text: "t" }],
    });
    const { store } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, { store, answers: { "/v1/explain": { status: 200, body: engine } } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body!.venueExplanations, [{ bridgeUid: "GBR->PHL#0", outcome: "partial", reasonCode: "NEW_CODE", text: "t" }]);
  });

  it("explains a regulatory rejection like any routed decision", async () => {
    const engine = engineExplainResponse({
      feasibility: { allowed: false, reason: "amount exceeds the regulatory cap", active_facts: [], provider: "StaticMemoryProvider" },
      venue_explanations: [{ bridge_uid: "GBR->PHL#0", outcome: "unused", reason_code: "INFEASIBLE_REGULATORY", text: "t" }],
    });
    const { store, saves } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, { store, answers: { "/v1/explain": { status: 200, body: engine } } });
    assert.equal(res.status, 200);
    assert.equal(res.body!.feasibility.allowed, false);
    assert.equal(saves.length, 1);
  });
});

describe("GET /api/v1/transactions/:id/explanation: stored explanation", () => {
  it("returns the stored explanation on a repeat request without calling inference or writing", async () => {
    const { store, saves } = fakeStore([routedTarget()]);
    const first = await request(ROUTED_ID, { store });
    const second = await request(ROUTED_ID, { store, answers: {} });
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);
    assert.equal(second.calls.length, 0);
    assert.equal(saves.length, 1);
  });

  it("returns a stored ppoProjected explanation even when no checkpoint is enabled now (Q17 rule 1)", async () => {
    const stored = engineExplainResponse({ policy: "ppo_projected" }) as Prisma.JsonValue;
    const { store, saves } = fakeStore([ppoTarget({ engineResponse: stored })]);
    const res = await request(PPO_ID, {
      store,
      answers: { "/v1/version": { status: 200, body: { checkpoint: null } } },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body!.policy, "ppoProjected");
    assert.equal(res.calls.length, 0); // neither /v1/version nor /v1/explain
    assert.equal(saves.length, 0);
  });

  it("returns 500 INTERNAL_ERROR for a stored explanation that no longer maps, logging field paths only", async () => {
    const capture = captureLogger();
    const stored = { ...engineExplainResponse(), summary: 42, limitations: "secret-value" } as Prisma.JsonValue;
    const { store } = fakeStore([routedTarget({ decision: { ...routedTarget().decision!, explanation: { engineResponse: stored } } })]);
    const res = await request(ROUTED_ID, { store, logger: capture.logger });
    assertError(res, 500, "INTERNAL_ERROR");
    assert.equal(res.body!.error.message, "An unexpected error occurred.");
    assert.equal(res.calls.length, 0);
    const logged = capture.entries().find((e) => e.msg === "stored explanation no longer maps");
    assert.deepEqual(logged?.problems, ["summary", "limitations"]);
    assert.ok(!capture.lines.join("\n").includes("secret-value"));
  });
});

describe("GET /api/v1/transactions/:id/explanation: concurrent first requests", () => {
  it("stores one explanation; the request that lost the race returns the stored one", async () => {
    const { store, saves, stored } = fakeStore([routedTarget()]);
    // Both requests read "no explanation" before either saves.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const gatedStore: ExplanationStore = {
      ...store,
      async save(input) {
        if (++waiting === 2) release();
        await gate;
        return store.save(input);
      },
    };
    const [a, b] = await Promise.all([request(ROUTED_ID, { store: gatedStore }), request(ROUTED_ID, { store: gatedStore })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.body, b.body);
    assert.equal(saves.length, 2); // both tried; the fake, like the unique key, accepted one
    assert.equal(stored.size, 1);
  });

  it("returns the explanation that was stored first when another request won with a different body", async () => {
    const { store } = fakeStore([routedTarget()]);
    const first = engineExplainResponse({ summary: "stored first" }) as Record<string, unknown>;
    await store.save({ routingDecisionId: routedTarget().decision!.id, engineResponse: first, userId: "u", requestId: "r" });
    // A store whose findTarget still saw no explanation (read before the other commit).
    const stale: ExplanationStore = { ...store, findTarget: async () => routedTarget() };
    const res = await request(ROUTED_ID, { store: stale });
    assert.equal(res.status, 200);
    assert.equal(res.body!.summary, "stored first");
  });
});

describe("GET /api/v1/transactions/:id/explanation: DECISION_MISMATCH", () => {
  it("returns 409 when the engine's decision_id differs from the stored one, storing nothing", async () => {
    const { store, saves } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, {
      store,
      answers: { "/v1/explain": { status: 200, body: engineExplainResponse({ decision_id: "sha256:other" }) } },
    });
    assertError(res, 409, "DECISION_MISMATCH");
    assert.equal(res.body!.error.message, DECISION_MISMATCH_MESSAGE);
    assert.deepEqual(res.body!.error.details, {});
    assert.equal(saves.length, 0);
  });

  it("returns 409 for ppoProjected when the enabled checkpoint differs, without calling /v1/explain (Q17 rule 3)", async () => {
    const { store, saves } = fakeStore([ppoTarget()]);
    const res = await request(PPO_ID, {
      store,
      answers: { "/v1/version": { status: 200, body: { checkpoint: { sha256: "b".repeat(64) } } } },
    });
    assertError(res, 409, "DECISION_MISMATCH");
    assert.deepEqual(res.calls.map((c) => c.path), ["/v1/version"]);
    assert.equal(saves.length, 0);
  });

  it("explains ppoProjected when the enabled checkpoint matches the stored one (Q17 rule 4)", async () => {
    const { store, saves } = fakeStore([ppoTarget()]);
    const res = await request(PPO_ID, {
      store,
      answers: {
        "/v1/version": { status: 200, body: { checkpoint: { checkpoint_id: "c", sha256: CHECKPOINT } } },
        "/v1/explain": { status: 200, body: engineExplainResponse({ policy: "ppo_projected" }) },
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body!.policy, "ppoProjected");
    assert.deepEqual(res.calls.map((c) => c.path), ["/v1/version", "/v1/explain"]);
    assert.equal((res.calls[1]!.body as Record<string, unknown>).policy, "ppo_projected");
    assert.equal(saves.length, 1);
  });
});

describe("GET /api/v1/transactions/:id/explanation: POLICY_DISABLED", () => {
  it("returns 409 when no checkpoint is enabled, without calling /v1/explain (Q17 rule 2)", async () => {
    const { store, saves } = fakeStore([ppoTarget()]);
    const res = await request(PPO_ID, { store, answers: { "/v1/version": { status: 200, body: { checkpoint: null } } } });
    assertError(res, 409, "POLICY_DISABLED");
    assert.equal(res.body!.error.message, "The experimental PPO policy has no approved checkpoint enabled.");
    assert.deepEqual(res.calls.map((c) => c.path), ["/v1/version"]);
    assert.equal(saves.length, 0);
  });

  it("passes through an engine 409 POLICY_DISABLED with the backend's message, storing nothing", async () => {
    const { store, saves } = fakeStore([ppoTarget()]);
    const res = await request(PPO_ID, {
      store,
      answers: {
        "/v1/version": { status: 200, body: { checkpoint: { sha256: CHECKPOINT } } },
        "/v1/explain": { status: 409, body: engineError("POLICY_DISABLED", "engine-secret-text") },
      },
    });
    assertError(res, 409, "POLICY_DISABLED");
    assert.ok(!res.text.includes("engine-secret-text"));
    assert.equal(saves.length, 0);
  });

  it("returns 502 for a /v1/version body without a usable checkpoint", async () => {
    for (const body of [{}, { checkpoint: "x" }, { checkpoint: {} }, { checkpoint: { sha256: 1 } }, { checkpoint: [] }]) {
      const { store, saves } = fakeStore([ppoTarget()]);
      const res = await request(PPO_ID, { store, answers: { "/v1/version": { status: 200, body } } });
      assertError(res, 502, "INFERENCE_ERROR");
      assert.equal(res.calls.length, 1, JSON.stringify(body));
      assert.equal(saves.length, 0);
    }
  });

  it("does not read /v1/version for non-PPO decisions", async () => {
    const { store } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, { store });
    assert.deepEqual(res.calls.map((c) => c.path), ["/v1/explain"]);
  });
});

describe("GET /api/v1/transactions/:id/explanation: failed transactions", () => {
  it("returns 409 TRANSACTION_FAILED with the fixed message, without calling inference or storing", async () => {
    const { store, saves } = fakeStore([failedTarget()]);
    const res = await request(FAILED_ID, { store });
    assertError(res, 409, "TRANSACTION_FAILED");
    assert.equal(res.body!.error.message, TRANSACTION_FAILED_MESSAGE);
    assert.deepEqual(res.body!.error.details, {});
    assert.equal(res.calls.length, 0);
    assert.equal(saves.length, 0);
  });
});

describe("GET /api/v1/transactions/:id/explanation: IDs", () => {
  it("returns 404 NOT_FOUND for an unknown UUID", async () => {
    const { store, lookups, saves } = fakeStore([routedTarget()]);
    const res = await request(UNKNOWN_ID, { store });
    assertError(res, 404, "NOT_FOUND");
    assert.equal(res.body!.error.message, "Unknown resource.");
    assert.deepEqual(lookups, [UNKNOWN_ID]);
    assert.equal(res.calls.length, 0);
    assert.equal(saves.length, 0);
  });

  it("returns 404 NOT_FOUND for a malformed ID without touching the store", async () => {
    for (const id of ["abc", "56d0d708-62d6-59aa-aa8d-4df8d9b8d37", "56d0d708x62d6-59aa-aa8d-4df8d9b8d37f", "%20", "1"]) {
      const { store, lookups } = fakeStore([routedTarget()]);
      const res = await request(id, { store });
      assertError(res, 404, "NOT_FOUND");
      assert.ok(!res.text.includes(id === "%20" ? "%20" : id), id); // the ID is never echoed
      assert.deepEqual(lookups, [], id);
    }
  });

  it("accepts an upper-case UUID", async () => {
    const { store } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID.toUpperCase(), { store });
    assert.equal(res.status, 200);
  });
});

describe("GET /api/v1/transactions/:id/explanation: authentication and access", () => {
  it("returns 401 without a token or with an unknown one, before any lookup", async () => {
    for (const token of [null, "not-a-token", newToken()]) {
      const { store, lookups } = fakeStore([routedTarget()]);
      const res = await request(ROUTED_ID, { store, token });
      assertError(res, 401, "UNAUTHENTICATED");
      assert.deepEqual(lookups, []);
      assert.equal(res.calls.length, 0);
    }
  });

  it("lets a viewer read any transaction's explanation, including a ppoProjected one", async () => {
    const { store, saves } = fakeStore([routedTarget(), ppoTarget()]);
    const res = await request(ROUTED_ID, { store, token: viewerToken });
    assert.equal(res.status, 200);
    assert.equal(saves[0]!.userId, "u-viewer-1");
    const ppo = await request(PPO_ID, {
      store,
      token: viewerToken,
      answers: {
        "/v1/version": { status: 200, body: { checkpoint: { sha256: CHECKPOINT } } },
        "/v1/explain": { status: 200, body: engineExplainResponse({ policy: "ppo_projected" }) },
      },
    });
    assert.equal(ppo.status, 200);
  });
});

describe("GET /api/v1/transactions/:id/explanation: inference errors store nothing", () => {
  const cases: Array<[string, MockResponse | undefined, number, string]> = [
    ["unreachable (mock without an answer)", undefined, 503, "INFERENCE_UNAVAILABLE"],
    ["NOT_READY", { status: 503, body: engineError("NOT_READY"), retryAfter: "5" }, 503, "INFERENCE_UNAVAILABLE"],
    ["ENGINE_BUSY", { status: 503, body: engineError("ENGINE_BUSY"), retryAfter: "7" }, 503, "ENGINE_BUSY"],
    ["ENGINE_TIMEOUT", { status: 504, body: engineError("ENGINE_TIMEOUT") }, 504, "ENGINE_TIMEOUT"],
    ["engine INTERNAL_ERROR", { status: 500, body: engineError("INTERNAL_ERROR") }, 502, "INFERENCE_ERROR"],
    ["engine 422", { status: 422, body: engineError("DATE_OUT_OF_RANGE") }, 422, "DATE_OUT_OF_RANGE"],
    ["engine NOT_FOUND", { status: 404, body: engineError("NOT_FOUND") }, 502, "INFERENCE_ERROR"],
    ["a non-object body", { status: 200, body: [] }, 502, "INFERENCE_ERROR"],
    ["a missing field", { status: 200, body: { ...engineExplainResponse(), summary: undefined } }, 502, "INFERENCE_ERROR"],
    ["empty limitations", { status: 200, body: engineExplainResponse({ limitations: [] }) }, 502, "INFERENCE_ERROR"],
    ["non-null semantic_context", { status: 200, body: engineExplainResponse({ semantic_context: {} }) }, 502, "INFERENCE_ERROR"],
    ["another provider", { status: 200, body: engineExplainResponse({ feasibility: { allowed: true, reason: null, active_facts: [], provider: "Cognee" } }) }, 502, "INFERENCE_ERROR"],
    ["another policy", { status: 200, body: engineExplainResponse({ policy: "cheapest_feasible" }) }, 502, "INFERENCE_ERROR"],
  ];
  for (const [name, answer, status, code] of cases) {
    it(`${name} -> ${status} ${code}`, async () => {
      const { store, saves } = fakeStore([routedTarget()]);
      const res = await request(ROUTED_ID, { store, answers: { "/v1/explain": answer } });
      assertError(res, status, code);
      assert.ok(!res.text.includes("upstream message"));
      assert.ok(!("transactionId" in res.body!.error.details));
      assert.equal(saves.length, 0);
    });
  }

  it("forwards Retry-After for ENGINE_BUSY", async () => {
    const { store } = fakeStore([routedTarget()]);
    const res = await request(ROUTED_ID, {
      store,
      answers: { "/v1/explain": { status: 503, body: engineError("ENGINE_BUSY"), retryAfter: "7" } },
    });
    assert.equal(res.headers.get("retry-after"), "7");
  });
});

describe("GET /api/v1/transactions/:id/explanation: configuration and database faults", () => {
  it("returns 500 when the store is not configured (no DATABASE_URL)", async () => {
    const res = await request(ROUTED_ID);
    assertError(res, 500, "INTERNAL_ERROR");
    assert.equal(res.calls.length, 0);
  });

  it("returns 500 before calling inference when the caller has no User row", async () => {
    const { store, saves } = fakeStore([routedTarget()], { userExists: false });
    const res = await request(ROUTED_ID, { store });
    assertError(res, 500, "INTERNAL_ERROR");
    assert.equal(res.calls.length, 0);
    assert.equal(saves.length, 0);
  });

  it("returns 500 with the generic message when the save fails", async () => {
    const { store, stored } = fakeStore([routedTarget()], { saveError: new Error("db down: secret-host") });
    const res = await request(ROUTED_ID, { store });
    assertError(res, 500, "INTERNAL_ERROR");
    assert.ok(!res.text.includes("secret-host"));
    assert.equal(stored.size, 0);
  });

  it("returns 500 for a routed transaction without a decision row", async () => {
    const { store } = fakeStore([routedTarget({ decision: null })]);
    const res = await request(ROUTED_ID, { store });
    assertError(res, 500, "INTERNAL_ERROR");
    assert.equal(res.calls.length, 0);
  });
});

describe("GET /api/v1/transactions/:id/explanation: methods", () => {
  it("returns 405 with Allow: GET for other methods, before auth and without a lookup", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const { store, lookups } = fakeStore([routedTarget()]);
      const res = await request(ROUTED_ID, { store, method, token: null });
      assertError(res, 405, "METHOD_NOT_ALLOWED");
      assert.equal(res.headers.get("allow"), "GET", method);
      assert.equal(res.body!.error.message, `Method ${method} is not allowed on /api/v1/transactions/:id/explanation.`);
      assert.deepEqual(lookups, []);
    }
  });

  // HEAD responses have no body, so only the status and headers are checked.
  for (const [name, target] of [
    ["no stored explanation", routedTarget()],
    ["a stored explanation", routedTarget({
      decision: { ...routedTarget().decision!, explanation: { engineResponse: engineExplainResponse() as Prisma.JsonValue } },
    })],
    ["a stored-less ppoProjected decision", ppoTarget()],
  ] as const) {
    it(`returns 405 with Allow: GET for HEAD with ${name}, without inference, lookup or writes`, async () => {
      const { store, lookups, saves, stored } = fakeStore([target]);
      for (const token of [analystToken, null]) {
        const res = await request(target.id, {
          store,
          method: "HEAD",
          token,
          answers: {
            "/v1/version": { status: 200, body: { checkpoint: { sha256: CHECKPOINT } } },
            "/v1/explain": { status: 200, body: engineExplainResponse() },
          },
        });
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "GET");
        assert.equal(res.text, "");
        assert.deepEqual(res.calls, []);
      }
      assert.deepEqual(lookups, []);
      assert.deepEqual(saves, []);
      assert.equal(stored.size, 0);
    });
  }

  it("leaves GET unchanged after a rejected HEAD", async () => {
    const { store, saves } = fakeStore([routedTarget()]);
    await request(ROUTED_ID, { store, method: "HEAD" });
    const res = await request(ROUTED_ID, { store });
    assert.equal(res.status, 200);
    assert.equal(saves.length, 1);
  });

  it("keeps HEAD for other endpoints (e.g. GET /api/v1/transactions/:id)", async () => {
    const app = createApp({ logger: silentLogger, users });
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions/${ROUTED_ID}`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${analystToken}` },
      });
      assert.notEqual(res.status, 405);
      const del = await fetch(`${server.baseUrl}/api/v1/transactions/${ROUTED_ID}`, { method: "DELETE" });
      assert.equal(del.headers.get("allow"), "GET, HEAD");
    } finally {
      await server.close();
    }
  });
});
