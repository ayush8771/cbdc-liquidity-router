/*
 * LOCAL test fixtures for the observation panel, written from AD-1 v0.5 §3.2 and the AD-4 §10
 * example. They are not the official contract schemas or fixtures (those are Dev D's, §3.7) and
 * must not be copied into contracts/. Rates are deliberately unrealistic, as in AD-4 §10.
 */
export const PROFILE = {
  expected_interval_ms: 2000,
  live_max_age_ms: null,
  stale_after_ms: 6000,
  unavailable_after_ms: 30000,
  clock_tolerance_ms: 1000,
};

export const PAIR_LIST: Array<[string, string]> = [
  ["AED", "MXN"],
  ["EUR", "USD"],
  ["GBP", "PHP"],
  ["USD", "INR"],
];

type Obj = Record<string, unknown>;

/** An AD-4 §10 style `fx_rate` envelope for a pair; `over` replaces top-level fields. */
export function makeEvent(base: string, quote: string, rate = "1.2345", over: Obj = {}): Obj {
  return {
    schema_version: "1.0",
    event_id: "018f0000-0000-7000-8000-000000000001",
    event_type: "fx_rate",
    usage: "display_only",
    source: { source_id: "synthetic.fx", transport: "synthetic", source_url: null, gate3_decision_ref: null },
    provenance_class: "synthetic",
    derived_from: [],
    derivation: null,
    timestamps: {
      source_timestamp: "2026-11-24T10:00:00.000Z",
      source_timestamp_basis: "observed",
      retrieved_at: "2026-11-24T10:00:00.050Z",
      emitted_at: "2026-11-24T10:00:00.060Z",
    },
    source_sequence: "1",
    payload: { base_currency: base, quote_currency: quote, rate, rate_type: "mid" },
    payload_sha256: "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4",
    raw_sha256: null,
    validation: { status: "validated", reasons: [] },
    extraction: null,
    review: null,
    supersedes: null,
    synthetic: { generator_version: "0.0.0-example", seed: 1, case_id: "normal" },
    ...over,
  };
}

/** A `value` of §3.2. Pass `ageMs: null` for a never-received value. */
export function makeValue(base: string, quote: string, ageMs: number | null, freshness: string, rate = "1.2345", eventOver: Obj = {}): Obj {
  return {
    base_currency: base,
    quote_currency: quote,
    event: ageMs === null ? null : makeEvent(base, quote, rate, eventOver),
    age_ms: ageMs,
    freshness,
  };
}

export function freshValues(ageMs = 1000): Obj[] {
  return PAIR_LIST.map(([b, q], i) => makeValue(b, q, ageMs, "fresh", `${i + 1}.2345`));
}

const base = (type: string, seq: number, status = "ok"): Obj => ({
  protocol_version: "1.0",
  type,
  stream_seq: seq,
  server_time: "2026-11-24T10:00:01.000Z",
  source: { source_id: "synthetic.fx", status },
});

export const snapshot = (seq = 1, values: Obj[] = freshValues(), over: Obj = {}): Obj => ({
  ...base("snapshot", seq),
  profile: PROFILE,
  values,
  ...over,
});
export const update = (seq: number, value: Obj, over: Obj = {}): Obj => ({ ...base("update", seq), value, ...over });
export const heartbeat = (seq: number, status = "ok"): Obj => base("heartbeat", seq, status);

/** One SSE event on the wire: `event: <type>` and one `data:` line. */
export function sse(message: Obj, eventName?: string): string {
  return `event: ${eventName ?? String(message.type)}\ndata: ${JSON.stringify(message)}\n\n`;
}

/** A Response whose body the test feeds by hand. */
export function streamResponse(init: { status?: number; headers?: Record<string, string> } = {}) {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const response = new Response(body, {
    status: init.status ?? 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", ...(init.headers ?? {}) },
  });
  return {
    response,
    push: (text: string) => controller.enqueue(encoder.encode(text)),
    pushBytes: (bytes: Uint8Array) => controller.enqueue(bytes),
    end: () => controller.close(),
    fail: () => controller.error(new TypeError("network error")),
  };
}
