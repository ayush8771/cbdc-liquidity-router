import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseTransactionListQuery, parseUtcTimestamp, type FieldError } from "../../src/routes/transactions.js";

const parse = (query: string) => parseTransactionListQuery(new URLSearchParams(query));

function errorsOf(query: string): FieldError[] {
  const result = parse(query);
  assert.equal(result.ok, false, `expected ${JSON.stringify(query)} to be rejected`);
  return result.ok ? [] : result.errors;
}

function fieldsOf(query: string): string[] {
  return errorsOf(query).map((e) => e.field);
}

describe("parseTransactionListQuery", () => {
  it("uses the documented defaults", () => {
    assert.deepEqual(parse(""), { ok: true, query: { page: 1, pageSize: 20, filters: {} } });
  });

  it("accepts every documented parameter", () => {
    const result = parse(
      "page=3&pageSize=100&corridor=GBR-%3EPHL&policy=cheapestFeasible&stateMode=scenario&completed=false" +
        "&from=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00.5Z&sort=createdAt:desc",
    );
    assert.deepEqual(result, {
      ok: true,
      query: {
        page: 3,
        pageSize: 100,
        filters: {
          corridor: "GBR->PHL",
          policy: "cheapestFeasible",
          stateMode: "scenario",
          completed: false,
          from: new Date("2026-11-01T00:00:00.000Z"),
          to: new Date("2026-11-02T00:00:00.500Z"),
        },
      },
    });
  });

  for (const [name, values] of [
    ["corridor", ["USA->IND", "GBR->PHL", "ARE->MEX"]],
    ["policy", ["waterfall", "cheapestFeasible", "ppoProjected"]],
    ["stateMode", ["historicalReplay", "scenario", "explicit"]],
  ] as const) {
    for (const value of values) {
      it(`accepts ${name}=${value}`, () => {
        const result = parse(new URLSearchParams({ [name]: value }).toString());
        assert.ok(result.ok);
        assert.equal((result.query.filters as Record<string, unknown>)[name], value);
      });
    }
  }

  it("maps completed=true and completed=false to booleans", () => {
    const yes = parse("completed=true");
    const no = parse("completed=false");
    assert.ok(yes.ok && no.ok);
    assert.equal(yes.query.filters.completed, true);
    assert.equal(no.query.filters.completed, false);
  });

  for (const value of ["0", "-1", "1.5", "abc", "", " 1", "1e2", "01", "+1", "9007199254740993"]) {
    it(`rejects page=${JSON.stringify(value)} and pageSize=${JSON.stringify(value)}`, () => {
      assert.deepEqual(fieldsOf(`page=${encodeURIComponent(value)}`), ["page"]);
      assert.deepEqual(fieldsOf(`pageSize=${encodeURIComponent(value)}`), ["pageSize"]);
    });
  }

  it("accepts pageSize 1 and 100 and rejects 101", () => {
    assert.ok(parse("pageSize=1").ok);
    assert.ok(parse("pageSize=100").ok);
    assert.deepEqual(errorsOf("pageSize=101"), [{ field: "pageSize", message: "Must be at most 100." }]);
  });

  it("rejects a page whose row offset isn't exact", () => {
    assert.deepEqual(fieldsOf("page=9007199254740991&pageSize=100"), ["page"]);
  });

  for (const [name, value] of [
    ["corridor", "USA-IND"],
    ["corridor", "usa->ind"],
    ["policy", "cheapest_feasible"],
    ["policy", "Waterfall"],
    ["stateMode", "historical_replay"],
    ["completed", "1"],
    ["completed", "TRUE"],
    ["completed", ""],
    ["sort", "createdAt:asc"],
    ["sort", "createdAt"],
    ["sort", "amountUsd:desc"],
    ["sort", ""],
  ] as const) {
    it(`rejects ${name}=${JSON.stringify(value)}`, () => {
      assert.deepEqual(fieldsOf(new URLSearchParams({ [name]: value }).toString()), [name]);
    });
  }

  it("accepts sort=createdAt:desc", () => {
    assert.deepEqual(parse("sort=createdAt:desc"), parse(""));
  });

  for (const name of ["page", "pageSize", "corridor", "policy", "stateMode", "completed", "from", "to", "sort"]) {
    it(`rejects ${name} given twice`, () => {
      const value = { page: "1", pageSize: "1", corridor: "USA->IND", policy: "waterfall", stateMode: "explicit",
        completed: "true", from: "2026-01-01T00:00:00Z", to: "2026-01-01T00:00:00Z", sort: "createdAt:desc" }[name]!;
      const query = new URLSearchParams([[name, value], [name, value]]).toString();
      assert.deepEqual(errorsOf(query), [{ field: name, message: "Must be given at most once." }]);
    });
  }

  it("ignores unknown parameters, even repeated ones", () => {
    assert.deepEqual(parse("foo=1&foo=2&Page=0&token=abc"), parse(""));
  });

  it("accepts from equal to to (an empty range), and rejects from later than to", () => {
    assert.ok(parse("from=2026-11-02T00:00:00Z&to=2026-11-02T00:00:00Z").ok);
    assert.deepEqual(errorsOf("from=2026-11-02T00:00:00.001Z&to=2026-11-02T00:00:00Z"), [
      { field: "from", message: "Must not be later than to." },
    ]);
  });

  it("accepts only one of from or to", () => {
    const onlyFrom = parse("from=2026-11-02T00:00:00Z");
    const onlyTo = parse("to=2026-11-02T00:00:00Z");
    assert.ok(onlyFrom.ok && onlyTo.ok);
    assert.deepEqual(onlyFrom.query.filters, { from: new Date("2026-11-02T00:00:00Z") });
    assert.deepEqual(onlyTo.query.filters, { to: new Date("2026-11-02T00:00:00Z") });
  });

  it("reports every problem at once", () => {
    assert.deepEqual(fieldsOf("page=0&pageSize=500&policy=x&from=bad&sort=x"), ["page", "pageSize", "policy", "from", "sort"]);
  });
});

describe("parseUtcTimestamp", () => {
  for (const [value, iso] of [
    ["2026-11-02T10:00:00Z", "2026-11-02T10:00:00.000Z"],
    ["2026-11-02T10:00:00.1Z", "2026-11-02T10:00:00.100Z"],
    ["2026-11-02T10:00:00.12Z", "2026-11-02T10:00:00.120Z"],
    ["2026-11-02T10:00:00.123Z", "2026-11-02T10:00:00.123Z"],
    ["2024-02-29T23:59:59Z", "2024-02-29T23:59:59.000Z"],
    ["0001-01-01T00:00:00Z", "0001-01-01T00:00:00.000Z"],
  ] as const) {
    it(`accepts ${value}`, () => {
      assert.equal(parseUtcTimestamp(value)?.toISOString(), iso);
    });
  }

  for (const value of [
    "2026-11-02",
    "2026-11-02T10:00Z",
    "2026-11-02T10:00:00",
    "2026-11-02T10:00:00z",
    "2026-11-02 10:00:00Z",
    "2026-11-02T10:00:00+00:00",
    "2026-11-02T10:00:00+05:30",
    "2026-11-02T10:00:00.1234Z",
    "2026-11-02T10:00:00.Z",
    "2025-02-29T00:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-13-01T00:00:00Z",
    "2026-11-02T24:00:00Z",
    "2026-11-02T10:60:00Z",
    "2026-11-02T10:00:60Z",
    "1762077600000",
    "",
  ]) {
    it(`rejects ${JSON.stringify(value)}`, () => {
      assert.equal(parseUtcTimestamp(value), undefined);
    });
  }
});
