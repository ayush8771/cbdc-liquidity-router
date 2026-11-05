"""FastAPI application factory.

Run:  uvicorn cbdc_inference.api.app:create_app --factory --host 127.0.0.1 --port 8000

Lifecycle: startup resolves the settings and the ppo_projected checkpoint gate,
computes file metadata, and starts the EnginePool without blocking (workers
warm up in the background; /v1/health reports 503 until one is ready). Engine
metadata for /v1/version is fetched from the first ready worker. Shutdown
closes the pool (fails queued tasks, stops the worker processes).

The FastAPI process imports no Phase 1 module (arch §5.1, §6.2).
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Callable, Optional

from fastapi import FastAPI

from .. import API_VERSION, ENGINE_VERSION
from ..checkpoints import resolve_gate
from ..engine.errors import EngineError
from ..engine.pool import EnginePool
from ..engine.tasks import metadata_task
from ..settings import Settings, get_settings
from .errors import install_error_handling
from .metadata import static_metadata
from .routers import meta, reference, route

logger = logging.getLogger(__name__)
METADATA_RETRY_S = 1.0


async def _load_engine_metadata(app: FastAPI, startup_timeout_s: float) -> None:
    """Fetches /v1/version's engine metadata from the first worker to finish warming up.

    This is a startup task, not a caller's request, so it is given the worker **startup**
    budget (CBDC_ENGINE_STARTUP_TIMEOUT_S) rather than the 12 s request deadline (§5, §8):
    waiting for a worker to warm up is exactly what it is for, so the request deadline would
    otherwise expire it while queued and force a retry on every cold start.
    """
    while True:
        try:
            app.state.engine_metadata = await asyncio.wrap_future(
                app.state.pool.submit(metadata_task, deadline_s=startup_timeout_s))
            logger.info("engine metadata loaded")
            return
        except EngineError as exc:
            logger.warning("engine metadata not available yet: %s", exc.message)
            await asyncio.sleep(METADATA_RETRY_S)


def create_app(settings: Optional[Settings] = None,
               pool_factory: Optional[Callable[[Settings], EnginePool]] = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        repo_root = settings.repo_root_resolved
        gate = resolve_gate(settings.ppo_checkpoint_id, settings.approved_checkpoints_path, repo_root)
        app.state.checkpoint_gate = gate
        app.state.static_metadata = static_metadata(repo_root)
        app.state.engine_metadata = None
        # The approved entry goes to each worker, which re-verifies its SHA-256 itself (§7).
        factory = pool_factory or (lambda s: EnginePool.from_settings(s, checkpoint=gate.checkpoint))
        pool = factory(settings)
        app.state.pool = pool.start(wait=False)
        loader = asyncio.create_task(_load_engine_metadata(app, settings.engine_startup_timeout_s))
        logger.info("inference service %s starting: device=%s engine_workers=%d ppo_projected=%s%s",
                    ENGINE_VERSION, settings.device, settings.engine_workers, gate.status,
                    f" ({gate.reason})" if gate.reason else "")
        try:
            yield
        finally:
            loader.cancel()
            try:
                await loader
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            await asyncio.to_thread(pool.close)
            logger.info("inference service stopped")

    app = FastAPI(
        title="CBDC Liquidity Router — Inference API",
        version=ENGINE_VERSION,
        description=f"Internal inference API ({API_VERSION}). See docs/PHASE2_API_CONTRACT.md.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    install_error_handling(app)
    app.include_router(meta.router)
    app.include_router(reference.router)
    app.include_router(route.router)
    return app
