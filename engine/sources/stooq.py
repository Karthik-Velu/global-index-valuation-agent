"""Stooq adapter — free EOD prices, no key. A public-safe-ish alternative to Yahoo
for the PRICE need (license marked UNKNOWN until the agent verifies stooq's terms).
"""
from __future__ import annotations

import csv
import io
import time

import requests

from ..universe import BY_KEY
from .base import DataKind, License, Record, SampleResult, SourceAdapter

_QUOTE = "https://stooq.com/q/l/?s={sym}&f=sd2t2ohlcv&h&e=csv"


class StooqAdapter(SourceAdapter):
    id = "stooq"
    name = "Stooq EOD"
    provider = "Stooq"
    kinds = (DataKind.PRICE,)
    markets = "Global indices/ETFs/stocks (EOD); US ETFs as <sym>.us"
    license = License.UNKNOWN
    access_method = "rest_api"
    endpoint = "https://stooq.com"

    def _symbol(self, key: str) -> str | None:
        ix = BY_KEY.get(key)
        if not ix:
            return None
        return f"{ix.proxy.lower()}.us"   # US-listed ETF proxies

    def fetch_sample(self, kind: str, keys: list[str]) -> SampleResult:
        t0 = time.time()
        recs: list[Record] = []
        err = None
        for key in keys:
            sym = self._symbol(key)
            if not sym:
                continue
            try:
                r = requests.get(_QUOTE.format(sym=sym), timeout=12,
                                 headers={"User-Agent": "Mozilla/5.0"})
                if r.status_code != 200:
                    err = f"HTTP {r.status_code}"
                    continue
                row = next(csv.DictReader(io.StringIO(r.text)), None)
                if not row:
                    continue
                close = row.get("Close")
                if close in (None, "", "N/D"):
                    continue
                recs.append(Record(key=key, fields={"price": float(close)},
                                   asof=row.get("Date")))
            except Exception as e:
                err = str(e)[:160]
        return SampleResult(self.id, kind, recs, latency_ms=(time.time() - t0) * 1000,
                            error=err if not recs else None)
