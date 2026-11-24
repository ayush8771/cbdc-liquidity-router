/*
 * UI display model for the Bridge monitor's live cards. Defined by the UI: the
 * components render these, and stateApi.ts converts GET /api/v1/state into
 * them. The names follow contract §2.5, but this is not the API type.
 *
 * What the endpoint does NOT carry, and so what the monitor cannot show:
 * availability, health or any bridge status. Every value is simulated.
 */
import type { DataSourceTag } from "../transactions/detailTypes";

export type VenueStateView = {
  slot: number;
  bridgeUid: string;
  /** A fraction, as the contract defines it: 0.02 is 2%. */
  feePct: number;
  liquidityUsd: number;
  /** The raw number the API gives. Its scale is not defined, so it is never shown as a percentage or a level. */
  congestion: number;
  dataSourceTag: DataSourceTag;
  /** For example "synthetic_simulation". Unknown values are shown as written. */
  valuesProvenance: string;
};

export type CorridorStateView = {
  corridor: string;
  mode: "historicalReplay" | "scenario" | string;
  /** YYYY-MM-DD. */
  date: string;
  /** train, validation or test. */
  split: string;
  scenarioId: string | null;
  /** The raw number the API gives. */
  corridorRisk: number;
  /** The raw number the API gives: its unit is not stated in the contract. */
  baselineCostPct: number;
  venues: VenueStateView[];
  warnings: { code: string; message: string }[];
};

export type MonitorMode = "historicalReplay" | "scenario";

export const MODE_NAMES: Record<MonitorMode, string> = {
  historicalReplay: "Historical replay",
  scenario: "Scenario",
};

/** An unknown mode is shown as written. */
export function modeName(mode: string): string {
  return (MODE_NAMES as Record<string, string>)[mode] ?? mode;
}

const PROVENANCE_NAMES: Record<string, string> = {
  synthetic_simulation: "Synthetic simulation",
  synthetic_scenario: "Synthetic scenario",
  user_supplied_synthetic: "User-supplied synthetic",
};

/** What the values come from. An unknown value is shown as written, never dropped. */
export function valuesProvenanceName(provenance: string): string {
  return PROVENANCE_NAMES[provenance] ?? provenance;
}
