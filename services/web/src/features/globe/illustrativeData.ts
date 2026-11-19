import type { GlobeConnection, GlobeLocation } from "./types";

/*
 * ILLUSTRATIVE DATA. These are the six countries of the three corridors in the
 * project's network (API contract §1: USA->IND, GBR->PHL, ARE->MEX), placed at
 * approximate capital-city coordinates. The globe shows where the corridors
 * are, not whether they are available: nothing here is live, and no bridge
 * status, liquidity or availability exists in this data.
 */
export const ILLUSTRATIVE_LOCATIONS: GlobeLocation[] = [
  { id: "USA", name: "United States", lat: 38.9, lon: -77.04 }, // Washington, D.C.
  { id: "IND", name: "India", lat: 28.61, lon: 77.21 }, // New Delhi
  { id: "GBR", name: "United Kingdom", lat: 51.51, lon: -0.13 }, // London
  { id: "PHL", name: "Philippines", lat: 14.6, lon: 120.98 }, // Manila
  { id: "ARE", name: "United Arab Emirates", lat: 24.45, lon: 54.38 }, // Abu Dhabi
  { id: "MEX", name: "Mexico", lat: 19.43, lon: -99.13 }, // Mexico City
];

/** A connection plus the corridor code it stands for, as the API names it. */
export type IllustrativeCorridor = GlobeConnection & { corridor: string };

export const ILLUSTRATIVE_CORRIDORS: IllustrativeCorridor[] = [
  { id: "usa-ind", corridor: "USA->IND", from: "USA", to: "IND" },
  { id: "gbr-phl", corridor: "GBR->PHL", from: "GBR", to: "PHL" },
  { id: "are-mex", corridor: "ARE->MEX", from: "ARE", to: "MEX" },
];
