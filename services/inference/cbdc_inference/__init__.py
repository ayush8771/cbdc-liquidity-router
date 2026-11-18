"""CBDC Liquidity Router — Major Phase 2 inference service (Dev A).

Layout (arch §4, §5.1):
  cbdc_inference.api     FastAPI app, routers, schemas, error handlers. Imports NO Phase 1 module.
  cbdc_inference.engine  route(), state frames, worker pool, policies, explain. Imports NO FastAPI.
  cbdc_inference.settings / checkpoints   shared, import neither.
"""

ENGINE_VERSION = "0.1.0"
API_VERSION = "v1"
PHASE1_BASELINE_TAG = "phase1-complete"

__version__ = ENGINE_VERSION
