import type { IconName } from "../components/ui/Icon";

export type NavEntry = {
  to: string;
  label: string;
  icon: IconName;
};

// One entry per screen in arch §3 (Dev C) backed by an Application API
// endpoint (contract §3.1). Transaction detail is reached from History.
export const NAVIGATION: NavEntry[] = [
  { to: "/", label: "Dashboard", icon: "dashboard" },
  { to: "/transactions/new", label: "New transaction", icon: "route" },
  { to: "/transactions", label: "History", icon: "history" },
  { to: "/compare", label: "Compare policies", icon: "compare" },
  { to: "/network", label: "Network", icon: "network" },
  { to: "/bridges", label: "Bridge monitor", icon: "gauge" },
];
