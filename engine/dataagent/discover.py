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

from .. import llm, memory, proposals
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
            "Prefer sources usable by a PUBLIC product. Do not invent endpoints you are unsure of. "
            "Each source is reviewed by a non-engineer product owner who approves or "
            "rejects building an adapter for it, so also give, per source: "
            '"reason" (what we cannot cover today without it), "expected_outcome" '
            "(what measurably improves and how we would know), and "
            '"worked_examples" ([2-3 of {"situation","today","after"}]).'
        )
        user = json.dumps({"need": need["id"], "kind": need["kind"],
                           "market_scope": need["market_scope"], "must_be_public": bool(need["public_only"])})
        try:
            txt, model_id = llm.call_with_model("source_discovery", system, user,
                                                max_tokens=2000, json_mode=True)
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
                # A lead in the registry is inert — nothing ever turns it into an
                # adapter. Raising it as a proposal is what gives it a decision and,
                # once approved, a Builder to actually write the adapter.
                # License-blocked sources are recorded but never proposed: we only
                # redistribute public-domain / redistribution-OK data (CLAUDE.md).
                if s.get("license") not in {"personal_only", "prohibited"}:
                    proposals.capture(
                        source_agent="source-discovery", kind="source_adapter",
                        target=s["id"], model_id=model_id,
                        proposal=(f"Build an ingestion adapter for {s.get('name', s['id'])} "
                                  f"({s.get('provider', '?')}) to cover {need['kind']} for "
                                  f"{need['market_scope']}.").strip(),
                        reason=s.get("reason"), expected_outcome=s.get("expected_outcome"),
                        worked_examples=s.get("worked_examples"),
                        payload={"source": s, "need": need})
                memory.capture(
                    f"source:{s['id']}",
                    f"{s.get('name', s['id'])} — candidate {need['kind']} source "
                    f"(license: {s.get('license', 'unknown')}, access: {s.get('access_method', '?')}).",
                    kind="source_status", origin="source-discovery agent", confidence=0.30,
                    testable=True, test_hint=s.get("endpoint"))
    return out
