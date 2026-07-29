"""Stock-level valuation — the bottom-up counterpart to `engine/metrics.py`.

Prepares one row per security (point-in-time fundamentals from Tier B +
point-in-time prices from Tier B) in exactly the schema `engine.metrics.compute()`
expects, then hands off to that SAME scoring function — value/growth/momentum/
mean-reversion/opportunity/GARP math is defined ONCE and shared by index-level and
stock-level scoring. Peer group ("kind") is sector, so a stock's cheapness is judged
against its own sector, not the whole market.

Point-in-time discipline: fundamentals come from `tierb.metrics_asof(asof, ...)` —
only vintages FILED on or before `asof` — and prices are read only up to `asof`.
This is what lets the SAME function serve both "today's live scoreboard" and the
walk-forward backtest (engine/backtest.py), which calls it once per historical
rebalance date with no look-ahead.

Known v1 simplifications (documented, not silent):
  * Valuation multiples use the latest ANNUAL (FY) revenue/net_income/operating
    cash flow as of `asof` — not a trailing-twelve-month roll of quarters. Can be
    up to ~12 months stale relative to price for calendar-quarter reporters.
  * dividend_yield is trailing-12-month dividends-per-share (from the `dividends`
    table, engine/sources/corpactions.py — Massive reference data, point-in-time
    on ex_dividend_date) divided by price; 0.0 for stocks with no dividend rows
    in the window, which is a real value (non-payer), not a placeholder.
  * No forward (analyst-estimate) growth — fwd_growth is NaN; growth_raw is
    trailing YoY revenue/earnings only.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from . import metrics, tierb

# Point-in-time FLOW metrics (income-statement / cash-flow — a period total, must
# stay FY-only or a raw quarterly figure would badly understate a P/E-style ratio).
FLOW_CODES = ("total_revenue", "net_income", "operating_cash_flow")
# Point-in-time INSTANT metrics (balance-sheet / share-count snapshots — freshest
# available value is correct regardless of which filing reported it).
INSTANT_CODES = ("total_equity", "shares_outstanding")
ALL_CODES = FLOW_CODES + INSTANT_CODES

# shares_outstanding is the one INSTANT metric where "freshest wins" isn't enough:
# EDGAR reports it under three different XBRL concepts (see metric_catalog.json),
# and it's common for two of them to land on the exact same period_end (e.g. a
# 10-K cover-page date matching the fiscal year end) — so a tie on date alone
# leaves the choice to whichever row happened to be inserted last, an accident of
# ingest ordering, not a deliberate one. That silently corrupted market_cap/P/E
# for CMCSA (found 2026-07-27, JOURNAL) and turned out to be widespread — the
# shares_concept_disagreement quality check fired on ~42% of ingested securities
# the next two daily runs (JOURNAL 2026-07-29). Break same-date ties using the
# catalog's own documented preference instead of insertion order.
_SHARES_TAG_PRIORITY = {
    "dei:EntityCommonStockSharesOutstanding": 0,   # catalog: "cleanest for current market cap"
    "us-gaap:CommonStockSharesOutstanding": 1,
    "us-gaap:CommonStockSharesIssued": 2,
}


def _resolve_shares_concept(df: pd.DataFrame) -> pd.DataFrame:
    """Collapse multiple XBRL concepts reporting shares_outstanding for the same
    (security_id, period_end) down to one row, by catalog-documented preference.
    Leaves every other metric_code (incl. total_equity) untouched. This does NOT
    fix true multi-class summing (e.g. Class A + Class B counted separately under
    the SAME concept) — that needs per-class dimensional data this table doesn't
    carry; still open, tracked in the shares_concept_disagreement lesson."""
    is_shares = df["metric_code"] == "shares_outstanding"
    if not is_shares.any():
        return df
    shares = df[is_shares].copy()
    shares["_pri"] = shares["raw_tag"].map(_SHARES_TAG_PRIORITY).fillna(99)
    shares = (shares.sort_values(["security_id", "period_end", "_pri"])
                    .drop_duplicates(["security_id", "period_end"], keep="first")
                    .drop(columns="_pri"))
    return pd.concat([df[~is_shares], shares], ignore_index=True)


def _nth_per_security(df: pd.DataFrame, n: int) -> pd.DataFrame:
    """Pivot to security_id x metric_code, taking the nth-most-recent period_end
    per (security_id, metric_code) — n=0 latest, n=1 one period back (for YoY)."""
    if df.empty:
        return pd.DataFrame()
    sub = df.sort_values(["security_id", "metric_code", "period_end"])
    grouped = sub.groupby(["security_id", "metric_code"], sort=False)
    picked = grouped.tail(1) if n == 0 else grouped.nth(-1 - n)
    if picked.empty:
        return pd.DataFrame()
    return picked.pivot(index="security_id", columns="metric_code", values="value")


def _fundamentals_frame(asof, security_ids: list[int]) -> pd.DataFrame:
    """One row per security_id: latest pe/pb/ps/pcf inputs + trailing YoY growth,
    all knowable as of `asof` (tierb.metrics_asof — no look-ahead)."""
    empty_cols = ["security_id"] + list(ALL_CODES) + ["rev_growth", "earnings_growth"]
    rows = tierb.metrics_asof(asof, metric_codes=list(ALL_CODES),
                              security_ids=security_ids, source="xbrl")
    if not rows:
        return pd.DataFrame(columns=empty_cols)
    fm = pd.DataFrame(rows, columns=tierb.FM_COLUMNS)
    fm["period_end"] = pd.to_datetime(fm["period_end"])
    fm["value"] = pd.to_numeric(fm["value"], errors="coerce")

    flow = fm[fm["metric_code"].isin(FLOW_CODES) & (fm["fiscal_period"] == "FY")]
    instant = _resolve_shares_concept(fm[fm["metric_code"].isin(INSTANT_CODES)])
    latest_flow, prior_flow = _nth_per_security(flow, 0), _nth_per_security(flow, 1)
    latest_instant = _nth_per_security(instant, 0)
    if latest_flow.empty and latest_instant.empty:
        return pd.DataFrame(columns=empty_cols)

    idx = pd.Index(sorted(set(latest_flow.index) | set(latest_instant.index)), name="security_id")
    out = pd.DataFrame(index=idx)
    for c in ALL_CODES:
        src = latest_flow if c in FLOW_CODES else latest_instant
        out[c] = src[c].reindex(idx) if c in src.columns else np.nan

    def _yoy(code):
        if code not in latest_flow.columns or code not in prior_flow.columns:
            return pd.Series(np.nan, index=idx)
        latest_v, prior_v = latest_flow[code].reindex(idx), prior_flow[code].reindex(idx)
        return (latest_v / prior_v.abs() - 1.0).where(prior_v.notna() & (prior_v != 0))

    out["rev_growth"] = _yoy("total_revenue")
    out["earnings_growth"] = _yoy("net_income")
    return out.reset_index()


def _price_features(asof, security_ids: list[int], lookback_days: int = 400) -> pd.DataFrame:
    """One row per security_id: latest close as of `asof` + momentum/mean-reversion
    inputs from the trailing `lookback_days` of Tier B prices (date <= asof only)."""
    cols = ["security_id", "price", "ret_3m", "ret_6m", "ret_12m",
            "ma200_ratio", "pct_52w_range", "drawdown_52w"]
    if not security_ids or not tierb.have_prices():
        return pd.DataFrame(columns=cols)
    con = tierb.connect()
    df = con.execute(
        "select security_id, date, close from prices "
        "where date <= ? and date >= ?::date - to_days(?) "
        "and security_id in (select unnest(?::bigint[])) order by security_id, date",
        [asof, asof, lookback_days, security_ids]).df()
    if df.empty:
        return pd.DataFrame(columns=cols)
    df["date"] = pd.to_datetime(df["date"])

    def _ret_at(g: pd.DataFrame, price: float, last_date, calendar_days: int):
        prior = g[g["date"] <= last_date - pd.Timedelta(days=calendar_days)]
        return (price / prior["close"].iloc[-1] - 1.0) if not prior.empty else np.nan

    out = []
    for sid, g in df.groupby("security_id", sort=False):
        price = float(g["close"].iloc[-1])
        last_date = g["date"].iloc[-1]
        window = g.tail(260)  # ~1 trading year if fully populated
        hi, lo = float(window["close"].max()), float(window["close"].min())
        ma200 = g["close"].tail(200).mean()
        out.append({
            "security_id": sid, "price": price,
            "ret_3m": _ret_at(g, price, last_date, 91),
            "ret_6m": _ret_at(g, price, last_date, 182),
            "ret_12m": _ret_at(g, price, last_date, 365),
            "ma200_ratio": (price / ma200 - 1.0) if ma200 else np.nan,
            "pct_52w_range": (price - lo) / (hi - lo) if hi > lo else 0.5,
            "drawdown_52w": (price / hi - 1.0) if hi else np.nan,
        })
    return pd.DataFrame(out, columns=cols)


def _dividend_features(asof, security_ids: list[int]) -> pd.DataFrame:
    """security_id -> trailing-12-month dividends-per-share as of `asof` (sum of
    cash_amount for ex-dividend dates in (asof - 365d, asof]) — point-in-time,
    same discipline as fundamentals/prices: an ex-date after `asof` is invisible."""
    from . import db

    cols = ["security_id", "ttm_dps"]
    if not security_ids or not db.have_db():
        return pd.DataFrame(columns=cols)
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            "select security_id, sum(cash_amount) from dividends "
            "where ex_dividend_date <= %s and ex_dividend_date > %s::date - interval '365 days' "
            "and security_id = any(%s) group by security_id",
            (asof, asof, security_ids))
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)


def _universe(security_ids: list[int] | None) -> pd.DataFrame:
    """(security_id, ticker, name, sector, country, currency) for the stock
    universe. `currency` isn't populated at ingest time (edgar.py never sets
    it — every tracked security is US-ticker-listed, see universescan.py), so
    it's coalesced to 'USD' here rather than left null: our prices (Massive
    grouped-daily) are USD-denominated, so that default reflects reality
    rather than papering over a gap."""
    from . import db

    q = ("select id, ticker, name, sector, country, coalesce(currency, 'USD') "
         "from securities where kind='stock'")
    params: list = []
    if security_ids:
        q += " and id in (select unnest(%s::bigint[]))"
        params.append(security_ids)
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(q, params)
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=["security_id", "ticker", "name", "sector", "country", "currency"])


def market_breakdown(asof, market_holdings: dict[str, list[tuple[str, float]]],
                     top_n: int = 5) -> dict[str, list[dict]]:
    """Phase C — bottom-up: for each index-level market, which of its actual
    holdings are we tracking at stock level (EDGAR-ingested), and how do THOSE
    stocks score. `market_holdings` = {market_key: [(ticker, weight), ...]} —
    the same (symbol, weight) top-holdings datasource.py already fetches for the
    index-level growth calc, reused here rather than a second data pull.

    One score_frame() call across every matched ticker (not one call per
    market) — the same universe-wide-then-slice pattern the backtest already
    uses, so this stays cheap even across ~150 markets.

    A market absent from the result simply has no stock-level breakdown this
    run (no matched holdings, or none scored) — the dashboard treats that as
    "nothing to show here" and degrades gracefully, same as every other
    optional field in the payload."""
    all_tickers = {t for holdings in market_holdings.values() for t, _w in (holdings or [])}
    if not all_tickers:
        return {}
    uni = _universe(None)
    if uni.empty:
        return {}
    ticker_to_sid = dict(zip(uni["ticker"], uni["security_id"]))
    matched_ids = [ticker_to_sid[t] for t in all_tickers if t in ticker_to_sid]
    if not matched_ids:
        return {}

    scored = score_frame(asof, security_ids=matched_ids)
    if scored.empty:
        return {}
    # drop=False: "ticker" must survive as a column too, not just become the
    # index key — set_index(drop=True) silently drops it from each row's dict,
    # which previously left every output row's "ticker" field None.
    by_ticker = scored.set_index("ticker", drop=False).to_dict(orient="index")

    out: dict[str, list[dict]] = {}
    for mkey, holdings in market_holdings.items():
        rows = [by_ticker[t] for t, _w in (holdings or []) if t in by_ticker]
        if not rows:
            continue
        rows.sort(key=lambda r: r.get("opportunity_score") if r.get("opportunity_score") is not None else -1,
                  reverse=True)
        out[mkey] = [{
            "ticker": r.get("ticker"), "name": r.get("name"), "sector": r.get("sector"),
            "opportunity_score": r.get("opportunity_score"), "value_score": r.get("value_score"),
            "growth_score": r.get("growth_score"), "pe": r.get("pe"),
            "garp": bool(r.get("garp")), "value_trap": bool(r.get("value_trap")),
            "overvalued": bool(r.get("overvalued")),
            # Investability panel (Phase D, ADR-024) — "can I actually buy this,
            # and what does it cost": the only genuinely currency-denominated
            # fields in the whole product, USD-native (see _universe()).
            "price": r.get("price"), "market_cap": r.get("market_cap"),
            "currency": r.get("currency"), "country": r.get("country"),
        } for r in rows[:top_n]]
    return out


def score_frame(asof, security_ids: list[int] | None = None) -> pd.DataFrame:
    """The bottom-up scoreboard as of `asof` — one row per stock, scored with the
    SAME value/growth/momentum/opportunity math as the index-level product,
    peer-grouped by sector. Point-in-time throughout: safe to call for today or
    for any past rebalance date (the walk-forward backtest does exactly that)."""
    uni = _universe(security_ids)
    if uni.empty:
        return uni
    ids = uni["security_id"].tolist()

    fund = _fundamentals_frame(asof, ids)
    price = _price_features(asof, ids)
    div = _dividend_features(asof, ids)

    df = uni.merge(fund, on="security_id", how="left").merge(price, on="security_id", how="left")
    df = df.merge(div, on="security_id", how="left")

    df["market_cap"] = df["price"] * df["shares_outstanding"]
    df["pe"] = (df["market_cap"] / df["net_income"]).where(df["net_income"] > 0)
    df["pb"] = (df["market_cap"] / df["total_equity"]).where(df["total_equity"] > 0)
    df["ps"] = (df["market_cap"] / df["total_revenue"]).where(df["total_revenue"] > 0)
    df["pcf"] = (df["market_cap"] / df["operating_cash_flow"]).where(df["operating_cash_flow"] > 0)
    df["dividend_yield"] = (df["ttm_dps"] / df["price"]).where(df["price"] > 0).fillna(0.0)
    df = df.drop(columns=["ttm_dps"])
    df["fwd_growth"] = np.nan    # no analyst-estimate source at stock level yet
    df["growth_cov"] = 1.0

    # Peer group for cross-sectional ranking: sector, falling back to a single
    # bucket for anything unclassified (same graceful-degradation spirit as the
    # index-level "neutral 50" fill for markets with no growth data).
    df["kind"] = df["sector"].fillna("Unclassified").replace("", "Unclassified")
    df["key"] = df["ticker"]
    df["symbol"] = df["ticker"]

    return metrics.compute(df)


if __name__ == "__main__":
    import json
    from datetime import date

    out = score_frame(date.today().isoformat())
    print(f"scored {len(out)} stocks as of {date.today().isoformat()}")
    if not out.empty:
        cols = ["symbol", "kind", "opportunity_score", "value_score", "growth_score", "garp"]
        print(out[cols].head(20).to_string(index=False))
