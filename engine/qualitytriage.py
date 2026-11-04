"""Quality-Triage Agent — LLM layer over engine/quality.py's findings.

Explains root causes for the data-quality checks firing most this run, and
proposes ONE new deterministic check per firing check that would catch the
same class of problem earlier or more precisely. Cheap tier; no-op without an
API key (quality.run()'s deterministic checks already ran regardless).

Runs "on findings" — only when the deterministic quality job actually raised
issues — so it never sits in the hot path of a clean run.

A firing check is a NEED in the register (data_needs id "quality:<check>"); the
check proposed to fix it is the SOLUTION, and the proposal's identity (ADR-044).
Keying on the firing check made one row soak up every night it fired (ids 60, 63
and 67 showed 99, 94 and 87 "evidence"), and declining one fix closed the need.
Only open needs are triaged: an answered one (missing_revenue is queued for build)
is not re-litigated, and the need's constraints and the fixes already declined are
in the prompt, so a withdrawn idea (#63 for stale_filings) is not offered again.
"""
from __future__ import annotations

import json

from . import canonical, db, llm, memory, proposals
from .sources import registry


def _needs_for(checks: list[str]) -> dict[str, dict]:
    """{check: its need row}, adding an open need for a check seen for the first time."""
    for chk in checks:
        registry.add_need({"id": f"quality:{chk}", "kind": "quality",
                           "market_scope": "data quality", "public_only": True,
                           "description": f"{chk} findings from engine/quality.py"})
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id, status, description, status_note from data_needs "
                    "where id = any(%s)", ([f"quality:{x}" for x in checks],))
        return {r[0].split(":", 1)[1]: {"status": r[1], "description": r[2], "note": r[3]}
                for r in cur.fetchall()}


def triage_issues(report: dict, max_checks: int = 4) -> dict:
    if not llm.LLM_ENABLED:
        return {"skipped": "no API key — deterministic quality.run() checks still ran"}

    by_check = report.get("by_check", {})
    needs = _needs_for(list(by_check))
    ranked = sorted(by_check.items(), key=lambda kv: kv[1], reverse=True)
    top = [kv for kv in ranked if needs.get(kv[0], {}).get("status") == "open"][:max_checks]
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
        'know", '
        '"worked_examples": [2-3 of {"situation","today","after"} using REAL '
        "identifiers from the sample — never invent numbers you were not given]}.\n"
        # root_cause and expected_outcome are the basis for the owner's decision
        # (directive 2026-08-02) — a check that fires 1,000× a day is a very
        # different proposition from one that fires twice, and they can only weigh
        # that if you say so up front.
        "The owner decides from root_cause and expected_outcome. Be concrete about "
        "firing volume and whether it blocks anything. Respect the need's constraints, "
        "and never propose any of declined_solutions again, under any name."
    )
    triaged = []
    for check_name, count in top:
        sample = [i for i in all_issues if i.get("check_name") == check_name][:5]
        need, need_id = needs[check_name], f"quality:{check_name}"
        declined = [k.split(":", 1)[1] for k in
                    proposals.decided_keys("quality_check", need_id=need_id)]
        user = json.dumps({"check_name": check_name, "count": count, "sample": sample,
                           "need": need["description"], "constraints": need["note"],
                           "declined_solutions": declined}, default=str)
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
        if not nc.get("name"):
            triaged.append({"check_name": check_name, "skipped": "model named no check"})
            continue
        # ...and this is the reviewable decision, keyed on the PROPOSED check. The
        # same fix raised again merges into its row; raised for a second firing
        # check it gains a second signal; declined (under any spelling), capture()
        # refuses it outright, and the need stays open for a different fix.
        res = proposals.capture(
            source_agent="quality-triage", kind="quality_check",
            target=canonical.check_name(nc["name"]), model_id=model_id,
            proposal=(f"Add a new deterministic check `{nc['name']}`: "
                      f"{nc.get('logic', '')}").strip(),
            reason=(obj.get("root_cause") or "").strip() or None,
            expected_outcome=obj.get("expected_outcome"),
            worked_examples=obj.get("worked_examples"),
            payload={"check_name": nc.get("name"), "logic": nc.get("logic"),
                     "rationale": nc.get("rationale"), "fix": obj.get("fix"),
                     "fires_for": check_name, "firing_count": count, "sample": sample},
            need_id=need_id, signal=f"check:{check_name}")
        triaged.append({"check_name": check_name, "root_cause": obj.get("root_cause"),
                        "proposed_check": nc.get("name"), "proposal": res})
        if nc.get("name") and nc.get("rationale"):
            memory.capture(
                f"quality:{check_name}", f"{nc['name']} — {nc['rationale']}",
                kind="quality_check", origin="quality-triage agent", confidence=0.35,
                testable=True, test_hint=nc.get("logic"))
    return {"triaged": triaged}
