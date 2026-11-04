import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLIENT_REFERENCE_MESSAGE,
  COUNTRY_CODE_MESSAGE,
  isCalendarDate,
  validateTransactionRequest,
  type FieldError,
  type TransactionRequest,
} from "../../src/validation/transactionRequest.js";

// Request bodies shaped after API contract §3.2; test data, not fixtures.
const series = (last: number) => Array.from({ length: 30 }, (_, i) => (i === 29 ? last : i));
const replay = {
  senderCountry: "GBR",
  receiverCountry: "PHL",
  amountUsd: 300000.0,
  state: { mode: "historicalReplay", date: "2024-06-14" },
  policy: "waterfall",
  clientReference: "optional",
};
const scenario = { ...replay, state: { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" } };
const explicit = {
  ...replay,
  policy: "ppoProjected",
  state: {
    mode: "explicit",
    referenceDate: "2024-06-14",
    venues: [
      { bridgeUid: "GBR->PHL#0", liquidityUsd: 210000.0, congestion: 0.35, history: { liquidityUsd: series(210000), congestion: series(0.35) } },
      { bridgeUid: "GBR->PHL#1", liquidityUsd: 60000.0, congestion: 0.2, history: null },
      { bridgeUid: "GBR->PHL#2", liquidityUsd: 90000.0, congestion: 0.5 },
    ],
  },
};

function valid(body: unknown): TransactionRequest {
  const result = validateTransactionRequest(body);
  assert.ok(result.ok, `expected valid, got ${result.ok ? "" : result.code}`);
  return result.value;
}

/** The schema problems, asserting VALIDATION_ERROR rather than INVALID_AMOUNT. */
function errors(body: unknown): FieldError[] {
  const result = validateTransactionRequest(body);
  assert.equal(result.ok, false, "expected invalid");
  if (result.ok) return [];
  assert.equal(result.code, "VALIDATION_ERROR", "expected VALIDATION_ERROR");
  return result.code === "VALIDATION_ERROR" ? result.errors : [];
}

/** Asserts the §3.2 step-2 outcome: INVALID_AMOUNT on an otherwise valid body. */
function invalidAmount(body: unknown): void {
  const result = validateTransactionRequest(body);
  assert.equal(result.ok, false, "expected invalid");
  assert.equal(result.ok ? undefined : result.code, "INVALID_AMOUNT");
  assert.equal(result.ok || result.code !== "INVALID_AMOUNT" ? undefined : result.field, "amountUsd");
}

const fields = (body: unknown) => errors(body).map((e) => e.field);
const without = (object: Record<string, unknown>, key: string) => {
  const { [key]: _removed, ...rest } = object;
  return rest;
};

describe("validateTransactionRequest: valid requests", () => {
  it("accepts historical replay", () => {
    assert.deepEqual(valid(replay), {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 300000,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policy: "waterfall",
      clientReference: "optional",
    });
  });

  it("accepts a scenario, keeping scenarioId exactly as sent", () => {
    assert.deepEqual(valid(scenario).state, { mode: "scenario", date: "2024-06-14", scenarioId: "cheapest_venue_outage" });
    assert.equal((valid({ ...scenario, state: { ...scenario.state, scenarioId: "cheapestVenueOutage" } }).state as { scenarioId: string }).scenarioId, "cheapestVenueOutage");
  });

  it("accepts an explicit state with full, null and omitted history", () => {
    const value = valid(explicit);
    assert.equal(value.policy, "ppoProjected");
    assert.deepEqual(value.state, {
      mode: "explicit",
      referenceDate: "2024-06-14",
      venues: [
        { bridgeUid: "GBR->PHL#0", liquidityUsd: 210000, congestion: 0.35, history: { liquidityUsd: series(210000), congestion: series(0.35) } },
        { bridgeUid: "GBR->PHL#1", liquidityUsd: 60000, congestion: 0.2, history: null },
        { bridgeUid: "GBR->PHL#2", liquidityUsd: 90000, congestion: 0.5, history: null },
      ],
    });
  });

  it("leaves domain rules to inference: values, venue counts and history consistency", () => {
    // INVALID_STATE_VALUE, STATE_VENUE_MISMATCH and UNSUPPORTED_CORRIDOR are the engine's (§2.4, §4).
    assert.equal(valid({ ...replay, amountUsd: 9e9 }).amountUsd, 9e9);
    // A well-formed code in no supported corridor: the engine's call, not ours.
    assert.equal(valid({ ...replay, senderCountry: "XXX" }).senderCountry, "XXX");
    assert.equal(valid({ ...replay, state: { mode: "historicalReplay", date: "1999-01-01" } }).state.mode, "historicalReplay");
    const odd = { ...explicit, state: { ...explicit.state, venues: [{ bridgeUid: "nope", liquidityUsd: -1, congestion: -2, history: { liquidityUsd: series(5), congestion: series(9) } }] } };
    assert.equal(valid(odd).state.mode, "explicit");
    assert.equal(valid({ ...explicit, state: { ...explicit.state, venues: [] } }).state.mode, "explicit");
  });

  it("defaults policy to waterfall only when it is omitted (§3.2)", () => {
    assert.equal(valid(without(replay, "policy")).policy, "waterfall");
  });

  for (const policy of ["waterfall", "cheapestFeasible", "ppoProjected"]) {
    it(`accepts policy ${policy}`, () => {
      assert.equal(valid({ ...replay, policy }).policy, policy);
    });
  }

  it("accepts every state mode", () => {
    assert.equal(valid(replay).state.mode, "historicalReplay");
    assert.equal(valid(scenario).state.mode, "scenario");
    assert.equal(valid(explicit).state.mode, "explicit");
  });

  it("treats an omitted or null clientReference as null, and keeps empty strings", () => {
    assert.equal(valid(without(replay, "clientReference")).clientReference, null);
    assert.equal(valid({ ...replay, clientReference: null }).clientReference, null);
    assert.equal(valid({ ...replay, clientReference: "" }).clientReference, "");
  });

  it("accepts a clientReference of exactly 200 code points, counting code points not UTF-16 units", () => {
    assert.equal(valid({ ...replay, clientReference: "r".repeat(200) }).clientReference, "r".repeat(200));
    // 200 astral characters are 400 UTF-16 units but 200 code points.
    const emoji = "\u{1f600}".repeat(200);
    assert.equal(emoji.length, 400);
    assert.equal(valid({ ...replay, clientReference: emoji }).clientReference, emoji);
  });

  it("does not share arrays with the input", () => {
    const body = structuredClone(explicit);
    const value = valid(body);
    const history = (value.state as { venues: Array<{ history: { liquidityUsd: number[] } }> }).venues[0]!.history;
    history.liquidityUsd[0] = 999;
    assert.equal(body.state.venues[0]!.history!.liquidityUsd[0], 0);
  });
});

describe("validateTransactionRequest: invalid requests", () => {
  for (const body of [null, [], "text", 1, true, undefined]) {
    it(`rejects a body that isn't an object: ${JSON.stringify(body)}`, () => {
      // Form-level: about no single field, so field is omitted (§4).
      assert.deepEqual(errors(body), [{ message: "Must be a JSON object." }]);
    });
  }

  for (const key of ["senderCountry", "receiverCountry", "amountUsd", "state"]) {
    it(`requires ${key}`, () => {
      assert.deepEqual(errors(without(replay, key)), [{ field: key, message: "Required." }]);
    });
  }

  for (const [key, value, message] of [
    ["senderCountry", "", COUNTRY_CODE_MESSAGE],
    ["senderCountry", 826, COUNTRY_CODE_MESSAGE],
    ["receiverCountry", null, COUNTRY_CODE_MESSAGE],
    ["policy", null, "Must be one of: waterfall, cheapestFeasible, ppoProjected."],
    ["amountUsd", "300000", "Must be a finite number."],
    ["amountUsd", null, "Must be a finite number."],
    ["amountUsd", Infinity, "Must be a finite number."],
    ["amountUsd", Number.NaN, "Must be a finite number."],
    ["state", "historicalReplay", "Must be an object."],
    ["state", [], "Must be an object."],
    ["policy", "cheapest_feasible", "Must be one of: waterfall, cheapestFeasible, ppoProjected."],
    ["policy", "ppo_projected", "Must be one of: waterfall, cheapestFeasible, ppoProjected."],
    ["policy", "Waterfall", "Must be one of: waterfall, cheapestFeasible, ppoProjected."],
    ["policy", 1, "Must be one of: waterfall, cheapestFeasible, ppoProjected."],
    ["clientReference", 42, "Must be a string."],
    ["clientReference", { id: 1 }, "Must be a string."],
  ] as const) {
    it(`rejects ${key} = ${JSON.stringify(value) ?? String(value)}`, () => {
      assert.deepEqual(errors({ ...replay, [key]: value }), [{ field: key, message }]);
    });
  }

  for (const value of ["gbr", "Gbr", "GB", "GBRR", "G8R", "G R", "GB ", " GBR", "gbr ", "ÀÉÎ", "ＧＢＲ", ""]) {
    it(`rejects the country code ${JSON.stringify(value)}`, () => {
      assert.deepEqual(errors({ ...replay, senderCountry: value }), [
        { field: "senderCountry", message: COUNTRY_CODE_MESSAGE },
      ]);
    });
  }

  for (const value of ["GBR", "PHL", "XXX", "AAA", "ZZZ"]) {
    it(`accepts the country code ${value}`, () => {
      assert.equal(valid({ ...replay, senderCountry: value }).senderCountry, value);
    });
  }

  it("rejects a clientReference longer than 200 code points, by code point", () => {
    assert.deepEqual(errors({ ...replay, clientReference: "r".repeat(201) }), [
      { field: "clientReference", message: CLIENT_REFERENCE_MESSAGE },
    ]);
    // 201 code points, 402 UTF-16 units.
    assert.deepEqual(errors({ ...replay, clientReference: "\u{1f600}".repeat(201) }), [
      { field: "clientReference", message: CLIENT_REFERENCE_MESSAGE },
    ]);
    // 300 UTF-16 units but only 150 code points: accepted, so the count is by code point.
    const under = "\u{1f600}".repeat(150);
    assert.equal(under.length, 300);
    assert.equal(valid({ ...replay, clientReference: under }).clientReference, under);
  });

  it("rejects unknown top-level fields (provisional), e.g. a misspelt policy", () => {
    assert.deepEqual(errors({ ...replay, polcy: "ppoProjected" }), [{ field: "polcy", message: "Unknown field." }]);
    assert.deepEqual(fields({ ...replay, corridor: "GBR->PHL", senderCountry: "" }), ["corridor", "senderCountry"]);
  });

  describe("state", () => {
    it("requires state.mode and checks its value", () => {
      assert.deepEqual(errors({ ...replay, state: { date: "2024-06-14" } }), [{ field: "state.mode", message: "Required." }]);
      for (const mode of ["historical_replay", "Explicit", "", 1]) {
        assert.deepEqual(errors({ ...replay, state: { mode, date: "2024-06-14" } }), [
          { field: "state.mode", message: "Must be one of: historicalReplay, scenario, explicit." },
        ]);
      }
    });

    it("requires each mode's fields", () => {
      assert.deepEqual(fields({ ...replay, state: { mode: "historicalReplay" } }), ["state.date"]);
      assert.deepEqual(fields({ ...replay, state: { mode: "scenario" } }), ["state.date", "state.scenarioId"]);
      assert.deepEqual(fields({ ...replay, state: { mode: "explicit" } }), ["state.referenceDate", "state.venues"]);
    });

    it("rejects unknown fields inside state, including another mode's fields (§2.4)", () => {
      assert.deepEqual(fields({ ...replay, state: { ...replay.state, scenarioId: "baseline" } }), ["state.scenarioId"]);
      assert.deepEqual(fields({ ...replay, state: { ...replay.state, risk: 0.1 } }), ["state.risk"]);
      assert.deepEqual(fields({ ...scenario, state: { ...scenario.state, referenceDate: "2024-06-14" } }), ["state.referenceDate"]);
      assert.deepEqual(fields({ ...explicit, state: { ...explicit.state, date: "2024-06-14" } }), ["state.date"]);
      assert.deepEqual(fields({ ...replay, state: { ...replay.state, scenario_id: "x" } }), ["state.scenario_id"]);
    });

    for (const value of ["2024-6-14", "14-06-2024", "2024-06-14T00:00:00Z", "2024-02-30", "2023-02-29", "2024-13-01", "", 20240614, null]) {
      it(`rejects the date ${JSON.stringify(value)}`, () => {
        assert.deepEqual(errors({ ...replay, state: { mode: "historicalReplay", date: value } }), [
          { field: "state.date", message: "Must be a date in YYYY-MM-DD form." },
        ]);
      });
    }

    it("checks scenarioId and referenceDate types", () => {
      assert.deepEqual(errors({ ...scenario, state: { ...scenario.state, scenarioId: "" } }), [
        { field: "state.scenarioId", message: "Must be a non-empty string." },
      ]);
      assert.deepEqual(fields({ ...explicit, state: { ...explicit.state, referenceDate: "2024/06/14" } }), ["state.referenceDate"]);
    });
  });

  describe("explicit venues", () => {
    const withVenues = (venues: unknown) => ({ ...explicit, state: { ...explicit.state, venues } });
    const venue = explicit.state.venues[1]!;

    it("requires venues to be an array of objects", () => {
      assert.deepEqual(errors(withVenues({})), [{ field: "state.venues", message: "Must be an array." }]);
      assert.deepEqual(errors(withVenues([venue, "x", null])), [
        { field: "state.venues[1]", message: "Must be an object." },
        { field: "state.venues[2]", message: "Must be an object." },
      ]);
    });

    it("requires bridgeUid, liquidityUsd and congestion", () => {
      assert.deepEqual(fields(withVenues([{}])), [
        "state.venues[0].bridgeUid",
        "state.venues[0].liquidityUsd",
        "state.venues[0].congestion",
      ]);
    });

    it("checks venue field types", () => {
      assert.deepEqual(errors(withVenues([{ bridgeUid: 0, liquidityUsd: "1", congestion: Infinity }])), [
        { field: "state.venues[0].bridgeUid", message: "Must be a non-empty string." },
        { field: "state.venues[0].liquidityUsd", message: "Must be a finite number." },
        { field: "state.venues[0].congestion", message: "Must be a finite number." },
      ]);
    });

    it("rejects fields that can't be set, such as fee or risk (§2.4)", () => {
      assert.deepEqual(fields(withVenues([{ ...venue, fee: 0.01, risk: 0.1, data_source_tag: "x" }])), [
        "state.venues[0].fee",
        "state.venues[0].risk",
        "state.venues[0].data_source_tag",
      ]);
    });

    it("requires history to be an object with exactly liquidityUsd and congestion", () => {
      assert.deepEqual(fields(withVenues([{ ...venue, history: [] }])), ["state.venues[0].history"]);
      assert.deepEqual(fields(withVenues([{ ...venue, history: { liquidityUsd: series(1) } }])), ["state.venues[0].history.congestion"]);
      assert.deepEqual(fields(withVenues([{ ...venue, history: { liquidityUsd: series(1), congestion: series(1), dates: [] } }])), [
        "state.venues[0].history.dates",
      ]);
    });

    for (const [label, values] of [
      ["29 numbers", series(1).slice(1)],
      ["31 numbers", [...series(1), 1]],
      ["an empty array", []],
      ["an object", { 0: 1 }],
    ] as const) {
      it(`rejects history with ${label}`, () => {
        assert.deepEqual(errors(withVenues([{ ...venue, history: { liquidityUsd: values, congestion: series(1) } }])), [
          { field: "state.venues[0].history.liquidityUsd", message: "Must be an array of exactly 30 numbers." },
        ]);
      });
    }

    it("reports the first non-numeric history element by index", () => {
      const bad = series(1);
      (bad as unknown[])[7] = "8";
      assert.deepEqual(errors(withVenues([{ ...venue, history: { liquidityUsd: series(1), congestion: bad } }])), [
        { field: "state.venues[0].history.congestion[7]", message: "Must be a finite number." },
      ]);
      const nulls = series(1);
      (nulls as unknown[])[0] = null;
      assert.deepEqual(fields(withVenues([{ ...venue, history: { liquidityUsd: nulls, congestion: series(1) } }])), [
        "state.venues[0].history.liquidityUsd[0]",
      ]);
    });
  });

  it("reports every problem at once", () => {
    assert.deepEqual(
      fields({ senderCountry: "", amountUsd: "x", state: { mode: "scenario", date: "bad" }, policy: "x", extra: 1 }),
      ["extra", "senderCountry", "receiverCountry", "amountUsd", "state.date", "state.scenarioId", "policy"],
    );
  });
});

describe("validateTransactionRequest: amountUsd and precedence (§3.2)", () => {
  // -0 is zero, so it is rejected too; its label is spelled out because
  // template interpolation renders it as "0".
  for (const [label, amountUsd] of [
    ["0", 0],
    ["-0", -0],
    ["-5", -5],
    ["-1e-9", -1e-9],
    ["-9e9", -9e9],
    ["-Number.MIN_VALUE", -Number.MIN_VALUE],
  ] as const) {
    it(`returns INVALID_AMOUNT for an otherwise valid body with amountUsd ${label}`, () => {
      invalidAmount({ ...replay, amountUsd });
    });
  }

  for (const amountUsd of [1e-9, 0.01, 1, 300000, 9e9, Number.MIN_VALUE]) {
    it(`accepts the positive amountUsd ${amountUsd}`, () => {
      assert.equal(valid({ ...replay, amountUsd }).amountUsd, amountUsd);
    });
  }

  it("reports schema problems before the amount: a bad country code and a zero amount give VALIDATION_ERROR", () => {
    // The §3.2 precedence example: the country problem is listed, the amount is not.
    assert.deepEqual(errors({ ...replay, senderCountry: "gbr", amountUsd: 0 }), [
      { field: "senderCountry", message: COUNTRY_CODE_MESSAGE },
    ]);
  });

  for (const [label, body] of [
    ["an unknown field", { ...replay, amountUsd: 0, extra: 1 }],
    ["policy: null", { ...replay, amountUsd: 0, policy: null }],
    ["an over-long clientReference", { ...replay, amountUsd: -1, clientReference: "r".repeat(201) }],
    ["a bad state", { ...replay, amountUsd: 0, state: { mode: "historicalReplay", date: "nope" } }],
  ] as const) {
    it(`prefers VALIDATION_ERROR over INVALID_AMOUNT when the body also has ${label}`, () => {
      const result = validateTransactionRequest(body);
      assert.equal(result.ok, false);
      assert.equal(result.ok ? undefined : result.code, "VALIDATION_ERROR");
      // The amount is never named as a schema problem.
      assert.equal(errors(body).some((e) => e.field === "amountUsd"), false);
    });
  }

  it("keeps a non-finite or non-numeric amount a schema problem, not INVALID_AMOUNT", () => {
    for (const amountUsd of ["0", null, Number.NaN, -Infinity, Infinity]) {
      assert.deepEqual(errors({ ...replay, amountUsd }), [{ field: "amountUsd", message: "Must be a finite number." }]);
    }
  });
});

describe("isCalendarDate", () => {
  for (const value of ["2024-06-14", "2024-02-29", "2011-01-01", "2025-09-30", "0001-01-01"]) {
    it(`accepts ${value}`, () => assert.equal(isCalendarDate(value), true));
  }
  for (const value of ["2023-02-29", "2024-04-31", "2024-00-10", "2024-01-00", "2024-1-01", "24-01-01", "2024-01-01 "]) {
    it(`rejects ${JSON.stringify(value)}`, () => assert.equal(isCalendarDate(value), false));
  }
});
