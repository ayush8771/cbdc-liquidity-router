// A valid GET /v1/version body shaped after API contract §2.2: test data, not a
// fixture. The shared cache validates every /v1/version body before storing it
// (src/mappers/versionResponse.ts), so tests that only care about one field
// override it here and keep the rest valid.
export function engineVersionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: "v1",
    engine_version: "0.1.0",
    phase1_baseline_tag: "phase1-complete",
    git_commit: "bc9905e",
    default_policy: "waterfall",
    policies: [
      { policy: "waterfall", status: "default", enabled: true },
      { policy: "cheapest_feasible", status: "baseline", enabled: true },
      { policy: "ppo_projected", status: "experimental", enabled: false, disabled_reason: "no approved checkpoint configured" },
    ],
    checkpoint: null,
    knowledge: { knowledge_version: "2026-11-02.1", sha256: "e".repeat(64) },
    data: {
      daily_state_sha256: "1".repeat(64),
      bridge_network_sha256: "2".repeat(64),
      normalization_stats_sha256: "3".repeat(64),
      macro_risk_proxy_sha256: "4".repeat(64),
      rpw_corridor_quarterly_sha256: "5".repeat(64),
      scenarios_sha256: "6".repeat(64),
      date_range: { start: "2011-01-01", end: "2025-09-30" },
    },
    reward_weights: { lambda_latency: 1.0, lambda_risk: 1.0, lambda_unrouted: 1.0, status: "placeholder" },
    runtime: { platform: "linux-x86_64", python: "3.10.11", torch: "2.13.0+cpu", device: "cpu", lock_file: "x.txt" },
    ...overrides,
  };
}
