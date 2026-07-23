"""Model-Upgrade Agent (v1, deliberately scoped down) — reads model_scorecard
(already populated by every engine/llm.py::call(), migration 0006) and proposes
ADVISORY chain changes. This is NOT the full ARCHITECTURE.md Pillar 5 vision:
no models.yaml registry, no provider abstraction beyond what llm.py/
modelrouting.py already have, no golden-eval gate. Those are a new subsystem;
building them is out of scope for "the agent that's supposed to exist" — see
docs/DECISIONS.md for the ADR recording this as a deliberate v1 scope-down.

Never auto-mutates config.py or env — proposals only, a human hand-edits
MODEL_<ROLE>_CHAIN. Monthly cadence (see engine/pipeline.py / refresh.yml).
"""
from __future__ import annotations

import json

from . import config, db, llm, memory, modelrouting

MIN_N = 20                    # attempts before a model's stats are trusted
LOW_SUCCESS = 0.70             # below this success_rate -> flag for demotion
HIGH_RATE_LIMIT_FRAC = 0.15    # rate_limit_hits / n above this -> flag
HIGH_SUCCESS = 0.95            # promotion candidate threshold


def _chain_for_role(role: str) -> list[str]:
    return {"cheap": config.MODEL_CHEAP_CHAIN, "smart": config.MODEL_SMART_CHAIN
           }.get(role, config.MODEL_AGENT_CHAIN)


def compute_proposals() -> list[dict]:
    """Pure SQL/threshold analysis over model_scorecard — no LLM, always runs."""
    proposals = []
    for r in modelrouting.scorecard():
        n = r.get("n") or 0
        if n < MIN_N:
            continue
        chain = _chain_for_role(r["role"])
        in_chain = r["model_id"] in chain
        success = float(r.get("success_rate") or 0)
        rl_frac = (r.get("rate_limit_hits") or 0) / n
        stats = {"n": n, "success_rate": r.get("success_rate"),
                 "rate_limit_hits": r.get("rate_limit_hits"), "p50_latency_ms": r.get("p50_latency_ms")}
        if in_chain and (success < LOW_SUCCESS or rl_frac > HIGH_RATE_LIMIT_FRAC):
            proposals.append({
                "kind": "demote", "role": r["role"], "model_id": r["model_id"], "stats": stats,
                "suggestion": f"{r['model_id']} in role={r['role']} has success_rate={success} "
                             f"over n={n} (rate-limit hit rate {rl_frac:.0%}) — consider demoting "
                             f"or dropping it from MODEL_{r['role'].upper()}_CHAIN"})
        elif not in_chain and success >= HIGH_SUCCESS:
            proposals.append({
                "kind": "promote", "role": r["role"], "model_id": r["model_id"], "stats": stats,
                "suggestion": f"{r['model_id']} shows success_rate={success} over n={n} for "
                             f"role={r['role']} but is not in the configured chain — consider adding it"})
    return proposals


def propose_upgrades(narrate: bool = True) -> dict:
    proposals = compute_proposals()
    if not proposals:
        return {"proposals": [], "note": "no model in any chain has enough evidence to flag"}
    for p in proposals:
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "insert into taxonomy_changes(kind,target,change,reason,auto) "
                "values('model_routing',%s,%s,%s,false)",
                (p["role"], p["suggestion"], json.dumps(p["stats"])))
            c.commit()
        memory.capture(f"model_routing:{p['role']}", p["suggestion"], kind="model_perf",
                       origin="model-upgrade agent", confidence=0.35, testable=True,
                       test_hint=f"re-check model_scorecard for role={p['role']}")
    narrative = None
    if narrate and llm.LLM_ENABLED:
        system = (
            "Summarize these model-routing proposals for a human maintainer in <=100 "
            "words. Be concrete: name models and roles, state the stat that triggered "
            "each. This is ADVISORY ONLY — say so; nothing auto-applies."
        )
        try:
            narrative = llm.call("cheap", system, json.dumps(proposals, default=str), max_tokens=300)
        except Exception:
            narrative = None
    return {"proposals": proposals, "narrative": narrative}
