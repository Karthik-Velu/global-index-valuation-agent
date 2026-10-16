"""Top picks — the "what to look at first, and why" block at the top of the dashboard.

Deterministic (a job, no LLM). Picks are chosen by rule from the same scores the rest of
the page shows, and every "why" line is assembled from the numbers — nothing is generated,
so a reason can never say something the data doesn't.

Selection:
  markets/funds  fundamentally strong + plausible data + not in the expensive cohort,
                 ranked by opportunity score (the model's main blend).
  stocks         the same, plus: US-dollar reporter (strategies.data_sane), US-domiciled
                 (see _domestic), market cap >= PICK_MIN_MARKET_CAP so the names are
                 liquid, and no open valuation-distorting data-quality issue
                 (EXCLUDE_CHECKS).
  on sale        everything flagged by strategies.on_sale that passes the same data
                 gates, ranked by opportunity score.

The evidence line is deliberately part of the payload: these are rule-based screens, and
the live track record is not yet enough independent history to call them skill.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from .config import LONG_AVG_YEARS
from .growthhistory import MIN_CHANGES
from .strategies import STRATEGIES

N_MARKETS = 3
N_STOCKS = 5
N_ON_SALE = 8
PICK_MIN_MARKET_CAP = 2e9
HIGH_PE = 35.0   # above this, "cheap" can't be about earnings
VOLATILE_NI = 0.6  # avg yearly earnings swing above this gets a caution (median ~0.65
                   # across all stocks, so this flags the noisier half, not outliers)

# Open quality issues that distort a company's valuation or growth figures. A pick built
# on one of these would be recommending a data error (690 tickers carry the first alone).
EXCLUDE_CHECKS = frozenset({
    "shares_multiclass_unsummed", "timeseries_jump", "negative_value",
    "missing_revenue", "missing_net_income", "no_fundamentals", "stale_filings",
})


def _f(v):
    try:
        v = float(v)
        return None if math.isnan(v) or math.isinf(v) else v
    except (TypeError, ValueError):
        return None


def _pct(v, signed=True):
    v = _f(v)
    if v is None:
        return "n/a"
    fmt = ".1%" if abs(v) < 0.05 else ".0%"   # "+0%" revenue growth reads as a lie
    return format(v, "+" + fmt) if signed else format(abs(v), fmt)


_PEERS = {"Country": "other countries", "Sector": "other sectors", "Region": "other regions",
          "Style": "other styles", "Broad": "other broad markets"}


def _avg_label(r: dict) -> str:
    """'5-year average price', or the window actually used when less history is on
    file ('2-year average price (5 years of prices not on file yet)')."""
    yrs = _f(r.get("long_avg_years"))
    if yrs is None or yrs >= LONG_AVG_YEARS - 0.25:
        return f"{LONG_AVG_YEARS}-year average price"
    return (f"{yrs:.0f}-year average price ({LONG_AVG_YEARS} years of prices not on file yet)"
            if abs(yrs - round(yrs)) < 0.15 else
            f"{yrs:.1f}-year average price ({LONG_AVG_YEARS} years of prices not on file yet)")


def _yrs(r: dict, which: str) -> int:
    return int(_f(r.get(f"{which}_changes")) or 0)


def _history(r: dict) -> str | None:
    """"Revenue up 6 of 6 years (+7%/yr), earnings up 4 of 6 (+13%/yr), profitable
    every year; last year +4% / +4%" — the multi-year record, None without one."""
    n_r, n_e = _yrs(r, "rev"), _yrs(r, "ni")
    if max(n_r, n_e) < MIN_CHANGES:
        return None
    bits = []
    up, cagr = _f(r.get("rev_up_ratio")), _f(r.get("rev_cagr"))
    if n_r and up is not None:
        bits.append(f"revenue up {round(up * n_r)} of {n_r} years"
                    + (f" ({_pct(cagr)}/yr)" if cagr is not None else ""))
    up, cagr = _f(r.get("ni_up_ratio")), _f(r.get("ni_cagr"))
    if n_e and up is not None:
        bits.append(f"earnings up {round(up * n_e)} of {n_e}"
                    + (f" ({_pct(cagr)}/yr)" if cagr is not None else ""))
    pos = _f(r.get("ni_pos_ratio"))
    if pos is not None and pos >= 1.0:
        bits.append("profitable every year")
    line = "Growth record: " + ", ".join(bits)
    rev, earn = _f(r.get("rev_growth")), _f(r.get("earnings_growth"))
    if rev is not None or earn is not None:
        line += f"; last year {_pct(rev)} / {_pct(earn)}"
    return line


def _reasons(r: dict, is_market: bool) -> tuple[list[str], list[str]]:
    """(reasons, cautions) for one row, each a short plain-English line."""
    reasons, cautions = [], []
    pe, val = _f(r.get("pe")), _f(r.get("value_score"))
    rev, earn, fwd = _f(r.get("rev_growth")), _f(r.get("earnings_growth")), _f(r.get("fwd_growth"))
    disc, ret12 = _f(r.get("discount_long")), _f(r.get("ret_12m"))
    avg = _avg_label(r)
    kind = r.get("kind") or ""
    peers = _PEERS.get(kind, "other markets") if is_market else f"{kind or 'sector'} peers"

    if val is not None and pe is not None:
        if val >= 66 and pe > HIGH_PE:
            # The value score blends five yields (config.VALUE_WEIGHTS); a name can
            # rank cheap on book/sales/cash flow while its P/E is high (Ares: 70).
            # "Cheap: P/E 70" would read as a contradiction — say where it's cheap.
            reasons.append(f"Cheap vs {peers} on book, sales and cash flow (value score "
                           f"{val:.0f}/100) — not on earnings: P/E {pe:.1f}")
        elif val >= 66:
            reasons.append(f"Cheap vs {peers}: P/E {pe:.1f}, value score {val:.0f}/100")
        elif val >= 40:
            reasons.append(f"Fairly priced: P/E {pe:.1f} (value score {val:.0f}/100)")
        else:
            reasons.append(f"Not cheap — P/E {pe:.1f} — the case rests on growth")

    hist = _history(r)
    if hist:
        reasons.append(hist)
    else:
        growth = []
        if rev is not None:
            growth.append(f"revenue {_pct(rev)}")
        if earn is not None:
            growth.append(f"earnings {_pct(earn)}")
        if growth:
            line = "Business growing: " + ", ".join(growth)
            if fwd is not None and fwd > 0:
                line += f"; analysts expect {_pct(fwd)}"
            reasons.append(line)

    if disc is not None and disc <= -0.10:
        reasons.append(f"On sale: {_pct(disc, signed=False)} below its {avg}")
    elif disc is not None and disc >= 0.10:
        reasons.append(f"Trading {_pct(disc, signed=False)} above its {avg}")

    dy = _f(r.get("dividend_yield"))
    if dy is not None and dy >= 0.025:
        reasons.append(f"Dividend yield {dy:.1%}")

    if fwd is not None and fwd < 0:
        cautions.append(f"Analysts expect earnings to fall {_pct(fwd, signed=False)}")
    ni_cagr, ni_vol = _f(r.get("ni_cagr")), _f(r.get("ni_vol"))
    if earn is not None and earn > 1.5:
        cautions.append(f"Earnings jump of {_pct(earn)} may be one-off — check it repeats")
    elif earn is not None and ni_cagr is not None and earn > 0.3 and earn - ni_cagr > 0.4:
        cautions.append(f"Last year's earnings ({_pct(earn)}) ran far ahead of the "
                        f"{_yrs(r, 'ni')}-year trend ({_pct(ni_cagr)}/yr) — may not repeat")
    if ni_vol is not None and ni_vol > VOLATILE_NI:
        cautions.append(f"Earnings are volatile: they move ~{ni_vol:.0%} a year on average")
    if not is_market and (_f(r.get("hist_years")) or 0) < MIN_CHANGES:
        cautions.append("Less than 3 years of reported history — growth record unproven")
    if rev is not None and rev < 0 and hist:
        cautions.append(f"Revenue dipped last year ({_pct(rev)})")
    if is_market:
        cov = _f(r.get("growth_cov"))
        if cov is not None and cov < 0.5:
            cautions.append(f"Growth figures cover only {cov:.0%} of the fund's holdings")
    if ret12 is not None and ret12 <= -0.30:
        cautions.append(f"Down {_pct(ret12, signed=False)} in a year — know why before buying")
    elif r.get("value_trap"):
        cautions.append(f"Price still falling ({_pct(ret12)} over 12 months)")
    return reasons[:4], cautions[:3]


def _card(r: dict, is_market: bool) -> dict:
    reasons, cautions = _reasons(r, is_market)
    card = {
        "name": r.get("name"), "kind": r.get("kind"),
        "opportunity_score": _f(r.get("opportunity_score")),
        "value_score": _f(r.get("value_score")), "growth_score": _f(r.get("growth_score")),
        "pe": _f(r.get("pe")), "discount_long": _f(r.get("discount_long")),
        "long_avg_years": _f(r.get("long_avg_years")),
        "ret_12m": _f(r.get("ret_12m")),
        "consistency_score": _f(r.get("consistency_score")),
        "rev_cagr": _f(r.get("rev_cagr")), "ni_cagr": _f(r.get("ni_cagr")),
        "strategies": [STRATEGIES[k]["label"] for k in (r.get("strategies") or []) if k in STRATEGIES],
        "reasons": reasons, "cautions": cautions,
    }
    if is_market:
        card.update(key=r.get("key"), symbol=r.get("symbol"), region=r.get("region"))
    else:
        card.update(ticker=r.get("ticker"), price=_f(r.get("price")),
                    market_cap=_f(r.get("market_cap")))
    return card


def _domestic(df: pd.DataFrame) -> pd.Series:
    """US-domiciled. A foreign company's EDGAR share count is in ORDINARY shares while
    its US price is per ADR, so market cap — and every ratio built on it — is off by
    the ADR ratio, which no source we ingest carries yet. Rentokil: 5 shares per ADR,
    so P/E 107 instead of ~21. Until ADR ratios are ingested, these can't be picks."""
    return df["country"].fillna("United States").eq("United States") if "country" in df \
        else pd.Series(True, index=df.index)


QUALITY_PREFIX = "quality:"


def exclusion_reasons(stocks: pd.DataFrame,
                      flagged: dict[str, set[str]] | None = None) -> pd.DataFrame:
    """Why each stock row is kept out of the picks — one boolean column per reason,
    same index as `stocks`. A row can carry several (every non-USD reporter is also
    "implausible" in data_sane terms, so the counts are NOT a partition).

      implausible_pe     0 < P/E < SANE_MIN_PE          } the three plausibility tests
      implausible_ps     P/S < SANE_MIN_PS              } inside strategies.data_sane,
      below_min_mcap     market cap < SANE_MIN_MARKET_CAP } tested positively (NaN passes)
      non_usd_reporter   reporting currency present and not USD (NULL passes)
      foreign_listing    not _domestic (a NULL country counts as US)
      short_history      hist_years < MIN_CHANGES (NaN counts as short)
      quality:<check>    an open data-quality issue in EXCLUDE_CHECKS for the ticker

    The ONE definition the picks and the screener's data_ok (engine/screenjobs.py)
    share, so a name the on-sale list hides is hidden by the screener too."""
    from .config import SANE_MIN_MARKET_CAP, SANE_MIN_PE, SANE_MIN_PS

    flagged = flagged or {}
    idx = stocks.index

    def num(c):
        return pd.to_numeric(stocks[c], errors="coerce") if c in stocks \
            else pd.Series(np.nan, index=idx, dtype=float)

    pe, ps, mcap = num("pe"), num("ps"), num("market_cap")
    ccy = stocks["reporting_currency"] if "reporting_currency" in stocks \
        else pd.Series(None, index=idx, dtype=object)
    out = pd.DataFrame(index=idx)
    out["implausible_pe"] = (pe > 0) & (pe < SANE_MIN_PE)
    out["implausible_ps"] = ps < SANE_MIN_PS
    out["below_min_mcap"] = mcap < SANE_MIN_MARKET_CAP
    out["non_usd_reporter"] = ccy.notna() & (ccy.astype(str).str.upper() != "USD")
    out["foreign_listing"] = ~_domestic(stocks)
    out["short_history"] = (num("hist_years").fillna(0) < MIN_CHANGES) if "hist_years" in stocks \
        else pd.Series(False, index=idx)
    tickers = stocks["ticker"] if "ticker" in stocks else pd.Series(None, index=idx, dtype=object)
    open_checks = tickers.map(lambda t: flagged.get(t) or set())
    for check in sorted(EXCLUDE_CHECKS):
        out[QUALITY_PREFIX + check] = open_checks.map(lambda s, c=check: c in s).astype(bool)
    return out.astype(bool)


def _eligible(df: pd.DataFrame) -> pd.Series:
    def col(c, default):
        return df[c].fillna(default).astype(bool) if c in df else pd.Series(default, index=df.index)
    return col("fundamentally_strong", False) & col("data_sane", True) & ~col("overvalued", False)


def build(markets: pd.DataFrame, stocks: pd.DataFrame | None = None,
          flagged: dict[str, set[str]] | None = None, accuracy: dict | None = None) -> dict:
    """`flagged` = {ticker: {open quality check names}}; `accuracy` = ledger summary."""
    flagged = flagged or {}
    out: dict = {"strategies": STRATEGIES, "markets": [], "stocks": [],
                 "on_sale": {"markets": [], "stocks": []}, "excluded": {}}

    if markets is not None and not markets.empty and "fundamentally_strong" in markets:
        m = markets[_eligible(markets)].sort_values("opportunity_score", ascending=False)
        out["markets"] = [_card(r, True) for r in m.head(N_MARKETS).to_dict("records")]
        # Ranked by the model's overall blend, not by depth of fall: sorting on the
        # discount alone put the most-crashed expensive names first (KRMN at P/E 260).
        sale = markets[markets["on_sale"].fillna(False).astype(bool)] \
            .sort_values("opportunity_score", ascending=False)
        out["on_sale"]["markets"] = [_card(r, True) for r in sale.head(N_ON_SALE).to_dict("records")]

    if stocks is not None and not stocks.empty and "fundamentally_strong" in stocks:
        why = exclusion_reasons(stocks, flagged)
        bad = why[[c for c in why.columns if c.startswith(QUALITY_PREFIX)]].any(axis=1)
        # A stock pick needs a verifiable record (>= MIN_CHANGES years of history) —
        # "fundamentally strong" on one year alone is exactly what ADR-035 replaced.
        record = ~why["short_history"]
        clean = ~bad & ~why["foreign_listing"] & record
        liquid = stocks["market_cap"].fillna(0) >= PICK_MIN_MARKET_CAP
        strong = _eligible(stocks)
        s = stocks[strong & clean & liquid].sort_values("opportunity_score", ascending=False)
        out["stocks"] = [_card(r, False) for r in s.head(N_STOCKS).to_dict("records")]
        sale = stocks[stocks["on_sale"].fillna(False).astype(bool) & clean & liquid] \
            .sort_values("opportunity_score", ascending=False)
        out["on_sale"]["stocks"] = [_card(r, False) for r in sale.head(N_ON_SALE).to_dict("records")]
        on_sale_all = stocks["on_sale"].fillna(False).astype(bool)
        out["excluded"] = {
            "strong_with_data_issues": int((strong & bad).sum()),
            "foreign_listings": int(why["foreign_listing"].sum()),
            "short_history": int((strong & ~record).sum()),
            "on_sale_with_data_issues": int((on_sale_all & ~clean).sum()),
            "non_usd_reporters": int(why["non_usd_reporter"].sum()),
            "implausible_valuation": int((~stocks["data_sane"].fillna(True).astype(bool)).sum()),
        }

    out["method"] = (
        "Chosen by rule from the scores on this page, not by hand: fundamentally strong "
        "(for stocks, a multi-year record over up to six years: profitable in at least "
        "80% of them, revenue and earnings up in at least 60% with positive growth rates and no "
        "boom-bust swings; growth at least median vs peers, counting how steady it was "
        "as much as how fast), "
        "plausible data, and not in the most expensive 20% — then ranked by opportunity "
        f"score. Stocks also need a market cap of at least ${PICK_MIN_MARKET_CAP / 1e9:.0f}B, "
        "US-dollar financial statements, a US domicile (foreign listings' share counts "
        "don't yet account for ADR ratios), at least 3 years of reported history, and no "
        "open data-quality issue.")
    acc = accuracy or {}
    n, ic = acc.get("evaluations") or 0, _f(acc.get("avg_rank_ic"))
    out["evidence"] = (
        "Rule-based screens, not advice. " + (
            f"Live track record so far: {n} overlapping weekly batches, average rank "
            f"correlation {ic:+.2f} — not yet enough independent history to call it skill."
            if n and ic is not None else "No live track record yet."))
    return out
