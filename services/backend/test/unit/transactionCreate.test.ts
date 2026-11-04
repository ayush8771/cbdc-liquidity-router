import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import type {
  RoutedTransaction,
  SavedTransaction,
  FailedTransaction,
  TransactionPersistence,
} from "../../src/db/transactionPersistence.js";
import { createInferenceClient, type InferenceRequest, type MockResponse } from "../../src/inferenceClient/client.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import {
  SCENARIO_IDS,
  engineError,
  engineRegulatoryRejection,
  engineRouteResponse,
  requestBody,
} from "../helpers/transactions.js";

// POST /api/v1/transactions with a fake persistence layer and the mock-mode
// inference client: no database and no network.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const SAVED: SavedTransaction = { id: "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f", createdAt: new Date("2026-11-02T10:00:00.123Z") };

interface FakeOptions {
  userExists?: boolean;
  saveError?: Error;
}

function fakePersistence({ userExists = true, saveError }: FakeOptions = {}) {
  const calls = { userExists: [] as string[], routed: [] as RoutedTransaction[], failed: [] as FailedTransaction[] };
  const persistence: TransactionPersistence = {
    async userExists(userId) {
      calls.userExists.push(userId);
      return userExists;
    },
    async saveRouted(input) {
      calls.routed.push(input);
      if (saveError) throw saveError;
      return SAVED;
    },
    async saveFailed(input) {
      calls.failed.push(input);
      if (saveError) throw saveError;
      return SAVED;
    },
  };
  return { persistence, calls };
}

type Answer = MockResponse | undefined | ((request: Readonly<InferenceRequest>) => MockResponse | undefined);

interface Setup extends FakeOptions {
  answer?: Answer;
  persistence?: false;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

async function post(setup: Setup = {}) {
  const fake = fakePersistence(setup);
  const inferenceCalls: Array<Readonly<InferenceRequest>> = [];
  const answer = setup.answer ?? { status: 200, body: engineRouteResponse() };
  const inferenceClient = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        inferenceCalls.push(request);
        return typeof answer === "function" ? answer(request) : answer;
      },
    },
  );
  const capture = captureLogger();
  const app = createApp({
    logger: capture.logger,
    users,
    inferenceClient,
    ...(setup.persistence !== false && { transactionPersistence: fake.persistence }),
  });
  const server = await startServer(app);
  try {
    const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(setup.token !== "" && { Authorization: `Bearer ${setup.token ?? analystToken}` }),
        ...setup.headers,
      },
      body: setup.rawBody ?? JSON.stringify(setup.body ?? requestBody()),
    });
    const text = await res.text();
    return {
      res,
      body: JSON.parse(text) as Record<string, any>,
      calls: fake.calls,
      inferenceCalls,
      logs: capture.entries(),
    };
  } finally {
    await server.close();
  }
}

const nothingSaved = (calls: ReturnType<typeof fakePersistence>["calls"]) => {
  assert.equal(calls.routed.length, 0);
  assert.equal(calls.failed.length, 0);
};

describe("POST /api/v1/transactions: routed", () => {
  it("returns 201 with the §3.2 structure and saves the mapped columns", async () => {
    const { res, body, calls, inferenceCalls } = await post({ headers: { "X-Request-Id": "req-1" } });
    assert.equal(res.status, 201);
    assert.equal(res.headers.get("x-request-id"), "req-1");
    // §3.2: the same keys, in the same order, as GET /api/v1/transactions/:id.
    assert.deepEqual(Object.keys(body), ["id", "createdAt", "createdBy", "status", "transaction", "failure", "decision"]);
    assert.equal(body.failure, null);
    assert.equal(body.id, SAVED.id);
    assert.equal(body.createdAt, "2026-11-02T10:00:00.123Z");
    assert.equal(body.createdBy, "u-analyst-1");
    assert.equal(body.status, "routed");
    assert.deepEqual(body.transaction, {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000.0,
      corridor: "GBR->PHL",
      simulationDate: "2024-06-14",
      clientReference: null,
    });
    assert.equal(body.decision.decisionId, "sha256:9f2c");
    assert.equal(body.decision.provenance.stateMode, "historicalReplay");
    assert.equal(body.decision.allocations.length, 3);
    assert.equal(body.decision.transaction, undefined);

    assert.equal(inferenceCalls.length, 1);
    assert.equal(inferenceCalls[0]!.path, "/v1/route");
    assert.equal(inferenceCalls[0]!.requestId, "req-1");
    assert.deepEqual(inferenceCalls[0]!.body, {
      transaction: { sender_country: "GBR", receiver_country: "PHL", amount_usd: 300000.0 },
      state: { mode: "historical_replay", date: "2024-06-14" },
      policy: "waterfall",
    });

    assert.deepEqual(calls.userExists, ["u-analyst-1"]);
    assert.equal(calls.failed.length, 0);
    assert.equal(calls.routed.length, 1);
    const saved = calls.routed[0]!;
    assert.equal(saved.userId, "u-analyst-1");
    assert.equal(saved.requestId, "req-1");
    assert.equal(saved.corridor, "GBR->PHL");
    assert.deepEqual(saved.request.state, { mode: "historicalReplay", date: "2024-06-14" });
    assert.equal(saved.decision.policy, "waterfall");
    assert.equal(saved.decision.rewardAmountBased, -0.3078);
    assert.equal(saved.allocations.length, 3);
    // The inference body, unchanged.
    assert.deepEqual(saved.engineResponse, engineRouteResponse());
  });

  it("saves and returns a regulatory rejection like any 200", async () => {
    const { res, body, calls } = await post({ answer: { status: 200, body: engineRegulatoryRejection() } });
    assert.equal(res.status, 201);
    assert.equal(body.status, "routed");
    assert.equal(body.decision.feasibility.allowed, false);
    assert.deepEqual(body.decision.allocations, []);
    assert.equal(calls.routed.length, 1);
    assert.equal(calls.routed[0]!.decision.allowed, false);
    assert.deepEqual(calls.routed[0]!.allocations, []);
    assert.equal(calls.routed[0]!.decision.rewardEnv, 0);
    assert.equal(calls.routed[0]!.decision.feeCostUsd, 0);
    assert.deepEqual(calls.routed[0]!.engineResponse, engineRegulatoryRejection());
  });

  it("generates a request ID when none is sent and uses it throughout", async () => {
    const { res, calls, inferenceCalls } = await post();
    const id = res.headers.get("x-request-id");
    assert.ok(id);
    assert.equal(inferenceCalls[0]!.requestId, id);
    assert.equal(calls.routed[0]!.requestId, id);
  });

  it("lets a viewer route with a baseline policy", async () => {
    const { res, calls } = await post({
      token: viewerToken,
      body: requestBody({ policy: "cheapestFeasible" }),
      answer: { status: 200, body: engineRouteResponse({ policy: "cheapest_feasible", policyStatus: "baseline" }) },
    });
    assert.equal(res.status, 201);
    assert.equal(calls.routed[0]!.userId, "u-viewer-1");
    assert.equal(calls.routed[0]!.decision.policy, "cheapestFeasible");
  });

  for (const scenarioId of SCENARIO_IDS) {
    it(`passes scenario ${scenarioId} to inference and to stateSpec unchanged`, async () => {
      const state = { mode: "scenario", date: "2024-06-14", scenarioId };
      const { res, body, calls, inferenceCalls } = await post({
        body: requestBody({ state }),
        answer: { status: 200, body: engineRouteResponse({ stateMode: "scenario", scenarioId }) },
      });
      assert.equal(res.status, 201);
      assert.deepEqual((inferenceCalls[0]!.body as Record<string, unknown>).state, {
        mode: "scenario",
        date: "2024-06-14",
        scenario_id: scenarioId,
      });
      assert.deepEqual(calls.routed[0]!.request.state, state);
      assert.equal(body.decision.provenance.scenarioId, scenarioId);
    });
  }
});

describe("POST /api/v1/transactions: inference failures saved as failed", () => {
  const cases: Array<[string, Answer, number, string]> = [
    ["no mock answer (unavailable)", undefined, 503, "INFERENCE_UNAVAILABLE"],
    ["ENGINE_TIMEOUT", { status: 504, body: engineError("ENGINE_TIMEOUT"), retryAfter: "5" }, 504, "ENGINE_TIMEOUT"],
    ["INTERNAL_ERROR", { status: 500, body: engineError("INTERNAL_ERROR") }, 502, "INFERENCE_ERROR"],
    ["NOT_FOUND", { status: 404, body: engineError("NOT_FOUND") }, 502, "INFERENCE_ERROR"],
    ["a non-object 200 body", { status: 200, body: [] }, 502, "INFERENCE_ERROR"],
  ];
  for (const [name, answer, status, code] of cases) {
    it(`${name}: ${status} ${code} with details.transactionId`, async () => {
      // undefined means "no mock answer", so pass a function returning it.
      const { res, body, calls } = await post({ answer: answer ?? (() => undefined), headers: { "X-Request-Id": "req-f" } });
      assert.equal(res.status, status);
      assert.equal(res.headers.get("retry-after"), null);
      assert.deepEqual(body, {
        error: { code, message: body.error.message, details: { transactionId: SAVED.id }, requestId: "req-f" },
      });
      assert.doesNotMatch(JSON.stringify(body), /upstream message/);
      assert.equal(calls.routed.length, 0);
      assert.equal(calls.failed.length, 1);
      assert.equal(calls.failed[0]!.failureCode, code);
      assert.equal(calls.failed[0]!.userId, "u-analyst-1");
      assert.equal(calls.failed[0]!.requestId, "req-f");
      assert.deepEqual(calls.failed[0]!.request.state, { mode: "historicalReplay", date: "2024-06-14" });
    });
  }

  it("ENGINE_BUSY: 503 with Retry-After forwarded and details.transactionId (§3.2)", async () => {
    const { res, body, calls } = await post({
      answer: { status: 503, body: engineError("ENGINE_BUSY"), retryAfter: "5" },
      headers: { "X-Request-Id": "req-b" },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.deepEqual(body, {
      error: {
        code: "ENGINE_BUSY",
        message: "The routing engine is busy. Try again later.",
        details: { transactionId: SAVED.id },
        requestId: "req-b",
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /upstream message/);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0]!.failureCode, "ENGINE_BUSY");
    assert.equal(calls.routed.length, 0);
  });

  it("NOT_READY: 503 INFERENCE_UNAVAILABLE with cause, Retry-After and details.transactionId (§3.2)", async () => {
    const { res, body, calls } = await post({
      answer: { status: 503, body: engineError("NOT_READY"), retryAfter: "5" },
      headers: { "X-Request-Id": "req-n" },
    });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "5");
    assert.deepEqual(body, {
      error: {
        code: "INFERENCE_UNAVAILABLE",
        message: "The inference service is unavailable.",
        details: { transactionId: SAVED.id, cause: "NOT_READY" },
        requestId: "req-n",
      },
    });
    assert.doesNotMatch(JSON.stringify(body), /upstream message/);
    assert.equal(calls.failed.length, 1);
    // Stored as the code returned, not the inference code (§3.2).
    assert.equal(calls.failed[0]!.failureCode, "INFERENCE_UNAVAILABLE");
    assert.equal(calls.routed.length, 0);
  });

  for (const retryAfter of [undefined, "soon", "Wed, 21 Oct 2026 07:28:00 GMT"]) {
    it(`NOT_READY with Retry-After ${JSON.stringify(retryAfter)}: no header, mapping unchanged`, async () => {
      const { res, body, calls } = await post({ answer: { status: 503, body: engineError("NOT_READY"), retryAfter } });
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), null);
      assert.equal(body.error.code, "INFERENCE_UNAVAILABLE");
      assert.deepEqual(body.error.details, { transactionId: SAVED.id, cause: "NOT_READY" });
      assert.equal(calls.failed.length, 1);
    });
  }

  it("a plain INFERENCE_UNAVAILABLE (unreachable) has no cause", async () => {
    const { body } = await post({ answer: () => undefined });
    assert.equal(body.error.code, "INFERENCE_UNAVAILABLE");
    assert.deepEqual(body.error.details, { transactionId: SAVED.id });
  });

  it("saves a 200 body the 6E-2 mapper rejects as failed, logging field paths only", async () => {
    const bad = engineRouteResponse({ policy: "cheapest_feasible" });
    const { res, body, calls, logs } = await post({ answer: { status: 200, body: bad } });
    assert.equal(res.status, 502);
    assert.equal(body.error.code, "INFERENCE_ERROR");
    assert.deepEqual(body.error.details, { transactionId: SAVED.id });
    assert.equal(calls.routed.length, 0);
    assert.equal(calls.failed.length, 1);
    assert.equal(calls.failed[0]!.failureCode, "INFERENCE_ERROR");
    const entry = logs.find((line) => line.msg === "inference response rejected");
    assert.ok(entry, JSON.stringify(logs));
    assert.deepEqual(entry.problems, ["policy: differs from the requested policy"]);
  });

  for (const [label, metrics] of [
    ["missing", undefined],
    ["null", null],
    ["without fee_cost_usd", "drop-fee"],
  ] as const) {
    it(`saves a 200 with ${label} metrics as failed with INFERENCE_ERROR, never as routed (§2.8)`, async () => {
      const engine = engineRouteResponse();
      if (metrics === undefined) delete engine.metrics;
      else if (metrics === null) engine.metrics = null;
      else delete (engine.metrics as Record<string, unknown>).fee_cost_usd;
      const { res, body, calls } = await post({ answer: { status: 200, body: engine } });
      assert.equal(res.status, 502);
      assert.deepEqual(body.error, {
        code: "INFERENCE_ERROR",
        message: "The inference service returned an invalid response.",
        details: { transactionId: SAVED.id },
        requestId: body.error.requestId,
      });
      assert.equal(calls.routed.length, 0);
      assert.equal(calls.failed.length, 1);
      assert.equal(calls.failed[0]!.failureCode, "INFERENCE_ERROR");
    });
  }

  for (const status of ["calibrated", "Placeholder", null, undefined]) {
    it(`saves a 200 with reward_weights.status ${JSON.stringify(status) ?? "missing"} as failed with INFERENCE_ERROR`, async () => {
      const engine = engineRouteResponse();
      const weights = (engine.metrics as { reward_weights: Record<string, unknown> }).reward_weights;
      if (status === undefined) delete weights.status;
      else weights.status = status;
      const { res, body, calls, logs } = await post({ answer: { status: 200, body: engine } });
      assert.equal(res.status, 502);
      assert.equal(body.error.code, "INFERENCE_ERROR");
      assert.deepEqual(body.error.details, { transactionId: SAVED.id });
      assert.equal(calls.routed.length, 0);
      assert.equal(calls.failed.length, 1);
      assert.equal(calls.failed[0]!.failureCode, "INFERENCE_ERROR");
      const entry = logs.find((line) => line.msg === "inference response rejected");
      assert.deepEqual(entry?.problems, ['metrics.reward_weights.status: must be "placeholder"']);
      // Field paths only: the received value is never logged.
      if (typeof status === "string") assert.doesNotMatch(JSON.stringify(logs), new RegExp(`"${status}"`));
    });
  }

  it("saves a regulatory rejection without metrics as failed, not routed", async () => {
    const engine = { ...engineRegulatoryRejection(), metrics: null };
    const { res, calls } = await post({ answer: { status: 200, body: engine } });
    assert.equal(res.status, 502);
    assert.equal(calls.routed.length, 0);
    assert.equal(calls.failed[0]!.failureCode, "INFERENCE_ERROR");
  });

  it("returns 503 and saves the failed row when the app has no inference client", async () => {
    const fake = fakePersistence();
    const server = await startServer(createApp({ logger: silentLogger, users, transactionPersistence: fake.persistence }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${analystToken}` },
        body: JSON.stringify(requestBody()),
      });
      assert.equal(res.status, 503);
      assert.deepEqual(((await res.json()) as Record<string, any>).error.details, { transactionId: SAVED.id });
      assert.equal(fake.calls.failed.length, 1);
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/v1/transactions: passed through, nothing saved", () => {
  // engineError() sends empty details: a domain 422 then has none, and a
  // VALIDATION_ERROR gets one form-level item (§4: errors is never empty).
  for (const code of ["UNSUPPORTED_CORRIDOR", "DATE_IN_GAP_BUFFER", "UNKNOWN_SCENARIO", "VALIDATION_ERROR"]) {
    it(`engine 422 ${code}`, async () => {
      const { res, body, calls } = await post({ answer: { status: 422, body: engineError(code) } });
      assert.equal(res.status, 422);
      assert.equal(body.error.code, code);
      assert.deepEqual(
        body.error.details,
        code === "VALIDATION_ERROR" ? { errors: [{ message: "Rejected by the routing engine." }] } : {},
      );
      nothingSaved(calls);
    });
  }

  it("engine 422 DATE_IN_GAP_BUFFER matches the passthrough fixture, mapped field and all", async () => {
    const { res, body, calls } = await post({
      body: requestBody({ state: { mode: "historicalReplay", date: "2022-01-10" } }),
      answer: {
        status: 422,
        body: {
          error: {
            code: "DATE_IN_GAP_BUFFER",
            message: "simulation_date 2022-01-10 falls within the 30-day gap buffer of a split boundary.",
            details: { field: "state.date" },
            request_id: "fixture-422_date_in_gap_buffer",
          },
        },
      },
      headers: { "X-Request-Id": "fixture-422_date_in_gap_buffer_passthrough" },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(body, {
      error: {
        code: "DATE_IN_GAP_BUFFER",
        message: "The date falls within a gap buffer.",
        details: { field: "state.date" },
        requestId: "fixture-422_date_in_gap_buffer_passthrough",
      },
    });
    nothingSaved(calls);
  });

  it("engine 422 VALIDATION_ERROR with 75 items: all 75 reach the client over HTTP, nothing saved", async () => {
    const errors = Array.from({ length: 75 }, (_, i) =>
      i < 60 ? { field: `state.venues[0].history.congestion[${i % 30}]`, message: "m" } : { field: "transaction", message: "m" },
    );
    const { res, body, calls } = await post({
      answer: { status: 422, body: { error: { code: "VALIDATION_ERROR", message: "m", details: { errors }, request_id: "x" } } },
    });
    assert.equal(res.status, 422);
    const forwarded = body.error.details.errors as Array<{ field?: string; message: string }>;
    assert.equal(forwarded.length, 75);
    assert.deepEqual(forwarded[59], { field: "state.venues[0].history.congestion[29]", message: "Rejected by the routing engine." });
    assert.deepEqual(forwarded[60], { message: "Rejected by the routing engine." });
    assert.deepEqual(forwarded[74], { message: "Rejected by the routing engine." });
    nothingSaved(calls);
  });

  it("engine 422 VALIDATION_ERROR: mapped app paths, fixed item messages, nothing saved", async () => {
    const { res, body, calls } = await post({
      answer: {
        status: 422,
        body: {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request failed validation.",
            details: {
              errors: [
                { field: "state.venues[0].history.liquidity_usd", message: "Must have exactly 30 items." },
                { field: "transaction.sender_country", message: "upstream message" },
              ],
            },
            request_id: "x",
          },
        },
      },
    });
    assert.equal(res.status, 422);
    assert.equal(body.error.message, "Request failed validation.");
    assert.deepEqual(body.error.details, {
      errors: [
        { field: "state.venues[0].history.liquidityUsd", message: "Rejected by the routing engine." },
        { field: "senderCountry", message: "Rejected by the routing engine." },
      ],
    });
    assert.doesNotMatch(JSON.stringify(body), /upstream message|30 items|liquidity_usd/);
    nothingSaved(calls);
  });

  it("409 POLICY_DISABLED", async () => {
    const { res, body, calls } = await post({
      body: requestBody({ policy: "ppoProjected" }),
      answer: { status: 409, body: engineError("POLICY_DISABLED") },
    });
    assert.equal(res.status, 409);
    assert.equal(body.error.code, "POLICY_DISABLED");
    assert.deepEqual(body.error.details, {});
    nothingSaved(calls);
  });
});

describe("POST /api/v1/transactions: refused before inference", () => {
  it("401 without a token", async () => {
    const { res, calls, inferenceCalls } = await post({ token: "" });
    assert.equal(res.status, 401);
    assert.equal(inferenceCalls.length, 0);
    assert.equal(calls.userExists.length, 0);
  });

  it("403 FORBIDDEN_POLICY for a viewer asking for ppoProjected, even with other invalid fields", async () => {
    const { res, body, calls, inferenceCalls } = await post({
      token: viewerToken,
      body: requestBody({ policy: "ppoProjected", amountUsd: "x" }),
    });
    assert.equal(res.status, 403);
    assert.equal(body.error.code, "FORBIDDEN_POLICY");
    assert.equal(inferenceCalls.length, 0);
    assert.equal(calls.userExists.length, 0);
    nothingSaved(calls);
  });

  it("400 MALFORMED_REQUEST for invalid JSON", async () => {
    const { res, body, inferenceCalls } = await post({ rawBody: "{" });
    assert.equal(res.status, 400);
    assert.equal(body.error.code, "MALFORMED_REQUEST");
    assert.equal(inferenceCalls.length, 0);
  });

  it("422 VALIDATION_ERROR with every problem", async () => {
    const { res, body, calls, inferenceCalls } = await post({ body: { senderCountry: "", polcy: "waterfall" } });
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(
      (body.error.details.errors as Array<{ field: string }>).map((e) => e.field).sort(),
      ["amountUsd", "polcy", "receiverCountry", "senderCountry", "state"],
    );
    assert.equal(inferenceCalls.length, 0);
    assert.equal(calls.userExists.length, 0);
  });

  it("422 VALIDATION_ERROR for a lower-case country code, with the fixed message", async () => {
    const { res, body, calls, inferenceCalls } = await post({ body: requestBody({ senderCountry: "gbr" }) });
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(body.error.details.errors, [
      { field: "senderCountry", message: "Must be three upper-case letters." },
    ]);
    assert.equal(inferenceCalls.length, 0);
    assert.equal(calls.userExists.length, 0);
    nothingSaved(calls);
  });

  it("422 VALIDATION_ERROR for policy: null, which never defaults", async () => {
    const { res, body, calls, inferenceCalls } = await post({ body: requestBody({ policy: null }) });
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(
      (body.error.details.errors as Array<{ field: string }>).map((e) => e.field),
      ["policy"],
    );
    assert.equal(inferenceCalls.length, 0);
    nothingSaved(calls);
  });

  it("422 VALIDATION_ERROR for a clientReference over 200 code points", async () => {
    const { res, body, inferenceCalls } = await post({ body: requestBody({ clientReference: "r".repeat(201) }) });
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(
      (body.error.details.errors as Array<{ field: string }>).map((e) => e.field),
      ["clientReference"],
    );
    assert.equal(inferenceCalls.length, 0);
  });

  for (const amountUsd of [0, -5]) {
    it(`422 INVALID_AMOUNT with details.field for amountUsd ${amountUsd}, before inference`, async () => {
      const { res, body, calls, inferenceCalls } = await post({ body: requestBody({ amountUsd }) });
      assert.equal(res.status, 422);
      assert.equal(body.error.code, "INVALID_AMOUNT");
      assert.equal(body.error.message, "The amount must be greater than 0 and finite.");
      assert.deepEqual(body.error.details, { field: "amountUsd" });
      assert.equal(inferenceCalls.length, 0);
      assert.equal(calls.userExists.length, 0);
      nothingSaved(calls);
    });
  }

  it("matches the 422_validation_error fixture exactly: envelope message and Unknown field.", async () => {
    const { res, body, calls, inferenceCalls } = await post({
      body: {
        senderCountry: "GBR",
        receiverCountry: "PHL",
        amountUsd: 300000.0,
        state: {
          mode: "explicit",
          referenceDate: "2024-06-14",
          venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 210000.0, congestion: 0.35, risk: 0.2 }],
        },
      },
      headers: { "X-Request-Id": "fixture-422_validation_error" },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(body, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: { errors: [{ field: "state.venues[0].risk", message: "Unknown field." }] },
        requestId: "fixture-422_validation_error",
      },
    });
    assert.equal(inferenceCalls.length, 0);
    nothingSaved(calls);
  });

  it("matches the 422_validation_error_precedence fixture exactly", async () => {
    const { res, body } = await post({
      body: { senderCountry: "gbr", receiverCountry: "PHL", amountUsd: 0.0, state: { mode: "historicalReplay", date: "2024-06-14" } },
      headers: { "X-Request-Id": "fixture-422_validation_error_precedence" },
    });
    assert.equal(res.status, 422);
    assert.deepEqual(body, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Request failed validation.",
        details: { errors: [{ field: "senderCountry", message: "Must be three upper-case letters." }] },
        requestId: "fixture-422_validation_error_precedence",
      },
    });
  });

  it("omits field for a form-level error: a body that is a JSON array (§4)", async () => {
    const { res, body } = await post({ body: [] });
    assert.equal(res.status, 422);
    assert.deepEqual(body.error.details, { errors: [{ message: "Must be a JSON object." }] });
    assert.equal("field" in body.error.details.errors[0], false);
  });

  it("prefers VALIDATION_ERROR over INVALID_AMOUNT (§3.2 precedence)", async () => {
    const { res, body, inferenceCalls } = await post({ body: requestBody({ senderCountry: "gbr", amountUsd: 0 }) });
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(body.error.details.errors, [
      { field: "senderCountry", message: "Must be three upper-case letters." },
    ]);
    assert.equal(inferenceCalls.length, 0);
  });

  it("500 INTERNAL_ERROR without a User row, before inference, saving nothing", async () => {
    const { res, body, calls, inferenceCalls, logs } = await post({ userExists: false });
    assert.equal(res.status, 500);
    assert.deepEqual(body.error, {
      code: "INTERNAL_ERROR",
      message: "An unexpected error occurred.",
      details: {},
      requestId: body.error.requestId,
    });
    assert.equal(inferenceCalls.length, 0);
    nothingSaved(calls);
    assert.ok(logs.some((line) => line.msg === "unhandled error"));
  });

  it("500 INTERNAL_ERROR without persistence (no DATABASE_URL), before inference", async () => {
    const { res, body, inferenceCalls } = await post({ persistence: false });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.equal(inferenceCalls.length, 0);
  });

  it("405 METHOD_NOT_ALLOWED with Allow for other methods (§4)", async () => {
    const server = await startServer(createApp({ logger: silentLogger, users }));
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${analystToken}` },
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD, POST");
    } finally {
      await server.close();
    }
  });
});

describe("POST /api/v1/transactions: database errors", () => {
  it("returns a generic 500 when saving a routed transaction fails", async () => {
    const { res, body, calls } = await post({ saveError: new Error("db down") });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.deepEqual(body.error.details, {});
    assert.doesNotMatch(JSON.stringify(body), /db down/);
    assert.equal(calls.routed.length, 1);
  });

  it("returns a generic 500 without a transactionId when saving a failed transaction fails", async () => {
    const { res, body } = await post({ answer: () => undefined, saveError: new Error("db down") });
    assert.equal(res.status, 500);
    assert.equal(body.error.code, "INTERNAL_ERROR");
    assert.deepEqual(body.error.details, {});
  });
});
