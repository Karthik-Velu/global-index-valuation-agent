"""Analyst agent orchestrator (ARCHITECTURE.md Pillar 1) — the entrypoint
engine/pipeline.py calls. Grades matured theses first (so lessons from past
calls are available before new investigations start), then investigates the
few genuinely ambiguous markets this run flags.
"""
from __future__ import annotations

from .. import config, llm
from . import react, reflect, select


def run(df, asof: str, current_prices: dict, max_markets: int = 8) -> dict:
    if not llm.available():
        return {"active": False, "note": "no model configured"}

    refl = reflect.reflect(current_prices, asof)

    df_by_key = {k: {**v, "key": k} for k, v in df.set_index("key").to_dict(orient="index").items()}
    candidates = select.pick_ambiguous_markets(df, asof, limit=max_markets)
    investigations = [react.investigate_market(m, df_by_key, asof) for m in candidates]

    return {"active": True, "model": config.MODEL_AGENT, "reflected": refl,
           "n_candidates": len(candidates), "investigations": investigations}
