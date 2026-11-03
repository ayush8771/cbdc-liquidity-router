"""FastAPI application factory.

Run:  uvicorn cbdc_inference.api.app:create_app --factory --host 127.0.0.1 --port 8000

At this stage the app has no /v1 endpoints: they are added only once they are
backed by the engine (no stub returns invented values). Startup resolves the
settings and the ppo_projected checkpoint gate; it does not import Phase 1.
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI

from .. import API_VERSION, ENGINE_VERSION
from ..checkpoints import resolve_gate
from ..settings import Settings, get_settings
from .errors import install_error_handling

logger = logging.getLogger(__name__)


def create_app(settings: Optional[Settings] = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        gate = resolve_gate(settings.ppo_checkpoint_id, settings.approved_checkpoints_path, settings.repo_root_resolved)
        app.state.checkpoint_gate = gate
        logger.info("inference service %s starting: device=%s engine_workers=%d ppo_projected=%s%s",
                    ENGINE_VERSION, settings.device, settings.engine_workers, gate.status,
                    f" ({gate.reason})" if gate.reason else "")
        yield

    app = FastAPI(
        title="CBDC Liquidity Router — Inference API",
        version=ENGINE_VERSION,
        description=f"Internal inference API ({API_VERSION}). See docs/PHASE2_API_CONTRACT.md.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    install_error_handling(app)
    return app
