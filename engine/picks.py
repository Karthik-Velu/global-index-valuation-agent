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

import pandas as pd

from .strategies import STRATEGIES

N_MARKETS = 3
N_STOCKS = 5
N_ON_SALE = 8
PICK_MIN_MARKET_CAP = 2e9
HIGH_PE = 35.0   # above this, "cheap" can't be about earnings

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


def _reasons(r: dict, is_market: bool) -> tuple[list[str], list[str]]:
    """(reasons, cautions) for one row, each a short plain-English line."""
    reasons, cautions = [], []
    pe, val = _f(r.get("pe")), _f(r.get("value_score"))
    rev, earn, fwd = _f(r.get("rev_growth")), _f(r.get("earnings_growth")), _f(r.get("fwd_growth"))
    disc, ret12 = _f(r.get("discount_52w")), _f(r.get("ret_12m"))
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
        reasons.append(f"On sale: {_pct(disc, signed=False)} below its 52-week average")
    elif disc is not None and disc >= 0.10:
        reasons.append(f"Trading {_pct(disc, signed=False)} above its 52-week average")

    dy = _f(r.get("dividend_yield"))
    if dy is not None and dy >= 0.025:
        reasons.append(f"Dividend yield {dy:.1%}")

    if fwd is not None and fwd < 0:
        cautions.append(f"Analysts expect earnings to fall {_pct(fwd, signed=False)}")
    if earn is not None and earn > 1.5:
        cautions.append(f"Earnings jump of {_pct(earn)} may be one-off — check it repeats")
    if is_market:
        cov = _f(r.get("growth_cov"))
        if cov is not None and cov < 0.5:
            cautions.append(f"Growth figures cover only {cov:.0%} of the fund's holdings")
    if ret12 is not None and ret12 <= -0.30:
        cautions.append(f"Down {_pct(ret12, signed=False)} in a year — know why before buying")
    elif r.get("value_trap"):
        cautions.append(f"Price still falling ({_pct(ret12)} over 12 months)")
    return reasons[:4], cautions[:2]


def _card(r: dict, is_market: bool) -> dict:
    reasons, cautions = _reasons(r, is_market)
    card = {
        "name": r.get("name"), "kind": r.get("kind"),
        "opportunity_score": _f(r.get("opportunity_score")),
        "value_score": _f(r.get("value_score")), "growth_score": _f(r.get("growth_score")),
        "pe": _f(r.get("pe")), "discount_52w": _f(r.get("discount_52w")),
        "ret_12m": _f(r.get("ret_12m")),
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
        bad = {t for t, checks in flagged.items() if checks & EXCLUDE_CHECKS}
        clean = ~stocks["ticker"].isin(bad) & _domestic(stocks)
        liquid = stocks["market_cap"].fillna(0) >= PICK_MIN_MARKET_CAP
        strong = _eligible(stocks)
        s = stocks[strong & clean & liquid].sort_values("opportunity_score", ascending=False)
        out["stocks"] = [_card(r, False) for r in s.head(N_STOCKS).to_dict("records")]
        sale = stocks[stocks["on_sale"].fillna(False).astype(bool) & clean & liquid] \
            .sort_values("opportunity_score", ascending=False)
        out["on_sale"]["stocks"] = [_card(r, False) for r in sale.head(N_ON_SALE).to_dict("records")]
        on_sale_all = stocks["on_sale"].fillna(False).astype(bool)
        out["excluded"] = {
            "strong_with_data_issues": int((strong & stocks["ticker"].isin(bad)).sum()),
            "foreign_listings": int((~_domestic(stocks)).sum()),
            "on_sale_with_data_issues": int((on_sale_all & ~clean).sum()),
            "non_usd_reporters": int((stocks.get("reporting_currency", pd.Series(dtype=object))
                                      .fillna("USD").str.upper() != "USD").sum()),
            "implausible_valuation": int((~stocks["data_sane"].fillna(True).astype(bool)).sum()),
        }

    out["method"] = (
        "Chosen by rule from the scores on this page, not by hand: fundamentally strong "
        "(profitable, revenue and earnings growing, growth at least median vs peers), "
        "plausible data, and not in the most expensive 20% — then ranked by opportunity "
        f"score. Stocks also need a market cap of at least ${PICK_MIN_MARKET_CAP / 1e9:.0f}B, "
        "US-dollar financial statements, a US domicile (foreign listings' share counts "
        "don't yet account for ADR ratios), and no open data-quality issue.")
    acc = accuracy or {}
    n, ic = acc.get("evaluations") or 0, _f(acc.get("avg_rank_ic"))
    out["evidence"] = (
        "Rule-based screens, not advice. " + (
            f"Live track record so far: {n} overlapping weekly batches, average rank "
            f"correlation {ic:+.2f} — not yet enough independent history to call it skill."
            if n and ic is not None else "No live track record yet."))
    return out
