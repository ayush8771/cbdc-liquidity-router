"""Entry point: `python -m cbdc_ingestion`.

Starts the seeded generator and serves AD-1 §3.1's two paths until SIGINT or
SIGTERM, then stops the generator and closes the listener. Nothing is written to
disk, and no outbound connection is ever opened.
"""
from __future__ import annotations

import logging
import signal
import sys
import threading

from . import GENERATOR_VERSION, SOURCE_ID
from .http_api import make_server
from .service import IngestionService
from .settings import Settings, from_environment

logger = logging.getLogger("cbdc_ingestion")


def run(settings: Settings) -> int:
    logging.basicConfig(level=getattr(logging, settings.log_level, logging.INFO),
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")
    service = IngestionService(settings.seed, case_id=settings.case_id)
    server = make_server(service, host=settings.host, port=settings.port)
    stopping = threading.Event()

    def shutdown(signum, _frame) -> None:
        logger.info("signal %s received; stopping", signum)
        stopping.set()
        # shutdown() must not run on the serving thread; this handler does not serve.
        threading.Thread(target=server.shutdown, name="shutdown", daemon=True).start()

    for sig in (signal.SIGINT, getattr(signal, "SIGTERM", signal.SIGINT)):
        signal.signal(sig, shutdown)

    service.start()
    host, port = server.server_address[:2]
    logger.info("serving %s and /healthz on http://%s:%s (generator %s, source %s, synthetic only)",
                "/v1/latest", host, port, GENERATOR_VERSION, SOURCE_ID)
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        service.stop()
        server.server_close()
        logger.info("ingestion exited")
    return 0


def main() -> int:
    try:
        settings = from_environment()
    except ValueError as exc:
        print(f"ingestion configuration error: {exc}", file=sys.stderr)
        return 2
    return run(settings)


if __name__ == "__main__":  # pragma: no cover - process entry point
    raise SystemExit(main())
