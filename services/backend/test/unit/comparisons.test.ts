import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Prisma } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import type { ComparisonRow, ComparisonStore, NewComparison } from "../../src/db/comparisons.js";
import { createInferenceClient, type InferenceRequest, type MockResponse } from "../../src/inferenceClient/client.js";
import { mapRouteResponse } from "../../src/mappers/routeResponse.js";
import { resolveComparisonPolicies } from "../../src/routes/comparisons.js";
import {
  canonicalComparisonPolicy,
  COMPARISON_POLICY_ALIASES,
  DEFAULT_COMPARISON_POLICIES,
  POLICIES_MESSAGES,
  validateComparisonRequest,
} from "../../src/validation/comparisonRequest.js";
import { validateTransactionRequest } from "../../src/validation/transactionRequest.js";
import {
  COMPARE_NOTE,
  comparisonBody,
  ENGINE_SKIP_MESSAGE,
  engineCompareResponse,
  engineResult,
  engineSkipped,
  type EnginePolicy,
} from "../helpers/comparisons.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";
import { engineError, requestBody } from "../helpers/transactions.js";

// POST /api/v1/comparisons and GET /api/v1/comparisons/:id (API contract §3.6,
// owner decisions Q18) with a fake store and the mock inference client: no
// database and no network. The Prisma store is tested in
// comparisonStore.test.ts and against PostgreSQL in the integration suite.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];

const CHECKPOINT = "a".repeat(64);
const UNKNOWN_ID = "00000000-0000-4000-8000-00000000ffff";
const CREATED_AT = new Date("2026-11-16T09:00:00.000Z");
const savedId = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

/** An in-memory store. Every save is a new record, as in the database. */
function fakeStore(options: { saveError?: Error; userExists?: boolean; rows?: ComparisonRow[] } = {}) {
  const saves: NewComparison[] = [];
  const lookups: string[] = [];
  const rows = new Map<string, ComparisonRow>((options.rows ?? []).map((row) => [row.id, row]));
  const store: ComparisonStore = {
    async userExists() {
      return options.userExists ?? true;
    },
    async save(input) {
      saves.push(structuredClone(input));
      if (options.saveError) throw options.saveError;
      const id = savedId(saves.length);
      const state = input.request.state;
      rows.set(id, {
        id,
        createdAt: CREATED_AT,
        createdById: input.userId,
        senderCountry: input.request.senderCountry,
        receiverCountry: input.request.receiverCountry,
        corridor: input.corridor,
        amountUsd: input.request.amountUsd,
        simulationDate: new Date(`${state.mode === "explicit" ? state.referenceDate : state.date}T00:00:00.000Z`),
        clientReference: input.request.clientReference,
        stateMode: state.mode,
        stateSpec: structuredClone(state) as unknown as Prisma.JsonValue,
        policies: [...input.request.policies],
        engineResponse: structuredClone(input.engineResponse) as Prisma.JsonValue,
      });
      return { id, createdAt: CREATED_AT };
    },
    async findById(id) {
      lookups.push(id);
      return rows.get(id.toLowerCase()) ?? null;
    },
  };
  return { store, saves, lookups, rows };
}

type Answer = MockResponse | undefined | ((request: Readonly<InferenceRequest>) => MockResponse | undefined);
type Answers = Partial<Record<string, Answer>>;

const clientReferenceOf = (request: Readonly<InferenceRequest>) =>
  ((request.body!.transaction as Record<string, unknown>).client_reference as string | undefined) ?? null;

/** /v1/compare answering every requested policy with a result, in the order sent; PPO from an approved checkpoint. */
const allResults: Answer = (request) => ({
  status: 200,
  body: engineCompareResponse(
    (request.body!.policies as EnginePolicy[]).map((policy) =>
      engineResult(policy, {
        checkpointSha256: policy === "ppo_projected" ? CHECKPOINT : null,
        clientReference: clientReferenceOf(request),
      }),
    ),
  ),
});
/** ppo_projected disabled in the engine: skipped, the others answered. */
const ppoSkipped: Answer = (request) => {
  const policies = request.body!.policies as EnginePolicy[];
  return {
    status: 200,
    body: engineCompareResponse(
      policies.filter((p) => p !== "ppo_projected").map((p) => engineResult(p, { clientReference: clientReferenceOf(request) })),
      policies.filter((p) => p === "ppo_projected").map((p) => engineSkipped(p)),
    ),
  };
};
const ENABLED: Answers = { "/v1/compare": allResults };
const DISABLED: Answers = { "/v1/compare": ppoSkipped };

interface CallOptions {
  store?: ComparisonStore;
  answers?: Answers;
  token?: string | null;
  body?: unknown;
  rawBody?: string;
  method?: string;
  logger?: typeof silentLogger;
  noClient?: boolean;
}

async function call(path: string, options: CallOptions = {}) {
  const { answers = ENABLED, token = analystToken, method = "GET", logger = silentLogger } = options;
  const calls: InferenceRequest[] = [];
  const client = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        calls.push(request as InferenceRequest);
        const answer = answers[request.path];
        return typeof answer === "function" ? answer(request) : answer;
      },
    },
  );
  const app = createApp({
    logger,
    users,
    ...(!options.noClient && { inferenceClient: client }),
    ...(options.store && { comparisons: options.store }),
  });
  const server = await startServer(app);
  try {
    const payload = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
    const res = await fetch(`${server.baseUrl}${path}`, {
      method,
      headers: {
        "X-Request-Id": "req-compare",
        ...(payload !== undefined && { "Content-Type": "application/json" }),
        ...(token !== null && { Authorization: `Bearer ${token}` }),
      },
      body: payload,
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      body: text ? (JSON.parse(text) as Record<string, any>) : undefined,
      calls,
      compareCalls: calls.filter((c) => c.path === "/v1/compare"),
    };
  } finally {
    await server.close();
  }
}

const post = (body: unknown, options: CallOptions = {}) =>
  call("/api/v1/comparisons", { method: "POST", body, ...options });

function assertError(res: { status: number; body?: Record<string, any> }, status: number, code: string) {
  assert.equal(res.status, status, JSON.stringify(res.body));
  assert.deepEqual(Object.keys(res.body!), ["error"]);
  assert.deepEqual(Object.keys(res.body!.error), ["code", "message", "details", "requestId"]);
  assert.equal(res.body!.error.code, code);
  assert.equal(res.body!.error.requestId, "req-compare");
  assert.ok(!("transactionId" in res.body!.error.details));
}

const policiesOf = (res: { body?: Record<string, any> }) => res.body!.results.map((r: { policy: string }) => r.policy);
/** The §3.2 decision the transaction endpoint would return for one engine result. */
function decisionFor(policy: EnginePolicy, appPolicy: string, checkpointSha256: string | null = null) {
  const request = validateTransactionRequest(requestBody({ policy: appPolicy }));
  assert.ok(request.ok);
  return mapRouteResponse(engineResult(policy, { checkpointSha256 }), request.value).decision;
}

describe("comparison policy names (Q18)", () => {
  it("maps the aliases to canonical names: baseline -> waterfall, ruleBased -> cheapestFeasible", () => {
    assert.deepEqual(COMPARISON_POLICY_ALIASES, { baseline: "waterfall", ruleBased: "cheapestFeasible" });
    assert.equal(canonicalComparisonPolicy("baseline"), "waterfall");
    assert.equal(canonicalComparisonPolicy("ruleBased"), "cheapestFeasible");
    for (const name of ["waterfall", "cheapestFeasible", "ppoProjected"]) assert.equal(canonicalComparisonPolicy(name), name);
    for (const name of ["Baseline", "rule_based", "ppo_projected", "ppo", "toString", "__proto__", 1, null]) {
      assert.equal(canonicalComparisonPolicy(name), undefined, String(name));
    }
  });

  it("has the approved default order, without ppoProjected for a viewer", () => {
    assert.deepEqual(DEFAULT_COMPARISON_POLICIES, ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(resolveComparisonPolicies(undefined, "analyst"), ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(resolveComparisonPolicies(undefined, "viewer"), ["waterfall", "cheapestFeasible"]);
    assert.deepEqual(resolveComparisonPolicies(["cheapestFeasible"], "viewer"), ["cheapestFeasible"]);
  });
});

describe("POST /api/v1/comparisons: default policy list (Q18)", () => {
  it("compares waterfall, cheapestFeasible, ppoProjected, in that order, when an analyst omits policies", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody(), { store });
    assert.equal(res.status, 201);
    assert.deepEqual(res.compareCalls[0]!.body!.policies, ["waterfall", "cheapest_feasible", "ppo_projected"]);
    assert.deepEqual(res.body!.policies, ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(policiesOf(res), ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(saves[0]!.request.policies, ["waterfall", "cheapestFeasible", "ppoProjected"]);
  });

  it("keeps the default order whatever order the engine answers in", async () => {
    const { store } = fakeStore();
    const res = await post(comparisonBody(), {
      store,
      answers: {
        "/v1/compare": {
          status: 200,
          body: engineCompareResponse([
            engineResult("ppo_projected", { checkpointSha256: CHECKPOINT }),
            engineResult("cheapest_feasible"),
            engineResult("waterfall"),
          ]),
        },
      },
    });
    assert.equal(res.status, 201);
    assert.deepEqual(policiesOf(res), ["waterfall", "cheapestFeasible", "ppoProjected"]);
  });

  it("sends a viewer who omits policies waterfall and cheapestFeasible only", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody(), { store, token: viewerToken });
    assert.equal(res.status, 201);
    assert.deepEqual(res.compareCalls[0]!.body!.policies, ["waterfall", "cheapest_feasible"]);
    assert.deepEqual(res.body!.policies, ["waterfall", "cheapestFeasible"]);
    assert.deepEqual(policiesOf(res), ["waterfall", "cheapestFeasible"]);
    assert.equal(res.body!.createdBy, "u-viewer-1");
    assert.equal(saves[0]!.userId, "u-viewer-1");
    assert.deepEqual(saves[0]!.request.policies, ["waterfall", "cheapestFeasible"]);
  });
});

describe("POST /api/v1/comparisons: explicit policies", () => {
  const cases: Array<[string[], string[]]> = [
    [["ppoProjected", "waterfall", "cheapestFeasible"], ["ppoProjected", "waterfall", "cheapestFeasible"]],
    [["cheapestFeasible", "waterfall"], ["cheapestFeasible", "waterfall"]],
    [["cheapestFeasible"], ["cheapestFeasible"]],
    // Aliases are mapped in place, so the caller's order is kept.
    [["baseline", "ruleBased", "ppoProjected"], ["waterfall", "cheapestFeasible", "ppoProjected"]],
    [["ruleBased", "baseline"], ["cheapestFeasible", "waterfall"]],
    [["ppoProjected", "ruleBased"], ["ppoProjected", "cheapestFeasible"]],
    [["baseline", "cheapestFeasible"], ["waterfall", "cheapestFeasible"]],
  ];
  for (const [sent, canonical] of cases) {
    it(`[${sent.join(", ")}] -> [${canonical.join(", ")}], in that order`, async () => {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: sent }), {
        store,
        answers: {
          // The engine answers in reverse order.
          "/v1/compare": (request) => {
            const answer = (allResults as (r: Readonly<InferenceRequest>) => MockResponse)(request);
            (answer.body as { results: unknown[] }).results.reverse();
            return answer;
          },
        },
      });
      assert.equal(res.status, 201);
      const engineNames = { waterfall: "waterfall", cheapestFeasible: "cheapest_feasible", ppoProjected: "ppo_projected" };
      assert.deepEqual(res.compareCalls[0]!.body!.policies, canonical.map((p) => engineNames[p as keyof typeof engineNames]));
      assert.deepEqual(res.body!.policies, canonical);
      assert.deepEqual(policiesOf(res), canonical);
      assert.deepEqual(saves[0]!.request.policies, canonical);
      // No alias is ever stored or returned.
      assert.ok(!/"(baseline|ruleBased)"/.test(JSON.stringify(res.body!.policies)));
      assert.ok(!res.text.includes("ruleBased"));
    });
  }

  it("returns the record: id, createdAt, createdBy, transaction, state, policies, results, skipped, sameState, note", async () => {
    const { store, saves } = fakeStore();
    const state = { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" };
    const engine = engineCompareResponse([
      engineResult("waterfall", { clientReference: "demo-001", stateMode: "scenario", scenarioId: "cheapest_venue_outage" }),
    ]);
    const res = await post(comparisonBody({ policies: ["baseline"], state, clientReference: "demo-001" }), {
      store,
      answers: { "/v1/compare": { status: 200, body: engine } },
    });
    assert.equal(res.status, 201, res.text);
    assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(res.headers.get("x-request-id"), "req-compare");
    assert.deepEqual(Object.keys(res.body!), [
      "id", "createdAt", "createdBy", "transaction", "state", "policies", "results", "skipped", "sameState", "note",
    ]);
    assert.equal(res.body!.id, savedId(1));
    assert.equal(res.body!.createdAt, "2026-11-16T09:00:00.000Z");
    assert.equal(res.body!.createdBy, "u-analyst-1");
    assert.deepEqual(res.body!.transaction, {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000.0,
      corridor: "GBR->PHL",
      simulationDate: "2024-06-14",
      clientReference: "demo-001",
    });
    assert.deepEqual(res.body!.state, state);
    assert.deepEqual(res.body!.policies, ["waterfall"]);
    assert.deepEqual(res.body!.skipped, []);
    assert.equal(res.body!.sameState, true);
    assert.equal(res.body!.note, COMPARE_NOTE);
    assert.ok(!("transactionId" in res.body!));
    // Each result is a §3.2 decision: no transaction, camelCase, enums mapped.
    assert.equal(res.body!.results.length, 1);
    assert.equal(res.body!.results[0].decisionId, "sha256:waterfall");
    assert.equal(res.body!.results[0].provenance.stateMode, "scenario");
    assert.ok(!("transaction" in res.body!.results[0]));

    assert.deepEqual(res.compareCalls[0]!.body, {
      transaction: { sender_country: "GBR", receiver_country: "PHL", amount_usd: 300000.0, client_reference: "demo-001" },
      state: { mode: "scenario", date: "2024-06-14", scenario_id: "cheapest_venue_outage" },
      policies: ["waterfall"],
    });
    assert.equal(res.compareCalls[0]!.requestId, "req-compare");
    assert.deepEqual(saves, [
      {
        userId: "u-analyst-1",
        requestId: "req-compare",
        request: { senderCountry: "GBR", receiverCountry: "PHL", amountUsd: 300000.0, state, policies: ["waterfall"], clientReference: "demo-001" },
        corridor: "GBR->PHL",
        engineResponse: engine,
      },
    ]);
  });

  it("returns each result exactly as the transaction endpoint maps that policy's decision", async () => {
    const { store } = fakeStore();
    const res = await post(comparisonBody({ policies: ["waterfall", "ppoProjected"] }), { store });
    assert.deepEqual(res.body!.results, [
      decisionFor("waterfall", "waterfall"),
      decisionFor("ppo_projected", "ppoProjected", CHECKPOINT),
    ]);
  });
});

describe("POST /api/v1/comparisons: effective state", () => {
  it("returns and saves an explicit state as validated, with history null when omitted", async () => {
    const { store, saves } = fakeStore();
    const state = {
      mode: "explicit",
      referenceDate: "2024-06-14",
      venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1000, congestion: 0.1 }],
    };
    const effective = { ...state, venues: [{ ...state.venues[0], history: null }] };
    const engine = engineCompareResponse([engineResult("waterfall", { stateMode: "explicit" })]);
    const res = await post(comparisonBody({ policies: ["waterfall"], state }), {
      store,
      answers: { "/v1/compare": { status: 200, body: engine } },
    });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body!.state, effective);
    assert.deepEqual(saves[0]!.request.state, effective);
    assert.equal(res.body!.transaction.simulationDate, "2024-06-14");
  });

  const mismatches: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["a different state_date", { state: { mode: "historicalReplay", date: "2024-06-14" } }, { state_date: "2024-06-13" }],
    [
      "a different scenario_id",
      { state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" } },
      { state_mode: "scenario", values_provenance: "synthetic_scenario", scenario_id: "liquidity_minus50" },
    ],
    ["a scenario_id in replay mode", { state: { mode: "historicalReplay", date: "2024-06-14" } }, { scenario_id: "baseline" }],
    ["another state_mode", { state: { mode: "historicalReplay", date: "2024-06-14" } }, { state_mode: "scenario" }],
  ];
  for (const [name, overrides, provenance] of mismatches) {
    it(`refuses a result whose provenance reports ${name}: 502, nothing saved`, async () => {
      const { store, saves } = fakeStore();
      const result = engineResult("waterfall");
      const body = engineCompareResponse([{ ...result, provenance: { ...(result.provenance as object), ...provenance } }]);
      const res = await post(comparisonBody({ policies: ["waterfall"], ...overrides }), {
        store,
        answers: { "/v1/compare": { status: 200, body } },
      });
      assertError(res, 502, "INFERENCE_ERROR");
      assert.equal(saves.length, 0);
    });
  }

  it("returns the validated state when every policy was skipped, as no result can confirm it", async () => {
    const { store, saves } = fakeStore();
    const state = { mode: "scenario", date: "2024-06-14", scenarioId: "liquidity_minus30" };
    const res = await post(comparisonBody({ policies: ["ppoProjected"], state }), { store, answers: DISABLED });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body!.state, state);
    assert.deepEqual(saves[0]!.request.state, state);
  });
});

describe("POST /api/v1/comparisons: request validation", () => {
  const nameMessage = POLICIES_MESSAGES.name;
  const cases: Array<[string, Record<string, unknown>, Array<{ field?: string; message: string }>]> = [
    ["policies: null", { policies: null }, [{ field: "policies", message: "Must be an array." }]],
    ["policies not an array", { policies: "waterfall" }, [{ field: "policies", message: "Must be an array." }]],
    ["an empty policies list", { policies: [] }, [{ field: "policies", message: "Must list at least one policy." }]],
    [
      "a duplicate policy",
      { policies: ["waterfall", "cheapestFeasible", "waterfall"] },
      [{ field: "policies[2]", message: POLICIES_MESSAGES.duplicate }],
    ],
    ["an alias and its canonical name", { policies: ["baseline", "waterfall"] }, [{ field: "policies[1]", message: POLICIES_MESSAGES.duplicate }]],
    ["a canonical name and its alias", { policies: ["cheapestFeasible", "ruleBased"] }, [{ field: "policies[1]", message: POLICIES_MESSAGES.duplicate }]],
    ["an alias twice", { policies: ["ruleBased", "ruleBased"] }, [{ field: "policies[1]", message: POLICIES_MESSAGES.duplicate }]],
    [
      "unknown policy names, each listed",
      { policies: ["waterfall", "ppo", 7, "ppo_projected", null, "Baseline", "cheapest_feasible"] },
      [1, 2, 3, 4, 5, 6].map((i) => ({ field: `policies[${i}]`, message: nameMessage })),
    ],
    ["the transaction field `policy`", { policy: "waterfall" }, [{ field: "policy", message: "Unknown field." }]],
    ["an unknown top-level field", { polices: ["waterfall"] }, [{ field: "polices", message: "Unknown field." }]],
    [
      "transaction problems and policies problems together",
      { senderCountry: "gb", policies: [] },
      [
        { field: "senderCountry", message: "Must be three upper-case letters." },
        { field: "policies", message: "Must list at least one policy." },
      ],
    ],
    [
      "a schema problem before INVALID_AMOUNT (§3.2 precedence)",
      { amountUsd: 0, policies: ["waterfall", "baseline"] },
      [{ field: "policies[1]", message: POLICIES_MESSAGES.duplicate }],
    ],
    ["a missing state", { state: undefined }, [{ field: "state", message: "Required." }]],
    [
      "a client reference over 200 code points",
      { clientReference: "x".repeat(201) },
      [{ field: "clientReference", message: "Must be at most 200 characters (Unicode code points)." }],
    ],
  ];
  for (const [name, overrides, errors] of cases) {
    it(`rejects ${name} with 422 VALIDATION_ERROR, calling and saving nothing`, async () => {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody(overrides), { store });
      assertError(res, 422, "VALIDATION_ERROR");
      assert.equal(res.body!.error.message, "Request failed validation.");
      assert.deepEqual(res.body!.error.details, { errors });
      assert.equal(res.calls.length, 0);
      assert.equal(saves.length, 0);
    });
  }

  it("lists every accepted name, canonical then alias, in the unknown-name message", () => {
    assert.equal(nameMessage, "Must be one of: waterfall, cheapestFeasible, ppoProjected, baseline, ruleBased.");
  });

  it("rejects a body that isn't an object with a form-level error", async () => {
    const res = await post([comparisonBody()], { store: fakeStore().store });
    assertError(res, 422, "VALIDATION_ERROR");
    assert.deepEqual(res.body!.error.details, { errors: [{ message: "Must be a JSON object." }] });
  });

  it("returns 422 INVALID_AMOUNT for a non-positive amount in an otherwise valid body", async () => {
    for (const amountUsd of [0, -5]) {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ amountUsd, policies: ["waterfall"] }), { store });
      assertError(res, 422, "INVALID_AMOUNT");
      assert.deepEqual(res.body!.error.details, { field: "amountUsd" });
      assert.equal(res.calls.length, 0);
      assert.equal(saves.length, 0);
    }
  });

  it("returns 400 MALFORMED_REQUEST for invalid JSON", async () => {
    const res = await post(undefined, { store: fakeStore().store, rawBody: "{not json" });
    assertError(res, 400, "MALFORMED_REQUEST");
  });

  it("never echoes a caller-supplied value", async () => {
    const res = await post(comparisonBody({ policies: ["SECRET-POLICY"], senderCountry: "SECRET-COUNTRY" }), { store: fakeStore().store });
    assertError(res, 422, "VALIDATION_ERROR");
    assert.ok(!res.text.includes("SECRET"));
  });

  it("validateComparisonRequest returns canonical names in the caller's order, or undefined when omitted", () => {
    const given = validateComparisonRequest(comparisonBody({ policies: ["ppoProjected", "ruleBased", "baseline"] }));
    assert.ok(given.ok);
    assert.deepEqual(given.value.policies, ["ppoProjected", "cheapestFeasible", "waterfall"]);
    const omitted = validateComparisonRequest(comparisonBody());
    assert.ok(omitted.ok);
    assert.equal(omitted.value.policies, undefined);
    assert.ok(!("policy" in omitted.value));
  });
});

describe("POST /api/v1/comparisons: authentication and roles", () => {
  it("returns 401 UNAUTHENTICATED without a token or with an unknown one", async () => {
    for (const token of [null, newToken()]) {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody(), { store, token });
      assertError(res, 401, "UNAUTHENTICATED");
      assert.equal(res.calls.length, 0);
      assert.equal(saves.length, 0);
    }
  });

  it("returns 403 FORBIDDEN_POLICY to a viewer who lists ppoProjected, before validation, inference and persistence", async () => {
    for (const body of [
      comparisonBody({ policies: ["waterfall", "ppoProjected"] }),
      comparisonBody({ policies: ["baseline", "ruleBased", "ppoProjected"] }),
      // Also invalid: the role check still comes first.
      comparisonBody({ policies: ["ppoProjected", "ppoProjected"], amountUsd: "x" }),
    ]) {
      const { store, saves, lookups } = fakeStore();
      const res = await post(body, { store, token: viewerToken });
      assertError(res, 403, "FORBIDDEN_POLICY");
      assert.deepEqual(res.body!.error.details, {});
      assert.equal(res.calls.length, 0);
      assert.equal(saves.length, 0);
      assert.deepEqual(lookups, []);
    }
  });

  it("lets a viewer compare the non-experimental policies, by canonical name or alias", async () => {
    for (const policies of [["waterfall", "cheapestFeasible"], ["ruleBased", "baseline"]]) {
      const { store } = fakeStore();
      const res = await post(comparisonBody({ policies }), { store, token: viewerToken });
      assert.equal(res.status, 201);
      assert.deepEqual(policiesOf(res), policies.map((p) => canonicalComparisonPolicy(p)));
    }
  });
});

describe("POST /api/v1/comparisons: PPO is the engine's to enable", () => {
  it("never calls /v1/version: the only inference call is one /v1/compare", async () => {
    for (const answers of [ENABLED, DISABLED]) {
      const res = await post(comparisonBody(), { store: fakeStore().store, answers });
      assert.equal(res.status, 201);
      assert.deepEqual(res.calls.map((c) => c.path), ["/v1/compare"]);
    }
  });

  it("enabled: returns and saves the engine's ppoProjected result, whatever checkpoint it reports", async () => {
    for (const checkpoint of [CHECKPOINT, "b".repeat(64)]) {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: ["waterfall", "ppoProjected"] }), {
        store,
        answers: {
          "/v1/compare": {
            status: 200,
            body: engineCompareResponse([engineResult("waterfall"), engineResult("ppo_projected", { checkpointSha256: checkpoint })]),
          },
        },
      });
      assert.equal(res.status, 201, res.text);
      assert.deepEqual(policiesOf(res), ["waterfall", "ppoProjected"]);
      assert.equal(res.body!.results[1].provenance.checkpoint.sha256, checkpoint);
      assert.deepEqual(res.body!.skipped, []);
      assert.equal(saves.length, 1);
    }
  });

  it("disabled: reports ppoProjected in skipped with the engine's message unchanged, and saves the comparison", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody(), { store, answers: DISABLED });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body!.policies, ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual(policiesOf(res), ["waterfall", "cheapestFeasible"]);
    assert.deepEqual(res.body!.skipped, [{ policy: "ppoProjected", code: "POLICY_DISABLED", message: ENGINE_SKIP_MESSAGE }]);
    // One engine call, for exactly the policies listed: nothing is retried or substituted.
    assert.equal(res.compareCalls.length, 1);
    assert.deepEqual(res.compareCalls[0]!.body!.policies, ["waterfall", "cheapest_feasible", "ppo_projected"]);
    assert.equal(saves.length, 1);
    assert.deepEqual(saves[0]!.request.policies, ["waterfall", "cheapestFeasible", "ppoProjected"]);
  });

  it("disabled: saves a comparison in which every policy was skipped, with corridor null", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody({ policies: ["ppoProjected"] }), { store, answers: DISABLED });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body!.results, []);
    assert.equal(res.body!.skipped.length, 1);
    assert.equal(res.body!.transaction.corridor, null);
    assert.equal(saves[0]!.corridor, null);
  });

  it("passes every skipped message through exactly, including empty, Unicode and unknown codes, in request order", async () => {
    const { store } = fakeStore();
    const messages = { ppo: "Needs history on every venue (explicit mode) — “ünïcode”", cheap: "" };
    const res = await post(comparisonBody({ policies: ["waterfall", "ruleBased", "ppoProjected"] }), {
      store,
      answers: {
        "/v1/compare": {
          status: 200,
          body: engineCompareResponse(
            [engineResult("waterfall")],
            [
              engineSkipped("ppo_projected", "POLICY_UNAVAILABLE_FOR_STATE", messages.ppo),
              engineSkipped("cheapest_feasible", "SOME_NEW_CODE", messages.cheap),
            ],
          ),
        },
      },
    });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(res.body!.skipped, [
      { policy: "cheapestFeasible", code: "SOME_NEW_CODE", message: messages.cheap },
      { policy: "ppoProjected", code: "POLICY_UNAVAILABLE_FOR_STATE", message: messages.ppo },
    ]);
  });

  it("never falls back to raw PPO: a result naming any unrequested or unknown policy is refused", async () => {
    for (const result of [
      { ...engineResult("ppo_projected", { checkpointSha256: CHECKPOINT }), policy: "ppo" },
      { ...engineResult("ppo_projected", { checkpointSha256: CHECKPOINT }), policy: "ppo_raw" },
      engineResult("cheapest_feasible"), // a substitute for the skipped policy
    ]) {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: ["waterfall", "ppoProjected"] }), {
        store,
        answers: { "/v1/compare": { status: 200, body: engineCompareResponse([engineResult("waterfall"), result]) } },
      });
      assertError(res, 502, "INFERENCE_ERROR");
      assert.equal(res.compareCalls.length, 1); // never retried
      assert.equal(saves.length, 0);
    }
  });
});

describe("POST /api/v1/comparisons: invalid /v1/compare 200 bodies", () => {
  const waterfall = () => engineResult("waterfall");
  const cases: Array<[string, unknown]> = [
    ["a body that isn't an object", [1]],
    ["results missing", { skipped: [], same_state: true, note: "n" }],
    ["skipped missing", { results: [waterfall()], same_state: true, note: "n" }],
    ["same_state false", engineCompareResponse([waterfall()], [], { same_state: false })],
    ["a note that isn't a string", engineCompareResponse([waterfall()], [], { note: null })],
    ["a requested policy reported nowhere", engineCompareResponse([])],
    ["a result for a policy that wasn't requested", engineCompareResponse([waterfall(), engineResult("ppo_projected", { checkpointSha256: CHECKPOINT })])],
    ["the same policy twice in results", engineCompareResponse([waterfall(), waterfall()])],
    ["a policy in both results and skipped", engineCompareResponse([waterfall()], [engineSkipped("waterfall")])],
    ["a skipped entry without a code", engineCompareResponse([], [{ policy: "waterfall", message: "m" }])],
    ["a skipped entry whose code isn't a code", engineCompareResponse([], [engineSkipped("waterfall", "not a code <script>")])],
    ["a skipped entry without a message", engineCompareResponse([], [{ policy: "waterfall", code: "POLICY_DISABLED" }])],
    ["a skipped entry whose message isn't a string", engineCompareResponse([], [engineSkipped("waterfall", "POLICY_DISABLED", 5 as unknown as string)])],
    ["a skipped entry naming an alias", engineCompareResponse([], [engineSkipped("baseline")])],
    ["a result that isn't a valid RouteResponse", engineCompareResponse([{ ...waterfall(), metrics: null }])],
    ["a result echoing another amount", engineCompareResponse([{ ...waterfall(), transaction: { ...(waterfall().transaction as object), amount_usd: 1 } }])],
  ];
  for (const [name, body] of cases) {
    it(`returns 502 INFERENCE_ERROR and saves nothing for ${name}`, async () => {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: ["waterfall"] }), { store, answers: { "/v1/compare": { status: 200, body } } });
      assertError(res, 502, "INFERENCE_ERROR");
      assert.equal(res.body!.error.message, "The inference service returned an invalid response.");
      assert.deepEqual(res.body!.error.details, {});
      assert.equal(saves.length, 0);
    });
  }

  it("refuses results that disagree on the corridor or the state frame", async () => {
    const other = engineResult("cheapest_feasible");
    for (const second of [
      { ...other, transaction: { ...(other.transaction as object), corridor: "USA->IND" } },
      { ...other, provenance: { ...(other.provenance as object), state_frame_sha256: "another" } },
    ]) {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: ["waterfall", "cheapestFeasible"] }), {
        store,
        answers: { "/v1/compare": { status: 200, body: engineCompareResponse([waterfall(), second]) } },
      });
      assertError(res, 502, "INFERENCE_ERROR");
      assert.equal(saves.length, 0);
    }
  });

  it("logs field paths only, never values", async () => {
    const capture = captureLogger();
    const body = engineCompareResponse([{ ...waterfall(), decision_id: 42, policy_status: "secret-value" }]);
    const res = await post(comparisonBody({ policies: ["waterfall"] }), {
      store: fakeStore().store,
      logger: capture.logger,
      answers: { "/v1/compare": { status: 200, body } },
    });
    assertError(res, 502, "INFERENCE_ERROR");
    const logged = capture.entries().find((e) => e.msg === "inference response rejected");
    assert.ok(logged);
    assert.deepEqual(logged.problems, [
      "results[0].decision_id: must be a non-empty string",
      "results[0].policy_status: has an unknown value",
    ]);
    assert.ok(!capture.lines.join("\n").includes("secret-value"));
  });

  it("keeps unknown engine fields in the results and stores the response verbatim", async () => {
    const { store, saves } = fakeStore();
    const body = engineCompareResponse([{ ...waterfall(), extra_field: { nested_key: 1 } }], [], { extra_top: true });
    const res = await post(comparisonBody({ policies: ["waterfall"] }), { store, answers: { "/v1/compare": { status: 200, body } } });
    assert.equal(res.status, 201);
    assert.deepEqual(res.body!.results[0].extraField, { nestedKey: 1 });
    assert.ok(!("extraTop" in res.body!));
    assert.deepEqual(saves[0]!.engineResponse, body);
  });
});

describe("POST /api/v1/comparisons: inference failures persist nothing", () => {
  const cases: Array<[string, Answer, number, string, Record<string, unknown>, string | null]> = [
    ["no answer (unreachable)", undefined, 503, "INFERENCE_UNAVAILABLE", {}, null],
    ["500 INTERNAL_ERROR", { status: 500, body: engineError("INTERNAL_ERROR") }, 502, "INFERENCE_ERROR", {}, null],
    ["a 500 that isn't an envelope", { status: 500, body: "oops" }, 502, "INFERENCE_ERROR", {}, null],
    ["503 NOT_READY", { status: 503, body: engineError("NOT_READY"), retryAfter: "7" }, 503, "INFERENCE_UNAVAILABLE", { cause: "NOT_READY" }, "7"],
    ["503 ENGINE_BUSY", { status: 503, body: engineError("ENGINE_BUSY"), retryAfter: "3" }, 503, "ENGINE_BUSY", {}, "3"],
    ["504 ENGINE_TIMEOUT", { status: 504, body: engineError("ENGINE_TIMEOUT") }, 504, "ENGINE_TIMEOUT", {}, null],
    ["422 UNSUPPORTED_CORRIDOR", { status: 422, body: engineError("UNSUPPORTED_CORRIDOR") }, 422, "UNSUPPORTED_CORRIDOR", {}, null],
    ["422 DATE_IN_GAP_BUFFER", { status: 422, body: { error: { code: "DATE_IN_GAP_BUFFER", message: "m", details: { field: "state.date" } } } }, 422, "DATE_IN_GAP_BUFFER", { field: "state.date" }, null],
    // §2.9: a disabled policy is skipped, so this code from /v1/compare is a fault, not passed through.
    ["409 POLICY_DISABLED", { status: 409, body: engineError("POLICY_DISABLED") }, 502, "INFERENCE_ERROR", {}, null],
    ["404 NOT_FOUND", { status: 404, body: engineError("NOT_FOUND") }, 502, "INFERENCE_ERROR", {}, null],
    ["201 with a valid body", { status: 201, body: engineCompareResponse([engineResult("waterfall")]) }, 502, "INFERENCE_ERROR", {}, null],
    ["204", { status: 204, body: null }, 502, "INFERENCE_ERROR", {}, null],
    ["a redirect", { status: 302, body: engineCompareResponse([engineResult("waterfall")]) }, 502, "INFERENCE_ERROR", {}, null],
  ];
  for (const [name, answer, status, code, details, retryAfter] of cases) {
    it(`${name} -> ${status} ${code}`, async () => {
      const { store, saves } = fakeStore();
      const res = await post(comparisonBody({ policies: ["waterfall"] }), { store, answers: { "/v1/compare": answer } });
      assertError(res, status, code);
      assert.deepEqual(res.body!.error.details, details);
      assert.equal(res.headers.get("retry-after"), retryAfter);
      assert.ok(!res.text.includes("upstream message"));
      assert.equal(res.compareCalls.length, 1); // never retried
      assert.equal(saves.length, 0);
    });
  }

  it("returns 503 INFERENCE_UNAVAILABLE when no inference client is configured", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody(), { store, noClient: true });
    assertError(res, 503, "INFERENCE_UNAVAILABLE");
    assert.equal(saves.length, 0);
  });
});

describe("POST /api/v1/comparisons: persistence", () => {
  it("saves once, only after a 200 that maps", async () => {
    const { store, saves } = fakeStore();
    const res = await post(comparisonBody({ policies: ["waterfall"] }), { store });
    assert.equal(res.status, 201);
    assert.equal(saves.length, 1);
  });

  it("returns 500 INTERNAL_ERROR when the save fails, without leaking the cause", async () => {
    const { store } = fakeStore({ saveError: new Error("db-password-and-detail") });
    const res = await post(comparisonBody({ policies: ["waterfall"] }), { store, logger: captureLogger().logger });
    assertError(res, 500, "INTERNAL_ERROR");
    assert.ok(!res.text.includes("db-password"));
  });

  it("returns 500 before inference when the caller has no User row, or no database is configured", async () => {
    const missingUser = fakeStore({ userExists: false });
    for (const store of [missingUser.store, undefined]) {
      const res = await post(comparisonBody(), { ...(store && { store }), logger: captureLogger().logger });
      assertError(res, 500, "INTERNAL_ERROR");
      assert.equal(res.calls.length, 0);
    }
    assert.equal(missingUser.saves.length, 0);
  });

  it("saves the same request twice as two independent records", async () => {
    const { store, saves, rows } = fakeStore();
    const body = comparisonBody({ policies: ["waterfall"], clientReference: "same" });
    const [first, second] = await Promise.all([post(body, { store }), post(body, { store })]);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.notEqual(first.body!.id, second.body!.id);
    assert.equal(saves.length, 2);
    assert.equal(rows.size, 2);
  });
});

describe("GET /api/v1/comparisons/:id", () => {
  async function created(body: Record<string, unknown>, answers: Answers = ENABLED) {
    const fake = fakeStore();
    const res = await post(body, { store: fake.store, answers });
    assert.equal(res.status, 201, res.text);
    return { ...fake, posted: res.body! };
  }

  it("returns the stored comparison exactly as the POST returned it, without calling inference", async () => {
    const { store, posted, saves } = await created(comparisonBody({ policies: ["ppoProjected", "baseline"], clientReference: "demo" }));
    const res = await call(`/api/v1/comparisons/${posted.id}`, { store, answers: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, posted);
    assert.deepEqual(Object.keys(res.body!), Object.keys(posted));
    assert.deepEqual(res.body!.policies, ["ppoProjected", "waterfall"]);
    assert.deepEqual(res.body!.state, { mode: "historicalReplay", date: "2024-06-14" });
    assert.deepEqual(policiesOf(res), ["ppoProjected", "waterfall"]);
    assert.equal(res.calls.length, 0);
    assert.equal(saves.length, 1);
  });

  it("returns a stored effective explicit state and scenario state as the POST did", async () => {
    const explicit = {
      mode: "explicit",
      referenceDate: "2024-06-14",
      venues: [{ bridgeUid: "GBR->PHL#0", liquidityUsd: 1000, congestion: 0.1 }],
    };
    const scenario = { mode: "scenario", date: "2024-06-14", scenarioId: "congestion_x2" };
    for (const [state, options] of [
      [explicit, { stateMode: "explicit" }],
      [scenario, { stateMode: "scenario", scenarioId: "congestion_x2" }],
    ] as const) {
      const answer: Answer = { status: 200, body: engineCompareResponse([engineResult("waterfall", options)]) };
      const { store, posted } = await created(comparisonBody({ policies: ["waterfall"], state }), { "/v1/compare": answer });
      const res = await call(`/api/v1/comparisons/${posted.id}`, { store, answers: {} });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, posted);
    }
  });

  it("returns a comparison with skipped policies, and one in which every policy was skipped", async () => {
    for (const policies of [undefined, ["ppoProjected"]]) {
      const { store, posted } = await created(comparisonBody(policies && { policies }), DISABLED);
      const res = await call(`/api/v1/comparisons/${posted.id}`, { store });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, posted);
      assert.equal(res.body!.skipped[0].message, ENGINE_SKIP_MESSAGE);
    }
  });

  it("lets a viewer read any comparison, including one with a ppoProjected result", async () => {
    const { store, posted } = await created(comparisonBody());
    const res = await call(`/api/v1/comparisons/${posted.id}`, { store, token: viewerToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, posted);
    assert.equal(res.body!.createdBy, "u-analyst-1");
  });

  it("finds an upper-case UUID", async () => {
    const { store, posted } = await created(comparisonBody());
    const res = await call(`/api/v1/comparisons/${String(posted.id).toUpperCase()}`, { store });
    assert.equal(res.status, 200);
  });

  it("returns 404 NOT_FOUND for an unknown UUID", async () => {
    const { store, lookups } = fakeStore();
    const res = await call(`/api/v1/comparisons/${UNKNOWN_ID}`, { store });
    assertError(res, 404, "NOT_FOUND");
    assert.deepEqual(res.body!.error, { code: "NOT_FOUND", message: "Unknown resource.", details: {}, requestId: "req-compare" });
    assert.deepEqual(lookups, [UNKNOWN_ID]);
  });

  it("returns the same 404 for a malformed ID, without touching the database", async () => {
    for (const id of ["1", "not-a-uuid", `${UNKNOWN_ID}0`, "00000000-0000-4000-8000-00000000fffg", "%27%20OR%201=1"]) {
      const { store, lookups } = fakeStore();
      const res = await call(`/api/v1/comparisons/${id}`, { store });
      assertError(res, 404, "NOT_FOUND");
      assert.equal(res.body!.error.message, "Unknown resource.");
      assert.deepEqual(lookups, []);
    }
  });

  it("returns 401 UNAUTHENTICATED without a token, before any lookup", async () => {
    const { store, lookups } = fakeStore();
    for (const token of [null, newToken()]) {
      assertError(await call(`/api/v1/comparisons/${UNKNOWN_ID}`, { store, token }), 401, "UNAUTHENTICATED");
    }
    assert.deepEqual(lookups, []);
  });

  it("returns 500 INTERNAL_ERROR without a database, and for a stored response that no longer maps", async () => {
    assertError(await call(`/api/v1/comparisons/${UNKNOWN_ID}`, { logger: captureLogger().logger }), 500, "INTERNAL_ERROR");

    const { rows, posted } = await created(comparisonBody({ policies: ["waterfall"] }));
    const row = rows.get(posted.id)!;
    for (const broken of [
      { ...row, engineResponse: { results: "secret-value", skipped: [], same_state: true, note: "n" } },
      // A stored state the stored results don't confirm.
      { ...row, stateSpec: { mode: "historicalReplay", date: "2024-06-13" } as Prisma.JsonValue },
    ]) {
      const capture = captureLogger();
      const res = await call(`/api/v1/comparisons/${posted.id}`, { store: fakeStore({ rows: [broken] }).store, logger: capture.logger });
      assertError(res, 500, "INTERNAL_ERROR");
      assert.equal(res.body!.error.message, "An unexpected error occurred.");
      const logged = capture.entries().find((e) => e.msg === "stored compare response no longer maps");
      assert.ok(logged);
      assert.equal(logged.comparisonId, posted.id);
      assert.ok(!capture.lines.join("\n").includes("secret-value"));
    }
  });

  it("answers HEAD like GET, with no body", async () => {
    const { store, posted } = await created(comparisonBody());
    const res = await call(`/api/v1/comparisons/${posted.id}`, { store, method: "HEAD" });
    assert.equal(res.status, 200);
    assert.equal(res.text, "");
  });
});

describe("comparison routes: method handling (§4)", () => {
  for (const [method, path, allow] of [
    ["GET", "/api/v1/comparisons", "POST"],
    ["HEAD", "/api/v1/comparisons", "POST"],
    ["DELETE", "/api/v1/comparisons", "POST"],
    ["PUT", "/api/v1/comparisons", "POST"],
    ["OPTIONS", "/api/v1/comparisons", "POST"],
    ["POST", `/api/v1/comparisons/${UNKNOWN_ID}`, "GET, HEAD"],
    ["DELETE", `/api/v1/comparisons/${UNKNOWN_ID}`, "GET, HEAD"],
    ["PATCH", `/api/v1/comparisons/${UNKNOWN_ID}`, "GET, HEAD"],
  ] as const) {
    it(`${method} ${path.replace(UNKNOWN_ID, ":id")} -> 405 with Allow: ${allow}, saving nothing`, async () => {
      const { store, saves, lookups } = fakeStore();
      // Authentication comes first (§10 Q14): no token is 401, without Allow.
      const anon = await call(path, { store, method, token: null });
      assert.equal(anon.status, 401);
      assert.equal(anon.headers.get("allow"), null);
      assert.equal(anon.calls.length, 0);
      // A valid token: 405 with Allow.
      const res = await call(path, { store, method, token: viewerToken });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), allow);
      if (method !== "HEAD") {
        assert.deepEqual(res.body!.error, {
          code: "METHOD_NOT_ALLOWED",
          message: `Method ${method} is not allowed on ${path.replace(UNKNOWN_ID, ":id")}.`,
          details: {},
          requestId: "req-compare",
        });
      }
      assert.equal(res.calls.length, 0);
      assert.equal(saves.length, 0);
      assert.deepEqual(lookups, []);
    });
  }

  it("returns 404 for a path below a comparison", async () => {
    const res = await call(`/api/v1/comparisons/${UNKNOWN_ID}/explanation`, { store: fakeStore().store });
    assertError(res, 404, "NOT_FOUND");
  });
});
