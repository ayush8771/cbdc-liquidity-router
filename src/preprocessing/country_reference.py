"""Country reference cleaning (Stage 1B Specification v3 §5/§6).

REAL data, cleaned only - no new information created.
".." sentinel -> NaN. Congo (COG/COD/ZAR) and ARE Region=".." issues are
documented, NOT fixed, per approved decisions.
"""
import pandas as pd

SENTINEL_COLS = ["Region", "Income Group", "Lending category", "G8/G20"]


def build_country_reference_clean(countries_csv):
    df = pd.read_csv(countries_csv)
    for col in SENTINEL_COLS:
        if col in df.columns:
            df[col] = df[col].replace("..", pd.NA)
    return df
