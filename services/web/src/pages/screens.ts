import type { MandatoryLabelKey } from "../lib/labels";

export type ScreenSpec = {
  path: string;
  eyebrow: string;
  title: string;
  description: string;
  /** Application API operations this screen will use (contract §3.1). */
  endpoints: string[];
  /** Labels that apply to every value on the screen. */
  labels?: Exclude<MandatoryLabelKey, "devAuthBanner">[];
  showCarryOverNote?: boolean;
};

// Purpose of each screen from arch §3 (Dev C) and roadmap §3.C; endpoints
// from contract §3.1. No fields or workflows are implied beyond those.
// Dashboard and History have their own preview pages (pages/DashboardPage.tsx,
// pages/HistoryPage.tsx); the screens below are still placeholders.
export const SCREENS: ScreenSpec[] = [
  {
    path: "/transactions/new",
    eyebrow: "Route",
    title: "New transaction",
    description:
      "Route a transaction on a historical replay date, a stress scenario or a user-supplied synthetic state, with the policy you choose.",
    endpoints: [
      "POST /api/v1/transactions",
      "GET /api/v1/replay/calendar",
      "GET /api/v1/scenarios",
      "GET /api/v1/network",
      "GET /api/v1/meta",
    ],
    showCarryOverNote: true,
  },
  {
    path: "/compare",
    eyebrow: "Evaluate",
    title: "Compare policies",
    description: "Run several policies on one transaction against the same state, side by side.",
    endpoints: ["POST /api/v1/comparisons", "GET /api/v1/comparisons/{id}"],
    labels: ["placeholderWeights"],
  },
  {
    path: "/network",
    eyebrow: "Reference",
    title: "Network",
    description: "Supported corridors and their bridge venues, with fees, baseline capacity and data source.",
    endpoints: ["GET /api/v1/network"],
  },
  {
    path: "/bridges",
    eyebrow: "Monitor",
    title: "Bridge monitor",
    description: "Liquidity and congestion for each venue of a corridor, on a replay or scenario date.",
    endpoints: ["GET /api/v1/state"],
    labels: ["simulated"],
  },
];
