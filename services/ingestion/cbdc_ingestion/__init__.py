"""Phase 3 D-24 ingestion component (Dev A).

A **local, synthetic** FX observation producer. It generates seeded `fx_rate`
event envelopes (AD-4 v0.2) for four fixed currency pairs and serves the latest
validated envelope per pair over a private, unauthenticated HTTP endpoint
(`GET /v1/latest`, AD-1 component view v0.5 §3.1, P-1).

Approved scope (`docs/PHASE3_SCOPE.md` v1.4 §2.2.2, §2.2.3; D-24):

- It contacts **no external host**: every value is generated locally. There is
  no provider, no adapter, no network client and no credential of any kind.
- It has **no path to inference, PostgreSQL or the Phase 1 engine** (AD-6 B-3,
  B-4). It imports nothing from `src/`, `services/inference/` or
  `services/backend/`, and nothing in those imports this package.
- Every envelope is `usage: display_only`, `provenance_class: synthetic`,
  `transport: synthetic`, `source_id: synthetic.fx`, with a populated
  `synthetic` block (AD-4 §3.2). Observations never influence routing (AD-6 §1).
- Rates are **deliberately unrealistic** (AD-1 §3, AD-12 row), so no reader can
  mistake them for market data.
- The dependency set is the Python standard library only. `pytest` is needed to
  run the tests, not the service.

Nothing here is a gate deliverable: no gate has passed (D-6, D-18).
"""
from __future__ import annotations

# Written into every envelope's `synthetic.generator_version`. Bump it whenever a
# generated payload or hash would change for the same seed and sequence: it is the
# only marker that distinguishes one generation rule from another (AD-4 §3.2).
GENERATOR_VERSION = "0.1.0"

# `protocol_version` of the GET /v1/latest response body (AD-1 §3.1). Independent
# of the AD-4 envelope `schema_version` and of the AD-1 §3.2 SSE protocol version.
PROTOCOL_VERSION = "1.0"

# AD-4 envelope version this component emits.
SCHEMA_VERSION = "1.0"

# The one source this component ever claims. The `synthetic.` prefix is one of the
# four markers AD-4 §3.2 requires to agree.
SOURCE_ID = "synthetic.fx"

__all__ = ["GENERATOR_VERSION", "PROTOCOL_VERSION", "SCHEMA_VERSION", "SOURCE_ID"]
