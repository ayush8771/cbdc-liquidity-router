"""Engine layer (arch §5.1, §6). Placeholder: not implemented yet.

Will contain route(transaction, state, policy) -> RouteResult, state frames,
the spawn-based EnginePool and its worker initialiser, policies and explain.
Only this package may import Phase 1 `src`, and only inside engine worker
processes. It must never import FastAPI. See services/inference/README.md,
"Phase 1 integration plan", for the mapped interfaces.
"""
