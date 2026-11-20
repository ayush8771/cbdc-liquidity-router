/*
 * The New Transaction form's reference data, live (contract §3.1): corridors,
 * venues and the single-transfer limit from GET /api/v1/network (already
 * integrated for the Network page), scenarios from GET /api/v1/scenarios, and
 * the policies from GET /api/v1/meta. Each is its own request with its own
 * result, so one failing never blocks or retries the others; the form is built
 * from the three once all have loaded.
 */
import { ApiError, INVALID_RESPONSE, type ApiClient } from "../../api/client";
import type { Role } from "../../api/types";
import { isApiMetaPolicies, isApiScenarios } from "../../api/types";
import type { NetworkView } from "../network/types";
import { POLICY_NAMES, type PolicyKey, type PolicyTier } from "../transactions/types";
import type { CorridorRef, PolicyRef, ReferenceData, ScenarioRef } from "./types";

const unreadable = () =>
  new ApiError({ status: 200, code: INVALID_RESPONSE, message: "The server's response could not be read." });

export async function fetchScenarios(api: ApiClient): Promise<ScenarioRef[]> {
  const raw = await api.get<unknown>("/scenarios");
  if (!isApiScenarios(raw)) throw unreadable();
  return raw.scenarios.map((s) => ({ scenarioId: s.scenarioId, description: s.description }));
}

/** The policies as the API lists them, before any role rule. */
export async function fetchPolicies(api: ApiClient): Promise<PolicyRef[]> {
  const raw = await api.get<unknown>("/meta");
  if (!isApiMetaPolicies(raw)) throw unreadable();
  return (
    raw.policies
      // The form can only submit the policies it knows how to name; an unknown one is not offered.
      .filter((p) => Object.hasOwn(POLICY_NAMES, p.policy))
      .map((p) => ({
        policy: p.policy as PolicyKey,
        status: p.status as PolicyTier,
        enabled: p.enabled,
        ...(p.disabledReason !== undefined ? { disabledReason: p.disabledReason } : {}),
      }))
  );
}

export const VIEWER_POLICY_REASON = "only analysts can use the experimental policy";

/**
 * The experimental policy is for analysts only (contract §3.0): a viewer who
 * asks for it gets 403 FORBIDDEN_POLICY, so it is not offered to them. If it is
 * also disabled by the engine, the engine's own reason is kept. The server
 * stays the authority: this only avoids a request that is certain to fail.
 */
export function applyRole(policies: PolicyRef[], role: Role | undefined): PolicyRef[] {
  if (role === "analyst") return policies;
  return policies.map((p) =>
    p.policy === "ppoProjected" && p.enabled ? { ...p, enabled: false, disabledReason: VIEWER_POLICY_REASON } : p,
  );
}

/** The corridors and venues of the network, as the form lists them. The venues keep the API's slot order. */
export function toCorridorRefs(network: NetworkView): CorridorRef[] {
  return network.corridors.map((c) => ({
    corridor: c.corridor,
    senderCountry: c.senderCountry,
    receiverCountry: c.receiverCountry,
    venues: c.venues.map((v) => ({ bridgeUid: v.bridgeUid, feePct: v.feePct, dataSourceTag: v.dataSourceTag })),
  }));
}

export function buildReferenceData(network: NetworkView, scenarios: ScenarioRef[], policies: PolicyRef[]): ReferenceData {
  return {
    corridors: toCorridorRefs(network),
    scenarios,
    policies,
    maxSingleTransferUsd: network.maxSingleTransferUsd,
  };
}

export type ReferenceSource = "network" | "scenarios" | "policies" | "calendar";

const NOUN: Record<ReferenceSource, string> = {
  network: "the corridors",
  scenarios: "the scenarios",
  policies: "the policies",
  calendar: "the calendar of eligible dates",
};

export type ReferenceErrorView = { message: string; reference: string | undefined; canRetry: boolean };

/**
 * What to tell the user when one source failed. The wording is this UI's own,
 * chosen by `code`, `status` and `details.cause`, never by the backend's
 * message. All three endpoints read the inference service's cached data, so
 * their failures are its: unavailable, still starting up, timed out, or an
 * invalid answer.
 */
export function describeReferenceError(error: unknown, source: ReferenceSource): ReferenceErrorView {
  const noun = NOUN[source];
  if (!(error instanceof ApiError)) {
    return { message: `Something went wrong while loading ${noun}.`, reference: undefined, canRetry: true };
  }
  const reference = error.requestId ?? undefined;
  const view = (message: string, canRetry = true): ReferenceErrorView => ({ message, reference, canRetry });

  if (error.code === "NETWORK_ERROR") return view("The server could not be reached. Check your connection, then try again.");
  if (error.code === INVALID_RESPONSE) return view(`The server sent ${noun} in a form this page couldn't read.`);
  if (error.code === "INFERENCE_UNAVAILABLE") {
    return error.details.cause === "NOT_READY"
      ? view(`The routing engine is starting up, so ${noun} aren't available yet. Try again in a moment.`)
      : view(`The routing engine is unavailable, so ${noun} can't be loaded. Try again in a moment.`);
  }
  if (error.code === "ENGINE_BUSY") return view("The routing engine is busy. Try again in a moment.");
  if (error.code === "ENGINE_TIMEOUT") return view("The routing engine did not answer in time. Try again.");
  if (error.status === 403) return view(`You don't have access to ${noun}.`, false);
  if (error.status >= 500) return view("The server hit an unexpected error. Try again in a moment.");
  return view(`The request failed (${error.code}).`);
}
