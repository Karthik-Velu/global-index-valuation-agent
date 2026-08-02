"""Optional LLM layer: research the KPIs that drive sub-sectors with thin coverage
or newly-emerged industries, and propose additions to the catalog. Cheap tier;
no-op without an API key (the deterministic tagging + validation always run).

By the model-routing strategy this runs on the T1 cheap/owned tier (Qwen/GLM/
DeepSeek) once the provider abstraction lands; today it uses engine/llm's cheap model.
"""
from __future__ import annotations

import json

from .. import db, llm, memory, proposals


def research_thin_subsectors(max_subsectors: int = 4) -> dict:
    if not llm.LLM_ENABLED:
        return {"skipped": "no API key — deterministic tagging + validation still ran"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute("select distinct sub_sector from security_tags "
                    "where sub_sector is not null and sub_sector <> '' limit %s", (max_subsectors,))
        subs = [r[0] for r in cur.fetchall()]

    system = (
        "You are an equity analyst. For the given equity sub-sector, list up to 5 of the "
        "MOST important KPIs that drive its growth/quality and are NOT generic income-"
        "statement items. Each one will be read by a non-engineer product owner who "
        "approves or rejects adding it to the metric catalog, so justify it in plain "
        "English.\n"
        'Return ONLY a JSON object: {"metrics": [ up to 5 of {"metric_code": snake_case, '
        '"label", "definition", "unit", "source_hint", "xbrl_tags": [exact US-GAAP/IFRS '
        "tag names ONLY if you are certain, else omit], "
        '"reason": "WHY this is being proposed — what we cannot currently see without '
        'it, and what decision goes wrong today as a result. Never restate the '
        'definition here.", '
        '"expected_outcome": "what measurably improves and how we would know", '
        '"how_used": "HOW IT WILL BE USED going forward, concretely — which score or '
        "view consumes it once collected (valuation scoring, growth scoring, the stock "
        "breakdown, reference only), and which companies it is collected for. If "
        "nothing consumes it yet and it would only be collected, say exactly that.\", "
        '"worked_examples": [2-3 of {"situation","today","after"} naming real companies '
        "in this sub-sector] } ]}.\n"
        # The owner reads these four fields and nothing else before approving, so a
        # non-answer in any of them is what makes a decision blind (directive
        # 2026-08-02). Named explicitly because the pre-existing legacy proposals
        # failed exactly here: reason was the literal string "LLM sub-sector KPI
        # proposal", which says nothing at all.
        "reason, expected_outcome and how_used are what the owner reads before "
        "approving. Vague or self-referential answers there make the proposal "
        "un-decidable — be concrete or say plainly that you are unsure."
    )
    researched = []
    for sub in subs:
        try:
            txt, model_id = llm.call_with_model("sector_research", system, sub,
                                                max_tokens=2000, json_mode=True)
            obj = json.loads(txt)
            data = obj.get("metrics", obj if isinstance(obj, list) else [])
            researched.append({"sub_sector": sub, "proposed": data})
            with db.connect() as c, c.cursor() as cur:
                for d in data:
                    cur.execute(
                        "insert into taxonomy_changes(kind,target,change,reason,auto) "
                        "values('catalog_proposal',%s,%s,'LLM sub-sector KPI proposal',true)",
                        (d.get("metric_code", ""), f"propose for {sub}: {d.get('label', '')}"))
                c.commit()
            # The reviewable decision. Keyed on metric_code alone, so the same KPI
            # arriving from three different sub-sectors — and again tomorrow night —
            # is ONE decision with rising evidence, not 15 rows (which is exactly
            # what capex_intensity did before this existed).
            for d in data:
                if not d.get("metric_code"):
                    continue
                proposals.capture(
                    source_agent="sector-research", kind="catalog_kpi",
                    target=d["metric_code"], model_id=model_id,
                    proposal=(f"Add `{d['metric_code']}` ({d.get('label', '')}) to the metric "
                              f"catalog: {d.get('definition', '')}").strip(),
                    reason=d.get("reason"), expected_outcome=d.get("expected_outcome"),
                    how_used=d.get("how_used"), worked_examples=d.get("worked_examples"),
                    payload={"label": d.get("label"), "definition": d.get("definition"),
                             "unit": d.get("unit"), "applies_to": sub,
                             "xbrl_tags": d.get("xbrl_tags") or [],
                             "source_hint": d.get("source_hint"),
                             "proposed_for_sub_sector": sub})
            # Feed semantic memory: each proposed KPI becomes a candidate lesson.
            for d in data:
                if d.get("metric_code") and d.get("label"):
                    memory.capture(
                        f"sector_research:{sub}",
                        f"{d['label']} ({d['metric_code']}) — {d.get('definition', '')}".strip(),
                        kind="kpi", origin="sector-research agent", confidence=0.40,
                        test_hint=d.get("source_hint"))
        except Exception as e:
            researched.append({"sub_sector": sub, "error": str(e)[:140]})
    return {"researched": researched}
