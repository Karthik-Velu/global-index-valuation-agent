"""Orchestrate one Sector-Intelligence pass: tag stocks, validate the catalog,
(optionally) research new sub-sector KPIs, and write a report + changelog.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from ..config import DATA_DIR
from . import tagging, validate

REPORT_PATH = DATA_DIR / "sectoragent_report.json"


def run(tag_limit: int | None = None, with_research: bool = False) -> dict:
    print("== Sector-Intelligence Agent ==")
    tags = tagging.tag_securities(limit=tag_limit)
    print(f"   tagging: {tags['tagged']} securities ({tags['changed']} changed, {tags['unknown']} unknown)")

    val = validate.validate_catalog()
    suspect = [v for v in val if v["verdict"] == "suspect"]
    nodata = [v for v in val if v["verdict"] == "no_data"]
    ok = [v for v in val if v["verdict"] == "ok"]
    print(f"   catalog: {len(ok)} ok, {len(suspect)} SUSPECT, "
          f"{len(nodata)} no-data (need more companies)")
    for s in suspect:
        print(f"     ! {s['metric_code']}: {s['note']}")
    fixed = validate.auto_fix_suspects(val)
    if fixed:
        print(f"   auto-fixed {len(fixed)} suspect metric(s) -> demoted to 'computed', "
              f"purged bad data, catalog corrected: {fixed}")

    research = None
    if with_research:
        try:
            from .research import research_thin_subsectors
            research = research_thin_subsectors()
        except Exception as e:
            research = {"error": str(e)[:160]}

    report = {
        "asof": date.today().isoformat(),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "tagging": tags,
        "catalog": {"ok": len(ok), "suspect": [s["metric_code"] for s in suspect],
                    "no_data": len(nodata), "auto_fixed": fixed},
        "suspect_detail": suspect,
        "research": research,
    }
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"   wrote {REPORT_PATH}")
    return report


if __name__ == "__main__":
    run()
