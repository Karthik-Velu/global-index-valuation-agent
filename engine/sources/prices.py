"""Massive (formerly Polygon.io) — EOD prices for US-listed securities (ADR-017).

Date-driven ingestion built on Massive's GROUPED-DAILY endpoint: one API call
returns OHLCV for every US-listed ticker (stocks + ETFs) for one trading day, so
the whole 3,000-ticker universe costs 1 call/day — the free tier's 5-req/min limit
is irrelevant for daily operation, and a full 2-year backfill is ~504 calls
(~105 min paced at 4.8 req/min) in a single CI job.

Auth is the `MASSIVE_API_KEY` env var (Massive's own client convention), sent as an
`Authorization: Bearer` header so the key never appears in URLs or CI logs.

Prices are used SERVER-SIDE ONLY to compute derived signals (P/E, returns,
backtest scores). Massive's terms require a business plan to redistribute RAW
market data; the derived-data clause is flagged for human review in ADR-017 —
until then nothing sourced from these bars is published raw.

History note: `adjusted=true` bars are SPLIT-adjusted (not dividend-adjusted).
A split re-bases the whole history server-side, so the monthly `--full` rebuild
(purge + re-fetch) keeps the store re-based; daily incremental appends are cheap
and idempotent.

(The previous adapter used Stooq — retired 2026-07-09 after confirming both its
free access paths are bot-walled against headless CI; see JOURNAL + ADR-017.)

  python -m engine.sources.prices ingest               # daily incremental (~1 call)
  python -m engine.sources.prices ingest --full         # full-history rebuild (resumable)
  python -m engine.sources.prices ingest --full --tickers AAPL,MSFT  # targeted re-fetch
"""
from __future__ import annotations

import json
import os
import time
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
import requests

MASSIVE_BASE = os.getenv("MASSIVE_BASE", "https://api.massive.com").rstrip("/")
_KEY_ENV = "MASSIVE_API_KEY"

_GROUPED_PATH = "/v2/aggs/grouped/locale/us/market/stocks/{day}"
_RANGE_PATH = "/v2/aggs/ticker/{ticker}/range/1/day/{start}/{end}"

# Hard sanity bound for the backward walk (beyond any advertised tier).
_MAX_LOOKBACK_YEARS = 11
# N consecutive zero-result weekdays == beyond entitlement (no US market week
# is all holidays), when the API signals the limit with empty results not 403.
_EMPTY_STREAK_FLOOR = 5

_DEBUG = os.getenv("PRICES_DEBUG", "").strip().lower() in ("1", "true", "yes")


class RateLimited(Exception):
    def __init__(self, retry_after: float):
        self.retry_after = retry_after
        super().__init__(f"429 rate-limited (retry after {retry_after:.0f}s)")


class NotEntitled(Exception):
    """403 — the requested date/data is beyond this key's plan."""


def _api_key() -> str:
    key = os.getenv(_KEY_ENV, "").strip()
    if not key:
        raise RuntimeError(
            f"{_KEY_ENV} is not set — add the Massive API key as a GitHub Actions "
            "secret (repo Settings > Secrets and variables > Actions) or export it "
            "locally. Sign up free at massive.com.")
    return key


def _get(path: str, params: dict | None = None) -> dict:
    url = f"{MASSIVE_BASE}{path}"
    r = requests.get(url, params=params or {},
                     headers={"Authorization": f"Bearer {_api_key()}"}, timeout=30)
    if _DEBUG:
        print(f"   [prices debug] GET {path} -> {r.status_code}, len={len(r.text)}, "
              f"body[:160]={r.text[:160]!r}")
    if r.status_code == 429:
        try:
            retry_after = float(r.headers.get("Retry-After", "60"))
        except ValueError:
            retry_after = 60.0
        raise RateLimited(max(retry_after, 60.0))
    if r.status_code == 403:
        raise NotEntitled(r.text[:200])
    r.raise_for_status()
    return r.json()


def fetch_grouped_daily(day: date, adjusted: bool = True) -> pd.DataFrame:
    """One trading day's OHLCV for EVERY US ticker, as
    DataFrame[ticker, open, high, low, close, volume]. Empty frame for holidays
    (resultsCount == 0). Raises NotEntitled beyond the plan's history window and
    RateLimited on 429 — callers decide the policy."""
    data = _get(_GROUPED_PATH.format(day=f"{day:%Y-%m-%d}"),
                {"adjusted": str(adjusted).lower(), "include_otc": "false"})
    rows = data.get("results") or []
    df = pd.DataFrame([{"ticker": r.get("T"), "open": r.get("o"), "high": r.get("h"),
                        "low": r.get("l"), "close": r.get("c"), "volume": r.get("v")}
                       for r in rows if r.get("T") and r.get("c") is not None])
    if df.empty:
        return pd.DataFrame(columns=["ticker", "open", "high", "low", "close", "volume"])
    return df[df["close"] > 0].reset_index(drop=True)


def fetch_ticker_range(ticker: str, start: date, end: date,
                       adjusted: bool = True) -> pd.DataFrame | None:
    """One ticker's daily bars over [start, end] as
    DataFrame[date, open, high, low, close, volume], oldest-first. None when the
    ticker is unknown/has no data. Daily-bar timestamps are ET-midnight-anchored
    Unix ms — converted via America/New_York so bars land on the right calendar
    day. limit=50000 means a 10-year range never paginates; next_url is followed
    defensively anyway."""
    path = _RANGE_PATH.format(ticker=ticker.upper().strip(),
                              start=f"{start:%Y-%m-%d}", end=f"{end:%Y-%m-%d}")
    params = {"adjusted": str(adjusted).lower(), "sort": "asc", "limit": 50000}
    results: list[dict] = []
    data = _get(path, params)
    results.extend(data.get("results") or [])
    while data.get("next_url"):
        nxt = data["next_url"]
        nxt_path = nxt[len(MASSIVE_BASE):] if nxt.startswith(MASSIVE_BASE) else nxt
        data = _get(nxt_path)
        results.extend(data.get("results") or [])
    if not results:
        return None
    df = pd.DataFrame([{"t": r.get("t"), "open": r.get("o"), "high": r.get("h"),
                        "low": r.get("l"), "close": r.get("c"), "volume": r.get("v")}
                       for r in results if r.get("c") is not None])
    if df.empty:
        return None
    df["date"] = (pd.to_datetime(df["t"], unit="ms", utc=True)
                  .dt.tz_convert("America/New_York").dt.date.astype(str))
    df = df[df["close"] > 0].drop(columns=["t"])
    return df[["date", "open", "high", "low", "close", "volume"]].sort_values(
        "date").reset_index(drop=True)


# --- store-side helpers ------------------------------------------------------

def _meta_path() -> Path:
    from .. import tierb
    return tierb.root() / "prices_meta.json"


def _meta_read() -> dict:
    p = _meta_path()
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {}


def _meta_write(**updates) -> None:
    m = _meta_read()
    m.update(updates)
    p = _meta_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(m, indent=2, default=str))


def _priced_universe() -> list[tuple[int, str]]:
    """(security_id, ticker) for every stock AND ETF proxy we track — grouped
    daily covers both, so index proxies stop depending on Yahoo for prices."""
    from .. import db

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select id, ticker from securities where kind in ('stock','etf') "
                    "order by ticker")
        return cur.fetchall()


def _store_date_bounds() -> tuple[date | None, date | None]:
    from .. import tierb

    if not tierb.have_prices():
        return None, None
    lo, hi = tierb.connect().execute("select min(date), max(date) from prices").fetchone()
    return lo, hi


def _weekdays_backward(start: date):
    d = start
    while True:
        if d.weekday() < 5:
            yield d
        d -= timedelta(days=1)


def _weekdays_between(lo: date, hi: date) -> list[date]:
    return [lo + timedelta(days=i) for i in range((hi - lo).days + 1)
            if (lo + timedelta(days=i)).weekday() < 5]


def _grouped_day_rows(day: date, id_by_ticker: dict[str, int]) -> tuple[list[tuple], int]:
    """Fetch one grouped day and map to store rows. Returns (rows, raw_count)."""
    df = fetch_grouped_daily(day)
    raw = len(df)
    rows = []
    for r in df.to_dict(orient="records"):
        sid = id_by_ticker.get(str(r["ticker"]).upper())
        if sid is None:
            continue
        rows.append((sid, day.isoformat(), r.get("open"), r.get("high"), r.get("low"),
                     float(r["close"]), r.get("volume"), "massive"))
    return rows, raw


def _call_paced(last_call: list[float], sleep: float) -> None:
    """Sleep so consecutive API calls stay `sleep` seconds apart."""
    now = time.monotonic()
    wait = (last_call[0] + sleep) - now
    if wait > 0:
        time.sleep(wait)
    last_call[0] = time.monotonic()


def bulk_ingest(tickers: list[str] | None = None, full: bool = False,
                sleep: float = 13.0, max_minutes: float | None = None) -> dict:
    """Fetch + write daily OHLCV into Tier B.

    Modes (public signature unchanged from the Stooq era — datapipeline step 2c
    and the workflows call it the same way):
      * incremental (default): grouped-daily for each trading day after the
        store's max(date) — normally 1 call/day; capped at 30 days back (7 for an
        empty store) so the daily pipeline can never wander into backfill costs.
      * full, no tickers: resumable full-history rebuild — purge the universe's
        rows once, then walk trading days BACKWARD from today via grouped-daily
        until the plan's history floor (403 or 5 consecutive empty weekdays),
        persisting a cursor in <store>/prices_meta.json after every day so a
        killed job resumes where it stopped.
      * full + tickers: targeted per-ticker re-fetch (delete those securities'
        history, re-pull via fetch_ticker_range) — the split re-base path.

    `sleep` paces API calls (13s ≈ 4.6 req/min, safely under the free tier's 5).
    `max_minutes` makes CI jobs stop cleanly before their timeout; the cursor
    carries the rest to the next run.
    """
    from .. import tierb

    _api_key()  # fail fast + loud before any work if the key is missing
    universe = _priced_universe()
    id_by_ticker = {tk.upper(): sid for sid, tk in universe}
    stats: dict = {"tickers": len(universe), "written": 0, "days": 0, "missing": [],
                   "errors": [], "mode": "full" if full else "incremental"}
    deadline = time.monotonic() + max_minutes * 60 if max_minutes else None
    last_call = [0.0]

    # --- targeted per-ticker refresh (split re-base) -------------------------
    if full and tickers:
        want = [(sid, tk) for sid, tk in universe if tk.upper() in {t.upper() for t in tickers}]
        stats["tickers"] = len(want)
        stats["purged"] = tierb.delete_price_securities([sid for sid, _ in want])
        writer = tierb.PriceWriter()
        start = date.today() - timedelta(days=int(_MAX_LOOKBACK_YEARS * 365.25))
        for sid, tk in want:
            _call_paced(last_call, sleep)
            try:
                df = fetch_ticker_range(tk, start, date.today())
            except NotEntitled:
                df = None  # range clipped server-side on some plans; treat as missing
            except RateLimited as rl:
                time.sleep(rl.retry_after)
                try:
                    df = fetch_ticker_range(tk, start, date.today())
                except Exception as e:
                    stats["errors"].append(f"{tk}: {str(e)[:80]}")
                    continue
            except Exception as e:
                stats["errors"].append(f"{tk}: {str(e)[:80]}")
                continue
            if df is None or df.empty:
                stats["missing"].append(tk)
                continue
            writer.add([(sid, r["date"], r.get("open"), r.get("high"), r.get("low"),
                         float(r["close"]), r.get("volume"), "massive")
                        for r in df.to_dict(orient="records")])
        writer.close()
        stats["written"] = writer.added
        if writer.error:
            stats["tierb_error"] = writer.error
        return stats

    # --- date-driven grouped paths -------------------------------------------
    def fetch_day_into(writer: tierb.PriceWriter, day: date) -> int | None:
        """One paced grouped call -> rows written; None means rate-limit gave up."""
        _call_paced(last_call, sleep)
        try:
            rows, _ = _grouped_day_rows(day, id_by_ticker)
        except RateLimited as rl:
            time.sleep(rl.retry_after)
            try:
                rows, _ = _grouped_day_rows(day, id_by_ticker)
            except Exception as e:
                stats["errors"].append(f"{day}: {str(e)[:80]}")
                return None
        writer.add(rows)
        return len(rows)

    if not full:
        _, hi = _store_date_bounds()
        window_start = (hi + timedelta(days=1)) if hi else (date.today() - timedelta(days=7))
        window_start = max(window_start, date.today() - timedelta(days=30))
        days = _weekdays_between(window_start, date.today())
        writer = tierb.PriceWriter()
        for day in days:
            if deadline and time.monotonic() > deadline:
                stats["stopped"] = "max_minutes"
                break
            n = fetch_day_into(writer, day)
            if n is None:
                break
            stats["days"] += 1
        writer.close()
        stats["written"] = writer.added
        if writer.error:
            stats["tierb_error"] = writer.error
        return stats

    # full rebuild, resumable
    meta = _meta_read()
    hard_floor = date.today() - timedelta(days=int(_MAX_LOOKBACK_YEARS * 365.25))
    if meta.get("full_rebuild_started"):
        # resume: cursor = last day already processed -> start just before it
        cursor = date.fromisoformat(meta["cursor"]) if meta.get("cursor") else date.today()
        walk_from = cursor - timedelta(days=1)
        print(f"   resuming full price rebuild from cursor {cursor}")
    else:
        purged = tierb.delete_price_securities([sid for sid, _ in universe])
        stats["purged"] = purged
        _meta_write(full_rebuild_started=True, cursor=date.today().isoformat(),
                    started_at=date.today().isoformat())
        walk_from = date.today()

    writer = tierb.PriceWriter()
    empty_streak = 0
    floor_reason = None
    for day in _weekdays_backward(walk_from):
        if deadline and time.monotonic() > deadline:
            stats["stopped"] = "max_minutes"
            break
        if day < hard_floor:
            floor_reason = f"hard lookback bound ({_MAX_LOOKBACK_YEARS}y)"
            break
        _call_paced(last_call, sleep)
        try:
            rows, raw = _grouped_day_rows(day, id_by_ticker)
        except NotEntitled:
            floor_reason = "403 NOT_AUTHORIZED (plan history limit)"
            break
        except RateLimited as rl:
            time.sleep(rl.retry_after)
            try:
                rows, raw = _grouped_day_rows(day, id_by_ticker)
            except Exception as e:
                stats["errors"].append(f"{day}: {str(e)[:80]}")
                break
        except Exception as e:
            stats["errors"].append(f"{day}: {str(e)[:80]}")
            break
        if raw == 0:
            empty_streak += 1
            if empty_streak >= _EMPTY_STREAK_FLOOR:
                floor_reason = f"{_EMPTY_STREAK_FLOOR} consecutive empty weekdays (plan history limit)"
                break
        else:
            empty_streak = 0
            writer.add(rows)
        stats["days"] += 1
        _meta_write(cursor=day.isoformat())
        if stats["days"] % 50 == 0:
            print(f"   backfill progress: {stats['days']} days, cursor {day}", flush=True)
    writer.close()
    stats["written"] = writer.added
    if writer.error:
        stats["tierb_error"] = writer.error
    if floor_reason:
        stats["floor"] = floor_reason
        _meta_write(full_rebuild_started=False, floor=floor_reason,
                    floor_date=_meta_read().get("cursor"))
        print(f"   backfill COMPLETE — history floor: {floor_reason}")
    elif stats.get("stopped"):
        print(f"   backfill paused at cursor {_meta_read().get('cursor')} — "
              "re-run to continue (resumable)")
    return stats


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="engine.sources.prices",
                                description="Massive EOD price ingestion (ADR-017)")
    sub = p.add_subparsers(dest="cmd", required=True)
    ing = sub.add_parser("ingest", help="fetch + write daily OHLCV")
    ing.add_argument("--full", action="store_true", help="full-history rebuild (resumable)")
    ing.add_argument("--tickers", help="comma-separated subset (with --full: targeted re-fetch)")
    ing.add_argument("--sleep", type=float, default=13.0, help="seconds between API calls")
    ing.add_argument("--max-minutes", type=float, default=None,
                     help="stop cleanly after this many minutes (cursor resumes next run)")
    a = p.parse_args()
    if a.cmd == "ingest":
        tks = [t.strip() for t in a.tickers.split(",")] if a.tickers else None
        result = bulk_ingest(tickers=tks, full=a.full, sleep=a.sleep,
                             max_minutes=a.max_minutes)
        print(json.dumps(result, indent=2, default=str))
