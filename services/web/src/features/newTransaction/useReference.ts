import { useApiQuery } from "../../api/useApiQuery";
import { useAuth } from "../../auth/AuthContext";
import { fetchNetwork } from "../network/networkApi";
import { applyRole, buildReferenceData, fetchPolicies, fetchScenarios } from "./referenceApi";
import type { ReferenceQuery } from "./ReferenceStatus";
import type { ReferenceData } from "./types";

/**
 * The transaction forms' reference data, live: corridors (GET /network),
 * scenarios (GET /scenarios) and policies (GET /meta), each its own request with
 * its own loading, error and retry. `reference` is null until all three have
 * loaded; `queries` is what ReferenceStatus shows in the meantime. Shared by
 * New transaction and Compare, so both read the same way.
 */
export function useLiveReference(enabled: boolean): { reference: ReferenceData | null; queries: ReferenceQuery[] } {
  const { api, user } = useAuth();
  const network = useApiQuery("reference:network", () => fetchNetwork(api), enabled);
  const scenarios = useApiQuery("reference:scenarios", () => fetchScenarios(api), enabled);
  const policies = useApiQuery("reference:policies", () => fetchPolicies(api), enabled);
  const reference =
    network.status === "success" && scenarios.status === "success" && policies.status === "success"
      ? buildReferenceData(network.data, scenarios.data, applyRole(policies.data, user?.role))
      : null;
  return {
    reference,
    queries: [
      { source: "network", status: network.status, error: network.error, retry: network.retry },
      { source: "scenarios", status: scenarios.status, error: scenarios.error, retry: scenarios.retry },
      { source: "policies", status: policies.status, error: policies.error, retry: policies.retry },
    ],
  };
}
