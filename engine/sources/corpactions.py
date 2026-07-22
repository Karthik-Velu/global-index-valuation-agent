"""Corporate actions — dividends + splits (Massive/Polygon.io reference data).

Two v3 reference endpoints, both TICKER-OPTIONAL and date-range-filterable
(`.gte`/`.lte` suffixes) — so a single bulk query (paginated) pulls every
dividend/split across the WHOLE market for a window, the same one-call-covers-
everything shape as prices.py's grouped-daily endpoint, rather than sweeping
per-ticker.

Splits are already reflected in prices.py's split-adjusted bars (`adjusted=true`
grouped-daily) — this module's `splits` table is an audit trail, not something
downstream code re-derives prices from. Dividends are NOT reflected in that
(split-only) adjusted series, so this is the real data source for
stockvaluation.py's trailing-12-month dividend_yield (previously hardcoded to
0.0 — see ADR entry).

Volume reality check (confirmed 2026-07-22, see JOURNAL): the "whole US
market" is a LOT bigger than our ~3,000-ticker tracked universe — a 2-year
window hit 394,000+ dividend rows and was still climbing when a 90-minute CI
job ran out of time, having not even started on splits. Rows for tickers we
don't track are the overwhelming majority of that (this module keeps only
`ticker in _tracked_ids()`) but Massive's v3 reference endpoints have no
multi-ticker filter, so there's no way to ask for less server-side — the
options are "fetch the whole market and discard most of it" (fewer, fatter
requests) or "sweep our ~3,000 tickers individually" (thousands of thinner
requests, empirically slower at the same per-request rate limit). This module
takes the whole-market approach and instead shrinks the WINDOW (see
_FULL_DAYS/_INCREMENTAL_DAYS below) and persists PER PAGE (not batched to the
end) so a run that still doesn't finish in one sitting saves real, durable
progress instead of losing everything to a timeout.

  python -m engine.sources.corpactions ingest             # ~35d window (daily incremental)
  python -m engine.sources.corpactions ingest --full       # ~13mo window (one-time backfill)
  python -m engine.sources.corpactions ingest --start 2024-01-01 --end 2024-06-01
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta

import requests

MASSIVE_BASE = os.getenv("MASSIVE_BASE", "https://api.massive.com").rstrip("/")
_KEY_ENV = "MASSIVE_API_KEY"

_DIVIDENDS_PATH = "/v3/reference/dividends"
_SPLITS_PATH = "/v3/reference/splits"
# Polygon/Massive's v3 REFERENCE endpoints (dividends, splits) cap `limit` at
# 1000 — that's a different, lower ceiling than the aggregates/grouped-daily
# endpoints prices.py uses (which allow up to 50000). 5000 here 400'd
# immediately in CI (confirmed 2026-07-22, see JOURNAL) — reverted to 1000.
_PAGE_LIMIT = 1000

# stockvaluation.py's dividend_yield only ever needs a TRAILING 12-MONTH
# window (see _dividend_features) — a 2-year backfill was borrowed from
# prices.py's precedent (which genuinely needs deep history for backtesting)
# without checking whether corp actions needed the same depth. It doesn't:
# ~13 months covers today's TTM yield with a buffer, and empirically that's
# roughly half the request volume of the 2-year window that couldn't finish
# in 90 minutes. _INCREMENTAL_DAYS is intentionally much smaller than the
# daily pipeline's other steps' windows — this step runs INSIDE the larger
# daily pipeline (already ~2h for a full sweep), not as its own job, so it
# has to be fast: ~35 days of whole-market dividend volume is a few minutes,
# not tens of minutes.
_INCREMENTAL_DAYS = 35
_FULL_DAYS = 400


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        self.retry_after = retry_after
        super().__init__(f"429 rate-limited (retry after {retry_after:.0f}s)")


def _api_key() -> str:
    key = os.getenv(_KEY_ENV, "").strip()
    if not key:
        raise RuntimeError(
            f"{_KEY_ENV} is not set — add the Massive API key as a GitHub Actions "
            "secret (repo Settings > Secrets and variables > Actions) or export it "
            "locally. Sign up free at massive.com.")
    return key


def _get(path: str, params: dict) -> dict:
    r = requests.get(f"{MASSIVE_BASE}{path}", params=params,
                     headers={"Authorization": f"Bearer {_api_key()}"}, timeout=30)
    if r.status_code == 429:
        try:
            retry_after = float(r.headers.get("Retry-After", "60"))
        except ValueError:
            retry_after = 60.0
        raise RateLimited(max(retry_after, 60.0))
    if not r.ok:
        # requests' own raise_for_status() message never includes the response
        # body, which is exactly the detail that would have made the 400
        # (limit=5000 exceeding this endpoint's real max of 1000) diagnosable
        # from the CI log alone instead of needing a guess-and-check cycle.
        raise requests.HTTPError(
            f"{r.status_code} {r.reason} for url: {r.url} — body: {r.text[:300]}", response=r)
    return r.json()


def _paginated(path: str, params: dict, sleep: float, label: str, on_page) -> int:
    """Walk next_url until exhausted, retrying once on a 429. Calls `on_page(rows)`
    with each page's raw results as they arrive — the caller persists immediately
    rather than this function accumulating everything in memory, so a run that
    gets killed mid-pagination (CI timeout, rate-limit exhaustion) keeps whatever
    it already fetched instead of losing it all (confirmed 2026-07-22: a 90-min
    timeout mid-dividends-fetch discarded 394,000 already-fetched rows because
    the old design only persisted once, at the very end). Prints per-page
    progress too — a silent multi-minute pagination loop with zero output is
    exactly what made an earlier CI timeout undiagnosable without a log pull.
    Returns the total row count seen."""
    total = 0
    page = 1
    try:
        data = _get(path, params)
    except RateLimited as rl:
        print(f"   [{label}] page {page} rate-limited, sleeping {rl.retry_after:.0f}s", flush=True)
        time.sleep(rl.retry_after)
        data = _get(path, params)
    rows = data.get("results") or []
    on_page(rows)
    total += len(rows)
    print(f"   [{label}] page {page}: {len(rows)} rows ({total} total)", flush=True)
    while data.get("next_url"):
        time.sleep(sleep)
        page += 1
        nxt = data["next_url"]
        nxt_path = nxt[len(MASSIVE_BASE):] if nxt.startswith(MASSIVE_BASE) else nxt
        try:
            data = _get(nxt_path, {})
        except RateLimited as rl:
            print(f"   [{label}] page {page} rate-limited, sleeping {rl.retry_after:.0f}s", flush=True)
            time.sleep(rl.retry_after)
            data = _get(nxt_path, {})
        rows = data.get("results") or []
        on_page(rows)
        total += len(rows)
        print(f"   [{label}] page {page}: {len(rows)} rows ({total} total)", flush=True)
    return total


def _tracked_ids() -> dict[str, int]:
    from .. import db
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select ticker, id from securities where kind in ('stock','etf')")
        return {tk.upper(): sid for tk, sid in cur.fetchall()}


def ingest(start: date | None = None, end: date | None = None, full: bool = False,
          sleep: float = 13.0) -> dict:
    """Bulk date-range pull of dividends + splits across the whole market (ticker
    omitted from the request), keeping only rows for tickers we track. Persists
    PER PAGE (see _paginated) rather than accumulating everything and writing once
    at the end — a run that runs out of time keeps whatever it already fetched.
    Idempotent (ON CONFLICT DO NOTHING on the natural key), so a daily re-run over
    an overlapping window, or a re-fire after a partial run, is cheap and safe.

    `sleep` defaults to 13s (~4.6 req/min) — the same free-tier-safe pacing
    prices.py uses, since this is the same provider/plan and there's no
    confirmed evidence the reference endpoints get a more generous quota than
    grouped-daily prices.

    `full=True` (no explicit start/end) widens the window to _FULL_DAYS — see
    the module docstring for why that's ~13 months, not the 2 years prices.py
    uses (dividend_yield only ever needs a trailing-12-month window; a 2-year
    whole-market pull couldn't finish a 90-minute CI job — see JOURNAL
    2026-07-22)."""
    from .. import db

    _api_key()  # fail fast + loud before any work if the key is missing
    end = end or date.today()
    start = start or (end - timedelta(days=_FULL_DAYS if full else _INCREMENTAL_DAYS))
    id_by_ticker = _tracked_ids()
    stats: dict = {"window": [start.isoformat(), end.isoformat()], "dividends": 0, "splits": 0,
                  "dividends_unmatched": 0, "splits_unmatched": 0, "errors": []}
    have_db = db.have_db()
    if not have_db:
        stats["note"] = "DATABASE_URL not set — nothing will be persisted"

    def _persist_dividends(rows: list[dict]) -> None:
        if not have_db or not rows:
            stats["dividends_unmatched"] += sum(
                1 for d in rows if id_by_ticker.get(str(d.get("ticker") or "").upper()) is None)
            return
        batch = []
        for d in rows:
            tk = str(d.get("ticker") or "").upper()
            sid = id_by_ticker.get(tk)
            if sid is None:
                stats["dividends_unmatched"] += 1
                continue
            batch.append((sid, tk, d.get("cash_amount"), d.get("currency"), d.get("dividend_type"),
                          d.get("declaration_date"), d.get("ex_dividend_date"), d.get("record_date"),
                          d.get("pay_date"), d.get("frequency")))
        if not batch:
            return
        with db.connect() as conn, conn.cursor() as cur:
            cur.executemany(
                """insert into dividends (security_id, ticker, cash_amount, currency, dividend_type,
                                          declaration_date, ex_dividend_date, record_date, pay_date, frequency)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (ticker, ex_dividend_date, cash_amount) do nothing""",
                batch)
            conn.commit()
        stats["dividends"] += len(batch)

    def _persist_splits(rows: list[dict]) -> None:
        if not have_db or not rows:
            stats["splits_unmatched"] += sum(
                1 for s in rows if id_by_ticker.get(str(s.get("ticker") or "").upper()) is None)
            return
        batch = []
        for s in rows:
            tk = str(s.get("ticker") or "").upper()
            sid = id_by_ticker.get(tk)
            if sid is None:
                stats["splits_unmatched"] += 1
                continue
            batch.append((sid, tk, s.get("execution_date"), s.get("split_from"), s.get("split_to")))
        if not batch:
            return
        with db.connect() as conn, conn.cursor() as cur:
            cur.executemany(
                """insert into splits (security_id, ticker, execution_date, split_from, split_to)
                   values (%s,%s,%s,%s,%s)
                   on conflict (ticker, execution_date, split_from, split_to) do nothing""",
                batch)
            conn.commit()
        stats["splits"] += len(batch)

    print(f"   fetching dividends {start} .. {end}", flush=True)
    try:
        _paginated(_DIVIDENDS_PATH, {
            "ex_dividend_date.gte": start.isoformat(), "ex_dividend_date.lte": end.isoformat(),
            "limit": _PAGE_LIMIT,
        }, sleep, "dividends", _persist_dividends)
    except Exception as e:
        stats["errors"].append(f"dividends: {str(e)[:160]}")

    print(f"   fetching splits {start} .. {end}", flush=True)
    try:
        _paginated(_SPLITS_PATH, {
            "execution_date.gte": start.isoformat(), "execution_date.lte": end.isoformat(),
            "limit": _PAGE_LIMIT,
        }, sleep, "splits", _persist_splits)
    except Exception as e:
        stats["errors"].append(f"splits: {str(e)[:160]}")

    return stats


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="engine.sources.corpactions",
                                description="Corporate actions ingestion (dividends + splits)")
    sub = p.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest", help="bulk date-range pull of dividends + splits")
    ing.add_argument("--full", action="store_true",
                     help=f"~{_FULL_DAYS} days of history (one-time backfill; covers the TTM "
                          "dividend_yield window with a buffer)")
    ing.add_argument("--start", help="ISO date, default: window-days back from --end")
    ing.add_argument("--end", help="ISO date, default: today")
    ing.add_argument("--sleep", type=float, default=13.0, help="seconds between pagination requests")
    a = p.parse_args()
    if a.cmd == "ingest":
        start_d = date.fromisoformat(a.start) if a.start else None
        end_d = date.fromisoformat(a.end) if a.end else None
        result = ingest(start=start_d, end=end_d, full=a.full, sleep=a.sleep)
        print(json.dumps(result, indent=2, default=str))
        if result["errors"]:
            # ingest() itself never raises on a fetch failure (datapipeline.py's
            # daily incremental call wraps this non-fatally, same as prices/EDGAR
            # hiccups) — but for this standalone CLI/CI job, a small handful of
            # bulk calls erroring means the run accomplished nothing while still
            # printing "success" to the workflow. A CI job that silently does
            # nothing is worse than one that fails loudly (see JOURNAL 2026-07-22
            # — the first two backfill attempts both reported success: one from
            # a 30-min timeout that never got this far, one from every fetch
            # 400ing on the first call).
            import sys
            sys.exit(1)
