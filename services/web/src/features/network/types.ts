/*
 * UI display model for the Network page. Defined by the UI, like the other
 * feature models: components render these, and once the shared contracts are
 * merged a mapper converts GET /api/v1/network into them. The field names
 * follow the rev 5 contract's Network schema (camelCase) so that mapper
 * stays a straight copy, but this is not the API type and must not become one.
 *
 * What the endpoint does NOT carry, and so what this page cannot show: live
 * liquidity, congestion, or any availability or health. Those come from
 * GET /api/v1/state (the Bridge monitor).
 */
import type { DataSourceTag } from "../transactions/detailTypes";

export type VenueView = {
  /** The venue's position in its corridor. */
  slot: number;
  bridgeUid: string;
  /** A fraction, as the contract defines it: 0.015 is 1.5%. Never stored as a percentage. */
  feePct: number;
  /** Static reference metadata, not live liquidity. */
  baselineCapacityUsd: number;
  dataSourceTag: DataSourceTag;
};

export type CorridorView = {
  corridor: string;
  senderCountry: string;
  receiverCountry: string;
  venues: VenueView[];
};

export type NetworkView = {
  corridors: CorridorView[];
  maxSingleTransferUsd: number;
  /** As the API names it, for example "project_assumption". */
  maxSingleTransferProvenance: string;
};

/** UI descriptions of the data-source tags. Not official contract labels. */
export const DATA_SOURCE_NAMES: Record<DataSourceTag, string> = {
  real_static_bridge: "Real static bridge",
  synthetic_bridge_expansion: "Synthetic expansion",
  synthetic_no_real_anchor: "Synthetic — no real anchor",
};

/** An unknown tag is shown as written, never dropped. */
export function dataSourceName(tag: string): string {
  return (DATA_SOURCE_NAMES as Record<string, string>)[tag] ?? tag;
}

const PROVENANCE_NAMES: Record<string, string> = {
  project_assumption: "Project assumption",
};

/** An unknown provenance is shown as written. */
export function provenanceName(provenance: string): string {
  return PROVENANCE_NAMES[provenance] ?? provenance;
}

const fee = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A fee fraction as a percentage for display: 0.015 is "1.50%", 0.0105 is "1.05%". Does not change the value. */
export function formatFeeFraction(feePct: number): string {
  return fee.format(feePct);
}
