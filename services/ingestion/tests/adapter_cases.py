"""The adapters the shared contract suite runs over (acceptance criterion 1).

Every adapter in the component is listed in `ADAPTERS`, so A-1's "every adapter
passes one shared suite" is enforced by construction rather than by convention.
`test_registry.py` asserts that the list covers every `Adapter` subclass the
package defines, so a new adapter cannot be added without joining the suite.

`_ContractProbe` is a **test-only** minimal adapter. It exists so the suite
tests the base contract itself — the state machine, cancellation, the
unidirectional rule — independently of any shipped adapter's own behaviour. It
is never registered, never packaged and never reachable at runtime.
"""
from __future__ import annotations

from typing import Sequence

from cbdc_ingestion.adapters.base import Adapter, AdapterDescription, NormalizedObservation
from cbdc_ingestion.adapters.context import AdapterContext, CancellationSignal, NullMetrics
from cbdc_ingestion.adapters.registry import load_registry
from cbdc_ingestion.adapters.synthetic_fx import SyntheticFxAdapter
from cbdc_ingestion.clock import ManualClock

from .conftest import SEED, START_MS

PROBE_SOURCE_ID = "synthetic.contract_probe"
SYNTHETIC_FX_SOURCE_ID = "synthetic.fx.adapter"
PROBE_INTERVAL_MS = 2000


class _CollectingSink:
    """A sink stand-in for the contract suite: it records and does nothing else."""

    def __init__(self) -> None:
        self.observations: list = []
        self.quarantine: list = []
        self.faults: list = []

    def publish(self, channel: str, item) -> None:
        getattr(self, channel).append(item)


class _ContractProbe(Adapter):
    """A minimal synthetic adapter: one observation per interval, from the clock."""

    def __init__(self) -> None:
        super().__init__(PROBE_SOURCE_ID)
        self._next_due_ms = None
        self._sequence = 0

    def describe(self) -> AdapterDescription:
        return AdapterDescription(
            adapter_id="contract_probe",
            transports=("synthetic",),
            event_types=("fx_rate",),
            subjects=(("EUR", "USD", "mid"),),
            required_registry_fields=("source_id", "transport", "provenance_class", "subjects"),
            emits_timestamp_basis="observed",
            production_mode="poll",
        )

    def _start(self, context: AdapterContext) -> None:
        self._next_due_ms = context.now_ms()

    def _produce(self) -> Sequence[NormalizedObservation]:
        now_ms = self._context.now_ms()
        if self._next_due_ms is None or now_ms < self._next_due_ms:
            return ()
        self._next_due_ms = now_ms + PROBE_INTERVAL_MS
        self._sequence += 1
        return (self.normalize({"rate": "1.000000", "at_ms": now_ms, "sequence": self._sequence}),)

    def normalize(self, raw) -> NormalizedObservation:
        return NormalizedObservation(
            event_type="fx_rate",
            subject=("EUR", "USD", "mid"),
            payload={"base_currency": "EUR", "quote_currency": "USD",
                     "rate": raw["rate"], "rate_type": "mid"},
            source_timestamp_ms=raw["at_ms"],
            source_timestamp_basis="observed",
            sequence=raw["sequence"],
        )


def make_context(adapter: Adapter, *, clock: ManualClock = None,
                 sink=None) -> AdapterContext:
    """A context for `adapter`, on a manual clock. No credential resolver is
    passed, so the refusing default applies (authorization §8 item 3)."""
    return AdapterContext(
        source_id=adapter.source_id,
        clock=clock or ManualClock(START_MS),
        sink=sink if sink is not None else _CollectingSink(),
        cancellation=CancellationSignal(),
        metrics=NullMetrics(),
    )


def adapter_for_record(record) -> SyntheticFxAdapter:
    """The adapter one validated registry record selects.

    The seed comes from the record's recorded allocation, which is the only
    authority for one (AD-12 §3.1 mitigation 1); the fallback is used solely by
    tests that construct a record without loading the allocation file.
    """
    registry = load_registry()
    allocation = registry.allocation_for(record.source_id)
    return SyntheticFxAdapter.for_record(
        record, SEED if allocation is None else allocation.seed)


def _shipped_synthetic_fx() -> SyntheticFxAdapter:
    """The shipped adapter, as the shared contract suite instantiates it."""
    registry = load_registry()
    record = registry.record_for(SYNTHETIC_FX_SOURCE_ID)
    assert record is not None, "the shipped registry must carry the synthetic FX record"
    return adapter_for_record(record)


# (id, factory). Extended as adapters are added;
# `test_registry.py::test_every_adapter_subclass_is_in_the_shared_contract_suite`
# asserts the list is complete against the package's `Adapter` subclasses, so an
# adapter cannot be shipped with a suite of its own that quietly tests less.
ADAPTERS = [
    ("contract_probe", _ContractProbe),
    ("synthetic_fx", _shipped_synthetic_fx),
]
