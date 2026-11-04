"""Catalogue audit: every verdict class, tag normalisation, no price is ever read, and
nothing is written except the two report files. An in-memory DuckDB stands in for the
Tier B store, a fake connection for Postgres and a fake HTTP getter for SEC frames; no
network. Run: python tests/test_catalogaudit.py
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import duckdb  # noqa: E402

from engine import catalogaudit as ca, db, tierb  # noqa: E402
from engine.sources import catalog  # noqa: E402


def _row(code, in_xbrl, tags=(), source="n_a", unit="USD", notes=""):
    return {"metric_code": code, "label": code.replace("_", " "), "definition": "",
            "unit": unit, "in_xbrl": in_xbrl, "xbrl_tags": list(tags),
            "source_if_not_xbrl": source, "notes": notes}


CAT = [
    _row("total_revenue", True, ["us-gaap:Revenues"]),
    _row("net_income", True, ["us-gaap:NetIncomeLoss"]),
    _row("niche_kpi", True, ["us-gaap:NicheThing"]),
    _row("production_volume", True, ["us-gaap:OilAndGasProductionForPeriodBarrelsOfOilEquivalent",
                                     "srt:OilAndGasProductionVolumeMeasure"], "investor_deck"),
    _row("revenue_total", True, ["us-gaap:Revenues"]),  # claimed first by total_revenue
    _row("bad_tag", True, ["us-gaap_Backlog"]),
    _row("nim", False, [], "mgmt_mdna", "percent"),
    _row("net_margin", False, [], "computed", "percent", "net_income / total_revenue"),
    _row("niche_margin", False, [], "computed", "percent", "niche_kpi over total_revenue"),
    _row("orphan_ratio", False, [], "computed", "ratio", "analyst estimate, no filing input"),
]
# Postgres holds the same rows plus one the JSON lacks (a guessed tag from a proposal).
DB_ROWS = [dict(r) for r in CAT] + [_row("guessed_kpi", True, ["us-gaap:Sales"])]

STORE = [  # (security_id, metric_code, raw_tag, filed_date)
    (1, "total_revenue", "us-gaap:Revenues", "2026-02-01"),
    (2, "total_revenue", "us-gaap:Revenues", "2026-03-01"),
    (3, "total_revenue", "us-gaap:Revenues", "2026-04-01"),
    (1, "net_income", "us-gaap:NetIncomeLoss", "2026-02-01"),
    (2, "net_income", "us-gaap:NetIncomeLoss", "2026-03-01"),
    (1, "niche_kpi", "us-gaap:NicheThing", "2026-05-01"),
]


def _store():
    con = duckdb.connect()
    con.execute("""create table fundamental_metrics (security_id bigint, metric_code varchar,
                   raw_tag varchar, filed_date date, period_end date, value double)""")
    con.executemany("insert into fundamental_metrics values (?, ?, ?, ?, '2025-12-31', 1.0)",
                    STORE)
    # A trap, not data: any query that touches prices fails the test.
    con.execute("create view prices as select error('prices view read') as close")
    return con


@contextlib.contextmanager
def _patched(obj, **attrs):
    old = {k: getattr(obj, k) for k in attrs}
    for k, v in attrs.items():
        setattr(obj, k, v)
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(obj, k, v)


def _by_code(rep):
    return {r["metric_code"]: r for r in rep["rows"]}


def test_tag_normalisation():
    n = ca.normalise_tag
    assert n("us-gaap:Revenues") == ("us-gaap:Revenues", None)
    assert n("us-gaap:Sales") == ("us-gaap:Sales", None)  # well formed; coverage catches guesses
    tag, why = n(" us-gaap_Revenues ")
    assert tag == "us-gaap:Revenues" and "underscore" in why
    tag, why = n("US-GAAP:Revenues")
    assert tag == "us-gaap:Revenues" and "upper-case" in why
    tag, why = n("Revenues")
    assert tag == "us-gaap:Revenues" and "no namespace" in why
    assert "unknown namespace" in n("acme:Widgets")[1]
    assert "not an ns:Concept" in n("total revenue")[1]
    assert n("ifrs-full:Revenue") == ("ifrs-full:Revenue", None)


def test_every_verdict_with_store_and_db():
    rep = ca.audit(CAT, DB_ROWS, _store(), None, min_issuers=2)
    v = {c: r["verdict"] for c, r in _by_code(rep).items()}
    assert v == {"total_revenue": "ok", "net_income": "ok", "niche_kpi": "low_coverage",
                 "production_volume": "dead", "revenue_total": "dead",
                 "bad_tag": "malformed_tag", "nim": "non_xbrl_by_design",
                 "net_margin": "ok", "niche_margin": "low_coverage",
                 "orphan_ratio": "dead", "guessed_kpi": "db_json_drift"}, v
    rows = _by_code(rep)
    assert "total_revenue" in rows["revenue_total"]["action"]  # names who claimed the tag
    assert "dead" in rows["guessed_kpi"]["flags"]  # drift outranks, but dead is kept
    assert "dead" in rows["bad_tag"]["flags"] and rows["bad_tag"]["tags"][0]["lands_as"] is None
    assert "Every tag is malformed" in rows["bad_tag"]["action"]
    t = rows["total_revenue"]["tags"][0]
    assert (t["store_issuers"], t["store_last_filed"], t["stored_as"]) == \
        (3, "2026-04-01", ["total_revenue"]), t
    assert {i["code"] for i in rows["net_margin"]["inputs"]} == {"net_income", "total_revenue"}
    assert rep["sources"]["store"]["issuers"] == 3
    assert sum(rep["verdict_counts"].values()) == len(rep["rows"])


def test_no_store_is_unverified_not_ok():
    rep = ca.audit(CAT, None, None, None, min_issuers=2)
    v = {c: r["verdict"] for c, r in _by_code(rep).items()}
    assert v["total_revenue"] == v["net_margin"] == "unverified", v
    # static facts need no store: a claimed tag, a malformed tag, no inputs
    assert v["revenue_total"] == v["orphan_ratio"] == "dead", v
    assert v["bad_tag"] == "malformed_tag" and v["nim"] == "non_xbrl_by_design", v
    assert all(r["drift"] == [] for r in rep["rows"])  # no DB read, no drift claimed


def test_frames_counts_filers_and_records_failures():
    calls, sleeps = [], []

    class R:
        def __init__(self, code, body=None):
            self.status_code, self._body = code, body

        def json(self):
            return self._body

    def get(url, headers, timeout):
        calls.append(url)
        assert headers["User-Agent"] == "catalogaudit-test test@example.com"
        if "/Revenues/USD/CY2025.json" in url:
            return R(200, {"pts": 3, "data": [{}, {}, {}]})
        if "NicheThing" in url:
            raise ConnectionError("reset by peer")
        return R(404)

    tags = {"us-gaap:Revenues": "USD", "us-gaap:NicheThing": "USD",
            "us-gaap:OilAndGasProductionForPeriodBarrelsOfOilEquivalent": "physical_units"}
    with _patched(os, environ={**os.environ, "SEC_USER_AGENT": "catalogaudit-test test@example.com"}):
        fr = ca.frames_coverage(tags, 2025, get=get, sleep=sleeps.append)
    t = fr["tags"]
    assert t["us-gaap:Revenues"]["filers"] == 3 and t["us-gaap:Revenues"]["period"] == "CY2025"
    assert t["us-gaap:NicheThing"]["filers"] is None and "ConnectionError" in t["us-gaap:NicheThing"]["error"]
    oil = t["us-gaap:OilAndGasProductionForPeriodBarrelsOfOilEquivalent"]
    assert oil["filers"] == 0 and oil["error"] is None
    assert len(calls) == 1 + 8 + 8  # every unit and both period forms before "nobody files it"
    assert any("CY2025Q4I" in u for u in calls)
    # at most 5 a second: every request after the first waited out the gap
    assert len(sleeps) == len(calls) - 1 and min(sleeps) >= 0.19, sleeps

    rep = ca.audit(CAT, None, None, fr, min_issuers=2)
    v = {c: r["verdict"] for c, r in _by_code(rep).items()}
    assert v["total_revenue"] == "ok" and v["production_volume"] == "dead", v
    assert v["niche_kpi"] == "unverified", v  # a failed fetch is not evidence of zero

    with _patched(os, environ={k: x for k, x in os.environ.items() if k != "SEC_USER_AGENT"}):
        fr = ca.frames_coverage(tags, 2025, get=get, sleep=sleeps.append)
    assert "SEC_USER_AGENT" in fr["error"] and fr["tags"] == {}


def test_prices_view_is_never_read():
    # The audit itself runs against a store whose prices view raises if touched.
    ca.audit(CAT, DB_ROWS, _store(), None, min_issuers=2)
    # And the real store connection drops the view before any query can run.
    with _patched(tierb, enabled=lambda: True, connect=_store):
        con = ca._store()
    assert con.execute("select count(*) from duckdb_views() "
                       "where view_name = 'prices'").fetchone()[0] == 0
    src = Path(ca.__file__).read_text()
    assert not re.search(r"\b(from|join)\s+prices\b", src, re.I)


class _Cur:
    def __init__(self, log):
        self.log, self.description = log, None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        self.log.append(sql)
        cols = ["metric_code", "label", "definition", "unit", "in_xbrl", "xbrl_tags",
                "source_if_not_xbrl", "notes"]
        self.description = [(c,) for c in cols]
        self._rows = [tuple(r[c] for c in cols) for r in DB_ROWS]

    def fetchall(self):
        return self._rows


class _Conn:
    def __init__(self):
        self.log, self.read_only = [], False

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return _Cur(self.log)

    def commit(self):
        raise AssertionError("the audit must never commit")


def test_run_writes_only_the_two_reports():
    conn, store = _Conn(), _store()
    before = store.execute("select count(*), sum(security_id) from fundamental_metrics").fetchone()
    with tempfile.TemporaryDirectory() as d:
        cat_path = Path(d) / "metric_catalog.json"
        cat_path.write_text(json.dumps({"metrics": CAT}, indent=2))
        snapshot = cat_path.read_bytes()
        out = Path(d) / "out"
        with _patched(catalog, CATALOG_PATH=cat_path), \
             _patched(db, have_db=lambda: True, connect=lambda: conn), \
             _patched(tierb, enabled=lambda: True, connect=lambda: store):
            rep = ca.run(min_issuers=2, out_dir=out)
        assert cat_path.read_bytes() == snapshot  # catalogue untouched
        assert sorted(p.name for p in out.iterdir()) == ["catalog_audit.json", "catalog_audit.md"]
        assert sorted(p.name for p in Path(d).iterdir()) == ["metric_catalog.json", "out"]
        body = json.loads((out / "catalog_audit.json").read_text())
        md = (out / "catalog_audit.md").read_text()
    assert body["verdict_counts"] == rep["verdict_counts"] and body["sources"]["db_rows"] == 11
    assert conn.read_only and conn.log and all(s.lstrip().lower().startswith("select")
                                               for s in conn.log), conn.log
    assert store.execute("select count(*), sum(security_id) from fundamental_metrics").fetchone() == before
    for v in ("malformed_tag", "db_json_drift", "non_xbrl_by_design", "dead", "low_coverage", "ok"):
        assert f"## {v} (" in md, v
    assert md.index("## malformed_tag") < md.index("## dead") < md.index("## ok")
    assert "\u2014" not in md  # house style: no em dashes
    src = Path(ca.__file__).read_text()
    for w in ("seed_db", "append_metrics", "delete_metric", "_swap_in", ".commit(",
              "insert into", "delete from", "update metric_catalog", "CATALOG_PATH.write"):
        assert w not in src, w


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("catalogue audit tests passed")
