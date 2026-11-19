/*
 * UI models for the New Transaction screen. Defined by the UI, like
 * ../transactions/types.ts: the field names follow the rev 5 contract
 * (CreateTransactionRequest, ErrorResponse) so a mapper from the generated API
 * types stays a straight copy, but these are not the API types. Do not grow
 * them into hand-written API types.
 */
import type { DataSourceTag, TransactionDetailView } from "../transactions/detailTypes";
import type { PolicyKey, PolicyTier, StateModeKey } from "../transactions/types";

// ---------- reference data (what the form's choices come from) ----------

export type VenueRef = {
  bridgeUid: string;
  /** A fraction, as the contract defines `feePct` (0.015 is 1.5%). Used here only to order venues, cheapest first. */
  feePct: number;
  dataSourceTag: DataSourceTag;
};

export type CorridorRef = {
  corridor: string;
  senderCountry: string;
  receiverCountry: string;
  venues: VenueRef[];
};

export type ScenarioRef = { scenarioId: string; description: string };

export type PolicyRef = {
  policy: PolicyKey;
  status: PolicyTier;
  enabled: boolean;
  disabledReason?: string;
};

/** From GET /network, /scenarios and /meta once integrated. */
export type ReferenceData = {
  corridors: CorridorRef[];
  scenarios: ScenarioRef[];
  policies: PolicyRef[];
  maxSingleTransferUsd: number;
};

// ---------- form ----------

export type VenueInput = { bridgeUid: string; liquidityUsd: string; congestion: string };

/** Everything is text while the user types; validation turns it into a payload. */
export type FormValues = {
  corridor: string;
  amountUsd: string;
  policy: PolicyKey;
  clientReference: string;
  mode: StateModeKey;
  /** Replay and scenario modes. YYYY-MM-DD. */
  date: string;
  scenarioId: string;
  /** Explicit mode. YYYY-MM-DD. */
  referenceDate: string;
  venues: VenueInput[];
};

/**
 * Field errors keyed by form field: "corridor", "amountUsd", "policy",
 * "clientReference", "mode", "date", "scenarioId", "referenceDate", and
 * "venues.<index>.liquidityUsd|congestion|bridgeUid".
 */
export type FieldErrors = Record<string, string>;

/** What would be sent to POST /api/v1/transactions. */
export type TransactionPayload = {
  senderCountry: string;
  receiverCountry: string;
  amountUsd: number;
  state:
    | { mode: "historicalReplay"; date: string }
    | { mode: "scenario"; date: string; scenarioId: string }
    | { mode: "explicit"; referenceDate: string; venues: { bridgeUid: string; liquidityUsd: number; congestion: number }[] };
  policy: PolicyKey;
  clientReference?: string;
};

// ---------- submission result ----------

export type ServerError = {
  status: number;
  code: string;
  message: string;
  details: {
    /** VALIDATION_ERROR only. A form-level error has no field. */
    errors?: { field?: string; message: string }[];
    /** Tolerated if present; never relied on. */
    field?: string;
    /** Set on persisted (5xx) failures only. */
    transactionId?: string;
    /**
     * Set only on a 503 INFERENCE_UNAVAILABLE, and only when the engine said it
     * wasn't ready yet ("NOT_READY": still starting up). Contract §4. Any other
     * value, or this on any other code, means nothing here and is ignored.
     */
    cause?: string;
  };
  requestId: string;
};

export type SubmitResult =
  | { kind: "routed"; transaction: TransactionDetailView }
  | { kind: "error"; error: ServerError };

/** The form-level message shown above the Submit button. */
export type FormErrorView = {
  title: string;
  messages: string[];
  code: string;
  requestId: string;
};
