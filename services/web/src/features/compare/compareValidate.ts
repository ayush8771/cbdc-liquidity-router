import type { Role } from "../../api/types";
import type { FieldErrors, FormValues, ReferenceData } from "../newTransaction/types";
import { validateForm } from "../newTransaction/validate";
import { POLICY_NAMES, type PolicyKey } from "../transactions/types";
import { toComparePayload, type ComparePayload } from "./compareApi";

export const MIN_POLICIES = 2;

/**
 * Checks the comparison form: the transaction fields exactly as the New
 * Transaction form checks them (validateForm), then the chosen policies. At
 * least two are needed, each can be chosen once (the checklist guarantees it), and
 * the experimental policy is for analysts only (a viewer who sends it gets 403).
 * Whether the engine can run a chosen policy is not decided here: it is skipped
 * and shown as skipped, never an error.
 */
export function validateCompare(
  values: FormValues,
  reference: ReferenceData,
  policies: PolicyKey[],
  role: Role | undefined,
): { errors: FieldErrors; payload: ComparePayload | null } {
  // The transaction form's own check, with its single policy set aside.
  const base = validateForm({ ...values, policy: "waterfall" }, reference);
  const errors: FieldErrors = { ...base.errors };
  delete errors.policy;

  if (policies.length < MIN_POLICIES) {
    errors.policies = `Choose at least ${MIN_POLICIES === 2 ? "two" : MIN_POLICIES} policies to compare.`;
  } else if (policies.some((p) => !Object.hasOwn(POLICY_NAMES, p) || !reference.policies.some((r) => r.policy === p))) {
    errors.policies = "Choose only the listed policies.";
  } else if (policies.includes("ppoProjected") && role !== "analyst") {
    errors.policies = "Only analysts can compare the experimental policy.";
  }

  if (Object.keys(errors).length > 0 || !base.payload) return { errors, payload: null };
  return { errors, payload: toComparePayload(base.payload, policies) };
}
