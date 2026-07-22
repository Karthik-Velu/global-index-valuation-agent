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

  python -m engine.sources.corpactions ingest             # ~400d window (daily incremental)
  python -m engine.sources.corpactions ingest --full       # ~2y window, matches price backfill
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
_PAGE_LIMIT = 5000  # provider max — fewer round trips against the shared 5 req/min free tier

# Default incremental window: comfortably covers a year of TTM dividend history
# plus the daily gap since the last run. --full uses the same ~2y span as the
# price backfill (prices.py's free-tier entitlement window).
_INCREMENTAL_DAYS = 400
_FULL_DAYS = 730


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
    r.raise_for_status()
    return r.json()


def _paginated(path: str, params: dict, sleep: float, label: str) -> list[dict]:
    """Walk next_url until exhausted, retrying once on a 429. Prints per-page
    progress — a silent multi-minute pagination loop with zero output is exactly
    what made the first CI run's 30-minute timeout undiagnosable (had to pull raw
    job logs to learn it never printed anything at all)."""
    out: list[dict] = []
    page = 1
    try:
        data = _get(path, params)
    except RateLimited as rl:
        print(f"   [{label}] page {page} rate-limited, sleeping {rl.retry_after:.0f}s", flush=True)
        time.sleep(rl.retry_after)
        data = _get(path, params)
    out.extend(data.get("results") or [])
    print(f"   [{label}] page {page}: {len(data.get('results') or [])} rows "
          f"({len(out)} total)", flush=True)
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
        out.extend(data.get("results") or [])
        print(f"   [{label}] page {page}: {len(data.get('results') or [])} rows "
              f"({len(out)} total)", flush=True)
    return out


def fetch_dividends(start: date, end: date, sleep: float = 13.0) -> list[dict]:
    return _paginated(_DIVIDENDS_PATH, {
        "ex_dividend_date.gte": start.isoformat(), "ex_dividend_date.lte": end.isoformat(),
        "limit": _PAGE_LIMIT,
    }, sleep, "dividends")


def fetch_splits(start: date, end: date, sleep: float = 13.0) -> list[dict]:
    return _paginated(_SPLITS_PATH, {
        "execution_date.gte": start.isoformat(), "execution_date.lte": end.isoformat(),
        "limit": _PAGE_LIMIT,
    }, sleep, "splits")


def _tracked_ids() -> dict[str, int]:
    from .. import db
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select ticker, id from securities where kind in ('stock','etf')")
        return {tk.upper(): sid for tk, sid in cur.fetchall()}


def ingest(start: date | None = None, end: date | None = None, full: bool = False,
          sleep: float = 13.0) -> dict:
    """Bulk date-range pull of dividends + splits across the whole market (ticker
    omitted from the request), keeping only rows for tickers we track. Idempotent
    (ON CONFLICT DO NOTHING on the natural key), so a daily re-run over an
    overlapping window is cheap and safe.

    `sleep` defaults to 13s (~4.6 req/min) — the same free-tier-safe pacing
    prices.py uses, since this is the same provider/plan and there's no
    confirmed evidence the reference endpoints get a more generous quota than
    grouped-daily prices (the first CI attempt at 1.0s produced zero output in
    30 minutes, consistent with repeated silent 429 backoffs — see JOURNAL
    2026-07-22).

    `full=True` (no explicit start/end) widens the window to ~2y, matching the
    price backfill's window — same `full_ingest` flag the daily pipeline already
    threads through to prices.bulk_ingest(full=...)."""
    from .. import db

    _api_key()  # fail fast + loud before any work if the key is missing
    end = end or date.today()
    start = start or (end - timedelta(days=_FULL_DAYS if full else _INCREMENTAL_DAYS))
    id_by_ticker = _tracked_ids()
    stats: dict = {"window": [start.isoformat(), end.isoformat()], "dividends": 0, "splits": 0,
                  "dividends_unmatched": 0, "splits_unmatched": 0, "errors": []}

    print(f"   fetching dividends {start} .. {end}", flush=True)
    try:
        divs = fetch_dividends(start, end, sleep)
    except Exception as e:
        stats["errors"].append(f"dividends: {str(e)[:160]}")
        divs = []
    print(f"   fetching splits {start} .. {end}", flush=True)
    try:
        splits = fetch_splits(start, end, sleep)
    except Exception as e:
        stats["errors"].append(f"splits: {str(e)[:160]}")
        splits = []

    div_rows, split_rows = [], []
    for d in divs:
        tk = str(d.get("ticker") or "").upper()
        sid = id_by_ticker.get(tk)
        if sid is None:
            stats["dividends_unmatched"] += 1
            continue
        div_rows.append((sid, tk, d.get("cash_amount"), d.get("currency"), d.get("dividend_type"),
                         d.get("declaration_date"), d.get("ex_dividend_date"), d.get("record_date"),
                         d.get("pay_date"), d.get("frequency")))
    for s in splits:
        tk = str(s.get("ticker") or "").upper()
        sid = id_by_ticker.get(tk)
        if sid is None:
            stats["splits_unmatched"] += 1
            continue
        split_rows.append((sid, tk, s.get("execution_date"), s.get("split_from"), s.get("split_to")))

    if not db.have_db():
        stats["note"] = "DATABASE_URL not set — fetched but not persisted"
        return stats

    with db.connect() as conn, conn.cursor() as cur:
        if div_rows:
            cur.executemany(
                """insert into dividends (security_id, ticker, cash_amount, currency, dividend_type,
                                          declaration_date, ex_dividend_date, record_date, pay_date, frequency)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (ticker, ex_dividend_date, cash_amount) do nothing""",
                div_rows)
            stats["dividends"] = len(div_rows)
        if split_rows:
            cur.executemany(
                """insert into splits (security_id, ticker, execution_date, split_from, split_to)
                   values (%s,%s,%s,%s,%s)
                   on conflict (ticker, execution_date, split_from, split_to) do nothing""",
                split_rows)
            stats["splits"] = len(split_rows)
        conn.commit()
    return stats


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="engine.sources.corpactions",
                                description="Corporate actions ingestion (dividends + splits)")
    sub = p.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest", help="bulk date-range pull of dividends + splits")
    ing.add_argument("--full", action="store_true",
                     help=f"~{_FULL_DAYS // 365}y history (matches the price backfill window)")
    ing.add_argument("--start", help="ISO date, default: window-days back from --end")
    ing.add_argument("--end", help="ISO date, default: today")
    ing.add_argument("--sleep", type=float, default=13.0, help="seconds between pagination requests")
    a = p.parse_args()
    if a.cmd == "ingest":
        start_d = date.fromisoformat(a.start) if a.start else None
        end_d = date.fromisoformat(a.end) if a.end else None
        result = ingest(start=start_d, end=end_d, full=a.full, sleep=a.sleep)
        print(json.dumps(result, indent=2, default=str))
