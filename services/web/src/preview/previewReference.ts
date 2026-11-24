/*
 * PREVIEW DATA — illustrative reference data for the New Transaction form,
 * standing in for GET /network, /scenarios, /meta and /replay/calendar before
 * the shared API contracts are merged. Not from the API, not copied from the
 * shared fixtures, and not used once integration starts: delete this file then.
 *
 * Facts that come from the project, not from this file's imagination: the
 * three corridors, the six scenario IDs and their multipliers (Stage 1F), the
 * $500,000 single-transfer cap, and that the data ends on 2025-09-30. Venue
 * fees and capacities are made up.
 */
import type { ReferenceData } from "../features/newTransaction/types";

export const PREVIEW_REFERENCE: ReferenceData = {
  corridors: [
    {
      corridor: "USA->IND",
      senderCountry: "USA",
      receiverCountry: "IND",
      venues: [
        { bridgeUid: "USA->IND#0", feePct: 0.014, dataSourceTag: "real_static_bridge" },
        { bridgeUid: "USA->IND#1", feePct: 0.011, dataSourceTag: "synthetic_bridge_expansion" },
        { bridgeUid: "USA->IND#2", feePct: 0.022, dataSourceTag: "synthetic_bridge_expansion" },
      ],
    },
    {
      corridor: "GBR->PHL",
      senderCountry: "GBR",
      receiverCountry: "PHL",
      venues: [
        { bridgeUid: "GBR->PHL#0", feePct: 0.019, dataSourceTag: "real_static_bridge" },
        { bridgeUid: "GBR->PHL#1", feePct: 0.013, dataSourceTag: "synthetic_bridge_expansion" },
        { bridgeUid: "GBR->PHL#2", feePct: 0.028, dataSourceTag: "synthetic_bridge_expansion" },
      ],
    },
    {
      corridor: "ARE->MEX",
      senderCountry: "ARE",
      receiverCountry: "MEX",
      venues: [
        { bridgeUid: "ARE->MEX#0", feePct: 0.011, dataSourceTag: "synthetic_no_real_anchor" },
        { bridgeUid: "ARE->MEX#1", feePct: 0.008, dataSourceTag: "synthetic_bridge_expansion" },
        { bridgeUid: "ARE->MEX#2", feePct: 0.017, dataSourceTag: "synthetic_bridge_expansion" },
      ],
    },
  ],
  // Sorted by scenarioId, in ascending ordinal (code-point) order: the order GET /scenarios returns
  // them in since contract rev 5 (§2.7). The scenarios themselves are unchanged.
  scenarios: [
    { scenarioId: "baseline", description: "Unmodified synthetic bridge state." },
    { scenarioId: "cheapest_venue_outage", description: "The fee-cheapest venue of each corridor at 10% liquidity." },
    { scenarioId: "combined_stress", description: "Liquidity at 70% and congestion x1.5 on every venue." },
    { scenarioId: "congestion_x2", description: "Every venue's congestion doubled." },
    { scenarioId: "liquidity_minus30", description: "Every venue's liquidity scaled to 70%." },
    { scenarioId: "liquidity_minus50", description: "Every venue's liquidity scaled to 50%." },
  ],
  policies: [
    { policy: "waterfall", status: "default", enabled: true },
    { policy: "cheapestFeasible", status: "baseline", enabled: true },
    { policy: "ppoProjected", status: "experimental", enabled: false, disabledReason: "no approved checkpoint configured" },
  ],
  maxSingleTransferUsd: 500_000,
};

/**
 * What the mock service needs to stand in for the engine. Not part of the
 * form's reference data: the real engine holds these.
 */
export const PREVIEW_ENGINE_MODEL = {
  baselineCapacityUsd: {
    "USA->IND#0": 900_000,
    "USA->IND#1": 300_000,
    "USA->IND#2": 150_000,
    "GBR->PHL#0": 450_000,
    "GBR->PHL#1": 150_000,
    "GBR->PHL#2": 80_000,
    "ARE->MEX#0": 700_000,
    "ARE->MEX#1": 220_000,
    "ARE->MEX#2": 120_000,
  } as Record<string, number>,
  /** Stage 1F's uniform multipliers. `cheapest` applies to the fee-cheapest venue as well. */
  scenarioMultipliers: {
    baseline: { liquidity: 1, cheapest: 1 },
    liquidity_minus30: { liquidity: 0.7, cheapest: 1 },
    liquidity_minus50: { liquidity: 0.5, cheapest: 1 },
    cheapest_venue_outage: { liquidity: 1, cheapest: 0.1 },
    congestion_x2: { liquidity: 1, cheapest: 1 },
    combined_stress: { liquidity: 0.7, cheapest: 1 },
  } as Record<string, { liquidity: number; cheapest: number }>,
  /** Data ends on 2025-09-30 (project fact). The start is illustrative. */
  dateRange: { start: "2011-01-01", end: "2025-09-30" },
};
