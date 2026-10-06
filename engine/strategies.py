"""Strategy screens — "fundamentally strong, but trading well below its 52-week average".

A deterministic job (no LLM), applied at the end of `metrics.compute()` so the index
scoreboard, the stock `score_frame()` and the walk-forward backtest all carry the same
columns. The idea: a business that is still growing, profitable and not expensive, whose
price has fallen well below its own 52-week average, may be a temporary mispricing
rather than a broken company.

Why this needs its own fundamentals test: the existing `value_trap` flag in metrics.py is
PRICE-only (cheap + deeply down + still falling). It never looks at the business, so it
cannot tell "falling because it's broken" from "falling while the numbers keep improving".
These screens are that second half.

Columns added (all NaN-tolerant; an index row simply has no market cap, a stock row no
forward estimates):
  discount_52w        price vs its 52-week average (ma252_ratio, falling back to the
                      200-day average when a full year of prices isn't available)
  data_sane           valuation inputs are plausible (see config.SANE_*) and, for stocks,
                      the income statement is in USD (prices are USD)
  fundamentally_strong  profitable, revenue AND earnings growing (each <= +150%: bigger
                      jumps are usually one-offs), growth at least median
                      vs peers, not in the expensive cohort, enough data to say so
  on_sale             strong + sane + >=10% below its 52-week average
  deep_value_intact   on_sale + >=20% below + cheap (value score >= 60)
  turning_up          on_sale + price already recovering (1m return > 0, off its lows)
  on_sale_score       for strong+sane names only (NaN otherwise): percentile, within
                      peers, of how far below the 52-week average it trades. Defined on
                      that subset ON PURPOSE — the backtest then tests exactly the claim
                      "among fundamentally strong names, the beaten-down ones do better",
                      not "fundamentally strong beats everything" (a different question).
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import (
    DEEP_DISCOUNT,
    DEEP_VALUE_MIN_SCORE,
    GROWTH_WINSOR,
    ON_SALE_DISCOUNT,
    SANE_MIN_MARKET_CAP,
    SANE_MIN_PE,
    SANE_MIN_PS,
    STRONG_MIN_COVERAGE,
    STRONG_MIN_GROWTH_SCORE,
    TURNING_UP_MIN_RANGE,
)

# Human-readable definitions — the dashboard renders these verbatim, so the rule a
# reader sees is the rule the code applies.
STRATEGIES = {
    "on_sale": {
        "label": "Quality on sale",
        "rule": f"Profitable, revenue and earnings growing, not expensive vs peers — and "
                f"trading at least {abs(ON_SALE_DISCOUNT):.0%} below its 52-week average.",
    },
    "deep_value_intact": {
        "label": "Deep discount, fundamentals intact",
        "rule": f"Quality on sale, at least {abs(DEEP_DISCOUNT):.0%} below its 52-week "
                f"average, and cheap (value score {DEEP_VALUE_MIN_SCORE}+).",
    },
    "turning_up": {
        "label": "Quality on sale, turning up",
        "rule": f"Quality on sale where the fall looks to have stopped: up over the last "
                f"month and back at least {TURNING_UP_MIN_RANGE:.0%} off its 52-week low.",
    },
}


def _col(df: pd.DataFrame, name: str) -> pd.Series:
    return df[name] if name in df else pd.Series(np.nan, index=df.index)


def apply(df: pd.DataFrame) -> pd.DataFrame:
    """Add the screen columns to a frame already scored by metrics.compute()."""
    df = df.copy()
    pe, ps, mcap = _col(df, "pe"), _col(df, "ps"), _col(df, "market_cap")
    rev, earn, fwd = _col(df, "rev_growth"), _col(df, "earnings_growth"), _col(df, "fwd_growth")
    cov = _col(df, "growth_cov")

    df["discount_52w"] = _col(df, "ma252_ratio").fillna(_col(df, "ma200_ratio"))

    # "Implausible" is tested positively, so a missing input (an index has no market
    # cap) never fails the gate — only a present-and-absurd value does.
    # A stock whose income statement isn't in USD has every valuation ratio off by an
    # exchange rate (prices are USD) — not plausible until fundamentals are converted.
    ccy = df["reporting_currency"] if "reporting_currency" in df else pd.Series(None, index=df.index)
    foreign_ccy = ccy.notna() & (ccy.astype(str).str.upper() != "USD")
    df["data_sane"] = ~((pe > 0) & (pe < SANE_MIN_PE)) & ~(ps < SANE_MIN_PS) \
        & ~(mcap < SANE_MIN_MARKET_CAP) & ~foreign_ccy

    # Earnings growth above the same +150% bound used for revenue is usually a one-off
    # (a prior-year write-down reversing, an asset sale) — and it also flatters the P/E.
    # Real data: Edison +247% at P/E 4.7, Clorox +189%. Forward estimates, where they
    # exist (indices), can carry the test instead.
    earnings_up = ((earn > 0) & (earn <= GROWTH_WINSOR[1])) | (fwd > 0)
    df["fundamentally_strong"] = (
        (pe > 0)                                            # profitable
        & (rev > 0) & (rev <= GROWTH_WINSOR[1])             # growing, not a base-effect spike
        & earnings_up
        & (_col(df, "growth_score") >= STRONG_MIN_GROWTH_SCORE)
        & ~df["overvalued"].fillna(False).astype(bool)
        & (cov.fillna(1.0) >= STRONG_MIN_COVERAGE)          # stocks carry growth_cov = 1.0
    )

    eligible = df["fundamentally_strong"] & df["data_sane"]
    disc = df["discount_52w"]
    df["on_sale"] = eligible & (disc <= ON_SALE_DISCOUNT)
    df["deep_value_intact"] = df["on_sale"] & (disc <= DEEP_DISCOUNT) \
        & (_col(df, "value_score") >= DEEP_VALUE_MIN_SCORE)
    df["turning_up"] = df["on_sale"] & (_col(df, "ret_1m") > 0) \
        & (_col(df, "pct_52w_range") >= TURNING_UP_MIN_RANGE)

    score = pd.Series(np.nan, index=df.index)
    sub = df[eligible & disc.notna()]
    if not sub.empty:
        score.loc[sub.index] = sub.groupby("kind")["discount_52w"].transform(
            lambda s: (-s).rank(pct=True) * 100.0)
    df["on_sale_score"] = score.round(1)

    df["strategies"] = [[k for k in STRATEGIES if bool(r[k])]
                        for _, r in df[list(STRATEGIES)].iterrows()]
    return df
