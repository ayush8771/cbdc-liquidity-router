"""AD-5 v0.8 §8.1–§8.2b classifier cases for 3.3-A acceptance criterion 5 — DATA ONLY.

Basis: AD-5 **v0.8, APPROVED** 26 November 2026. §15 records **AD5-Q8: YES** —
the three outcomes, the C-b → D → C-a order against an `event_id`-keyed index,
and §8.2b.1's v0.7b field matrix, **including the formerly `[PROPOSED]`/`[DevB]`
rows** (`source.transport`, `source.source_url`, `source.gate3_decision_ref`,
`provenance_class`, `derived_from` as an unordered set, `derivation`,
`source_timestamp_basis`, `supersedes`). Cases (j)–(m) are therefore
**unconditional**. (`docs/PHASE3_33A_AUTHORIZATION.md` still calls them
conditional in places, e.g. §12 item 13; its §10.3 row 3 records the v0.8
approval that supersedes that text.)

**Reachability through the adapter path (reviewed at `1b54754`).** `pipeline.py`
validates with the unchanged D-24 strict validator, which refuses slice-foreign
but schema-valid envelopes. The cases in `DIRECT_CLASSIFIER_ONLY` cannot reach a
classifier through `run_cycle` and must be fed to `dedup.py` directly; criterion
5 defines its inputs as schema-valid envelopes, so they remain required cases.

Dev B (P-4) conformance fixtures. This module builds **pairs and sequences of
schema-valid envelopes** and records the outcome AD-5 requires for each. It does
**not** classify anything, and it imports nothing from `dedup.py` or
`pipeline.py`, so it stays importable as pure data (owner of
classification: `dedup.py`; owner of envelope validation and processing:
`pipeline.py` — confirmed by Ayush). The cases are run against the real
classifier (confirmed at a9a3742) by `test_idempotency_conformance.py`.

**Outcome labels are spec vocabulary, not production types.** They are the
AD-5 §8.2 class names, plus one label for "no class matched":

    "C-b"  identity collision  — rejected, counted, first kept
    "D"    duplicate           — discarded, counted
    "C-a"  value conflict      — first kept, counted, does not become current
    "NEW"  no class matched    — the event proceeds as a new observation

Every envelope here is built by the existing D-24 `build_fx_event` (an approved,
untouched module) and then mutated **only as the schema permits**, with the
paired mutations of AD-5 §8.2b.2. Invalid envelopes belong to criterion 5a and
live in `envelope_validation_cases.py`, never here.

Fixture origin (AD-12 §3.4 / 3.3-A §6.2 format; A-10): see `ORIGIN`. These
fixtures are generated in code, not committed files, and none is recorded from
a provider.
"""
from __future__ import annotations

import copy
from dataclasses import dataclass, field
from typing import Optional

from cbdc_ingestion.canonical import payload_sha256
from cbdc_ingestion.envelope import build_fx_event, event_id_for, fx_payload
from cbdc_ingestion.generator import rate_for
from cbdc_ingestion.pairs import Pair

from .conftest import SEED, START_MS

ORIGIN = {
    "origin": "hand-written",
    "created": "2026-11-27",
    "note": "AD-5 v0.8 criterion 5 classifier cases built in code from build_fx_event",
}

# AD-5 §8.2 labels. Plain strings on purpose: see the module docstring.
CB, D, CA, NEW = "C-b", "D", "C-a", "NEW"
OUTCOMES = frozenset({CB, D, CA, NEW})

# Schema-valid cases the unchanged strict validator (`validation.validate_fx_envelope`,
# used by pipeline.py via LatestStore.apply) refuses: classifier-direct only. Checked
# by test_idempotency_cases.py so the list cannot drift from the validator.
DIRECT_CLASSIFIER_ONLY = frozenset({"g2", "h", "i", "j", "k", "k2", "l", "m", "r"})

# AD-8 §3.5 / 3.3-A §5.3: the synthetic transport's in-process dedup window.
DEDUP_WINDOW_MS = 300_000

# Fixed, readable UUIDs for derived_from / supersedes. Valid v4 shape; not event IDs of anything.
U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"
U3 = "33333333-3333-4333-8333-333333333333"

BASE_SEQUENCE = 7
# Inside the generator's declared range for USD/INR (BASE_RATES 1.234500 +/- 0.010000), which
# is also the adapter registry record's plausibility range, so no fixture is quarantined
# as VALUE_OUT_OF_RANGE once criterion 16's bounds run. Trailing zeros kept (AD-4 §4).
BASE_RATE = "1.234500"
ALT_RATE = "1.234600"      # same pair, a different value: a 0.008% jump, well under 20%
EURUSD_RATE = "2.200000"   # EUR/USD's generator centre


# Option B (owner decision, 27 Nov 2026; implemented at fbef1ec): the registry-selected adapter
# shares source_id `synthetic.fx` with the D-24 generator, mutually exclusively, and is told apart
# by its allocated seed. Mirrors cbdc_ingestion/registry/seed_allocations.json at fbef1ec; not
# imported so this module stays pure data; test_idempotency_conformance.py asserts it equals the allocation.
ADAPTER_SEED = 20261127


def base_envelope(*, sequence: int = BASE_SEQUENCE, rate: str = BASE_RATE,
                  base: str = "USD", quote: str = "INR", shift_ms: int = 0, seed: int = SEED) -> dict:
    """A validated synthetic `fx_rate` envelope.

    `retrieved_at` and `emitted_at` are set apart from `source_timestamp` so that
    (n) and (o) can move each of them alone while keeping AD-4 §5's ordering
    (`retrieved_at <= emitted_at`) and staying inside the 1 s clock tolerance.
    `shift_ms` moves all three together, so a later observation is never
    future-quarantined.
    """
    t0 = START_MS + shift_ms
    return build_fx_event(seed=seed, sequence=sequence, payload=fx_payload(base, quote, rate),
                          source_timestamp_ms=t0, retrieved_at_ms=t0 + 100, emitted_at_ms=t0 + 200)


def _rehash(event: dict) -> dict:
    """Keeps `payload_sha256` true to `{event_type, payload}` after a payload mutation.

    A wrong hash is an envelope fault (AD-5 §7.1, A-5), not a classifier case, so
    every classifier input must carry the correct one.
    """
    event["payload_sha256"] = payload_sha256(event["event_type"], event["payload"])
    return event


def _mutate(event: dict, fn) -> dict:
    out = copy.deepcopy(event)
    fn(out)
    return out


@dataclass(frozen=True)
class PairCase:
    """Two schema-valid envelopes delivered in order; `expected` is the second's outcome.

    `mutated` is the exact set of leaf paths that differ between them (checked by
    `test_idempotency_cases.py`, so no case can differ in more than it claims).
    The three `shares_*` flags are fixture properties of AD-5 §8.1's keys, also
    checked — they record *why* the case is hard, not how to classify it.
    """
    case_id: str
    criterion: str
    description: str
    first: dict
    second: dict
    expected: str
    mutated: frozenset
    shares_event_id: bool
    shares_observation_key: bool
    shares_idempotency_key: bool
    # For (p): the two batch-wrapper instance_ids. The envelopes themselves are byte-identical.
    wrapper_instance_ids: Optional[tuple] = None
    spec: str = ""
    # Questions the integration must answer before the case can be bound. Not assumptions.
    integration_notes: tuple = ()

    @property
    def direct_classifier_only(self) -> bool:
        return self.case_id in DIRECT_CLASSIFIER_ONLY


def _pair(case_id, criterion, description, mutator, expected, mutated, *, obs, idem,
          spec="", notes=(), first=None, wrapper=None) -> PairCase:
    first = base_envelope() if first is None else first
    second = _mutate(first, mutator)
    return PairCase(case_id=case_id, criterion=criterion, description=description, first=first,
                    second=second, expected=expected, mutated=frozenset(mutated),
                    shares_event_id=first["event_id"] == second["event_id"],
                    shares_observation_key=obs, shares_idempotency_key=idem,
                    wrapper_instance_ids=wrapper, spec=spec, integration_notes=tuple(notes))


def _set(path: str, value):
    """A mutator setting one dotted path."""
    def fn(e):
        node = e
        *parents, leaf = path.split(".")
        for p in parents:
            node = node[p]
        node[leaf] = value
    return fn


def _all(*fns):
    def fn(e):
        for f in fns:
            f(e)
    return fn


_SYNTHETIC_TO_REAL = _all(
    _set("provenance_class", "real"),
    _set("source", {"source_id": "test.provider-fx", "transport": "poll",
                    "source_url": "https://provider.invalid/fx", "gate3_decision_ref": "G3-TEST-0001"}),
    _set("synthetic", None),
)

_TO_BANK_HOLIDAY = _all(
    _set("event_type", "bank_holiday"),
    _set("payload", {"country": "IND", "date": "2025-11-25", "name": "Synthetic test holiday"}),
    _rehash,
)


def _derived_base(order: tuple) -> dict:
    return _mutate(base_envelope(), _all(_set("derived_from", list(order)),
                                         _set("derivation", "test-only derivation label")))


# ---------------------------------------------------------------------------
# Criterion 5: under a reused event_id, classified C-b — (a) to (m)
# ---------------------------------------------------------------------------

CB_CASES: tuple = (
    _pair("a", "5(a)", "changed synthetic.case_id", _set("synthetic.case_id", "overlap-run-b"),
          CB, {"synthetic.case_id"}, obs=True, idem=True,
          spec="AD-5 §8.2b.1 synthetic.case_id; the C-1 class (40 recorded collisions)"),
    _pair("b", "5(b)", "changed synthetic.generator_version", _set("synthetic.generator_version", "0.2.0"),
          CB, {"synthetic.generator_version"}, obs=True, idem=True,
          spec="AD-5 §8.2b.1 synthetic.generator_version"),
    _pair("c", "5(c)", "changed synthetic.seed; shares both §8.1 keys and must not be discarded as D",
          _set("synthetic.seed", SEED + 1), CB, {"synthetic.seed"}, obs=True, idem=True,
          spec="AD-5 §8.2b.1 synthetic.seed (C-1 input); 3.3-A §4.2 counter-example table"),
    _pair("d", "5(d)", "changed source_timestamp, basis left 'observed'; matches neither D nor C-a",
          _set("timestamps.source_timestamp", "2025-11-24T23:59:58.000Z"), CB,
          {"timestamps.source_timestamp"}, obs=False, idem=False,
          spec="AD-5 §8.2 second bullet; §8.2b.1 timestamps.source_timestamp (C-1 input)",
          notes=("The new timestamp is 2 s EARLIER than the first, so it is not future-quarantined; "
                 "confirm the pipeline does not apply ordering (§8.3 'late') before classification.",)),
    _pair("e", "5(e)", "changed source_sequence alone; payload hash, subject, source_timestamp unchanged",
          _set("source_sequence", "8"), CB, {"source_sequence"}, obs=True, idem=True,
          spec="AD-5 §8.2b.1 source_sequence (C-1 input); 3.3-A §4.2 'source_sequence' correction"),
    _pair("f", "5(f)", "changed payload (rate) and so payload_sha256; also satisfies C-a — C-b must win",
          _all(_set("payload.rate", ALT_RATE), _rehash), CB, {"payload.rate", "payload_sha256"},
          obs=True, idem=False, spec="AD-5 §8.2 order C-b before C-a; §8.2b.1 payload/payload_sha256"),
    _pair("g", "5(g)", "changed subject: the pair (USD/INR -> EUR/USD)",
          _all(_set("payload.base_currency", "EUR"), _set("payload.quote_currency", "USD"),
               _set("payload.rate", EURUSD_RATE), _rehash), CB,
          {"payload.base_currency", "payload.quote_currency", "payload.rate", "payload_sha256"},
          obs=False, idem=False,
          spec="AD-5 §8.2b.1 subject (the pair is a C-1 input); §6.3 fx_rate subject"),
    _pair("g2", "5(g)", "changed subject: rate_type (mid -> bid), the third fx_rate subject field",
          _all(_set("payload.rate_type", "bid"), _rehash), CB, {"payload.rate_type", "payload_sha256"},
          obs=False, idem=False, spec="AD-5 §6.3: fx_rate subject is base, quote, rate_type",
          notes=("The D-24 slice validator only admits rate_type 'mid' (pairs.RATE_TYPE). Confirm the "
                 "adapter-path validation in pipeline.py admits 'bid', or drop this variant.",)),
    _pair("h", "5(h)", "changed source.source_id (still synthetic.-prefixed)",
          _set("source.source_id", "synthetic.fx-b"), CB, {"source.source_id"}, obs=False, idem=False,
          spec="AD-5 §8.2b.1 source.source_id",
          notes=("Option B (fbef1ec) resolves source_id by sharing 'synthetic.fx' between the two exclusive "
                 "configurations, so no 3.3-A path can emit another source_id: pipeline.build_envelope "
                 "refuses a mismatching record as a permanent contract_violation and the strict validator "
                 "refuses the envelope. This case is therefore classifier-direct only BY DESIGN — it "
                 "remains required, since criterion 5(h) is defined on schema-valid envelopes.",)),
    _pair("i", "5(i)", "changed event_type with the matching payload shape (fx_rate -> bank_holiday)",
          _TO_BANK_HOLIDAY, CB,
          {"event_type", "payload.base_currency", "payload.quote_currency", "payload.rate",
           "payload.rate_type", "payload.country", "payload.date", "payload.name", "payload_sha256"},
          obs=False, idem=False, spec="AD-5 §8.2b.1 event_type; schema allOf event_type->payload",
          notes=("3.3-A emits fx_rate only; confirm the adapter path validates a bank_holiday envelope "
                 "rather than rejecting the type before classification.",)),
    # --- the formerly [PROPOSED]/[DevB] rows, adopted by AD5-Q8 (AD-5 v0.8 §15) ---
    _pair("j", "5(j)", "provenance_class moved with source.* and the synthetic block (allOf rules 0-3)",
          _SYNTHETIC_TO_REAL, CB,
          {"provenance_class", "source.source_id", "source.transport", "source.source_url",
           "source.gate3_decision_ref", "synthetic", "synthetic.seed", "synthetic.case_id",
           "synthetic.generator_version"},
          obs=False, idem=False,
          spec="AD-5 v0.8 §8.2b.1 provenance_class, source.* (adopted by AD5-Q8); §8.2b.2 paired mutation 1",
          notes=("The second envelope is 'real' with a Gate 3 ref string; confirm the pipeline does not "
                 "refuse a real envelope on the synthetic adapter path before classification.",)),
    _pair("k", "5(k)", "derived_from with derivation (allOf rule 3)",
          _all(_set("derived_from", [U1]), _set("derivation", "test-only derivation label")), CB,
          {"derived_from", "derivation"}, obs=True, idem=True,
          spec="AD-5 v0.8 §8.2b.1 derived_from/derivation (adopted by AD5-Q8); §8.2b.2 paired mutation 1"),
    _pair("k2", "5(k)", "derived_from reordered only: compared as an unordered set, so D",
          _set("derived_from", [U2, U1]), D, {"derived_from"}, obs=True, idem=True,
          first=_derived_base((U1, U2)),
          spec="AD-5 §8.2b.1 derived_from 'as an unordered set'",
          notes=("Two elements are schema-valid (maxItems 50) but break AD-4 §6's v1 single-source rule "
                 "(AD4-Q8). If pipeline.py enforces AD4-Q8 before classification, this variant cannot "
                 "reach the classifier and must be fed to it directly.",)),
    _pair("l", "5(l)", "source_timestamp_basis observed -> published, timestamp non-null",
          _set("timestamps.source_timestamp_basis", "published"), CB,
          {"timestamps.source_timestamp_basis"}, obs=True, idem=True,
          spec="AD-5 v0.8 §8.2b.1 source_timestamp_basis (adopted by AD5-Q8); §8.2b.2 consequence 2",
          notes=("pipeline.admit at 1b54754 refuses a basis differing from the record's timestamp_basis "
                 "('timestamp_basis_mismatch') before an envelope exists; classifier-direct only.",)),
    _pair("m", "5(m)", "supersedes changed with review null: correction evidence never silently discarded",
          _set("supersedes", U3), CB, {"supersedes"}, obs=True, idem=True,
          spec="AD-5 v0.8 §8.2b.1 supersedes (adopted by AD5-Q8); schema allOf rule 5",
          notes=("V-4 requires supersedes to resolve to an existing event of the same source and type; "
                 "U3 resolves to nothing. Confirm whether V-4 runs before classification — if it does, "
                 "this case must target an earlier stored event's event_id instead.",)),
)

# ---------------------------------------------------------------------------
# Criterion 5: under a reused event_id, classified D — (n) to (s)
# ---------------------------------------------------------------------------

D_CASES: tuple = (
    _pair("n", "5(n)", "differs only in retrieved_at", _set("timestamps.retrieved_at", "2025-11-25T00:00:00.150Z"),
          D, {"timestamps.retrieved_at"}, obs=True, idem=True, spec="AD-5 §8.2b.1: retrieved_at excluded"),
    _pair("o", "5(o)", "differs only in emitted_at", _set("timestamps.emitted_at", "2025-11-25T00:00:00.900Z"),
          D, {"timestamps.emitted_at"}, obs=True, idem=True, spec="AD-5 §8.2b.1: emitted_at excluded"),
    _pair("p", "5(p)", "byte-identical envelope redelivered under a different wrapper instance_id",
          lambda e: None, D, set(), obs=True, idem=True,
          wrapper=("6f1f6c0e-2f0a-4b6e-8a53-0d6a2d1f3a11", "a3c9e1d2-7b4f-4c8a-9e21-5d0f3b6a8c47"),
          spec="AD-5 §8.2b.1 'instance_id is not an envelope field'; ingestion-latest.v1 wrapper",
          notes=("Needs the integration point that consumes a batch wrapper (or wrapper metadata) — not "
                 "yet known whether the classifier ever sees instance_id.",)),
    _pair("q", "5(q)", "validation.status changed with matching reasons (validated/[] -> quarantined/[VALUE_JUMP])",
          _set("validation", {"status": "quarantined", "reasons": ["VALUE_JUMP"]}), D,
          {"validation.status", "validation.reasons"}, obs=True, idem=True,
          spec="AD-5 §8.2b.1: validation excluded; §8.2b.2 paired mutation 1",
          notes=("At 1b54754 pipeline.run_cycle routes a non-validated envelope to the 'quarantine' channel "
                 "BEFORE sink publication. If dedup.py sits at publication, (q) never reaches it through the "
                 "pipeline; confirm the classifier's position, else feed (q) to the classifier directly.",)),
    _pair("r", "5(r)", "differs only in raw_sha256", _set("raw_sha256", "ab" * 32), D, {"raw_sha256"},
          obs=True, idem=True, spec="AD-5 §8.2b.1: raw_sha256 excluded (Dev B accepts)"),
    _pair("s", "5(s)", "identical in every field (plain redelivery)", lambda e: None, D, set(),
          obs=True, idem=True, spec="AD-5 §8.2 D"),
)

# ---------------------------------------------------------------------------
# C-a, the general-rule D cell, and NEW controls (different event_ids)
# ---------------------------------------------------------------------------

def _resequenced(sequence: int, rate: str = BASE_RATE, **kw) -> dict:
    """A fresh build at another sequence: a different event_id by the C-1 derivation."""
    return base_envelope(sequence=sequence, rate=rate, **kw)


CA_AND_CONTROL_CASES: tuple = (
    PairCase("ca", "5 (C-a)", "different event_id, same observation_key, different payload_sha256: first kept",
             first=base_envelope(), second=_resequenced(8, rate=ALT_RATE), expected=CA,
             mutated=frozenset({"event_id", "source_sequence", "payload.rate", "payload_sha256"}),
             shares_event_id=False, shares_observation_key=True, shares_idempotency_key=False,
             spec="AD-5 §8.2 C-a; §8.3 equal source_timestamp, different event_id"),
    PairCase("d-new-id", "5 (D, general rule)",
             "different event_id, same payload and observation: D on the adapter path "
             "(AD-1 §3.4 would call this a conflict on the D-24 path — §8.2 divergent cell)",
             first=base_envelope(), second=_resequenced(8), expected=D,
             mutated=frozenset({"event_id", "source_sequence"}),
             shares_event_id=False, shares_observation_key=True, shares_idempotency_key=True,
             spec="AD-5 §8.2 'Which governs where'; AD5-Q11(a)"),
    # Option B: the generator (seed 20261125) and the adapter (seed 20261127) share source_id, event_type,
    # subject and potentially source_timestamp, so their observation_keys can coincide. The seed is a C-1
    # input, so event_ids differ: never C-b. The generated rates differ, so it is C-a, not D.
    PairCase("optb-cross-config", "5 (C-a, Option B)",
             "D-24 generator event vs registry-selected adapter event at the same pair, sequence and "
             "source_timestamp: distinct event_ids, same observation_key, different rate",
             first=base_envelope(sequence=1, rate=rate_for(SEED, Pair("USD", "INR"), 1)),
             second=base_envelope(sequence=1, rate=rate_for(ADAPTER_SEED, Pair("USD", "INR"), 1),
                                  seed=ADAPTER_SEED),
             expected=CA,
             mutated=frozenset({"event_id", "synthetic.seed", "payload.rate", "payload_sha256"}),
             shares_event_id=False, shares_observation_key=True, shares_idempotency_key=False,
             spec="Option B (owner, 27 Nov 2026; fbef1ec); AD-5 §8.2 C-a; §8.5 cross-configuration note",
             integration_notes=("Unreachable within one process: Option B makes the configurations mutually "
                                "exclusive (selecting a record replaces the generator) and dedup state is "
                                "in-process only (dedup: within_run), so the pair can meet only if a future "
                                "change shares classifier state across a configuration switch. Feed it to "
                                "the classifier directly.",)),
    PairCase("new-subject", "control", "different event_id and different pair: no class matches",
             first=base_envelope(), second=_resequenced(7, rate=EURUSD_RATE, base="EUR", quote="USD"),
             expected=NEW,
             mutated=frozenset({"event_id", "payload.base_currency", "payload.quote_currency", "payload.rate",
                                "payload_sha256"}),
             shares_event_id=False, shares_observation_key=False, shares_idempotency_key=False,
             spec="AD-5 §8.2 (no condition holds)"),
    PairCase("new-later", "control", "same subject, newer source_timestamp, new event_id: no class matches",
             first=base_envelope(), second=_resequenced(8, rate=ALT_RATE, shift_ms=2000),
             expected=NEW,
             mutated=frozenset({"event_id", "source_sequence", "payload.rate", "payload_sha256",
                                "timestamps.source_timestamp", "timestamps.retrieved_at",
                                "timestamps.emitted_at"}),
             shares_event_id=False, shares_observation_key=False, shares_idempotency_key=False,
             spec="AD-5 §8.3 'Newer source_timestamp'"),
)

PAIR_CASES: tuple = CB_CASES + D_CASES + CA_AND_CONTROL_CASES

# ---------------------------------------------------------------------------
# Sequences: first-kept behaviour after a rejection
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class SequenceCase:
    case_id: str
    description: str
    events: tuple
    expected: tuple
    spec: str = ""
    integration_notes: tuple = ()


def _case(cid: str) -> PairCase:
    return next(c for c in PAIR_CASES if c.case_id == cid)


_redelivery = _case("n").second  # the base event, redelivered with a later retrieved_at

SEQUENCE_CASES: tuple = (
    SequenceCase("seq-cb-first-kept", "after a C-b rejection the FIRST is still the kept event: its redelivery is D",
                 events=(base_envelope(), _case("a").second, _redelivery), expected=(NEW, CB, D),
                 spec="AD-5 §8.2 C-b 'first is kept'; AD-1 §3.4"),
    SequenceCase("seq-cb-repeat", "the rejected collider arriving again is still compared with the first: C-b again",
                 events=(base_envelope(), _case("a").second, _case("a").second), expected=(NEW, CB, CB),
                 spec="AD-5 §8.2: the event_id index retains the first's §8.2b comparison fields",
                 integration_notes=("Assumes the rejected event is not inserted into the event_id index. "
                                    "AD-5 says the first is kept; confirm with Ayush that the index is not "
                                    "overwritten by a rejected arrival.",)),
    SequenceCase("seq-ca-first-kept", "after a C-a conflict the first stays kept: its redelivery is D",
                 events=(base_envelope(), _case("ca").second, _redelivery), expected=(NEW, CA, D),
                 spec="AD-5 §8.2 C-a 'first is kept'"),
)

# ---------------------------------------------------------------------------
# The 300 s window: at, inside and outside its boundary (criterion 5, last sentence)
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class WindowCase:
    case_id: str
    pair_case_id: str        # which PairCase supplies the two envelopes
    second_arrival_offset_ms: int
    expected: Optional[str]  # None: AD-5 does not determine it — see `open_question`
    not_expected: Optional[str] = None
    open_question: str = ""
    spec: str = ""


# Q4, RESOLVED against dedup.py at a9a3742 (confirmed interface): the gap is measured on the
# classifier's `now_ms` argument (on the adapter path, the cycle's `retrieved_at_ms`), and the window
# is INCLUSIVE — an entry seen at T is retained at T+300 000 ms and expired at T+300 001 ms.
_BOUNDARY_RESOLVED = "Q4 resolved at a9a3742: inclusive at 300 000 ms; clock = classify(now_ms)."

WINDOW_CASES: tuple = (
    WindowCase("win-d-inside", "s", DEDUP_WINDOW_MS - 1, D, spec="3.3-A §5.3; AD-5 §8.2 dedup window"),
    WindowCase("win-d-at", "s", DEDUP_WINDOW_MS, D, open_question=_BOUNDARY_RESOLVED, spec="3.3-A §5.3"),
    WindowCase("win-d-outside", "s", DEDUP_WINDOW_MS + 1, NEW, not_expected=D,
               spec="AD-5 §8.2: after the window a duplicate is handled by §8.3 ordering, not D"),
    WindowCase("win-cb-inside", "a", DEDUP_WINDOW_MS - 1, CB, spec="AD-5 §8.2 event_id index retention"),
    WindowCase("win-cb-at", "a", DEDUP_WINDOW_MS, CB, open_question=_BOUNDARY_RESOLVED, spec="AD-5 §8.2"),
    WindowCase("win-cb-outside", "a", DEDUP_WINDOW_MS + 1, NEW,
               spec="AD-5 §8.2: 'a collision whose first arrival has fallen out of the window is not "
                    "detected, and the later event is accepted as new'"),
)
