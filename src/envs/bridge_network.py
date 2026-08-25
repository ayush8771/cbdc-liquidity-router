import pandas as pd
import logging
from collections import defaultdict

logger = logging.getLogger(__name__)

# Stage 1A: simulation capacity, NOT a claim about real CBDC bridge infrastructure.
# See FINAL Approved Specification §4.
MAX_BRIDGES = 6


class BridgeNetwork:
    """Parses network graph topology (nodes, edges, capacities, fees) from
    structured CSVs.

    Stage 1A fixes:
    - Column names now match the actual structured CSV schema
      (`liquidity_capacity`, `latency_fee_pct`) instead of the previous
      `capacity`/`fee_rate` names, which never matched any real column and
      silently fell back to hardcoded defaults on every row.
    - Storage changed from a single dict per (source, target) pair - which
      could only ever hold ONE bridge per corridor and would silently
      overwrite a second row for the same corridor - to a list per
      corridor, so the code structurally supports multiple vaults per
      corridor. The current structured CSV still only has one bridge per
      corridor (a Stage 1B data-expansion item, not a Stage 1A one), but
      the code no longer silently discards a second bridge if/when that
      data arrives.
    """

    DEFAULT_CONGESTION_PLACEHOLDER = 0.0

    # Same placeholder status as congestion above - real risk is derived
    # from macro_risk_proxy (WDI/CPI) per the approved specification, a
    # Stage 1B deliverable not implemented here.
    DEFAULT_RISK_PLACEHOLDER = 0.0

    def __init__(
        self,
        bridge_csv="data/structured/bridge_network.csv",
        countries_csv="data/structured/countries.csv",
    ):
        self.bridge_csv = bridge_csv
        self.countries_csv = countries_csv
        self._corridor_index = defaultdict(list)  # (source, target) -> [bridge dict, ...]
        self._valid_countries = None
        self._load_countries()
        self.load_network()

    def _load_countries(self):
        """Stage 1A fix: countries_csv was previously accepted but never
        read (dead parameter). Now used for lightweight validation of bridge
        endpoints - logs a warning for unrecognized nodes rather than
        silently ignoring or hard-failing.
        """
        try:
            df = pd.read_csv(self.countries_csv)
            code_col = "ISO 3166-1 alpha-3 country code"
            if code_col in df.columns:
                self._valid_countries = set(df[code_col].dropna().astype(str))
            else:
                logger.warning(
                    "[BridgeNetwork] countries_csv missing expected column "
                    f"'{code_col}' - skipping country validation."
                )
        except Exception as e:
            logger.warning(f"[BridgeNetwork] Could not load countries_csv ({e}).")

    def load_network(self):
        try:
            df = pd.read_csv(self.bridge_csv)
            for idx, row in df.iterrows():
                src = row["source_node"]
                tgt = row["target_node"]

                # Stage 1A fix: real column is `liquidity_capacity`, not
                # `capacity`. Previously always fell back to the 1,000,000
                # default regardless of actual data.
                cap = float(row.get("liquidity_capacity", 1_000_000.0))

                # `latency_fee_pct` was already correct in the original code.
                fee = float(row.get("latency_fee_pct", 0.01))

                congestion = float(
                    row.get("congestion", self.DEFAULT_CONGESTION_PLACEHOLDER)
                )
                risk = float(row.get("risk", self.DEFAULT_RISK_PLACEHOLDER))

                if self._valid_countries is not None:
                    for node, label in ((src, "source_node"), (tgt, "target_node")):
                        if str(node) not in self._valid_countries:
                            logger.warning(
                                f"[BridgeNetwork] Row {idx}: {label} '{node}' "
                                "not found in countries.csv."
                            )

                bridge = {
                    "bridge_id": f"{src}->{tgt}#{idx}",
                    "source": src,
                    "target": tgt,
                    "capacity": cap,
                    "fee": fee,
                    "congestion": congestion,
                    "risk": risk,
                    "row_index": idx,
                }
                self._corridor_index[(src, tgt)].append(bridge)

            num_bridges = sum(len(v) for v in self._corridor_index.values())
            num_corridors = len(self._corridor_index)
            logger.info(
                f"[BridgeNetwork] Loaded {num_bridges} bridges across "
                f"{num_corridors} corridors."
            )
        except Exception as e:
            logger.warning(f"[BridgeNetwork] Warning: Could not parse network file ({e}).")

    def get_bridges_for_corridor(self, source, target):
        """Returns a list of bridge dicts for a given (source, target)
        corridor, each with capacity/fee/congestion/risk/a stable bridge_id.
        Ordered by row_index (CSV order) for determinism. Capped at
        MAX_BRIDGES defensively - a no-op today since the current data has
        at most one bridge per corridor.
        """
        bridges = self._corridor_index.get((source, target), [])
        return bridges[:MAX_BRIDGES]

    def get_capacity(self, source, target):
        """Legacy single-value accessor - returns the first bridge's
        capacity for this corridor (0.0 if none). Kept for backward
        compatibility; prefer get_bridges_for_corridor for anything
        multi-bridge-aware.
        """
        bridges = self.get_bridges_for_corridor(source, target)
        return bridges[0]["capacity"] if bridges else 0.0

    def get_fee(self, source, target):
        bridges = self.get_bridges_for_corridor(source, target)
        return bridges[0]["fee"] if bridges else 0.0

    def get_congestion(self, source, target):
        bridges = self.get_bridges_for_corridor(source, target)
        return bridges[0]["congestion"] if bridges else self.DEFAULT_CONGESTION_PLACEHOLDER

    def get_risk(self, source, target):
        bridges = self.get_bridges_for_corridor(source, target)
        return bridges[0]["risk"] if bridges else self.DEFAULT_RISK_PLACEHOLDER