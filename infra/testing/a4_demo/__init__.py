"""TEST-ONLY A-4 demonstration: the fake-provider bridge and the CLI.

Outside the ingestion build context, so nothing here can enter a runtime image —
the same arrangement as `infra/testing/fault_ingestion/`, D-24's test-only fault
harness. No network, no real provider, no credential, and nothing in
`services/ingestion/cbdc_ingestion/` imports it.

See `bridge.py` for why the bridge lives here rather than on either side, and
`run_demo.py` for the reproducible demonstration.
"""
from .bridge import ScriptedTransport, encode, source_values, to_response

__all__ = ["ScriptedTransport", "encode", "source_values", "to_response"]
