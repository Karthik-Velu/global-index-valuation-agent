"""Optional LLM layer: research the KPIs that drive sub-sectors with thin coverage
or newly-emerged industries, and propose additions to the catalog. Cheap tier;
no-op without an API key (the deterministic tagging + validation always run).

By the model-routing strategy this runs on the T1 cheap/owned tier (Qwen/GLM/
DeepSeek) once the provider abstraction lands; today it uses engine/llm's cheap model.
"""
from __future__ import annotations

import json

from .. import db, llm


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
        "statement items. Return ONLY a JSON list of "
        '{metric_code (snake_case), label, definition, unit, source_hint}.'
    )
    proposals = []
    for sub in subs:
        try:
            txt = llm._call(llm.MODEL_CHEAP, system, sub, max_tokens=700)
            data = json.loads(txt[txt.find("["): txt.rfind("]") + 1])
            proposals.append({"sub_sector": sub, "proposed": data})
            with db.connect() as c, c.cursor() as cur:
                for d in data:
                    cur.execute(
                        "insert into taxonomy_changes(kind,target,change,reason,auto) "
                        "values('catalog',%s,%s,'LLM sub-sector KPI proposal',true)",
                        (d.get("metric_code", ""), f"propose for {sub}: {d.get('label', '')}"))
                c.commit()
        except Exception as e:
            proposals.append({"sub_sector": sub, "error": str(e)[:140]})
    return {"researched": proposals}
