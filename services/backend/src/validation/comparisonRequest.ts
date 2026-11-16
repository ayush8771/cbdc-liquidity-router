import {
  MESSAGES,
  POLICIES,
  validateTransactionRequest,
  type FieldError,
  type Policy,
  type StateSpec,
} from "./transactionRequest.js";

// The POST /api/v1/comparisons request (API contract §3.6): the §3.2
// transaction request with `policies: [...]` in place of `policy`.
//
// - Every §3.2 rule is applied by validateTransactionRequest itself, on the
//   body without `policies`: countries, amountUsd, state, clientReference,
//   unknown fields at every level, unsafe integers, and the precedence of
//   VALIDATION_ERROR over INVALID_AMOUNT.
// - `policy` is not a comparison field, so it is an unknown field here (§1:
//   requests are strict), whatever its value.
// - `policies`, when given, must be a non-empty array of policy names. Each
//   is a canonical name or one of the comparison aliases (COMPARISON_POLICY_ALIASES,
//   owner decision Q18), mapped to its canonical name in place, so the
//   caller's order is kept. Two entries naming the same canonical policy,
//   alias or not, are a duplicate. null is rejected (§3.6); only an omitted
//   `policies` takes the default.
// - Its problems join the other schema problems in one VALIDATION_ERROR, so
//   INVALID_AMOUNT is returned only when `policies` is valid too.
// - Messages are fixed sentences; none repeats a caller-supplied value.
//
// The default list for an omitted `policies` depends on the caller's role, so
// it is resolved by the route (resolveComparisonPolicies), not here.

/**
 * Comparison-only aliases (owner decision Q18): accepted in a request's
 * `policies`, mapped to the canonical name, and never stored or returned.
 */
export const COMPARISON_POLICY_ALIASES: Readonly<Record<string, Policy>> = Object.freeze({
  baseline: "waterfall",
  ruleBased: "cheapestFeasible",
});

/** Every name a comparison request may list: the canonical names, then the aliases. */
export const COMPARISON_POLICY_NAMES: readonly string[] = Object.freeze([
  ...POLICIES,
  ...Object.keys(COMPARISON_POLICY_ALIASES),
]);

/**
 * The policies compared when `policies` is omitted, in result order (owner
 * decision Q18): baseline (waterfall), ruleBased (cheapestFeasible), then
 * ppoProjected. A role that may not use the experimental policies gets this
 * list without them (§3.6).
 */
export const DEFAULT_COMPARISON_POLICIES: readonly Policy[] = Object.freeze([
  "waterfall",
  "cheapestFeasible",
  "ppoProjected",
] as const);

export const POLICIES_MESSAGES = Object.freeze({
  empty: "Must list at least one policy.",
  duplicate: "Must not repeat a policy; an alias names the same policy as its canonical name.",
  name: `Must be one of: ${COMPARISON_POLICY_NAMES.join(", ")}.`,
});

/** The canonical name for a comparison policy name or alias, or undefined. */
export function canonicalComparisonPolicy(name: unknown): Policy | undefined {
  if (typeof name !== "string") return undefined;
  if ((POLICIES as readonly string[]).includes(name)) return name as Policy;
  return Object.hasOwn(COMPARISON_POLICY_ALIASES, name) ? COMPARISON_POLICY_ALIASES[name] : undefined;
}

export interface ValidatedComparisonRequest {
  senderCountry: string;
  receiverCountry: string;
  amountUsd: number;
  state: StateSpec;
  /** Canonical names in the caller's order; undefined when omitted. */
  policies: Policy[] | undefined;
  clientReference: string | null;
}

/** A comparison with its policy list resolved: what is sent, stored and returned. */
export interface ComparisonRequest extends ValidatedComparisonRequest {
  policies: Policy[];
}

export type ComparisonValidationResult =
  | { ok: true; value: ValidatedComparisonRequest }
  | { ok: false; code: "VALIDATION_ERROR"; errors: FieldError[] }
  | { ok: false; code: "INVALID_AMOUNT"; field: "amountUsd" };

export function validateComparisonRequest(body: unknown): ComparisonValidationResult {
  // Not an object: the transaction validator's form-level error.
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return validateTransactionRequest(body) as ComparisonValidationResult;
  }
  const { policies: rawPolicies, policy: _policy, ...rest } = body as Record<string, unknown>;
  const base = validateTransactionRequest(rest);

  const errors: FieldError[] = [];
  if (Object.hasOwn(body, "policy")) errors.push({ field: "policy", message: MESSAGES.unknownField });

  let policies: Policy[] | undefined;
  if (Object.hasOwn(body, "policies")) {
    if (!Array.isArray(rawPolicies)) errors.push({ field: "policies", message: MESSAGES.array });
    else if (rawPolicies.length === 0) errors.push({ field: "policies", message: POLICIES_MESSAGES.empty });
    else {
      const canonical: Policy[] = [];
      rawPolicies.forEach((item: unknown, i) => {
        const policy = canonicalComparisonPolicy(item);
        if (policy === undefined) errors.push({ field: `policies[${i}]`, message: POLICIES_MESSAGES.name });
        else if (canonical.includes(policy)) errors.push({ field: `policies[${i}]`, message: POLICIES_MESSAGES.duplicate });
        else canonical.push(policy);
      });
      if (errors.length === 0) policies = canonical;
    }
  }

  if (!base.ok && base.code === "VALIDATION_ERROR") {
    return { ok: false, code: "VALIDATION_ERROR", errors: [...base.errors, ...errors] };
  }
  // Schema problems come before INVALID_AMOUNT (§3.2 precedence).
  if (errors.length > 0) return { ok: false, code: "VALIDATION_ERROR", errors };
  if (!base.ok) return base;
  const { senderCountry, receiverCountry, amountUsd, state, clientReference } = base.value;
  return { ok: true, value: { senderCountry, receiverCountry, amountUsd, state, policies, clientReference } };
}
