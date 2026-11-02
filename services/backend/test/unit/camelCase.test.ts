import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { camelCaseKey, KeyCollisionError, toCamelCase } from "../../src/mappers/camelCase.js";

describe("camelCaseKey", () => {
  const cases: Array<[string, string]> = [
    ["start", "start"],
    ["gap_buffer_days", "gapBufferDays"],
    ["excluded_ranges", "excludedRanges"],
    ["daily_state_sha256", "dailyStateSha256"],
    ["lambda_latency", "lambdaLatency"],
    ["sha256", "sha256"],
    ["field_2", "field2"],
    ["a__b", "aB"],
    ["_private", "_private"],
    ["trailing_", "trailing_"],
    ["gapBufferDays", "gapBufferDays"],
    ["already_Camel", "alreadyCamel"],
    ["", ""],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      assert.equal(camelCaseKey(input), expected);
    });
  }
});

describe("toCamelCase", () => {
  it("maps the API contract §2.6 calendar shape", () => {
    const engine = {
      start: "2011-01-01",
      end: "2025-09-30",
      splits: {
        train: { start: "2011-01-01", end: "2021-12-31" },
        validation: { start: "2022-01-01", end: "2023-12-31" },
        test: { start: "2024-01-01", end: "2025-09-30" },
      },
      gap_buffer_days: 30,
      excluded_ranges: [{ start: "2011-01-01", end: "2011-01-31" }],
      note: "Synthetic daily bridge state.",
    };
    assert.deepEqual(toCamelCase(engine), {
      start: "2011-01-01",
      end: "2025-09-30",
      splits: {
        train: { start: "2011-01-01", end: "2021-12-31" },
        validation: { start: "2022-01-01", end: "2023-12-31" },
        test: { start: "2024-01-01", end: "2025-09-30" },
      },
      gapBufferDays: 30,
      excludedRanges: [{ start: "2011-01-01", end: "2011-01-31" }],
      note: "Synthetic daily bridge state.",
    });
  });

  it("maps keys inside arrays and nested arrays", () => {
    assert.deepEqual(toCamelCase({ a_list: [[{ inner_key: 1 }], { other_key: [{ deep_key: true }] }] }), {
      aList: [[{ innerKey: 1 }], { otherKey: [{ deepKey: true }] }],
    });
  });

  it("never changes values, including strings with underscores", () => {
    const value = {
      mode: "historical_replay",
      tag: "real_static_bridge",
      bridge_uid: "USA->IND#0",
      number: 0.015,
      flag: false,
      nothing: null,
      list: ["cheapest_feasible", 1, null],
    };
    assert.deepEqual(toCamelCase(value), {
      mode: "historical_replay",
      tag: "real_static_bridge",
      bridgeUid: "USA->IND#0",
      number: 0.015,
      flag: false,
      nothing: null,
      list: ["cheapest_feasible", 1, null],
    });
  });

  it("keeps unknown fields", () => {
    assert.deepEqual(toCamelCase({ start: "x", future_field: { some_value: 1 } }), {
      start: "x",
      futureField: { someValue: 1 },
    });
  });

  it("passes primitives and empty containers through", () => {
    for (const value of ["text", 0, true, null, [], {}]) assert.deepEqual(toCamelCase(value), value);
  });

  it("does not mutate its input", () => {
    const input = { outer_key: { inner_key: [{ leaf_key: 1 }] } };
    const copy = structuredClone(input);
    const output = toCamelCase(input) as { outerKey: { innerKey: Array<{ leafKey: number }> } };
    output.outerKey.innerKey[0]!.leafKey = 99;
    assert.deepEqual(input, copy);
  });

  for (const [label, input] of [
    ["a_b and aB", { a_b: 1, aB: 2 }],
    ["a_b and a__b", { a_b: 1, a__b: 2 }],
    ["a collision inside an array", { list: [{ x_y: 1, xY: 2 }] }],
  ] as const) {
    it(`throws KeyCollisionError for ${label}`, () => {
      assert.throws(() => toCamelCase(input), KeyCollisionError);
    });
  }

  it("keeps a __proto__ key as an ordinary property without changing prototypes", () => {
    const input = JSON.parse('{"__proto__": {"polluted": true}, "ok_key": 1}') as unknown;
    const output = toCamelCase(input) as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(output), Object.prototype);
    assert.ok(Object.hasOwn(output, "__proto__"));
    assert.equal(output.okKey, 1);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});
