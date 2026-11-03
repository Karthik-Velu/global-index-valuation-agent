"""Share census (S0, ADR-043): the plan's golden cases over trimmed public-domain
companyfacts fixtures, the store-vs-simulation reconciliation over a trimmed store
dump, and the licence guard (plan rule 6). In-memory DuckDB; no Postgres, no SEC,
no network. Run: python tests/test_shares_census.py
"""
from __future__ import annotations

import csv
import json
import random
import re
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import duckdb  # noqa: E402

from engine import shares, sharescensus as sc  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "shares"
CF = FIX / "companyfacts"
ASOF = "2026-10-31"
GOLDEN = {"EMN": 915389, "FMC": 37785, "BABA": 1577552, "SJ": 1753673, "META": 1326801,
          "CRWV": 1769628, "BRK-B": 1067983, "MCD": 63908, "TSCO": 916365, "MBLY": 1910139,
          "AAL": 6201, "RMTHF": 876779}

_RUN: dict = {}


def _census():
    """One cache-mode run over the fixtures, shared by the tests."""
    if not _RUN:
        with tempfile.TemporaryDirectory() as tmp:
            secs = Path(tmp) / "securities.json"
            secs.write_text(json.dumps([{"ticker": t, "cik": c} for t, c in GOLDEN.items()]))
            recs, ctx = sc.run_cache([CF], ASOF, str(secs),
                                     [str(FIX / "store_shares_by_ticker.json")])
            S, T = sc.sections(recs, ctx)
            jp, cp = sc.write(recs, S, T, ctx, Path(tmp) / "out", runtime=1.0)
            _RUN.update(recs={r["ticker"]: r for r in recs}, S=S, T=T,
                        doc=json.loads(jp.read_text()),
                        header=next(csv.reader(cp.open())))
    return _RUN


def _facts(cik):
    return sc.load_companyfacts(CF / f"CIK{cik:010d}.json")


def _verdicts(tk):
    return shares.classify_accessions(shares.fact_rows(GOLDEN[tk], _facts(GOLDEN[tk])))


def _show(r):
    """The CSV columns of a record: enough to read a failure, small enough to print."""
    return {k: r.get(k) for k in sc.CSV_COLUMNS if r.get(k) is not None}


def _close(a, b, tol=0.0005):
    return a is not None and abs(a / b - 1) <= tol


# --- goldens (plan, S0 Tests) -------------------------------------------------------

def test_emn_collision():
    r = _census()["recs"]["EMN"]
    assert r["today_value"] == 224221189 and r["today_concept"] == shares.CSI, r
    assert r["new_value"] == 114380456 and r["new_candidate"] == "cover", r
    assert r["new_accession"] == "0000915389-26-000172", r
    assert round(r["collision_ratio"], 3) == 1.960, r["collision_ratio"]


def test_fmc_collision():
    r = _census()["recs"]["FMC"]
    assert round(r["collision_ratio"], 3) == 1.196, r["collision_ratio"]
    assert r["new_value"] == 155558399, r


def test_baba_unchanged_cover_rejected_ratio_facts():
    r = _census()["recs"]["BABA"]
    assert r["today_value"] == r["new_value"] == 18580374278, r
    cover = [v for v in _verdicts("BABA") if v["accession"] == "0001193125-26-231755"
             and v["candidate"] == "cover"]
    assert cover and cover[0]["value_raw"] == 1858037427 and cover[0]["value_clean"] is None, cover
    assert cover[0]["verdict"] == "QUARANTINE", cover
    assert r["ads_ratios"] == "2019-07-29:1;2019-07-30:8", r["ads_ratios"]
    rows = shares.fact_rows(GOLDEN["BABA"], _facts(GOLDEN["BABA"]))
    assert shares.ads_ratio_at(rows, "2019-07-29", ASOF) == 1
    assert shares.ads_ratio_at(rows, "2026-03-31", ASOF) == 8


def test_sj_stale_and_832x_its_weighted_average():
    r = _census()["recs"]["SJ"]
    assert r["today_value"] == 34743152000, r
    assert r["wa_newest_raw"] == 41776414 and r["wa_newest_period_end"] == "2025-12-31", r
    assert round(r["today_over_wa_newest"]) == 832, r["today_over_wa_newest"]
    assert r["new_value"] is None and r["new_reason"] == "stale_beyond_ceiling", r
    assert r["new_verdict"] == "FIX", r   # the 6-K's /1000 fix, still stale


def test_meta_crwv_no_count_with_weighted_average():
    for tk, w in (("META", 2552000000), ("CRWV", 551000000)):
        r = _census()["recs"][tk]
        assert r["today_value"] is None and r["new_value"] is None, (tk, _show(r))
        assert r["wa_fallback_value"] == w, (tk, r["wa_fallback_value"])


def test_brk_neither_after_2015():
    r = _census()["recs"]["BRK-B"]
    assert r["new_value"] is None, r
    assert r["new_count_date"] is None or r["new_count_date"] < "2016-01-01", r
    assert r["wa_fallback_period_end"] is None or r["wa_fallback_period_end"] < "2016-01-01", r


def test_mcd_fresher_cover_and_weighted_average_in_millions():
    r = _census()["recs"]["MCD"]
    assert r["today_value"] == 710398642, r          # the stale January cover
    assert r["new_value"] == 707641531 and r["new_candidate"] == "cover", r
    assert 700 < r["wa_newest_raw"] < 720 and r["wa_newest_verdict"] == "QUARANTINE", r
    assert r["band_label"] == "wa_rejected", r


def test_tsco_tagged_split_ratio():
    r = _census()["recs"]["TSCO"]
    assert r["edgar_split_ratio"] == 5 and r["edgar_split_ratio_filed"] == "2026-02-19", r


def test_mbly_class_incomplete():
    r = _census()["recs"]["MBLY"]
    assert round(r["band_cover"], 2) == 0.31 and r["band_label"] == "partial_class", r


def test_aal_future_cover_clamped():
    v = [x for x in _verdicts("AAL") if x["candidate"] == "cover" and x["period_end"] == "2027-07-17"]
    assert v and v[0]["count_date"] == v[0]["filed_date"] == "2026-07-23", v
    r = _census()["recs"]["AAL"]
    assert r["new_count_date"] == "2026-07-23" and "count_date_future" in r["new_flags"], r


def test_magic_ifrs_consolidated_numerator_with_parent():
    r = _census()["recs"]["RMTHF"]
    assert r["ni_concept"] == "ifrs-full:ProfitLoss", r["ni_concept"]
    assert r["_nm"]["ni_parent_found"] is True, r["_nm"]
    assert _close(r["ni_parent_gap"], 43291000 / 36883000 - 1, 0.001), r["ni_parent_gap"]
    assert r["te_concept"] == "ifrs-full:Equity" and r["_nm"]["te_parent_found"], r["_nm"]


# --- the census as a whole -----------------------------------------------------------

def test_every_section_and_threshold():
    run = _census()
    assert sorted(run["S"]) == list("ABCDEFGHIJKLM"), sorted(run["S"])
    assert sorted(run["T"], key=lambda k: int(k[1:])) == [f"T{i}" for i in range(1, 17)]
    for t in run["T"].values():
        assert {"measure", "value", "fires", "evaluable"} <= set(t), t
        assert "advisory" in t   # cache mode never sets a threshold


def test_store_matches_simulation():
    B = _census()["S"]["B"]
    assert B["available"] and B["securities"] >= 8, B
    assert B["today_mismatch"] == 0 and not B["mismatches"], B["mismatches"]
    assert set(B["row_level"]) == {"equal"}, B["row_level"]


def test_old_check_reproduced():
    # quality.py check 7 over the simulated store rows. SJ's fixture keeps its whole
    # history, so the count matches the 2 open issue rows the live check reported for
    # SJ on 2026-10-31 (the full cache run reproduces all 691 issuers and 1,287 rows).
    assert _census()["recs"]["SJ"]["old_check_groups"] == 2
    assert sc.old_check([("2026-03-31", shares.CSI, 10.0), ("2026-03-31", shares.CSI, 16.0)]) == 1
    assert sc.old_check([("2026-03-31", shares.CSI, 10.0), ("2026-03-31", shares.CSI, 14.0)]) == 0


def test_periodic_forms_match_ingest():
    from engine.sources import edgar
    assert shares.PERIODIC_FORMS == edgar.FUNDAMENTAL_FORMS


def test_truncation_and_order_invariance():
    for tk in ("EMN", "BABA", "MCD"):
        rows = shares.fact_rows(GOLDEN[tk], _facts(GOLDEN[tk]))
        full = shares.classify_accessions(rows)
        filed = sorted({r["filed_date"] for r in rows})
        rnd = random.Random(7)
        for cut in rnd.sample(filed, 5):
            part = shares.classify_accessions([r for r in rows if r["filed_date"] <= cut])
            assert part == [v for v in full if v["filed_date"] <= cut], (tk, cut)
            assert shares.select(part, cut) == shares.select(full, cut), (tk, cut)
        shuffled = rows[:]
        rnd.shuffle(shuffled)
        assert shares.classify_accessions(shuffled) == full, tk


# --- the CI modes, over a fake store ----------------------------------------------------

class _Cur:
    """Postgres stand-in: canned rows per query, matched on the table name."""

    def __init__(self, rows):
        self.rows, self.last = rows, None

    def execute(self, sql, params=None):
        self.last = next(k for k in self.rows if k in sql)

    def fetchall(self):
        return self.rows[self.last]

    def fetchone(self):
        return self.rows[self.last][0] if self.rows[self.last] else None


def test_store_and_companyfacts_modes():
    import datetime as dt
    from engine.sources import catalog, edgar
    tickers = list(GOLDEN)
    sid = {t: i for i, t in enumerate(tickers, 1)}
    tagmap = catalog.xbrl_tag_map()
    sim = []
    for t in tickers:
        sim += sc.simulate_ingest([_facts(GOLDEN[t])], sid[t], tagmap)
    duck = duckdb.connect()
    duck.register("fm_src", sc.fm_frame(sim))
    duck.execute("create table fundamental_metrics as select * from fm_src")
    cur = _Cur({
        "from securities": [(sid[t], t, str(GOLDEN[t]), t, "United States") for t in tickers],
        "from security_tags": [(sid["TSCO"], "5531")],
        "from splits": [(sid["TSCO"], dt.date(2024, 12, 20), 1.0, 5.0)],
        "screener_snapshots": [({"fields": ["ticker", "data_flags", "market_cap"],
                                 "rows": [["EMN", [], 9e9], ["FMC", ["quality:timeseries_jump"], 5e9]]},)],
    })
    ctx = sc.read_store(duck, cur, ASOF)
    assert ctx["pick_eligible"] == {"EMN"}, ctx["pick_eligible"]
    for companyfacts in (False, True):
        saved = edgar._companyfacts, edgar._tickers
        edgar._companyfacts = lambda cik, cache=True: _facts(int(cik))
        edgar._tickers = lambda: {t: {"cik": c, "title": t} for t, c in GOLDEN.items()}
        try:
            recs, out = sc.run_store(ASOF, companyfacts=companyfacts, ctx=ctx)
        finally:
            edgar._companyfacts, edgar._tickers = saved
        S, T = sc.sections(recs, out)
        with tempfile.TemporaryDirectory() as tmp:
            jp, _ = sc.write(recs, S, T, out, tmp, runtime=1.0)
            doc = json.loads(jp.read_text())
        assert not [k for k in _keys(doc) if sc.LICENCE_RE.search(str(k))]
        assert S["J"]["available"] and S["J"]["rows_by_year"] == {"2024": 1}, S["J"]
        assert T["T7"]["evaluable"] and T["T6"]["evaluable"], (T["T6"], T["T7"])
        by = {r["ticker"]: r for r in recs}
        assert by["EMN"]["today_value"] == 224221189, _show(by["EMN"])
        if companyfacts:
            assert S["B"]["today_mismatch"] == 0, S["B"]["mismatches"]
            assert S["C"]["over_5pct_pick_eligible"] == 1, S["C"]   # EMN
            assert S["K"]["cik_changes"] == 0, S["K"]
        else:
            assert S["C"].get("available") is False and "advisory" not in T["T1"]


# --- licence guard (plan rule 6) -------------------------------------------------------

def _keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _keys(v)


def test_no_output_field_matches_rule_6():
    run = _census()
    bad = [k for k in _keys(run["doc"]) if sc.LICENCE_RE.search(str(k))]
    assert not bad, bad
    assert not [c for c in run["header"] if sc.LICENCE_RE.search(c)], run["header"]
    try:
        sc.licence_check({"sections": {"C": {"top": [{"market_cap": 1}]}}})
    except ValueError as e:
        assert "rule-6" in str(e)
    else:
        raise AssertionError("licence_check let a market_cap key through")


def test_never_reads_price_values():
    src = (ROOT / "engine" / "sharescensus.py").read_text()
    assert "prices" not in (ROOT / "engine" / "shares.py").read_text()
    # every statement that names the prices table is one of the two constants
    stmts = re.findall(r'"[^"\n]*\bfrom prices\b[^"\n]*"', src)
    assert stmts and all(s.strip('"') in sc.BAR_COUNT_SQL or s.strip('"') in sc.BAR_DATES_SQL
                         for s in stmts), stmts
    for sql in (sc.BAR_COUNT_SQL, sc.BAR_DATES_SQL):
        assert not re.search(r"\b(open|high|low|close|volume|adj\w*)\b", sql, re.I), sql
    # ...and both run against a prices table that has no value column at all
    con = duckdb.connect()
    con.execute("create table prices (security_id bigint, date date, ingested_at timestamptz)")
    con.execute("insert into prices values (1, '2026-10-30', '2026-10-31 01:00:00+00')")
    assert con.execute(sc.BAR_COUNT_SQL).fetchall() == [(1, 1)]
    assert len(con.execute(sc.BAR_DATES_SQL, [[1]]).fetchall()) == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("share census tests passed")
