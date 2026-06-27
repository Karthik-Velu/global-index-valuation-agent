"""SimFin adapter — license-clean (redistribution_ok) stock-level fundamentals.

SimFin v3 REST: https://backend.simfin.com/api/v3/companies/statements/compact
auth via an `api-key` param; free key from simfin.com (free tier is US-heavy).

We pull the income statement (PL) for recent fiscal years and derive the growth
signals the product's GARP scoring uses (revenue + earnings growth). P/E and P/B are
left to price-bearing sources. The parser is defensive across SimFin's column shapes;
the ingestion agent's own probe validates it once a key is present.
"""
from __future__ import annotations

import time

import requests

from .base import DataKind, License, Record, SampleResult, SourceAdapter

_URL = "https://backend.simfin.com/api/v3/companies/statements/compact"


def _find(cols: list[str], *needles) -> int | None:
    low = [str(c).lower() for c in cols]
    for i, c in enumerate(low):
        if all(n in c for n in needles):
            return i
    return None


def _growth(series: list[float]) -> float | None:
    vals = [v for v in series if isinstance(v, (int, float))]
    if len(vals) < 2 or not vals[-2]:
        return None
    try:
        return round(vals[-1] / abs(vals[-2]) - 1.0, 4)
    except Exception:
        return None


class SimFinAdapter(SourceAdapter):
    id = "simfin"
    name = "SimFin v3 (fundamentals)"
    provider = "SimFin"
    kinds = (DataKind.FUNDAMENTALS,)
    markets = "US-heavy free tier; broader on paid. Standardized financials."
    license = License.REDISTRIBUTION_OK
    access_method = "rest_api"
    endpoint = "https://backend.simfin.com/api/v3"
    requires_key_env = "SIMFIN_API_KEY"

    def fetch_sample(self, kind: str, keys: list[str]) -> SampleResult:
        import os
        t0 = time.time()
        key = os.getenv(self.requires_key_env, "")
        if not key:
            return SampleResult(self.id, kind, [], error="no SIMFIN_API_KEY")
        recs: list[Record] = []
        err = None
        rate = False
        for ticker in keys:
            try:
                r = requests.get(_URL, timeout=15, params={
                    "ticker": ticker, "statements": "PL", "period": "fy",
                    "start": "2021-01-01", "api-key": key,
                })
                if r.status_code == 429:
                    rate = True
                    continue
                if r.status_code != 200:
                    err = f"HTTP {r.status_code}"
                    continue
                payload = r.json()
                comp = payload[0] if isinstance(payload, list) and payload else payload
                stmts = comp.get("statements") if isinstance(comp, dict) else None
                pl = next((s for s in (stmts or []) if str(s.get("statement", "")).upper() in ("PL", "PROFIT_LOSS")), None)
                if not pl:
                    continue
                cols = pl.get("columns", [])
                rows = pl.get("data", [])
                ri = _find(cols, "revenue")
                ni = _find(cols, "net", "income")
                yi = _find(cols, "fiscal", "year") or _find(cols, "fyear")
                if ri is None or not rows:
                    continue
                rows = sorted(rows, key=lambda x: x[yi]) if yi is not None else rows
                rev = _growth([row[ri] for row in rows])
                earn = _growth([row[ni] for row in rows]) if ni is not None else None
                asof = str(rows[-1][yi]) if yi is not None else None
                fields = {"rev_growth": rev, "earnings_growth": earn}
                if any(v is not None for v in fields.values()):
                    recs.append(Record(key=ticker, fields=fields, asof=asof))
            except Exception as e:
                err = str(e)[:160]
        return SampleResult(self.id, kind, recs, latency_ms=(time.time() - t0) * 1000,
                            error=err if not recs else None, rate_limited=rate)
