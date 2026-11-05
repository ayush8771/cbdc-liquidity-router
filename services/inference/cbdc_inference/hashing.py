"""Canonical hashing: `decision_id`, artefact fingerprints and the daily-state
fingerprint (API contract §2.11).

Pure Python plus `rfc8785`; imports no Phase 1 module and no FastAPI, so both the
FastAPI process and the engine workers can use it. `pandas` is imported lazily,
inside the daily-state fingerprint only.

The algorithms here are the contract's, and `infra/scripts/check_contracts.py`
implements the same rules independently. Both must reproduce
`contracts/test-vectors/decision_id.v1.json` and
`contracts/test-vectors/daily_state_fingerprint.v1.json` byte for byte, on
Windows and on Linux (§9.1 A-1, A-2).

Nothing here hashes an output: `decision_id` identifies a decision's *inputs*.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Optional

import rfc8785

ID_SCHEME = 1
# Exactly the six fingerprints /v1/version reports and §2.11 hashes.
ID_ARTEFACTS = ("knowledge_sha256", "daily_state_sha256", "bridge_network_sha256", "normalization_stats_sha256",
                "macro_risk_proxy_sha256", "rpw_corridor_quarterly_sha256")
SCENARIO_FIELDS = ("liquidity_multiplier", "congestion_multiplier", "cheapest_venue_liquidity_multiplier")
REWARD_FIELDS = ("lambda_latency", "lambda_risk", "lambda_unrouted")
HISTORY_CHANNELS = ("liquidity_usd", "congestion")

MAX_SAFE_INTEGER = 2 ** 53 - 1

# §2.11 daily-state fingerprint, scheme 1. Any change to these needs a new scheme number.
FINGERPRINT_DOMAIN = b"cbdc-liquidity-router/daily-state-fingerprint/v1"
FINGERPRINT_PANDAS = "2.3.3"
FINGERPRINT_HASH_KEY = "0123456789123456"


class UnsafeNumberError(ValueError):
    """§2.11: an integer-valued number in `transaction` or `state` with |x| > 2^53 − 1.

    The API layer turns this into `422 VALIDATION_ERROR` with the value's request
    path in `details.errors[].field`. The value is never rounded.
    """

    def __init__(self, field: str, value):
        super().__init__(f"{field}: {value!r} is an integer-valued number outside the safe range.")
        self.field = field
        self.value = value


# ---------------------------------------------------------------- numeric normalisation
def binary64(value, field: str) -> float:
    """The normalised IEEE 754 binary64 value used for **both** execution and hashing (§2.11).

    Value-based, not spelling-based: `300000`, `300000.0` and `3e5` normalise alike, so the
    backend's `JSON.parse` and the engine can't disagree. An integer-valued result outside
    ±(2^53 − 1) raises `UnsafeNumberError` rather than rounding.
    """
    x = float(value)
    if x.is_integer() and abs(x) > MAX_SAFE_INTEGER:
        raise UnsafeNumberError(field, value)
    return x


def unsafe_numbers(node: Any, path: str = "") -> list:
    """Paths of every integer-valued number outside ±(2^53 − 1) under `node` (§2.11).

    Used to collect *all* offending paths for one `details.errors[]` array, rather than
    failing on the first.
    """
    found = []
    if isinstance(node, dict):
        for key, value in node.items():
            found += unsafe_numbers(value, f"{path}.{key}" if path else key)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            found += unsafe_numbers(value, f"{path}[{i}]")
    elif isinstance(node, (int, float)) and not isinstance(node, bool):
        try:
            binary64(node, path)
        except UnsafeNumberError:
            found.append(path)
    return found


# ---------------------------------------------------------------- the canonical document
def normalised_state(raw: dict) -> dict:
    """The §2.11 `state` member.

    Explicit venues are sorted by `bridge_uid` in ascending **ordinal** (code-point) order,
    so `#10` sorts before `#2`. That sort is for hashing only: execution, `allocations[].slot`,
    the PPO observation and the explanations all keep Phase 1's slot order (§2.4). An omitted
    `history` is written as `null`, so null and missing hash alike.
    """
    mode = raw["mode"]
    if mode == "explicit":
        venues = []
        # enumerate() first so an error path reports the venue's position *as sent*.
        for i, v in sorted(enumerate(raw["venues"]), key=lambda iv: iv[1]["bridge_uid"]):
            at = f"state.venues[{i}]"
            history = v.get("history")
            venues.append({
                "bridge_uid": v["bridge_uid"],
                "liquidity_usd": binary64(v["liquidity_usd"], f"{at}.liquidity_usd"),
                "congestion": binary64(v["congestion"], f"{at}.congestion"),
                "history": None if history is None else {
                    channel: [binary64(x, f"{at}.history.{channel}[{j}]")
                              for j, x in enumerate(history[channel])]
                    for channel in HISTORY_CHANNELS},
            })
        return {"mode": "explicit", "reference_date": raw["reference_date"], "venues": venues}
    if mode == "scenario":
        return {"mode": "scenario", "date": raw["date"], "scenario_id": raw["scenario_id"]}
    return {"mode": "historical_replay", "date": raw["date"]}


def decision_document(inputs: dict) -> dict:
    """The §2.11 canonical document (`id_scheme` 1) for **one** policy.

    `inputs` carries `request` (a `/v1/route` or `/v1/compare` body), `engine_version`,
    `reward_weights`, `artefacts`, optionally `policy` (required for a compare entry),
    `scenario` (the `/v1/scenarios` entry, scenario mode only) and `checkpoint_sha256`
    (`ppo_projected` only).

    Every member is always present, so `null` is written out rather than omitted. Excluded:
    `api_version`, `git_commit`, `client_reference`, the scenario `description`, the
    reward-weight `status`, and every output field.
    """
    req = inputs["request"]
    policy = inputs.get("policy") or req.get("policy") or "waterfall"
    tx, raw_state = req["transaction"], req["state"]
    scenario = None
    if raw_state["mode"] == "scenario":
        definition = inputs["scenario"]
        if definition["scenario_id"] != raw_state["scenario_id"]:
            raise ValueError("scenario definition does not match state.scenario_id")
        scenario = {"scenario_id": definition["scenario_id"],
                    **{k: float(definition[k]) for k in SCENARIO_FIELDS}}
    if policy == "ppo_projected" and not inputs.get("checkpoint_sha256"):
        # A ppo_projected request without an enabled checkpoint is POLICY_DISABLED and gets no ID.
        raise ValueError("ppo_projected needs checkpoint_sha256")
    return {
        "id_scheme": ID_SCHEME,
        "engine_version": inputs["engine_version"],
        "transaction": {"sender_country": tx["sender_country"], "receiver_country": tx["receiver_country"],
                        "amount_usd": binary64(tx["amount_usd"], "transaction.amount_usd")},
        "state": normalised_state(raw_state),
        "policy": policy,
        "scenario": scenario,
        "reward_weights": {k: float(inputs["reward_weights"][k]) for k in REWARD_FIELDS},
        "artefacts": {k: inputs["artefacts"][k] for k in ID_ARTEFACTS},
        # A checkpoint change never changes a baseline ID.
        "checkpoint_sha256": inputs["checkpoint_sha256"] if policy == "ppo_projected" else None,
    }


def canonical(doc: dict) -> str:
    """RFC 8785 (JCS): sorted keys, no whitespace, ECMAScript number formatting."""
    return rfc8785.dumps(doc).decode("utf-8")


def compute_decision_id(inputs: dict) -> str:
    """`"sha256:"` + the lowercase hex SHA-256 of the RFC 8785 UTF-8 bytes (§2.11)."""
    return "sha256:" + hashlib.sha256(rfc8785.dumps(decision_document(inputs))).hexdigest()


# ---------------------------------------------------------------- artefact fingerprints
def sha256_text_file(path) -> str:
    """Text artefacts (CSV, JSON) are hashed after CRLF→LF, so a Windows checkout made with
    `core.autocrlf=true` hashes the same as the committed blob (§2.11)."""
    data = Path(path).read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def sha256_binary_file(path, chunk_size: int = 1 << 20) -> str:
    """Binary artefacts (parquet) are hashed as they are (§2.11)."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk_size), b""):
            h.update(block)
    return h.hexdigest()


def scenarios_sha256(scenarios: list) -> str:
    """§2.2: SHA-256 of the RFC 8785 serialisation of the `scenarios` array, sorted by
    `scenario_id` (ordinal), so the order they were defined or inserted in never matters.
    It is a cache key only and does not enter `decision_id`."""
    return hashlib.sha256(rfc8785.dumps(sorted(scenarios, key=lambda s: s["scenario_id"]))).hexdigest()


# ---------------------------------------------------------------- daily-state fingerprint
def daily_state_descriptor(frame) -> dict:
    """The scheme-1 descriptor hashed together with the row hashes (§2.11)."""
    return {
        "scheme": 1,
        "columns": [{"name": str(c), "dtype": str(frame[c].dtype)} for c in frame.columns],
        "index": {"names": [None if n is None else str(n) for n in frame.index.names],
                  "dtypes": [str(frame.index.get_level_values(i).dtype) for i in range(frame.index.nlevels)]},
        "row_count": int(len(frame)),
        "pandas_version": FINGERPRINT_PANDAS,
        "hashing": {"function": "pandas.util.hash_pandas_object", "index": True, "categorize": False,
                    "hash_key": FINGERPRINT_HASH_KEY, "row_hash_dtype": "<u8"},
    }


def daily_state_fingerprint(frame) -> str:
    """SHA-256 of `DOMAIN || u64le(len(schema)) || schema || u64le(len(rows)) || rows` (§2.11).

    Row hashes include the index and are forced little-endian, so the value matches across
    platforms. Any pandas version other than the pinned one is an error, never a silent
    difference.
    """
    import pandas as pd  # lazy: only the fingerprint needs pandas
    if pd.__version__ != FINGERPRINT_PANDAS:
        raise RuntimeError(
            f"the daily-state fingerprint is defined for pandas {FINGERPRINT_PANDAS}, not {pd.__version__}")
    schema = rfc8785.dumps(daily_state_descriptor(frame))
    rows = pd.util.hash_pandas_object(frame, index=True, categorize=False,
                                      hash_key=FINGERPRINT_HASH_KEY).to_numpy().astype("<u8").tobytes()
    h = hashlib.sha256(FINGERPRINT_DOMAIN)
    for part in (schema, rows):
        h.update(len(part).to_bytes(8, "little"))
        h.update(part)
    return h.hexdigest()
