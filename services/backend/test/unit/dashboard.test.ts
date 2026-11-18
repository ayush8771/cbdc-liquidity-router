import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Prisma, type PrismaClient } from "@prisma/client";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import {
  createPrismaDashboardRepository,
  dashboardWhere,
  type DashboardAggregates,
  type DashboardFilters,
  type DashboardPolicyRow,
  type DashboardRepository,
} from "../../src/db/dashboard.js";
import type { InferenceClient } from "../../src/inferenceClient/client.js";
import {
  DASHBOARD_NOTE,
  completionRate,
  parseDashboardQuery,
  toDashboardSummary,
} from "../../src/routes/dashboard.js";
import { VALIDATION_ERROR_MESSAGE } from "../../src/validation/transactionRequest.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// GET /api/v1/dashboard/summary (API contract §3.8). PostgreSQL behaviour is
// covered by test/integration/transactions.test.ts.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const PATH = "/api/v1/dashboard/summary";

const EMPTY: DashboardAggregates = {
  totals: { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 },
  byPolicy: [],
  byCorridor: [],
};

function policyRow(policy: DashboardPolicyRow["policy"], overrides: Partial<DashboardPolicyRow> = {}): DashboardPolicyRow {
  return {
    policy,
    count: 1,
    allowedRouted: 1,
    completedAllowedRouted: 1,
    meanRewardAmountBased: -0.25,
    meanFeeCostPct: 1.5,
    meanLatencyTerm: 0.2,
    meanRiskTerm: 0.0,
    ...overrides,
  };
}

/** A repository that records each filter set and answers with fixed aggregates. */
function fakeRepository(answer: DashboardAggregates | Error = EMPTY) {
  const calls: DashboardFilters[] = [];
  const repository: DashboardRepository = {
    async summary(filters) {
      calls.push(filters);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
  return { repository, calls };
}

/** An inference client that records any use; the dashboard must never call it. */
function trapInference() {
  const used: string[] = [];
  const fail = (name: string) => () => {
    used.push(name);
    throw new Error(`inference ${name} called`);
  };
  const client = { mode: "live", get: fail("get"), post: fail("post"), health: fail("health") };
  return { client: client as unknown as InferenceClient, used };
}

async function request(
  dashboard: DashboardRepository | undefined,
  path = PATH,
  init: { method?: string; headers?: Record<string, string> } = { headers: auth(viewerToken) },
  options: { logger?: typeof silentLogger; inferenceClient?: InferenceClient } = {},
): Promise<{ status: number; headers: Headers; text: string; body: Record<string, unknown> | undefined }> {
  const server = await startServer(
    createApp({ logger: options.logger ?? silentLogger, users, dashboard, inferenceClient: options.inferenceClient }),
  );
  try {
    const res = await fetch(`${server.baseUrl}${path}`, init);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, body: text === "" ? undefined : JSON.parse(text) };
  } finally {
    await server.close();
  }
}

describe("parseDashboardQuery", () => {
  const parse = (query: string) => parseDashboardQuery(new URLSearchParams(query));

  it("accepts no parameters: no filters, both window bounds null (unbounded)", () => {
    assert.deepEqual(parse(""), { ok: true, query: { filters: {}, window: { from: null, to: null } } });
  });

  it("parses every documented parameter and echoes from and to exactly as sent", () => {
    const result = parse("from=2026-11-01T00:00:00Z&to=2026-11-02T23:59:59.5Z&corridor=GBR->PHL&policy=ppoProjected");
    assert.deepEqual(result, {
      ok: true,
      query: {
        filters: {
          from: new Date("2026-11-01T00:00:00Z"),
          to: new Date("2026-11-02T23:59:59.500Z"),
          corridor: "GBR->PHL",
          policy: "ppoProjected",
        },
        window: { from: "2026-11-01T00:00:00Z", to: "2026-11-02T23:59:59.5Z" },
      },
    });
  });

  it("keeps an omitted bound null while echoing the other", () => {
    const onlyFrom = parse("from=2026-11-01T00:00:00Z");
    assert.ok(onlyFrom.ok);
    assert.deepEqual(onlyFrom.query.window, { from: "2026-11-01T00:00:00Z", to: null });
    assert.deepEqual(onlyFrom.query.filters, { from: new Date("2026-11-01T00:00:00Z") });
    const onlyTo = parse("to=2026-11-02T00:00:00Z");
    assert.ok(onlyTo.ok);
    assert.deepEqual(onlyTo.query.window, { from: null, to: "2026-11-02T00:00:00Z" });
    assert.deepEqual(onlyTo.query.filters, { to: new Date("2026-11-02T00:00:00Z") });
  });

  it("accepts from equal to to (an empty window), but not from later than to", () => {
    assert.equal(parse("from=2026-11-01T00:00:00Z&to=2026-11-01T00:00:00Z").ok, true);
    assert.deepEqual(parse("from=2026-11-01T00:00:00.001Z&to=2026-11-01T00:00:00Z"), {
      ok: false,
      errors: [{ field: "from", message: "Must not be later than to." }],
    });
  });

  for (const bad of ["2026-11-01", "2026-11-01T00:00:00+01:00", "2026-11-01T00:00:00", "2026-02-30T00:00:00Z", "2026-11-01T00:00:00.1234Z", ""]) {
    it(`rejects from=${JSON.stringify(bad)} as not an ISO 8601 UTC timestamp`, () => {
      assert.deepEqual(parse(`from=${encodeURIComponent(bad)}`), {
        ok: false,
        errors: [{ field: "from", message: "Must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z." }],
      });
    });
  }

  it("accepts every documented corridor and policy, and rejects other spellings", () => {
    for (const corridor of ["USA->IND", "GBR->PHL", "ARE->MEX"]) assert.equal(parse(`corridor=${corridor}`).ok, true);
    for (const policy of ["waterfall", "cheapestFeasible", "ppoProjected"]) assert.equal(parse(`policy=${policy}`).ok, true);
    assert.deepEqual(parse("corridor=GBR-PHL&policy=ppo_projected"), {
      ok: false,
      errors: [
        { field: "corridor", message: "Must be one of: USA->IND, GBR->PHL, ARE->MEX." },
        { field: "policy", message: "Must be one of: waterfall, cheapestFeasible, ppoProjected." },
      ],
    });
  });

  it("rejects a documented parameter given twice, and reports every problem at once", () => {
    const result = parse("from=x&to=2026-11-01T00:00:00Z&to=2026-11-02T00:00:00Z&policy=a&policy=b&corridor=nope");
    assert.deepEqual(result, {
      ok: false,
      errors: [
        { field: "to", message: "Must be given at most once." },
        { field: "policy", message: "Must be given at most once." },
        { field: "from", message: "Must be an ISO 8601 UTC timestamp, e.g. 2026-11-02T10:00:00Z." },
        { field: "corridor", message: "Must be one of: USA->IND, GBR->PHL, ARE->MEX." },
      ],
    });
  });

  it("ignores unknown parameters, including the history list's own", () => {
    assert.deepEqual(parse("page=0&status=failed&stateMode=bad&completed=maybe&x=1"), {
      ok: true,
      query: { filters: {}, window: { from: null, to: null } },
    });
  });
});

describe("completionRate (§3.8)", () => {
  it("is completed allowed routed / allowed routed", () => {
    assert.equal(completionRate(2, 3), 2 / 3);
    assert.equal(completionRate(0, 4), 0);
    assert.equal(completionRate(5, 5), 1);
  });

  it("is null when there are no allowed routed decisions", () => {
    assert.equal(completionRate(0, 0), null);
  });
});

describe("toDashboardSummary", () => {
  const window = { from: null, to: null };

  it("returns exactly window, totals, byPolicy, byCorridor and note, in that order", () => {
    const body = toDashboardSummary(window, {
      totals: { transactions: 3, routed: 2, failed: 1, rejectedByFeasibility: 1 },
      byPolicy: [policyRow("waterfall")],
      byCorridor: [{ corridor: "GBR->PHL", routed: 2, allowedRouted: 1, completedAllowedRouted: 1 }],
    });
    assert.deepEqual(Object.keys(body), ["window", "totals", "byPolicy", "byCorridor", "note"]);
    assert.deepEqual(Object.keys(body.window as object), ["from", "to"]);
    assert.deepEqual(Object.keys(body.totals as object), ["transactions", "routed", "failed", "rejectedByFeasibility"]);
    assert.deepEqual(Object.keys((body.byPolicy as object[])[0]!), [
      "policy",
      "count",
      "allowedRouted",
      "completionRate",
      "meanRewardAmountBased",
      "meanFeeCostPct",
      "meanLatencyTerm",
      "meanRiskTerm",
    ]);
    assert.deepEqual(Object.keys((body.byCorridor as object[])[0]!), ["corridor", "routed", "allowedRouted", "completionRate"]);
    assert.equal(body.note, DASHBOARD_NOTE);
  });

  it("uses the §3.8 note verbatim", () => {
    assert.equal(
      DASHBOARD_NOTE,
      "Aggregates of independent what-if decisions on synthetic states, under placeholder reward weights. Transactions do not consume liquidity. Not a backtest.",
    );
  });

  it("returns zero totals, empty groups and null bounds for an empty database", () => {
    assert.deepEqual(toDashboardSummary(window, EMPTY), {
      window: { from: null, to: null },
      totals: { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 },
      byPolicy: [],
      byCorridor: [],
      note: DASHBOARD_NOTE,
    });
  });

  it("gives null completionRate and passes null means through for a group with no allowed routed decision", () => {
    const body = toDashboardSummary(window, {
      totals: { transactions: 2, routed: 1, failed: 1, rejectedByFeasibility: 1 },
      byPolicy: [
        policyRow("cheapestFeasible", {
          count: 2,
          allowedRouted: 0,
          completedAllowedRouted: 0,
          meanRewardAmountBased: null,
          meanFeeCostPct: null,
          meanLatencyTerm: null,
          meanRiskTerm: null,
        }),
      ],
      byCorridor: [{ corridor: "USA->IND", routed: 1, allowedRouted: 0, completedAllowedRouted: 0 }],
    });
    assert.deepEqual(body.byPolicy, [
      {
        policy: "cheapestFeasible",
        count: 2,
        allowedRouted: 0,
        completionRate: null,
        meanRewardAmountBased: null,
        meanFeeCostPct: null,
        meanLatencyTerm: null,
        meanRiskTerm: null,
      },
    ]);
    assert.deepEqual(body.byCorridor, [{ corridor: "USA->IND", routed: 1, allowedRouted: 0, completionRate: null }]);
  });

  it("keeps a null meanFeeCostPct beside non-null means (no allowed decision executed anything)", () => {
    const body = toDashboardSummary(window, { ...EMPTY, byPolicy: [policyRow("waterfall", { meanFeeCostPct: null })] });
    const [item] = body.byPolicy as Array<Record<string, unknown>>;
    assert.equal(item!.meanFeeCostPct, null);
    assert.equal(item!.meanRewardAmountBased, -0.25);
    assert.equal(item!.completionRate, 1);
  });

  it("does not round", () => {
    const body = toDashboardSummary(window, {
      ...EMPTY,
      byPolicy: [policyRow("waterfall", { allowedRouted: 3, completedAllowedRouted: 2, meanLatencyTerm: 0.1234567891234 })],
    });
    const [item] = body.byPolicy as Array<Record<string, unknown>>;
    assert.equal(item!.completionRate, 2 / 3);
    assert.equal(item!.meanLatencyTerm, 0.1234567891234);
  });

  it("orders byPolicy by the §1 enum order and byCorridor by corridor, whatever the database order", () => {
    const body = toDashboardSummary(window, {
      ...EMPTY,
      byPolicy: [policyRow("ppoProjected"), policyRow("waterfall"), policyRow("cheapestFeasible")],
      byCorridor: [
        { corridor: "USA->IND", routed: 1, allowedRouted: 1, completedAllowedRouted: 1 },
        { corridor: "ARE->MEX", routed: 1, allowedRouted: 1, completedAllowedRouted: 1 },
        { corridor: "GBR->PHL", routed: 1, allowedRouted: 1, completedAllowedRouted: 1 },
      ],
    });
    assert.deepEqual((body.byPolicy as Array<{ policy: string }>).map((p) => p.policy), ["waterfall", "cheapestFeasible", "ppoProjected"]);
    assert.deepEqual((body.byCorridor as Array<{ corridor: string }>).map((c) => c.corridor), ["ARE->MEX", "GBR->PHL", "USA->IND"]);
  });

  it("reproduces the contract fixture app/dashboard/200_summary.json from its aggregates", () => {
    const fixture = JSON.parse(
      readFileSync(new URL("../../../../contracts/fixtures/app/dashboard/200_summary.json", import.meta.url), "utf8"),
    ) as { request: { query: { from: string; to: string } }; response: { body: Record<string, unknown> } };
    const want = fixture.response.body;
    // Counts derived from the fixture (§3.8): waterfall 2 of 3 allowed completed,
    // cheapestFeasible 0 of 1, ppoProjected 1 of 1; GBR->PHL 2 of 4, ARE->MEX 1 of 1.
    const got = toDashboardSummary(fixture.request.query, {
      totals: { transactions: 7, routed: 6, failed: 1, rejectedByFeasibility: 1 },
      byPolicy: [
        policyRow("waterfall", { count: 5, allowedRouted: 3, completedAllowedRouted: 2, meanRewardAmountBased: -0.251407, meanFeeCostPct: 1.563333, meanLatencyTerm: 0.257083, meanRiskTerm: 0 }),
        policyRow("cheapestFeasible", { count: 1, allowedRouted: 1, completedAllowedRouted: 0, meanRewardAmountBased: -0.5864, meanFeeCostPct: 1.4, meanLatencyTerm: 0.11, meanRiskTerm: 0 }),
        policyRow("ppoProjected", { count: 1, allowedRouted: 1, completedAllowedRouted: 1, meanRewardAmountBased: -0.28588, meanFeeCostPct: 2.071333, meanLatencyTerm: 0.326367, meanRiskTerm: 0 }),
      ],
      byCorridor: [
        { corridor: "GBR->PHL", routed: 5, allowedRouted: 4, completedAllowedRouted: 2 },
        { corridor: "ARE->MEX", routed: 1, allowedRouted: 1, completedAllowedRouted: 1 },
      ],
    });
    // Same keys everywhere; numbers equal to the fixture's 6-decimal values.
    const close = (a: unknown, b: unknown, path: string): void => {
      if (typeof a === "number" && typeof b === "number") {
        assert.ok(Math.abs(a - b) < 1e-6, `${path}: ${a} vs ${b}`);
      } else if (a !== null && typeof a === "object") {
        assert.deepEqual(Object.keys(a), Object.keys(b as object), path);
        for (const key of Object.keys(a)) close((a as never)[key], (b as never)[key], `${path}.${key}`);
      } else {
        assert.equal(a, b, path);
      }
    };
    close(got, want, "body");
  });
});

describe("Prisma dashboard repository", () => {
  /** Records the SQL Prisma would send; answers each query in order. */
  function fakePrisma(answers: unknown[][] = [[{ transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 }], [], []]) {
    const queries: Prisma.Sql[] = [];
    const calls: { ops?: unknown[]; options?: unknown } = {};
    const client = {
      $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
        const sql = Prisma.sql(strings, ...values);
        queries.push(sql);
        return { op: queries.length - 1 };
      },
      async $transaction(ops: unknown[], options: unknown) {
        calls.ops = ops;
        calls.options = options;
        return answers;
      },
    };
    return { client: client as unknown as PrismaClient, queries, calls };
  }
  const squash = (sql: string) => sql.replace(/\s+/g, " ");

  it("runs the totals, byPolicy and byCorridor queries in one REPEATABLE READ transaction", async () => {
    const totals = { transactions: 3, routed: 2, failed: 1, rejectedByFeasibility: 0 };
    const byPolicy = [policyRow("waterfall")];
    const byCorridor = [{ corridor: "GBR->PHL", routed: 2, allowedRouted: 2, completedAllowedRouted: 1 }];
    const { client, queries, calls } = fakePrisma([[totals], byPolicy, byCorridor]);
    const result = await createPrismaDashboardRepository(client).summary({});
    assert.deepEqual(result, { totals, byPolicy, byCorridor });
    assert.equal(queries.length, 3);
    assert.deepEqual(calls.ops, [{ op: 0 }, { op: 1 }, { op: 2 }]);
    assert.deepEqual(calls.options, { isolationLevel: "RepeatableRead" });
  });

  it("aggregates in SQL with the §3.8 populations and formulas", async () => {
    const { client, queries } = fakePrisma();
    await createPrismaDashboardRepository(client).summary({});
    const [totals, byPolicy, byCorridor] = queries.map((q) => squash(q.sql));
    const allowedRouted = `t."status" = 'routed' AND d."allowed" IS TRUE`;
    // Totals: every transaction; failed by status; rejected = routed with allowed false.
    assert.match(totals!, /COUNT\(\*\)::integer AS "transactions"/);
    assert.ok(totals!.includes(`(COUNT(*) FILTER (WHERE t."status" = 'routed'))::integer AS "routed"`));
    assert.ok(totals!.includes(`(COUNT(*) FILTER (WHERE t."status" = 'failed'))::integer AS "failed"`));
    assert.ok(totals!.includes(`(COUNT(*) FILTER (WHERE t."status" = 'routed' AND d."allowed" IS FALSE))::integer AS "rejectedByFeasibility"`));
    // byPolicy: grouped by the requested policy; count is every row in the group.
    assert.match(byPolicy!, /GROUP BY t\."requestedPolicy"$/);
    assert.ok(byPolicy!.includes(`COUNT(*)::integer AS "count"`));
    assert.ok(byPolicy!.includes(`(COUNT(*) FILTER (WHERE ${allowedRouted}))::integer AS "allowedRouted"`));
    assert.ok(byPolicy!.includes(`(COUNT(*) FILTER (WHERE ${allowedRouted} AND d."completed" IS TRUE))::integer AS "completedAllowedRouted"`));
    for (const [column, alias] of [["rewardAmountBased", "meanRewardAmountBased"], ["latencyTerm", "meanLatencyTerm"], ["riskTerm", "meanRiskTerm"]]) {
      assert.ok(byPolicy!.includes(`AVG(d."${column}") FILTER (WHERE ${allowedRouted}) AS "${alias}"`), alias);
    }
    assert.ok(
      byPolicy!.includes(`100 * AVG(d."feeCostUsd" / d."executedUsd") FILTER (WHERE ${allowedRouted} AND d."executedUsd" > 0) AS "meanFeeCostPct"`),
    );
    // byCorridor: routed rows only, grouped by the stored corridor.
    assert.ok(byCorridor!.includes(`AND t."status" = 'routed' AND t."corridor" IS NOT NULL GROUP BY t."corridor"`));
    assert.ok(byCorridor!.includes(`COUNT(*)::integer AS "routed"`));
    assert.ok(byCorridor!.includes(`(COUNT(*) FILTER (WHERE d."allowed" IS TRUE))::integer AS "allowedRouted"`));
    // Every query reads the transactions with their (optional) decisions, never allocations or comparisons.
    for (const sql of [totals, byPolicy, byCorridor]) {
      assert.ok(sql!.includes(`FROM "TransactionRequest" t LEFT JOIN "RoutingDecision" d ON d."transactionId" = t."id"`));
      assert.ok(!/Allocation|Comparison|engineResponse/.test(sql!));
    }
  });

  it("applies the same filters, as bound parameters, to every query", async () => {
    const filters: DashboardFilters = {
      from: new Date("2026-11-01T00:00:00Z"),
      to: new Date("2026-11-02T00:00:00.5Z"),
      corridor: "GBR->PHL",
      policy: "waterfall",
    };
    const { client, queries } = fakePrisma();
    await createPrismaDashboardRepository(client).summary(filters);
    for (const query of queries) {
      const sql = squash(query.text);
      assert.ok(sql.includes(`t."createdAt" >= CAST($1 AS timestamptz)`), sql);
      assert.ok(sql.includes(`t."createdAt" < CAST($2 AS timestamptz)`), sql);
      assert.ok(sql.includes(`t."corridor" = $3`), sql);
      assert.ok(sql.includes(`t."requestedPolicy" = CAST($4 AS "Policy")`), sql);
      assert.deepEqual(query.values, ["2026-11-01T00:00:00.000Z", "2026-11-02T00:00:00.500Z", "GBR->PHL", "waterfall"]);
    }
  });

  it("adds no condition for omitted filters", () => {
    const where = dashboardWhere({});
    assert.equal(where.sql, "TRUE");
    assert.deepEqual(where.values, []);
  });

  it("falls back to zero totals if the totals query returns no row", async () => {
    const { client } = fakePrisma([[], [], []]);
    assert.deepEqual(await createPrismaDashboardRepository(client).summary({}), EMPTY);
  });
});

describe("GET /api/v1/dashboard/summary", () => {
  it("returns 401 UNAUTHENTICATED without a token, or with an unknown one, without reading the database", async () => {
    const { repository, calls } = fakeRepository();
    for (const headers of [{}, auth(newToken()), { Authorization: "Bearer mock-viewer" }]) {
      const res = await request(repository, PATH, { headers });
      assert.equal(res.status, 401);
      assert.equal((res.body!.error as { code: string }).code, "UNAUTHENTICATED");
    }
    assert.equal(calls.length, 0);
  });

  for (const [role, token] of [["viewer", viewerToken], ["analyst", analystToken]] as const) {
    it(`returns 200 with the summary to a ${role}`, async () => {
      const { repository, calls } = fakeRepository({
        totals: { transactions: 1, routed: 1, failed: 0, rejectedByFeasibility: 0 },
        byPolicy: [policyRow("ppoProjected")],
        byCorridor: [{ corridor: "GBR->PHL", routed: 1, allowedRouted: 1, completedAllowedRouted: 1 }],
      });
      const res = await request(repository, PATH, { headers: { ...auth(token), "X-Request-Id": "dash-1" } });
      assert.equal(res.status, 200, res.text);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json; charset=utf-8/);
      assert.equal(res.headers.get("x-request-id"), "dash-1");
      assert.deepEqual(res.body, {
        window: { from: null, to: null },
        totals: { transactions: 1, routed: 1, failed: 0, rejectedByFeasibility: 0 },
        byPolicy: [
          {
            policy: "ppoProjected",
            count: 1,
            allowedRouted: 1,
            completionRate: 1,
            meanRewardAmountBased: -0.25,
            meanFeeCostPct: 1.5,
            meanLatencyTerm: 0.2,
            meanRiskTerm: 0,
          },
        ],
        byCorridor: [{ corridor: "GBR->PHL", routed: 1, allowedRouted: 1, completionRate: 1 }],
        note: DASHBOARD_NOTE,
      });
      assert.deepEqual(calls, [{}]);
    });
  }

  it("returns the empty summary when the database has nothing in the window", async () => {
    const { repository } = fakeRepository();
    const res = await request(repository, `${PATH}?from=2030-01-01T00:00:00Z`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      window: { from: "2030-01-01T00:00:00Z", to: null },
      totals: { transactions: 0, routed: 0, failed: 0, rejectedByFeasibility: 0 },
      byPolicy: [],
      byCorridor: [],
      note: DASHBOARD_NOTE,
    });
  });

  it("passes the parsed filters to the repository and echoes the window as sent", async () => {
    const { repository, calls } = fakeRepository();
    const res = await request(
      repository,
      `${PATH}?from=2026-11-01T00:00:00Z&to=2026-11-02T23:59:59Z&corridor=GBR-%3EPHL&policy=waterfall&unknown=1`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body!.window, { from: "2026-11-01T00:00:00Z", to: "2026-11-02T23:59:59Z" });
    assert.deepEqual(calls, [
      { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-02T23:59:59Z"), corridor: "GBR->PHL", policy: "waterfall" },
    ]);
  });

  it("returns 422 VALIDATION_ERROR with every problem, without reading the database", async () => {
    const { repository, calls } = fakeRepository();
    const res = await request(
      repository,
      `${PATH}?from=2026-11-03T00:00:00Z&to=2026-11-02T00:00:00Z&policy=ppo_projected&corridor=X`,
      { headers: { ...auth(viewerToken), "X-Request-Id": "dash-422" } },
    );
    assert.equal(res.status, 422);
    assert.deepEqual(res.body, {
      error: {
        code: "VALIDATION_ERROR",
        message: VALIDATION_ERROR_MESSAGE,
        details: {
          errors: [
            { field: "corridor", message: "Must be one of: USA->IND, GBR->PHL, ARE->MEX." },
            { field: "policy", message: "Must be one of: waterfall, cheapestFeasible, ppoProjected." },
            { field: "from", message: "Must not be later than to." },
          ],
        },
        requestId: "dash-422",
      },
    });
    assert.equal(calls.length, 0);
  });

  it("validates before checking the database configuration", async () => {
    const res = await request(undefined, `${PATH}?policy=x`);
    assert.equal(res.status, 422);
  });

  it("returns 500 INTERNAL_ERROR without DATABASE_URL", async () => {
    const res = await request(undefined);
    assert.equal(res.status, 500);
    assert.equal((res.body!.error as { code: string }).code, "INTERNAL_ERROR");
  });

  it("returns 500 INTERNAL_ERROR on a database error, without leaking it", async () => {
    const capture = captureLogger();
    const { repository } = fakeRepository(new Error("connection refused: secret-host"));
    const res = await request(repository, PATH, { headers: auth(viewerToken) }, { logger: capture.logger });
    assert.equal(res.status, 500);
    assert.deepEqual((res.body!.error as Record<string, unknown>).code, "INTERNAL_ERROR");
    assert.ok(!res.text.includes("secret-host"));
  });

  it("never calls inference", async () => {
    const trap = trapInference();
    const { repository } = fakeRepository();
    for (const query of ["", "?policy=waterfall", "?policy=bad"]) {
      await request(repository, `${PATH}${query}`, { headers: auth(analystToken) }, { inferenceClient: trap.client });
    }
    assert.deepEqual(trap.used, []);
  });

  it("answers HEAD with the GET route: 200, no body, same auth", async () => {
    const { repository, calls } = fakeRepository();
    const ok = await request(repository, PATH, { method: "HEAD", headers: auth(viewerToken) });
    assert.equal(ok.status, 200);
    assert.equal(ok.text, "");
    const unauthenticated = await request(repository, PATH, { method: "HEAD" });
    assert.equal(unauthenticated.status, 401);
    assert.equal(calls.length, 1);
  });

  for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
    it(`${method} returns 401 without a token and 405 METHOD_NOT_ALLOWED with Allow: GET, HEAD with one (§10 Q14)`, async () => {
      const { repository, calls } = fakeRepository();
      const anon = await request(repository, PATH, { method, headers: { "X-Request-Id": "dash-405" } });
      assert.equal(anon.status, 401);
      assert.equal(anon.headers.get("allow"), null);
      const res = await request(repository, PATH, {
        method,
        headers: { "X-Request-Id": "dash-405", ...auth(viewerToken) },
      });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "GET, HEAD");
      assert.deepEqual(res.body, {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: `Method ${method} is not allowed on /api/v1/dashboard/summary.`,
          details: {},
          requestId: "dash-405",
        },
      });
      assert.equal(calls.length, 0);
    });
  }

  it("returns 404 for paths under it that are not registered", async () => {
    const res = await request(fakeRepository().repository, "/api/v1/dashboard", { headers: auth(viewerToken) });
    assert.equal(res.status, 404);
  });
});
