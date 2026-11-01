"""Stage 1E step 3 - read-only semantic explanation & audit of Stage 1D results.

Reads existing Stage 1D per-transaction result files (never modifies them),
and for every unique transaction produces a deterministic, provenance-tagged
explanation:

  * decision        - from StaticMemoryProvider (the ONLY feasibility authority)
  * env consistency - does that decision agree with what the Stage 1D run
                      recorded (`rejected` column), where available?
  * semantic layer  - facts retrieved via Cognee for the transaction's corridor,
                      grounded to known fact_ids and cross-checked against the
                      facts StaticMemoryProvider says are active on that date.

Explanations are rendered from templates (no LLM-generated prose). Cognee is
used only for CHUNKS retrieval, once per corridor (memory facts depend on
corridor and date, not on the routing policy), and is optional (`adapter=None`
gives a static-only audit). This module never imports PPO, the environment,
training or evaluation code.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Optional

import pandas as pd

from .provider import StaticMemoryProvider

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INPUTS = [
    "outputs/experiments/stage1d_holdout_eval_20261101_225445/per_transaction.csv",
    "outputs/experiments/stage1d_holdout_datedisjoint_eval_20261101_230534/per_transaction.csv",
    "outputs/experiments/stage1d_holdout_datedisjoint_v2_eval_20261101_233252/per_transaction.csv",
    "outputs/diagnostics/failed_splitting_20261101_202140/failed_transactions.csv",
]
REQUIRED_COLUMNS = {"transaction_id", "corridor", "simulation_date", "amount"}
TX_KEY = ["transaction_id", "sender", "receiver", "amount", "simulation_date"]


def sha256_file(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def corridor_query(sender: str, receiver: str) -> str:
    return (f"Which rules, transfer limits or corridor restrictions apply to cross-border transfers "
            f"from {sender} to {receiver}?")


def _split_corridor(corridor: str):
    parts = str(corridor).split("->")
    if len(parts) != 2 or not all(p.strip() for p in parts):
        raise ValueError(f"unparseable corridor {corridor!r}")
    return parts[0].strip(), parts[1].strip()


def _input_label(path: Path) -> str:
    return f"{path.parent.name}/{path.name}"


def load_transactions(paths) -> tuple:
    """Returns (transactions DataFrame, input metadata list).

    One row per unique (transaction_id, sender, receiver, amount, date), with
    `sources` (input labels it appears in) and `outcomes` (per-source summary of
    the recorded Stage 1D results for that transaction).
    """
    frames, meta = [], []
    for p in map(Path, paths):
        df = pd.read_csv(p)
        missing = REQUIRED_COLUMNS - set(df.columns)
        if missing:
            raise ValueError(f"{p}: missing required columns {sorted(missing)}")
        label = _input_label(p)
        meta.append({"path": str(p), "label": label, "sha256": sha256_file(p), "rows": len(df)})
        sr = df["corridor"].map(_split_corridor)
        df = df.assign(sender=sr.str[0], receiver=sr.str[1], amount=df["amount"].astype(float),
                       simulation_date=df["simulation_date"].astype(str), source=label)
        frames.append(df)
    all_rows = pd.concat(frames, ignore_index=True)

    records = []
    for key, g in all_rows.groupby(TX_KEY, sort=True):
        tx = dict(zip(TX_KEY, key))
        tx["regime"] = g["regime"].dropna().iloc[0] if "regime" in g and g["regime"].notna().any() else None
        tx["sources"] = sorted(g["source"].unique())
        tx["outcomes"] = {src: _summarize_outcomes(sg) for src, sg in g.groupby("source")}
        rej = g["rejected"].dropna() if "rejected" in g else pd.Series(dtype=bool)
        tx["recorded_rejected"] = None if rej.empty else bool(rej.astype(bool).any())
        tx["recorded_rejected_consistent"] = None if rej.empty else bool(rej.astype(bool).nunique() == 1)
        records.append(tx)
    return pd.DataFrame(records), meta


def _summarize_outcomes(g: pd.DataFrame) -> dict:
    out = {"rows": int(len(g))}
    if "policy" in g and "amount_completed" in g:
        out["amount_completion_rate_by_policy"] = {
            p: float(pg["amount_completed"].astype(bool).mean()) for p, pg in g.groupby("policy")}
        out["n_checkpoints"] = int(g["checkpoint"].nunique()) if "checkpoint" in g else None
    if "mechanism" in g:  # failure diagnostics
        out["failure_mechanisms"] = sorted(g["mechanism"].dropna().unique().tolist())
        out["failed_checkpoints"] = sorted(g["checkpoint"].dropna().unique().tolist())
    return out


def retrieve_for_corridors(adapter, corridors, top_k: int = 5) -> dict:
    """One retrieval per corridor. Errors are recorded per corridor, never raised."""
    out = {}
    for s, r in sorted(set(corridors)):
        q = corridor_query(s, r)
        try:
            out[f"{s}->{r}"] = adapter.retrieve(q, top_k=top_k)
        except Exception as e:  # noqa: BLE001 - retrieval is advisory only
            out[f"{s}->{r}"] = {"query": q, "error": f"{type(e).__name__}: {e}"}
    return out


def _py(v):
    """numpy/pandas scalar -> native Python (so JSON gets true bools/ints, not strings)."""
    if v is None:
        return None
    if hasattr(v, "item") and not isinstance(v, (list, dict, str)):
        return v.item()
    return v


def _fact_brief(f: dict) -> str:
    return f"{f['fact_id']} ({f['provenance_tag']}, verified={str(f['verified']).lower()})"


def explain_transaction(tx: dict, static: StaticMemoryProvider, retrieval: Optional[dict]) -> dict:
    """Deterministic explanation + cross-check for one transaction."""
    tx = {k: _py(v) for k, v in tx.items()}
    s, r, a, d = tx["sender"], tx["receiver"], float(tx["amount"]), str(tx["simulation_date"])
    st = static.explain(s, r, a, d)
    active_ids = sorted(f["fact_id"] for f in st["active_facts"])

    semantic = {"status": "not_requested"}
    if retrieval is not None:
        if "error" in retrieval:
            semantic = {"status": "error", "error": retrieval["error"], "query": retrieval.get("query")}
        else:
            grounded = sorted(retrieval.get("grounded_fact_ids", []))
            semantic = {
                "status": "ok", "query": retrieval.get("query"),
                "grounded_fact_ids": grounded,
                "active_facts_retrieved": sorted(set(active_ids) & set(grounded)),
                "active_facts_missed": sorted(set(active_ids) - set(grounded)),
                "retrieved_facts_not_active": sorted(set(grounded) - set(active_ids)),
                "ungrounded_result_count": int(retrieval.get("ungrounded_result_count", 0)),
                "unknown_fact_ids": sorted({u for it in retrieval.get("results", []) for u in it.get("unknown_fact_ids", [])}),
            }
            semantic["covers_all_active_facts"] = not semantic["active_facts_missed"]

    recorded = tx.get("recorded_rejected")
    recorded = None if recorded is None or recorded != recorded else bool(recorded)  # NaN -> None
    env_check = {
        "recorded_rejected": recorded,
        "static_allowed": st["allowed"],
        "consistent": None if recorded is None else (st["allowed"] == (not recorded)),
    }

    by_id = {f["fact_id"]: f for f in st["active_facts"]}
    decision = "ALLOWED" if st["allowed"] else "BLOCKED"
    lines = [f"Transfer {s}->{r} of {a:,.2f} USD on {d}: {decision} by StaticMemoryProvider ({st['reason']})."]
    if st["decisive_fact_ids"]:
        lines.append("Decisive fact(s): " + "; ".join(_fact_brief(by_id[i]) for i in st["decisive_fact_ids"]) + ".")
    lines.append("Active fact(s) on this date: " + ("; ".join(_fact_brief(by_id[i]) for i in active_ids) or "none") + ".")
    if env_check["consistent"] is not None:
        lines.append("Matches the Stage 1D recorded outcome." if env_check["consistent"]
                     else "DOES NOT match the Stage 1D recorded outcome.")
    if semantic["status"] == "ok":
        lines.append(f"Semantic retrieval grounded {semantic['grounded_fact_ids'] or 'no facts'}; "
                     f"missed active {semantic['active_facts_missed'] or 'none'}; "
                     f"{semantic['ungrounded_result_count']} ungrounded result(s).")
    elif semantic["status"] == "error":
        lines.append(f"Semantic retrieval unavailable ({semantic['error']}).")

    return {
        "transaction_id": tx["transaction_id"], "sender": s, "receiver": r, "amount": a, "simulation_date": d,
        "regime": tx.get("regime"), "sources": tx.get("sources", []), "outcomes": tx.get("outcomes", {}),
        "decision": {"allowed": st["allowed"], "reason": st["reason"], "decisive_fact_ids": st["decisive_fact_ids"],
                     "active_fact_ids": active_ids, "source": "StaticMemoryProvider"},
        "active_facts": st["active_facts"],
        "env_consistency": env_check,
        "semantic": semantic,
        "explanation": " ".join(lines),
        "knowledge_version": st["knowledge_version"], "knowledge_sha256": st["knowledge_sha256"],
    }


def summarize(explanations: list, retrievals: Optional[dict]) -> dict:
    n = len(explanations)
    env = [e["env_consistency"]["consistent"] for e in explanations]
    sem = [e["semantic"] for e in explanations]
    ok = [x for x in sem if x["status"] == "ok"]
    by_source = {}
    for e in explanations:
        for src in e["sources"]:
            by_source[src] = by_source.get(src, 0) + 1
    return {
        "n_transactions": n,
        "transactions_by_source": by_source,
        "allowed": sum(e["decision"]["allowed"] for e in explanations),
        "blocked": sum(not e["decision"]["allowed"] for e in explanations),
        "env_consistency": {"checked": sum(v is not None for v in env), "consistent": sum(v is True for v in env),
                            "inconsistent": sum(v is False for v in env), "not_available": sum(v is None for v in env)},
        "semantic": {
            "status_counts": {s: sum(x["status"] == s for x in sem) for s in ("ok", "error", "not_requested")},
            "transactions_covering_all_active_facts": sum(x["covers_all_active_facts"] for x in ok),
            "transactions_missing_active_facts": sum(not x["covers_all_active_facts"] for x in ok),
            "transactions_with_retrieved_inactive_facts": sum(bool(x["retrieved_facts_not_active"]) for x in ok),
            "transactions_with_ungrounded_results": sum(x["ungrounded_result_count"] > 0 for x in ok),
            "unknown_fact_ids_seen": sorted({u for x in ok for u in x["unknown_fact_ids"]}),
            "corridors_retrieved": None if retrievals is None else sorted(retrievals),
            "corridors_with_errors": None if retrievals is None else sorted(k for k, v in retrievals.items() if "error" in v),
        },
    }


def run_audit(input_paths, out_dir, static: StaticMemoryProvider, adapter=None, top_k: int = 5) -> dict:
    """Runs the audit and writes explanations.jsonl, retrievals.json, summary.json and
    input_hashes.json into `out_dir` (must not exist). Inputs are verified unchanged."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=False)
    txs, meta = load_transactions(input_paths)
    if adapter is not None and adapter.knowledge.sha256 != static.knowledge.sha256:
        raise ValueError("adapter and static provider must use the same knowledge base")

    retrievals = None
    if adapter is not None:
        retrievals = retrieve_for_corridors(adapter, zip(txs["sender"], txs["receiver"]), top_k=top_k)

    explanations = [
        explain_transaction(tx, static, None if retrievals is None else retrievals[f"{tx['sender']}->{tx['receiver']}"])
        for tx in txs.to_dict(orient="records")
    ]
    with open(out_dir / "explanations.jsonl", "w", encoding="utf-8") as fh:
        for e in explanations:
            fh.write(json.dumps(e, default=str) + "\n")
    if retrievals is not None:
        (out_dir / "retrievals.json").write_text(json.dumps(retrievals, indent=2, default=str), encoding="utf-8")
    summary = summarize(explanations, retrievals)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2, default=str), encoding="utf-8")

    after = {m["path"]: sha256_file(m["path"]) for m in meta}
    changed = [m["path"] for m in meta if after[m["path"]] != m["sha256"]]
    if changed:
        raise RuntimeError(f"input files changed during the audit: {changed}")
    (out_dir / "input_hashes.json").write_text(json.dumps(
        {"inputs": meta, "verified_unchanged_after_audit": True}, indent=2), encoding="utf-8")
    return summary
