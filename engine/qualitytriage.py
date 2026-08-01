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

from . import db, llm, memory, proposals


def triage_issues(report: dict, max_checks: int = 4) -> dict:
    if not llm.LLM_ENABLED:
        return {"skipped": "no API key — deterministic quality.run() checks still ran"}

    by_check = report.get("by_check", {})
    top = sorted(by_check.items(), key=lambda kv: kv[1], reverse=True)[:max_checks]
    all_issues = report.get("issues", [])

    # The 4-part format is asked for HERE, at the source, so the admin console has
    # something reviewable without a second LLM pass. proposals.enrich() is the
    # backstop for anything that still arrives bare (legacy rows, weaker tiers).
    system = (
        "You triage data-quality warnings for a fintech fundamentals pipeline, and "
        "your output is read by a non-engineer product owner who will approve or "
        "reject it. Given a check name and a sample of its firings, explain the "
        "likely ROOT CAUSE and propose ONE new deterministic check that would catch "
        "this earlier or more precisely.\n"
        'Return ONLY a JSON object: {"root_cause", "fix", '
        '"new_check": {"name": snake_case, "logic": "one paragraph, pseudocode-level", '
        '"rationale"}, "expected_outcome": "what measurably improves and how we would '
        'know", "worked_examples": [2-3 of {"situation","today","after"} using REAL '
        "identifiers from the sample — never invent numbers you were not given]}."
    )
    triaged = []
    for check_name, count in top:
        sample = [i for i in all_issues if i.get("check_name") == check_name][:5]
        user = json.dumps({"check_name": check_name, "count": count, "sample": sample}, default=str)
        try:
            txt, model_id = llm.call_with_model("quality_triage", system, user,
                                                max_tokens=1600, json_mode=True)
            obj = json.loads(txt)
        except Exception as e:
            triaged.append({"check_name": check_name, "error": str(e)[:160]})
            continue
        nc = obj.get("new_check") or {}
        # taxonomy_changes stays the append-only log of what the agent SAID...
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "insert into taxonomy_changes(kind,target,change,reason,auto) "
                "values('quality_check',%s,%s,%s,false)",
                (check_name, f"propose new check {nc.get('name', '?')}: {nc.get('logic', '')}",
                 obj.get("root_cause", "")))
            c.commit()
        # ...and this is the reviewable decision. Re-running tonight bumps the
        # evidence on the same row instead of minting a duplicate, and if the
        # admin has already declined it, capture() refuses it outright.
        res = proposals.capture(
            source_agent="quality-triage", kind="quality_check", target=check_name,
            model_id=model_id,
            proposal=(f"Add a new deterministic check `{nc.get('name', 'unnamed')}`: "
                      f"{nc.get('logic', '')}").strip(),
            reason=(obj.get("root_cause") or "").strip() or None,
            expected_outcome=obj.get("expected_outcome"),
            worked_examples=obj.get("worked_examples"),
            payload={"check_name": nc.get("name"), "logic": nc.get("logic"),
                     "rationale": nc.get("rationale"), "fix": obj.get("fix"),
                     "fires_for": check_name, "firing_count": count, "sample": sample})
        triaged.append({"check_name": check_name, "root_cause": obj.get("root_cause"),
                        "proposed_check": nc.get("name"), "proposal": res})
        if nc.get("name") and nc.get("rationale"):
            memory.capture(
                f"quality:{check_name}", f"{nc['name']} — {nc['rationale']}",
                kind="quality_check", origin="quality-triage agent", confidence=0.35,
                testable=True, test_hint=nc.get("logic"))
    return {"triaged": triaged}
