import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import type { TransactionPersistence } from "../../src/db/transactionPersistence.js";
import { createInferenceClient, type InferenceRequest } from "../../src/inferenceClient/client.js";
import {
  UNSAFE_INTEGER_MESSAGE,
  validateTransactionRequest,
  type FieldError,
} from "../../src/validation/transactionRequest.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { silentLogger, startServer } from "../helpers/server.js";
import { engineRouteResponse } from "../helpers/transactions.js";

// API contract §2.11: integer-valued numbers beyond ±(2^53 - 1) in transaction
// or state are rejected with 422 VALIDATION_ERROR, never rounded. The rule is
// on the parsed value, so every test body here is raw JSON text: the spelling
// reaches JSON.parse exactly as a client would send it.

const MAX = "9007199254740991";
const FINITE = "Must be a finite number.";

/** An explicit-state body as JSON text; each placeholder is replaced by a raw number token. */
function rawBody(numbers: { amount?: string; liquidity?: string; congestion?: string; historyLast?: string; historyFirst?: string } = {}): string {
  const first = numbers.historyFirst ?? "0";
  const last = numbers.historyLast ?? "210000";
  const history = [first, ...Array.from({ length: 28 }, (_, i) => String(i + 1)), last].join(",");
  return `{
    "senderCountry": "GBR", "receiverCountry": "PHL", "amountUsd": ${numbers.amount ?? "300000"},
    "policy": "waterfall",
    "state": {"mode": "explicit", "referenceDate": "2024-06-14", "venues": [
      {"bridgeUid": "GBR->PHL#0", "liquidityUsd": 210000, "congestion": 0.35, "history": null},
      {"bridgeUid": "GBR->PHL#1", "liquidityUsd": ${numbers.liquidity ?? "60000"}, "congestion": ${numbers.congestion ?? "0.2"},
       "history": {"liquidityUsd": [${history}], "congestion": [${Array(30).fill("0.2").join(",")}]}}
    ]}
  }`;
}

function errorsFor(text: string): FieldError[] {
  const result = validateTransactionRequest(JSON.parse(text));
  // Unsafe integers are schema problems, so VALIDATION_ERROR, never INVALID_AMOUNT.
  return !result.ok && result.code === "VALIDATION_ERROR" ? result.errors : [];
}

describe("validateTransactionRequest: unsafe integers (§2.11)", () => {
  it("accepts ±MAX_SAFE_INTEGER and passes the parsed values on unchanged", () => {
    const result = validateTransactionRequest(
      JSON.parse(rawBody({ amount: MAX, liquidity: `${MAX}.0`, historyFirst: `-${MAX}`, historyLast: "9.007199254740991e15" })),
    );
    assert.ok(result.ok);
    assert.equal(result.value.amountUsd, Number.MAX_SAFE_INTEGER);
    assert.equal(result.value.state.mode, "explicit");
    if (result.value.state.mode !== "explicit") return;
    const venue = result.value.state.venues[1]!;
    assert.equal(venue.liquidityUsd, Number.MAX_SAFE_INTEGER);
    assert.equal(venue.history!.liquidityUsd[0], -Number.MAX_SAFE_INTEGER);
    assert.equal(venue.history!.liquidityUsd[29], Number.MAX_SAFE_INTEGER);
  });

  it("accepts large non-integers and tiny values in any spelling", () => {
    for (const amount of ["4503599627370495.5", "1.5e-7", "0.00000015", "-0.0", "300000.0", "3e5"]) {
      assert.deepEqual(errorsFor(rawBody({ amount })), [], amount);
    }
  });

  for (const spelling of ["9007199254740992", "9007199254740993", "9007199254740992.0", "9.007199254740992e15", "1e21", "1E300"]) {
    it(`rejects amountUsd ${spelling}`, () => {
      assert.deepEqual(errorsFor(rawBody({ amount: spelling })), [{ field: "amountUsd", message: UNSAFE_INTEGER_MESSAGE }]);
    });
  }

  for (const spelling of ["-9007199254740992", "-9007199254740993", "-9.007199254740992e15", "-1e21"]) {
    it(`rejects negative amountUsd ${spelling}`, () => {
      assert.deepEqual(errorsFor(rawBody({ amount: spelling })), [{ field: "amountUsd", message: UNSAFE_INTEGER_MESSAGE }]);
    });
  }

  it("rejects unsafe nested venue values with their camelCase paths", () => {
    assert.deepEqual(errorsFor(rawBody({ liquidity: "1e16", congestion: "-9007199254740992" })), [
      { field: "state.venues[1].liquidityUsd", message: UNSAFE_INTEGER_MESSAGE },
      { field: "state.venues[1].congestion", message: UNSAFE_INTEGER_MESSAGE },
    ]);
  });

  it("rejects unsafe history values by index", () => {
    assert.deepEqual(errorsFor(rawBody({ historyLast: "9007199254740992.0" })), [
      { field: "state.venues[1].history.liquidityUsd[29]", message: UNSAFE_INTEGER_MESSAGE },
    ]);
    assert.deepEqual(errorsFor(rawBody({ historyFirst: "-1e300" })), [
      { field: "state.venues[1].history.liquidityUsd[0]", message: UNSAFE_INTEGER_MESSAGE },
    ]);
  });

  it("rejects values that overflow to ±Infinity as non-finite", () => {
    assert.deepEqual(errorsFor(rawBody({ amount: "1e400", liquidity: "-1e400", historyLast: "1e999" })), [
      { field: "amountUsd", message: FINITE },
      { field: "state.venues[1].liquidityUsd", message: FINITE },
      { field: "state.venues[1].history.liquidityUsd[29]", message: FINITE },
    ]);
  });
});

describe("POST /api/v1/transactions: unsafe integers (§2.11)", () => {
  const token = newToken();
  const users: DevUser[] = [
    { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(token) },
  ];

  async function post(body: string, engineResponse: Record<string, unknown> = engineRouteResponse()) {
    const inferenceCalls: Array<Readonly<InferenceRequest>> = [];
    const saved: unknown[] = [];
    const persistence: TransactionPersistence = {
      userExists: async () => true,
      saveRouted: async (input) => {
        saved.push(input);
        return { id: "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f", createdAt: new Date("2026-11-02T10:00:00.123Z") };
      },
      saveFailed: async (input) => {
        saved.push(input);
        return { id: "c0a8012e-7d3b-4f5e-9a51-2b1f3c4d5e6f", createdAt: new Date("2026-11-02T10:00:00.123Z") };
      },
    };
    const inferenceClient = createInferenceClient(
      { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
      {
        logger: silentLogger,
        mockHandler: (request) => {
          inferenceCalls.push(request);
          return { status: 200, body: engineResponse };
        },
      },
    );
    const app = createApp({ logger: silentLogger, users, inferenceClient, transactionPersistence: persistence });
    const server = await startServer(app);
    try {
      const res = await fetch(`${server.baseUrl}/api/v1/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body,
      });
      return { res, body: (await res.json()) as Record<string, any>, inferenceCalls, saved };
    } finally {
      await server.close();
    }
  }

  for (const [label, numbers, field] of [
    ["amountUsd beyond +2^53 - 1", { amount: "9007199254740993" }, "amountUsd"],
    ["amountUsd beyond -(2^53 - 1)", { amount: "-9.007199254740992e15" }, "amountUsd"],
    ["a nested venue value", { liquidity: "9007199254740992.0" }, "state.venues[1].liquidityUsd"],
    ["a history value", { historyFirst: "1e21" }, "state.venues[1].history.liquidityUsd[0]"],
  ] as const) {
    it(`422 VALIDATION_ERROR for ${label}, before inference`, async () => {
      const { res, body, inferenceCalls, saved } = await post(rawBody(numbers));
      assert.equal(res.status, 422);
      assert.equal(body.error.code, "VALIDATION_ERROR");
      assert.deepEqual(body.error.details.errors, [{ field, message: UNSAFE_INTEGER_MESSAGE }]);
      assert.equal(inferenceCalls.length, 0);
      assert.equal(saved.length, 0);
    });
  }

  it("422 VALIDATION_ERROR for 1e400 (parsed as Infinity)", async () => {
    const { res, body, inferenceCalls } = await post(rawBody({ amount: "1e400" }));
    assert.equal(res.status, 422);
    assert.equal(body.error.code, "VALIDATION_ERROR");
    assert.deepEqual(body.error.details.errors, [{ field: "amountUsd", message: FINITE }]);
    assert.equal(inferenceCalls.length, 0);
  });

  it("sends the same parsed values to inference when they are safe", async () => {
    // The engine response echoes this request (explicit state, amount
    // 2^53 - 1), so the backend's response checks accept it.
    const base = engineRouteResponse({ stateMode: "explicit" });
    const engineResponse = {
      ...base,
      transaction: { ...(base.transaction as Record<string, unknown>), amount_usd: Number.MAX_SAFE_INTEGER },
    };
    const { res, body, inferenceCalls } = await post(
      rawBody({ amount: `${MAX}.0`, liquidity: "9.007199254740991e15", historyFirst: `-${MAX}` }),
      engineResponse,
    );
    assert.equal(res.status, 201);
    assert.equal(body.status, "routed");
    assert.equal(body.transaction.amountUsd, Number.MAX_SAFE_INTEGER);
    assert.equal(inferenceCalls.length, 1);
    const sent = inferenceCalls[0]!.body as Record<string, any>;
    assert.equal(sent.transaction.amount_usd, Number.MAX_SAFE_INTEGER);
    assert.equal(sent.state.venues[1].liquidity_usd, Number.MAX_SAFE_INTEGER);
    assert.equal(sent.state.venues[1].history.liquidity_usd[0], -Number.MAX_SAFE_INTEGER);
  });
});
