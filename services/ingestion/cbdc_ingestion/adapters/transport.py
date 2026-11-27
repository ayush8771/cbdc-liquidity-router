"""The transport seam A-4 drives, and the **one** kind of transport it admits.

AD-5 §13 **A-4** asks for fault injection *against a controllable fake
provider*, which needs something shaped like a transport. Phase 3.3-A had none:
its adapter wraps a local seeded generator, so the four network fault classes in
`faults.py` were defined and unreachable. This module is that shape, and it is
deliberately the **narrowest** shape that makes the classes reachable.

**No network exists here, and none can be added by accident.**

- This module imports **no** socket, HTTP, TLS or subprocess module, and names
  no host, port or URL. `tests/test_a4_faults.py` asserts that against `ast`
  import nodes, the same way acceptance criterion 11 guards the scaffold.
- A transport must declare `kind`, and only **`in_process_simulation`** is
  admitted (`AUTHORIZED_TRANSPORT_KINDS`). A transport that declared a networked
  kind is **refused at attachment**, not merely discouraged.
- Nothing in this package ever *implements* a transport. The implementation a
  test attaches is a scripted, in-process object — `infra/testing/fake_provider/`
  — which lives outside every build context and imports nothing from
  `cbdc_ingestion`. The two sides meet by duck typing, in a test, so the
  production package does not import the scaffold and the scaffold does not
  import the production package.

**Adding a networked kind is not a code change, it is an approval.** It needs
AD-10 (egress and its enforcement, which AD-5 §14 gap 2 records as
unspecified), A-9's **T-5 per adapter from inside the container including the
egress allowlist**, and — for anything resembling a real provider — **Gate 3**,
which does not exist. All four capability gates remain **CLOSED**.

---

**Why the body is read in chunks.** AD-5 §7.3 requires an oversized body to be
*"checked **while reading** rather than after"*. A limit applied to an already
materialized body is not that check: by then the memory has been spent, which is
the thing the limit exists to prevent. `read_body` therefore stops at the first
chunk that crosses the limit and never concatenates the rest, and the response
records how much it actually yielded so a test can assert the early stop rather
than trusting it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Mapping, Optional, Protocol, Sequence

from .faults import AdapterFault, FaultClass
from .simulation import SIMULATION_TIMING, SimulatedTimingProfile

# The only transport kind this scope admits. **Extending this tuple is an
# approval question, not a refactor** (AD-10, A-9 T-5, Gate 3).
AUTHORIZED_TRANSPORT_KINDS = ("in_process_simulation",)

# The simulated wire protocol's major version. An unknown version is a
# whole-response rejection (AD-5 §7.3), never a best-effort parse.
WIRE_PROTOCOL_VERSION = 1

# The one content type the simulated transport accepts. Anything else is a
# whole-response rejection (AD-5 §7.1 `contract_violation`, §7.3).
EXPECTED_CONTENT_TYPE = "application/json"


class TransportRefused(RuntimeError):
    """A transport was offered that this scope does not admit."""


@dataclass
class TransportResponse:
    """One provider response, as a transport would hand it over.

    Everything is data: a status, a content type, headers, and the body as an
    **iterable of chunks** rather than one block, so the size limit can be
    applied while reading. `truncated` marks a body that ends mid-stream;
    `network_error` marks a response that never arrived at all.
    """

    status: int = 200
    content_type: str = EXPECTED_CONTENT_TYPE
    chunks: Sequence[bytes] = field(default_factory=tuple)
    headers: Mapping[str, str] = field(default_factory=dict)
    truncated: bool = False
    network_error: Optional[str] = None
    location: Optional[str] = None
    # Filled by `read_body`: how many bytes the caller actually pulled. The
    # evidence for "checked while reading".
    bytes_consumed: int = 0
    chunks_consumed: int = 0

    def header(self, name: str) -> Optional[str]:
        """One header, case-insensitively, as a provider's would be read."""
        lowered = {str(k).lower(): v for k, v in self.headers.items()}
        return lowered.get(str(name).lower())

    def iter_chunks(self) -> Iterable[bytes]:
        for chunk in self.chunks:
            self.bytes_consumed += len(chunk)
            self.chunks_consumed += 1
            yield chunk


class Transport(Protocol):
    """What an adapter is allowed to pull from (structural, never imported).

    `kind` is checked against `AUTHORIZED_TRANSPORT_KINDS` at attachment, and
    `fetch()` returns one `TransportResponse`. There is no `connect`, no `send`
    and no header-setting operation: the seam is **pull-only**, so an adapter
    cannot push anything outward through it.
    """

    kind: str

    def fetch(self) -> TransportResponse:  # pragma: no cover - structural
        ...


def assert_admissible(transport) -> str:
    """The attachment guard. Returns the kind, or refuses.

    Refusing on an **unknown or missing** kind rather than allowing it is the
    point: a transport that forgot to declare itself must not be treated as
    harmless.
    """
    kind = getattr(transport, "kind", None)
    if not isinstance(kind, str) or kind not in AUTHORIZED_TRANSPORT_KINDS:
        raise TransportRefused(
            f"transport kind {kind!r} is not admitted; this scope admits "
            f"{AUTHORIZED_TRANSPORT_KINDS} only. A networked transport needs AD-10, "
            "A-9 T-5 inside the container, and Gate 3, which does not exist")
    if not callable(getattr(transport, "fetch", None)):
        raise TransportRefused("a transport exposes a callable fetch()")
    return kind


def read_body(response: TransportResponse,
              profile: SimulatedTimingProfile = SIMULATION_TIMING) -> bytes:
    """The body, refusing an oversized one **while reading** (AD-5 §7.3).

    Stops at the first chunk that crosses `max_response_bytes` and raises
    without joining the remainder, so the bytes a caller never needed are never
    held. The fault is a whole-response rejection, and the reason names the
    limit class rather than the body.
    """
    collected, total = [], 0
    for chunk in response.iter_chunks():
        total += len(chunk)
        if total > profile.max_response_bytes:
            raise AdapterFault(FaultClass.CONTRACT_VIOLATION, "response_body_too_large",
                               source_id="")
        collected.append(chunk)
    if response.truncated:
        # A body that ends mid-stream is a *connection* failure, not a shape
        # failure: the provider may be perfectly well configured, so this is
        # recoverable and is retried with backoff.
        #
        # **A4-02, Target A classification.** AD-5 §7.1 puts "a stream closed by
        # the provider" under `provider_unavailable` and reserves
        # `transient_network` for a failure on *our* side of the connection —
        # DNS, a reset, a read timeout. A truncated body is the provider ending a
        # stream it had already begun answering, so it is the former. Both
        # classes are recoverable, so the retry is unchanged; the class is what
        # an operator reads, and it should say the provider is the one failing.
        raise AdapterFault(FaultClass.PROVIDER_UNAVAILABLE, "truncated_stream", source_id="")
    return b"".join(collected)
