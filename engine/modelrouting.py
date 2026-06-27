"""Model-SPECIFIC learning: adaptive waterfall ordering + prompt packaging.

Two things are learned per-model here (kept distinct from the model-agnostic
knowledge in engine/context/*.md):

  1. Reliability  — which model is actually fast + reliable for a given role,
     from outcome metrics (model_invocations -> model_scorecard view).
  2. Packaging    — per-family quirks (JSON-mode support; whether a hard
     "JSON only" nudge is needed), in model_profiles.

Everything is best-effort: with no DATABASE_URL the recorder is a no-op and
profile()/order_by_learning() fall back to heuristics, so the LLM path still works.
"""
from __future__ import annotations

from . import db

# Families we recognise from a model id, most-specific first.
_FAMILIES = ("claude", "gpt-oss", "deepseek", "qwen", "llama", "glm",
             "mixtral", "mistral", "gemma", "phi", "gemini")


def _family(model_id: str) -> str:
    m = (model_id or "").lower()
    for fam in _FAMILIES:
        if fam in m:
            return fam
    return m.split(":", 1)[0] or "unknown"  # fall back to the provider scheme


def record(role: str, model_id: str, ok: bool, *, error_kind: str | None = None,
           latency_ms: int | None = None, attempt: int = 1,
           json_requested: bool = False, json_ok: bool | None = None) -> None:
    """Log one LLM attempt. Silent no-op without a DB."""
    if not db.have_db():
        return
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "insert into model_invocations"
                "(role,model_id,ok,error_kind,latency_ms,attempt,json_requested,json_ok) "
                "values (%s,%s,%s,%s,%s,%s,%s,%s)",
                (role, model_id, ok, error_kind, latency_ms, attempt, json_requested, json_ok))
            c.commit()
    except Exception:
        pass


def scorecard(role: str | None = None) -> list[dict]:
    if not db.have_db():
        return []
    try:
        from psycopg.rows import dict_row
        with db.connect() as c, c.cursor(row_factory=dict_row) as cur:
            if role:
                cur.execute("select * from model_scorecard where role=%s order by n desc", (role,))
            else:
                cur.execute("select * from model_scorecard order by role, n desc")
            return cur.fetchall()
    except Exception:
        return []


def reliability(role: str) -> dict[str, float]:
    """model_id -> learned reliability in [0,1] (only models with enough evidence)."""
    out: dict[str, float] = {}
    for r in scorecard(role):
        if (r.get("n") or 0) < 3:  # too little evidence -> stay neutral
            continue
        succ = float(r.get("success_rate") or 0)
        jr = r.get("json_rate")
        jr = float(jr) if jr is not None else succ
        out[r["model_id"]] = round(0.6 * succ + 0.4 * jr, 3)
    return out


def order_by_learning(role: str, candidates: list[str]) -> list[str]:
    """Reorder available candidates by learned reliability (desc), stably.

    Models with no evidence keep a neutral 0.5 so they aren't punished for being new.
    Off by default (config.ADAPTIVE_ROUTING) — the static chain order is authoritative.
    """
    rel = reliability(role)
    if not rel:
        return candidates
    return sorted(candidates, key=lambda m: -rel.get(m, 0.5))


def profile(model_id: str) -> dict:
    """Per-family prompt-packaging profile (heuristic default, DB override)."""
    fam = _family(model_id)
    default = {
        "family": fam,
        "supports_json_mode": fam != "claude",  # Anthropic path ignores response_format
        "force_json_suffix": fam in ("llama", "qwen", "gemma", "phi"),
    }
    if not db.have_db():
        return default
    try:
        from psycopg.rows import dict_row
        with db.connect() as c, c.cursor(row_factory=dict_row) as cur:
            cur.execute("select * from model_profiles where family=%s", (fam,))
            row = cur.fetchone()
            return {**default, **row} if row else default
    except Exception:
        return default


if __name__ == "__main__":  # quick inspection: python -m engine.modelrouting
    rows = scorecard()
    if not rows:
        print("no model_invocations yet (or no DB).")
    for r in rows:
        print(f"{r['role']:<16} {r['model_id']:<40} n={r['n']:<4} "
              f"ok={r['success_rate']} json={r['json_rate']} p50={r['p50_latency_ms']}ms "
              f"429s={r['rate_limit_hits']}")
