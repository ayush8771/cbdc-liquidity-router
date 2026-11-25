import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { canonicalize, payloadSha256 } from "../../src/observations/canonical.js";

// AD-1 v0.5 §3.7: Python and TypeScript must give the same verdict on the
// shared payload-hash vectors. The file is read in place from contracts/ (it is
// owned by the platform branch, merged with PR #15), never copied here. A
// missing or malformed file fails this test: it is not skipped.
const VECTORS_URL = new URL("../../../../contracts/test-vectors/event_payload_hash.v1.json", import.meta.url);

interface Vector {
  name: string;
  event_type: string;
  payload: Record<string, unknown>;
  canonical: string;
  sha256: string;
  same_hash_as?: string;
  differs_from?: string;
  must_not_equal_sha256_of?: string;
}

const file = JSON.parse(readFileSync(VECTORS_URL, "utf8")) as {
  schema_version: string;
  vectors: Vector[];
  must_not_match: Vector[];
};

describe("shared payload_sha256 vectors (contracts/test-vectors/event_payload_hash.v1.json)", () => {
  const byName = new Map(file.vectors.map((v) => [v.name, v]));

  it("is the v1.0 file and is not empty", () => {
    assert.equal(file.schema_version, "1.0");
    assert.ok(file.vectors.length > 0);
    assert.ok(file.must_not_match.length > 0);
  });

  for (const v of [...file.vectors, ...file.must_not_match]) {
    it(`${v.name}: canonical string and sha256 reproduced byte for byte`, () => {
      assert.equal(canonicalize({ event_type: v.event_type, payload: v.payload }), v.canonical);
      assert.equal(payloadSha256(v.event_type, v.payload), v.sha256);
      assert.match(v.sha256, /^[0-9a-f]{64}$/);
    });
  }

  it("the documented equalities and inequalities hold", () => {
    for (const v of file.vectors) {
      if (v.same_hash_as !== undefined) assert.equal(v.sha256, byName.get(v.same_hash_as)!.sha256, v.name);
      if (v.differs_from !== undefined) assert.notEqual(v.sha256, byName.get(v.differs_from)!.sha256, v.name);
    }
    for (const v of file.must_not_match) {
      const other = byName.get(v.must_not_equal_sha256_of!);
      assert.ok(other, v.name);
      assert.notEqual(payloadSha256(v.event_type, v.payload), other.sha256, v.name);
    }
  });
});
