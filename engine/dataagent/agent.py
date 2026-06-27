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
from ..universe import UNIVERSE
from . import probe

REPORT_PATH = DATA_DIR / "dataagent_report.json"

# The needs the product has. Seeded on first run; editable in the DB thereafter.
DEFAULT_NEEDS = [
    {"id": "index_price", "kind": "price", "market_scope": "all index proxies",
     "description": "EOD price for every index proxy", "public_only": True, "target_freq": "daily"},
    {"id": "index_valuation", "kind": "index_valuation", "market_scope": "all index proxies",
     "description": "P/E, P/B, yield at index level", "public_only": True, "target_freq": "weekly"},
    {"id": "stock_fundamentals", "kind": "fundamentals", "market_scope": "non-US first (coverage gap)",
     "description": "stock-level financials/ratios/growth", "public_only": True, "target_freq": "weekly"},
]


def seed_needs() -> None:
    for n in DEFAULT_NEEDS:
        existing = {x["id"] for x in registry.list_needs()}
        if n["id"] not in existing:
            registry.upsert_need(n)


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
    seed_needs()
    n_seed = registry.seed_from_catalog()
    if n_seed:
        print(f"   catalog: {n_seed} researched sources loaded as leads")
    idx_keys = sample_keys(sample_n)
    report = {"asof": asof, "generated_at": datetime.now(timezone.utc).isoformat(),
              "sample_keys": idx_keys, "needs": [], "alerts": [], "decisions": [],
              "leads_to_adapt": []}

    for need in registry.list_needs():
        kind = need["kind"]
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
                                    "verified_live": sc.error is None, "status": "candidate"})
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
