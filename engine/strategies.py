"""Strategy screens — "fundamentally strong, but trading well below its long-run average price".

A deterministic job (no LLM), applied at the end of `metrics.compute()` so the index
scoreboard, the stock `score_frame()` and the walk-forward backtest all carry the same
columns. The idea: a business that is still growing, profitable and not expensive, whose
price has fallen well below its own 5-year average price, may be a temporary mispricing
rather than a broken company.

Why this needs its own fundamentals test: the existing `value_trap` flag in metrics.py is
PRICE-only (cheap + deeply down + still falling). It never looks at the business, so it
cannot tell "falling because it's broken" from "falling while the numbers keep improving".
These screens are that second half.

Columns added (all NaN-tolerant; an index row simply has no market cap, a stock row no
forward estimates):
  discount_long       price vs its long-run average (ma_long_ratio): the average close
                      over the last 5 years (config.LONG_AVG_YEARS), or all the history on
                      file when shorter but >= 1 year — long_avg_years says which. Was the
                      52-week average until 2026-10-07 (ADR-036).
  data_sane           valuation inputs are plausible (see config.SANE_*) and, for stocks,
                      the income statement is in USD (prices are USD)
  fundamentally_strong  profitable, growth at least median vs peers, not in the
                      expensive cohort, enough data to say so — and growing as a
                      RECORD where there are >= 3 years of history (profitable >= 80% of
                      up to 6 years, revenue and earnings up >= 60% with positive CAGRs, revenue
                      not boom-bust, not shrinking now); otherwise last year's revenue
                      AND earnings growing (each <= +150%: bigger jumps are one-offs)
  steady_compounder   revenue and earnings up >= 80% of years, never a loss, low
                      volatility (growthhistory.py)
  on_sale             strong + sane + >=10% below its long-run average
  deep_value_intact   on_sale + >=20% below + cheap (value score >= 60)
  turning_up          on_sale + price already recovering (1m return > 0, off its lows)
  steady_on_sale      on_sale + steady_compounder
  on_sale_score       for strong+sane names only (NaN otherwise): percentile, within
                      peers, of how far below the long-run average it trades. Defined on
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
    LONG_AVG_YEARS,
    ON_SALE_DISCOUNT,
    SANE_MIN_MARKET_CAP,
    SANE_MIN_PE,
    SANE_MIN_PS,
    STEADY_MAX_NI_VOL,
    STEADY_MAX_REV_VOL,
    STEADY_MIN_CAGR,
    STEADY_MIN_UP_YEARS,
    STRONG_MAX_REV_VOL,
    STRONG_MIN_COVERAGE,
    STRONG_MIN_GROWTH_SCORE,
    STRONG_MIN_LATEST_REV,
    STRONG_MIN_NI_UP_YEARS,
    STRONG_MIN_PROFITABLE_YEARS,
    STRONG_MIN_REV_UP_YEARS,
    TURNING_UP_MIN_RANGE,
)
from .growthhistory import MIN_CHANGES

# Human-readable definitions — the dashboard renders these verbatim, so the rule a
# reader sees is the rule the code applies.
STRATEGIES = {
    "on_sale": {
        "label": "Quality on sale",
        "rule": f"Profitable, revenue and earnings growing, not expensive vs peers — and "
                f"trading at least {abs(ON_SALE_DISCOUNT):.0%} below its {LONG_AVG_YEARS}-year "
                f"average price (or its average over all the price history on file, if shorter).",
    },
    "deep_value_intact": {
        "label": "Deep discount, fundamentals intact",
        "rule": f"Quality on sale, at least {abs(DEEP_DISCOUNT):.0%} below its long-run "
                f"average, and cheap (value score {DEEP_VALUE_MIN_SCORE}+).",
    },
    "turning_up": {
        "label": "Quality on sale, turning up",
        "rule": f"Quality on sale where the fall looks to have stopped: up over the last "
                f"month and back at least {TURNING_UP_MIN_RANGE:.0%} off its 52-week low.",
    },
    "steady_on_sale": {
        "label": "Steady compounder on sale",
        "rule": f"Quality on sale with a steady record: revenue and earnings up in at least "
                f"{STEADY_MIN_UP_YEARS:.0%} of the last six years, profitable every year, "
                f"and low year-to-year volatility.",
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

    # No fallback to a short average: under a year of prices there is no long-run
    # average to be below (a 200-day stand-in would be a different, much easier test).
    df["discount_long"] = _col(df, "ma_long_ratio")

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
    one_year = (rev > 0) & (rev <= GROWTH_WINSOR[1]) & earnings_up

    # With several years of history (stocks), "growing" means a RECORD, not one year:
    # last year can be a rebound or a one-off (Amgen: earnings +89% last year, a
    # fraction of that as a multi-year trend). Short-history stocks and index rows keep the one-year test.
    rev_up, ni_up = _col(df, "rev_up_ratio"), _col(df, "ni_up_ratio")
    has_hist = rev_up.notna() & (_col(df, "hist_years") >= MIN_CHANGES)
    multi_year = (
        (_col(df, "rev_changes") >= MIN_CHANGES)                # a revenue record exists
        & (_col(df, "ni_pos_ratio") >= STRONG_MIN_PROFITABLE_YEARS)
        & (_col(df, "rev_cagr") > 0) & (rev_up >= STRONG_MIN_REV_UP_YEARS)
        & (_col(df, "ni_cagr") > 0) & (ni_up >= STRONG_MIN_NI_UP_YEARS)
        & (_col(df, "rev_vol").fillna(0) <= STRONG_MAX_REV_VOL)   # not boom-bust
        & (rev.fillna(0) >= STRONG_MIN_LATEST_REV)                # not shrinking now
        & ~(earn > GROWTH_WINSOR[1])                              # P/E not flattered by a one-off
    )
    df["fundamentally_strong"] = (
        (pe > 0)                                            # profitable now
        & one_year.where(~has_hist, multi_year)
        # "Growth at least median vs peers": for a stock with a record, speed and
        # steadiness count equally (metrics' growth_score_eff), so a steady +10%
        # grower isn't failed for ranking below a jumpier +25% one (Rollins, S&P
        # Global, Jack Henry were, on speed alone). Others: speed, as before.
        & (_col(df, "growth_score").where(_col(df, "consistency_score").isna(),
                                          _col(df, "growth_score_eff"))
           >= STRONG_MIN_GROWTH_SCORE)
        & ~df["overvalued"].fillna(False).astype(bool)
        & (cov.fillna(1.0) >= STRONG_MIN_COVERAGE)          # stocks carry growth_cov = 1.0
    )
    df["steady_compounder"] = (
        has_hist & (rev_up >= STEADY_MIN_UP_YEARS) & (ni_up >= STEADY_MIN_UP_YEARS)
        & (_col(df, "ni_pos_ratio") >= 1.0)
        & (_col(df, "rev_vol") <= STEADY_MAX_REV_VOL) & (_col(df, "ni_vol") <= STEADY_MAX_NI_VOL)
        & (_col(df, "rev_cagr") >= STEADY_MIN_CAGR) & (_col(df, "ni_cagr") >= STEADY_MIN_CAGR)
    )

    eligible = df["fundamentally_strong"] & df["data_sane"]
    disc = df["discount_long"]
    df["on_sale"] = eligible & (disc <= ON_SALE_DISCOUNT)
    df["deep_value_intact"] = df["on_sale"] & (disc <= DEEP_DISCOUNT) \
        & (_col(df, "value_score") >= DEEP_VALUE_MIN_SCORE)
    df["turning_up"] = df["on_sale"] & (_col(df, "ret_1m") > 0) \
        & (_col(df, "pct_52w_range") >= TURNING_UP_MIN_RANGE)
    df["steady_on_sale"] = df["on_sale"] & df["steady_compounder"]

    score = pd.Series(np.nan, index=df.index)
    sub = df[eligible & disc.notna()]
    if not sub.empty:
        score.loc[sub.index] = sub.groupby("kind")["discount_long"].transform(
            lambda s: (-s).rank(pct=True) * 100.0)
    df["on_sale_score"] = score.round(1)

    df["strategies"] = [[k for k in STRATEGIES if bool(r[k])]
                        for _, r in df[list(STRATEGIES)].iterrows()]
    return df
