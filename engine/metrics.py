"""Scoring engine — the deterministic brain.

Turns raw snapshots into the two things you asked for:
  * Value score       -> "cheap and good value buys" (requirement #3)
  * Opportunity score -> growth/upside that is NOT (or less) overvalued (#4)

Plus guardrails: overvalued flag and value-trap detection. Everything is ranked
WITHIN its `kind` peer group (countries vs countries, sectors vs sectors), so
adding US sectors never distorts the country value comparison. Weights come from
the tuning layer, which the market-feedback loop can adjust over time.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import (
    GROWTH_FWD_WEIGHT,
    OVERVALUED_QUANTILE,
    VALUE_TRAP_DRAWDOWN,
    VALUE_TRAP_MOM_12M,
)
from .tuning import current_opportunity_weights, current_value_weights


def _pct_in_group(df: pd.DataFrame, col: str) -> pd.Series:
    """Percentile rank 0..100 within each `kind` group."""
    return df.groupby("kind")[col].transform(lambda s: s.rank(pct=True) * 100.0)


def _z_in_group(df: pd.DataFrame, col: str) -> pd.Series:
    def z(s):
        sd = s.std(ddof=0)
        return (s - s.mean()) / sd if sd and not np.isnan(sd) else pd.Series(0.0, index=s.index)
    return df.groupby("kind")[col].transform(z)


def compute(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    vw, ow = current_value_weights(), current_opportunity_weights()

    # --- yields (higher = cheaper) ---
    df["earnings_yield"] = 1.0 / df["pe"].where(df["pe"] > 0)
    df["book_yield"] = 1.0 / df["pb"].where(df["pb"] > 0)
    df["sales_yield"] = 1.0 / df["ps"].where(df["ps"] > 0)
    df["cashflow_yield"] = 1.0 / df["pcf"].where(df["pcf"] > 0)
    df["dividend_yield"] = df["dividend_yield"].fillna(0.0)

    # --- Value score: weighted z-blend of cheapness, ranked within kind ---
    val = pd.Series(0.0, index=df.index)
    wsum = 0.0
    for col, w in vw.items():
        if col in df:
            val = val.add(_z_in_group(df, col) * w, fill_value=0.0)
            wsum += w
    df["value_raw"] = val / (wsum or 1.0)
    df["value_score"] = _pct_in_group(df, "value_raw").round(1)

    # --- Overvalued gate (within kind) ---
    df["richness"] = -df["value_raw"]
    cutoff = df.groupby("kind")["richness"].transform(lambda s: s.quantile(OVERVALUED_QUANTILE))
    df["overvalued"] = df["richness"] >= cutoff

    # --- Momentum (blended 3/6/12m total return), ranked within kind ---
    df["momentum_raw"] = (
        0.5 * df["ret_3m"].fillna(0) + 0.3 * df["ret_6m"].fillna(0) + 0.2 * df["ret_12m"].fillna(0)
    )
    df["momentum_score"] = _pct_in_group(df, "momentum_raw").round(1)

    # --- Mean-reversion: depressed vs its own 52w range / 200d MA ---
    df["mean_reversion_raw"] = (
        (1.0 - df["pct_52w_range"].fillna(0.5)) * 0.6
        + (-df["ma200_ratio"].fillna(0)).clip(lower=0) * 0.4
    )
    df["mean_reversion_score"] = _pct_in_group(df, "mean_reversion_raw").round(1)

    # --- Fundamental growth: real revenue/earnings growth of the top holdings,
    #     blended with forward analyst estimates. NOT price momentum. ---
    for c in ("rev_growth", "earnings_growth", "fwd_growth"):
        if c not in df:
            df[c] = np.nan
    trailing = df[["earnings_growth", "rev_growth"]].mean(axis=1, skipna=True)
    fwd = df["fwd_growth"]
    df["growth_raw"] = np.where(
        fwd.notna() & trailing.notna(), GROWTH_FWD_WEIGHT * fwd + (1 - GROWTH_FWD_WEIGHT) * trailing,
        np.where(fwd.notna(), fwd, trailing),
    )
    df["has_growth"] = pd.Series(df["growth_raw"], index=df.index).notna()
    df["growth_score"] = _pct_in_group(df, "growth_raw").round(1)
    # Markets with no constituent growth data sit neutral so they aren't penalised.
    df["growth_score_eff"] = df["growth_score"].fillna(50.0)
    df["high_growth"] = df["growth_score"] >= 75.0

    # --- Opportunity (true GARP): cheap + fundamentally growing, gated ---
    opp = (
        ow["value"] * df["value_score"]
        + ow.get("growth", 0.40) * df["growth_score_eff"]
        + ow.get("momentum", 0.12) * df["momentum_score"]
        + ow.get("mean_reversion", 0.08) * df["mean_reversion_score"]
    )
    opp = opp.where(~df["overvalued"], opp - 15)
    df["opportunity_score"] = opp.clip(0, 100).round(1)

    # --- Value-trap flag: cheap but deeply down and still weak ---
    df["value_trap"] = (
        (df["value_score"] >= 70)
        & (df["ret_12m"].fillna(0) <= VALUE_TRAP_MOM_12M)
        & (df["drawdown_52w"].fillna(0) <= VALUE_TRAP_DRAWDOWN)
    )

    df["value_band"] = pd.cut(
        df["value_score"], [-1, 33, 66, 101], labels=["Expensive", "Fair", "Cheap"]
    ).astype(str)

    # GARP sweet spot: reasonably cheap AND high fundamental growth, not overvalued.
    df["garp"] = (df["value_score"] >= 55) & df["high_growth"] & (~df["overvalued"])

    return df.sort_values("opportunity_score", ascending=False).reset_index(drop=True)
