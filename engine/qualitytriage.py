"""Quality-Triage Agent — LLM layer over engine/quality.py's findings.

Explains root causes for the data-quality checks firing most this run, and
proposes ONE new deterministic check per firing check that would catch the
same class of problem earlier or more precisely. Cheap tier; no-op without an
API key (quality.run()'s deterministic checks already ran regardless).

Runs "on findings" — only when the deterministic quality job actually raised
issues — so it never sits in the hot path of a clean run.
"""
from __future__ import annotations

import json

from . import db, llm, memory


def triage_issues(report: dict, max_checks: int = 4) -> dict:
    if not llm.LLM_ENABLED:
        return {"skipped": "no API key — deterministic quality.run() checks still ran"}

    by_check = report.get("by_check", {})
    top = sorted(by_check.items(), key=lambda kv: kv[1], reverse=True)[:max_checks]
    all_issues = report.get("issues", [])

    system = (
        "You triage data-quality warnings for a fintech fundamentals pipeline. "
        "Given a check name and a sample of its firings, explain the likely ROOT "
        "CAUSE and propose ONE new deterministic check that would catch this "
        'earlier or more precisely. Return ONLY a JSON object: {"root_cause", '
        '"fix", "new_check": {"name": snake_case, "logic": "one paragraph, '
        'pseudocode-level", "rationale"}}.'
    )
    triaged = []
    for check_name, count in top:
        sample = [i for i in all_issues if i.get("check_name") == check_name][:5]
        user = json.dumps({"check_name": check_name, "count": count, "sample": sample}, default=str)
        try:
            txt = llm.call("quality_triage", system, user, max_tokens=1200, json_mode=True)
            obj = json.loads(txt)
        except Exception as e:
            triaged.append({"check_name": check_name, "error": str(e)[:160]})
            continue
        nc = obj.get("new_check") or {}
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "insert into taxonomy_changes(kind,target,change,reason,auto) "
                "values('quality_check',%s,%s,%s,false)",
                (check_name, f"propose new check {nc.get('name', '?')}: {nc.get('logic', '')}",
                 obj.get("root_cause", "")))
            c.commit()
        triaged.append({"check_name": check_name, "root_cause": obj.get("root_cause"),
                        "proposed_check": nc.get("name")})
        if nc.get("name") and nc.get("rationale"):
            memory.capture(
                f"quality:{check_name}", f"{nc['name']} — {nc['rationale']}",
                kind="quality_check", origin="quality-triage agent", confidence=0.35,
                testable=True, test_hint=nc.get("logic"))
    return {"triaged": triaged}
