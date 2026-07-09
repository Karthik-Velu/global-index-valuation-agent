"""Stooq — free, keyless EOD prices for US-listed securities.

Every security in our stock universe trades under a US ticker (EDGAR
auto-discovery only admits companies with a mapped US ticker — see
universescan.py), so Stooq's uniform `TICKER.US` daily-bars endpoint covers the
whole universe with one adapter and no per-exchange suffix logic.

Prices are used SERVER-SIDE ONLY to compute derived signals (P/E, returns,
backtest scores) — never republished raw, the same posture already used for
Yahoo-sourced index proxies. Stooq's terms are UNKNOWN/unverified for
redistribution (same caveat `stooq.py`'s lightweight probe adapter already
carries); internal, non-redistributed use is the safe lane until verified.

  python -m engine.sources.prices ingest              # daily incremental (small window)
  python -m engine.sources.prices ingest --full        # full-history backfill/refresh
  python -m engine.sources.prices ingest --full --tickers AAPL,MSFT   # targeted refresh
"""
from __future__ import annotations

import io
import os
import time
from datetime import date, timedelta

import pandas as pd
import requests

_HEADERS = {"User-Agent": "Mozilla/5.0"}  # Stooq's daily-bars endpoint 403s a bare UA
_DAILY_URL = "https://stooq.com/q/d/l/?s={sym}&i=d"

_COLS = ("date", "open", "high", "low", "close", "volume")

# Set PRICES_DEBUG=1 to print raw status/headers/body-head for every call — the
# only way to see what Stooq actually returned when running in CI (the only
# network-reachable environment; the dev sandbox can't hit external hosts at all).
_DEBUG = os.getenv("PRICES_DEBUG", "").strip().lower() in ("1", "true", "yes")


def _symbol(ticker: str) -> str:
    return f"{ticker.strip().lower()}.us"


def fetch_ticker_prices(ticker: str, start: date | None = None) -> pd.DataFrame | None:
    """One ticker's daily OHLCV from Stooq, oldest-first. `start` restricts to an
    incremental window (Stooq honors d1=YYYYMMDD); omit for full history. Returns
    None on any failure, delisting, or unmapped ticker — callers skip gracefully
    rather than let one bad symbol break a bulk run."""
    url = _DAILY_URL.format(sym=_symbol(ticker))
    if start:
        url += f"&d1={start:%Y%m%d}&d2={date.today():%Y%m%d}"
    try:
        r = requests.get(url, headers=_HEADERS, timeout=30)
    except Exception as e:
        if _DEBUG:
            print(f"   [prices debug] {ticker}: GET {url} raised {e!r}")
        return None
    if _DEBUG:
        print(f"   [prices debug] {ticker}: GET {url} -> {r.status_code}, "
              f"len={len(r.text)}, content-type={r.headers.get('content-type')!r}, "
              f"body[:200]={r.text[:200]!r}")
    if r.status_code != 200 or not r.text:
        return None
    text = r.text.strip()
    # Stooq returns a plain-text "No data" line (not a 4xx) for unknown symbols
    # or an empty requested window — both are legitimate "nothing here" cases.
    if not text or text.lower().startswith("no data") or text.startswith("<"):
        return None
    try:
        df = pd.read_csv(io.StringIO(text))
    except Exception as e:
        if _DEBUG:
            print(f"   [prices debug] {ticker}: CSV parse failed: {e!r}")
        return None
    df.columns = [c.strip().lower() for c in df.columns]
    if df.empty or "close" not in df.columns or "date" not in df.columns:
        if _DEBUG:
            print(f"   [prices debug] {ticker}: parsed but missing close/date — "
                  f"columns={list(df.columns)}")
        return None
    df = df[[c for c in _COLS if c in df.columns]].copy()
    for c in ("open", "high", "low", "close", "volume"):
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["close"])
    df = df[df["close"] > 0]
    if df.empty:
        return None
    return df.sort_values("date").reset_index(drop=True)


def _priced_universe() -> list[tuple[int, str]]:
    """(security_id, ticker) for every ingested stock — ETF index proxies are
    handled by the separate Phase-1 Yahoo-holdings pipeline, not this one."""
    from .. import db

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select id, ticker from securities where kind='stock' order by ticker")
        return cur.fetchall()


def _max_dates(security_ids: list[int]) -> dict[int, date]:
    """security_id -> latest stored trading day, for the incremental window."""
    from .. import tierb

    if not security_ids or not tierb.have_prices():
        return {}
    con = tierb.connect()
    rows = con.execute(
        "select security_id, max(date) from prices "
        "where security_id in (select unnest(?::bigint[])) group by security_id",
        [security_ids]).fetchall()
    return {sid: d for sid, d in rows}


def bulk_ingest(tickers: list[str] | None = None, full: bool = False,
                sleep: float = 0.2) -> dict:
    """Fetch + write daily OHLCV for `tickers` (default: the whole stock universe).

    full=False (daily default): fetch only trading days after each security's
    stored max(date) — cheap, bounded, safe to run every day.
    full=True: DELETE each target security's stored history first (the clean way
    to re-base after a split — see tierb.delete_price_securities), then re-fetch
    full history. Chunked/buffered throughout (PriceWriter flushes every 200k
    rows) — memory stays flat regardless of universe size, same discipline as
    the EDGAR bulk-ingest OOM fix (cache=False, no unbounded accumulation).
    """
    from .. import tierb

    universe = _priced_universe()
    if tickers:
        want = {t.upper() for t in tickers}
        universe = [(sid, tk) for sid, tk in universe if tk.upper() in want]
    stats = {"tickers": len(universe), "written": 0, "missing": [], "errors": [],
             "mode": "full" if full else "incremental"}
    if not universe:
        return stats

    if full:
        purged = tierb.delete_price_securities([sid for sid, _ in universe])
        stats["purged"] = purged
        max_dates: dict[int, date] = {}
    else:
        max_dates = _max_dates([sid for sid, _ in universe])

    writer = tierb.PriceWriter()
    for i, (sid, tk) in enumerate(universe, 1):
        if i % 250 == 0:
            print(f"   price ingest progress: {i}/{len(universe)} tickers", flush=True)
        start = None if full else (max_dates.get(sid, date.today() - timedelta(days=400))
                                    + timedelta(days=1))
        if start and start > date.today():
            continue  # already current
        try:
            df = fetch_ticker_prices(tk, start=start)
        except Exception as e:
            stats["errors"].append(f"{tk}: {str(e)[:80]}")
            continue
        if df is None or df.empty:
            stats["missing"].append(tk)
            continue
        rows = [(sid, str(r["date"]), r.get("open"), r.get("high"), r.get("low"),
                 float(r["close"]), r.get("volume"), "stooq")
                for r in df.to_dict(orient="records")]
        writer.add(rows)
        time.sleep(sleep)
    writer.close()
    stats["written"] = writer.added
    if writer.error:
        stats["tierb_error"] = writer.error
        print(f"   WARNING: Tier B price write failed: {writer.error}")
    return stats


if __name__ == "__main__":
    import argparse
    import json

    p = argparse.ArgumentParser(prog="engine.sources.prices", description="Stooq EOD price ingestion")
    sub = p.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest", help="fetch + write daily OHLCV")
    ing.add_argument("--full", action="store_true", help="full-history backfill/refresh")
    ing.add_argument("--tickers", help="comma-separated ticker subset (default: whole universe)")
    ing.add_argument("--sleep", type=float, default=0.2, help="seconds between requests")
    a = p.parse_args()
    if a.cmd == "ingest":
        tks = [t.strip() for t in a.tickers.split(",")] if a.tickers else None
        result = bulk_ingest(tickers=tks, full=a.full, sleep=a.sleep)
        print(json.dumps(result, indent=2, default=str))
