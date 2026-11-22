# syntax=docker/dockerfile:1
#
# Inference service image (arch §4.2, §7.2). Build from the REPOSITORY ROOT so
# Phase 1 code and data can be copied; services/inference/Dockerfile.dockerignore
# is an allow-list, so nothing else (.git, venvs, outputs/, .env, secrets) can
# enter the build context:
#
#   docker build -f services/inference/Dockerfile \
#     --build-arg CBDC_GIT_COMMIT=$(git rev-parse HEAD) -t cbdc-inference:local .
#
# Base image: python:3.10.11 is the Phase 1 interpreter (arch §7.2). No 3.10.11
# image exists for Debian bookworm (3.10.11 predates it), so this uses bullseye.
# Security trade-off: bullseye (Debian 11) is out of Debian's regular security
# support, and this exact-patch image is no longer rebuilt, so OS packages and
# Python 3.10.11 itself carry unpatched CVEs. Acceptable for local development
# only; replacing it (e.g. a newer 3.10.x on bookworm) changes the interpreter
# and needs approval and a parity re-check. See services/inference/README.md.
FROM python:3.10.11-slim-bullseye@sha256:fd86924ba14682eb11a3c244f60a35b5dfe3267cbf26d883fb5c14813ce926f1

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_ROOT_USER_ACTION=ignore

# Dependencies first, so code and data changes don't invalidate this layer.
# Hash-checked, no dependency resolution: exactly the Milestone 2 lock
# (torch 2.13.0+cpu; no CUDA, triton or Cognee).
COPY services/inference/requirements/linux-x86_64-cpu.txt /tmp/linux-x86_64-cpu.txt
RUN pip install --require-hashes --no-deps -r /tmp/linux-x86_64-cpu.txt \
 && pip check \
 && rm /tmp/linux-x86_64-cpu.txt

# Phase 1 code and the data read at inference, plus the service (arch §4.2).
# Copied read-only for the runtime user: owned by root.
COPY src/ /repo/src/
COPY data/structured/ /repo/data/structured/
COPY data/processed/ /repo/data/processed/
COPY data/knowledge/ /repo/data/knowledge/
COPY contracts/test-vectors/ /repo/contracts/test-vectors/
COPY services/inference/ /repo/services/inference/

# Non-root runtime user. Checkpoints are never copied into the image: an approved
# one is mounted read-only at /repo/outputs/experiments by a Compose override, and
# the approval registry (config/approved_checkpoints.json) ships empty, so
# ppo_projected stays disabled unless the owner approves a checkpoint.
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin cbdc

# The commit is supplied at build time; the image contains no .git.
# metadata.git_commit() ignores a value that isn't a 7-40 character hex SHA.
ARG CBDC_GIT_COMMIT=""
ENV CBDC_GIT_COMMIT=${CBDC_GIT_COMMIT} \
    CBDC_REPO_ROOT=/repo \
    CBDC_DEVICE=cpu \
    CBDC_ENABLE_COGNEE=false

USER cbdc
WORKDIR /repo/services/inference
EXPOSE 8000

# 503 until the engine workers are ready (contract §3.9), so a long start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=3 \
  CMD ["python", "-c", "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/v1/health', timeout=4).status == 200 else 1)"]

# 0.0.0.0 inside the container only. Compose keeps the service on its internal
# network; host exposure is only in the optional debug override (contract §8).
CMD ["uvicorn", "cbdc_inference.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]
