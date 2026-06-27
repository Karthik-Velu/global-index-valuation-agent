"""Autonomous source discovery (optional, cheap-model).

Asks the cheap LLM tier to propose candidate data sources for needs that lack a
license-clean source, and records them as `lead`s in the catalog for a human (or a
later coding pass) to turn into adapters. Degrades to a no-op with no API key — the
deterministic probing/scoring is the part that must always run.

NOTE: by the model-routing strategy this should run on the T1 cheap/owned tier
(self-hosted Qwen / GLM-Flash / DeepSeek). Until the provider abstraction (arch
Pillar 5) lands it uses the existing cheap model in engine/llm.py.
"""
from __future__ import annotations

import json

from .. import llm
from ..sources import registry


def discover_for_needs(needs: list[dict], max_needs: int = 3) -> list[dict]:
    if not llm.LLM_ENABLED:
        return [{"skipped": "no API key — discovery is the only LLM step; probing still ran"}]

    out = []
    for need in needs[:max_needs]:
        system = (
            "You suggest FREE or cheap, license-clean data sources for a fintech "
            'ingestion pipeline. Return ONLY a JSON object: {"sources": [ <=5 of '
            '{"id","name","provider","kinds","coverage","access_method",'
            '"endpoint","auth","free_tier","license","update_freq","sample_hint","confidence"} ]}. '
            "kinds from price/index_valuation/fundamentals/news/fx/macro/corp_actions/filings. "
            "license from public_domain/redistribution_ok/personal_only/prohibited/unknown. "
            "Prefer sources usable by a PUBLIC product. Do not invent endpoints you are unsure of."
        )
        user = json.dumps({"need": need["id"], "kind": need["kind"],
                           "market_scope": need["market_scope"], "must_be_public": bool(need["public_only"])})
        try:
            txt = llm._call(llm.MODEL_AGENT, system, user, max_tokens=900, json_mode=True)
            obj = json.loads(txt)
            data = obj.get("sources", obj if isinstance(obj, list) else [])
        except Exception as e:
            out.append({"need": need["id"], "error": str(e)[:160]})
            continue
        for s in data:
            s.setdefault("status", "lead")
            s["has_adapter"] = False
            s["verified_live"] = False
            if s.get("id"):
                registry.upsert_source(s)
                out.append({"need": need["id"], "lead": s["id"], "license": s.get("license")})
    return out
