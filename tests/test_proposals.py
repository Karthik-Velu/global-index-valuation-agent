"""Agents v2, the proposal half (ADR-044): canonical keys, the declined and parked
blocks on synonyms, need gating, distinct-signal evidence and scope merge, expiry,
no catalogue clobber, enrichment keeping scope and grounding how_used, and the
0017 migration being re-runnable. Fake DB (tests/_fakepg.py), no network, no
Postgres. Run: python tests/test_proposals.py
"""
from __future__ import annotations

import ast
import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _fakepg  # noqa: E402  (also puts the repo root on sys.path)

from engine import canonical, proposals, quality  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def open_need(fdb, nid, kind="sector_kpi", status="open", **kw):
    fdb.needs[nid] = {"id": nid, "kind": kind, "status": status, "description": nid,
                      "status_note": None, "park_until": None, **kw}


def kpi(fdb, code, sub, need="sector_kpi_xbrl", **extra):
    return proposals.capture(
        source_agent="sector-research", kind="catalog_kpi", target=code,
        proposal=f"Add `{code}` for {sub}: x", reason="r", expected_outcome="o",
        worked_examples=[{"situation": "s", "today": "t", "after": "a"}],
        payload={"applies_to": sub, "proposed_for_sub_sector": sub, **extra},
        need_id=need, signal=f"sub_sector:{sub}")


def source(fdb, target, provider, need="index_price"):
    return proposals.capture(
        source_agent="source-discovery", kind="source_adapter", target=target,
        proposal=f"Build an adapter for {provider}",
        payload={"source": {"provider": provider}, "need": {"id": need}},
        need_id=need, signal=f"need:{need}")


def check(fdb, name, fires, need=None):
    return proposals.capture(
        source_agent="quality-triage", kind="quality_check", target=canonical.check_name(name),
        proposal=f"Add a check {name}", payload={"check_name": name, "fires_for": fires},
        need_id=need or f"quality:{fires}", signal=f"check:{fires}")


# --------------------------------------------------------------------------- #
# canonical keys
# --------------------------------------------------------------------------- #

def test_canonical_keys_collapse_the_31_oct_spellings():
    fred = {canonical.provider(x) for x in
            ("FRED", "fred", "fred_index", "fred_idx", "Federal Reserve Bank of St. Louis",
             "Federal Reserve Economic Data (FRED)")}
    assert fred == {"fred"}, fred
    av = {canonical.provider(x) for x in
          ("Alpha Vantage", "alpha_vantage", "AlphaVantage", "alpha_vantage_api",
           "Alpha Vantage Inc.", "alpha_vantage_fundamentals")}
    assert av == {"alpha_vantage"}, av
    assert canonical.provider("Nasdaq Data Link") == canonical.provider("quandl")
    assert canonical.provider("ECB") == canonical.provider("European Central Bank") == "ecb"
    for x in ("FRED", "Finnhub.io", "Twelve Data (Italy/US)"):
        assert canonical.provider(canonical.provider(x)) == canonical.provider(x)

    codes = [m["metric_code"] for m in json.loads(
        (ROOT / "engine/sources/metric_catalog.json").read_text())["metrics"]]
    assert canonical.resolve_kpi("average_revenue_per_user", codes) == "arpu"
    assert canonical.resolve_kpi("ARPU", codes) == "arpu"
    assert canonical.resolve_kpi("Capacity-Utilisation", codes) == "capacity_utilization"
    assert canonical.resolve_kpi("book_to_bill_ratio", codes) == "book_to_bill"
    assert canonical.resolve_kpi("crop_yield", codes) is None
    assert canonical.kpi_concept("Crop-Yields") == canonical.kpi_concept("crop_yield")

    a = canonical.canonical_key("catalog_kpi", "crop_yield", {"applies_to": "Agriculture"})
    b = canonical.canonical_key("catalog_kpi", "CropYields", {"applies_to": "Agriculture"})
    assert a == b == "catalog_kpi:crop_yield@materials", (a, b)
    # Same concept, another sub-sector of the same sector: one decision.
    assert canonical.canonical_key("catalog_kpi", "x", {"applies_to": "Semiconductors"}) == \
        canonical.canonical_key("catalog_kpi", "x", {"applies_to": "Electronics"})
    # The PROPOSED check is the identity, never the firing one.
    q1 = canonical.canonical_key("quality_check", "missing_revenue",
                                 {"check_name": "check_alt_revenue_tags"})
    q2 = canonical.canonical_key("quality_check", "stale_filings",
                                 {"check_name": "alt_revenue_tag_validation"})
    assert q1 == q2 == "quality_check:alt_revenue_tag", (q1, q2)
    assert canonical.canonical_key("source_adapter", "fred_idx", {"source": {"provider": "FRED"}},
                                   "macro_fred") == "source_adapter:fred@macro_fred"


def test_xbrl_tags_are_normalised_or_rejected():
    assert canonical.xbrl_tag("us-gaap_InvestmentsInPropertyPlantAndEquipment") == \
        "us-gaap:InvestmentsInPropertyPlantAndEquipment"
    assert canonical.xbrl_tag("US-GAAP: NetIncomeLoss") == "us-gaap:NetIncomeLoss"
    assert canonical.xbrl_tag("Revenues") == "us-gaap:Revenues"
    assert canonical.xbrl_tag("ifrs:Revenue") == "ifrs-full:Revenue"
    for bad in ("Cost per bushel", "foo:Bar", "us-gaap:netIncome", "", None):
        assert canonical.xbrl_tag(bad) is None, bad


# --------------------------------------------------------------------------- #
# capture: blocks, gating, evidence, scope
# --------------------------------------------------------------------------- #

def test_synonym_blocked_after_decline_and_the_need_stays_open():
    fdb = _fakepg.install()
    open_need(fdb, "index_price", kind="price")
    open_need(fdb, "sector_kpi_xbrl")
    open_need(fdb, "quality:missing_revenue", kind="quality")

    r = source(fdb, "fred_idx", "fred_idx")
    assert r["action"] == "created", r
    assert proposals.decide(r["id"], "decline", actor="owner")["status"] == "declined"
    for spelling, prov in (("FRED", "FRED"), ("fred_index", "Federal Reserve Bank of St. Louis")):
        again = source(fdb, canonical.provider(prov), prov)
        assert again == {"action": "blocked_declined", "id": r["id"]}, again
    # Declining rejected the solution, not the need.
    assert fdb.needs["index_price"]["status"] == "open"

    k = kpi(fdb, "crop_yield", "Agriculture")
    proposals.decide(k["id"], "decline", actor="owner")
    assert kpi(fdb, "Crop-Yields", "Agriculture")["action"] == "blocked_declined"
    # Another sector is a different decision.
    assert kpi(fdb, "crop_yield", "Food & Beverage")["action"] == "created"

    q = check(fdb, "check_alt_revenue_tags", "missing_revenue")
    proposals.decide(q["id"], "decline", actor="owner")
    assert check(fdb, "alt_revenue_tag_validation", "missing_revenue")["action"] == \
        "blocked_declined"
    assert len(fdb.proposals) == 4


def test_legacy_rows_are_rekeyed_so_old_declines_block_synonyms():
    fdb = _fakepg.install()
    open_need(fdb, "index_price", kind="price")
    open_need(fdb, "quality:stale_filings", kind="quality")
    open_need(fdb, "sector_kpi_xbrl")
    old = fdb.add_proposal(kind="source_adapter", target="FRED", status="declined",
                           evidence_count=20, dedup_key="source_adapter:FRED",
                           payload={"source": {"id": "FRED"}, "need": {"id": "index_price"}})
    noisy = fdb.add_proposal(kind="quality_check", target="stale_filings", evidence_count=99,
                             dedup_key="quality_check:stale_filings",
                             how_used="feeds the ESG scoring engine",
                             payload={"check_name": "latest_filing_only",
                                      "fires_for": "stale_filings"})
    legacy_kpi = fdb.add_proposal(kind="catalog_kpi", target="spectrum_holdings",
                                  dedup_key="catalog_kpi:spectrum_holdings",
                                  proposal="Spectrum holdings, rewritten by enrich",
                                  payload={"legacy": True})
    fdb.taxonomy.append({"kind": "catalog_proposal", "target": "spectrum_holdings",
                         "change": "propose for Telecom: Spectrum Holdings"})

    assert source(fdb, "fred", "fred_index") == {"action": "blocked_declined", "id": old}
    p = fdb.proposals
    assert p[noisy]["evidence_count"] == 1 and p[noisy]["signals"] == ["check:stale_filings"]
    assert "rekeyed" in fdb.events_for(noisy)
    assert p[noisy]["need_id"] == "quality:stale_filings"
    assert p[noisy]["how_used"] == proposals.grounded_how_used("quality_check")
    assert p[old]["how_used"] is None                    # decided: the words read stay
    assert p[legacy_kpi]["payload"]["inferred_scope"] == "Telecom"
    assert p[legacy_kpi]["canonical_key"] == "catalog_kpi:spectrum_holding@communication_services"
    # Idempotent: a second pass touches nothing.
    assert proposals.backfill_canonical(force=True) == {"rekeyed": 0}


def test_a_kpi_already_in_the_catalogue_is_never_raised():
    fdb = _fakepg.install()
    open_need(fdb, "sector_kpi_xbrl")
    fdb.catalog["capex_intensity"] = {"metric_code": "capex_intensity"}
    for code in ("average_revenue_per_user", "capacity_utilisation", "Capex-Intensity"):
        r = kpi(fdb, code, "Telecom")
        assert r["action"] == "in_catalogue", (code, r)
    assert fdb.proposals == {}


def test_agents_propose_against_open_needs_only():
    fdb = _fakepg.install()
    open_need(fdb, "macro_fred", kind="macro", status="parked", park_until="2027-03-31")
    open_need(fdb, "index_valuation", kind="index_valuation", status="answered_by_roadmap")
    open_need(fdb, "index_price", kind="price")
    assert source(fdb, "fred", "FRED", need="macro_fred")["action"] == "blocked_need"
    assert source(fdb, "x", "Acme", need="index_valuation")["need_status"] == "answered_by_roadmap"
    assert source(fdb, "x", "Acme", need="no_such_need")["need_status"] == "missing"
    assert source(fdb, "x", "Acme", need="index_price")["action"] == "created"
    assert len(fdb.proposals) == 1


def test_evidence_counts_distinct_signals_and_scopes_merge():
    fdb = _fakepg.install()
    open_need(fdb, "sector_kpi_xbrl")
    first = kpi(fdb, "wafer_starts", "Semiconductors")
    assert first["action"] == "created"
    again = kpi(fdb, "wafer_starts", "Semiconductors")          # next week, same signal
    assert again["action"] == "seen" and again["evidence_count"] == 1, again
    other = kpi(fdb, "Wafer-Starts", "Electronics")             # same sector, new sub-sector
    assert other == {"action": "bumped", "id": first["id"], "evidence_count": 2}, other
    row = fdb.proposals[first["id"]]
    assert row["payload"]["applies_to"] == "Semiconductors; Electronics", row["payload"]
    assert row["payload"]["scopes"] == ["Semiconductors", "Electronics"]
    assert row["signals"] == ["sub_sector:Semiconductors", "sub_sector:Electronics"]
    assert fdb.events_for(first["id"]).count("evidence_bumped") == 1

    open_need(fdb, "quality:missing_revenue", kind="quality")
    open_need(fdb, "quality:missing_net_income", kind="quality")
    a = check(fdb, "check_alt_revenue_tags", "missing_revenue")
    assert check(fdb, "check_alt_revenue_tags", "missing_revenue")["evidence_count"] == 1
    b = check(fdb, "alt_revenue_tag_check", "missing_net_income",
              need="quality:missing_net_income")
    assert b["id"] == a["id"] and b["evidence_count"] == 2, b


def test_parked_blocks_synonyms_but_still_gathers_evidence():
    fdb = _fakepg.install()
    open_need(fdb, "sector_kpi_xbrl")
    pid = kpi(fdb, "crop_yield", "Agriculture")["id"]
    proposals.decide(pid, "park", actor="owner", park_min_evidence=3)
    r = kpi(fdb, "crop_yields", "Agriculture")
    assert r["action"] == "blocked_parked" and fdb.proposals[pid]["status"] == "parked"
    # An unscoped (legacy) parked decision covers every sector.
    fdb.add_proposal(kind="catalog_kpi", target="livestock_count", status="parked",
                     canonical_key="catalog_kpi:livestock_count@all", dedup_key="lc")
    assert kpi(fdb, "livestock_counts", "Agriculture")["action"] == "blocked_parked"
    assert len(fdb.proposals) == 2
    # A legacy pending synonym sharing the parked key does not let the idea through.
    open_need(fdb, "index_price", kind="price")
    tiingo = fdb.add_proposal(kind="source_adapter", target="Tiingo", status="parked",
                              dedup_key="t1", payload={"source": {"provider": "Tiingo"},
                                                       "need": {"id": "index_price"}})
    fdb.add_proposal(kind="source_adapter", target="tiingo_eod", dedup_key="t2",
                     payload={"source": {"provider": "Tiingo, Inc."},
                              "need": {"id": "index_price"}})
    proposals._BACKFILLED = False                         # as on the first run after deploy
    assert source(fdb, "tiingo", "Tiingo") == {"action": "blocked_parked", "id": tiingo,
                                               "evidence_count": 1}


# --------------------------------------------------------------------------- #
# expiry
# --------------------------------------------------------------------------- #

def test_checks_list_matches_the_code():
    src = (ROOT / "engine/quality.py").read_text()
    emitted = set(re.findall(r'"check_name": "([a-z_]+)"', src))
    assert emitted == set(quality.CHECKS), emitted ^ set(quality.CHECKS)


def test_expiry_when_the_trigger_is_gone():
    fdb = _fakepg.install()
    open_need(fdb, "quality:shares_concept_disagreement", kind="quality")
    open_need(fdb, "quality:stale_filings", kind="quality")
    open_need(fdb, "index_valuation", kind="index_valuation", status="answered_by_roadmap")
    open_need(fdb, "sector_kpi_non_xbrl", status="parked")
    fdb.catalog["capex_intensity"] = {"metric_code": "capex_intensity"}
    retired = fdb.add_proposal(kind="quality_check", target="shares_concept_disagreement",
                               payload={"legacy": True}, canonical_key="q1")
    in_cat = fdb.add_proposal(kind="catalog_kpi", target="capex_intensity", canonical_key="k1")
    answered = fdb.add_proposal(kind="source_adapter", target="x", need_id="index_valuation",
                                canonical_key="s1")
    stale = fdb.add_proposal(kind="quality_check", target="y", canonical_key="q2",
                             payload={"fires_for": "stale_filings"},
                             last_seen=_fakepg.days_ago(fdb, proposals.EXPIRY_DAYS + 1))
    fresh = fdb.add_proposal(kind="quality_check", target="z", canonical_key="q3",
                             payload={"fires_for": "stale_filings"},
                             last_seen=_fakepg.days_ago(fdb, 3))
    parked_need = fdb.add_proposal(kind="catalog_kpi", target="bushel_cost", canonical_key="k2",
                                   need_id="sector_kpi_non_xbrl")
    declined = fdb.add_proposal(kind="quality_check", target="w", status="declined",
                                payload={"legacy": True}, canonical_key="q4")

    out = proposals.expire_stale()
    assert sorted(out["expired"]) == sorted([retired, in_cat, answered, stale]), out
    for pid, why in ((retired, "shares_concept_disagreement was retired"),
                     (in_cat, "capex_intensity is already in the catalogue"),
                     (answered, "index_valuation is answered_by_roadmap"),
                     (stale, f"for {proposals.EXPIRY_DAYS} days")):
        assert fdb.proposals[pid]["status"] == "expired"
        assert why in fdb.proposals[pid]["action_detail"], fdb.proposals[pid]["action_detail"]
        ev = [e for e in fdb.events if e["proposal_id"] == pid and e["event"] == "expired"]
        assert ev and ev[0]["from_status"] == "pending" and ev[0]["to_status"] == "expired"
    for pid in (fresh, parked_need, declined):
        assert fdb.proposals[pid]["status"] != "expired"
    assert proposals.expire_stale() == {"expired": []}
    # An expired decision cannot be re-decided...
    assert "cannot re-decide" in proposals.decide(stale, "approve", actor="owner")["error"]


def test_daily_expiry_rekeys_legacy_rows_first():
    """Expiry runs daily, the agents weekly: a legacy row's need is known only once it is
    re-keyed, so the daily pass must not wait for Wednesday's capture()."""
    fdb = _fakepg.install()
    open_need(fdb, "index_valuation", kind="index_valuation", status="answered_by_roadmap")
    pid = fdb.add_proposal(kind="source_adapter", target="fred_idx", dedup_key="legacy",
                           payload={"source": {"provider": "FRED"},
                                    "need": {"id": "index_valuation"}})
    assert proposals.expire_stale() == {"expired": [pid]}
    assert fdb.proposals[pid]["need_id"] == "index_valuation"
    assert fdb.events_for(pid) == ["rekeyed", "expired"]


def test_an_expired_proposal_raised_again_is_revived():
    fdb = _fakepg.install()
    open_need(fdb, "quality:stale_filings", kind="quality")
    pid = check(fdb, "vintage_gap", "stale_filings")["id"]
    fdb.proposals[pid]["last_seen"] = _fakepg.days_ago(fdb, 90)
    proposals.expire_stale()
    assert fdb.proposals[pid]["status"] == "expired"
    r = check(fdb, "vintage_gap_check", "stale_filings")
    assert r["action"] == "revived" and fdb.proposals[pid]["status"] == "pending"
    assert "revived" in fdb.events_for(pid)


def test_unpark_restarts_the_clock_and_reopens_due_needs():
    fdb = _fakepg.install()
    open_need(fdb, "macro_fred", kind="macro", status="parked",
              park_until=(date.today() - timedelta(days=1)).isoformat())
    open_need(fdb, "japan_fundamentals", kind="fundamentals", status="parked",
              park_until="2099-03-01")
    pid = fdb.add_proposal(status="parked", park_until=date.today(), canonical_key="k",
                           last_seen=_fakepg.days_ago(fdb, 400))
    out = proposals.unpark()
    assert out == {"unparked": [pid], "needs_reopened": ["macro_fred"]}, out
    assert fdb.needs["japan_fundamentals"]["status"] == "parked"
    assert proposals.expire_stale() == {"expired": []}      # resurfaced today, not stale


# --------------------------------------------------------------------------- #
# approval: no clobber, verified tags only
# --------------------------------------------------------------------------- #

CURATED = {"metric_code": "capacity_utilization", "label": "Capacity Utilization Rate",
           "definition": "Output as a percentage of installed capacity.", "unit": "percent",
           "category": "kpi",
           "applies_to": "Materials (chemicals, steel, paper, cement), refining, some industrials",
           "in_xbrl": False, "xbrl_tags": [], "source_if_not_xbrl": "mgmt_mdna",
           "importance": "high", "notes": "No standardized us-gaap tag."}


def test_approving_an_existing_code_never_clobbers_the_curated_row():
    fdb = _fakepg.install()
    fdb.catalog["capacity_utilization"] = dict(CURATED)
    pid = fdb.add_proposal(kind="catalog_kpi", target="capacity_utilization",
                           canonical_key="k", payload={"label": "Capacity utilisation",
                                                       "category": "sector_kpi",
                                                       "importance": "medium"})
    res = proposals.decide(pid, "approve", actor="owner", note="looks fine",
                           applies_to="all")
    assert res["status"] == "approved"
    row = fdb.proposals[pid]
    assert row["status"] == "actioned", row
    assert row["action_detail"].startswith("already in catalogue, no change"), row["action_detail"]
    live = fdb.catalog["capacity_utilization"]
    for k, v in CURATED.items():
        if k != "notes":
            assert live[k] == v, (k, live[k])
    assert live["notes"].startswith("No standardized us-gaap tag. | approved again")
    assert 'approver\'s scope "all" recorded here, not applied' in live["notes"]
    assert "looks fine" in live["notes"]


def test_a_new_kpi_gets_in_xbrl_only_from_verified_tags():
    fdb = _fakepg.install()
    guess = fdb.add_proposal(kind="catalog_kpi", target="bushel_cost", canonical_key="a",
                             payload={"applies_to": "Agriculture",
                                      "xbrl_tags": ["us-gaap:CostPerBushel"]})
    proposals.decide(guess, "approve", actor="owner")
    assert fdb.catalog["bushel_cost"]["in_xbrl"] is False
    assert fdb.catalog["bushel_cost"]["xbrl_tags"] == []
    assert fdb.catalog["bushel_cost"]["applies_to"] == "Agriculture"
    assert "no verified XBRL tags" in fdb.proposals[guess]["action_detail"]
    ok = fdb.add_proposal(kind="catalog_kpi", target="warranty_reserve", canonical_key="b",
                          payload={"applies_to": "Electronics", "xbrl_verified": True,
                                   "xbrl_tags": ["us-gaap:ProductWarrantyAccrual"]})
    proposals.decide(ok, "approve", actor="owner")
    assert fdb.catalog["warranty_reserve"]["in_xbrl"] is True


# --------------------------------------------------------------------------- #
# enrich: scope kept, how_used grounded
# --------------------------------------------------------------------------- #

def test_enrich_keeps_the_scope_and_grounds_how_used():
    reply = {"proposal": "Add spectrum holdings to the catalogue.", "reason": "r",
             "expected_outcome": "o", "consumers": ["ingestion", "esg_scoring_engine"],
             "worked_examples": [{"situation": "s", "today": "t", "after": "a"}]}
    fdb = _fakepg.install(llm_reply=lambda role, system, user: json.dumps(reply))
    pid = fdb.add_proposal(kind="catalog_kpi", target="spectrum_holdings", canonical_key="k",
                           proposal="propose for Telecom: Spectrum Holdings")
    out = proposals.enrich(limit=5)
    assert out == {"enriched": [pid], "failed": []}, out
    row = fdb.proposals[pid]
    assert row["proposal"] == "Add spectrum holdings to the catalogue."
    assert row["payload"]["inferred_scope"] == "Telecom"
    assert row["how_used"].startswith("Read by: EDGAR and ESEF ingestion"), row["how_used"]
    assert "esg" not in row["how_used"].lower()
    assert "metric_catalog.json" in row["how_used"]
    # Approval still writes the sector the prose named, though the prose is gone.
    proposals.decide(pid, "approve", actor="owner")
    assert fdb.catalog["spectrum_holdings"]["applies_to"] == "Telecom"
    assert "INFERRED" in fdb.catalog["spectrum_holdings"]["notes"]


def test_enrich_survives_a_reply_that_is_not_an_object():
    fdb = _fakepg.install(llm_reply=lambda role, system, user: "[1, 2]")
    pid = fdb.add_proposal(canonical_key="k")
    out = proposals.enrich(limit=5)
    assert out["enriched"] == [] and out["failed"][0]["id"] == pid, out
    assert fdb.proposals[pid]["needs_enrichment"] is True


def test_how_used_comes_only_from_the_consumer_list():
    menu = proposals.CONSUMERS["quality_check"]
    every = proposals.grounded_how_used("quality_check")
    assert all(v in every for v in menu.values())
    assert proposals.grounded_how_used("quality_check", ["Pricing-Power Factor"]) == every
    assert proposals.grounded_how_used("quality_check", []).startswith("Nothing in the code")
    one = proposals.grounded_how_used("quality_check", ["picks"])
    assert menu["picks"] in one and menu["triage"] not in one
    fdb = _fakepg.install()
    open_need(fdb, "quality:stale_filings", kind="quality")
    pid = check(fdb, "vintage_gap", "stale_filings")["id"]
    assert fdb.proposals[pid]["how_used"] == every
    # Every file a consumer names exists.
    for kind in proposals.CONSUMERS.values():
        for text in kind.values():
            for f in re.findall(r"(?:engine|dashboard)/[\w/]+\.(?:py|json|js)\b", text):
                assert (ROOT / f).exists(), f


# --------------------------------------------------------------------------- #
# migration 0017 and the Edge Function twin
# --------------------------------------------------------------------------- #

MIGRATION = ROOT / "engine/migrations/0017_needs_register.sql"


def _statements(sql: str) -> list[str]:
    sql = re.sub(r"--[^\n]*", "", sql)
    sql = re.sub(r"\$\$.*?\$\$", "$$BODY$$", sql, flags=re.S)
    return [" ".join(s.split()).lower() for s in sql.split(";") if s.strip()]


def test_migration_0017_is_rerunnable_and_deletes_nothing():
    stmts = _statements(MIGRATION.read_text())
    assert stmts, "empty migration"
    dropped = set()
    for s in stmts:
        assert not re.match(r"(delete|truncate|drop table|drop column)", s), s
        if s.startswith("alter table") and " add column " in s:
            assert " add column if not exists " in s, s
        if s.startswith("create index") or s.startswith("create table"):
            assert "if not exists" in s, s
        m = re.search(r"drop constraint if exists (\w+)", s)
        if m:
            dropped.add(m.group(1))
        m = re.search(r"add constraint (\w+)", s)
        if m:
            # Either dropped by name first, or by the catalogue loop in the DO block.
            assert m.group(1) in dropped or (m.group(1) == "proposals_status_check"
                                             and any("do $$body$$" in x for x in stmts)), s
        if s.startswith("update "):
            # A second run must find nothing left to change.
            assert re.search(r"status = 'open'|<> 'invented'|is null", s), s
    body = re.search(r"\$\$(.*?)\$\$", MIGRATION.read_text(), flags=re.S).group(1)
    assert "drop constraint" in body and "'proposals'::regclass" in body
    # The 0013 status list survives, plus 'expired'.
    allowed = re.search(r"check \(status in \(([^)]*)\)\)",
                        [s for s in stmts if "proposals_status_check check" in s][0]).group(1)
    for st in ("pending", "approved", "actioned", "queued_build", "declined", "parked",
               "failed", "expired"):
        assert f"'{st}'" in allowed, st


def test_migration_keeps_every_researched_lead():
    sql = MIGRATION.read_text()
    listed = set(re.findall(r"'([a-z0-9_]+)'", sql.split("array[", 1)[1].split("]", 1)[0]))
    seeds = {s["id"] for s in json.loads(
        (ROOT / "engine/sources/seed_catalog.json").read_text())["sources"]}
    # All 40 seed rows of 2026-11-05. A row seeded later is inserted after 0017 has run,
    # so it needs no entry here, and an applied migration is never edited.
    assert listed <= seeds and len(listed) == 40, (len(listed), listed - seeds)


def test_edge_function_mirrors_no_clobber_and_verified_tags():
    """There is no Deno harness here, so this is the careful read, made repeatable."""
    ts = (ROOT / "supabase/functions/admin/index.ts").read_text()
    body = ts[ts.index("async function applyCatalogKpi("):ts.index("async function applyModelRouting(")]
    assert ".upsert(" not in body, "an upsert on metric_catalog would overwrite curated fields"
    assert body.index("if (existing)") < body.index(".insert(")
    exist = body[body.index("if (existing)"):body.index(".insert(")]
    assert ".update({ notes:" in exist and "already in catalogue, no change" in exist
    for field in ("label", "applies_to", "category", "importance", "source_if_not_xbrl"):
        assert f"{field}:" not in exist, field
    assert "payload.xbrl_verified === true" in body
    assert "payload.inferred_scope" in body
    will = ts[ts.index("function willWrite("):]
    assert "pay.xbrl_verified === true" in will and "pay.inferred_scope" in will
    assert 'const TERMINAL = new Set(["declined", "actioned", "expired"]);' in ts


def test_python_sources_parse():
    for f in ("engine/proposals.py", "engine/canonical.py", "engine/quality.py"):
        ast.parse((ROOT / f).read_text())


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("proposal queue tests passed")
