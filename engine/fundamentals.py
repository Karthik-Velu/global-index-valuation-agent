"""Stock-level fundamentals retrieval — routed through the ingestion agent's choice.

Whichever source the data-ingestion agent has selected for the 'stock_fundamentals'
need (in the registry) is what gets used here. This is the seam that makes the
agent's source decisions actually change what the product fetches — i.e. it "updates
the data retrieval jobs". Falls back to any available source if none is chosen yet.
"""
from __future__ import annotations

from .sources import adapters


def fetch(tickers: list[str], need_id: str = "stock_fundamentals",
          default: str = "yahoo") -> dict:
    a = adapters.active_adapter(need_id, default=default)
    if a is None:
        return {"source": None, "records": [], "error": "no available source for fundamentals"}
    res = a.fetch_sample("fundamentals", tickers)
    return {
        "source": a.id, "license": a.license.value, "public_safe": a.public_safe(),
        "records": [{"key": r.key, **r.fields, "asof": r.asof} for r in res.records],
        "error": res.error,
    }
