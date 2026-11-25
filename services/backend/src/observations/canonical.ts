import { createHash } from "node:crypto";

// RFC 8785 (JCS) canonical form, limited to what AD-4's `payload_sha256`
// input needs in this slice: objects and printable-ASCII strings (AD-1 §3.7,
// P-9; no new dependency). For that subset RFC 8785 is exactly: keys sorted
// by UTF-16 code unit (identical to byte order for ASCII), no whitespace, and
// strings escaped as JSON.stringify escapes them (printable ASCII needs only
// `"` and `\`). Anything outside the subset throws, so an unsupported input
// can never be hashed in a form the Python side would not produce.

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function canonicalize(value: unknown): string {
  if (typeof value === "string") {
    if (!PRINTABLE_ASCII.test(value)) throw new CanonicalizationError("only printable ASCII strings are supported");
    return JSON.stringify(value);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new CanonicalizationError("only plain objects are supported");
    }
    const keys = Object.keys(value).sort(compareCodeUnits);
    const parts = keys.map((key) => `${canonicalize(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new CanonicalizationError("only objects and ASCII strings are supported");
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** AD-4 §2: SHA-256 of the RFC 8785 form of {"event_type", "payload"}, lowercase hex. */
export function payloadSha256(eventType: string, payload: unknown): string {
  return createHash("sha256").update(canonicalize({ event_type: eventType, payload }), "utf8").digest("hex");
}
