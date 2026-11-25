/*
 * Runs the shared stream-message fixtures (contracts/events/fixtures/stream-message/, Dev D's) through the
 * real client decoder, read straight from disk and never copied. Each fixture has an explicit expected
 * outcome; a fixture that is added, removed or renamed fails the file-set test until it is classified.
 *
 * "invalid" in a fixture means the PRODUCER schema rejects it. The client is deliberately more lenient
 * in five cases (AD-1 v0.5 §3.3.3); those have their own named tests below.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeMessage, parseProfile, type DecodeContext } from "../../src/features/observations/validate";
import type { Profile } from "../../src/features/observations/types";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../contracts/events/fixtures/stream-message");

type Fixture = { description: string; valid: boolean; reason: string; instance: Record<string, unknown> };
const load = (name: string): Fixture => JSON.parse(readFileSync(resolve(DIR, name), "utf8")) as Fixture;

/** Event name and last accepted sequence come from the fixture. A snapshot is the first message on a connection, so it has lastSeq 0 and no profile yet. */
function decode(name: string) {
  const { instance } = load(name);
  const type = instance.type as string;
  const profile = parseProfile(load("valid_snapshot.json").instance.profile) as Profile;
  const ctx: DecodeContext = { lastSeq: type === "snapshot" ? 0 : (instance.stream_seq as number) - 1, profile: type === "snapshot" ? null : profile };
  return decodeMessage(type, JSON.stringify(instance), ctx);
}

type Kind = "snapshot" | "update" | "heartbeat";
const VALID: Record<string, Kind> = {
  "valid_heartbeat_outage.json": "heartbeat",
  "valid_snapshot.json": "snapshot",
  "valid_snapshot_all_unavailable.json": "snapshot",
  "valid_update.json": "update",
  "valid_update_stale_value.json": "update",
  "valid_update_unavailable_value.json": "update",
};
// The decoder's reason text is asserted only where it is stable; null means "assert the kind only".
const REJECTED: Record<string, { kind: "fault" | "stop"; reason: string | null }> = {
  "invalid_missing_source.json": { kind: "fault", reason: "source missing or malformed" },
  // The code is stricter than the §3.3.3 list, which names only a missing or mistyped source.
  "invalid_unknown_source_status.json": { kind: "fault", reason: "source missing or malformed" },
  "invalid_server_time_format.json": { kind: "fault", reason: "server_time is not a timestamp" },
  "invalid_protocol_version_major_2.json": { kind: "stop", reason: "unsupported_version" },
  "invalid_stream_seq_zero.json": { kind: "fault", reason: "first stream_seq is not 1" },
  "invalid_profile_null_unavailable_after.json": { kind: "fault", reason: "profile missing, malformed, out of order or without a withdrawal threshold" },
  "invalid_profile_stale_after_unavailable.json": { kind: "fault", reason: "profile missing, malformed, out of order or without a withdrawal threshold" },
  "invalid_snapshot_three_values.json": { kind: "fault", reason: "snapshot does not carry exactly four values" },
  "invalid_snapshot_wrong_order.json": { kind: "fault", reason: "values are not the four pairs in order" },
  "invalid_fresh_but_age_over_stale.json": { kind: "fault", reason: "freshness disagrees with the age and profile" },
  "invalid_stale_but_age_under_stale.json": { kind: "fault", reason: "freshness disagrees with the age and profile" },
  "invalid_age_over_unavailable_with_event.json": { kind: "fault", reason: "freshness disagrees with the age and profile" },
  "invalid_fresh_with_null_event.json": { kind: "fault", reason: "a value with no event must be unavailable with no age" },
  // Faults through the freshness recompute (age 0 is fresh), not through a dedicated "event must be null" check.
  "invalid_unavailable_with_event.json": { kind: "fault", reason: null },
};
const TOLERATED = [
  "invalid_unknown_type.json",
  "invalid_heartbeat_with_value.json",
  "invalid_update_extra_field.json",
  "invalid_event_wrong_hash.json",
  "invalid_update_pair_mismatch.json",
];

describe("shared stream-message fixtures", () => {
  it("covers exactly the classified file set", () => {
    const expected = [...Object.keys(VALID), ...Object.keys(REJECTED), ...TOLERATED].sort();
    expect(readdirSync(DIR).sort()).toEqual(expected);
    expect(new Set(expected).size).toBe(expected.length);
  });

  it("every fixture keeps the shared format (invalid ones carry a reason) and a valid/invalid file-name prefix", () => {
    for (const name of readdirSync(DIR)) {
      const f = load(name);
      expect(Object.keys(f).sort(), name).toEqual(f.valid ? ["description", "instance", "valid"] : ["description", "instance", "reason", "valid"]);
      expect(f.valid, name).toBe(name.startsWith("valid_"));
    }
  });

  it.each(Object.entries(VALID))("valid fixture %s decodes as %s", (name, kind) => {
    expect(decode(name).kind).toBe(kind);
  });

  it.each(Object.entries(REJECTED))("producer-invalid fixture %s is rejected by the client", (name, want) => {
    const got = decode(name);
    expect(got.kind).toBe(want.kind);
    if (want.reason !== null) expect(got).toMatchObject({ reason: want.reason });
  });
});

describe("intentional client tolerance: the producer schema rejects, the client accepts (AD-1 §3.3.3)", () => {
  it("invalid_unknown_type: an unknown type is ignored and its stream_seq still counts", () => {
    expect(decode("invalid_unknown_type.json")).toEqual({ kind: "ignored", seq: 5 });
  });

  it("invalid_heartbeat_with_value: an extra field on a heartbeat is not read and is no fault", () => {
    expect(decode("invalid_heartbeat_with_value.json")).toMatchObject({ kind: "heartbeat", seq: 4, source: { sourceId: "synthetic.fx", status: "ok" } });
  });

  it("invalid_update_extra_field: an unknown extra field is ignored and the value is shown", () => {
    expect(decode("invalid_update_extra_field.json")).toMatchObject({
      kind: "update",
      value: { base: "EUR", quote: "USD", rate: "0.9876", withheld: false, unavailable: false },
    });
  });

  it("invalid_event_wrong_hash: the client never checks payload_sha256 (Express owns it, §3.4)", () => {
    expect(decode("invalid_event_wrong_hash.json")).toMatchObject({
      kind: "update",
      value: { base: "EUR", quote: "USD", rate: "0.9876", withheld: false, unavailable: false },
    });
  });

  it("invalid_update_pair_mismatch: the mismatched value is withheld, not a fault", () => {
    expect(decode("invalid_update_pair_mismatch.json")).toMatchObject({
      kind: "update",
      value: { base: "GBP", quote: "PHP", rate: null, withheld: true, unavailable: true },
    });
  });
});
