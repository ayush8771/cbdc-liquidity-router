from .knowledge import DEFAULT_KNOWLEDGE_PATH
from .provider import StaticMemoryProvider


class CogneeMemoryLayer:
    """Semantic Memory Layer for dynamic regulatory and policy constraints.

    Stage 1E step 1: a compatibility wrapper. `constraints` is now derived
    from the provenance-tagged knowledge base (data/knowledge/
    regulatory_facts.json) via StaticMemoryProvider instead of being
    hard-coded, but `constraints` and `check_transaction` keep exactly the
    pre-Stage-1E shape, values, reason strings and logic - so
    CBDCLiquidityEnv (which reads and may override
    constraints["max_single_transfer_usd"]) behaves identically.

    Cognee itself is not used here yet. Memory never sees or changes routing
    allocations; it can only block a transaction via the existing feasibility
    check, and only with facts the legacy check can express.
    """

    def __init__(self, provider=None, knowledge_path=DEFAULT_KNOWLEDGE_PATH):
        self.provider = provider if provider is not None else StaticMemoryProvider(path=knowledge_path)
        self.constraints = self.provider.legacy_constraints()

    def check_transaction(self, sender: str, receiver: str, amount: float):
        if amount > self.constraints["max_single_transfer_usd"]:
            return False, "Transaction amount exceeds single transfer policy limit."
        if (sender, receiver) in self.constraints["restricted_corridors"]:
            return False, "Corridor restricted under active memory policy rules."
        return True, "Valid transaction under memory rules."

    def constraints_overridden(self) -> bool:
        """True if `constraints` was changed after construction (e.g. by
        CBDCLiquidityEnv(max_transfer_usd=...)), so it no longer matches the
        knowledge base."""
        return self.constraints != self.provider.legacy_constraints()

    def get_context(self, sender, receiver, simulation_date=None):
        """Knowledge-base facts for this corridor (read-only; not runtime overrides)."""
        return self.provider.get_context(sender, receiver, simulation_date)

    def explain(self, sender, receiver, amount, simulation_date=None):
        """Explanation from the knowledge base, plus the decision actually
        enforced by `constraints` (they differ only if constraints were overridden)."""
        out = self.provider.explain(sender, receiver, amount, simulation_date)
        ok, reason = self.check_transaction(sender, receiver, amount)
        out.update({"enforced_allowed": ok, "enforced_reason": reason,
                    "constraints_overridden": self.constraints_overridden()})
        return out
