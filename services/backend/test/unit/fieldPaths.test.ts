import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapEngineFieldPath } from "../../src/inferenceClient/fieldPaths.js";
import { toRouteRequest } from "../../src/mappers/routeRequest.js";
import { validateTransactionRequest } from "../../src/validation/transactionRequest.js";

// The engine -> app field-path table (API contract §4).

describe("mapEngineFieldPath", () => {
  for (const [engine, app] of [
    // §4's own examples
    ["transaction.amount_usd", "amountUsd"],
    ["state.venues[1].history.liquidity_usd", "state.venues[1].history.liquidityUsd"],
    // the engine fixtures' paths
    ["state.date", "state.date"],
    ["state.scenario_id", "state.scenarioId"],
    ["state.venues", "state.venues"],
    ["state.venues[0].liquidity_usd", "state.venues[0].liquidityUsd"],
    ["state.venues[0].history.liquidity_usd", "state.venues[0].history.liquidityUsd"],
    // the rest of the request
    ["transaction.sender_country", "senderCountry"],
    ["transaction.receiver_country", "receiverCountry"],
    ["transaction.client_reference", "clientReference"],
    ["policy", "policy"],
    ["state", "state"],
    ["state.mode", "state.mode"],
    ["state.reference_date", "state.referenceDate"],
    ["state.venues[12]", "state.venues[12]"],
    ["state.venues[2].bridge_uid", "state.venues[2].bridgeUid"],
    ["state.venues[2].congestion", "state.venues[2].congestion"],
    ["state.venues[2].history", "state.venues[2].history"],
    ["state.venues[2].history.congestion", "state.venues[2].history.congestion"],
    ["state.venues[2].history.congestion[29]", "state.venues[2].history.congestion[29]"],
    ["state.venues[0].history.liquidity_usd[0]", "state.venues[0].history.liquidityUsd[0]"],
  ] as const) {
    it(`maps ${engine} -> ${app}`, () => assert.equal(mapEngineFieldPath(engine), app));
  }

  for (const path of [
    "transaction", // UNSUPPORTED_CORRIDOR: no single app field
    "state.venues[0].risk", // not a request field
    "state.venues[0].fee",
    "amountUsd", // an app path is not an engine path
    "transaction.amountUsd",
    "state.scenarioId",
    "state.venues[01]", // leading zero
    "state.venues[-1]",
    "state.venues[x]",
    "state.venues[0].history.liquidity_usd[30][0]",
    "state.venues.0",
    "STATE.DATE",
    " state.date",
    "state.date ",
    "",
    "__proto__",
    "constructor",
    "x".repeat(300),
  ]) {
    it(`drops ${JSON.stringify(path.length > 40 ? `${path.slice(0, 10)}…` : path)}`, () => {
      assert.equal(mapEngineFieldPath(path), undefined);
    });
  }

  for (const value of [undefined, null, 1, {}, ["state.date"]]) {
    it(`drops a non-string field ${JSON.stringify(value)}`, () => assert.equal(mapEngineFieldPath(value), undefined));
  }

  it("covers every field the backend sends: each engine leaf path maps back to the app path it came from", () => {
    const body = {
      senderCountry: "GBR",
      receiverCountry: "PHL",
      amountUsd: 1,
      clientReference: "r",
      policy: "waterfall",
      state: {
        mode: "explicit",
        referenceDate: "2024-06-14",
        venues: [
          { bridgeUid: "u", liquidityUsd: 1, congestion: 0, history: { liquidityUsd: Array(30).fill(1), congestion: Array(30).fill(0) } },
        ],
      },
    };
    const result = validateTransactionRequest(body);
    assert.ok(result.ok);
    const engine = toRouteRequest(result.value);
    const leaves: string[] = [];
    const walk = (value: unknown, path: string) => {
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
      else if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) walk(v, path === "" ? k : `${path}.${k}`);
      } else leaves.push(path);
    };
    walk(engine, "");
    for (const leaf of leaves) assert.notEqual(mapEngineFieldPath(leaf), undefined, leaf);
    // The scenario mode's own field too.
    assert.equal(mapEngineFieldPath("state.scenario_id"), "state.scenarioId");
  });
});
