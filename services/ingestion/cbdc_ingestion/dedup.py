"""AD5-Q1's two keys and AD5-Q8's three outcomes (AD-5 v0.8 §8.1, §8.2, §8.2b).

**Adapter path only.** The D-24 generator path runs on **AD-1 §3.4 exactly as
approved**, keyed on `event_id` inequality, through `store.LatestStore`. Nothing
here touches it: AD5-Q11(a) gives each path its own rule, and the two differ in
one cell (two events with equal payloads and unequal `event_id`s are AD-1's
conflict and AD-5's duplicate). `LatestStore` is unchanged.

**Two keys, because one cannot answer both questions** (§8.1):

```text
observation_key  = (source_id, event_type, subject, source_timestamp)
idempotency_key  = (observation_key, payload_sha256)
```

`observation_key` detects a **conflict**; `idempotency_key` detects a
**duplicate**. The hash is inside the idempotency key, so two events with
different payloads have different idempotency keys **by construction**.

**Evaluation order is C-b, then D, then C-a, and the order is a requirement**
(§8.2). C-b gets **its own index, keyed on `event_id` alone** — not on either
§8.1 key — because an identity collision lands in two ways the §8.1 keys miss:

- **Sharing the `idempotency_key` exactly.** Events differing only in
  `synthetic.case_id`, `synthetic.generator_version`, `synthetic.seed`,
  `source_sequence` or `supersedes` have both keys equal. Evaluated second, such
  an event is classified **D** and **silently discarded** — the C-1 defect.
  `source_sequence` is a C-1 input and nothing forces it to change the payload,
  so this is not hypothetical.
- **Matching neither key.** Events sharing an `event_id` but differing in
  `source_timestamp` have a different `observation_key`, hence a different
  `idempotency_key`, so they match neither D nor C-a and would be **accepted
  while carrying an already-used identity**.

**The window is the bound on detection, not merely on memory** (§8.2). The
`event_id` index retains the `event_id` and the §8.2b comparison fields — **never
the payload** — for the source's AD-8 `dedup_window`, 300 s here (authorization
§5.3). A collision whose first arrival has fallen out of the window is **not
detected**, and the later event is accepted as new. Stated, not hidden.

**In-process only.** `dedup: within_run` (§8.5, authorization §8 item 4):
**no restart-safe deduplication**, no acknowledgement, no replay. A restart
loses the state, and the source's record declares that scope.
"""
from __future__ import annotations

import threading
from typing import Optional

# Authorization §5.3: the synthetic transport's dedup window. Long enough to
# cover a redelivery, short enough to bound memory.
DEDUP_WINDOW_MS = 300_000

# AD-5 §8.2's three outcomes, plus the ordinary one.
ACCEPTED = "accepted"
DUPLICATE = "duplicate"              # D
VALUE_CONFLICT = "value_conflict"    # C-a
IDENTITY_COLLISION = "identity_collision"  # C-b

OUTCOMES = (ACCEPTED, DUPLICATE, VALUE_CONFLICT, IDENTITY_COLLISION)

# §8.2b.1's identity-bearing fields, as schema paths. `event_id` is the C-b key
# and equal by definition in every candidate, so it is not compared.
#
# **Excluded, deliberately:** `raw_sha256` (Dev B accepts the exclusion; its
# integrity obligations are unchanged), `timestamps.retrieved_at`,
# `timestamps.emitted_at`, `validation.*`, `extraction`, `review` — each records
# when, by which process, or with what verdict *we* handled the event, and each
# legitimately differs between two deliveries of one observation. Including them
# would turn every redelivery into a rejected collision and break at-least-once
# delivery outright (§3.7 H-1).
#
# **`instance_id` is absent by construction, not by exclusion.** It is not an
# envelope field at any level; it lives on the batch wrapper. So a restarted
# producer's redelivery of one envelope is a **duplicate** whatever wrapper
# carried it.
IDENTITY_BEARING_PATHS = (
    "payload_sha256",
    "event_type",
    "source.source_id",
    "source.transport",
    "source.source_url",
    "source.gate3_decision_ref",
    "source_sequence",
    "timestamps.source_timestamp",
    "timestamps.source_timestamp_basis",
    "provenance_class",
    "derived_from",
    "derivation",
    "synthetic.seed",
    "synthetic.case_id",
    "synthetic.generator_version",
    "supersedes",
)

EXCLUDED_PATHS = (
    "raw_sha256", "timestamps.retrieved_at", "timestamps.emitted_at",
    "validation.status", "validation.reasons", "extraction", "review",
    "schema_version", "usage",
)

# `derived_from` is compared as an **unordered set** (Dev B's recommendation,
# adopted): the schema declares `uniqueItems: true` with no ordering semantics
# stated anywhere, and AD-4 §6's v1 single-source rule keeps it at at most one
# element, so set and sequence comparison coincide today. If ordering is ever
# given meaning, this must change with it.
SET_COMPARED_PATHS = frozenset({"derived_from"})


def _at(event: dict, path: str):
    """The value at a dotted schema path, or `None` when a parent is absent.

    A `None` parent and a `None` leaf compare equal, which is correct here: an
    absent `synthetic` block and a null one both mean "no synthetic provenance",
    and the schema permits only one of the two for a given class anyway.
    """
    current = event
    for part in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(part)
    return current


def subject_of(event: dict) -> tuple:
    """The event's subject, as AD-5 §6.3's ordered tuple.

    For `fx_rate` it is `(base, quote, rate_type)` — **the pair is a C-1 input**
    and the field the three-part key of scope §3.B could not distinguish. A type
    without a defined subject yields the empty tuple, which is what
    `announcement` needs (§6.3); no such type exists in this scope.
    """
    payload = event.get("payload") or {}
    if event.get("event_type") == "fx_rate":
        return (payload.get("base_currency"), payload.get("quote_currency"),
                payload.get("rate_type"))
    return ()


def observation_key(event: dict) -> tuple:
    """`(source_id, event_type, subject, source_timestamp)` (§8.1).

    **A null `source_timestamp` falls back to `retrieved_at`**, and such a source
    is not restart-safe (§8.1's case table, §8.4). Unreachable in this scope:
    AD-1 §3.4 rejects a null source timestamp outright and `pipeline.admit`
    refuses it before the classifier sees it.
    """
    timestamps = event.get("timestamps") or {}
    moment = timestamps.get("source_timestamp") or timestamps.get("retrieved_at")
    return (_at(event, "source.source_id"), event.get("event_type"),
            subject_of(event), moment)


def idempotency_key(event: dict) -> tuple:
    """`(observation_key, payload_sha256)` (§8.1)."""
    return (observation_key(event), event.get("payload_sha256"))


def identity_fields(event: dict) -> dict:
    """The §8.2b comparison fields. **Never the payload** (§8.2's horizon note).

    `payload_sha256` stands in for the payload, which is the point: the index
    can detect a differing payload without retaining one.
    """
    snapshot = {}
    for path in IDENTITY_BEARING_PATHS:
        value = _at(event, path)
        if path in SET_COMPARED_PATHS:
            value = frozenset(value or ())
        snapshot[path] = value
    return snapshot


def differing_identity_fields(first: dict, second: dict) -> tuple:
    """Which identity-bearing fields differ between two snapshots.

    Returned rather than a bare boolean so a counter and a log line can name the
    field: C-1 showed that a conflict loop can stall a subject for a whole run
    while showing only as a count (AD-8 §7.3 Q-2, both classes alertable).
    """
    return tuple(path for path in IDENTITY_BEARING_PATHS
                 if first.get(path) != second.get(path))


class _Entry:
    __slots__ = ("fields", "seen_ms")

    def __init__(self, fields: dict, seen_ms: int) -> None:
        self.fields = fields
        self.seen_ms = seen_ms


class DedupIndex:
    """The within-run deduplication state for one source.

    Three indexes, because the three outcomes ask three different questions:
    an `event_id` index for C-b, an `idempotency_key` set for D, and an
    `observation_key` map for C-a. All are pruned to `window_ms`.

    **Bounded.** Entries hold the `event_id`, the comparison fields and a
    timestamp. No payload, no envelope, no provider text.
    """

    def __init__(self, *, window_ms: int = DEDUP_WINDOW_MS) -> None:
        if window_ms < 1:
            raise ValueError("the dedup window must be positive (AD-8 §5.3)")
        self.window_ms = int(window_ms)
        self._lock = threading.RLock()
        self._by_event_id: dict = {}
        self._by_idempotency: dict = {}
        self._by_observation: dict = {}
        self.counters = {name: 0 for name in OUTCOMES}
        self.collision_fields: dict = {}

    # ------------------------------------------------------------------ pruning
    def prune(self, now_ms: int) -> int:
        """Drops entries older than the window. Returns how many went.

        Pruning is what makes the window the **bound on detection**: once a first
        arrival is dropped, a later collision against it is accepted as new.
        """
        cutoff = int(now_ms) - self.window_ms
        dropped = 0
        with self._lock:
            for index in (self._by_event_id, self._by_idempotency, self._by_observation):
                stale = [k for k, entry in index.items() if entry.seen_ms < cutoff]
                for key in stale:
                    del index[key]
                dropped += len(stale)
        return dropped

    def __len__(self) -> int:
        with self._lock:
            return len(self._by_event_id)

    # ----------------------------------------------------------------- classify
    def classify(self, event: dict, now_ms: int) -> tuple:
        """Classifies `event` and records it. Returns `(outcome, detail)`.

        **The order is C-b, then D, then C-a** (§8.2), and C-b is evaluated
        against the `event_id` index alone. `detail` names the differing fields
        for C-b, and is `()` otherwise.

        A rejected or discarded event is **not** recorded as a new first
        arrival: the **first is kept** in every one of the three outcomes, so
        overwriting the index would let a later arrival become the baseline.
        """
        now_ms = int(now_ms)
        self.prune(now_ms)
        event_id = event.get("event_id")
        fields = identity_fields(event)
        obs_key = observation_key(event)
        idem_key = (obs_key, event.get("payload_sha256"))

        with self._lock:
            # --- C-b: same event_id, differing event content (§8.2b) ---------
            seen = self._by_event_id.get(event_id)
            if seen is not None:
                differing = differing_identity_fields(seen.fields, fields)
                if differing:
                    self.counters[IDENTITY_COLLISION] += 1
                    for path in differing:
                        self.collision_fields[path] = self.collision_fields.get(path, 0) + 1
                    return IDENTITY_COLLISION, differing

            # --- D: same idempotency_key as an event already seen ------------
            if idem_key in self._by_idempotency:
                self.counters[DUPLICATE] += 1
                return DUPLICATE, ()

            # --- C-a: same observation_key, different payload_sha256, and no
            # --- validated `supersedes` (§8.2a) -------------------------------
            prior = self._by_observation.get(obs_key)
            if prior is not None and prior.fields.get("payload_sha256") != event.get(
                    "payload_sha256"):
                if not _declares_correction(event):
                    self.counters[VALUE_CONFLICT] += 1
                    return VALUE_CONFLICT, ()

            entry = _Entry(fields, now_ms)
            self._by_event_id[event_id] = entry
            self._by_idempotency[idem_key] = entry
            self._by_observation[obs_key] = entry
            self.counters[ACCEPTED] += 1
            return ACCEPTED, ()

    def forget(self, event: dict) -> bool:
        """Removes an accepted event from all three indexes. Returns whether it was there.

        **Why an accepted event is ever withdrawn.** `classify` records the event
        *before* the service publishes it, because it must: a duplicate has to be
        recognized before it reaches the sink, not after. If the publication then
        fails, the index is left asserting that an event was seen which no
        consumer ever received — and the **next delivery of that same
        observation would be discarded as a duplicate**, so the value would be
        lost for the whole run. Within `within_run` scope that is the one
        retry-safety property this index still owes.

        Only the caller that accepted the event may withdraw it, and only for its
        own failed publish. It is **not** a rollback of a rejection: a C-b, a D
        and a C-a each keep the first arrival, which is never withdrawn.
        """
        event_id = event.get("event_id")
        obs_key = observation_key(event)
        idem_key = (obs_key, event.get("payload_sha256"))
        with self._lock:
            entry = self._by_event_id.get(event_id)
            if entry is None:
                return False
            # Only withdraw the entries this very event owns. A later event
            # sharing the observation key would have been a D or a C-a and so
            # never became an entry, but the check costs nothing and makes the
            # method safe to call out of order.
            for index, key in ((self._by_event_id, event_id),
                               (self._by_idempotency, idem_key),
                               (self._by_observation, obs_key)):
                if index.get(key) is entry:
                    del index[key]
            if self.counters[ACCEPTED] > 0:
                self.counters[ACCEPTED] -= 1
            return True

    def snapshot(self) -> dict:
        with self._lock:
            return {"counters": dict(self.counters), "entries": len(self._by_event_id),
                    "collision_fields": dict(self.collision_fields)}


def _declares_correction(event: dict) -> bool:
    """Whether the event carries a **validated** `supersedes` (§8.2a).

    A declared revision is not a conflict; an unexplained second value is.
    **An adapter sets `supersedes` only from something the provider actually
    published and never infers a correction from a value simply differing**
    (AD5-Q10) — inferring one is what turns a C-a conflict into a silent
    overwrite. For a synthetic source this is **unreachable by invariant**: the
    generator publishes no corrections and `envelope.py` writes
    `supersedes: None`.
    """
    if not event.get("supersedes"):
        return False
    return (event.get("validation") or {}).get("status") == "validated"
