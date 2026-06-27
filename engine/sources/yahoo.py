"""Yahoo (yfinance) adapter — the current incumbent.

Marked PERSONAL_ONLY: Yahoo's ToS prohibits redistribution/commercial use, so the
agent will keep this for personal/dev use but prefer a public-safe source for any
need flagged public_only.
"""
from __future__ import annotations

import time

import numpy as np

from ..universe import BY_KEY
from .base import DataKind, License, Record, SampleResult, SourceAdapter


def _invert(v):
    try:
        v = float(v)
        return round(1.0 / v, 2) if v and v > 0 and np.isfinite(v) else None
    except Exception:
        return None


class YahooAdapter(SourceAdapter):
    id = "yahoo"
    name = "Yahoo Finance (yfinance)"
    provider = "Yahoo"
    kinds = (DataKind.PRICE, DataKind.INDEX_VALUATION, DataKind.FUNDAMENTALS)
    markets = "Global ETFs/indices + global stocks; broad"
    license = License.PERSONAL_ONLY
    access_method = "rest_api"
    endpoint = "https://query1.finance.yahoo.com"

    def fetch_sample(self, kind: str, keys: list[str]) -> SampleResult:
        import yfinance as yf
        # Stock-level fundamentals: `keys` are raw tickers, not index proxies.
        if kind == DataKind.FUNDAMENTALS.value:
            return self._fetch_fundamentals(keys)
        t0 = time.time()
        recs: list[Record] = []
        err = None
        for key in keys:
            ix = BY_KEY.get(key)
            if not ix:
                continue
            try:
                t = yf.Ticker(ix.proxy)
                fields, asof = {}, None
                hist = t.history(period="5d", interval="1d", auto_adjust=True)
                if hist is not None and not hist.empty:
                    fields["price"] = round(float(hist["Close"].iloc[-1]), 4)
                    asof = str(hist.index[-1].date())
                if kind == DataKind.INDEX_VALUATION.value:
                    eh = t.funds_data.equity_holdings
                    col = eh.columns[0]
                    fields["pe"] = _invert(eh.loc["Price/Earnings", col]) if "Price/Earnings" in eh.index else None
                    fields["pb"] = _invert(eh.loc["Price/Book", col]) if "Price/Book" in eh.index else None
                    fields["ps"] = _invert(eh.loc["Price/Sales", col]) if "Price/Sales" in eh.index else None
                    info = t.get_info()
                    dy = info.get("yield") or info.get("dividendYield")
                    if dy is not None:
                        dy = float(dy)
                        fields["dividend_yield"] = round(dy / 100 if dy > 1 else dy, 4)
                if fields:
                    recs.append(Record(key=key, fields=fields, asof=asof))
            except Exception as e:  # one bad ticker shouldn't fail the sample
                err = str(e)[:160]
        return SampleResult(self.id, kind, recs, latency_ms=(time.time() - t0) * 1000,
                            error=err if not recs else None)

    def _fetch_fundamentals(self, tickers: list[str]) -> SampleResult:
        import yfinance as yf
        t0 = time.time()
        recs, err = [], None
        for tk in tickers:
            try:
                info = yf.Ticker(tk).get_info()
                fields = {
                    "pe": info.get("trailingPE"),
                    "pb": info.get("priceToBook"),
                    "rev_growth": info.get("revenueGrowth"),
                    "earnings_growth": info.get("earningsGrowth"),
                }
                if any(v is not None for v in fields.values()):
                    recs.append(Record(key=tk, fields=fields))
            except Exception as e:
                err = str(e)[:160]
        return SampleResult(self.id, DataKind.FUNDAMENTALS.value, recs,
                            latency_ms=(time.time() - t0) * 1000, error=err if not recs else None)
