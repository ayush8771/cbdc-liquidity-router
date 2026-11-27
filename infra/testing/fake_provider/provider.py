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


# --------------------------------------------------------------------- A-4 steps
# The misbehaviours AD-5 section 13's A-4 names, as **semantics without wire
# detail**. Each is plain data: no bytes, no header syntax, no status code
# arithmetic and no encoding. A bridge outside this package turns a step into
# whatever shape the component under test expects, which is why this scaffold
# can describe a truncated stream without ever owning a stream.


@dataclass(frozen=True)
class StatusFault:
    """One poll the provider answers with a failing status.

    `status` is the integer a provider would return — 401, 403, 429, 500, 502,
    503, 504 — and `retry_after` is the raw header value a caller must decide
    about, including the invalid spellings A-4 requires: a non-numeric string,
    a negative number and the HTTP-date form are all passed through **as
    written**, because the point of the case is what the component does with an
    unusable value, not what this scaffold would prefer it to be.
    """

    status: int
    retry_after: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.status, int) or isinstance(self.status, bool):
            raise ScriptError(f"status must be an integer, got {self.status!r}")
        if not 100 <= self.status <= 599:
            raise ScriptError(f"{self.status} is not a response status")


@dataclass(frozen=True)
class Redirect:
    """One poll answered with a redirect, which must never be followed.

    `target` is an opaque label, never a URL: following a redirect would reach a
    host no allowlist named, so the case exists to assert the **refusal**, and a
    scaffold that carried a real target would be inviting the opposite.
    """

    status: int = 302
    target: str = "elsewhere"

    def __post_init__(self) -> None:
        if not 300 <= self.status <= 399:
            raise ScriptError(f"{self.status} is not a redirect status")
        if "//" in self.target or ":" in self.target:
            raise ScriptError("a redirect target here is an opaque label, never a URL")


@dataclass(frozen=True)
class WrongContentType:
    """One poll whose body is fine but whose declared type is not."""

    content_type: str = "text/html"


@dataclass(frozen=True)
class MalformedBody:
    """One poll whose body cannot be parsed. `text` is the raw nonsense sent."""

    text: str = "{not json"


@dataclass(frozen=True)
class OversizedBody:
    """One poll whose body exceeds the size limit.

    `chunk_bytes` and `chunks` describe how it arrives, so a caller can show the
    limit was applied **while reading**: a body delivered in many small pieces
    must be refused part-way through, not after the last piece.
    """

    chunk_bytes: int = 512
    chunks: int = 64

    def __post_init__(self) -> None:
        if self.chunk_bytes < 1 or self.chunks < 1:
            raise ScriptError("an oversized body needs at least one chunk of at least one byte")


@dataclass(frozen=True)
class TruncatedStream:
    """One poll whose body stops mid-stream. `values` is what did arrive."""

    values: Sequence[Mapping[str, str]] = field(default_factory=tuple)


@dataclass(frozen=True)
class CloseOnConnect:
    """A provider that closes immediately, so no response arrives at all."""

    reason: str = "closed_on_connect"


@dataclass(frozen=True)
class WrongProtocolVersion:
    """One poll carrying a payload protocol version the caller cannot read."""

    version: int = 999
    values: Sequence[Mapping[str, str]] = field(default_factory=tuple)


@dataclass(frozen=True)
class RepeatedSubject:
    """One poll carrying two items for the same subject (AD-5 section 7.3)."""

    values: Sequence[Mapping[str, str]] = field(default_factory=tuple)


@dataclass(frozen=True)
class TooManyItems:
    """One poll carrying more items than the subject allowlist permits."""

    values: Sequence[Mapping[str, str]] = field(default_factory=tuple)


Step = (
    Deliver | Fault | Silence | StatusFault | Redirect | WrongContentType
    | MalformedBody | OversizedBody | TruncatedStream | CloseOnConnect
    | WrongProtocolVersion | RepeatedSubject | TooManyItems
)

# Every step kind, so a bridge can assert it handles all of them rather than
# silently ignoring one it has not been taught.
STEP_KINDS = (
    Deliver, Fault, Silence, StatusFault, Redirect, WrongContentType,
    MalformedBody, OversizedBody, TruncatedStream, CloseOnConnect,
    WrongProtocolVersion, RepeatedSubject, TooManyItems,
)


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
            if not isinstance(step, STEP_KINDS):
                raise ScriptError(
                    f"step {index} is {type(step).__name__}, which is not one of "
                    f"{tuple(k.__name__ for k in STEP_KINDS)}")
        self._script = tuple(script)
        self._position = 0
        self._repeat_last = False

    def repeating(self) -> "FakeProvider":
        """Makes the **last** step repeat for ever instead of exhausting.

        For a case whose subject is something other than the end of a script —
        a contract suite that polls an unknown number of times, or a recovery
        that must stay recovered. The script is otherwise unchanged, so the
        faults still occur exactly where they were written.
        """
        self._repeat_last = True
        return self

    @property
    def exhausted(self) -> bool:
        if self._repeat_last:
            return False
        return self._position >= len(self._script)

    @property
    def remaining(self) -> int:
        return len(self._script) - self._position

    def poll(self) -> Step:
        if self.exhausted:
            raise ScriptError("the script is exhausted; a caller must check `exhausted` first")
        if self._position >= len(self._script):
            # Only reachable under `repeating()`, which is what keeps the
            # non-repeating script's exhaustion an error rather than a silence.
            return self._script[-1]
        step = self._script[self._position]
        self._position += 1
        return step

    def reset(self) -> None:
        """Replay from the start, so one script can serve a restart-identity check."""
        self._position = 0
