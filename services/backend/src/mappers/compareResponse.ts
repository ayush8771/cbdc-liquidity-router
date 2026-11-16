import { InferenceError } from "../inferenceClient/errors.js";
import type { ComparisonRequest } from "../validation/comparisonRequest.js";
import type { Policy, StateSpec } from "../validation/transactionRequest.js";
import { POLICY_TO_ENGINE, toRouteRequest } from "./routeRequest.js";
import { InvalidRouteResponseError, mapRouteResponse, POLICY_FROM_ENGINE } from "./routeResponse.js";

// POST /v1/compare (API contract §2.9) for the Application API comparison
// (§3.6): the request sent, and the 200 body validated and mapped.
//
// Request: the /v1/route body with `policies` in place of `policy`. The list
// is always sent, already resolved, so the engine never applies its own
// default ("every enabled policy").
//
// Response:
// - Each result is a RouteResponse for one policy, validated and mapped by
//   mapRouteResponse against the request with that policy. The app `results`
//   entries are its `decision` (§3.6: "results: [decision...]").
// - `results` follow the order of the request's policies (approved Q18
//   decision), whatever order the engine used. `skipped` follows it too.
// - A result or skipped entry must name a policy that was sent, and at most
//   once; every policy sent must be reported in one of the two. So a result for
//   any policy that was not asked for, such as an unprojected PPO, is refused.
// - Every result must report the same corridor and the same
//   state_frame_sha256 (§2.9: one state frame), and same_state must be true.
// - Effective state (§3.6, owner decision Q18): every result's provenance must
//   confirm the state that was sent: state_mode and transaction.simulation_date
//   (checked by mapRouteResponse), provenance.state_date (the date, or the
//   reference date in explicit mode) and provenance.scenario_id (the scenario,
//   or null in the other modes). The returned `state` is that confirmed,
//   validated state spec. When every policy is skipped, no result can confirm
//   it, and it is the validated state spec as sent.
// - skipped[].message is the engine's text, passed through unchanged (owner
//   decision Q18). A skipped entry is part of a 201 body, not an error, so
//   §4's fixed-message rule doesn't apply. skipped[].code must look like an
//   error code; a documented code or not, it is kept as it is (§1: at run
//   time an unknown enum value is treated generically, never rejected).
// - Anything else throws InvalidCompareResponseError, a 502 INFERENCE_ERROR
//   naming field paths (for logs), never values.
// - The input is never mutated, so it can be stored verbatim (§6.1).

type JsonObject = Record<string, unknown>;

export function toCompareRequest(request: ComparisonRequest): JsonObject {
  // The transaction and state exactly as /v1/route gets them.
  const { policy: _policy, ...rest } = toRouteRequest({ ...request, policy: "waterfall" });
  return { ...rest, policies: request.policies.map((policy) => POLICY_TO_ENGINE[policy]) };
}

export class InvalidCompareResponseError extends InferenceError {
  /** Field paths and what was wrong, for logs. Never contains values. */
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(502, "INFERENCE_ERROR", "The inference service returned an invalid response.", "invalid_response", {
      upstreamStatus: 200,
    });
    this.name = "InvalidCompareResponseError";
    this.problems = problems;
  }
}

export interface ComparisonResult {
  policy: Policy;
  /** The §3.2 `decision` for this policy. */
  decision: JsonObject;
  /** provenance.checkpoint.sha256, or null. */
  checkpointSha256: string | null;
}

export interface SkippedPolicy {
  policy: Policy;
  code: string;
  message: string;
}

export interface MappedComparison {
  /** From the results; null when every policy was skipped (§3.6). Never derived. */
  corridor: string | null;
  /** The effective state: the validated state spec, confirmed by every result's provenance. */
  state: StateSpec;
  /** In the order of the request's policies. */
  results: ComparisonResult[];
  /** In the order of the request's policies. */
  skipped: SkippedPolicy[];
  note: string;
}

const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

export function mapCompareResponse(body: unknown, request: ComparisonRequest): MappedComparison {
  const problems: string[] = [];
  if (!isObject(body)) throw new InvalidCompareResponseError(["(body): must be an object"]);

  const results = new Map<Policy, ComparisonResult>();
  const corridors = new Set<string>();
  const stateFrames = new Set<string>();
  // The app policy an entry names, if it was sent and isn't reported yet.
  const reported = new Set<Policy>();
  const entryPolicy = (value: unknown, path: string): Policy | undefined => {
    const policy = typeof value === "string" && Object.hasOwn(POLICY_FROM_ENGINE, value) ? POLICY_FROM_ENGINE[value] : undefined;
    if (policy === undefined) problems.push(`${path}: has an unknown value`);
    else if (!request.policies.includes(policy)) problems.push(`${path}: was not requested`);
    else if (reported.has(policy)) problems.push(`${path}: is reported more than once`);
    else {
      reported.add(policy);
      return policy;
    }
    return undefined;
  };

  if (!Array.isArray(body.results)) problems.push("results: must be an array");
  else {
    body.results.forEach((entry: unknown, i) => {
      const path = `results[${i}]`;
      if (!isObject(entry)) return void problems.push(`${path}: must be an object`);
      const policy = entryPolicy(entry.policy, `${path}.policy`);
      if (policy === undefined) return;
      confirmState(entry, request.state, path, problems);
      try {
        const mapped = mapRouteResponse(entry, { ...request, policy });
        corridors.add(mapped.columns.corridor);
        stateFrames.add(mapped.columns.decision.stateFrameSha256);
        results.set(policy, {
          policy,
          decision: mapped.decision,
          checkpointSha256: mapped.columns.decision.checkpointSha256,
        });
      } catch (error) {
        if (!(error instanceof InvalidRouteResponseError)) throw error;
        problems.push(...error.problems.map((p) => `${path}.${p}`));
      }
    });
  }

  const skipped = new Map<Policy, SkippedPolicy>();
  if (!Array.isArray(body.skipped)) problems.push("skipped: must be an array");
  else {
    body.skipped.forEach((entry: unknown, i) => {
      const path = `skipped[${i}]`;
      if (!isObject(entry)) return void problems.push(`${path}: must be an object`);
      const policy = entryPolicy(entry.policy, `${path}.policy`);
      const code = typeof entry.code === "string" && CODE.test(entry.code) ? entry.code : undefined;
      if (code === undefined) problems.push(`${path}.code: must be an error code`);
      const message = typeof entry.message === "string" ? entry.message : undefined;
      if (message === undefined) problems.push(`${path}.message: must be a string`);
      if (policy === undefined || code === undefined || message === undefined) return;
      skipped.set(policy, { policy, code, message });
    });
  }

  if (Array.isArray(body.results) && Array.isArray(body.skipped) && request.policies.some((p) => !reported.has(p))) {
    problems.push("(body): a requested policy is in neither results nor skipped");
  }
  if (corridors.size > 1) problems.push("results: transaction.corridor differs between results");
  if (stateFrames.size > 1) problems.push("results: provenance.state_frame_sha256 differs between results");
  if (body.same_state !== true) problems.push("same_state: must be true");
  if (typeof body.note !== "string") problems.push("note: must be a string");

  if (problems.length > 0) throw new InvalidCompareResponseError(problems);
  const [corridor = null] = corridors;
  return {
    corridor,
    state: request.state,
    results: request.policies.flatMap((p) => results.get(p) ?? []),
    skipped: request.policies.flatMap((p) => skipped.get(p) ?? []),
    note: body.note as string,
  };
}

// provenance.state_date and provenance.scenario_id against the state sent.
// The rest of the state is checked by mapRouteResponse. A missing provenance
// object is reported there, so it is skipped here.
function confirmState(entry: JsonObject, state: StateSpec, path: string, problems: string[]): void {
  const provenance = entry.provenance;
  if (!isObject(provenance)) return;
  const date = state.mode === "explicit" ? state.referenceDate : state.date;
  if (provenance.state_date !== date) problems.push(`${path}.provenance.state_date: differs from the requested state`);
  const scenarioId = state.mode === "scenario" ? state.scenarioId : null;
  if (provenance.scenario_id !== scenarioId) problems.push(`${path}.provenance.scenario_id: differs from the requested state`);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
