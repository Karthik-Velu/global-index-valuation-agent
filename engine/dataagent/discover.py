"""Autonomous source discovery (optional, cheap-model).

Asks the cheap LLM tier to propose candidate data sources for OPEN source needs in
the needs register (data_needs), and raises each as a proposal for the owner to
decide. Degrades to a no-op with no API key — the deterministic probing/scoring is
the part that must always run.

What it trusts changed after the 31 Oct 2026 queue review (ADR-044):
  * the prompt carries the need's description and the providers already known,
    verified and declined, so the model no longer proposes blind (it offered price
    feeds for index_valuation because it never saw "P/E, P/B, yield");
  * the licence gate uses the registry's licence for the provider
    (registry.verified_license), never the model's claim: every new spelling of a
    provider claimed redistribution_ok and passed;
  * a suggestion is a proposal keyed on provider + need, and is NOT upserted into
    data_sources. Upserting every invented id as a lead is how 214 of 216 rows came
    to have no adapter, and how an invented 'finnhub' rewrote the verified row.

NOTE: by the model-routing strategy this should run on the T1 cheap/owned tier
(self-hosted Qwen / GLM-Flash / DeepSeek). Until the provider abstraction (arch
Pillar 5) lands it uses the existing cheap model in engine/llm.py.
"""
from __future__ import annotations

import json

from .. import canonical, llm, memory, proposals
from ..sources import registry
from ..sources.base import DataKind

SOURCE_KINDS = {k.value for k in DataKind}
# Licences we never build for: we only redistribute public-domain / redistribution-OK
# data (CLAUDE.md). Judged on the registry's record, not the model's word.
BLOCKED_LICENSES = {"personal_only", "prohibited"}


def _context(known: list[dict], declined: list[str], need_id: str) -> str:
    """The registry and the owner's past decisions, in a line each, for the prompt."""
    on_record = sorted({f"{canonical.provider(s.get('provider') or s['id'])} "
                        f"({s.get('license') or 'unknown'})" for s in known})
    verified = sorted({canonical.provider(s.get("provider") or s["id"]) for s in known
                       if s.get("has_adapter") or s.get("verified_live")})
    here = sorted({k.split(":", 1)[1].rsplit("@", 1)[0] for k in declined
                   if k.endswith(f"@{need_id}")})
    return (f"Already catalogued (provider and the licence on record): {', '.join(on_record) or 'none'}. "
            f"Verified, with a working adapter: {', '.join(verified) or 'none'}. "
            f"The owner DECLINED these for this need; never suggest them again: "
            f"{', '.join(here) or 'none'}.")


def discover_for_needs(needs: list[dict], max_needs: int = 3) -> list[dict]:
    if not llm.LLM_ENABLED:
        return [{"skipped": "no API key — discovery is the only LLM step; probing still ran"}]
    # Agents propose against open needs only. An answered, parked or met need is
    # not re-litigated every week, and a KPI or quality need is not a source need.
    open_needs = [n for n in needs if n.get("kind") in SOURCE_KINDS
                  and (n.get("status") or "open") == "open"]
    if not open_needs:
        return [{"skipped": "no open source need in the register"}]

    known = registry.list_sources()
    declined = proposals.decided_keys("source_adapter")
    out = []
    for need in open_needs[:max_needs]:
        system = (
            "You suggest FREE or cheap, licence-clean data sources for ONE need of a "
            "fintech ingestion pipeline. Read the need's description and suggest only "
            "sources that supply exactly that (a price feed does not answer a "
            'valuation need). Return ONLY a JSON object: {"sources": [ <=5 of '
            '{"name","provider","kinds","coverage","access_method",'
            '"endpoint","auth","free_tier","license","update_freq","sample_hint","confidence"} ]}. '
            "provider is the organisation's real name, spelled once (for example "
            "'Federal Reserve Bank of St. Louis'), never a product id. "
            "kinds from price/index_valuation/fundamentals/news/fx/macro/corp_actions/filings. "
            "license from public_domain/redistribution_ok/personal_only/prohibited/unknown; "
            "it is a claim only, the pipeline uses the licence it has on record. "
            "Prefer sources usable by a PUBLIC product. Do not invent endpoints you are unsure of. "
            + _context(known, declined, need["id"]) + " "
            'If nothing new genuinely fits, return {"sources": []}. '
            "Each source is reviewed by a non-engineer product owner who approves or "
            "rejects building an adapter for it, so also give, per source: "
            '"reason" (WHY: what we cannot cover today without it), "expected_outcome" '
            "(what measurably improves and how we would know), and "
            '"worked_examples" ([2-3 of {"situation","today","after"}]).'
        )
        user = json.dumps({"need": need["id"], "kind": need["kind"],
                           "description": need.get("description"),
                           "market_scope": need.get("market_scope"),
                           "must_be_public": bool(need.get("public_only"))})
        try:
            txt, model_id = llm.call_with_model("source_discovery", system, user,
                                                max_tokens=2000, json_mode=True)
            obj = json.loads(txt)
            data = obj.get("sources", obj if isinstance(obj, list) else [])
        except Exception as e:
            out.append({"need": need["id"], "error": str(e)[:160]})
            continue
        for s in data:
            if not isinstance(s, dict):
                continue
            prov = canonical.provider(s.get("provider") or s.get("id"))
            if prov == "unknown":
                continue
            lic = registry.verified_license(prov, need["kind"], known) or "unknown"
            row = {"need": need["id"], "provider": prov, "license": lic,
                   "license_claimed": s.get("license")}
            if lic in BLOCKED_LICENSES:
                out.append({**row, "action": "blocked_license"})
                continue
            licence = (f"Licence on record: {lic}." if lic != "unknown" else
                       "Licence: not on record, so unverified (the model claimed "
                       f"{s.get('license') or 'nothing'}); confirm it before building.")
            res = proposals.capture(
                source_agent="source-discovery", kind="source_adapter", target=prov,
                model_id=model_id,
                proposal=(f"Build an ingestion adapter for {s.get('name') or prov} "
                          f"({s.get('provider') or prov}) to cover {need['kind']} for "
                          f"{need.get('market_scope')}. {licence}").strip(),
                reason=s.get("reason"), expected_outcome=s.get("expected_outcome"),
                worked_examples=s.get("worked_examples"),
                payload={"source": {**s, "license": lic, "license_claimed": s.get("license"),
                                    "license_verified": lic != "unknown"},
                         "need": {k: need.get(k) for k in
                                  ("id", "kind", "description", "market_scope", "public_only")}},
                need_id=need["id"], signal=f"need:{need['id']}")
            out.append({**row, "action": res.get("action"), "id": res.get("id")})
            memory.capture(
                f"source:{prov}",
                f"{s.get('name') or prov} — candidate {need['kind']} source "
                f"(licence on record: {lic}, access: {s.get('access_method', '?')}).",
                kind="source_status", origin="source-discovery agent", confidence=0.30,
                testable=True, test_hint=s.get("endpoint"))
    return out
