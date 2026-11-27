"""The source registry: AD-5 §2.2's record, A-2's startup validation and
AD-12 §3.1's collision safeguards (authorization §6.1).

**Configuration, not code, and not user input** (AD-5 §2.1): a version-controlled
file loaded at ingestion start, validated against a closed set of rules, and
immutable at runtime. **A registry that fails validation is a startup failure,
never a partial load** — the same rule `settings.py` already applies to the seed.
A component that quietly dropped one bad record would run with a silently
different source set.

**The runtime validates records with the code here, not by loading a schema
file** (authorization §7.4). `contracts/events/registry/source-record.v1.schema.json`
is a review and test artefact: it is outside the ingestion build context by
construction, so the image cannot depend on it. `tests/test_registry_schema.py`
holds the two in agreement.

**What this module refuses, and why each refusal exists**

| Refusal | Why |
|---|---|
| A `synthetic.` prefix without the synthetic class, or the converse | AD-4 §3.2's four markers must agree, or an envelope's provenance contradicts its registry record |
| A transport that does not match the class, or that this scope does not authorize | Only `synthetic` is authorized (authorization §8 items 1 and 2) |
| A synthetic record with a non-null `endpoint`, a non-null `credential_ref` or a non-empty `egress_allowlist` | §6.1's synthetic-only assertions: no outbound reach, checkable from the record alone. **Asserted individually**, so one passing cannot mask another |
| A `real` or `derived` record whose Gate 3 reference is absent, inactive or withdrawn | A-11, acceptance criterion 10. **Unreachable in this scope** — no such record exists before Gate 3 — and present so that it cannot be added without one |
| A freshness profile breaking AD-4 §7's ordering invariant | A profile whose `stale_after_ms` exceeded its `unavailable_after_ms` would make a value unavailable before it was stale |
| A `describe()` that contradicts the record | Acceptance criterion 1: a **startup failure, not a warning** |
| A registry-selected source with no allocation entry, or an overlapping `(seed, pair)` | §6.1 mitigations 1 and 3 |
| Two active records sharing a `source_id` | AD-4 Part 2 §3.4 item 3, **granted for Phase 3.3-A only** (§13.3) |

**The D-24 generator path is exempt from every check in this module, and must
be** (§6.1). It is **not registry-selected**: it takes its seed from
`CBDC_INGESTION_SEED` and has no record and no allocation entry, so an unscoped
refusal would refuse to start the approved D-24 slice. The exemption is
structural rather than a flag: nothing in `service.py`'s default path calls into
this module at all. `tests/test_seed_allocation.py` asserts it as a test.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional, Sequence

from .base import AUTHORIZED_TRANSPORTS, TIMESTAMP_BASES, TRANSPORTS, AdapterDescription

# The records ship **inside the package**, where the Dockerfile's existing
# `COPY cbdc_ingestion/ /app/cbdc_ingestion/` already carries them: no Dockerfile,
# `.dockerignore`, Compose or build-context change is requested (authorization §7.4).
REGISTRY_DIR = Path(__file__).resolve().parent.parent / "registry"
SOURCES_PATH = REGISTRY_DIR / "sources.json"
ALLOCATIONS_PATH = REGISTRY_DIR / "seed_allocations.json"

PROVENANCE_CLASSES = ("real", "derived", "synthetic", "assumed")
RECORD_STATUSES = ("proposed", "active", "suspended", "withdrawn")
GATE3_STATUSES = ("active", "inactive", "withdrawn")
DEDUP_SCOPES = ("within_run",)

# AD-4 §3's transport pairing: which transports each class may carry.
CLASS_TRANSPORTS = {
    "synthetic": frozenset({"synthetic"}),
    "real": frozenset({"websocket", "poll", "scheduled", "manual"}),
    "derived": frozenset({"websocket", "poll", "scheduled", "manual"}),
    "assumed": frozenset({"manual"}),
}

# The record's closed field set (AD-5 §2.2, plus `adapter_id` and `dedup`, which
# select the implementation and name the §5.3 scope). An unknown key is a
# startup failure: a typo that silently did nothing is how a safeguard is lost.
RECORD_FIELDS = (
    "source_id", "display_name", "provider_id", "event_types", "subjects",
    "transport", "provenance_class", "endpoint", "egress_allowlist",
    "credential_ref", "gate3_decision_ref", "freshness_profile", "plausibility",
    "rate_limits", "schedule", "timestamp_basis", "retention_policy_ref",
    "redistribution", "status", "adapter_id", "dedup",
)

# The event types this scope knows. A record naming another is a startup failure
# rather than a source that emits nothing (AD-5 §2.2).
KNOWN_EVENT_TYPES = ("fx_rate",)


class RegistryInvalid(ValueError):
    """A registry record, or the allocation file, failed validation at startup.

    It is a **startup failure, never a partial load** (AD-5 §2.1). The message
    carries the `source_id` and a reason code and **no payload**: AD-1 §3.4
    allows the reason and, where the envelope is well formed, the `event_id`,
    and nothing else reaches a log line.
    """


@dataclass(frozen=True)
class FreshnessProfile:
    """AD-4 §7's profile, with authorization §5.4's synthetic values.

    `live_max_age_ms` is **null for a synthetic source**: AD-4 §8.1 rule 4
    labels a synthetic value **Simulated**, and that rule precedes the Live
    rule, so a Live threshold here would be a dead setting that read as though
    the value could be live.
    """

    expected_interval_ms: int
    live_max_age_ms: Optional[int]
    stale_after_ms: int
    unavailable_after_ms: int
    clock_tolerance_ms: int

    def __post_init__(self) -> None:
        for name in ("expected_interval_ms", "stale_after_ms", "unavailable_after_ms"):
            value = getattr(self, name)
            if not isinstance(value, int) or isinstance(value, bool) or value < 1:
                raise RegistryInvalid(f"freshness_profile.{name} must be a positive integer")
        if not isinstance(self.clock_tolerance_ms, int) or self.clock_tolerance_ms < 0:
            raise RegistryInvalid("freshness_profile.clock_tolerance_ms must be a non-negative integer")
        if self.live_max_age_ms is not None and (
                not isinstance(self.live_max_age_ms, int) or self.live_max_age_ms < 1):
            raise RegistryInvalid("freshness_profile.live_max_age_ms must be a positive integer or null")
        # AD-4 §7's ordering invariant. A value cannot become unavailable before
        # it becomes stale, and neither can precede the interval it is measured
        # against (acceptance criterion 2's fourth negative case).
        if self.live_max_age_ms is not None and self.live_max_age_ms > self.stale_after_ms:
            raise RegistryInvalid("freshness_profile: live_max_age_ms must not exceed stale_after_ms (AD-4 §7)")
        if self.stale_after_ms < self.expected_interval_ms:
            raise RegistryInvalid(
                "freshness_profile: stale_after_ms must be at least expected_interval_ms (AD-4 §7)")
        if self.unavailable_after_ms <= self.stale_after_ms:
            raise RegistryInvalid(
                "freshness_profile: unavailable_after_ms must exceed stale_after_ms (AD-4 §7)")


@dataclass(frozen=True)
class SourceRecord:
    """One validated AD-5 §2.2 record. Immutable at runtime (AD-5 §2.1)."""

    source_id: str
    display_name: str
    provider_id: Optional[str]
    event_types: tuple
    subjects: tuple
    transport: str
    provenance_class: str
    endpoint: Optional[str]
    egress_allowlist: tuple
    credential_ref: Optional[str]
    gate3_decision_ref: Optional[dict]
    freshness_profile: FreshnessProfile
    plausibility: dict
    rate_limits: Optional[dict]
    schedule: Optional[str]
    timestamp_basis: str
    retention_policy_ref: Optional[str]
    redistribution: dict
    status: str
    adapter_id: str
    dedup: str

    @property
    def is_synthetic(self) -> bool:
        return self.provenance_class == "synthetic"

    @property
    def startable(self) -> bool:
        """Only an `active` record may start an adapter (AD-5 §2.4)."""
        return self.status == "active"

    @property
    def pair_keys(self) -> tuple:
        """The subject set as `base/quote` keys, for the §6.1 overlap check."""
        return tuple(f"{s[0]}/{s[1]}" for s in self.subjects if len(s) >= 2)


def _require(condition: bool, source_id: str, reason: str) -> None:
    if not condition:
        raise RegistryInvalid(f"{source_id or '<unnamed>'}: {reason}")


def parse_record(raw: dict) -> SourceRecord:
    """Validates one record and returns it, or raises `RegistryInvalid` (A-2)."""
    if not isinstance(raw, dict):
        raise RegistryInvalid("a registry record must be an object")
    source_id = raw.get("source_id")
    _require(isinstance(source_id, str) and bool(source_id), "", "source_id must be a non-empty string")
    unknown = sorted(set(raw) - set(RECORD_FIELDS))
    _require(not unknown, source_id, f"unknown registry field(s): {', '.join(unknown)}")
    missing = sorted(set(RECORD_FIELDS) - set(raw))
    _require(not missing, source_id, f"missing registry field(s): {', '.join(missing)}")

    provenance_class = raw["provenance_class"]
    transport = raw["transport"]
    _require(provenance_class in PROVENANCE_CLASSES, source_id,
             f"provenance_class must be one of {PROVENANCE_CLASSES}")
    _require(transport in TRANSPORTS, source_id, f"transport must be one of {TRANSPORTS}")
    _require(raw["status"] in RECORD_STATUSES, source_id, f"status must be one of {RECORD_STATUSES}")
    _require(raw["dedup"] in DEDUP_SCOPES, source_id,
             "dedup must be 'within_run': restart-safe deduplication is excluded (§8 item 4)")
    _require(raw["timestamp_basis"] in TIMESTAMP_BASES, source_id,
             f"timestamp_basis must be one of {TIMESTAMP_BASES}")

    # AD-4 §3.2: the `synthetic.` prefix and the synthetic class agree, in both
    # directions. A one-directional check would let a `real` source hide behind
    # a synthetic-looking name, or the reverse.
    prefixed = source_id.startswith("synthetic.")
    _require(prefixed == (provenance_class == "synthetic"), source_id,
             "a 'synthetic.' source_id prefix is required if and only if provenance_class is "
             "'synthetic' (AD-4 §3.2)")
    _require(transport in CLASS_TRANSPORTS[provenance_class], source_id,
             f"transport {transport!r} does not pair with provenance_class "
             f"{provenance_class!r} (AD-4 §3)")
    # Authorization §6.1's synthetic-only assertions, each raised separately so
    # that one passing cannot mask another (acceptance criterion 2).
    if transport == "synthetic":
        _require(raw["endpoint"] is None, source_id,
                 "a synthetic source has no endpoint: it contacts nothing (§6.1)")
        _require(raw["credential_ref"] is None, source_id,
                 "a synthetic source has no credential_ref, and none resolves (§6.1, §8 item 3)")
        _require(raw["egress_allowlist"] == [], source_id,
                 "a synthetic source has an empty egress_allowlist: egress does not exist (§6.1)")
        _require(raw["schedule"] is None, source_id, "a synthetic source has no schedule")
        _require(raw["provider_id"] is None, source_id, "a synthetic source has no provider_id")

    # Gate 3 (A-11, acceptance criterion 10). Unreachable in this scope and
    # present so that a real record cannot be added without an active decision.
    gate3 = raw["gate3_decision_ref"]
    if provenance_class in ("real", "derived"):
        _require(isinstance(gate3, dict), source_id,
                 "a real or derived source requires a Gate 3 decision reference (AD-4 §3.1)")
        _require(gate3.get("status") in GATE3_STATUSES, source_id,
                 f"gate3_decision_ref.status must be one of {GATE3_STATUSES}")
        _require(gate3.get("status") == "active", source_id,
                 f"the Gate 3 decision is {gate3.get('status')!r}, not 'active': the adapter does "
                 "not start (A-11)")
        _require(isinstance(gate3.get("ref"), str) and bool(gate3.get("ref")), source_id,
                 "gate3_decision_ref.ref must be a non-empty string")
    else:
        _require(gate3 is None, source_id,
                 "a synthetic or assumed source carries no Gate 3 decision reference")

    # The Phase 3.3-A transport authorization is checked **after** Gate 3, so
    # that a record failing both reports the Gate 3 refusal: the gate is the
    # more fundamental reason, and it is the one acceptance criterion 10 names.
    _require(transport in AUTHORIZED_TRANSPORTS, source_id,
             f"transport {transport!r} is not authorized in Phase 3.3-A; only "
             f"{AUTHORIZED_TRANSPORTS} is (authorization §8 items 1 and 2)")

    event_types = raw["event_types"]
    _require(isinstance(event_types, list) and bool(event_types), source_id,
             "event_types must be a non-empty list")
    for event_type in event_types:
        _require(event_type in KNOWN_EVENT_TYPES, source_id,
                 f"unknown event_type {event_type!r}; this scope knows {KNOWN_EVENT_TYPES}")

    subjects = raw["subjects"]
    _require(subjects == "open" or (isinstance(subjects, list) and bool(subjects)), source_id,
             "subjects must be 'open' or a non-empty list of component lists")
    if subjects != "open":
        for subject in subjects:
            _require(isinstance(subject, list) and bool(subject)
                     and all(isinstance(c, str) and c for c in subject), source_id,
                     "every subject is a non-empty list of non-empty strings (AD-5 §6.3)")
        _require(len({tuple(s) for s in subjects}) == len(subjects), source_id,
                 "subjects must be unique")

    plausibility = raw["plausibility"]
    _require(isinstance(plausibility, dict)
             and isinstance(plausibility.get("max_relative_jump"), (int, float))
             and not isinstance(plausibility.get("max_relative_jump"), bool)
             and plausibility["max_relative_jump"] > 0, source_id,
             "plausibility.max_relative_jump must be a positive number (AD-5 §10)")
    ranges = plausibility.get("ranges")
    _require(isinstance(ranges, dict), source_id, "plausibility.ranges must be an object")
    for key, bounds in ranges.items():
        _require(isinstance(bounds, dict) and set(bounds) == {"min", "max"}, source_id,
                 f"plausibility.ranges[{key!r}] must carry exactly min and max")
        for name in ("min", "max"):
            # Decimal STRINGS, never floats: a float round-trip loses the
            # producer's digits, and a trailing zero is significant (AD-5 §4).
            _require(isinstance(bounds[name], str), source_id,
                     f"plausibility.ranges[{key!r}].{name} must be a decimal string, not a number "
                     "(AD-5 §4)")

    redistribution = raw["redistribution"]
    _require(isinstance(redistribution, dict) and set(redistribution) == {"permitted", "audience"}
             and isinstance(redistribution["permitted"], bool), source_id,
             "redistribution must carry exactly a boolean 'permitted' and an 'audience'")

    _require(isinstance(raw["adapter_id"], str) and bool(raw["adapter_id"]), source_id,
             "adapter_id must name the adapter implementation this record selects")
    _require(isinstance(raw["egress_allowlist"], list), source_id,
             "egress_allowlist must be a list")
    _require(isinstance(raw["display_name"], str) and bool(raw["display_name"]), source_id,
             "display_name must be a non-empty string")

    return SourceRecord(
        source_id=source_id,
        display_name=raw["display_name"],
        provider_id=raw["provider_id"],
        event_types=tuple(event_types),
        subjects=subjects if subjects == "open" else tuple(tuple(s) for s in subjects),
        transport=transport,
        provenance_class=provenance_class,
        endpoint=raw["endpoint"],
        egress_allowlist=tuple(raw["egress_allowlist"]),
        credential_ref=raw["credential_ref"],
        gate3_decision_ref=gate3,
        freshness_profile=_parse_profile(source_id, raw["freshness_profile"]),
        plausibility=plausibility,
        rate_limits=raw["rate_limits"],
        schedule=raw["schedule"],
        timestamp_basis=raw["timestamp_basis"],
        retention_policy_ref=raw["retention_policy_ref"],
        redistribution=redistribution,
        status=raw["status"],
        adapter_id=raw["adapter_id"],
        dedup=raw["dedup"],
    )


PROFILE_FIELDS = tuple(FreshnessProfile.__dataclass_fields__)


def _parse_profile(source_id: str, raw) -> FreshnessProfile:
    """The freshness profile, with its field set closed.

    An unknown key is a startup failure rather than a `TypeError`: a misspelled
    `stale_after_ms` that silently kept the default would be a freshness rule
    nobody applied.
    """
    _require(isinstance(raw, dict), source_id, "freshness_profile must be an object (AD-4 §7)")
    unknown = sorted(set(raw) - set(PROFILE_FIELDS))
    _require(not unknown, source_id, f"unknown freshness_profile field(s): {', '.join(unknown)}")
    missing = sorted(set(PROFILE_FIELDS) - set(raw))
    _require(not missing, source_id, f"missing freshness_profile field(s): {', '.join(missing)}")
    try:
        return FreshnessProfile(**raw)
    except RegistryInvalid as exc:
        raise RegistryInvalid(f"{source_id}: {exc}") from None


@dataclass(frozen=True)
class SeedAllocation:
    """One recorded allocation (AD-12 §3.1 mitigation 1, authorization §6.1).

    Read-only at runtime and never written by the process. Changing one is a
    reviewed commit, which is the audit trail the container posture makes the
    only possible form of the record.
    """

    seed: int
    source_id: str
    subjects: tuple
    period: str
    active: bool
    intent: str = ""

    @property
    def pair_keys(self) -> tuple:
        return tuple(f"{s[0]}/{s[1]}" for s in self.subjects if len(s) >= 2)


@dataclass(frozen=True)
class Registry:
    """The loaded, validated registry and its seed allocations."""

    records: tuple = ()
    allocations: tuple = ()

    def record_for(self, source_id: str) -> Optional[SourceRecord]:
        for record in self.records:
            if record.source_id == source_id:
                return record
        return None

    def active_records(self) -> tuple:
        return tuple(r for r in self.records if r.startable)

    def allocation_for(self, source_id: str) -> Optional[SeedAllocation]:
        for allocation in self.allocations:
            if allocation.source_id == source_id and allocation.active:
                return allocation
        return None


def parse_allocation(raw: dict) -> SeedAllocation:
    if not isinstance(raw, dict):
        raise RegistryInvalid("a seed allocation must be an object")
    source_id = raw.get("source_id")
    _require(isinstance(source_id, str) and bool(source_id), "", "an allocation needs a source_id")
    seed = raw.get("seed")
    _require(isinstance(seed, int) and not isinstance(seed, bool) and 0 <= seed <= 2 ** 53 - 1,
             source_id, "an allocation's seed must be an integer in [0, 2^53 - 1] (AD-4 §3.2)")
    subjects = raw.get("subjects")
    _require(isinstance(subjects, list) and bool(subjects), source_id,
             "an allocation records the subject set it covers (mitigation 2)")
    _require(isinstance(raw.get("period"), str) and bool(raw["period"]), source_id,
             "an allocation records its intended period")
    _require(isinstance(raw.get("active"), bool), source_id,
             "an allocation records whether it is active")
    unknown = sorted(set(raw) - {"seed", "source_id", "subjects", "period", "active", "intent"})
    _require(not unknown, source_id, f"unknown allocation field(s): {', '.join(unknown)}")
    return SeedAllocation(
        seed=seed, source_id=source_id,
        subjects=tuple(tuple(s) for s in subjects),
        period=raw["period"], active=raw["active"], intent=raw.get("intent", ""),
    )


def _load_json(path: Path, what: str) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RegistryInvalid(f"the {what} file could not be read: {path.name}") from exc
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        # The filename and the position, never the content: a malformed registry
        # is a configuration fault, and its text is not log material.
        raise RegistryInvalid(
            f"the {what} file is not valid JSON: {path.name} at line {exc.lineno}") from exc


def load_registry(sources_path: Path = None, allocations_path: Path = None) -> Registry:
    """Loads and validates both files, or raises `RegistryInvalid` (AD-5 §2.1).

    **Never a partial load.** Every record is validated before any is returned,
    so a service either has the whole reviewed source set or does not start.
    """
    sources_path = SOURCES_PATH if sources_path is None else Path(sources_path)
    allocations_path = ALLOCATIONS_PATH if allocations_path is None else Path(allocations_path)

    sources_doc = _load_json(sources_path, "registry")
    _require(isinstance(sources_doc, dict) and isinstance(sources_doc.get("sources"), list), "",
             "the registry file must be an object with a 'sources' list")
    records = tuple(parse_record(raw) for raw in sources_doc["sources"])

    allocations_doc = _load_json(allocations_path, "seed allocation")
    _require(isinstance(allocations_doc, dict) and isinstance(allocations_doc.get("allocations"), list),
             "", "the allocation file must be an object with an 'allocations' list")
    allocations = tuple(parse_allocation(raw) for raw in allocations_doc["allocations"])

    registry = Registry(records=records, allocations=allocations)
    check_source_id_uniqueness(records)
    check_allocations(records, allocations)
    return registry


# ------------------------------------------------------- §6.1 collision safeguards
def check_source_id_uniqueness(records: Sequence[SourceRecord]) -> None:
    """**One active generator configuration per `source_id`** (AD-4 Part 2 §3.4
    item 3), on the registry-selected synthetic adapter path.

    **Granted for Phase 3.3-A only**, by the owner's decision of 27 November 2026
    (authorization §6.1, §13.3): it is a **registry configuration rule** here. It
    changes **no derivation and no envelope field**, the approved C-1 derivation
    stands unchanged, AD-4 Part 2 is **not approved as a document**, and the rule
    does **not** extend to milestone 3.3-L or any later milestone. **The D-24
    generator path is exempt**, exactly as it is exempt from the overlap refusal.

    Its benefit is **dedup-state separation, not collision prevention** (§6.1's
    Anvesh 2 correction): `source_id` is absent from the C-1 derivation, so a
    second `source_id` does not prevent an `event_id` collision. What it
    separates is `observation_key`'s first component, so two streams no longer
    overwrite each other's dedup state. The collision still occurs and is still
    detected.
    """
    seen = {}
    for record in records:
        if not record.startable:
            continue
        if record.source_id in seen:
            raise RegistryInvalid(
                f"{record.source_id}: two active registry records share this source_id; the "
                "registry permits one active generator configuration per source_id, and a "
                "second configuration is a second source_id (AD-4 Part 2 §3.4 item 3, granted "
                "for Phase 3.3-A only)")
        seen[record.source_id] = record


def check_allocations(records: Sequence[SourceRecord],
                      allocations: Sequence[SeedAllocation]) -> None:
    """AD-12 §3.1's mitigations 1 to 3, over the **registry-selected** sources.

    1. **Coordinated seed allocation.** Every registry-selected source takes its
       seed from a recorded allocation. A source with no entry is a **refusal**.
    2. **Disjoint subjects.** Active allocations use disjoint pair sets, so
       `pair` never repeats across them.
    3. **The start-up refusal.** An overlapping `(seed, pair)` against another
       allocation active for the same period is a **refusal**.

    **In-process and local, and stated as such** (§12 item 8): it reads the
    allocation file and the records the service is starting, and it **cannot**
    detect a second container started independently against the same consumer.
    That limitation is recorded, not papered over.

    **The env-configured D-24 generator is not passed here and needs no entry.**
    """
    by_source = {}
    for allocation in allocations:
        if not allocation.active:
            continue
        by_source.setdefault(allocation.source_id, []).append(allocation)

    for record in records:
        if not record.startable:
            continue
        entries = by_source.get(record.source_id, [])
        if not entries:
            raise RegistryInvalid(
                f"{record.source_id}: a registry-selected source needs a recorded seed allocation; "
                "none is active in seed_allocations.json (AD-12 §3.1 mitigation 1). The "
                "env-configured D-24 generator is exempt and is not checked here")
        if len(entries) > 1:
            raise RegistryInvalid(
                f"{record.source_id}: more than one active seed allocation (AD-12 §3.1)")
        allocation = entries[0]
        if record.subjects != "open" and set(allocation.subjects) != set(record.subjects):
            raise RegistryInvalid(
                f"{record.source_id}: the allocation's subject set does not match the registry "
                "record's (AD-12 §3.1 mitigation 1)")

    active = [a for a in allocations if a.active]
    for i, first in enumerate(active):
        for second in active[i + 1:]:
            # Mitigation 2: disjoint subjects across sources registered together.
            shared_pairs = set(first.pair_keys) & set(second.pair_keys)
            # Both mitigations are **period-scoped**: AD-12 §3.1 mitigation 2
            # binds sources "registered at the same time", and two allocations
            # whose periods do not meet are never active together.
            if not _periods_overlap(first.period, second.period):
                continue
            if first.source_id != second.source_id and shared_pairs:
                raise RegistryInvalid(
                    f"{first.source_id} and {second.source_id}: active allocations must use "
                    f"disjoint pair sets; they share {sorted(shared_pairs)} "
                    "(AD-12 §3.1 mitigation 2)")
            # Mitigation 3: the (seed, pair) overlap refusal. A shared seed with a
            # shared pair reproduces the C-1 collision inputs exactly.
            if first.seed == second.seed and shared_pairs:
                raise RegistryInvalid(
                    f"{first.source_id} and {second.source_id}: allocations overlap on seed "
                    f"{first.seed} and pair(s) {sorted(shared_pairs)} for the same period "
                    "(AD-12 §3.1 mitigation 3)")


def _periods_overlap(first: str, second: str) -> bool:
    """Whether two `start/end` period strings overlap. `open` means no end.

    Deliberately simple: the periods are human-written review metadata, so a
    string that is not a well-formed range is treated as overlapping. **Failing
    towards a refusal is the safe direction** — a malformed period must not let
    an overlap through.
    """
    def bounds(period: str):
        parts = period.split("/", 1)
        start = parts[0].strip()
        end = parts[1].strip() if len(parts) == 2 else "open"
        return start, ("" if end in ("", "open") else end)

    try:
        first_start, first_end = bounds(first)
        second_start, second_end = bounds(second)
    except Exception:  # noqa: BLE001 - a malformed period refuses, it does not pass
        return True
    if not first_start or not second_start:
        return True
    # ISO dates compare correctly as strings; an empty end is unbounded.
    if first_end and first_end < second_start:
        return False
    if second_end and second_end < first_start:
        return False
    return True


def check_description(record: SourceRecord, description: AdapterDescription) -> None:
    """`describe()` against the record. **A mismatch is a startup failure, not a
    warning** (acceptance criterion 1, AD-5 §2.2).

    The description is **static** — it describes the code — so this check can
    actually contradict the configuration. A description that varied with the
    record could never disagree with it, and the check would be vacuous.
    """
    source_id = record.source_id
    _require(description.adapter_id == record.adapter_id, source_id,
             f"the record selects adapter {record.adapter_id!r} but the adapter describes itself "
             f"as {description.adapter_id!r}")
    _require(record.transport in description.transports, source_id,
             f"the record's transport {record.transport!r} is not among the adapter's "
             f"{description.transports}")
    missing_types = sorted(set(record.event_types) - set(description.event_types))
    _require(not missing_types, source_id,
             f"the record permits event type(s) {missing_types} the adapter cannot emit")
    if record.subjects != "open":
        missing_subjects = sorted(set(record.subjects) - set(description.subjects))
        _require(not missing_subjects, source_id,
                 f"the record permits {len(missing_subjects)} subject(s) the adapter cannot emit")
    _require(description.emits_timestamp_basis == record.timestamp_basis, source_id,
             f"the record's timestamp_basis {record.timestamp_basis!r} differs from the "
             f"adapter's {description.emits_timestamp_basis!r} (AD-4 §5)")
    for required in description.required_registry_fields:
        _require(required in RECORD_FIELDS, source_id,
                 f"the adapter requires registry field {required!r}, which the record has no "
                 "field for")


def selected_records(registry: Registry, source_ids: Iterable[str] = ()) -> tuple:
    """The active records a caller selects, validated for startability.

    **An empty selection is the default and selects nothing**, which is what
    keeps the D-24 generator path the service default: no registry record
    selects the adapter path unless a caller names one (authorization §7.2).
    """
    wanted = tuple(source_ids)
    if not wanted:
        return ()
    chosen = []
    for source_id in wanted:
        record = registry.record_for(source_id)
        _require(record is not None, source_id, "no registry record names this source_id")
        _require(record.startable, source_id,
                 f"the record's status is {record.status!r}, not 'active': the adapter does not "
                 "start (AD-5 §2.4)")
        chosen.append(record)
    return tuple(chosen)
