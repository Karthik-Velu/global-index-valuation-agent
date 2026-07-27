"""Foreign-exchange reference rates — Frankfurter (ECB daily rates, free,
keyless, https://frankfurter.dev). Powers the dashboard's optional
display-currency conversion (Phase D, ADR-023): a pure UX convenience layer,
never an input to any score. Every ratio the product computes (P/E, P/B,
dividend yield %) is dimensionless; the only genuinely currency-denominated
fields the dashboard shows (Phase C's investability panel — stock price,
market_cap) are USD already, since the universe requires a US-listed ticker
(see universescan.py). So this fetches USD-per-unit rates for a fixed list of
major currencies and the CLIENT does the multiplication, for display only.

  python -m engine.sources.fx ingest
"""
from __future__ import annotations

import os

import requests

FRANKFURTER_BASE = os.getenv("FRANKFURTER_BASE", "https://api.frankfurter.dev/v1").rstrip("/")

# Offered in the dashboard's display-currency selector — major currencies a
# global user base would actually want, not the full ISO-4217 list.
CURRENCIES = ["EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "CNY", "HKD", "SGD",
              "INR", "KRW", "BRL", "MXN", "ZAR", "SEK", "NOK", "NZD"]


def fetch_latest(base: str = "USD") -> dict:
    """Latest ECB reference rates, base USD. {"date": iso, "base": "USD", "rates": {...}}."""
    r = requests.get(f"{FRANKFURTER_BASE}/latest",
                     params={"base": base, "symbols": ",".join(CURRENCIES)}, timeout=15)
    r.raise_for_status()
    data = r.json()
    return {"date": data["date"], "base": data["base"], "rates": data["rates"]}


def ingest() -> dict:
    """Fetch latest rates and upsert into fx_rates. Best-effort, never fatal —
    matches every other source adapter's degrade-gracefully contract: on
    failure the dashboard just keeps showing USD (no display-currency
    conversion), same as a market with no stock-level breakdown."""
    from .. import db

    stats: dict = {"rates": 0, "errors": []}
    try:
        snap = fetch_latest()
    except Exception as e:
        stats["errors"].append(str(e)[:200])
        return stats
    stats["date"] = snap["date"]

    if not db.have_db():
        stats["note"] = "DATABASE_URL not set — nothing persisted"
        return stats

    rows = [(snap["date"], ccy, rate) for ccy, rate in snap["rates"].items()]
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """insert into fx_rates (asof, currency, rate) values (%s,%s,%s)
               on conflict (asof, currency) do update set rate = excluded.rate""",
            rows)
        conn.commit()
    stats["rates"] = len(rows)
    return stats


def latest_from_db() -> dict | None:
    """Most recent stored snapshot, {"asof": iso, "base": "USD", "rates": {...}} —
    read back by pipeline.py to embed into dashboard_data.json. None if the
    table is empty or Postgres isn't configured (dashboard degrades to USD-only)."""
    from .. import db

    if not db.have_db():
        return None
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select max(asof) from fx_rates")
        row = cur.fetchone()
        asof = row[0] if row else None
        if not asof:
            return None
        cur.execute("select currency, rate from fx_rates where asof = %s", (asof,))
        rates = {ccy: rate for ccy, rate in cur.fetchall()}
    return {"asof": asof.isoformat() if hasattr(asof, "isoformat") else str(asof),
            "base": "USD", "rates": rates}


if __name__ == "__main__":
    import json
    print(json.dumps(ingest(), indent=2, default=str))
