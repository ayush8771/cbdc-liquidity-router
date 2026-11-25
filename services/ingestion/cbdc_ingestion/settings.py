"""Environment settings for the ingestion component.

Read from the process environment only. **No `.env` file is loaded**, no secret
or credential exists, and nothing here can name an external host: there is no
provider URL setting, because the component contacts nothing (AD-1 §1, D-24).

| Variable | Default | Meaning |
|---|---|---|
| `CBDC_INGESTION_SEED` | `20261125` | The generator seed; it fixes every payload and hash |
| `CBDC_INGESTION_CASE_ID` | `normal` | `synthetic.case_id` on every envelope (AD-4 §3.2) |
| `CBDC_INGESTION_HOST` | `127.0.0.1` | Bind address. The container form sets `0.0.0.0` on its internal network only |
| `CBDC_INGESTION_PORT` | `8300` | Bind port. Never published to the host (AD-1 §3.6) |
| `CBDC_INGESTION_LOG_LEVEL` | `INFO` | Root log level for the process |

The prefix matches the Phase 2 services' `CBDC_` convention. An unparsable value
is a startup failure, not a silent default: a component that quietly ran on a
different seed would make its own events irreproducible.
"""
from __future__ import annotations

import os
from dataclasses import dataclass

DEFAULT_SEED = 20261125
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8300
MAX_SAFE_SEED = 2 ** 53 - 1


@dataclass(frozen=True)
class Settings:
    seed: int = DEFAULT_SEED
    case_id: str = "normal"
    host: str = DEFAULT_HOST
    port: int = DEFAULT_PORT
    log_level: str = "INFO"


def _int_env(env, name: str, default: int) -> int:
    raw = env.get(name)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {raw!r}") from exc


def from_environment(env=None) -> Settings:
    """The settings in `env`, defaulting to the process environment."""
    env = os.environ if env is None else env
    seed = _int_env(env, "CBDC_INGESTION_SEED", DEFAULT_SEED)
    port = _int_env(env, "CBDC_INGESTION_PORT", DEFAULT_PORT)
    if not 0 <= seed <= MAX_SAFE_SEED:
        raise ValueError("CBDC_INGESTION_SEED must be in [0, 2^53 - 1] (AD-4 §3.2)")
    if not 0 <= port <= 65535:
        raise ValueError("CBDC_INGESTION_PORT must be a TCP port")
    case_id = (env.get("CBDC_INGESTION_CASE_ID") or "normal").strip() or "normal"
    if len(case_id) > 200:
        raise ValueError("CBDC_INGESTION_CASE_ID must be at most 200 characters (AD-4 §3.2)")
    return Settings(
        seed=seed,
        case_id=case_id,
        host=(env.get("CBDC_INGESTION_HOST") or DEFAULT_HOST).strip() or DEFAULT_HOST,
        port=port,
        log_level=(env.get("CBDC_INGESTION_LOG_LEVEL") or "INFO").strip().upper() or "INFO",
    )
