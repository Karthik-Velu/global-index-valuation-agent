"""One ingestion-improvement pass.

For each data need: probe every adapter that serves it, score them, pick the best
(preferring license-clean sources for public needs), rewire the active source if a
better one exists, flag failures/gaps, and write a report. Deterministic + free;
LLM discovery is an optional add-on (engine/dataagent/discover.py).
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from ..config import DATA_DIR
from ..sources import adapters, registry
from ..sources.base import DataKind
from ..universe import UNIVERSE
from . import probe

REPORT_PATH = DATA_DIR / "dataagent_report.json"

# The needs register (ADR-044). A proposal is a SOLUTION to one of these; declining
# it rejects the solution and leaves the need where it was. Agents propose against
# `open` needs only. Seeded insert-only, so editing a row's status in the DB (the
# owner's call) is never reverted by the next run. The first three are the original
# source needs; the rest are the genuine needs the 31 Oct 2026 queue review found.
DEFAULT_NEEDS = [
    {"id": "index_price", "kind": "price", "market_scope": "all index proxies",
     "description": "EOD price for every index proxy", "public_only": True, "target_freq": "daily"},
    {"id": "index_valuation", "kind": "index_valuation", "market_scope": "all index proxies",
     "description": "P/E, P/B, yield at index level", "public_only": True,
     "target_freq": "weekly", "status": "answered_by_roadmap",
     "roadmap_ref": "Phase 2 bottom-up valuation from EDGAR constituents (docs/PLAN.md)",
     "status_note": "No proposed source qualified on 31 Oct 2026: all personal-use, paid, "
                    "price-only or vendor-copyrighted."},
    {"id": "stock_fundamentals", "kind": "fundamentals", "market_scope": "non-US first (coverage gap)",
     "description": "stock-level financials/ratios/growth", "public_only": True, "target_freq": "weekly",
     "status": "answered_by_roadmap",
     "roadmap_ref": "ADR-031: regulators jurisdiction by jurisdiction, Europe (ESEF) first",
     "status_note": "Japan (EDINET) is its own parked need, japan_fundamentals."},
    {"id": "japan_fundamentals", "kind": "fundamentals", "market_scope": "Japan",
     "description": "Japanese stock fundamentals from EDINET (FSA): Japan Public Data "
                    "License 1.0, free key. Build on API v2.",
     "public_only": True, "target_freq": "weekly", "status": "parked",
     "park_until": "2027-03-01", "status_note": "ADR-031 puts it after ESEF."},
    {"id": "macro_fred", "kind": "macro", "market_scope": "US macro",
     "description": "FRED macro series (public-domain BLS/BEA data)", "public_only": True,
     "target_freq": "weekly", "status": "parked", "park_until": "2027-03-31",
     "roadmap_ref": "docs/ROADMAP.md item 1c (news + macro)"},
    {"id": "sector_kpi_xbrl", "kind": "sector_kpi", "market_scope": "thin-coverage sub-sectors",
     "description": "Sector operating KPIs that issuers file in XBRL and the catalogue lacks",
     "public_only": True, "target_freq": "weekly"},
    {"id": "sector_kpi_non_xbrl", "kind": "sector_kpi", "market_scope": "sector KPIs outside XBRL",
     "description": "Sector operating KPIs that are not in XBRL (subscribers, ARPU, production "
                    "volumes, crop yield, cost per bushel, livestock counts)",
     "public_only": True, "target_freq": "weekly", "status": "parked", "park_until": "2027-06-30",
     "status_note": "Needs a non-XBRL extraction capability (MD&A text) that does not exist "
                    "yet. The review date is a placeholder; the brief gave none."},
    {"id": "kpi:warranty_cost_ratio", "kind": "sector_kpi", "market_scope": "Electronics",
     "description": "Warranty cost ratio, computable from EDGAR for some Electronics issuers",
     "public_only": True, "target_freq": "weekly", "status": "parked", "park_until": "2027-01-31"},
    {"id": "quality:missing_revenue", "kind": "quality", "market_scope": "data quality",
     "description": "False missing_revenue alerts when a company uses an alternate revenue tag",
     "public_only": True, "status": "answered_by_roadmap",
     "roadmap_ref": "proposal #60, approved by the owner and queued for build as a GitHub issue"},
    {"id": "quality:stale_filings", "kind": "quality", "market_scope": "data quality",
     "description": "stale_filings fires every night; the noise is real",
     "public_only": True,
     "status_note": "Proposal #63 (keep only the latest filing per period) was withdrawn by the "
                    "owner: it would break point-in-time vintages (ADR-005)."},
    {"id": "quality:negative_value", "kind": "quality", "market_scope": "data quality",
     "description": "negative_value findings on balance-sheet items and share counts",
     "public_only": True, "status": "answered_by_roadmap",
     "roadmap_ref": "ADR-043 share-count plan (PR #76)"},
    {"id": "quality:shares_multiclass_unsummed", "kind": "quality", "market_scope": "data quality",
     "description": "Per-class share facts that should be summed, so market cap is understated",
     "public_only": True, "status": "answered_by_roadmap",
     "roadmap_ref": "ADR-043 share-count plan (PR #76)"},
]

# Kinds that a source adapter can serve; the other needs belong to the sector-KPI
# and quality agents and are never probed.
SOURCE_KINDS = {k.value for k in DataKind}


def seed_needs() -> list[str]:
    """Insert the register's needs that are missing. Idempotent: returns the ids it
    added, which is empty on every run after the first."""
    return [n["id"] for n in DEFAULT_NEEDS if registry.add_need(n)]


# Stock-ticker sample for the fundamentals need (US + non-US, to test coverage).
FUND_SAMPLE = ["AAPL", "MSFT", "NVDA", "SAP.DE", "RELIANCE.NS", "7203.T"]


def sample_keys(n: int = 8) -> list[str]:
    """A region-spread INDEX sample (incl. weak-coverage EM) to test coverage."""
    pref = ["us_sp500", "japan", "germany", "uk", "brazil", "china_broad", "india_broad",
            "south_africa", "indonesia", "saudi", "vietnam", "mexico"]
    keys = [k for k in pref if any(ix.key == k for ix in UNIVERSE)]
    return keys[:n] or [ix.key for ix in UNIVERSE[:n]]


def _sample_for(kind: str, idx_keys: list[str]) -> list[str]:
    return FUND_SAMPLE if kind == "fundamentals" else idx_keys


def _pick_best(scored, public_only: bool):
    usable = [(a, sc) for a, sc in scored if sc.error is None and (sc.quality_score or 0) > 0]
    if not usable:
        return None
    if public_only:
        pub = [(a, sc) for a, sc in usable if a.public_safe()]
        pool = pub or usable   # fall back to best available, but we'll flag it
    else:
        pool = usable
    return max(pool, key=lambda x: x[1].quality_score)


def run(sample_n: int = 8, auto_apply: bool = True, with_discovery: bool = False) -> dict:
    asof = date.today().isoformat()
    print(f"== Data-Ingestion Agent — pass {asof} ==")
    try:
        seed_needs()
    except Exception as e:  # noqa: BLE001 — the register serves the agents; probing must not need it
        print(f"   needs seed skipped: {str(e)[:120]}")
    n_seed = registry.seed_from_catalog()
    if n_seed:
        print(f"   catalog: {n_seed} researched sources loaded as leads")
    idx_keys = sample_keys(sample_n)
    report = {"asof": asof, "generated_at": datetime.now(timezone.utc).isoformat(),
              "sample_keys": idx_keys, "needs": [], "alerts": [], "decisions": [],
              "leads_to_adapt": []}

    for need in registry.list_needs():
        kind = need["kind"]
        # A KPI or quality need has no adapter to probe, and a parked one is deferred
        # on purpose (probing japan_fundamentals would just re-score EDGAR).
        if kind not in SOURCE_KINDS or need.get("status") == "parked":
            continue
        keys = _sample_for(kind, idx_keys)
        cands = adapters.adapters_for(kind)
        scored = []
        for a in cands:
            if not a.available():
                report["alerts"].append({"need": need["id"], "source": a.id,
                                         "issue": f"needs key {a.requires_key_env}"})
                continue
            sc = probe.probe(a, kind, keys)
            registry.record_eval(sc.as_eval())
            registry.upsert_source({"id": a.id, "name": a.name, "provider": a.provider,
                                    "kinds": [k.value for k in a.kinds], "coverage": a.markets,
                                    "access_method": a.access_method, "endpoint": a.endpoint,
                                    "license": a.license.value, "has_adapter": True,
                                    "verified_live": sc.error is None, "status": "candidate"},
                                   authoritative=True)
            scored.append((a, sc))
            flag = "OK" if sc.error is None else f"FAIL({sc.error[:30]})"
            print(f"  {need['id']:<18} {a.id:<7} q={sc.quality_score} cov={sc.coverage_pct} {flag}")

        best = _pick_best(scored, bool(need["public_only"]))
        cur = need["active_source_id"]
        need_row = {"need": need["id"], "kind": kind, "active": cur,
                    "candidates": [{"source": a.id, "quality": sc.quality_score,
                                    "coverage": sc.coverage_pct, "license": a.license.value,
                                    "public_safe": a.public_safe(), "error": sc.error}
                                   for a, sc in scored]}

        if best:
            ba, bsc = best
            need_row["recommended"] = ba.id
            need_row["recommended_quality"] = bsc.quality_score
            if not ba.public_safe() and need["public_only"]:
                report["alerts"].append({"need": need["id"],
                                         "issue": "no license-clean source — using "
                                                  f"{ba.id} ({ba.license.value}); not public-safe"})
            if ba.id != cur:
                reason = f"quality {bsc.quality_score} (cov {bsc.coverage_pct}%), license {ba.license.value}"
                registry.set_active_source(need["id"], ba.id, reason, auto=auto_apply, applied=auto_apply)
                report["decisions"].append({"need": need["id"], "from": cur, "to": ba.id,
                                            "applied": auto_apply, "reason": reason})
        else:
            report["alerts"].append({"need": need["id"], "issue": "NO working source"})
            need_row["recommended"] = None

        report["needs"].append(need_row)

    if with_discovery:
        try:
            from .discover import discover_for_needs
            report["discovered"] = discover_for_needs(registry.list_needs())
        except Exception as e:
            report["discovered_error"] = str(e)[:200]

    # Leads (catalogued but no adapter yet) — the backlog of sources worth wiring in.
    leads = [s for s in registry.list_sources() if not s["has_adapter"]]
    leads.sort(key=lambda s: (s.get("confidence") == "high", s.get("license") in
                              ("public_domain", "redistribution_ok")), reverse=True)
    report["leads_to_adapt"] = [{"id": s["id"], "name": s["name"], "kinds": s["kinds"],
                                 "license": s["license"], "confidence": s["confidence"],
                                 "coverage": s["coverage"]} for s in leads[:10]]

    REPORT_PATH.write_text(json.dumps(report, indent=2))
    print(f"   {len(report['decisions'])} decision(s), {len(report['alerts'])} alert(s), "
          f"{len(leads)} lead(s). wrote {REPORT_PATH}")
    return report


if __name__ == "__main__":
    run()
