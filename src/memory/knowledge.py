"""Stage 1E - structured, provenance-tagged knowledge base.

The knowledge file is the ONLY memory source allowed to affect feasibility.
It is read deterministically (no LLM, no network). Cognee, when added, indexes
the same facts for retrieval/explanation and never replaces this file.

Fact fields:
    fact_id         unique id
    rule_type       one of RULE_TYPES
    value           rule value (number for max_single_transfer_usd, null for restricted_corridor)
    scope           {"sender": ISO3 | "*", "receiver": ISO3 | "*"}
    effective_from  "YYYY-MM-DD" or null (unbounded)
    effective_to    "YYYY-MM-DD" or null (unbounded), inclusive
    provenance_tag  one of PROVENANCE_TAGS
    verified        bool - true only when `source` is a checked real-world source
    source          non-empty citation / origin description
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pandas as pd

DEFAULT_KNOWLEDGE_PATH = Path(__file__).resolve().parents[2] / "data" / "knowledge" / "regulatory_facts.json"

SCHEMA_VERSION = 1
RULE_TYPES = {"max_single_transfer_usd", "restricted_corridor"}
PROVENANCE_TAGS = {"real_regulation", "real_operational", "project_assumption", "synthetic"}
WILDCARD = "*"


class KnowledgeValidationError(ValueError):
    pass


@dataclass(frozen=True)
class Fact:
    fact_id: str
    rule_type: str
    value: Optional[float]
    sender: str
    receiver: str
    effective_from: Optional[pd.Timestamp]
    effective_to: Optional[pd.Timestamp]
    provenance_tag: str
    verified: bool
    source: str
    notes: str = ""

    @property
    def is_global(self) -> bool:
        return self.sender == WILDCARD and self.receiver == WILDCARD

    @property
    def is_undated(self) -> bool:
        return self.effective_from is None and self.effective_to is None

    def applies_to(self, sender: str, receiver: str) -> bool:
        return self.sender in (WILDCARD, sender) and self.receiver in (WILDCARD, receiver)

    def active_on(self, date) -> bool:
        """Undated facts are always active. With a date, the fact is active if
        effective_from <= date <= effective_to (inclusive; None = unbounded).
        With date=None, only undated facts count as active (no assumption
        about 'now')."""
        if date is None:
            return self.is_undated
        d = pd.Timestamp(date)
        if self.effective_from is not None and d < self.effective_from:
            return False
        if self.effective_to is not None and d > self.effective_to:
            return False
        return True

    def to_dict(self) -> dict:
        return {
            "fact_id": self.fact_id, "rule_type": self.rule_type, "value": self.value,
            "scope": {"sender": self.sender, "receiver": self.receiver},
            "effective_from": None if self.effective_from is None else self.effective_from.strftime("%Y-%m-%d"),
            "effective_to": None if self.effective_to is None else self.effective_to.strftime("%Y-%m-%d"),
            "provenance_tag": self.provenance_tag, "verified": self.verified, "source": self.source,
            "notes": self.notes,
        }


@dataclass(frozen=True)
class KnowledgeBase:
    facts: tuple
    schema_version: int
    knowledge_version: str
    source_path: Optional[str] = None
    sha256: Optional[str] = None
    by_id: dict = field(default_factory=dict, compare=False)


def _parse_date(value, fact_id, name):
    if value is None:
        return None
    try:
        return pd.Timestamp(value)
    except (ValueError, TypeError) as e:
        raise KnowledgeValidationError(f"{fact_id}: invalid {name} {value!r}") from e


def parse_fact(raw: dict) -> Fact:
    if not isinstance(raw, dict):
        raise KnowledgeValidationError(f"fact must be an object, got {type(raw).__name__}")
    fact_id = raw.get("fact_id")
    if not isinstance(fact_id, str) or not fact_id.strip():
        raise KnowledgeValidationError("fact_id must be a non-empty string")
    rule_type = raw.get("rule_type")
    if rule_type not in RULE_TYPES:
        raise KnowledgeValidationError(f"{fact_id}: unknown rule_type {rule_type!r} (allowed: {sorted(RULE_TYPES)})")
    scope = raw.get("scope")
    if not isinstance(scope, dict) or not all(isinstance(scope.get(k), str) and scope.get(k) for k in ("sender", "receiver")):
        raise KnowledgeValidationError(f"{fact_id}: scope must have non-empty 'sender' and 'receiver'")
    value = raw.get("value")
    if rule_type == "max_single_transfer_usd":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not (value > 0) or value != value \
                or value == float("inf"):
            raise KnowledgeValidationError(f"{fact_id}: max_single_transfer_usd needs a finite positive number")
        value = float(value)
    elif value is not None:
        raise KnowledgeValidationError(f"{fact_id}: {rule_type} must have value null")
    if rule_type == "restricted_corridor" and WILDCARD in (scope["sender"], scope["receiver"]):
        raise KnowledgeValidationError(f"{fact_id}: restricted_corridor must name an exact sender and receiver")
    eff_from = _parse_date(raw.get("effective_from"), fact_id, "effective_from")
    eff_to = _parse_date(raw.get("effective_to"), fact_id, "effective_to")
    if eff_from is not None and eff_to is not None and eff_from > eff_to:
        raise KnowledgeValidationError(f"{fact_id}: effective_from is after effective_to")
    tag = raw.get("provenance_tag")
    if tag not in PROVENANCE_TAGS:
        raise KnowledgeValidationError(f"{fact_id}: unknown provenance_tag {tag!r} (allowed: {sorted(PROVENANCE_TAGS)})")
    verified = raw.get("verified")
    if not isinstance(verified, bool):
        raise KnowledgeValidationError(f"{fact_id}: verified must be true/false")
    if verified and tag in ("project_assumption", "synthetic"):
        raise KnowledgeValidationError(f"{fact_id}: a {tag} fact cannot be marked verified")
    source = raw.get("source")
    if not isinstance(source, str) or not source.strip():
        raise KnowledgeValidationError(f"{fact_id}: source must be a non-empty string")
    return Fact(fact_id=fact_id, rule_type=rule_type, value=value, sender=scope["sender"], receiver=scope["receiver"],
                effective_from=eff_from, effective_to=eff_to, provenance_tag=tag, verified=verified,
                source=source, notes=str(raw.get("notes", "")))


def build_knowledge_base(payload: dict, source_path=None, sha256=None) -> KnowledgeBase:
    if not isinstance(payload, dict):
        raise KnowledgeValidationError("knowledge payload must be a JSON object")
    if payload.get("schema_version") != SCHEMA_VERSION:
        raise KnowledgeValidationError(f"unsupported schema_version {payload.get('schema_version')!r} (expected {SCHEMA_VERSION})")
    version = payload.get("knowledge_version")
    if not isinstance(version, str) or not version:
        raise KnowledgeValidationError("knowledge_version must be a non-empty string")
    raw_facts = payload.get("facts")
    if not isinstance(raw_facts, list):
        raise KnowledgeValidationError("facts must be a list")
    facts = tuple(parse_fact(r) for r in raw_facts)
    ids = [f.fact_id for f in facts]
    dupes = sorted({i for i in ids if ids.count(i) > 1})
    if dupes:
        raise KnowledgeValidationError(f"duplicate fact_id(s): {dupes}")
    return KnowledgeBase(facts=facts, schema_version=SCHEMA_VERSION, knowledge_version=version,
                         source_path=None if source_path is None else str(source_path), sha256=sha256,
                         by_id={f.fact_id: f for f in facts})


def load_knowledge(path=DEFAULT_KNOWLEDGE_PATH) -> KnowledgeBase:
    path = Path(path)
    raw = path.read_bytes()
    try:
        payload = json.loads(raw.decode("utf-8"))
    except json.JSONDecodeError as e:
        raise KnowledgeValidationError(f"{path}: invalid JSON ({e})") from e
    return build_knowledge_base(payload, source_path=path, sha256=hashlib.sha256(raw).hexdigest())
