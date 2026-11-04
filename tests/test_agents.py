"""Agents v2, the agent half (ADR-044): the needs register seed, the registry never
overwriting verified fields, the discovery licence gate ignoring the model's claim,
deterministic sector rotation, the XBRL gate (no in_xbrl from guesses), and
Quality-Triage triaging open needs only, keyed on the proposed check. Fake DB
(tests/_fakepg.py) and a canned model; no network, no Postgres.
Run: python tests/test_agents.py
"""
from __future__ import annotations

import json
import os
import sys
import types
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _fakepg  # noqa: E402  (also puts the repo root on sys.path)

# The adapters pull in yahoo/numpy and live HTTP clients; the seed under test needs
# none of them.
_adapters = types.ModuleType("engine.sources.adapters")
_adapters.adapters_for = lambda kind: []
sys.modules.setdefault("engine.sources.adapters", _adapters)

from engine import proposals  # noqa: E402
from engine.dataagent import agent, discover  # noqa: E402
from engine.sectoragent import research  # noqa: E402
from engine.sources import registry  # noqa: E402
from engine import qualitytriage  # noqa: E402

SEED_FINNHUB = {"id": "finnhub", "name": "Finnhub", "provider": "Finnhub.io",
                "kinds": ["fundamentals", "price", "news", "filings"],
                "license": "personal_only", "notes": "researched: free tier is personal use",
                "verified_live": False, "has_adapter": False, "status": "lead",
                "confidence": "high", "endpoint": ""}


def seeded():
    fdb = _fakepg.install()
    agent.seed_needs()
    return fdb


# --------------------------------------------------------------------------- #
# the needs register
# --------------------------------------------------------------------------- #

def test_needs_seed_is_idempotent_and_never_reverts_the_owner():
    fdb = _fakepg.install()
    first = agent.seed_needs()
    assert len(first) == len(agent.DEFAULT_NEEDS) == len(fdb.needs)
    assert agent.seed_needs() == []                      # second run adds nothing
    n = fdb.needs
    assert n["index_valuation"]["status"] == "answered_by_roadmap"
    assert "Phase 2" in n["index_valuation"]["roadmap_ref"]
    assert (n["japan_fundamentals"]["status"], n["japan_fundamentals"]["park_until"]) == \
        ("parked", "2027-03-01")
    assert (n["macro_fred"]["status"], n["macro_fred"]["park_until"]) == ("parked", "2027-03-31")
    assert n["kpi:warranty_cost_ratio"]["park_until"] == "2027-01-31"
    assert n["sector_kpi_non_xbrl"]["status"] == "parked"
    assert n["sector_kpi_xbrl"]["status"] == "open"
    assert n["quality:stale_filings"]["status"] == "open"
    assert "ADR-005" in n["quality:stale_filings"]["status_note"]
    assert "#60" in n["quality:missing_revenue"]["roadmap_ref"]
    for q in ("quality:negative_value", "quality:shares_multiclass_unsummed"):
        assert "ADR-043" in n[q]["roadmap_ref"], q
    for need in agent.DEFAULT_NEEDS:
        assert need.get("status", "open") in {"open", "answered_by_roadmap", "parked", "met"}
        assert need.get("status") != "parked" or need.get("park_until"), need["id"]
    # The owner reopens a need in the DB; the next seed leaves it alone.
    n["macro_fred"]["status"] = "open"
    agent.seed_needs()
    assert n["macro_fred"]["status"] == "open"


# --------------------------------------------------------------------------- #
# the registry
# --------------------------------------------------------------------------- #

def test_registry_never_overwrites_verified_fields():
    fdb = _fakepg.install()
    registry.upsert_source(dict(SEED_FINNHUB), authoritative=True)
    # An invented lead colliding with the verified row (proposal 146).
    registry.upsert_source({"id": "finnhub", "name": "Finnhub API", "provider": "Finnhub",
                            "license": "redistribution_ok", "notes": "model says free",
                            "verified_live": True, "has_adapter": True, "status": "lead",
                            "endpoint": "https://finnhub.io/api/v1"})
    row = fdb.sources["finnhub"]
    kept = {"license": "personal_only", "notes": SEED_FINNHUB["notes"], "verified_live": False,
            "has_adapter": False, "status": "lead", "confidence": "high", "name": "Finnhub"}
    assert {k: row[k] for k in kept} == kept, row
    assert row["endpoint"] == "https://finnhub.io/api/v1"     # a blank may be filled
    # The researched catalogue (authoritative) still updates its own row.
    registry.upsert_source({**SEED_FINNHUB, "notes": "re-researched"}, authoritative=True)
    assert fdb.sources["finnhub"]["notes"] == "re-researched"


def test_invented_leads_are_not_sources():
    fdb = _fakepg.install()
    registry.upsert_source(dict(SEED_FINNHUB), authoritative=True)
    fdb.sources["fred_idx"] = {"id": "fred_idx", "provider": "FRED", "license": "public_domain",
                               "status": "invented", "kinds": "macro"}
    assert [s["id"] for s in registry.list_sources()] == ["finnhub"]
    assert registry.verified_license("FRED", "macro") is None


def test_verified_license_is_the_registry_record_most_restrictive_first():
    rows = [{"id": "tiingo_fundamentals_add_on", "provider": "Tiingo", "kinds": "fundamentals,price",
             "license": "redistribution_ok"},
            {"id": "tiingo_api_eod_prices", "provider": "Tiingo, Inc. (US)", "kinds": "price,news",
             "license": "personal_only"},
            {"id": "edgar", "provider": "SEC", "kinds": "fundamentals", "license": "public_domain"}]
    # Both Tiingo rows serve prices: the personal-use one wins.
    assert registry.verified_license("tiingo", "price", rows) == "personal_only"
    # Only the add-on serves fundamentals, so its licence is the one on record.
    assert registry.verified_license("Tiingo", "fundamentals", rows) == "redistribution_ok"
    # No row serves macro: every row of the provider counts, most restrictive first.
    assert registry.verified_license("Tiingo", "macro", rows) == "personal_only"
    assert registry.verified_license("U.S. Securities and Exchange Commission", "fundamentals",
                                     rows) == "public_domain"
    assert registry.verified_license("Acme Open Data", "price", rows) is None


# --------------------------------------------------------------------------- #
# source discovery
# --------------------------------------------------------------------------- #

def test_licence_gate_uses_the_registry_never_the_models_claim():
    prompts = []

    def reply(role, system, user):
        prompts.append((system, json.loads(user)))
        return json.dumps({"sources": [
            {"id": "finnhub_free_v2", "name": "Finnhub free", "provider": "Finnhub",
             "license": "redistribution_ok", "reason": "r", "expected_outcome": "o"},
            {"id": "acme_open", "name": "Acme Open Prices", "provider": "Acme Open Data",
             "license": "public_domain", "reason": "r", "expected_outcome": "o"},
            {"id": "sec_prices", "name": "SEC", "provider": "SEC", "license": "prohibited"},
        ]})
    fdb = _fakepg.install(llm_reply=reply)
    agent.seed_needs()
    registry.upsert_source(dict(SEED_FINNHUB), authoritative=True)
    registry.upsert_source({"id": "edgar", "name": "SEC EDGAR", "provider": "SEC",
                            "kinds": ["fundamentals"], "license": "public_domain",
                            "has_adapter": True, "verified_live": True, "status": "candidate"},
                           authoritative=True)
    fdb.add_proposal(kind="source_adapter", target="alpha_vantage", status="declined",
                     canonical_key="source_adapter:alpha_vantage@index_price", dedup_key="d")
    before = dict(fdb.sources)

    out = discover.discover_for_needs(registry.list_needs())
    # Only the one open SOURCE need was asked about (index_valuation is answered,
    # stock_fundamentals answered, japan and FRED parked, KPI/quality not sources).
    assert [u["need"] for _, u in prompts] == ["index_price"], prompts
    system, user = prompts[0]
    assert user["description"] == "EOD price for every index proxy"
    assert "finnhub (personal_only)" in system and "sec (public_domain)" in system
    assert "Verified, with a working adapter: sec" in system
    assert "never suggest them again: alpha_vantage" in system

    by = {o["provider"]: o for o in out}
    assert by["finnhub"]["action"] == "blocked_license"            # claimed redistribution_ok
    assert by["finnhub"]["license"] == "personal_only"
    assert by["acmeopen"]["action"] == "created" and by["acmeopen"]["license"] == "unknown"
    acme = fdb.proposals[by["acmeopen"]["id"]]
    assert acme["payload"]["source"]["license"] == "unknown"
    assert acme["payload"]["source"]["license_claimed"] == "public_domain"
    assert acme["payload"]["source"]["license_verified"] is False
    assert "unverified" in acme["proposal"] and acme["need_id"] == "index_price"
    assert by["sec"]["action"] == "created" and by["sec"]["license"] == "public_domain"
    # Nothing the model said was written to the registry.
    assert fdb.sources == before
    # Next week the same ideas, respelled, merge instead of piling up.
    n = len(fdb.proposals)
    discover.discover_for_needs(registry.list_needs())
    assert len(fdb.proposals) == n


def test_discovery_asks_nothing_when_no_source_need_is_open():
    fdb = _fakepg.install(llm_reply=lambda *a: (_ for _ in ()).throw(AssertionError("asked")))
    agent.seed_needs()
    fdb.needs["index_price"]["status"] = "met"
    assert discover.discover_for_needs(registry.list_needs()) == \
        [{"skipped": "no open source need in the register"}]


# --------------------------------------------------------------------------- #
# sector research
# --------------------------------------------------------------------------- #

def test_rotation_is_deterministic_thin_first_and_covers_every_tier():
    rows = [(s, 0) for s in ("Agriculture", "Apparel", "Chemicals", "Construction",
                             "Electronics", "Machinery", "Mining")] + \
           [("Telecom", 4), ("Banks", 9)]
    wk = 3000
    assert research.rotate(rows, 4, wk) == research.rotate(list(reversed(rows)), 4, wk)
    seen = set()
    for w in range(wk, wk + 2):                         # ceil(7 / 4) weeks
        pick = research.rotate(rows, 4, w)
        assert len(pick) == 4 and "Banks" not in pick
        seen |= set(pick)
    assert seen >= {s for s, c in rows if c == 0}, seen
    assert research.rotate(rows, 4, wk) != research.rotate(rows, 4, wk + 1)
    # A thin tier smaller than k is taken whole, then the next tier.
    assert research.rotate([("A", 0), ("B", 1), ("C", 1)], 2, 0) == ["A", "B"]
    assert research.rotate([], 4, wk) == []


def test_thin_subsectors_orders_by_catalogue_coverage():
    fdb = _fakepg.install()
    fdb.sub_sectors = ["Telecom", "Agriculture", "Banks", "Telecom"]
    fdb.catalog = {"arpu": {"applies_to": "Telecom"}, "churn_rate": {"applies_to": "Telecom"},
                   "nim": {"applies_to": "Commercial banks"}}
    with fdb_cursor(fdb) as cur:
        assert research.thin_subsectors(cur, 2, date(2026, 11, 4)) == ["Agriculture", "Banks"]


def fdb_cursor(fdb):
    return _fakepg.FakeConn(fdb).cursor()


def test_xbrl_tags_are_verified_only_by_a_deterministic_check():
    yes = lambda *a: True                                   # noqa: E731
    os.environ.pop("XBRL_VERIFY", None)
    assert research.verify_tags(["us-gaap:Revenues"], fetch=yes) == []   # off: offline fallback
    os.environ["XBRL_VERIFY"] = "1"
    try:
        filed = {("us-gaap", "ProductWarrantyAccrual", "USD")}
        fetch = lambda ns, c, unit, period: (ns, c, unit) in filed   # noqa: E731
        assert research.verify_tags(["us-gaap:ProductWarrantyAccrual", "us-gaap:Sales"],
                                    fetch=fetch) == ["us-gaap:ProductWarrantyAccrual"]

        def down(*a):
            raise OSError("SEC unreachable")
        assert research.verify_tags(["us-gaap:Revenues"], fetch=down) == []
    finally:
        os.environ.pop("XBRL_VERIFY", None)


def test_research_never_sets_in_xbrl_from_a_guess():
    prompts = []

    def reply(role, system, user):
        prompts.append(system)
        return json.dumps({"metrics": [
            {"metric_code": "average_revenue_per_user", "label": "ARPU"},
            {"metric_code": "crop_yield", "label": "Crop yield",
             "xbrl_tags": ["us-gaap_CropYield", "not a tag"], "reason": "r",
             "expected_outcome": "o"},
            {"metric_code": "warranty_cost_ratio", "label": "Warranty cost ratio",
             "xbrl_tags": ["us-gaap:ProductWarrantyExpense"]},
            {"metric_code": "seed_cost_per_acre", "label": "Seed cost",
             "xbrl_tags": ["us-gaap:CostOfGoodsAndServicesSold"]},
        ]})
    fdb = _fakepg.install(llm_reply=reply)
    agent.seed_needs()
    fdb.sub_sectors = ["Agriculture"]
    research._sec_frame = lambda ns, c, unit, period: c == "CostOfGoodsAndServicesSold"

    os.environ.pop("XBRL_VERIFY", None)
    # Offline nothing can verify, and the non-XBRL need is parked, so nothing could be
    # filed: the model is not asked at all.
    assert "XBRL_VERIFY is off" in research.research_thin_subsectors()["skipped"]
    assert prompts == []
    # With the non-XBRL need open, offline, every KPI goes there and none is XBRL.
    fdb.needs["sector_kpi_non_xbrl"]["status"] = "open"
    out = research.research_thin_subsectors(max_subsectors=1)
    got = {p["code"]: p for p in out["researched"][0]["proposed"]}
    assert got["average_revenue_per_user"]["action"] == "in_catalogue"
    assert got["crop_yield"] == {"code": "crop_yield", "need": "sector_kpi_non_xbrl",
                                 "action": "created"}
    assert got["warranty_cost_ratio"] == {"code": "warranty_cost_ratio",
                                          "need": "kpi:warranty_cost_ratio",
                                          "action": "blocked_need"}
    crop = next(r for r in fdb.proposals.values() if r["target"] == "crop_yield")
    assert crop["payload"]["xbrl_verified"] is False and crop["payload"]["xbrl_tags"] == []
    assert crop["payload"]["proposed_tags"] == ["us-gaap:CropYield"]
    assert "arpu" in prompts[0] and "capacity_utilization" in prompts[0]
    proposals.decide(crop["id"], "approve", actor="owner")
    assert fdb.catalog["crop_yield"]["in_xbrl"] is False      # the guess never counts
    fdb.proposals.clear()
    fdb.catalog.clear()
    fdb.needs["sector_kpi_non_xbrl"]["status"] = "parked"

    os.environ["XBRL_VERIFY"] = "1"
    try:
        out = research.research_thin_subsectors(max_subsectors=1)
    finally:
        os.environ.pop("XBRL_VERIFY", None)
    got = {p["code"]: p for p in out["researched"][0]["proposed"]}
    assert got["crop_yield"]["action"] == "blocked_need"          # its guess did not verify
    assert got["warranty_cost_ratio"]["action"] == "blocked_need"  # parked to 2027-01-31
    seed = got["seed_cost_per_acre"]
    assert seed["need"] == "sector_kpi_xbrl" and seed["action"] == "created", seed
    pay = next(iter(fdb.proposals.values()))["payload"]
    assert pay["xbrl_verified"] is True
    assert pay["xbrl_tags"] == ["us-gaap:CostOfGoodsAndServicesSold"]
    assert pay["applies_to"] == "Agriculture"


def test_research_skips_the_model_when_no_kpi_need_is_open():
    fdb = _fakepg.install(llm_reply=lambda *a: (_ for _ in ()).throw(AssertionError("asked")))
    agent.seed_needs()
    fdb.needs["sector_kpi_xbrl"]["status"] = "met"
    os.environ["XBRL_VERIFY"] = "1"
    try:
        assert research.research_thin_subsectors() == \
            {"skipped": "no open sector-KPI need in the register"}
    finally:
        os.environ.pop("XBRL_VERIFY", None)


# --------------------------------------------------------------------------- #
# quality triage
# --------------------------------------------------------------------------- #

def test_triage_works_open_needs_only_and_keys_on_the_proposed_check():
    asked = []

    def reply(role, system, user):
        u = json.loads(user)
        asked.append(u)
        return json.dumps({"root_cause": "rc", "fix": "f", "expected_outcome": "o",
                           "new_check": {"name": f"Check_{u['check_name']}_vintage_gaps",
                                         "logic": "l", "rationale": "x"}})
    fdb = _fakepg.install(llm_reply=reply)
    agent.seed_needs()
    fdb.add_proposal(kind="quality_check", target="latest_filing_only", status="declined",
                     need_id="quality:stale_filings", dedup_key="d63",
                     canonical_key="quality_check:latest_filing_only")
    report = {"by_check": {"missing_revenue": 50, "shares_multiclass_unsummed": 300,
                           "stale_filings": 40, "timeseries_jump": 3},
              "issues": [{"check_name": "stale_filings", "entity": "AAA"}]}
    out = qualitytriage.triage_issues(report)
    assert [u["check_name"] for u in asked] == ["stale_filings", "timeseries_jump"], asked
    assert "ADR-005" in asked[0]["constraints"]
    assert asked[0]["declined_solutions"] == ["latest_filing_only"]
    assert fdb.needs["quality:timeseries_jump"]["status"] == "open"   # new firing check
    rows = sorted(fdb.proposals.values(), key=lambda r: r["id"])[1:]
    assert [r["target"] for r in rows] == ["stale_filing_vintage_gap", "timeseries_jump_vintage_gap"]
    assert rows[0]["payload"]["fires_for"] == "stale_filings"
    assert rows[0]["need_id"] == "quality:stale_filings"
    assert rows[0]["signals"] == ["check:stale_filings"]
    assert len(out["triaged"]) == 2
    # Tomorrow it fires again: the same signal is not new evidence.
    qualitytriage.triage_issues(report)
    assert rows[0]["evidence_count"] == 1


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("agent tests passed")
