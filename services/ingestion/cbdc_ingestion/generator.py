"""The deterministic, seeded synthetic FX generator (AD-1 §3, AD-12 row).

One generator produces `fx_rate` observations for the four allowlisted pairs
(`pairs.py`) on a fixed schedule: **each pair every 2 s, staggered by 500 ms**,
which is the 2 events/s of AD-1 §3.

**Determinism.** A rate is a pure function of the seed, the pair and the pair's
sequence number. It uses SHA-256 rather than `random`, so there is no shared
generator state: pair order, thread interleaving, catch-up and replay cannot
change a value, and the same `(seed, sequence)` gives the same payload and the
same `payload_sha256` on any platform and at any time. This is what AD-1 §6
item 1 requires — "payloads and hashes do not depend on the clock" — and it is
why the clock is injected and used for timestamps only.

**The rates are deliberately unrealistic** (AD-1 §3, AD-12 row): every base
value is near 1-3 units of quote per base, which no real AED/MXN, EUR/USD,
GBP/PHP or USD/INR quote is. A reader cannot mistake one for market data, and
nothing downstream may treat one as a price. Observations never reach routing
(AD-6 §1, §4).

**Bounded work.** `due(now_ms)` emits at most one event per pair per call: if the
clock jumps forward, the skipped ticks are counted and dropped rather than
replayed as a backlog (AD-1 §3.4 — the ordering watermark makes an old value age
out safely, so there is nothing to gain from emitting it).
"""
from __future__ import annotations

import hashlib
from decimal import Decimal
from typing import Optional

from . import GENERATOR_VERSION
from .clock import Clock
from .envelope import build_fx_event, fx_payload
from .pairs import PAIRS, Pair

# AD-1 §3: each pair is observed every 2 s, and the four pairs are staggered by
# 500 ms, so the component emits 2 events/s in total.
PAIR_INTERVAL_MS = 2000
PAIR_STAGGER_MS = 500

# Deliberately unrealistic base rates, in units of quote per one unit of base
# (AD-4 §4). USD/INR reuses AD-4 §10's example value.
BASE_RATES = {
    "AED/MXN": Decimal("1.100000"),
    "EUR/USD": Decimal("2.200000"),
    "GBP/PHP": Decimal("3.300000"),
    "USD/INR": Decimal("1.234500"),
}

# Each rate wanders within +/- this much of its base, in units of the last decimal
# place below. Small enough that a rate can never reach zero or change sign.
RATE_DECIMALS = 6
WOBBLE_STEPS = 10_000  # +/- 0.010000
_QUANTUM = Decimal(1).scaleb(-RATE_DECIMALS)

assert set(BASE_RATES) == {p.key for p in PAIRS}, "every allowlisted pair needs a base rate"


def rate_for(seed: int, pair: Pair, sequence: int) -> str:
    """The decimal-string rate for one observation. Independent of the clock.

    The offset is read from the SHA-256 of the seed, the pair and the sequence, so
    it is reproducible everywhere and needs no generator state. The result is
    always a positive decimal string with exactly `RATE_DECIMALS` places, which is
    the form AD-4 §4 requires.
    """
    digest = hashlib.sha256(f"{int(seed)}|{pair.key}|{int(sequence)}".encode("ascii")).digest()
    # 8 bytes is far more entropy than the 20 001 offsets need; the modulo bias is
    # negligible and irrelevant, because this is a demonstration value, not a sample
    # from a distribution anything relies on.
    offset = int.from_bytes(digest[:8], "big") % (2 * WOBBLE_STEPS + 1) - WOBBLE_STEPS
    rate = BASE_RATES[pair.key] + Decimal(offset) * _QUANTUM
    if rate <= 0:  # unreachable with these constants; asserted rather than assumed
        raise ValueError(f"generated a non-positive rate for {pair.key} at sequence {sequence}")
    return str(rate.quantize(_QUANTUM))


def scheduled_ms(start_ms: int, pair_index: int, sequence: int) -> int:
    """When observation `sequence` (from 1) of pair `pair_index` is due."""
    return start_ms + pair_index * PAIR_STAGGER_MS + (sequence - 1) * PAIR_INTERVAL_MS


class FxGenerator:
    """Produces the next due envelopes. Holds one sequence counter per pair.

    It keeps no event, so its memory is four integers whatever the run length; the
    latest envelope per pair is held by `store.LatestStore`.
    """

    def __init__(self, seed: int, clock: Clock, *, start_ms: Optional[int] = None,
                 case_id: str = "normal", generator_version: str = GENERATOR_VERSION) -> None:
        if not isinstance(seed, int) or isinstance(seed, bool) or not 0 <= seed <= 2 ** 53 - 1:
            raise ValueError("seed must be an integer in [0, 2^53 - 1] (AD-4 §3.2)")
        self.seed = int(seed)
        self.clock = clock
        self.case_id = case_id
        self.generator_version = generator_version
        self.start_ms = clock.now_ms() if start_ms is None else int(start_ms)
        # Sequence numbers run from 1 and are per pair; `source_sequence` carries the
        # value as an opaque string (AD-4 §2).
        self._next_sequence = {p.key: 1 for p in PAIRS}
        self.skipped_ticks = 0

    def next_due_ms(self) -> int:
        """When the earliest pair's next observation falls due."""
        return min(scheduled_ms(self.start_ms, i, self._next_sequence[p.key])
                   for i, p in enumerate(PAIRS))

    def due(self, now_ms: Optional[int] = None) -> list:
        """The envelopes due at `now_ms`, in pair order, at most one per pair.

        The event's timestamps are the **scheduled** moment, not the moment the call
        happened, so a late or coarse poll does not make an event look fresher than
        the observation it stands for. `retrieved_at` and `emitted_at` equal the
        source timestamp because the generator is its own provider (AD-4 §5).
        """
        now_ms = self.clock.now_ms() if now_ms is None else int(now_ms)
        events = []
        for index, pair in enumerate(PAIRS):
            sequence = self._next_sequence[pair.key]
            if scheduled_ms(self.start_ms, index, sequence) > now_ms:
                continue
            # Catch up without a backlog: jump straight to the newest due sequence and
            # count what was skipped. Computed arithmetically rather than by stepping,
            # so even a clock jumped forward by a year costs one division instead of
            # millions of iterations.
            latest = (now_ms - self.start_ms - index * PAIR_STAGGER_MS) // PAIR_INTERVAL_MS + 1
            assert latest >= sequence, "a due sequence cannot precede the next one"
            self.skipped_ticks += latest - sequence
            self._next_sequence[pair.key] = latest + 1
            events.append(self.build(pair, latest, scheduled_ms(self.start_ms, index, latest)))
        return events

    def build(self, pair: Pair, sequence: int, moment_ms: int) -> dict:
        """One envelope for `pair` at `sequence`, observed at `moment_ms`."""
        payload = fx_payload(pair.base, pair.quote, rate_for(self.seed, pair, sequence))
        return build_fx_event(seed=self.seed, sequence=sequence, payload=payload,
                              retrieved_at_ms=moment_ms, case_id=self.case_id,
                              generator_version=self.generator_version)
