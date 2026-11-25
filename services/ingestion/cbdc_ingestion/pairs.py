"""The fixed FX pair allowlist (AD-1 §3.4, P-3; Dev A technical approval).

Four pairs, in this exact order, `rate_type` `mid` only: AED/MXN, EUR/USD,
GBP/PHP, USD/INR. The order is the one `GET /v1/latest` sorts by (base, then
quote, AD-1 §3.1) and the one the SSE `snapshot` uses, so it is defined once
here and never re-derived.

Any other pair, rate type or source is rejected, which bounds the component's
state at four events (AD-1 §3.4).

**The pairs imply no routing input** (AD-6 §2): they were chosen to match the
Phase 1 corridors a reader will recognise, and an FX rate has no defined mapping
to bridge liquidity, congestion, fees or risk (AD-6 §3).
"""
from __future__ import annotations

from typing import NamedTuple


class Pair(NamedTuple):
    base: str
    quote: str

    @property
    def key(self) -> str:
        return f"{self.base}/{self.quote}"


# Sorted by base then quote; `sorted()` over the tuples gives this same order.
PAIRS: tuple[Pair, ...] = (Pair("AED", "MXN"), Pair("EUR", "USD"), Pair("GBP", "PHP"), Pair("USD", "INR"))
PAIR_KEYS: tuple[str, ...] = tuple(p.key for p in PAIRS)
PAIR_INDEX = {p.key: i for i, p in enumerate(PAIRS)}

# The only `rate_type` this component emits or accepts (AD-1 §3.4).
RATE_TYPE = "mid"

# Currency-code membership for this slice: exactly the codes the allowlist uses
# (AD-4 §4 requires a membership check, not only a shape check). This is not an
# ISO 4217 register, and no code outside the allowlist can occur.
CURRENCIES = frozenset(code for p in PAIRS for code in p)

assert PAIRS == tuple(sorted(PAIRS)), "PAIRS must be in (base, quote) order"


def is_allowed(base: str, quote: str) -> bool:
    return f"{base}/{quote}" in PAIR_INDEX
