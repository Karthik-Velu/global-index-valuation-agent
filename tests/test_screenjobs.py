"""Screener job tests (engine/screenjobs.py + picks.exclusion_reasons) — no database,
no network. Needs pandas + numpy (+ duckdb for the chart-series test, skipped without
it); no pytest needed:

    python tests/test_screenjobs.py

Postgres is a fake connection/cursor that records every statement; Tier B is a real
in-memory DuckDB with synthetic `prices` / `fundamental_metrics`. All tickers are
fictitious (FX…). pytest will collect the test_* functions too.
"""
from __future__ import annotations

import contextlib
import io
import json
import math
import random
import re
import sys
import time
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402

from engine import db, picks, screenjobs, screens  # noqa: E402

FIX = ROOT / "tests" / "fixtures"
SECRET_UUID = "7f3c2a9e-1111-4222-8333-944455556666"
SECRET_TICKER = "FXSECRET"

try:
    from psycopg.errors import CheckViolation  # the real class the job would see
except Exception:  # noqa: BLE001 — psycopg not installed: same shape, fake class
    class CheckViolation(Exception):
        sqlstate = "23514"


def _boom():
    return CheckViolation(
        'new row for relation "screen_alerts" violates check constraint "x"\n'
        f"DETAIL:  Failing row contains ({SECRET_UUID}, {SECRET_TICKER}, 2026-10-14).")


# ---- fakes --------------------------------------------------------------------------

def _norm(sql: str) -> str:
    return " ".join(sql.split())


class FakeCursor:
    def __init__(self, conn):
        self.conn, self._rows, self.rowcount = conn, [], -1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        s = _norm(sql)
        self.conn.log.append(("execute", s, params))
        self._rows, self.rowcount = self.conn.respond(s, params)

    def executemany(self, sql, seq):
        seq = list(seq)
        self.conn.log.append(("executemany", _norm(sql), seq))
        self.rowcount = len(seq)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class FakeConn:
    """handlers: [(sql substring, fn(params) -> (rows, rowcount))]; fn may raise."""

    def __init__(self, handlers=()):
        self.handlers, self.log = list(handlers), []
        self.commits = self.rollbacks = 0

    def respond(self, sql, params):
        for sub, fn in self.handlers:
            if sub in sql:
                return fn(params)
        return [], 1

    def cursor(self):
        return FakeCursor(self)

    @contextlib.contextmanager
    def transaction(self):
        self.log.append(("savepoint", None, None))
        try:
            yield
        except BaseException:
            self.log.append(("rollback_to", None, None))
            raise
        self.log.append(("release", None, None))

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def sql(self, kind=None):
        return [s for k, s, _ in self.log if kind is None or k == kind]

    def calls(self, sub):
        return [(k, s, p) for k, s, p in self.log if s and sub in s]


@contextlib.contextmanager
def patched(obj, **attrs):
    old = {k: getattr(obj, k) for k in attrs}
    try:
        for k, v in attrs.items():
            setattr(obj, k, v)
        yield
    finally:
        for k, v in old.items():
            setattr(obj, k, v)


# ---- picks.exclusion_reasons / picks.build unchanged --------------------------------

def _frame_fixture():
    d = json.loads((FIX / "jobs_picks_frame.json").read_text(encoding="utf-8"))
    return pd.DataFrame(d["rows"]), {k: set(v) for k, v in d["flagged"].items()}


def _norm_json(x):
    return json.loads(json.dumps(x, sort_keys=True, default=str))


def test_picks_build_matches_golden():
    """Before/after: the golden file is the PRE-extraction picks.build() output on the
    same synthetic frame (generated from the original module, committed)."""
    df, flagged = _frame_fixture()
    got = picks.build(None, df, flagged, {"evaluations": 3, "avg_rank_ic": 0.05})
    want = json.loads((FIX / "jobs_picks_golden.json").read_text(encoding="utf-8"))
    assert _norm_json(got) == want, "picks.build output changed"
    assert want["stocks"] and want["on_sale"]["stocks"], "fixture must exercise the selection"
    assert all(want["excluded"].values()), want["excluded"]


def _legacy(stocks, flagged):
    """Verbatim pre-extraction selection logic of picks.build (stock half)."""
    bad = {t for t, checks in flagged.items() if checks & picks.EXCLUDE_CHECKS}
    record = (stocks["hist_years"].fillna(0) >= picks.MIN_CHANGES) if "hist_years" in stocks \
        else pd.Series(True, index=stocks.index)
    clean = ~stocks["ticker"].isin(bad) & picks._domestic(stocks) & record
    liquid = stocks["market_cap"].fillna(0) >= picks.PICK_MIN_MARKET_CAP
    strong = picks._eligible(stocks)
    s = stocks[strong & clean & liquid].sort_values("opportunity_score", ascending=False)
    sale = stocks[stocks["on_sale"].fillna(False).astype(bool) & clean & liquid] \
        .sort_values("opportunity_score", ascending=False)
    on_sale_all = stocks["on_sale"].fillna(False).astype(bool)
    excluded = {
        "strong_with_data_issues": int((strong & stocks["ticker"].isin(bad)).sum()),
        "foreign_listings": int((~picks._domestic(stocks)).sum()),
        "short_history": int((strong & ~record).sum()),
        "on_sale_with_data_issues": int((on_sale_all & ~clean).sum()),
        "non_usd_reporters": int((stocks.get("reporting_currency", pd.Series(dtype=object))
                                  .fillna("USD").str.upper() != "USD").sum()),
        "implausible_valuation": int((~stocks["data_sane"].fillna(True).astype(bool)).sum()),
    }
    return (list(s.head(picks.N_STOCKS)["ticker"]), list(sale.head(picks.N_ON_SALE)["ticker"]),
            excluded)


def _random_frame(seed: int, n: int = 60) -> tuple[pd.DataFrame, dict]:
    rnd = random.Random(seed)
    rows = []
    for i in range(n):
        rows.append({
            "ticker": f"FX{i:03d}", "name": f"Fixture {i}", "kind": "Technology",
            "country": rnd.choice(["United States", None, "Canada", "United States"]),
            "reporting_currency": rnd.choice(["USD", None, "EUR", "usd", "Usd"]),
            "market_cap": rnd.choice([np.nan, 5e8, 3e9, 4e10]),
            "pe": rnd.choice([np.nan, 2.0, 15.0, -3.0]), "ps": rnd.choice([np.nan, 0.01, 2.0]),
            "hist_years": rnd.choice([np.nan, 0, 2, 3, 6]),
            "data_sane": rnd.choice([True, False]),
            "fundamentally_strong": rnd.choice([True, False, True]),
            "overvalued": rnd.choice([True, False, None]),
            "on_sale": rnd.choice([True, False, None]),
            "opportunity_score": rnd.uniform(0, 100),
        })
    checks = sorted(picks.EXCLUDE_CHECKS) + ["unrelated_check"]
    flagged = {r["ticker"]: {rnd.choice(checks)} for r in rows if rnd.random() < 0.3}
    return pd.DataFrame(rows), flagged


def test_picks_build_matches_legacy_on_random_frames():
    for seed in range(25):
        df, flagged = _random_frame(seed)
        got = picks.build(None, df, flagged)
        top, sale, excluded = _legacy(df, flagged)
        assert [c["ticker"] for c in got["stocks"]] == top, seed
        assert [c["ticker"] for c in got["on_sale"]["stocks"]] == sale, seed
        assert got["excluded"] == excluded, (seed, got["excluded"], excluded)


def test_picks_build_edge_shapes():
    """No hist_years / reporting_currency / country columns, string dtype currency,
    duplicate index labels: same answers as the legacy code."""
    df, flagged = _random_frame(99, 30)
    variants = [df.drop(columns=["hist_years"]), df.drop(columns=["reporting_currency"]),
                df.drop(columns=["country"]),
                df.assign(reporting_currency=df["reporting_currency"].astype("string")),
                df.set_axis([0, 0, 1] * 10)]
    for v in variants:
        got = picks.build(None, v, flagged)
        top, sale, excluded = _legacy(v, flagged)
        assert [c["ticker"] for c in got["stocks"]] == top
        assert [c["ticker"] for c in got["on_sale"]["stocks"]] == sale
        assert got["excluded"] == excluded, (got["excluded"], excluded)


def test_exclusion_reasons_columns_and_semantics():
    df = pd.DataFrame({
        "ticker": ["FXA", "FXB", "FXC", "FXD", "FXE", "FXF"],
        "pe": [2.0, 15.0, np.nan, -4.0, 15.0, 15.0],
        "ps": [1.0, 0.01, 1.0, 1.0, 1.0, 1.0],
        "market_cap": [1e9, 1e9, 1e8, np.nan, 1e9, 1e9],
        "reporting_currency": ["USD", None, "EUR", "usd", "USD", "USD"],
        "country": ["United States", None, "Canada", "United States", "United States", None],
        "hist_years": [6, 6, np.nan, 2, 6, 3],
    })
    why = picks.exclusion_reasons(df, {"FXE": {"timeseries_jump", "unrelated"}, "FXF": {"unrelated"}})
    assert list(why.columns[:6]) == ["implausible_pe", "implausible_ps", "below_min_mcap",
                                     "non_usd_reporter", "foreign_listing", "short_history"]
    assert {c for c in why.columns[6:]} == {"quality:" + c for c in picks.EXCLUDE_CHECKS}
    assert all(why[c].dtype == bool for c in why.columns)
    hits = {t: [c for c in why.columns if why.loc[i, c]] for i, t in enumerate(df["ticker"])}
    assert hits == {
        "FXA": ["implausible_pe"],
        "FXB": ["implausible_ps"],                                  # NULL ccy / country pass
        "FXC": ["below_min_mcap", "non_usd_reporter", "foreign_listing", "short_history"],
        "FXD": ["short_history"],                                   # 'usd' is USD; NaN mcap passes
        "FXE": ["quality:timeseries_jump"],                         # unrelated check ignored
        "FXF": [],
    }, hits


def test_exclusion_reasons_agree_with_data_sane():
    """The three plausibility reasons + non-USD are exactly ~strategies.data_sane."""
    from engine import strategies
    rnd = random.Random(7)
    df = pd.DataFrame({
        "pe": [rnd.choice([np.nan, 1.0, 2.99, 3.0, 20.0, -1.0]) for _ in range(200)],
        "ps": [rnd.choice([np.nan, 0.04, 0.05, 3.0]) for _ in range(200)],
        "market_cap": [rnd.choice([np.nan, 2.9e8, 3e8, 1e10]) for _ in range(200)],
        "reporting_currency": [rnd.choice([None, "USD", "usd", "EUR"]) for _ in range(200)],
        "overvalued": False, "ticker": [f"FX{i}" for i in range(200)],
    })
    sane = strategies.apply(df)["data_sane"].astype(bool)
    why = picks.exclusion_reasons(df)
    insane = why[["implausible_pe", "implausible_ps", "below_min_mcap", "non_usd_reporter"]].any(axis=1)
    assert (insane == ~sane).all()


# ---- projection -----------------------------------------------------------------------

def _score_frame_like(n: int = 10) -> pd.DataFrame:
    rows = []
    for i in range(n):
        rows.append({
            "security_id": i + 1, "ticker": f"FX{chr(65 + i)}", "name": f"Fixture {chr(65 + i)} Inc",
            "sector": ["Technology", "Healthcare", "", None, "Space Mining"][i % 5],
            "country": "Canada" if i in (0, 4, 8) else ("United States" if i % 3 else None),
            "currency": "USD",
            "reporting_currency": "USD" if i != 3 else "EUR",
            "market_cap": 712345678.9 * (i + 1), "price": 123.456789 + i,
            "pe": [15.123456, np.nan, 2.5, 30.0][i % 4], "pb": np.float64(2.345678), "ps": 1.5,
            "pcf": np.nan, "dividend_yield": 0.0123456,
            "value_score": np.float64(66.666666), "growth_score": 55.55555,
            "consistency_score": np.nan, "opportunity_score": 70.0,
            "rev_growth": 0.123456, "earnings_growth": -0.05, "rev_cagr": 0.0812345,
            "ni_cagr": 0.1, "rev_up_ratio": 0.833333, "ni_up_ratio": 0.666667, "ni_pos_ratio": 1.0,
            "hist_years": np.int64(6) if i != 5 else np.nan,
            "discount_long": -0.1234567, "long_avg_years": 2.0,
            "on_sale": np.bool_(i % 2 == 0), "fundamentally_strong": True,
            "steady_compounder": bool(i % 3 == 0), "deep_value_intact": False,
            "turning_up": None, "garp": np.bool_(True), "value_trap": False,
            "strategies": np.array(["on_sale"]) if i % 2 == 0 else [],
            "ret_12m": 0.5, "momentum_score": 99.0,    # never projected
        })
    return pd.DataFrame(rows)


def test_project_stock_rows_shape_types_rounding():
    frame = _score_frame_like()
    rows, info = screenjobs.project_stock_rows(frame, {"FXC": {"stale_filings"}})
    keys = screens.field_keys("stocks")
    assert len(rows) == 10 and all(list(r) == [k for k in keys if k not in ("data_ok", "data_flags")]
                                   + ["data_ok", "data_flags"] for r in rows)
    assert "ret_12m" not in rows[0] and "momentum_score" not in rows[0]
    json.dumps(rows, allow_nan=False)           # no NaN / numpy left anywhere
    a = rows[0]
    assert a["market_cap"] == 712346000.0 and a["price"] == 123.457     # 6 significant figures
    assert a["pe"] == 15.12 and a["value_score"] == 66.67 and a["discount_long"] == -0.1235
    assert a["rev_up_ratio"] == 0.8333 and a["hist_years"] == 6     # float: the column has a NaN
    assert a["on_sale"] is True and a["garp"] is True and a["turning_up"] is None
    assert a["strategies"] == ["on_sale"] and rows[1]["strategies"] == []
    assert rows[1]["pe"] is None and rows[0]["pcf"] is None and rows[0]["consistency_score"] is None
    assert rows[2]["sector"] is None and rows[3]["sector"] is None      # '' -> None
    by = {r["ticker"]: r for r in rows}
    assert by["FXA"]["data_ok"] is False and by["FXA"]["data_flags"] == ["foreign_listing"]
    assert by["FXB"]["data_ok"] is True and by["FXB"]["data_flags"] == []
    assert by["FXC"]["data_flags"] == ["implausible_pe", "quality:stale_filings"]
    assert by["FXD"]["data_flags"] == ["non_usd_reporter"]
    assert by["FXF"]["data_flags"] == ["short_history"]
    assert info["n_hidden"] == sum(not r["data_ok"] for r in rows)
    assert info["excluded_counts"]["foreign_listing"] == 3
    assert info["enum_drift"] == {"sector": 2}                          # 'Space Mining' x2
    # The projected rows are what screens.evaluate expects: data_ok gating works.
    res = screens.evaluate({"v": 1, "scope": "stocks", "where": []}, rows)
    assert res["total"] == sum(r["data_ok"] for r in rows)


def test_py_matches_pipeline_clean():
    """_py follows engine.pipeline._clean's rules (where pipeline is importable — it
    needs yfinance & co.) and also handles numpy arrays and pandas NA/NaT."""
    vals = [1.5, float("nan"), float("inf"), np.float64(2.5), np.float32(np.nan), np.int64(7),
            np.bool_(True), True, None, "FXA", pd.Timestamp("2026-10-14"), [np.int64(1), np.nan],
            {"a": np.float64(1.0), "b": float("-inf")}, 3]
    try:
        from engine.pipeline import _clean
    except ImportError:
        _clean = None
    for v in vals:
        got = screenjobs._py(v)
        json.dumps(got, allow_nan=False)
        if _clean is not None:
            assert got == _clean(v) and type(got) is type(_clean(v)), (v, got, _clean(v))
    assert screenjobs._py(np.array(["x", "y"])) == ["x", "y"]
    assert screenjobs._py(pd.NA) is None and screenjobs._py(pd.NaT) is None


def test_project_stock_rows_empty():
    rows, info = screenjobs.project_stock_rows(pd.DataFrame(), {})
    assert rows == [] and info["n_hidden"] == 0


# ---- coverage guard ---------------------------------------------------------------

def _cov_rows(n, priced, pe_share=0.6):
    return [{"price": 1.0 if i < priced else None, "market_cap": 1e9 if i < priced else None,
             "pe": 10.0 if i < pe_share * n else None} for i in range(n)]


def test_coverage_guard():
    healthy = _cov_rows(100, 92)
    assert screenjobs.coverage_guard(healthy, None) is None
    assert screenjobs.coverage_guard(healthy, {"rows": 101, "coverage": {"pe": 0.64}}) is None
    g = screenjobs.coverage_guard(_cov_rows(100, 10), None)                   # price outage
    assert g["skipped"] == "low_coverage" and g["coverage"] == 0.1
    g = screenjobs.coverage_guard(healthy, {"rows": 120, "coverage": None})   # shrunk >10%
    assert g and g["previous_rows"] == 120
    g = screenjobs.coverage_guard(_cov_rows(100, 92, 0.3), {"rows": 100, "coverage": {"pe": 0.64}})
    assert g and g["pe_coverage"] == 0.3                                      # P/E collapse


# ---- snapshot -----------------------------------------------------------------------

def test_publish_stock_snapshot_payload():
    rows, info = screenjobs.project_stock_rows(_score_frame_like(4), {})
    conn = FakeConn()
    out = screenjobs.publish_stock_snapshot(conn, rows, "2026-10-14", info)
    (k, sql, params), = conn.log
    assert "insert into public.screener_snapshots" in sql and "on conflict (scope)" in sql
    assert params[0] == "2026-10-14"
    payload = json.loads(params[1])
    assert payload["fields"] == screens.field_keys("stocks") and payload["n"] == 4
    assert len(payload["rows"]) == 4 and len(payload["rows"][0]) == len(payload["fields"])
    rebuilt = [dict(zip(payload["fields"], r)) for r in payload["rows"]]
    assert rebuilt == rows
    assert out == {"rows": 4, "hidden": info["n_hidden"], "bytes": len(params[1])}
    assert set(payload["coverage"]) == {"price_mcap", "pe"}


def test_previous_snapshot():
    conn = FakeConn([("from public.screener_snapshots", lambda p: ([(3100, {"pe": 0.6})], 1))])
    assert screenjobs.previous_snapshot(conn) == {"rows": 3100, "coverage": {"pe": 0.6}}
    assert screenjobs.previous_snapshot(FakeConn([("screener_snapshots", lambda p: ([], 0))])) is None


# ---- alerts ---------------------------------------------------------------------------

ASOF = "2026-10-14"


def _alert_rows(n=8):
    """FXA..: pe 10,12,..; FXB and FXH carry a data issue."""
    return [{"ticker": f"FX{chr(65 + i)}", "pe": 10.0 + 2 * i, "value_score": 90 - i,
             "data_ok": i not in (1, 7)} for i in range(n)]


def _flt(**kw):
    f = {"v": 1, "scope": "stocks", "where": [{"field": "pe", "op": "<=", "value": 20}]}
    f.update(kw)
    return f


def _alert_conn(screens_rows, update_rowcount=1, insert=None):
    return FakeConn([
        ("from public.saved_screens s join auth.users", lambda p: (screens_rows, len(screens_rows))),
        ("update public.saved_screens", lambda p: ([], update_rowcount)),
        ("insert into public.screen_alerts", insert or (lambda p: ([], 1))),
        ("delete from public.screen_alerts", lambda p: ([], 3)),
    ])


def test_run_alerts_trust_baseline_and_diff():
    rows = _alert_rows()      # where pe<=20 -> FXA..FXF; data_ok drops FXB -> {A,C,D,E,F}
    screens_rows = [
        # untrusted owner: never evaluated, never touched
        ("s-untrusted", "u-1", _flt(), ["FXA"], None, None, False),
        # first evaluation: baseline, no alert
        ("s-baseline", "u-2", _flt(), None, None, None, True),
        # previous run: FXB (now data issue), FXG (now pe 22 -> really removed), FXA
        ("s-diff", "u-3", _flt(sort={"field": "value_score", "dir": "desc"}, limit=1),
         ["FXA", "FXB", "FXG"], date(2026, 10, 13), 8, True),
        # unchanged since last time
        ("s-same", "u-4", _flt(), ["FXA", "FXC", "FXD", "FXE", "FXF"], date(2026, 10, 13), 8, True),
    ]
    conn = _alert_conn(screens_rows)
    st = screenjobs.run_alerts(conn, "stocks", rows, ASOF)
    assert st["screens"] == 4 and st["skipped_untrusted"] == 1 and st["baselines"] == 1
    assert st["alerts"] == 1 and st["unchanged"] == 1 and st["pruned"] == 3
    assert st["universe"] == 8 and "errors" not in st
    ups = conn.calls("update public.saved_screens")
    assert [p[3] for _, _, p in ups] == ["s-baseline", "s-diff", "s-same"]   # untrusted untouched
    assert all(json.loads(p[0]) == ["FXA", "FXC", "FXD", "FXE", "FXF"] for _, _, p in ups)
    assert all(p[1] == date(2026, 10, 14) and p[2] == 8 for _, _, p in ups)
    (_, sql, p), = conn.calls("insert into public.screen_alerts")
    assert "on conflict (screen_id, asof) do nothing" in sql
    uid, sid, asof, added, removed, n_add, n_rem, hidden = p
    assert (uid, sid, asof) == ("u-3", "s-diff", date(2026, 10, 14))
    # sort/limit ignored: full match set, not the top-1
    assert added == ["FXC", "FXD", "FXE", "FXF"] and n_add == 4
    assert removed == ["FXG"] and n_rem == 1
    assert hidden == ["FXB"]                         # left only because data_ok flipped
    # the trust test is in SQL, at run time
    sql = conn.calls("join auth.users")[0][1]
    assert "email_confirmed_at is not null" in sql and "public.admins" in sql \
        and "can_view_prices" in sql and conn.calls("join auth.users")[0][2] == ("stocks",)


def test_run_alerts_skips_and_caps():
    rows = [{"ticker": f"FX{i:03d}", "pe": 5.0, "data_ok": True} for i in range(120)]
    screens_rows = [
        ("s-sameday", "u", _flt(), ["FX000"], date(2026, 10, 14), 120, True),
        ("s-shrunk", "u", _flt(), ["FX000"], date(2026, 10, 1), 200, True),
        ("s-invalid", "u", _flt(where=[{"field": "__proto__", "op": "<", "value": 1}]),
         ["FX000"], None, None, True),
        ("s-cap", "u", _flt(), ["GONE%03d" % i for i in range(70)], date(2026, 10, 13), 120, True),
        ("s-badlast", "u", _flt(), {"not": "a list"}, date(2026, 10, 13), 120, True),
    ]
    conn = _alert_conn(screens_rows)
    st = screenjobs.run_alerts(conn, "stocks", rows, ASOF)
    assert (st["skipped_same_asof"], st["skipped_shrunk"], st["skipped_invalid"]) == (1, 1, 1)
    assert st["alerts"] == 1 and st["baselines"] == 1     # corrupt last_matches -> new baseline
    (_, _, p), = conn.calls("insert into public.screen_alerts")
    assert len(p[3]) == 50 and p[5] == 120 and len(p[4]) == 50 and p[6] == 70


def test_run_alerts_screen_edited_meanwhile():
    """The update is guarded on the evaluated filter; rowcount 0 -> no alert."""
    conn = _alert_conn([("s", "u", _flt(), ["FXZ"], date(2026, 10, 13), 8, True)], update_rowcount=0)
    st = screenjobs.run_alerts(conn, "stocks", _alert_rows(), ASOF)
    assert st["skipped_changed"] == 1 and st["alerts"] == 0
    assert not conn.calls("insert into public.screen_alerts")
    (_, sql, p), = conn.calls("update public.saved_screens")
    assert "and filter = %s::jsonb" in sql and json.loads(p[4]) == _flt()


def test_run_alerts_markets_scope():
    rows = [{"key": "fx_land", "pe": 9.0}, {"key": "fx_sea", "pe": 30.0, "data_sane": False},
            {"key": "fx_air", "pe": 12.0}]
    flt = {"v": 1, "scope": "markets", "where": [{"field": "pe", "op": "<=", "value": 20}]}
    conn = _alert_conn([("m", "u", flt, ["fx_sea"], date(2026, 10, 5), 3, True)])
    st = screenjobs.run_alerts(conn, "markets", rows, ASOF)
    assert st["alerts"] == 1
    (_, _, p), = conn.calls("insert into public.screen_alerts")
    assert p[3] == ["fx_air", "fx_land"] and p[4] == ["fx_sea"]


def test_privacy_check_violation_never_leaks():
    """A constraint error whose DETAIL names a user uuid and a ticker must not reach the
    returned counts nor stdout; the next screen still runs."""
    calls = {"n": 0}

    def insert(p):
        calls["n"] += 1
        if calls["n"] == 1:
            raise _boom()
        return [], 1

    screens_rows = [("s1", SECRET_UUID, _flt(), [SECRET_TICKER], date(2026, 10, 13), 8, True),
                    ("s2", "u-2", _flt(), [SECRET_TICKER], date(2026, 10, 13), 8, True)]
    conn = _alert_conn(screens_rows, insert=insert)
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        st = screenjobs.run_alerts(conn, "stocks", _alert_rows(), ASOF)
        print(st)
    assert st["skipped_invalid"] == 1 and st["alerts"] == 1
    assert st["errors"] == {"CheckViolation": 1}
    blob = json.dumps(st) + buf.getvalue()
    assert SECRET_UUID not in blob and SECRET_TICKER not in blob and "DETAIL" not in blob
    assert ("rollback_to", None, None) in conn.log            # savepoint rolled back


def test_privacy_run_daily_and_market_hook():
    def raising(*a, **k):
        raise _boom()

    from engine import quality, stockvaluation
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), patched(screenjobs, _gate=lambda *a: None), \
            patched(stockvaluation, score_frame=raising):
        out = screenjobs.run_daily(ASOF, t_start=time.monotonic())
        print(out)
    assert out["error"] == "CheckViolation" and out["sqlstate"] == "23514"
    with contextlib.redirect_stdout(buf), patched(db, have_db=lambda: True, connect=raising):
        m = screenjobs.run_market_alerts([{"key": "fx_a", "pe": 1.0}], ASOF)
        print(m)
    assert m == {"error": "CheckViolation", "sqlstate": "23514"}
    blob = json.dumps(out) + json.dumps(m) + buf.getvalue()
    assert SECRET_UUID not in blob and SECRET_TICKER not in blob
    # snapshot step failing mid-way: sanitised too, and alerts are not run on it
    rows, info = screenjobs.project_stock_rows(_score_frame_like(10), {})
    conn = FakeConn([("insert into public.screener_snapshots", lambda p: (_ for _ in ()).throw(_boom())),
                     ("from public.screener_snapshots", lambda p: ([], 0))])
    with contextlib.redirect_stdout(buf), patched(screenjobs, _gate=lambda *a: None), \
            patched(stockvaluation, score_frame=lambda asof: _score_frame_like(10)), \
            patched(quality, open_flags_by_entity=lambda: {}), \
            patched(db, connect=lambda: conn):
        out = screenjobs.run_daily(ASOF)
    assert out["snapshot"] == {"error": "CheckViolation", "sqlstate": "23514"}
    assert out["alerts"] == {"skipped": "snapshot not published"}
    assert SECRET_UUID not in json.dumps(out)


def test_pipeline_hooks_never_log_exception_text():
    """The two engine hooks record class + SQLSTATE only (str(e) carries DETAIL)."""
    def code(text):         # comments may SAY "never str(e)"; only code counts
        return "\n".join(line.split("#")[0] for line in text.splitlines())

    src = (ROOT / "engine" / "datapipeline.py").read_text(encoding="utf-8")
    block = code(src[src.index("# 7b. Screener jobs"):src.index("# 8. Semantic-memory")])
    assert "screenjobs.run_daily(" in block and "t_start=t_start" in block
    assert "str(e)" not in block and "type(e).__name__" in block
    assert src.index("t_start = time.monotonic()") < src.index("# 0. Apply any pending")
    assert src.index("# 7. LLM AGENTS") < src.index("# 7b. Screener jobs")
    src = (ROOT / "engine" / "pipeline.py").read_text(encoding="utf-8")
    block = code(src[src.index("# 6. Alerts on saved MARKET screens"):])
    assert "run_market_alerts(payload['scoreboard']" in block and "str(e)" not in block
    src = (ROOT / "engine" / "screenjobs.py").read_text(encoding="utf-8")
    assert not re.search(r"str\(e\)|repr\(e\)|\{e\}|\{e!", code(src))


def test_market_alerts_guard_and_path():
    rows = [{"key": f"fx_{i}", "pe": 10.0 if i < 7 else None} for i in range(10)]
    with patched(db, have_db=lambda: True):
        assert screenjobs.run_market_alerts(rows, ASOF)["skipped"] == "low_coverage"
    rows = [{"key": f"fx_{i}", "pe": 10.0} for i in range(10)]
    conn = _alert_conn([])
    with patched(db, have_db=lambda: True, connect=lambda: conn):
        st = screenjobs.run_market_alerts(rows, ASOF)
    assert st["screens"] == 0 and conn.commits == 1
    assert conn.calls("join auth.users")[0][2] == ("markets",)
    with patched(db, have_db=lambda: False):
        assert screenjobs.run_market_alerts(rows, ASOF) == {"skipped": "no database"}


# ---- gate -----------------------------------------------------------------------------

def test_daily_gate():
    import os
    from engine import tierb
    env = os.environ.get("SCREENS_DAILY")
    try:
        os.environ["SCREENS_DAILY"] = "0"
        assert "disabled" in screenjobs.run_daily(ASOF)["skipped"]
        os.environ.pop("SCREENS_DAILY")
        assert screenjobs.run_daily(ASOF, full_ingest=True) == {"skipped": "full sweep"}
        with patched(db, have_db=lambda: False):
            assert screenjobs.run_daily(ASOF) == {"skipped": "no database"}
        with patched(db, have_db=lambda: True), patched(tierb, enabled=lambda: True,
                                                         have_prices=lambda: False):
            assert "Tier B" in screenjobs.run_daily(ASOF)["skipped"]
        with patched(db, have_db=lambda: True), patched(tierb, enabled=lambda: True,
                                                         have_prices=lambda: True):
            g = screenjobs._gate(False, time.monotonic() - 241 * 60)
            assert g["skipped"] == "elapsed" and g["elapsed_min"] == 241
            assert screenjobs._gate(False, time.monotonic()) is None
    finally:
        if env is None:
            os.environ.pop("SCREENS_DAILY", None)
        else:
            os.environ["SCREENS_DAILY"] = env


def test_run_daily_low_coverage_publishes_nothing():
    from engine import quality, stockvaluation
    frame = _score_frame_like(10).assign(price=np.nan, market_cap=np.nan)
    conn = FakeConn([("from public.screener_snapshots", lambda p: ([(10, {"pe": 0.5})], 1))])
    with patched(screenjobs, _gate=lambda *a: None), \
            patched(stockvaluation, score_frame=lambda asof: frame), \
            patched(quality, open_flags_by_entity=lambda: {}), patched(db, connect=lambda: conn):
        out = screenjobs.run_daily(ASOF)
    assert out["skipped"] == "low_coverage" and out["coverage"] == 0.0
    assert not [s for s in conn.sql() if "insert" in s or "update" in s or "delete" in s]


# ---- chart series (real DuckDB, synthetic Tier B) -----------------------------------------

def _duck():
    try:
        import duckdb
    except ImportError:
        return None
    from engine import tierb
    con = duckdb.connect()
    con.execute("create table prices (security_id bigint, date date, close double)")
    days = pd.bdate_range("2025-01-01", "2026-10-14")
    px = []
    for sid in (1, 2, 3):
        for i, d in enumerate(days):
            if sid == 2 and i % 10 == 3:
                continue                                      # FXB misses some days
            px.append((sid, d.date(), 100.0 + sid + i * 0.01))
    px.append((1, date(2025, 7, 5), 999.0))                   # stray Saturday bar, one ticker
    px.append((1, date(2026, 10, 15), 5.0))                   # after asof: never read
    con.executemany("insert into prices values (?, ?, ?)", px)
    con.execute("create table fundamental_metrics (security_id bigint, period_end date, "
                "fiscal_period varchar, metric_code varchar, value double, unit varchar, "
                "report_type varchar, audited boolean, filed_date date, raw_tag varchar, "
                "source varchar, confidence double, ingested_at timestamptz)")
    rev = [100, 110, 120, 30, 140, 150, 160, 170, 180]      # 2017..2025; 30 = a quarter
    fm = []
    for k, r in enumerate(rev):
        pe = date(2017 + k, 12, 31)
        filed = date(2018 + k, 2, 15)
        for code, v in (("total_revenue", r), ("net_income", r / 10)):
            fm.append((1, pe, "FY", code, float(v), "USD", "10-K", True, filed, "x", "xbrl", 1.0, None))
    fm.append((1, date(2026, 12, 31), "FY", "total_revenue", 999.0, "USD", "10-K", True,
               date(2027, 2, 1), "x", "xbrl", 1.0, None))      # filed after asof: invisible
    con.executemany("insert into fundamental_metrics values "
                    "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", fm)
    assert tuple(c[0] for c in con.execute("select * from fundamental_metrics limit 0").description) \
        == tierb.FM_COLUMNS
    uni = pd.DataFrame({"security_id": [1, 2, 3, 4], "ticker": ["FXA", "FXB", "FXC", "FXD"]})
    return con, uni


def test_publish_chart_series():
    d = _duck()
    if d is None:
        print("     (duckdb not installed — skipped)")
        return
    con, uni = d
    conn = FakeConn([("pg_total_relation_size", lambda p: ([(2_500_000,)], 1)),
                     ("delete from public.chart_series", lambda p: ([], 2))])
    out = screenjobs.publish_chart_series(conn, ASOF, tickers={"FXA", "FXB", "FXC", "FXD"},
                                          con=con, universe=uni)
    (_, sql, batch), = conn.calls("insert into public.chart_series")
    assert "on conflict (key) do update" in sql and "%s::int2[]" in sql and "%s::real[]" in sql
    by = {r[0]: r for r in batch}
    assert set(by) == {"calendar:us", "stock:FXA", "stock:FXB", "stock:FXC"}   # FXD: no data
    cal = by["calendar:us"]
    assert cal[1] == "calendar" and cal[2] == ASOF and cal[5] is None and cal[6] is None
    days = cal[4]
    assert days[0] == 0 and days == sorted(days) and len(days) == len(set(days))
    start = date.fromisoformat(cal[3])
    assert date(2025, 7, 5) not in {date.fromordinal(start.toordinal() + x) for x in days}
    assert (date.fromordinal(start.toordinal() + days[-1])) == date(2026, 10, 14)
    a, b = by["stock:FXA"], by["stock:FXB"]
    assert a[1] == "stock" and a[4] is None and len(a[5]) == len(days) == len(b[5])
    last = con.execute("select close from prices where security_id = 1 "
                       "and date = '2026-10-14'").fetchone()[0]
    assert all(isinstance(x, float) for x in a[5]) and math.isclose(a[5][-1], last)
    assert 999.0 not in a[5] and 5.0 not in a[5]           # stray Saturday / after asof
    assert sum(x is None for x in b[5]) > 0 and b[6] is None          # gaps; no fundamentals
    f = json.loads(a[6])
    assert len(f["period_end"]) == 7 and f["period_end"][-1] == "2025-12-31"
    assert f["currency"] == "USD" and 999.0 not in f["revenue"]
    assert f["revenue"][-1] == 180.0 and f["net_income"][-1] == 18.0
    i30 = f["period_end"].index("2020-12-31")
    assert f["revenue"][i30] is None and f["net_income"][i30] is None  # nulled year stays null
    assert conn.calls("delete from public.chart_series")[0][2] == (ASOF,)
    assert ("savepoint", None, None) in conn.log and ("release", None, None) in conn.log
    assert out["stocks"] == 3 and out["days"] == len(days) and out["pruned"] == 2
    assert out["table_mb"] == 2.5 and out["projected_mb"] < 1


def test_publish_chart_series_budget_and_time_box():
    d = _duck()
    if d is None:
        return
    con, uni = d
    buf = io.StringIO()
    conn = FakeConn()
    with contextlib.redirect_stdout(buf):
        out = screenjobs.publish_chart_series(conn, ASOF, con=con, universe=uni, budget_bytes=1000)
    assert out["skipped"] == "size_budget" and "budget" in buf.getvalue()
    assert not conn.log                                               # nothing written
    conn = FakeConn()
    with contextlib.redirect_stdout(buf):
        out = screenjobs.publish_chart_series(conn, ASOF, con=con, universe=uni, deadline_s=-1)
    assert out["skipped"] == "time_box" and not conn.calls("insert")
    assert screenjobs.publish_chart_series(FakeConn(), ASOF, tickers=set(), con=con,
                                           universe=uni) == {"skipped": "no universe"}


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {name}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
