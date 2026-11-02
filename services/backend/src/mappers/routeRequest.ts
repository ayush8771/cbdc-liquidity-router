import type { Policy, StateSpec, TransactionRequest } from "../validation/transactionRequest.js";

// A validated Application API transaction (API contract §3.2) as the
// inference RouteRequest (§2.8, §2.4). Field for field; nothing is computed.
//
// - Keys become snake_case, written out per field rather than converted
//   generically, so only documented fields are ever sent.
// - Enum values mapped (§3.2): policy cheapestFeasible -> cheapest_feasible,
//   ppoProjected -> ppo_projected; state mode historicalReplay ->
//   historical_replay. waterfall, scenario and explicit are the same in both.
// - Every other value is unchanged: countries, amounts, dates, bridge_uid,
//   liquidity, congestion and history numbers.
// - scenario_id is passed on exactly as received. PENDING (Dev A/C): whether
//   the Application API uses the engine's values (cheapest_venue_outage) or
//   camelCase ones; no conversion is guessed here.
// - policy is always sent, already defaulted, so the engine never applies its
//   own default (the schema's requestedPolicy is what was sent).
// - client_reference is sent only when the caller gave one.

export const POLICY_TO_ENGINE: Readonly<Record<Policy, string>> = Object.freeze({
  waterfall: "waterfall",
  cheapestFeasible: "cheapest_feasible",
  ppoProjected: "ppo_projected",
});

export const STATE_MODE_TO_ENGINE: Readonly<Record<StateSpec["mode"], string>> = Object.freeze({
  historicalReplay: "historical_replay",
  scenario: "scenario",
  explicit: "explicit",
});

export function toRouteRequest(request: TransactionRequest): Record<string, unknown> {
  return {
    transaction: {
      sender_country: request.senderCountry,
      receiver_country: request.receiverCountry,
      amount_usd: request.amountUsd,
      ...(request.clientReference !== null && { client_reference: request.clientReference }),
    },
    state: toEngineState(request.state),
    policy: POLICY_TO_ENGINE[request.policy],
  };
}

export function toEngineState(state: StateSpec): Record<string, unknown> {
  const mode = STATE_MODE_TO_ENGINE[state.mode];
  switch (state.mode) {
    case "historicalReplay":
      return { mode, date: state.date };
    case "scenario":
      return { mode, date: state.date, scenario_id: state.scenarioId };
    case "explicit":
      return {
        mode,
        reference_date: state.referenceDate,
        venues: state.venues.map((venue) => ({
          bridge_uid: venue.bridgeUid,
          liquidity_usd: venue.liquidityUsd,
          congestion: venue.congestion,
          history:
            venue.history === null
              ? null
              : { liquidity_usd: [...venue.history.liquidityUsd], congestion: [...venue.history.congestion] },
        })),
      };
  }
}
