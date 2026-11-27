"""A controllable TEST-ONLY fake provider (authorization v1.3 section 7.1; AD-5 section 7.1's fault taxonomy).

**Why it exists and why it does nothing yet.** Acceptance obligation **A-4**
(fault injection) needs somewhere to drive a provider's misbehaviour from. Phase
3.3-A authorizes **no transport**: its one adapter wraps a local seeded
generator, so there is nothing to fault. The authorization therefore asks for
this home to be *created* while A-4 stays **unexercised** (section 9, closing
note), and the 3.3-S exit record must still list A-4 as outstanding.

**What it is.** A deterministic script of outcomes that a caller pulls one at a
time. Nothing more. It is a pure in-process object:

- **no network.** No socket, no HTTP client or server, no URL, no hostname. The
  ingestion suite asserts this statically, so the file cannot quietly grow one.
- **no real provider.** No vendor name, endpoint, credential or recorded sample.
  Gate 3 does not exist and C-2 is out of scope (section 8 item 1).
- **no coupling.** It imports nothing from `cbdc_ingestion`, `src/` or
  `services/`, so it cannot drift into the production path, and it lives under
  `infra/` — **outside the ingestion build context**, so it cannot enter the
  image (section 7.4, acceptance criterion 11).

**Fault vocabulary.** The three classes are AD-5 section 7.1's, as plain strings
rather than an import of the service's enum, deliberately: this scaffold must
not depend on the component it exists to test. `faults.py` stays the one
authority for what each class *means* to an adapter.

**What a future A-4 adds, and must not add here.** A transport that reads this
script and misbehaves accordingly. That needs an authorized milestone; until
then nothing imports this module and no test drives a fault through it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping, Sequence

# AD-5 section 7.1. `item` is a single bad value; the adapter stays running.
FAULT_CLASSES = ("recoverable", "permanent", "item")


class ScriptError(ValueError):
    """A script this scaffold refuses to run, rather than guess at."""


@dataclass(frozen=True)
class Deliver:
    """One poll that yields `values`, each an opaque mapping the caller interprets."""

    values: Sequence[Mapping[str, str]] = field(default_factory=tuple)


@dataclass(frozen=True)
class Fault:
    """One poll that fails with an AD-5 section 7.1 class and a stable reason."""

    fault_class: str
    reason: str = "scripted"

    def __post_init__(self) -> None:
        if self.fault_class not in FAULT_CLASSES:
            raise ScriptError(f"unknown fault class {self.fault_class!r}; expected one of {FAULT_CLASSES}")


@dataclass(frozen=True)
class Silence:
    """One poll that yields nothing and does not fail: the silence window's input."""


Step = Deliver | Fault | Silence


class FakeProvider:
    """A scripted provider. `poll()` returns the next step; the script never loops.

    Deterministic by construction: the same script gives the same sequence, with
    no clock, no randomness and no I/O. `exhausted` is how a caller detects the
    end rather than being handed a silent, indefinite `Silence`.
    """

    def __init__(self, script: Sequence[Step]) -> None:
        if not script:
            raise ScriptError("an empty script would be indistinguishable from an exhausted one")
        for index, step in enumerate(script):
            if not isinstance(step, (Deliver, Fault, Silence)):
                raise ScriptError(f"step {index} is {type(step).__name__}, not a Deliver, Fault or Silence")
        self._script = tuple(script)
        self._position = 0

    @property
    def exhausted(self) -> bool:
        return self._position >= len(self._script)

    @property
    def remaining(self) -> int:
        return len(self._script) - self._position

    def poll(self) -> Step:
        if self.exhausted:
            raise ScriptError("the script is exhausted; a caller must check `exhausted` first")
        step = self._script[self._position]
        self._position += 1
        return step

    def reset(self) -> None:
        """Replay from the start, so one script can serve a restart-identity check."""
        self._position = 0
