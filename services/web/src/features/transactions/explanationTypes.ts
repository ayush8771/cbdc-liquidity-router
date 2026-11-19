/*
 * UI display model for the Explanation card. Defined by the UI: the card
 * renders these, and explanationApi.ts converts the API body into them. The
 * names follow contract §3.5, but this is not the API type.
 */

export type ExplanationFactView = {
  factId: string;
  ruleType: string;
  /** The fact's value as text. The contract gives `value` no type, so it is never assumed to be a number. */
  valueText: string;
  provenanceTag: string;
  verified: boolean;
  source: string;
};

export type VenueExplanationView = {
  bridgeUid: string;
  /** "used" or "unused" in v1; an unknown value is shown as written. */
  outcome: string;
  reasonCode: string;
  text: string;
};

export type ExplanationView = {
  decisionId: string;
  summary: string;
  feasibility: {
    allowed: boolean;
    reason: string | null;
    facts: ExplanationFactView[];
    provider: string;
  };
  venues: VenueExplanationView[];
  /** Required reading for a PPO decision: the shares come from a learned policy with no causal explanation. */
  policyNotes: string[];
  limitations: string[];
};
