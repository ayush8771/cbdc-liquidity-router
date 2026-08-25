class CogneeMemoryLayer:
    """Semantic Memory Layer for dynamic regulatory and policy constraints."""
    def __init__(self):
        self.constraints = {
            "max_single_transfer_usd": 500000.0,
            "restricted_corridors": []
        }

    def check_transaction(self, sender: str, receiver: str, amount: float):
        if amount > self.constraints["max_single_transfer_usd"]:
            return False, "Transaction amount exceeds single transfer policy limit."
        if (sender, receiver) in self.constraints["restricted_corridors"]:
            return False, "Corridor restricted under active memory policy rules."
        return True, "Valid transaction under memory rules."