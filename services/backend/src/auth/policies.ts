import type { Role } from "../config/devTokens.js";
import { ApiError } from "../middleware/errors.js";

// Role rule (API contract §3.0, arch §8.2): only analysts may request
// ppoProjected, alone or in a comparison. Enforced on the server.

export const EXPERIMENTAL_POLICIES: readonly string[] = ["ppoProjected"];

export function canUseExperimentalPolicies(role: Role): boolean {
  return role === "analyst";
}

/**
 * Throws 403 FORBIDDEN_POLICY if the caller's role may not request one of the
 * given Application API policy names.
 */
export function authorizePolicies(user: { role: Role }, policies: readonly string[]): void {
  if (canUseExperimentalPolicies(user.role)) return;
  if (policies.some((policy) => EXPERIMENTAL_POLICIES.includes(policy))) {
    throw new ApiError(403, "FORBIDDEN_POLICY", "Only analysts may request ppoProjected.");
  }
}
