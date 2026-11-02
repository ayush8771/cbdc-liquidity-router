import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLICY_TO_ENGINE, STATE_MODE_TO_ENGINE, toRouteRequest } from "../../src/mappers/routeRequest.js";
import { validateTransactionRequest, type TransactionRequest } from "../../src/validation/transactionRequest.js";

const series = (last: number) => Array.from({ length: 30 }, (_, i) => (i === 29 ? last : i * 1000));

function validated(body: Record<string, unknown>): TransactionRequest {
  const result = validateTransactionRequest(body);
  assert.ok(result.ok);
  return result.value;
}

const base = { senderCountry: "GBR", receiverCountry: "PHL", amountUsd: 300000.0 };

describe("toRouteRequest", () => {
  it("maps the §3.2 replay example to the §2.8 RouteRequest", () => {
    const request = validated({
      ...base,
      state: { mode: "historicalReplay", date: "2024-06-14" },
      policy: "waterfall",
      clientReference: "optional, echoed back",
    });
    assert.deepEqual(toRouteRequest(request), {
      transaction: {
        sender_country: "GBR",
        receiver_country: "PHL",
        amount_usd: 300000.0,
        client_reference: "optional, echoed back",
      },
      state: { mode: "historical_replay", date: "2024-06-14" },
      policy: "waterfall",
    });
  });

  it("maps a scenario, passing scenario_id unchanged (convention pending)", () => {
    for (const scenarioId of ["cheapest_venue_outage", "cheapestVenueOutage", "liquidity_minus30"]) {
      const request = validated({ ...base, state: { mode: "scenario", date: "2024-06-14", scenarioId } });
      assert.deepEqual(toRouteRequest(request).state, { mode: "scenario", date: "2024-06-14", scenario_id: scenarioId });
    }
  });

  it("maps an explicit state field for field, with history and null history", () => {
    const request = validated({
      ...base,
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
    });
    assert.deepEqual(toRouteRequest(request), {
      transaction: { sender_country: "GBR", receiver_country: "PHL", amount_usd: 300000.0 },
      state: {
        mode: "explicit",
        reference_date: "2024-06-14",
        venues: [
          { bridge_uid: "GBR->PHL#0", liquidity_usd: 210000.0, congestion: 0.35, history: { liquidity_usd: series(210000), congestion: series(0.35) } },
          { bridge_uid: "GBR->PHL#1", liquidity_usd: 60000.0, congestion: 0.2, history: null },
          { bridge_uid: "GBR->PHL#2", liquidity_usd: 90000.0, congestion: 0.5, history: null },
        ],
      },
      policy: "ppo_projected",
    });
  });

  it("maps every policy value (§3.2)", () => {
    assert.deepEqual(POLICY_TO_ENGINE, { waterfall: "waterfall", cheapestFeasible: "cheapest_feasible", ppoProjected: "ppo_projected" });
    for (const [app, engine] of Object.entries(POLICY_TO_ENGINE)) {
      const request = validated({ ...base, state: { mode: "historicalReplay", date: "2024-06-14" }, policy: app });
      assert.equal(toRouteRequest(request).policy, engine);
    }
  });

  it("maps every state mode (§3.2)", () => {
    assert.deepEqual(STATE_MODE_TO_ENGINE, { historicalReplay: "historical_replay", scenario: "scenario", explicit: "explicit" });
  });

  it("always sends the defaulted policy", () => {
    const request = validated({ ...base, state: { mode: "historicalReplay", date: "2024-06-14" } });
    assert.equal(toRouteRequest(request).policy, "waterfall");
  });

  it("omits client_reference when none was given, and keeps an empty string", () => {
    const none = validated({ ...base, state: { mode: "historicalReplay", date: "2024-06-14" }, clientReference: null });
    assert.equal("client_reference" in (toRouteRequest(none).transaction as object), false);
    const empty = validated({ ...base, state: { mode: "historicalReplay", date: "2024-06-14" }, clientReference: "" });
    assert.equal((toRouteRequest(empty).transaction as { client_reference: string }).client_reference, "");
  });

  it("keeps values exactly, including precision and unsupported inputs left for inference", () => {
    const request = validated({
      senderCountry: "usa",
      receiverCountry: "XXX",
      amountUsd: 0.1 + 0.2,
      state: { mode: "historicalReplay", date: "1999-12-31" },
    });
    assert.deepEqual(toRouteRequest(request).transaction, { sender_country: "usa", receiver_country: "XXX", amount_usd: 0.1 + 0.2 });
    assert.equal((toRouteRequest(request).state as { date: string }).date, "1999-12-31");
  });

  it("doesn't share arrays with the validated request, and serialises to the same JSON", () => {
    const request = validated({
      ...base,
      state: { mode: "explicit", referenceDate: "2024-06-14", venues: [{ bridgeUid: "u", liquidityUsd: 1, congestion: 0, history: { liquidityUsd: series(1), congestion: series(0) } }] },
    });
    const engine = toRouteRequest(request) as { state: { venues: Array<{ history: { liquidity_usd: number[] } }> } };
    engine.state.venues[0]!.history.liquidity_usd[0] = -1;
    assert.equal((request.state as { venues: Array<{ history: { liquidityUsd: number[] } }> }).venues[0]!.history.liquidityUsd[0], 0);
    assert.deepEqual(JSON.parse(JSON.stringify(toRouteRequest(request))), toRouteRequest(request));
  });
});
