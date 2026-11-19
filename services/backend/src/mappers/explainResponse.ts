import type { Policy } from "@prisma/client";
import { InferenceError } from "../inferenceClient/errors.js";
import { POLICY_TO_ENGINE } from "./routeRequest.js";

// The inference ExplainResponse (API contract §2.10) as the Application API
// Explanation (§3.5; app OpenAPI `Explanation`), without transactionId, which
// the route adds. Values are copied, never computed.
//
// - Built field by field from the documented fields only. An unknown engine
//   field is ignored (§1: responses are tolerant at run time), so the app body
//   never carries a field the closed Explanation schema doesn't define.
// - Unknown enum values (outcome, reason_code) are kept as they are, not
//   rejected (§1: consumers treat them generically).
// - policy must be the stored decision's policy, in engine spelling; the app
//   body uses the stored (camelCase) value.
// - Anything missing or of the wrong type throws InvalidExplainResponseError,
//   a 502 INFERENCE_ERROR naming field paths (for logs), never values. The
//   route turns it into 500 when the body came from the database instead.
// - The input is never mutated, so it can be stored verbatim (§6.1).

export class InvalidExplainResponseError extends InferenceError {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", "invalid_response", {
      upstreamStatus: 200,
    });
    this.name = "InvalidExplainResponseError";
    this.problems = problems;
  }
}

export interface MappedExplanation {
  /** The engine's decision_id, for the §3.5 comparison. */
  decisionId: string;
  /** The Explanation body without transactionId, in schema order. */
  body: Record<string, unknown>;
}

export function mapExplainResponse(engine: unknown, policy: Policy): MappedExplanation {
  const problems: string[] = [];
  const object = (value: unknown, path: string): Record<string, unknown> => {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
    problems.push(path);
    return {};
  };
  const array = (value: unknown, path: string): unknown[] => {
    if (Array.isArray(value)) return value;
    problems.push(path);
    return [];
  };
  const string = (value: unknown, path: string): string => {
    if (typeof value === "string") return value;
    problems.push(path);
    return "";
  };
  const boolean = (value: unknown, path: string): boolean => {
    if (typeof value === "boolean") return value;
    problems.push(path);
    return false;
  };
  const strings = (value: unknown, path: string): string[] =>
    array(value, path).map((item, i) => string(item, `${path}[${i}]`));

  const root = object(engine, "(body)");
  const decisionId = string(root.decision_id, "decision_id");
  if (decisionId === "" && !problems.includes("decision_id")) problems.push("decision_id");
  if (root.policy !== POLICY_TO_ENGINE[policy]) problems.push("policy");
  const summary = string(root.summary, "summary");

  const feasibility = object(root.feasibility, "feasibility");
  const allowed = boolean(feasibility.allowed, "feasibility.allowed");
  const reason = feasibility.reason === null ? null : string(feasibility.reason, "feasibility.reason");
  const activeFacts = array(feasibility.active_facts, "feasibility.active_facts").map((item, i) => {
    const path = `feasibility.active_facts[${i}]`;
    const fact = object(item, path);
    // value has no type in the schema; it must only be present.
    if (!Object.hasOwn(fact, "value")) problems.push(`${path}.value`);
    return {
      factId: string(fact.fact_id, `${path}.fact_id`),
      ruleType: string(fact.rule_type, `${path}.rule_type`),
      value: fact.value,
      provenanceTag: string(fact.provenance_tag, `${path}.provenance_tag`),
      verified: boolean(fact.verified, `${path}.verified`),
      source: string(fact.source, `${path}.source`),
    };
  });
  if (feasibility.provider !== "StaticMemoryProvider") problems.push("feasibility.provider");

  const venueExplanations = array(root.venue_explanations, "venue_explanations").map((item, i) => {
    const path = `venue_explanations[${i}]`;
    const venue = object(item, path);
    return {
      bridgeUid: string(venue.bridge_uid, `${path}.bridge_uid`),
      outcome: string(venue.outcome, `${path}.outcome`),
      reasonCode: string(venue.reason_code, `${path}.reason_code`),
      text: string(venue.text, `${path}.text`),
    };
  });
  const policyNotes = strings(root.policy_notes, "policy_notes");
  // Always null in v1 (C6, §2.10); the schema type is 'null'.
  if (root.semantic_context !== null) problems.push("semantic_context");
  const limitations = strings(root.limitations, "limitations");
  if (Array.isArray(root.limitations) && root.limitations.length === 0) problems.push("limitations");

  if (problems.length > 0) throw new InvalidExplainResponseError(problems);
  return {
    decisionId,
    body: {
      decisionId,
      policy,
      summary,
      feasibility: { allowed, reason, activeFacts, provider: "StaticMemoryProvider" },
      venueExplanations,
      policyNotes,
      semanticContext: null,
      limitations,
    },
  };
}
