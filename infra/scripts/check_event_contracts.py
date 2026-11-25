"""Contract check for contracts/events/ (Phase 3, AD-1 v0.5 section 3.7 [P-8], AD-4 v0.2).

Separate from check_contracts.py, which covers the Phase 2 API contracts and stays unchanged.

Checks, in order:
  1. Every *.schema.json in contracts/events/ is a valid JSON Schema 2020-12 document, with a unique $id,
     and every $ref resolves.
  2. Every fixture in contracts/events/fixtures/<kind>/ is {"description", "valid", ["reason"], ["status"], "instance"}
     and the verdict (schema + the semantic rules below) equals its "valid" flag. The same files are the shared
     fixtures for the TypeScript validator: both languages must give the same verdict on each one.
  3. Semantic rules a schema cannot express:
       envelope  payload_sha256 = SHA-256 of the RFC 8785 form of {"event_type","payload"}; real calendar dates;
                 retrieved_at <= emitted_at; FX currencies differ (AD-4 sections 4, 5, 6).
       slice     source synthetic.fx, validated, a source_timestamp, rate_type mid, one of the four allowlisted
                 pairs (AD-1 section 3.4).
       latest    (ingestion-latest, success body) events sorted by base then quote, so at most one per pair (AD-1 section 3.1).
       error     (ingestion-latest, error body) the HTTP status each code is sent with (AD-1 section 3.1).
       stream    a value's pair equals its event's pair; the profile is ordered; freshness agrees with age and
                 the profile; no number past unavailable_after_ms (AD-1 sections 3.2, 3.3.3).
  4. Coverage: each kind has valid and invalid fixtures, every message type and error code has a valid one, the
     AD-4 section 10 example is present with its published hash, and the file names say valid_ / invalid_.

  5. The cross-language hash vectors (contracts/test-vectors/event_payload_hash.v1.json, P-9, Dev A): each canonical
     string is the RFC 8785 form of {"event_type","payload"}, each digest its SHA-256, the same_hash_as / differs_from /
     must_not_equal_sha256_of relations hold, the AD-4 section 10 vector is present and all four pairs are generated.
     The TypeScript side must reproduce the same strings and digests.

Usage:  python infra/scripts/check_event_contracts.py [--root REPO_ROOT]
        python infra/scripts/check_event_contracts.py --instance KIND FILE [--expect-events N]
        python infra/scripts/check_event_contracts.py --frames FILE
The second form checks one live JSON body (for example a real GET /v1/latest response) against the schema and the
semantic rules of KIND, and with --expect-events also that a success body carries exactly N events.
The third form checks the frames a real producer wrote (infra/testing/observations/dump_frames.ts): a JSON array of
{"connection", "event", "msg"}, with "event" the SSE event name and "msg" the parsed data. Every msg must pass the
stream-message verdict above (strict: the same schema and semantic rules as the fixtures), "type" must equal "event",
each connection must start with a snapshot at stream_seq 1 and count up by one, and the frames must include all three
message types and all three freshness states, so an empty or one-sided dump cannot pass.
Exit status 0 when everything conforms, 1 otherwise. Needs only infra/scripts/requirements.txt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

import rfc8785
from jsonschema import Draft202012Validator
from referencing import Registry, Resource
from referencing.jsonschema import DRAFT202012

KINDS = {
    "envelope": "event-envelope.v1.schema.json",
    "ingestion-latest": "ingestion-latest.v1.schema.json",  # Dev A's schema: the 200 body and the error body
    "stream-message": "stream-message.v1.schema.json",
}
# AD-1 section 3.4: the allowlist, in the order of the snapshot's values.
PAIRS = [("AED", "MXN"), ("EUR", "USD"), ("GBP", "PHP"), ("USD", "INR")]
ERROR_STATUS = {"INVALID_REQUEST": 400, "NOT_FOUND": 404, "METHOD_NOT_ALLOWED": 405, "INTERNAL_ERROR": 500, "NOT_READY": 503}
MESSAGE_TYPES = ("snapshot", "update", "heartbeat")
# AD-4 section 10: the published example and its hash.
AD4_EXAMPLE_FIXTURE = "envelope/valid_ad4_section10_example.json"
AD4_EXAMPLE_HASH = "22fe8747cb6a035235c3ad84c45c5214d271941c784a5a2e4cc0c8c048798ca4"


def parse_ts(text: str):
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        return None


def payload_hash(event: dict) -> str:
    return hashlib.sha256(rfc8785.dumps({"event_type": event["event_type"], "payload": event["payload"]})).hexdigest()


def envelope_problems(e: dict) -> list[str]:
    out = []
    if payload_hash(e) != e["payload_sha256"]:
        out.append("payload_sha256 does not match the RFC 8785 form of {event_type, payload}")
    ts = e["timestamps"]
    parsed = {k: parse_ts(v) for k, v in ts.items() if k in ("source_timestamp", "retrieved_at", "emitted_at") and v is not None}
    for k, v in ts.items():
        if k in ("source_timestamp", "retrieved_at", "emitted_at") and v is not None and parsed[k] is None:
            out.append(f"timestamps.{k} is not a real date and time")
    if parsed.get("retrieved_at") and parsed.get("emitted_at") and parsed["retrieved_at"] > parsed["emitted_at"]:
        out.append("retrieved_at is after emitted_at")
    if e["event_type"] == "fx_rate" and e["payload"]["base_currency"] == e["payload"]["quote_currency"]:
        out.append("FX base and quote currencies are identical")
    return out


def slice_event_problems(e: dict) -> list[str]:
    """The D-24 slice accepts only validated synthetic.fx mid rates for the four pairs (AD-1 section 3.4)."""
    out = []
    if e["source"]["source_id"] != "synthetic.fx":
        out.append("slice: source_id is not synthetic.fx")
    if e["event_type"] != "fx_rate":
        out.append("slice: event_type is not fx_rate")
        return out
    if e["validation"]["status"] != "validated":
        out.append("slice: a quarantined event is never served")
    if e["timestamps"]["source_timestamp"] is None:
        out.append("slice: source_timestamp is null")
    p = e["payload"]
    if p["rate_type"] != "mid":
        out.append("slice: rate_type is not mid")
    if (p["base_currency"], p["quote_currency"]) not in PAIRS:
        out.append("slice: pair is not on the allowlist")
    return out


def event_problems(e: dict) -> list[str]:
    return envelope_problems(e) + slice_event_problems(e)


def value_problems(v: dict, profile: dict | None) -> list[str]:
    out = []
    pair = (v["base_currency"], v["quote_currency"])
    if v["event"] is not None:
        out += event_problems(v["event"])
        p = v["event"]["payload"]
        if (p.get("base_currency"), p.get("quote_currency")) != pair:
            out.append(f"value pair {pair[0]}/{pair[1]} differs from its event's pair")
        if profile is not None and v["age_ms"] is not None:
            if v["age_ms"] > profile["unavailable_after_ms"]:
                out.append("a value older than unavailable_after_ms must be unavailable, with no number")
            elif (v["age_ms"] > profile["stale_after_ms"]) != (v["freshness"] == "stale"):
                out.append("freshness disagrees with age_ms and stale_after_ms (exactly stale_after_ms is fresh)")
    return out


def profile_problems(p: dict) -> list[str]:
    out = []
    if p["stale_after_ms"] > p["unavailable_after_ms"]:
        out.append("profile: stale_after_ms exceeds unavailable_after_ms")
    if p["live_max_age_ms"] is not None and p["live_max_age_ms"] > p["stale_after_ms"]:
        out.append("profile: live_max_age_ms exceeds stale_after_ms")
    return out


def semantic_problems(kind: str, instance: dict, status) -> list[str]:
    if kind == "envelope":
        return envelope_problems(instance)
    if kind == "ingestion-latest" and "error" not in instance:
        out = [p for e in instance["events"] for p in event_problems(e)]
        keys = [(e["payload"]["base_currency"], e["payload"]["quote_currency"]) for e in instance["events"] if e["event_type"] == "fx_rate"]
        if keys != sorted(set(keys)):
            out.append("events are not sorted by base then quote, with one event per pair")
        return out
    if kind == "ingestion-latest":
        want = ERROR_STATUS[instance["error"]["code"]]
        return [] if status is None or status == want else [f"{instance['error']['code']} is sent with status {want}, not {status}"]
    if kind == "stream-message":
        out = []
        if instance["type"] == "snapshot":
            out += profile_problems(instance["profile"])
            for v in instance["values"]:
                out += value_problems(v, instance["profile"])
        elif instance["type"] == "update":
            out += value_problems(instance["value"], None)
        return out
    raise AssertionError(kind)


class Checker:
    def __init__(self, root: Path):
        self.dir = Path(root) / "contracts" / "events"
        self.problems: list[str] = []
        self.counts = {k: [0, 0] for k in KINDS}  # kind -> [valid, invalid]

    def fail(self, msg: str) -> None:
        self.problems.append(msg)

    def load_schemas(self) -> dict | None:
        schemas, ids = {}, {}
        files = sorted(self.dir.glob("*.schema.json"))
        names = {f.name for f in files}
        for kind, name in KINDS.items():
            if name not in names:
                self.fail(f"missing schema contracts/events/{name}")
        for f in files:
            try:
                doc = json.loads(f.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(doc)
            except Exception as exc:  # noqa: BLE001 - report any load or meta-schema failure
                self.fail(f"{f.name}: not a valid JSON Schema 2020-12 document: {str(exc).splitlines()[0]}")
                continue
            if doc.get("$id") in ids:
                self.fail(f"{f.name}: $id {doc.get('$id')} is already used by {ids[doc.get('$id')]}")
            ids[doc.get("$id")] = f.name
            schemas[f.name] = doc
        if any(name not in schemas for name in KINDS.values()):
            return None
        registry = Registry().with_resources([(d["$id"], Resource.from_contents(d, default_specification=DRAFT202012)) for d in schemas.values()])
        self.check_refs(schemas, registry)
        return {kind: Draft202012Validator(schemas[name], registry=registry) for kind, name in KINDS.items()}

    def check_refs(self, schemas: dict, registry) -> None:
        """Every $ref, including the envelope's URN, must resolve inside the registry. Nothing is ever fetched."""
        def refs(node):
            if isinstance(node, dict):
                if isinstance(node.get("$ref"), str):
                    yield node["$ref"]
                for v in node.values():
                    yield from refs(v)
            elif isinstance(node, list):
                for v in node:
                    yield from refs(v)

        for name, doc in sorted(schemas.items()):
            resolver = registry.resolver(base_uri=doc["$id"])
            for ref in sorted(set(refs(doc))):
                try:
                    resolver.lookup(ref)
                except Exception as exc:  # noqa: BLE001 - NoSuchResource, PointerToNowhere, Unretrievable
                    self.fail(f"{name}: unresolved $ref {ref!r} ({type(exc).__name__})")

    def verdict(self, validators: dict, kind: str, fx: dict) -> list[str]:
        inst = fx["instance"]
        try:
            errors = sorted(validators[kind].iter_errors(inst), key=lambda e: list(e.absolute_path))
        except Exception as exc:  # noqa: BLE001 - an unresolvable $ref is a contract bug
            return [f"validator failed: {type(exc).__name__}: {str(exc).splitlines()[0]}"]
        found = [f"schema: {'/'.join(map(str, e.absolute_path)) or '(root)'}: {e.message[:120]}" for e in errors]
        if not found:
            found = semantic_problems(kind, inst, fx.get("status"))
        return found

    def check_fixtures(self, validators: dict) -> None:
        seen = {}
        for kind in KINDS:
            d = self.dir / "fixtures" / kind
            files = sorted(d.glob("*.json")) if d.is_dir() else []
            if not files:
                self.fail(f"fixtures/{kind}: no fixtures")
            for f in files:
                rel = f"{kind}/{f.name}"
                try:
                    fx = json.loads(f.read_text(encoding="utf-8"))
                except ValueError as exc:
                    self.fail(f"{rel}: not JSON: {exc}")
                    continue
                if not isinstance(fx, dict) or not {"description", "valid", "instance"} <= set(fx) or not isinstance(fx["valid"], bool):
                    self.fail(f"{rel}: must be an object with description, valid (boolean) and instance")
                    continue
                if fx["valid"] is False and not fx.get("reason"):
                    self.fail(f"{rel}: an invalid fixture needs a reason")
                if not f.name.startswith("valid_" if fx["valid"] else "invalid_"):
                    self.fail(f"{rel}: the file name must start with {'valid_' if fx['valid'] else 'invalid_'}")
                self.counts[kind][0 if fx["valid"] else 1] += 1
                found = self.verdict(validators, kind, fx)
                if found and found[0].startswith("validator failed"):
                    # A crash is not a rejection: it must never make an invalid fixture look correctly rejected.
                    self.fail(f"{rel}: the validator could not run ({found[0]})")
                    continue
                if fx["valid"] and found:
                    self.fail(f"{rel}: marked valid but rejected: {found[0]}")
                if not fx["valid"] and not found:
                    self.fail(f"{rel}: marked invalid ({fx.get('reason')}) but accepted")
                if fx["valid"]:
                    seen.setdefault(kind, []).append(fx)
        self.check_coverage(seen)

    def check_coverage(self, valid: dict) -> None:
        for kind, (ok, bad) in self.counts.items():
            if ok == 0 or bad == 0:
                self.fail(f"fixtures/{kind}: needs at least one valid and one invalid fixture (has {ok} and {bad})")
        types = {fx["instance"].get("type") for fx in valid.get("stream-message", [])}
        for t in MESSAGE_TYPES:
            if t not in types:
                self.fail(f"fixtures/stream-message: no valid {t}")
        codes = {fx["instance"]["error"]["code"] for fx in valid.get("ingestion-latest", []) if "error" in fx["instance"]}
        for c in ERROR_STATUS:
            if c not in codes:
                self.fail(f"fixtures/ingestion-latest: no valid error {c}")
        sizes = {len(fx["instance"]["events"]) for fx in valid.get("ingestion-latest", []) if "events" in fx["instance"]}
        if not {0, 4} <= sizes:
            self.fail("fixtures/ingestion-latest: needs a valid empty response and a valid response with four events")
        path = self.dir / "fixtures" / AD4_EXAMPLE_FIXTURE
        try:
            ok = json.loads(path.read_text(encoding="utf-8"))["instance"]["payload_sha256"] == AD4_EXAMPLE_HASH
        except (OSError, ValueError, KeyError):
            ok = False
        if not ok:
            self.fail(f"fixtures/{AD4_EXAMPLE_FIXTURE}: the AD-4 section 10 example with hash {AD4_EXAMPLE_HASH} is required")

    def check_vectors(self) -> None:
        path = self.dir.parent / "test-vectors" / "event_payload_hash.v1.json"
        rel = "test-vectors/event_payload_hash.v1.json"
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
            vectors, must_not = doc["vectors"], doc.get("must_not_match", [])
        except (OSError, ValueError, KeyError) as exc:
            self.fail(f"{rel}: missing or unreadable: {type(exc).__name__}")
            return
        by_name = {}

        def own(v: dict, where: str) -> None:
            canonical = rfc8785.dumps({"event_type": v["event_type"], "payload": v["payload"]}).decode("utf-8")
            if v.get("canonical") != canonical:
                self.fail(f"{rel}: {where} {v['name']}: canonical string is not the RFC 8785 form")
            if v.get("sha256") != hashlib.sha256(canonical.encode("utf-8")).hexdigest():
                self.fail(f"{rel}: {where} {v['name']}: sha256 is not the digest of the canonical string")

        for v in vectors:
            own(v, "vector")
            by_name[v["name"]] = v
        for v in vectors:
            if "same_hash_as" in v and v["sha256"] != by_name[v["same_hash_as"]]["sha256"]:
                self.fail(f"{rel}: {v['name']} must hash like {v['same_hash_as']}")
            if "differs_from" in v and v["sha256"] == by_name[v["differs_from"]]["sha256"]:
                self.fail(f"{rel}: {v['name']} must hash differently from {v['differs_from']}")
        for v in must_not:
            own(v, "must_not_match")
            if v["sha256"] == by_name[v["must_not_equal_sha256_of"]]["sha256"]:
                self.fail(f"{rel}: altered payload {v['name']} still has the original hash")
        if by_name.get("ad4_section10_usd_inr", {}).get("sha256") != AD4_EXAMPLE_HASH:
            self.fail(f"{rel}: the AD-4 section 10 vector with hash {AD4_EXAMPLE_HASH} is required")
        pairs = {(v["payload"]["base_currency"], v["payload"]["quote_currency"]) for v in vectors if "seed" in v}
        if not set(PAIRS) <= pairs:
            self.fail(f"{rel}: generated vectors must cover all four pairs")
        if not must_not:
            self.fail(f"{rel}: needs altered-payload vectors that must not match")

    def run(self) -> list[str]:
        validators = self.load_schemas()
        if validators is not None:
            self.check_fixtures(validators)
        self.check_vectors()
        return self.problems


def frames_problems(checker: "Checker", validators: dict, frames) -> list[str]:
    """Strict producer verdicts for real stream frames (see the module docstring). Reuses Checker.verdict unchanged."""
    if not isinstance(frames, list) or not frames:
        return ["frames: expected a non-empty JSON array"]
    out, last, types, states = [], {}, set(), set()
    for i, fr in enumerate(frames):
        where = f"frame {i} ({fr.get('connection')}/{fr.get('event')})" if isinstance(fr, dict) else f"frame {i}"
        if not isinstance(fr, dict) or not {"connection", "event", "msg"} <= set(fr) or not isinstance(fr["msg"], dict):
            out.append(f"{where}: needs connection, event and msg (an object)")
            continue
        msg = fr["msg"]
        found = checker.verdict(validators, "stream-message", {"instance": msg})
        out += [f"{where}: {f}" for f in found]
        if msg.get("type") != fr["event"]:
            out.append(f"{where}: type {msg.get('type')!r} differs from the SSE event name {fr['event']!r}")
        seq, prev = msg.get("stream_seq"), last.get(fr["connection"])
        if prev is None and msg.get("type") != "snapshot":
            out.append(f"{where}: the first frame of a connection must be a snapshot")
        if seq != (1 if prev is None else prev + 1):
            out.append(f"{where}: stream_seq {seq!r} is not {1 if prev is None else prev + 1}")
        last[fr["connection"]] = seq if isinstance(seq, int) else (prev or 0)
        types.add(msg.get("type"))
        states.update(v.get("freshness") for v in (msg.get("values") or ([msg["value"]] if "value" in msg else [])))
    for t in MESSAGE_TYPES:
        if t not in types:
            out.append(f"frames: no {t} was produced")
    for f in ("fresh", "stale", "unavailable"):
        if f not in states:
            out.append(f"frames: no {f} value was produced")
    return out


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2], help="repository root")
    parser.add_argument("--instance", nargs=2, metavar=("KIND", "FILE"), help="check one JSON body instead of the repository")
    parser.add_argument("--frames", type=Path, metavar="FILE", help="check the frames a real producer wrote, instead of the repository")
    parser.add_argument("--expect-events", type=int, help="with --instance: the exact number of events expected")
    args = parser.parse_args(argv)
    checker = Checker(args.root)
    if args.frames:
        validators = checker.load_schemas()
        if validators is None:
            print("FAIL " + "; ".join(checker.problems))
            return 1
        found = frames_problems(checker, validators, json.loads(args.frames.read_text(encoding="utf-8")))
        for f in found:
            print(f"FAIL {f}")
        if not found:
            print(f"{args.frames} conforms: every frame passes the stream-message verdict")
        return 1 if found else 0
    if args.instance:
        kind, file = args.instance
        validators = checker.load_schemas()
        if validators is None or kind not in KINDS:
            print("FAIL " + ("; ".join(checker.problems) or f"unknown kind {kind}"))
            return 1
        body = json.loads(Path(file).read_text(encoding="utf-8"))
        found = checker.verdict(validators, kind, {"instance": body})
        if args.expect_events is not None and len(body.get("events", [])) != args.expect_events:
            found.append(f"expected {args.expect_events} events, got {len(body.get('events', []))}")
        for f in found:
            print(f"FAIL {f}")
        if not found:
            print(f"{file} conforms to {kind}")
        return 1 if found else 0
    problems = checker.run()
    for p in problems:
        print(f"FAIL {p}")
    if problems:
        print(f"{len(problems)} problem(s)")
        return 1
    print("contracts/events conforms: " + ", ".join(f"{k} {v[0]} valid + {v[1]} invalid" for k, v in checker.counts.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
