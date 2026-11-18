import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { createApp } from "../../src/app.js";
import type { DevUser } from "../../src/config/devTokens.js";
import {
  createInferenceClient,
  type InferenceRequest,
  type JsonObject,
  type MockResponse,
} from "../../src/inferenceClient/client.js";
import { mapStateResponse } from "../../src/mappers/stateResponse.js";
import { parseStateQuery } from "../../src/routes/state.js";
import { newToken, sha256Hex } from "../helpers/devTokens.js";
import { captureLogger, silentLogger, startServer } from "../helpers/server.js";

// GET /api/v1/state (API contract §3.7, §2.5). Inference answers come from
// test mock handlers: no network. The inference contract fixtures are read
// only, as inputs; the expected app bodies are written out field by field
// here, independently of the camelCase mapper.

const analystToken = newToken();
const viewerToken = newToken();
const users: DevUser[] = [
  { userId: "u-analyst-1", email: "analyst@example.test", role: "analyst", tokenSha256: sha256Hex(analystToken) },
  { userId: "u-viewer-1", email: "viewer@example.test", role: "viewer", tokenSha256: sha256Hex(viewerToken) },
];
const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

function fixture(name: string): { query: Record<string, string>; body: JsonObject } {
  const url = new URL(`../../../../contracts/fixtures/inference/state/${name}`, import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf8")) as {
    request: { query: Record<string, string> };
    response: { body: JsonObject };
  };
  return { query: parsed.request.query, body: parsed.response.body };
}

const REPLAY = fixture("200_replay_gbr_phl.json");
const SCENARIO = fixture("200_scenario_outage_with_history.json");

const REPLAY_PATH = "/api/v1/state?corridor=GBR-%3EPHL&mode=historicalReplay&date=2024-06-14";
const SCENARIO_PATH =
  "/api/v1/state?corridor=GBR-%3EPHL&mode=scenario&date=2024-06-14&scenarioId=cheapest_venue_outage&includeHistory=true";

// The §3.7 app body for a §2.5 body, written per documented field.
type Venue = Record<string, any>;
function expectedApp(engine: Record<string, any>): Record<string, any> {
  return {
    corridor: engine.corridor,
    state: {
      mode: engine.state.mode === "historical_replay" ? "historicalReplay" : engine.state.mode,
      date: engine.state.date,
      split: engine.state.split,
      scenarioId: engine.state.scenario_id,
    },
    corridorRisk: engine.corridor_risk,
    baselineCostPct: engine.baseline_cost_pct,
    venues: (engine.venues as Venue[]).map((v) => ({
      slot: v.slot,
      bridgeUid: v.bridge_uid,
      feePct: v.fee_pct,
      liquidityUsd: v.liquidity_usd,
      congestion: v.congestion,
      dataSourceTag: v.data_source_tag,
      valuesProvenance: v.values_provenance,
      ...(v.history !== undefined && {
        history: { dates: v.history.dates, liquidityUsd: v.history.liquidity_usd, congestion: v.history.congestion },
      }),
    })),
    warnings: engine.warnings,
  };
}

/** A mock-mode client (test handler, not fixtures) that records every request. */
function mockClient(answer: () => MockResponse | undefined) {
  const calls: InferenceRequest[] = [];
  const client = createInferenceClient(
    { url: "http://inference.invalid", mode: "mock", timeoutMs: 1000 },
    {
      logger: silentLogger,
      mockHandler: (request) => {
        calls.push(request as InferenceRequest);
        return request.path === "/v1/state" ? answer() : undefined;
      },
    },
  );
  return { client, calls };
}
const okWith = (body: unknown) => () => ({ status: 200, body });

interface Res {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, any> | undefined;
}

async function withApp<T>(
  options: Parameters<typeof createApp>[0],
  run: (get: (path: string, init?: { headers?: Record<string, string>; method?: string }) => Promise<Res>) => Promise<T>,
): Promise<T> {
  const server = await startServer(createApp({ logger: silentLogger, users, ...options }));
  try {
    return await run(async (path, init = {}) => {
      const res = await fetch(`${server.baseUrl}${path}`, {
        method: init.method ?? "GET",
        headers: init.headers ?? auth(viewerToken),
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, text, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
    });
  } finally {
    await server.close();
  }
}

/** One request against a fresh app whose inference answers with `answer`. */
async function request(path: string, answer: () => MockResponse | undefined = okWith(REPLAY.body), headers?: Record<string, string>) {
  const { client, calls } = mockClient(answer);
  const res = await withApp({ inferenceClient: client }, (get) => get(path, headers === undefined ? {} : { headers }));
  return { res, calls };
}

const q = (params: Record<string, string | string[]>) => {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    for (const v of Array.isArray(value) ? value : [value]) search.append(name, v);
  }
  return search;
};

describe("GET /api/v1/state", () => {
  describe("authentication and roles", () => {
    for (const [label, headers] of [
      ["no Authorization header", {}],
      ["a malformed token", { Authorization: "Bearer not-a-token" }],
      ["an unknown token", auth(newToken())],
      ["the MSW mock-analyst token", { Authorization: "Bearer mock-analyst" }],
    ] as const) {
      it(`returns 401 UNAUTHENTICATED for ${label}, without calling inference`, async () => {
        const { res, calls } = await request(REPLAY_PATH, okWith(REPLAY.body), headers);
        assert.equal(res.status, 401);
        assert.equal(res.body!.error.code, "UNAUTHENTICATED");
        assert.equal(calls.length, 0);
      });
    }

    it("checks authentication before the query: an invalid query without a token is 401", async () => {
      const { res, calls } = await request("/api/v1/state?mode=explicit", okWith(REPLAY.body), {});
      assert.equal(res.status, 401);
      assert.equal(calls.length, 0);
    });

    for (const [role, token] of [
      ["analyst", analystToken],
      ["viewer", viewerToken],
    ] as const) {
      it(`returns 200 for a ${role} (no role rule)`, async () => {
        const { res } = await request(REPLAY_PATH, okWith(REPLAY.body), auth(token));
        assert.equal(res.status, 200);
      });
    }
  });

  describe("query validation (parseStateQuery)", () => {
    const valid = { corridor: "GBR->PHL", mode: "historicalReplay", date: "2024-06-14" };

    it("accepts a replay query; includeHistory defaults to false", () => {
      assert.deepEqual(parseStateQuery(q(valid)), {
        ok: true,
        query: { corridor: "GBR->PHL", mode: "historicalReplay", date: "2024-06-14", scenarioId: undefined, includeHistory: false },
      });
    });

    it("accepts a scenario query with any non-empty scenarioId, unchanged", () => {
      const result = parseStateQuery(q({ ...valid, mode: "scenario", scenarioId: "not_a_real_scenario", includeHistory: "true" }));
      assert.deepEqual(result, {
        ok: true,
        query: { corridor: "GBR->PHL", mode: "scenario", date: "2024-06-14", scenarioId: "not_a_real_scenario", includeHistory: true },
      });
    });

    it("accepts includeHistory=false", () => {
      const result = parseStateQuery(q({ ...valid, includeHistory: "false" }));
      assert.equal(result.ok && result.query.includeHistory, false);
    });

    it("accepts any non-empty corridor string unchanged (no local allow-list)", () => {
      for (const corridor of ["FRA->DEU", "gbr->phl", "x"]) {
        const result = parseStateQuery(q({ ...valid, corridor }));
        assert.equal(result.ok && result.query.corridor, corridor);
      }
    });

    it("ignores unknown parameters", () => {
      assert.equal(parseStateQuery(q({ ...valid, scenario_id: "baseline", foo: "bar" })).ok, true);
    });

    const cases: Array<[string, Record<string, string | string[]>, Array<{ field: string; message: string }>]> = [
      [
        "every required parameter missing",
        {},
        [
          { field: "corridor", message: "Required." },
          { field: "mode", message: "Required." },
          { field: "date", message: "Required." },
        ],
      ],
      ["an empty corridor", { ...valid, corridor: "" }, [{ field: "corridor", message: "Must be a non-empty string." }]],
      ["a duplicated corridor", { ...valid, corridor: ["GBR->PHL", "FRA->DEU"] }, [{ field: "corridor", message: "Must be given at most once." }]],
      ["mode explicit", { ...valid, mode: "explicit" }, [{ field: "mode", message: "Must be one of: historicalReplay, scenario." }]],
      ["the engine spelling historical_replay", { ...valid, mode: "historical_replay" }, [{ field: "mode", message: "Must be one of: historicalReplay, scenario." }]],
      ["a date in another form", { ...valid, date: "14/06/2024" }, [{ field: "date", message: "Must be a date in YYYY-MM-DD form." }]],
      ["an impossible date", { ...valid, date: "2024-02-30" }, [{ field: "date", message: "Must be a date in YYYY-MM-DD form." }]],
      ["an empty date", { ...valid, date: "" }, [{ field: "date", message: "Must be a date in YYYY-MM-DD form." }]],
      ["scenario without scenarioId", { ...valid, mode: "scenario" }, [{ field: "scenarioId", message: "Required." }]],
      ["scenario with an empty scenarioId", { ...valid, mode: "scenario", scenarioId: "" }, [{ field: "scenarioId", message: "Must be a non-empty string." }]],
      [
        "historicalReplay with scenarioId",
        { ...valid, scenarioId: "baseline" },
        [{ field: "scenarioId", message: "Must not be given with mode historicalReplay." }],
      ],
      [
        "historicalReplay with an empty scenarioId",
        { ...valid, scenarioId: "" },
        [{ field: "scenarioId", message: "Must not be given with mode historicalReplay." }],
      ],
      ["includeHistory=1", { ...valid, includeHistory: "1" }, [{ field: "includeHistory", message: "Must be true or false." }]],
      ["includeHistory=TRUE", { ...valid, includeHistory: "TRUE" }, [{ field: "includeHistory", message: "Must be true or false." }]],
      ["an empty includeHistory", { ...valid, includeHistory: "" }, [{ field: "includeHistory", message: "Must be true or false." }]],
      ["a duplicated mode", { ...valid, mode: ["historicalReplay", "scenario"] }, [{ field: "mode", message: "Must be given at most once." }]],
      [
        "a duplicated scenarioId",
        { ...valid, mode: "scenario", scenarioId: ["baseline", "baseline"] },
        [{ field: "scenarioId", message: "Must be given at most once." }],
      ],
      [
        "several problems at once",
        { corridor: "", mode: "scenario", date: "x", includeHistory: "yes" },
        [
          { field: "corridor", message: "Must be a non-empty string." },
          { field: "date", message: "Must be a date in YYYY-MM-DD form." },
          { field: "scenarioId", message: "Required." },
          { field: "includeHistory", message: "Must be true or false." },
        ],
      ],
    ];
    for (const [label, params, errors] of cases) {
      it(`rejects ${label}`, () => {
        assert.deepEqual(parseStateQuery(q(params)), { ok: false, errors });
      });
    }

    it("returns 422 VALIDATION_ERROR over HTTP, echoing no value, without calling inference", async () => {
      const marker = "<script>secret-value";
      const path = `/api/v1/state?corridor=GBR-%3EPHL&mode=historicalReplay&date=${encodeURIComponent(marker)}&scenarioId=${encodeURIComponent(marker)}`;
      const { res, calls } = await request(path, okWith(REPLAY.body), { ...auth(viewerToken), "X-Request-Id": "v-1" });
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, {
        error: {
          code: "VALIDATION_ERROR",
          message: "Request failed validation.",
          details: {
            errors: [
              { field: "date", message: "Must be a date in YYYY-MM-DD form." },
              { field: "scenarioId", message: "Must not be given with mode historicalReplay." },
            ],
          },
          requestId: "v-1",
        },
      });
      assert.doesNotMatch(res.text, /script|secret-value/);
      assert.equal(calls.length, 0);
    });

    it("validates before checking for an inference client", async () => {
      const res = await withApp({}, (get) => get("/api/v1/state?mode=scenario"));
      assert.equal(res.status, 422);
    });
  });

  describe("inference request", () => {
    it("sends the replay query in engine spelling, with no scenario_id or include_history", async () => {
      const { res, calls } = await request(REPLAY_PATH, okWith(REPLAY.body), { ...auth(viewerToken), "X-Request-Id": "st-1" });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-request-id"), "st-1");
      assert.deepEqual(
        calls.map((c) => [c.method, c.path, c.requestId, c.query, c.body]),
        [["GET", "/v1/state", "st-1", REPLAY.query, undefined]],
      );
    });

    it("sends scenario_id and include_history=true for a scenario query with history", async () => {
      const { calls } = await request(SCENARIO_PATH, okWith(SCENARIO.body));
      assert.deepEqual(calls[0]!.query, SCENARIO.query);
    });

    it("leaves include_history out when includeHistory=false", async () => {
      const { calls } = await request(`${REPLAY_PATH}&includeHistory=false`);
      assert.deepEqual(calls[0]!.query, REPLAY.query);
    });

    it("forwards no unknown parameter and no Authorization", async () => {
      const { calls } = await request(`${REPLAY_PATH}&foo=bar&scenario_id=baseline`);
      assert.deepEqual(calls[0]!.query, REPLAY.query);
      assert.equal(JSON.stringify(calls[0]).includes(viewerToken), false);
    });

    it("builds the live URL with the engine parameters only, URL-encoded", async () => {
      // A live client against a stubbed fetch: the URL is checked, no network is used.
      const seen: string[] = [];
      const realFetch = globalThis.fetch;
      const client = createInferenceClient(
        { url: "http://inference.test", mode: "live", timeoutMs: 1000 },
        { logger: silentLogger },
      );
      const server = await startServer(createApp({ logger: silentLogger, users, inferenceClient: client }));
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.startsWith("http://inference.test")) return realFetch(input, init);
        seen.push(url);
        return new Response(JSON.stringify(SCENARIO.body), { status: 200, headers: { "Content-Type": "application/json" } });
      }) as typeof fetch;
      try {
        const res = await realFetch(`${server.baseUrl}${SCENARIO_PATH}`, { headers: auth(viewerToken) });
        assert.equal(res.status, 200);
      } finally {
        globalThis.fetch = realFetch;
        await server.close();
      }
      assert.equal(seen.length, 1);
      const url = new URL(seen[0]!);
      assert.equal(url.pathname, "/v1/state");
      assert.deepEqual(Object.fromEntries(url.searchParams), SCENARIO.query);
    });

    it("calls inference on every request (not cached)", async () => {
      const { client, calls } = mockClient(okWith(REPLAY.body));
      await withApp({ inferenceClient: client }, async (get) => {
        assert.equal((await get(REPLAY_PATH, { headers: auth(viewerToken) })).status, 200);
        assert.equal((await get(REPLAY_PATH, { headers: auth(viewerToken) })).status, 200);
      });
      assert.equal(calls.filter((c) => c.path === "/v1/state").length, 2);
      assert.equal(calls.filter((c) => c.path === "/v1/version").length, 0);
    });
  });

  describe("mapping", () => {
    it("maps the replay fixture: camelCase keys, historical_replay -> historicalReplay, values unchanged", async () => {
      const { res } = await request(REPLAY_PATH, okWith(REPLAY.body));
      assert.equal(res.status, 200);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
      assert.deepEqual(res.body, expectedApp(REPLAY.body));
      assert.equal(res.body!.state.mode, "historicalReplay");
      assert.equal(res.body!.state.scenarioId, null);
      assert.equal(res.body!.venues[0].history, undefined);
    });

    it("maps the scenario fixture with nested venue history: dates, liquidityUsd and congestion arrays unchanged", async () => {
      const { res } = await request(SCENARIO_PATH, okWith(SCENARIO.body));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, expectedApp(SCENARIO.body));
      assert.equal(res.body!.state.mode, "scenario");
      assert.equal(res.body!.state.scenarioId, "cheapest_venue_outage");
      const engineVenues = SCENARIO.body.venues as Venue[];
      (res.body!.venues as Venue[]).forEach((venue, i) => {
        assert.deepEqual(Object.keys(venue.history), ["dates", "liquidityUsd", "congestion"]);
        assert.equal(venue.history.dates.length, 30);
        assert.deepEqual(venue.history.liquidityUsd, engineVenues[i]!.history.liquidity_usd);
        assert.deepEqual(venue.history.congestion, engineVenues[i]!.history.congestion);
        assert.equal(venue.history.liquidity_usd, undefined);
      });
    });

    it("keeps and maps unknown fields at every level, values unchanged", async () => {
      const engine = structuredClone(SCENARIO.body) as Record<string, any>;
      engine.future_field = { nested_key: "snake_value" };
      engine.state.extra_state_field = "historical_replay";
      engine.venues[0].extra_venue_field = 1;
      engine.venues[0].history.extra_history_field = ["a_b"];
      engine.warnings.push({ code: "SOME_NEW_WARNING", message: "m", bridge_uids: ["GBR->PHL#0"] });
      const { res } = await request(SCENARIO_PATH, okWith(engine));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body!.futureField, { nestedKey: "snake_value" });
      assert.equal(res.body!.state.extraStateField, "historical_replay"); // only state.mode's value is mapped
      assert.equal(res.body!.venues[0].extraVenueField, 1);
      assert.deepEqual(res.body!.venues[0].history.extraHistoryField, ["a_b"]);
      assert.deepEqual(res.body!.warnings.at(-1), { code: "SOME_NEW_WARNING", message: "m", bridgeUids: ["GBR->PHL#0"] });
    });

    it("keeps an unknown state.mode value as it is (§1)", () => {
      const engine = { ...structuredClone(REPLAY.body), state: { ...(REPLAY.body.state as JsonObject), mode: "future_mode" } };
      assert.equal((mapStateResponse(engine).state as JsonObject).mode, "future_mode");
    });

    it("never mutates the inference body", () => {
      const engine = structuredClone(SCENARIO.body);
      const before = JSON.stringify(engine);
      mapStateResponse(engine);
      assert.equal(JSON.stringify(engine), before);
    });
  });

  describe("unknown scenarios", () => {
    it("passes an unknown scenarioId to inference unchanged and passes 422 UNKNOWN_SCENARIO through", async () => {
      const leaky = "scenario 'nope' not in /srv/app/scenarios.py";
      const { res, calls } = await request(
        "/api/v1/state?corridor=GBR-%3EPHL&mode=scenario&date=2024-06-14&scenarioId=nope",
        () => ({ status: 422, body: { error: { code: "UNKNOWN_SCENARIO", message: leaky, details: { field: "scenario_id", trace: "x" } } } }),
        { ...auth(viewerToken), "X-Request-Id": "us-1" },
      );
      assert.equal(calls[0]!.query!.scenario_id, "nope");
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, {
        error: { code: "UNKNOWN_SCENARIO", message: "The scenario is not defined.", details: {}, requestId: "us-1" },
      });
      assert.doesNotMatch(res.text, /srv|scenarios\.py|trace/);
    });

    for (const [code, message] of [
      ["DATE_OUT_OF_RANGE", "The date is outside 2011-01-01 to 2025-09-30."],
      ["DATE_IN_GAP_BUFFER", "The date falls within a gap buffer."],
      ["UNSUPPORTED_CORRIDOR", "The corridor is not in the network."],
    ] as const) {
      it(`passes 422 ${code} through with the backend's message`, async () => {
        const { res } = await request(REPLAY_PATH, () => ({ status: 422, body: { error: { code, message: "engine text" } } }));
        assert.equal(res.status, 422);
        assert.equal(res.body!.error.code, code);
        assert.equal(res.body!.error.message, message);
      });
    }
  });

  describe("unknown corridors", () => {
    const UNKNOWN_PATH = "/api/v1/state?corridor=FRA-%3EDEU&mode=historicalReplay&date=2024-06-14";

    it("forwards an unknown corridor to inference unchanged", async () => {
      const { calls } = await request(UNKNOWN_PATH, () => ({
        status: 422,
        body: { error: { code: "UNSUPPORTED_CORRIDOR", message: "x" } },
      }));
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0]!.query, { corridor: "FRA->DEU", mode: "historical_replay", date: "2024-06-14" });
    });

    it("returns inference's 422 UNSUPPORTED_CORRIDOR with the backend's message, exposing nothing from inference", async () => {
      const leaky = "corridor 'FRA->DEU' not in /srv/data/bridge_network.csv";
      const { res } = await request(
        UNKNOWN_PATH,
        () => ({ status: 422, body: { error: { code: "UNSUPPORTED_CORRIDOR", message: leaky, details: { field: "corridor", trace: "t" } } } }),
        { ...auth(viewerToken), "X-Request-Id": "uc-1" },
      );
      assert.equal(res.status, 422);
      assert.deepEqual(res.body, {
        error: { code: "UNSUPPORTED_CORRIDOR", message: "The corridor is not in the network.", details: {}, requestId: "uc-1" },
      });
      assert.doesNotMatch(res.text, /srv|bridge_network|trace/);
    });

    it("returns inference's 422 VALIDATION_ERROR (schema rejection) with the existing item mapping", async () => {
      const { res } = await request(UNKNOWN_PATH, () => ({
        status: 422,
        body: { error: { code: "VALIDATION_ERROR", message: "enum mismatch", details: { errors: [{ field: "corridor", message: "bad: FRA->DEU" }] } } },
      }));
      assert.equal(res.status, 422);
      assert.equal(res.body!.error.code, "VALIDATION_ERROR");
      assert.equal(res.body!.error.message, "Request failed validation.");
      // "corridor" has no entry in the engine field-path table, so the item is form-level (§4).
      assert.deepEqual(res.body!.error.details, { errors: [{ message: "Rejected by the routing engine." }] });
      assert.doesNotMatch(res.text, /FRA->DEU|enum mismatch/);
    });
  });

  describe("malformed responses", () => {
    const leaky = "Traceback: postgresql://user:pass@db";
    const badState = (state: unknown) => ({ ...structuredClone(REPLAY.body), state });
    for (const [label, answer] of [
      ["a JSON array", { status: 200, body: [REPLAY.body] }],
      ["JSON null", { status: 200, body: null }],
      ["a JSON string", { status: 200, body: leaky }],
      ["a 201 status", { status: 201, body: REPLAY.body }],
      ["a missing state", { status: 200, body: { ...structuredClone(REPLAY.body), state: undefined } }],
      ["a null state", { status: 200, body: badState(null) }],
      ["a state array", { status: 200, body: badState([]) }],
      ["a missing state.mode", { status: 200, body: badState({ date: "2024-06-14", split: "test", scenario_id: null }) }],
      ["a numeric state.mode", { status: 200, body: badState({ mode: 1, date: "2024-06-14", split: "test", scenario_id: null }) }],
    ] as const) {
      it(`returns 502 INFERENCE_ERROR for ${label}`, async () => {
        const { res } = await request(REPLAY_PATH, () => answer as MockResponse, { ...auth(viewerToken), "X-Request-Id": "bad-1" });
        assert.equal(res.status, 502);
        assert.deepEqual(res.body, {
          error: { code: "INFERENCE_ERROR", message: "The inference service returned an invalid response.", details: {}, requestId: "bad-1" },
        });
        assert.doesNotMatch(res.text, /Traceback|postgresql/);
      });
    }

    it("returns 502 when two keys collide inside a venue's history, logging paths but no key names", async () => {
      const engine = structuredClone(SCENARIO.body) as Record<string, any>;
      engine.venues[1].history.liquidityUsd = [1];
      const capture = captureLogger();
      const { client } = mockClient(okWith(engine));
      const server = await startServer(createApp({ logger: capture.logger, users, inferenceClient: client }));
      try {
        const res = await fetch(`${server.baseUrl}${SCENARIO_PATH}`, { headers: { ...auth(viewerToken), "X-Request-Id": "collide" } });
        assert.equal(res.status, 502);
        assert.equal(((await res.json()) as { error: { code: string } }).error.code, "INFERENCE_ERROR");
      } finally {
        await server.close();
      }
      const warning = capture.entries().find((e) => e.msg === "inference response could not be mapped");
      assert.equal(warning?.requestId, "collide");
      assert.equal(warning?.path, "/v1/state");
      assert.doesNotMatch(capture.lines.join("\n"), /liquidityUsd|liquidity_usd/);
    });
  });

  describe("inference failures", () => {
    const leaky = "Traceback: postgresql://user:pass@db /srv/engine.py";
    for (const [label, answer, status, code, details, retryAfter] of [
      ["inference 500", { status: 500, body: { error: { code: "INTERNAL_ERROR", message: leaky } } }, 502, "INFERENCE_ERROR", {}, null],
      ["inference 404", { status: 404, body: { error: { code: "NOT_FOUND", message: leaky } } }, 502, "INFERENCE_ERROR", {}, null],
      ["an undocumented 4xx", { status: 400, body: { error: { code: "MALFORMED_REQUEST", message: leaky } } }, 502, "INFERENCE_ERROR", {}, null],
      ["a non-JSON 502", { status: 502, body: leaky }, 502, "INFERENCE_ERROR", {}, null],
      [
        "NOT_READY",
        { status: 503, body: { error: { code: "NOT_READY", message: leaky } }, retryAfter: "3" },
        503,
        "INFERENCE_UNAVAILABLE",
        { cause: "NOT_READY" },
        "3",
      ],
      ["ENGINE_BUSY", { status: 503, body: { error: { code: "ENGINE_BUSY", message: leaky } }, retryAfter: "2" }, 503, "ENGINE_BUSY", {}, "2"],
      ["ENGINE_TIMEOUT", { status: 504, body: { error: { code: "ENGINE_TIMEOUT", message: leaky } } }, 504, "ENGINE_TIMEOUT", {}, null],
    ] as const) {
      it(`returns ${status} ${code} for ${label}, exposing nothing from inference`, async () => {
        const { res } = await request(REPLAY_PATH, () => answer as MockResponse);
        assert.equal(res.status, status);
        assert.equal(res.body!.error.code, code);
        assert.deepEqual(res.body!.error.details, details);
        assert.equal(res.headers.get("retry-after"), retryAfter);
        assert.doesNotMatch(res.text, /Traceback|postgresql|srv|INTERNAL_ERROR|NOT_FOUND|MALFORMED_REQUEST/);
      });
    }

    it("returns 503 INFERENCE_UNAVAILABLE when inference is unreachable (mock with no answer)", async () => {
      const { res } = await request(REPLAY_PATH, () => undefined);
      assert.equal(res.status, 503);
      assert.equal(res.body!.error.code, "INFERENCE_UNAVAILABLE");
      assert.equal(res.body!.error.details.cause, undefined);
    });

    it("returns 503 INFERENCE_UNAVAILABLE without an inference client", async () => {
      const res = await withApp({}, (get) => get(REPLAY_PATH, { headers: { ...auth(viewerToken), "X-Request-Id": "no-client" } }));
      assert.equal(res.status, 503);
      assert.deepEqual(res.body, {
        error: { code: "INFERENCE_UNAVAILABLE", message: "The inference service is unavailable.", details: {}, requestId: "no-client" },
      });
    });
  });

  describe("methods", () => {
    it("answers HEAD with the GET route: 200 and an empty body", async () => {
      const { client } = mockClient(okWith(REPLAY.body));
      const res = await withApp({ inferenceClient: client }, (get) => get(REPLAY_PATH, { method: "HEAD" }));
      assert.equal(res.status, 200);
      assert.equal(res.text, "");
    });

    it("requires authentication for HEAD", async () => {
      const { client, calls } = mockClient(okWith(REPLAY.body));
      const res = await withApp({ inferenceClient: client }, (get) => get(REPLAY_PATH, { method: "HEAD", headers: {} }));
      assert.equal(res.status, 401);
      assert.equal(calls.length, 0);
    });

    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      it(`returns 401 without a token, then 405 with Allow: GET, HEAD for ${method} with one (§10 Q14), without calling inference`, async () => {
        const { client, calls } = mockClient(okWith(REPLAY.body));
        const anon = await withApp({ inferenceClient: client }, (get) => get(REPLAY_PATH, { method, headers: {} }));
        assert.equal(anon.status, 401);
        assert.equal(anon.headers.get("allow"), null);
        const res = await withApp({ inferenceClient: client }, (get) => get(REPLAY_PATH, { method }));
        assert.equal(res.status, 405);
        assert.equal(res.headers.get("allow"), "GET, HEAD");
        assert.equal(res.body!.error.code, "METHOD_NOT_ALLOWED");
        assert.equal(res.body!.error.message, `Method ${method} is not allowed on /api/v1/state.`);
        assert.equal(calls.length, 0);
      });
    }
  });
});
