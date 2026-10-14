"""Screener jobs — deterministic (no LLM; a JOB, not an "agent"), ADR-037.

Three things the screener / charts / alerts read from Postgres, all rebuilt from the
same scored frame the dashboard's picks use (stockvaluation.score_frame):

  publish_stock_snapshot  the projected stock universe the Screener runs over
                          (screener_snapshots, one row, trusted-only under RLS)
  publish_chart_series    a close-only DISPLAY CACHE for trusted stock charts
                          (chart_series; a bounded exception to ADR-016 Choice 1:
                          rebuildable from Tier B, never read by a job/backtest,
                          <= CHART_BUDGET_BYTES, time-boxed)
  run_alerts              diff each alerting saved screen's FULL match set against
                          the last run's, write screen_alerts rows

Hooks: engine/datapipeline.py calls run_daily() once a day (stocks); engine/pipeline.py
calls run_market_alerts() on the weekly refresh (markets, over the exact scoreboard rows
written to dashboard_data.json). Neither writes a file under dashboard/ or data/.

Projected rows are built ONCE (project_stock_rows): registry fields only, numpy/NaN
cleaned by pipeline._clean's rules (_py), then rounded — and that same list feeds both
the snapshot payload and run_alerts, so an alert can never name a ticker the screen
doesn't show.
Filters are re-validated and evaluated by engine/screens.py, the Python mirror of the
browser's ScreenDSL.

PRIVACY. Saved screens and alerts are per-user rows and the pipeline report is a
public Actions artifact. So: only aggregate counts are returned or printed, and an
exception from anything touching those tables is reduced to its class name + SQLSTATE
(_err) — psycopg's message text carries "DETAIL: Failing row contains (...)", i.e.
user uuids, filters and tickers.

Snapshot payload (screener_snapshots.payload, scope 'stocks'):
  {"v": 1, "asof": "YYYY-MM-DD", "fields": [registry keys...], "rows": [[...], ...],
   "n": rows, "n_hidden": rows with data_ok false,
   "excluded_counts": {reason: n, ...}   # overlapping: a row can have several
   "coverage": {"price_mcap": share, "pe": share}}
chart_series rows: 'calendar:us' (kind 'calendar': start_date + days = day offsets) and
'stock:<TICKER>' (kind 'stock': closes aligned to that calendar, null = no bar;
fundamentals = {"period_end": [...], "revenue": [...], "net_income": [...],
"currency": str|null}, <= 7 annual points from growthhistory.annual_series, null years
stay null).
"""
from __future__ import annotations

import json
import math
import os
import time
from datetime import date

from . import db, screens

# Guards (design review C): a Tier B / price outage scores ~3,120 rows with every price
# field NaN; publishing that would blank the screener and fire a mass "removed" alert,
# then a mass "added" one the next healthy day.
COVERAGE_MIN = 0.8          # share of rows with a price AND a market cap (~0.91 healthy)
PE_COVERAGE_KEEP = 0.8      # pe coverage must stay >= this x the previous snapshot's
SHRINK_MIN = 0.9            # rows (and an alert's universe) vs the previous run
MARKET_PE_MIN = 0.8         # weekly market alerts: share of scoreboard rows with a P/E
ALERT_CAP = 50              # tickers stored per added/removed list (true counts kept)
ALERT_RETENTION_DAYS = 120
CHART_TIME_BOX_S = 600      # publish_chart_series aborts cleanly after 10 minutes
CHART_BUDGET_BYTES = 25 * 1024 * 1024
CHART_BATCH = 500
SCREENS_MAX_ELAPSED_MIN = 240   # default; env SCREENS_MAX_ELAPSED_MIN overrides

_SIG_MONEY = 6              # price / market cap: 712,345 must not become 712,300
_SIG_OTHER = 4              # ratios, scores, shares


def _err(e: BaseException) -> dict:
    """The ONLY way an exception from these jobs is recorded: class + SQLSTATE, never
    the message text (see module doc)."""
    return {"error": type(e).__name__, "sqlstate": getattr(e, "sqlstate", None)}


def _max_elapsed_min() -> float:
    try:
        return float(os.getenv("SCREENS_MAX_ELAPSED_MIN", "") or SCREENS_MAX_ELAPSED_MIN)
    except ValueError:
        return float(SCREENS_MAX_ELAPSED_MIN)


def _as_date(asof) -> date:
    return asof if isinstance(asof, date) else date.fromisoformat(str(asof)[:10])


# ---- projection -------------------------------------------------------------------

def _sig(x, n: int):
    if not isinstance(x, float) or x == 0 or not math.isfinite(x):
        return x
    return round(x, n - 1 - int(math.floor(math.log10(abs(x)))))


def _py(v):
    """Scalar/list -> plain JSON-safe Python, by pipeline._clean's rules (NaN/inf ->
    None, numpy -> python, Timestamp -> ISO; tests/test_screenjobs.py checks parity)
    plus what it doesn't cover: numpy arrays, pandas NA/NaT. Not imported from
    engine.pipeline, which drags in yfinance & co. — this module must import with
    pandas/numpy alone so its tests run anywhere."""
    import numpy as np
    import pandas as pd

    if isinstance(v, dict):
        return {k: _py(x) for k, x in v.items()}
    if isinstance(v, np.ndarray):
        v = v.tolist()
    if isinstance(v, (list, tuple)):
        return [_py(x) for x in v]
    if v is None or v is pd.NA or v is pd.NaT:
        return None
    if isinstance(v, np.integer):
        return int(v)
    if isinstance(v, (np.floating, float)):
        return None if (np.isnan(v) or np.isinf(v)) else float(v)
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, pd.Timestamp):
        return v.isoformat()
    return v


def project_stock_rows(frame, flagged: dict | None = None) -> tuple[list[dict], dict]:
    """score_frame output -> (rows keyed by the stock registry fields, info).

    data_ok = no exclusion reason (picks.exclusion_reasons — the same gate as the
    dashboard's picks and on-sale list); data_flags = the reason codes. info carries
    the per-reason counts (overlapping), the hidden count and enum drift (data values
    the static registry enums don't know, so drift shows up in the pipeline report)."""
    from . import picks

    reg = screens.registry()
    keys = screens.field_keys("stocks")
    types = {k: reg.fields[k]["type"] for k in keys}
    if frame is None or len(frame) == 0:
        return [], {"n_hidden": 0, "excluded_counts": {}, "enum_drift": {}}
    why = picks.exclusion_reasons(frame, flagged or {})
    reason_cols = list(why.columns)
    flags = why.to_numpy()
    recs = frame.to_dict("records")
    rows: list[dict] = []
    for i, rec in enumerate(recs):
        row = {}
        for k in keys:
            if k in ("data_ok", "data_flags"):
                continue
            v = _py(rec.get(k))
            t = types[k]
            if t in ("text", "enum") and v == "":
                v = None
            elif t == "money":
                v = _sig(v, _SIG_MONEY)
            elif t in ("number", "percent"):
                v = _sig(v, _SIG_OTHER)
            row[k] = v
        codes = [c for c, hit in zip(reason_cols, flags[i]) if hit]
        row["data_ok"] = not codes
        row["data_flags"] = codes
        rows.append(row)
    counts = {c: int(why[c].sum()) for c in reason_cols if why[c].any()}
    drift = {}
    for k in keys:
        if types[k] == "enum":
            known = set(reg.fields[k]["enum"])
            n = sum(1 for r in rows if r.get(k) is not None and r[k] not in known)
            if n:
                drift[k] = n
    info = {"n_hidden": sum(1 for r in rows if not r["data_ok"]),
            "excluded_counts": counts, "enum_drift": drift}
    return rows, info


def coverage(rows: list[dict]) -> dict:
    """Shares of rows with a price AND a market cap (needs prices AND fundamentals —
    either outage drops it to ~0), and with a P/E. P/E alone is only ~0.64 on a
    healthy day (loss-makers have none), so it is compared run-over-run instead."""
    n = len(rows)
    if not n:
        return {"price_mcap": 0.0, "pe": 0.0}
    return {"price_mcap": round(sum(1 for r in rows if r.get("price") is not None
                                    and r.get("market_cap") is not None) / n, 4),
            "pe": round(sum(1 for r in rows if r.get("pe") is not None) / n, 4)}


def previous_snapshot(conn) -> dict | None:
    """{'rows': n, 'coverage': {...}|None} of the stored stock snapshot, or None."""
    with conn.cursor() as cur:
        cur.execute("select jsonb_array_length(payload->'rows'), payload->'coverage' "
                    "from public.screener_snapshots where scope = 'stocks'")
        r = cur.fetchone()
    if not r:
        return None
    return {"rows": int(r[0] or 0), "coverage": r[1] if isinstance(r[1], dict) else None}


def coverage_guard(rows: list[dict], prev: dict | None) -> dict | None:
    """None when it's safe to publish, else the steps['screens'] skip record."""
    cov = coverage(rows)
    prev_n = (prev or {}).get("rows") or 0
    prev_pe = ((prev or {}).get("coverage") or {}).get("pe")
    bad = (cov["price_mcap"] < COVERAGE_MIN
           or (prev_n and len(rows) < SHRINK_MIN * prev_n)
           or (isinstance(prev_pe, (int, float)) and cov["pe"] < PE_COVERAGE_KEEP * prev_pe))
    if not bad:
        return None
    return {"skipped": "low_coverage", "coverage": cov["price_mcap"], "pe_coverage": cov["pe"],
            "rows": len(rows), "previous_rows": prev_n or None}


# ---- snapshot ---------------------------------------------------------------------

def publish_stock_snapshot(conn, rows: list[dict], asof, info: dict | None = None) -> dict:
    """Upsert the columnar stock snapshot. Caller commits."""
    info = info or {}
    keys = screens.field_keys("stocks")
    payload = {"v": 1, "asof": str(asof)[:10], "fields": keys,
               "rows": [[r.get(k) for k in keys] for r in rows],
               "n": len(rows), "n_hidden": info.get("n_hidden", 0),
               "excluded_counts": info.get("excluded_counts", {}),
               "coverage": coverage(rows)}
    body = json.dumps(payload, allow_nan=False, separators=(",", ":"))
    with conn.cursor() as cur:
        cur.execute(
            "insert into public.screener_snapshots (scope, asof, payload, updated_at) "
            "values ('stocks', %s, %s::jsonb, now()) "
            "on conflict (scope) do update set asof = excluded.asof, "
            "payload = excluded.payload, updated_at = now()",
            (str(asof)[:10], body))
    return {"rows": len(rows), "hidden": info.get("n_hidden", 0),
            "bytes": len(body)}


# ---- chart series -----------------------------------------------------------------

class _TimeBox(Exception):
    pass


def publish_chart_series(conn, asof, tickers=None, *, con=None, universe=None,
                         deadline_s: float = CHART_TIME_BOX_S,
                         budget_bytes: int = CHART_BUDGET_BYTES) -> dict:
    """Rebuild chart_series from Tier B: the last LONG_AVG_DAYS trading days of closes
    on one shared calendar, plus the cleaned annual revenue / net income series the
    growth record fields are computed from (growthhistory.annual_series, the same call
    and input stockvaluation uses). All-or-nothing in one transaction; aborts cleanly
    past `deadline_s` and skips (with a warning) when the projected size exceeds
    `budget_bytes`. `tickers` limits it to the published snapshot's names; `con` /
    `universe` are injectable for tests."""
    import numpy as np
    import pandas as pd

    from . import growthhistory, stockvaluation, tierb
    from .config import LONG_AVG_DAYS

    t0 = time.monotonic()

    def check():
        if time.monotonic() - t0 > deadline_s:
            raise _TimeBox()

    con = con if con is not None else tierb.connect()
    uni = universe if universe is not None else stockvaluation._universe(None)
    uni = uni.dropna(subset=["security_id", "ticker"])
    if tickers is not None:
        uni = uni[uni["ticker"].isin(set(tickers))]
    tk = {int(s): str(t) for s, t in zip(uni["security_id"], uni["ticker"])}
    if not tk:
        return {"skipped": "no universe"}
    try:
        px = con.execute(
            "select security_id, date, close from prices "
            "where date <= ? and date >= ?::date - to_days(?) and close is not null "
            "order by security_id, date",
            [str(asof)[:10], str(asof)[:10], int(LONG_AVG_DAYS * 1.46)]).df()
        px = px[px["security_id"].isin(list(tk))]
        if px.empty:
            return {"skipped": "no prices"}
        px["date"] = pd.to_datetime(px["date"])
        # One calendar for every row: the trading days most of the universe printed
        # (more than half of them): a stray holiday bar from one ticker doesn't add a
        # column of nulls to every row.
        per_day = px.groupby("date")["security_id"].nunique()
        cal = per_day[per_day > 0.5 * per_day.max()].index.sort_values()[-LONG_AVG_DAYS:]
        start = cal[0]
        days = [int((d - start).days) for d in cal]
        wide = px.pivot_table(index="security_id", columns="date", values="close",
                              aggfunc="last").reindex(columns=cal)
        check()

        rows = tierb.metrics_asof(str(asof)[:10], metric_codes=list(stockvaluation.FLOW_CODES),
                                  security_ids=list(tk), source="xbrl", con=con)
        fm = pd.DataFrame(rows, columns=tierb.FM_COLUMNS)
        fm["period_end"] = pd.to_datetime(fm["period_end"])
        fm["value"] = pd.to_numeric(fm["value"], errors="coerce")
        flow = fm[fm["metric_code"].isin(stockvaluation.FLOW_CODES) & (fm["fiscal_period"] == "FY")]
        annual = growthhistory.annual_series(flow) if not flow.empty else pd.DataFrame()
        rc = (flow[flow["metric_code"].isin(["total_revenue", "net_income"])]
              .sort_values(["period_end", "filed_date"]).groupby("security_id")["unit"].last()
              if not flow.empty else pd.Series(dtype=object))
        fund: dict[int, dict] = {}
        if not annual.empty:
            for sid, g in annual.groupby("security_id", sort=False):
                g = g.sort_values("period_end").tail(growthhistory.WINDOW_YEARS + 1)
                cur_ = rc.get(sid)
                fund[int(sid)] = {
                    "period_end": [d.date().isoformat() for d in pd.to_datetime(g["period_end"])],
                    "revenue": [_py(v) for v in g["total_revenue"].astype(float)],
                    "net_income": [_py(v) for v in g["net_income"].astype(float)],
                    "currency": cur_ if isinstance(cur_, str) else None}
        check()

        a = str(asof)[:10]
        s0 = start.date().isoformat()
        batch = [("calendar:us", "calendar", a, s0, days, None, None)]
        size = 64 + 2 * len(days)
        n_stock = 0
        for sid, t in sorted(tk.items(), key=lambda kv: kv[1]):
            closes = None
            if sid in wide.index:
                arr = wide.loc[sid].to_numpy(dtype=float)
                if np.isfinite(arr).any():
                    closes = [float(v) if np.isfinite(v) else None for v in arr]
            f = fund.get(sid)
            if closes is None and f is None:
                continue
            fj = json.dumps(f, allow_nan=False, separators=(",", ":")) if f else None
            batch.append((f"stock:{t}", "stock", a, s0, None, closes, fj))
            size += 64 + len(t) + (4 * len(closes) + len(closes) // 8 if closes else 0) \
                + (len(fj) if fj else 0)
            n_stock += 1
        if size > budget_bytes:
            print(f"   WARNING: chart series skipped — projected {size / 1e6:.1f} MB "
                  f"over the {budget_bytes / 1e6:.0f} MB budget (ADR-037)")
            return {"skipped": "size_budget", "projected_mb": round(size / 1e6, 1)}
        check()

        sql = ("insert into public.chart_series "
               "(key, kind, asof, start_date, days, closes, fundamentals, updated_at) "
               "values (%s, %s, %s, %s, %s::int2[], %s::real[], %s::jsonb, now()) "
               "on conflict (key) do update set kind = excluded.kind, asof = excluded.asof, "
               "start_date = excluded.start_date, days = excluded.days, "
               "closes = excluded.closes, fundamentals = excluded.fundamentals, "
               "updated_at = now()")
        with conn.transaction():
            with conn.cursor() as cur:
                for i in range(0, len(batch), CHART_BATCH):
                    check()
                    cur.executemany(sql, batch[i:i + CHART_BATCH])
                # Names that left the universe: their stale series go with this write.
                cur.execute("delete from public.chart_series where kind = 'stock' "
                            "and asof is distinct from %s", (a,))
                pruned = cur.rowcount
    except _TimeBox:
        print(f"   WARNING: chart series aborted after {deadline_s:.0f}s time box — nothing written")
        return {"skipped": "time_box", "seconds": round(time.monotonic() - t0)}
    out = {"stocks": n_stock, "days": len(days), "start": s0, "pruned": max(int(pruned or 0), 0),
           "projected_mb": round(size / 1e6, 2), "seconds": round(time.monotonic() - t0, 1)}
    try:
        with conn.cursor() as cur:
            cur.execute("select pg_total_relation_size('public.chart_series')")
            r = cur.fetchone()
        out["table_mb"] = round((r[0] or 0) / 1e6, 2) if r else None
    except Exception as e:  # noqa: BLE001 — a size probe must not fail the write
        out["table_mb"] = _err(e)
    return out


# ---- alerts -----------------------------------------------------------------------

_SCREENS_SQL = """
select s.id, s.user_id, s.filter, s.last_matches, s.last_evaluated_asof, s.universe_n,
       (s.scope <> 'stocks' or coalesce(
          u.email_confirmed_at is not null
          and (lower(u.email) in (select lower(a.email) from public.admins a)
               or lower(u.email) in (select lower(l.email) from public.app_allowlist l
                                     where l.can_view_prices)), false)) as allowed
from public.saved_screens s
join auth.users u on u.id = s.user_id
where s.alerts_enabled and s.scope = %s
order by s.id
"""


def run_alerts(conn, scope: str, rows: list[dict], asof) -> dict:
    """Diff every alerting `scope` screen against its stored baseline; write
    screen_alerts rows. Membership = the FULL match set of `where` (+ data_ok unless
    include_flagged) — sort/limit ignored, so rank churn inside a top-N never alerts.

    Stock screens count only while their owner is trusted (confirmed address in
    admins, or allowlisted with can_view_prices) — checked here, at run time, because
    this job runs as the table owner and bypasses RLS; others are counted
    `skipped_untrusted` and left untouched. First evaluation stores a baseline and
    alerts nothing; a universe < SHRINK_MIN x the stored one is not diffed; a screen
    already evaluated for `asof` is skipped. Names that left only because their data
    checks flipped are reported in hidden_data_issue, not as removed.

    Each screen runs in its own savepoint; any failure counts `skipped_invalid` and
    the loop goes on. Returns aggregate counts only. Caller commits."""
    asof_d = _as_date(asof)
    n_univ = len(rows)
    st = {"screens": 0, "alerts": 0, "baselines": 0, "unchanged": 0,
          "skipped_untrusted": 0, "skipped_invalid": 0, "skipped_same_asof": 0,
          "skipped_shrunk": 0, "skipped_changed": 0, "universe": n_univ}
    errors: dict[str, int] = {}
    with conn.cursor() as cur:
        cur.execute(_SCREENS_SQL, (scope,))
        screens_ = cur.fetchall()
    for sid, uid, flt, last, last_asof, univ_n, allowed in screens_:
        st["screens"] += 1
        if not allowed:
            st["skipped_untrusted"] += 1
            continue
        if last_asof is not None and _as_date(last_asof) == asof_d:
            st["skipped_same_asof"] += 1
            continue
        if univ_n and n_univ < SHRINK_MIN * univ_n:
            st["skipped_shrunk"] += 1
            continue
        try:
            res = screens.validate(flt, scope)
            if not res["ok"]:
                st["skipped_invalid"] += 1
                continue
            fl = res["filter"]
            now = set(screens.matching_keys(fl, rows))
            where_only = now if fl.get("include_flagged") else \
                set(screens.matching_keys(dict(fl, include_flagged=True), rows))
            baseline = not (isinstance(last, list) and all(isinstance(k, str) for k in last))
            with conn.transaction():
                with conn.cursor() as cur:
                    # Guarded on the filter we evaluated: if the user edited the screen
                    # meanwhile, the trigger has reset its baseline — leave it be.
                    cur.execute(
                        "update public.saved_screens set last_matches = %s::jsonb, "
                        "last_evaluated_asof = %s, universe_n = %s "
                        "where id = %s and filter = %s::jsonb",
                        (json.dumps(sorted(now)), asof_d, n_univ, sid,
                         json.dumps(flt, allow_nan=False)))
                    if cur.rowcount == 0:
                        st["skipped_changed"] += 1
                        continue
                    if baseline:
                        st["baselines"] += 1
                        continue
                    prev = set(last)
                    gone = prev - now
                    hidden = sorted(gone & where_only)
                    added, removed = sorted(now - prev), sorted(gone - set(hidden))
                    if not (added or removed or hidden):
                        st["unchanged"] += 1
                        continue
                    cur.execute(
                        "insert into public.screen_alerts (user_id, screen_id, asof, added, "
                        "removed, n_added, n_removed, hidden_data_issue) "
                        "values (%s, %s, %s, %s::text[], %s::text[], %s, %s, %s::text[]) "
                        "on conflict (screen_id, asof) do nothing",
                        (uid, sid, asof_d, added[:ALERT_CAP], removed[:ALERT_CAP],
                         len(added), len(removed), hidden[:ALERT_CAP]))
                    st["alerts"] += max(cur.rowcount, 0)
        except Exception as e:  # noqa: BLE001 — one bad screen never stops the rest
            st["skipped_invalid"] += 1
            name = _err(e)["error"]
            errors[name] = errors.get(name, 0) + 1
    with conn.cursor() as cur:
        cur.execute("delete from public.screen_alerts "
                    f"where created_at < now() - interval '{int(ALERT_RETENTION_DAYS)} days'")
        st["pruned"] = max(cur.rowcount, 0)
    if errors:
        st["errors"] = errors
    return st


def run_market_alerts(rows: list[dict], asof) -> dict:
    """Weekly hook (engine/pipeline.py): market-scope alerts over the exact scoreboard
    rows written to dashboard_data.json. Best-effort; never raises."""
    try:
        if not db.have_db():
            return {"skipped": "no database"}
        n = len(rows)
        pe = sum(1 for r in rows if r.get("pe") is not None) / n if n else 0.0
        if pe < MARKET_PE_MIN:
            return {"skipped": "low_coverage", "pe_coverage": round(pe, 3), "rows": n}
        with db.connect() as conn:
            try:
                res = run_alerts(conn, "markets", rows, asof)
                conn.commit()
            except Exception:
                conn.rollback()
                raise
        return res
    except Exception as e:  # noqa: BLE001
        return _err(e)


# ---- the daily step -----------------------------------------------------------------

def _gate(full_ingest: bool, t_start: float | None) -> dict | None:
    """None when the daily step should run, else its steps['screens'] skip record."""
    if os.getenv("SCREENS_DAILY", "").strip() == "0":
        return {"skipped": "disabled (SCREENS_DAILY=0)"}
    if full_ingest:
        # The monthly full sweep ran 308 min against the 360-min job limit (ADR-037);
        # a skipped day costs nothing — tomorrow's run catches up.
        return {"skipped": "full sweep"}
    if not db.have_db():
        return {"skipped": "no database"}
    from . import tierb
    if not (tierb.enabled() and tierb.have_prices()):
        return {"skipped": "Tier B prices not available"}
    if t_start is not None:
        el = (time.monotonic() - t_start) / 60
        if el > _max_elapsed_min():
            return {"skipped": "elapsed", "elapsed_min": round(el)}
    return None


def _step(conn, fn, *args, **kw) -> dict:
    try:
        out = fn(conn, *args, **kw)
        conn.commit()
        return out
    except Exception as e:  # noqa: BLE001
        try:
            conn.rollback()
        except Exception:  # noqa: BLE001
            pass
        return _err(e)


def run_daily(asof=None, *, full_ingest: bool = False, t_start: float | None = None) -> dict:
    """The daily screens step (engine/datapipeline.py): score the universe, publish
    the snapshot, run stock alerts, then the chart series (slowest last, and skipped
    once the run is past SCREENS_MAX_ELAPSED_MIN). Never raises; aggregate counts only."""
    t0 = time.monotonic()
    try:
        out = _run_daily(asof, full_ingest, t_start)
    except Exception as e:  # noqa: BLE001
        out = _err(e)
    if "skipped" not in out or "rows" in out:
        out["seconds"] = round(time.monotonic() - t0)
    return out


def _run_daily(asof, full_ingest: bool, t_start: float | None) -> dict:
    skip = _gate(full_ingest, t_start)
    if skip:
        return skip
    from . import quality, stockvaluation
    asof = str(asof or date.today().isoformat())[:10]
    frame = stockvaluation.score_frame(asof)
    flagged = quality.open_flags_by_entity()
    rows, info = project_stock_rows(frame, flagged)
    out: dict = {"rows": len(rows), "hidden": info["n_hidden"],
                 "coverage": coverage(rows)["price_mcap"]}
    if info["enum_drift"]:
        out["enum_drift"] = info["enum_drift"]
    with db.connect() as conn:
        guard = coverage_guard(rows, previous_snapshot(conn))
        conn.rollback()     # end the read transaction; each step below commits its own
        if guard:
            out.update(guard)
            return out
        out["snapshot"] = _step(conn, publish_stock_snapshot, rows, asof, info)
        if "error" in out["snapshot"]:
            out["alerts"] = {"skipped": "snapshot not published"}
        else:
            out["alerts"] = _step(conn, run_alerts, "stocks", rows, asof)
        if t_start is not None and (time.monotonic() - t_start) / 60 > _max_elapsed_min():
            out["chart_series"] = {"skipped": "elapsed"}
        else:
            out["chart_series"] = _step(conn, publish_chart_series, asof,
                                        tickers={r["ticker"] for r in rows if r.get("ticker")})
    return out


if __name__ == "__main__":
    print(json.dumps(run_daily(), indent=2, default=str))
