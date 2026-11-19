import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { InferenceError } from "../../src/inferenceClient/errors.js";
import {
  InvalidVersionResponseError,
  validateVersionResponse,
  versionResponseProblems,
} from "../../src/mappers/versionResponse.js";
import { engineVersionBody } from "../helpers/version.js";

// Validation of a /v1/version 200 body before the shared cache stores it.

// The shared contract fixtures, read only.
function contractFixture(name: string): Record<string, unknown> {
  const url = new URL(`../../../../contracts/fixtures/inference/meta/${name}`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { response: { body: Record<string, unknown> } }).response.body;
}

describe("versionResponseProblems", () => {
  it("accepts both contract fixtures (checkpoint null and enabled)", () => {
    assert.deepEqual(versionResponseProblems(contractFixture("200_version.json")), []);
    assert.deepEqual(versionResponseProblems(contractFixture("200_version_ppo_enabled.json")), []);
  });

  it("accepts the test helper body", () => {
    assert.deepEqual(versionResponseProblems(engineVersionBody()), []);
  });

  it("allows unknown fields, and leaves fields outside the fingerprint unchecked (§1 run-time tolerance)", () => {
    const body = engineVersionBody({ future_field: 1, api_version: "v2", policies: "anything", runtime: null });
    (body.data as Record<string, unknown>).date_range = "unchecked";
    (body.knowledge as Record<string, unknown>).knowledge_version = 5;
    assert.deepEqual(versionResponseProblems(body), []);
  });

  it("accepts any reward_weights.status string, and extra reward_weights keys", () => {
    const body = engineVersionBody({
      reward_weights: { lambda_latency: 2, lambda_risk: 0, lambda_unrouted: -1, status: "calibrated", extra: true },
    });
    assert.deepEqual(versionResponseProblems(body), []);
  });

  it("accepts an enabled checkpoint with only a valid sha256", () => {
    assert.deepEqual(versionResponseProblems(engineVersionBody({ checkpoint: { sha256: "a".repeat(64) } })), []);
  });

  const cases: Array<[string, (b: Record<string, any>) => void, string[]]> = [
    ["git_commit missing", (b) => delete b.git_commit, ["git_commit"]],
    ["git_commit empty", (b) => (b.git_commit = ""), ["git_commit"]],
    ["git_commit a number", (b) => (b.git_commit = 123), ["git_commit"]],
    ["engine_version missing", (b) => delete b.engine_version, ["engine_version"]],
    ["engine_version null", (b) => (b.engine_version = null), ["engine_version"]],
    ["reward_weights missing", (b) => delete b.reward_weights, ["reward_weights"]],
    ["reward_weights an array", (b) => (b.reward_weights = []), ["reward_weights"]],
    ["lambda_latency a string", (b) => (b.reward_weights.lambda_latency = "1"), ["reward_weights.lambda_latency"]],
    ["lambda_risk missing", (b) => delete b.reward_weights.lambda_risk, ["reward_weights.lambda_risk"]],
    ["lambda_unrouted null", (b) => (b.reward_weights.lambda_unrouted = null), ["reward_weights.lambda_unrouted"]],
    ["reward_weights.status missing", (b) => delete b.reward_weights.status, ["reward_weights.status"]],
    ["knowledge missing", (b) => delete b.knowledge, ["knowledge"]],
    ["knowledge.sha256 upper-case", (b) => (b.knowledge.sha256 = "A".repeat(64)), ["knowledge.sha256"]],
    ["knowledge.sha256 too short", (b) => (b.knowledge.sha256 = "a".repeat(63)), ["knowledge.sha256"]],
    ["data missing", (b) => delete b.data, ["data"]],
    ["data null", (b) => (b.data = null), ["data"]],
    ["data.daily_state_sha256 not hex", (b) => (b.data.daily_state_sha256 = "x".repeat(64)), ["data.daily_state_sha256"]],
    ["data.bridge_network_sha256 missing", (b) => delete b.data.bridge_network_sha256, ["data.bridge_network_sha256"]],
    ["data.normalization_stats_sha256 a number", (b) => (b.data.normalization_stats_sha256 = 1), ["data.normalization_stats_sha256"]],
    ["data.macro_risk_proxy_sha256 empty", (b) => (b.data.macro_risk_proxy_sha256 = ""), ["data.macro_risk_proxy_sha256"]],
    ["data.rpw_corridor_quarterly_sha256 prefixed", (b) => (b.data.rpw_corridor_quarterly_sha256 = `sha256:${"a".repeat(64)}`), ["data.rpw_corridor_quarterly_sha256"]],
    ["data.scenarios_sha256 missing", (b) => delete b.data.scenarios_sha256, ["data.scenarios_sha256"]],
    ["checkpoint missing", (b) => delete b.checkpoint, ["checkpoint"]],
    ["checkpoint a string", (b) => (b.checkpoint = "x"), ["checkpoint"]],
    ["checkpoint an array", (b) => (b.checkpoint = []), ["checkpoint"]],
    ["checkpoint without sha256", (b) => (b.checkpoint = { checkpoint_id: "c" }), ["checkpoint.sha256"]],
    ["checkpoint.sha256 a number", (b) => (b.checkpoint = { sha256: 1 }), ["checkpoint.sha256"]],
  ];
  for (const [label, change, problems] of cases) {
    it(`reports ${problems.join(", ")} when ${label}`, () => {
      const body = structuredClone(engineVersionBody()) as Record<string, any>;
      change(body);
      assert.deepEqual(versionResponseProblems(body), problems);
    });
  }

  it("reports every problem of an empty body, as field paths only", () => {
    assert.deepEqual(versionResponseProblems({}), [
      "git_commit",
      "engine_version",
      "reward_weights",
      "knowledge",
      "data",
      "checkpoint",
    ]);
  });
});

describe("validateVersionResponse", () => {
  it("throws a 502 INFERENCE_ERROR invalid_response with the problems", () => {
    assert.throws(
      () => validateVersionResponse({}),
      (e) =>
        e instanceof InvalidVersionResponseError &&
        e instanceof InferenceError &&
        e.status === 502 &&
        e.code === "INFERENCE_ERROR" &&
        e.message === "The inference service returned an invalid response." &&
        e.failure === "invalid_response" &&
        e.upstreamStatus === 200 &&
        e.problems.length === 6,
    );
  });

  it("returns for a valid body", () => {
    assert.doesNotThrow(() => validateVersionResponse(engineVersionBody()));
  });
});
