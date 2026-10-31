"""Tier B dump presets: every preset runs with its parameters bound, filters by
ticker and metric, and none reads the licensed prices view. In-memory DuckDB stands
in for the store; no Postgres, no network. Run: python tests/test_tierbdump.py
"""
from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb  # noqa: E402

from engine import tierb, tierbdump as td  # noqa: E402

ROWS = [  # (security_id, metric_code, period_end, value, raw_tag)
    (1, "shares_outstanding", "2026-09-30", 224221189, "us-gaap:CommonStockSharesIssued"),
    (1, "shares_outstanding", "2026-06-30", 114377421, "dei:EntityCommonStockSharesOutstanding"),
    (1, "net_income", "2025-12-31", 905000000, "us-gaap:NetIncomeLoss"),
    (2, "shares_outstanding", "2026-03-31", 18580374278, "us-gaap:CommonStockSharesIssued"),
    (2, "shares_outstanding", "2026-03-31", 1858037427, "us-gaap:CommonStockSharesIssued"),
]


def _store():
    con = duckdb.connect()
    con.execute("""create table fundamental_metrics (security_id int, metric_code varchar,
                   period_end date, fiscal_period varchar, value double, unit varchar,
                   raw_tag varchar, report_type varchar, filed_date date, source varchar)""")
    con.executemany("insert into fundamental_metrics values (?, ?, ?, 'Q3', ?, 'shares', ?, "
                    "'10-Q', '2026-10-30', 'xbrl')", ROWS)
    con.execute("create table securities_live as select * from (values (1, 'EMN'), (2, 'BABA')) "
                "t(id, ticker)")
    return con


def _run(preset, tickers=None, metrics=None):
    td._connect = _store
    tierb.stats = lambda: {}
    with tempfile.TemporaryDirectory() as d:
        td.OUT_DIR = Path(d)
        out = td.dump(preset, tickers, metrics)
        body = json.loads((Path(d) / f"tierb_{preset}.json").read_text())
    assert body["n_rows"] == out["n_rows"] == len(body["rows"])
    return body["rows"]


def test_shares_by_ticker_binds_tickers():
    rows = _run("shares_by_ticker", ["emn"])
    assert {r["ticker"] for r in rows} == {"EMN"} and len(rows) == 2, rows


def test_metrics_by_ticker_filters_metrics():
    rows = _run("metrics_by_ticker", ["EMN"], ["net_income"])
    assert [r["metric_code"] for r in rows] == ["net_income"], rows
    rows = _run("metrics_by_ticker", ["EMN"])  # no metrics: every metric for the ticker
    assert len(rows) == 3, rows


def test_multiclass_shares_without_params():
    rows = _run("multiclass_shares")
    assert {r["ticker"] for r in rows} == {"BABA"} and len(rows) == 2, rows


def test_ticker_presets_require_tickers():
    try:
        _run("shares_by_ticker")
    except SystemExit as e:
        assert "needs --tickers" in str(e)
    else:
        raise AssertionError("shares_by_ticker ran without --tickers")


def test_no_preset_reads_prices():
    for name, (sql, _) in td.PRESETS.items():
        assert "prices" not in sql.lower(), name


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("tier B dump tests passed")
