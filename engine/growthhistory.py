"""Multi-year growth history — how steadily a company has grown, not just last year.

A deterministic job (no LLM). One year of revenue/earnings growth says little: it can
be a rebound from a bad year, a one-off gain, or a peak. This module rebuilds each
company's ANNUAL revenue and net-income series from EDGAR and measures, over up to the
last six fiscal years: how fast it grew (CAGR), how often it grew (up-years), whether
it stayed profitable, and how volatile the yearly growth was.

Why the series has to be rebuilt: EDGAR tags every fact in a 10-K with fiscal period
"FY", including the quarterly breakdowns many 10-Ks carry, and the store has no
period-start column to tell a 3-month value from a 12-month one. Taking "the latest two
FY rows" — what stockvaluation did — compared a year with a quarter for 177 companies on
2026-10-05 (Accenture, Allstate, Dominion…) and used a quarter as the annual figure for
36. Annual values are recovered here by anchoring on the fiscal year-end — the newest
period in the company's latest annual report (10-K/20-F/40-F), since a 10-K's quarterly
breakdown never runs past its own year-end — and stepping back one year at a time
(350-380 days, so 52/53-week years work). Size is only the fallback anchor, for a
company with no annual-form filing on record: a full year is ~4x a quarter, so the
year-spaced chain with the largest values is the annual one. (Size alone fails where a
10-K's "revenue" is a sub-line: SBAC reports $245M against ~$730M quarters.)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .config import GROWTH_WINSOR

WINDOW_YEARS = 6           # yearly changes measured (7 annual points). Six, not five:
                           # a five-year window now starts at the 2020 COVID trough
                           # and inflates every CAGR (Texas Roadhouse earnings read
                           # +67%/yr); from 2019 the dip is one down year instead.
MIN_CHANGES = 3            # fewer than this and the history isn't "multi-year"
_STEP = (350, 380)         # days between consecutive fiscal year-ends (52/53-week aware)
_RECENT_DAYS = 400         # an annual chain must end this close to the newest FY row
_ANNUAL_FORMS = ("10-K", "20-F", "40-F", "10-KT")   # and their /A amendments
_QUARTER_IN_ANNUAL = 0.45  # an annual revenue < 45% of its neighbours is a quarter that
                           # landed in the annual slot (same period_end, same filing)

_CODES = ("total_revenue", "net_income", "operating_cash_flow")
FEATURES = ["hist_years", "rev_changes", "ni_changes", "rev_cagr", "rev_up_ratio", "rev_vol", "ni_cagr",
            "ni_up_ratio", "ni_pos_ratio", "ni_vol", "rev_growth", "earnings_growth",
            "annual_period_end"]


def _chain_from(days: np.ndarray, end: int) -> list[int]:
    """Indices into `days` (sorted ascending) stepping back one fiscal year at a time
    from index `end`; stops at the first missing year."""
    chain, cur = [end], end
    while True:
        lo, hi = days[cur] - _STEP[1], days[cur] - _STEP[0]
        cand = np.where((days >= lo) & (days <= hi))[0]
        if not len(cand):
            break
        cur = cand[np.argmin(np.abs(days[cand] - (days[cur] - 365)))]
        chain.append(cur)
    return chain[::-1]


def _annual_dates(anchor: pd.Series, fye=None) -> list:
    """period_ends of the annual chain for one company. `fye` (the fiscal year-end
    from its latest annual report) anchors it when known; otherwise the year-spaced
    chain with the largest `anchor` values (revenue, or |net income|) wins."""
    anchor = anchor.dropna()
    if anchor.empty:
        return []
    dates = anchor.index.values
    days = dates.astype("datetime64[D]").astype(np.int64)
    if fye is not None:
        hit = np.where(dates == np.datetime64(fye, "ns"))[0]
        if len(hit):
            return list(dates[_chain_from(days, int(hit[0]))])
    best, best_key = None, None
    for end in np.where(days >= days[-1] - _RECENT_DAYS)[0]:
        ch = _chain_from(days, int(end))
        key = (float(np.median(anchor.values[ch][-4:])), len(ch))  # biggest = full years
        if best_key is None or key > best_key:
            best, best_key = ch, key
    return list(dates[best])


def _fiscal_year_ends(f: pd.DataFrame) -> pd.Series:
    """security_id -> newest period_end in its latest annual-form filing."""
    form = f["report_type"].fillna("").str.replace("/A", "", regex=False)
    a = f[form.isin(_ANNUAL_FORMS)]
    if a.empty:
        return pd.Series(dtype="datetime64[ns]")
    latest = a.groupby("security_id")["filed_date"].transform("max")
    return a[a["filed_date"] == latest].groupby("security_id")["period_end"].max()


def annual_series(flow: pd.DataFrame) -> pd.DataFrame:
    """Clean annual (security_id, period_end, revenue, net income, operating cash
    flow) from FY flow rows as returned by tierb.metrics_asof. Latest vintage wins
    per period_end. The year-end comes from the latest annual report (see module
    doc); the size fallback anchors on revenue, or |net income| when a company
    reports no revenue line (some banks)."""
    cols = ["security_id", "period_end", *_CODES]
    f = flow[flow["metric_code"].isin(_CODES) & (flow["fiscal_period"] == "FY")]
    if f.empty:
        return pd.DataFrame(columns=cols)
    f = (f.sort_values(["security_id", "metric_code", "period_end", "filed_date"])
          .drop_duplicates(["security_id", "metric_code", "period_end"], keep="last"))
    wide = f.pivot_table(index=["security_id", "period_end"], columns="metric_code",
                         values="value", aggfunc="last")
    for c in _CODES:
        if c not in wide:
            wide[c] = np.nan
    wide = wide[list(_CODES)].sort_index()

    # Size anchor, vectorised: revenue where a company has >= 2 positive years,
    # else |net income|; any metric's date can carry the year-end.
    sid = wide.index.get_level_values(0)
    rev = wide["total_revenue"].where(wide["total_revenue"] > 0)
    use_rev = rev.notna().groupby(sid).transform("sum") >= 2
    anchor = rev.where(use_rev, wide["net_income"].abs()).fillna(wide.abs().max(axis=1))

    fyes = _fiscal_year_ends(f)
    keep = np.zeros(len(wide), dtype=bool)
    dates_all = wide.index.get_level_values(1).values
    a_vals = anchor.to_numpy()
    bounds = np.flatnonzero(np.r_[True, sid.values[1:] != sid.values[:-1], True])
    for lo, hi in zip(bounds[:-1], bounds[1:]):
        s_id = sid.values[lo]
        g = pd.Series(a_vals[lo:hi], index=dates_all[lo:hi])
        picked = _annual_dates(g, fyes.get(s_id))
        if picked:
            keep[lo:hi] = np.isin(dates_all[lo:hi], np.array(picked, dtype=dates_all.dtype))
    a = wide[keep].copy()
    if a.empty:
        return pd.DataFrame(columns=cols)

    # A quarter that overwrote the annual value (identical key) shows up as a
    # revenue far below BOTH neighbours (the newest year: below the prior one). Not
    # the larger neighbour — that nulls real collapses next to a spike (Las Vegas
    # Sands 2020, Blackstone 2022 after its 2021 performance-fee year).
    r = a["total_revenue"]
    g_id = a.index.get_level_values(0)
    newer = r.groupby(g_id).shift(-1)
    nb = pd.concat([r.groupby(g_id).shift(1), newer], axis=1).min(axis=1)
    bad = (r > 0) & (nb > 0) & (r < _QUARTER_IN_ANNUAL * nb)
    # Two short periods in a row defeat the both-neighbours test. A fiscal-year change
    # leaves exactly that: H&R Block's chain runs ..., $291M (a quarter), $466M (the
    # May-June 2021 transition), $3,463M, ... — so also flag a year far below BOTH the
    # next year and the company's typical recent year. Real hyper-growth isn't caught:
    # NVIDIA's pre-doubling year sits at its median.
    typical = r.groupby(g_id).transform(lambda v: v.tail(WINDOW_YEARS + 1).median())
    bad |= (r > 0) & (r < _QUARTER_IN_ANNUAL * newer) & (r < _QUARTER_IN_ANNUAL * typical)
    a.loc[bad, list(_CODES)] = np.nan
    return a.reset_index()[cols]


def _cagr(vals: np.ndarray, yrs: np.ndarray) -> float:
    """Compound growth from the first POSITIVE value to the latest one, over at least
    two years — so one early loss year doesn't blank the trend. The end point must be
    the latest year (or the one before): a trend that stops in 2022 is not "now"
    (ONE Gas has no revenue on file after 2022). `yrs` = years before the newest
    annual point."""
    ok = np.flatnonzero(~np.isnan(vals))
    pos = np.flatnonzero(~np.isnan(vals) & (vals > 0))
    if not len(ok) or not len(pos):
        return np.nan
    i, j = pos[0], ok[-1]
    span = yrs[i] - yrs[j]
    if j <= i or span < 1.9 or yrs[j] > 1.1 or not vals[j] > 0:
        return np.nan
    return (vals[j] / vals[i]) ** (1.0 / span) - 1.0


def features(annual: pd.DataFrame) -> pd.DataFrame:
    """Per-security growth-history features over the last WINDOW_YEARS changes."""
    rows = []
    lo, hi = GROWTH_WINSOR
    for sid, g in annual.groupby("security_id", sort=False):
        rows.append(_one(sid, g, lo, hi))
    return pd.DataFrame(rows, columns=["security_id"] + FEATURES)


def _one(sid, g: pd.DataFrame, lo: float, hi: float) -> dict:
    g = g.sort_values("period_end").tail(WINDOW_YEARS + 1)
    # Only the latest UNBROKEN run of years: a year with nothing on file (or nulled
    # as a quarter-in-annual-slot) breaks continuity, and what precedes it can be a
    # different reporting basis — H&R Block's 2020 entry is a 2-month transition
    # period after a fiscal-year change ($291M "revenue"), which made its growth
    # read +54%/yr instead of ~+3%.
    empty = (g["total_revenue"].isna() & g["net_income"].isna()).to_numpy()
    if empty.any():
        g = g.iloc[int(np.flatnonzero(empty)[-1]) + 1:]
    if g.empty:
        return {"security_id": sid}
    rev, ni = g["total_revenue"].to_numpy(float), g["net_income"].to_numpy(float)
    yrs = (g["period_end"].iloc[-1] - g["period_end"]).dt.days.to_numpy() / 365.25
    out = {"security_id": sid, "annual_period_end": g["period_end"].iloc[-1]}

    # Revenue: only the latest unbroken run of positive years. A zero or missing
    # revenue year for an operating company is a mapping gap, and what precedes it
    # is often a different line (GLPI: $103M, $110M, $0, $0, then $1.5B — which read
    # as +73%/yr).
    rv = ~np.isnan(rev) & (rev > 0)
    if rv.any():
        end = int(np.flatnonzero(rv)[-1])          # latest valid year (CAGR checks recency)
        gaps = np.flatnonzero(~rv[: end + 1])
        rv[: (gaps[-1] + 1) if len(gaps) else 0] = False
    ok = rv[1:] & rv[:-1]
    r_yoy = np.divide(rev[1:], rev[:-1], out=np.full(len(rev) - 1, np.nan), where=ok)[ok] - 1.0
    out["rev_growth"] = rev[-1] / rev[-2] - 1.0 if len(rev) > 1 and rv[-2:].all() else np.nan
    out["rev_cagr"] = _cagr(np.where(rv, rev, np.nan), yrs)
    out["rev_up_ratio"] = float((r_yoy > 0).mean()) if len(r_yoy) else np.nan
    out["rev_vol"] = float(np.std(np.clip(r_yoy, lo, hi))) if len(r_yoy) >= MIN_CHANGES else np.nan

    # Earnings: change scaled by |prior| (sign-safe), clipped like revenue so one
    # near-zero base year can't dominate the volatility.
    nv = ~np.isnan(ni)
    both = nv[1:] & nv[:-1] & (ni[:-1] != 0)
    n_yoy = np.divide(ni[1:] - ni[:-1], np.abs(ni[:-1]),
                      out=np.full(len(ni) - 1, np.nan), where=both)[both]
    out["earnings_growth"] = ((ni[-1] - ni[-2]) / abs(ni[-2])
                              if len(ni) > 1 and nv[-2:].all() and ni[-2] != 0 else np.nan)
    if nv.any():
        out["ni_pos_ratio"] = float((ni[nv] > 0).mean())
        out["ni_cagr"] = _cagr(ni, yrs)
    up = (ni[1:] > ni[:-1])[nv[1:] & nv[:-1]]
    out["ni_up_ratio"] = float(up.mean()) if len(up) else np.nan
    out["ni_vol"] = float(np.std(np.clip(n_yoy, -1.0, hi))) if len(n_yoy) >= MIN_CHANGES else np.nan
    out["rev_changes"], out["ni_changes"] = len(r_yoy), len(up)
    out["hist_years"] = int(max(len(r_yoy), len(up)))
    return out
