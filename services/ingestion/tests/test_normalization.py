"""Acceptance criterion 7: normalization (A-8), **format work only** (AD-5 §4).

Four claims, which are the four the criterion names:

1. **Decimal strings survive with their trailing zeros.** A trailing zero is
   significant to the payload hash (AD-5 §4), so `2.200000` and `2.2` are
   different strings even though they are the same number, and normalization
   must not normalize them into each other.
2. **No float round-trip.** Asserted as a *rejection* of a non-string rate, not
   as a tolerance on a converted one: by the time a float has been accepted the
   producer's digits are already gone, and no later check can recover them.
3. **Codes map only through the mapping table.** `pairs.py` is the one table;
   a code or a `rate_type` outside it cannot be produced, and cannot be admitted
   if it somehow were.
4. **A missing required field is a rejection, not a default.** An `item_invalid`
   fault, so the item is discarded and counted — never silently completed with a
   plausible-looking value.

**Scope.** This suite tests normalization as the **contract** defines it:
`NormalizedObservation`'s invariants (Dev A, `base.py`) and the one shipped
`normalize()` against that contract. It does **not** re-assert the adapter state
machine (criterion 1, `test_adapter_contract.py`), the generator's rate
arithmetic (`test_generator.py`), or envelope hashing
(`test_payload_hash.py`) — normalization happens strictly before any of those.
"""
from __future__ import annotations

from decimal import Decimal

import pytest

from cbdc_ingestion.adapters.base import NormalizedObservation
from cbdc_ingestion.adapters.faults import AdapterFault, FaultClass
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.generator import rate_for
from cbdc_ingestion.pairs import CURRENCIES, PAIRS, RATE_TYPE, Pair, is_allowed
from cbdc_ingestion.pipeline import admit

from .adapter_cases import SYNTHETIC_FX_SOURCE_ID
from .conftest import SEED, START_MS

EURUSD_PAIR = Pair("EUR", "USD")


@pytest.fixture
def record():
    return load_registry().record_for(SYNTHETIC_FX_SOURCE_ID)


@pytest.fixture
def adapter(record):
    built = SyntheticFxAdapter.for_record(record, SEED)
    built.start_ms = START_MS
    return built


def raw(**overrides) -> dict:
    item = {"pair": EURUSD_PAIR, "rate": "2.200000", "at_ms": START_MS, "sequence": 1}
    item.update(overrides)
    return item


# ------------------------------------------------- 1. decimal strings, as given
@pytest.mark.parametrize("rate", ["2.200000", "2.2", "2.20", "0.000001", "1234.567890"])
def test_the_rate_string_survives_byte_for_byte(adapter, rate):
    """The exact characters the producer gave, not a reformatted equivalent."""
    assert adapter.normalize(raw(rate=rate)).payload["rate"] == rate


def test_two_rates_equal_as_numbers_stay_distinct_as_strings(adapter):
    """`Decimal("2.2") == Decimal("2.200000")` is true, and the two must still
    normalize to different strings: the payload hash is over the string, so
    collapsing them would change an event's identity (AD-5 §4)."""
    assert Decimal("2.2") == Decimal("2.200000")
    short = adapter.normalize(raw(rate="2.2")).payload["rate"]
    long = adapter.normalize(raw(rate="2.200000", sequence=2)).payload["rate"]
    assert short != long


def test_the_generators_own_digits_are_preserved_through_normalization(adapter):
    """The real path, not a crafted string: whatever `rate_for` produced is what
    lands in the payload. If normalization reformatted it, this adapter's hashes
    would differ from the D-24 path's for the same `(seed, pair, sequence)`."""
    for sequence in range(1, 6):
        for pair in PAIRS:
            produced = rate_for(SEED, pair, sequence)
            observation = adapter.normalize(raw(pair=pair, rate=produced, sequence=sequence))
            assert observation.payload["rate"] == produced


# -------------------------------------------------------- 2. no float round-trip
@pytest.mark.parametrize("rate", [2.2, 2, Decimal("2.2"), None, True])
def test_a_rate_that_is_not_a_decimal_string_is_rejected(adapter, rate):
    """Rejected, **not** converted. A `Decimal` and an `int` are rejected too:
    both are perfectly precise, but accepting either would mean the component has
    two representations of a rate and one of them has no defined canonical form
    (AD-5 §4). `True` is in the list because `isinstance(True, int)` holds.
    """
    with pytest.raises(AdapterFault) as caught:
        adapter.normalize(raw(rate=rate))
    assert caught.value.fault_class is FaultClass.ITEM_INVALID
    assert caught.value.reason == "rate_not_a_decimal_string"


def test_the_rejection_is_an_item_fault_so_one_bad_rate_keeps_the_adapter_running(adapter):
    """An `item_invalid` fault is item-level: one bad rate discards that item and
    does **not** discard the good items beside it or move the adapter's state."""
    with pytest.raises(AdapterFault) as caught:
        adapter.normalize(raw(rate=2.2))
    assert caught.value.item_level is True
    assert caught.value.permanent is False


def test_no_module_converts_a_rate_through_a_float():
    """A static check, because the dynamic one can only sample: no source file in
    the component calls `float(` on anything. A single `float()` on a rate would
    pass every value test above while silently losing digits at the 17th."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1] / "cbdc_ingestion"
    sources = sorted(root.rglob("*.py"))
    assert len(sources) >= 8, sources
    offenders = []
    for path in sources:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#") or "float(" not in stripped:
                continue
            offenders.append(f"{path.name}:{number}: {stripped}")
    assert offenders == [], offenders


# ------------------------------------------------------- 3. the mapping table only
def test_every_subject_the_adapter_declares_comes_from_the_table(adapter):
    """`describe().subjects` is derived from `PAIRS`, not written out again: a
    second list would be a second mapping table, and the two would drift."""
    declared = adapter.describe().subjects
    assert declared == tuple((p.base, p.quote, RATE_TYPE) for p in PAIRS)


def test_the_normalized_subject_and_payload_agree(adapter):
    """The subject tuple and the payload codes are the same three values. A
    disagreement would make `dedup.subject_of` key an event on something other
    than what the payload says it is."""
    for pair in PAIRS:
        observation = adapter.normalize(raw(pair=pair))
        assert observation.subject == (pair.base, pair.quote, RATE_TYPE)
        assert observation.payload["base_currency"] == pair.base
        assert observation.payload["quote_currency"] == pair.quote
        assert observation.payload["rate_type"] == RATE_TYPE


def test_only_the_tables_codes_exist_and_only_its_rate_type(adapter):
    for pair in PAIRS:
        observation = adapter.normalize(raw(pair=pair))
        assert observation.payload["base_currency"] in CURRENCIES
        assert observation.payload["quote_currency"] in CURRENCIES
        assert observation.payload["rate_type"] == "mid"
    assert is_allowed("EUR", "USD") is True
    assert is_allowed("USD", "EUR") is False, "the (base, quote) order is part of the key"
    assert is_allowed("XXX", "YYY") is False


def test_a_pair_outside_the_table_is_refused_at_admission(record, adapter):
    """Normalization is format work and does not police the allowlist; `admit`
    does, before anything is built. Asserted here so criterion 7's "codes map
    only through the mapping table" has an enforcement point named, rather than
    resting on the adapter never trying."""
    outside = adapter.normalize(raw(pair=Pair("XXX", "YYY")))
    with pytest.raises(AdapterFault) as caught:
        admit(record, outside)
    assert caught.value.reason == "subject_not_permitted"


def test_a_rate_type_outside_the_table_cannot_be_produced(adapter):
    """`rate_type` is a module constant, not a per-item input, so no raw item can
    carry another one into a payload. Asserted by trying: a `rate_type` on the
    raw item is ignored, because `normalize` reads the table and not the item."""
    assert RATE_TYPE == "mid"
    observation = adapter.normalize(raw(rate_type="bid"))
    assert observation.payload["rate_type"] == "mid"
    assert observation.subject[2] == "mid"


# --------------------------------------- 4. a missing field is not a default
@pytest.mark.parametrize("field", ["pair", "rate", "at_ms", "sequence"])
def test_a_missing_required_field_is_a_rejection_not_a_default(adapter, field):
    """Each of the four, individually, so one being checked cannot mask another."""
    item = raw()
    del item[field]
    with pytest.raises(AdapterFault) as caught:
        adapter.normalize(item)
    assert caught.value.fault_class is FaultClass.ITEM_INVALID
    assert caught.value.reason == f"missing_{field}"


def test_no_timestamp_is_ever_filled_from_a_local_clock(adapter):
    """`source_timestamp_ms` is the raw item's scheduled moment, never now
    (AD-5 §3.5, AD-4 §5). Asserted with a moment far from any real clock, so a
    wall-clock fallback could not coincidentally match."""
    observation = adapter.normalize(raw(at_ms=START_MS - 86_400_000))
    assert observation.source_timestamp_ms == START_MS - 86_400_000
    assert observation.source_timestamp_basis == "observed"


# -------------------------------------- the contract the observation must satisfy
def test_a_normalized_observation_carries_no_identity_and_no_envelope(adapter):
    """Format work only: no `event_id`, no `payload_sha256`, no envelope fields.
    Identity and hashing are the service's (AD-5 §3.1, §3.4)."""
    observation = adapter.normalize(raw())
    assert set(observation.payload) == {"base_currency", "quote_currency", "rate", "rate_type"}
    for forbidden in ("event_id", "payload_sha256", "validation", "source", "timestamps"):
        assert not hasattr(observation, forbidden)


def test_a_null_timestamp_requires_the_none_basis():
    """AD-4 §5's nullability rule, enforced where the value is **made** and not
    only where it is validated — so an adapter cannot construct the inconsistent
    pair at all."""
    with pytest.raises(ValueError):
        NormalizedObservation(event_type="fx_rate", subject=("EUR", "USD", "mid"),
                              payload={}, source_timestamp_ms=None,
                              source_timestamp_basis="observed")
    with pytest.raises(ValueError):
        NormalizedObservation(event_type="fx_rate", subject=("EUR", "USD", "mid"),
                              payload={}, source_timestamp_ms=START_MS,
                              source_timestamp_basis="none")


def test_an_unknown_timestamp_basis_is_refused():
    with pytest.raises(ValueError):
        NormalizedObservation(event_type="fx_rate", subject=("EUR", "USD", "mid"),
                              payload={}, source_timestamp_ms=START_MS,
                              source_timestamp_basis="inferred")
