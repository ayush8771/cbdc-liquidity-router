"""Stage 1E - memory provider interface and the deterministic static provider.

A MemoryProvider answers three questions about a transaction:
    check_transaction  - may it be routed at all? (hard feasibility filter)
    get_context        - which facts apply to this corridor (as of a date)?
    explain            - why was it allowed/blocked, with fact ids and sources?

Providers never see, choose or modify routing allocations; they cannot
override PPO decisions. StaticMemoryProvider is fully deterministic and reads
only the structured knowledge base. A Cognee-backed provider (step 2) will
add semantic retrieval for get_context/explain only.
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable

from .knowledge import DEFAULT_KNOWLEDGE_PATH, Fact, KnowledgeBase, load_knowledge

# Exact reason strings of the pre-Stage-1E stub (kept so environment behaviour is unchanged).
REASON_OK = "Valid transaction under memory rules."
REASON_OVER_LIMIT = "Transaction amount exceeds single transfer policy limit."
REASON_RESTRICTED = "Corridor restricted under active memory policy rules."


@runtime_checkable
class MemoryProvider(Protocol):
    def check_transaction(self, sender: str, receiver: str, amount: float,
                          simulation_date=None) -> tuple: ...

    def get_context(self, sender: str, receiver: str, simulation_date=None) -> list: ...

    def explain(self, sender: str, receiver: str, amount: float, simulation_date=None) -> dict: ...


class StaticMemoryProvider:
    """Deterministic provider over a KnowledgeBase.

    Rule semantics (checked in this order, matching the legacy stub):
      1. max_single_transfer_usd: the transaction is blocked if amount > the
         SMALLEST active cap that applies to the corridor (most restrictive wins).
      2. restricted_corridor: blocked if an active restriction names this exact corridor.
    With simulation_date=None only undated facts are considered active.
    """

    def __init__(self, knowledge: Optional[KnowledgeBase] = None, path=DEFAULT_KNOWLEDGE_PATH):
        self.knowledge = knowledge if knowledge is not None else load_knowledge(path)

    def get_context(self, sender, receiver, simulation_date=None) -> list:
        return [f for f in self.knowledge.facts
                if f.applies_to(sender, receiver) and f.active_on(simulation_date)]

    def _decide(self, sender, receiver, amount, simulation_date):
        active = self.get_context(sender, receiver, simulation_date)
        caps = [f for f in active if f.rule_type == "max_single_transfer_usd"]
        if caps:
            binding = min(caps, key=lambda f: (f.value, f.fact_id))
            if amount > binding.value:
                return False, REASON_OVER_LIMIT, [binding], active
        restrictions = [f for f in active if f.rule_type == "restricted_corridor"]
        if restrictions:
            return False, REASON_RESTRICTED, restrictions, active
        return True, REASON_OK, [], active

    def check_transaction(self, sender, receiver, amount, simulation_date=None):
        ok, reason, _, _ = self._decide(sender, receiver, float(amount), simulation_date)
        return ok, reason

    def explain(self, sender, receiver, amount, simulation_date=None) -> dict:
        ok, reason, decisive, active = self._decide(sender, receiver, float(amount), simulation_date)
        return {
            "allowed": ok, "reason": reason,
            "decisive_fact_ids": [f.fact_id for f in decisive],
            "active_facts": [f.to_dict() for f in active],
            "knowledge_version": self.knowledge.knowledge_version,
            "knowledge_sha256": self.knowledge.sha256,
            "provider": type(self).__name__,
        }

    def legacy_constraints(self) -> dict:
        """The stub's `constraints` dict, derived from the knowledge base.

        Only global, undated caps and undated exact-corridor restrictions can be
        expressed in the legacy (date-free) environment check. Any other fact
        would change environment semantics, so it is rejected here rather than
        silently ignored; enabling it needs an approved, tested change.
        """
        unsupported = [f.fact_id for f in self.knowledge.facts
                       if not f.is_undated or (f.rule_type == "max_single_transfer_usd" and not f.is_global)]
        if unsupported:
            raise NotImplementedError(
                f"facts {unsupported} are dated or corridor-scoped caps; the current environment check is "
                "date-free and global. Enabling them requires an approved environment change.")
        caps = [f.value for f in self.knowledge.facts if f.rule_type == "max_single_transfer_usd"]
        if not caps:
            raise NotImplementedError("knowledge base has no global max_single_transfer_usd; the legacy "
                                      "environment check requires one.")
        restricted = [(f.sender, f.receiver) for f in self.knowledge.facts if f.rule_type == "restricted_corridor"]
        return {"max_single_transfer_usd": min(caps), "restricted_corridors": restricted}
