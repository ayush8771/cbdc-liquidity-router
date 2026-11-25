# syntax=docker/dockerfile:1
#
# Ingestion image (AD-1 v0.5 §3.6, P-6; Dev D). Standard library only, so there is nothing to install and no lock.
# Build context: services/ingestion/ (its own .dockerignore).
#
#   docker build -t cbdc-ingestion:local services/ingestion
#
# Base image: the one the inference image already uses (python:3.10.11, bullseye), so no new base is introduced and
# the interpreter is the Phase 1 one. The same trade-off applies as in services/inference/Dockerfile: bullseye is out
# of Debian's regular security support. Acceptable for local development only; replacing it needs approval.
#
# Runtime (set by infra/compose.observations.yaml): non-root, read-only root filesystem, all capabilities dropped,
# no published port, no env file, no secret, no volume. The process writes nothing to disk.
FROM python:3.10.11-slim-bullseye@sha256:fd86924ba14682eb11a3c244f60a35b5dfe3267cbf26d883fb5c14813ce926f1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    CBDC_INGESTION_HOST=0.0.0.0 \
    CBDC_INGESTION_PORT=8300

RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin cbdc

# Code only (root-owned, read-only for the runtime user). Tests and docs stay out of the image.
WORKDIR /app
COPY cbdc_ingestion/ /app/cbdc_ingestion/

USER cbdc
EXPOSE 8300
# No curl in the slim image: the standard library probes /healthz (AD-1 §3.1, 200 while the process is alive).
HEALTHCHECK --interval=10s --timeout=5s --start-period=5s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8300/healthz', timeout=3).status == 200 else 1)"]
CMD ["python", "-m", "cbdc_ingestion"]
