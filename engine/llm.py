"""Differential model router.

The ONLY place the LLM is used. It never sees raw stock data — only the already
aggregated, ranked scoreboard (≤ ~50 rows). Two tiers:

  * cheap_tag()  -> Haiku. High volume, low stakes: a 6-word tag per market.
  * smart_brief() -> Opus. One call per run: the top-level "what matters now".

If no ANTHROPIC_API_KEY is set, both return deterministic fallbacks so the whole
product still works for free.
"""
from __future__ import annotations

import json

from .config import ANTHROPIC_API_KEY, LLM_ENABLED, MODEL_CHEAP, MODEL_SMART

_client = None


def _get_client():
    global _client
    if _client is None:
        from anthropic import Anthropic

        _client = Anthropic(api_key=ANTHROPIC_API_KEY)
    return _client


def _call(model: str, system: str, user: str, max_tokens: int = 400) -> str:
    msg = _get_client().messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


def cheap_tags(markets: list[dict]) -> dict[str, str]:
    """One short, plain-English tag per market. Batched into a single cheap call."""
    if not LLM_ENABLED or not markets:
        return {m["key"]: _fallback_tag(m) for m in markets}
    compact = [
        {
            "key": m["key"], "name": m["name"], "pe": m.get("pe"),
            "value_score": m.get("value_score"), "growth_score": m.get("growth_score"),
            "fwd_growth": m.get("fwd_growth"), "earnings_growth": m.get("earnings_growth"),
            "opp": m.get("opportunity_score"), "trap": m.get("value_trap"),
            "high_growth": m.get("high_growth"), "garp": m.get("garp"),
            "overvalued": m.get("overvalued"),
        }
        for m in markets
    ]
    system = (
        "You label equity-index markets for a dashboard. 'Growth' means FUNDAMENTAL "
        "revenue/earnings growth, not price momentum. For each market return a <=7-word, "
        "punchy plain-English tag describing its setup (e.g. 'Cheap and growing fast', "
        "'Pricey but high growth', 'Deep value, no growth', 'Cheap, possible trap'). "
        "Return ONLY a JSON object mapping key->tag."
    )
    try:
        out = _call(MODEL_CHEAP, system, json.dumps(compact), max_tokens=900)
        data = json.loads(out[out.find("{"): out.rfind("}") + 1])
        return {m["key"]: data.get(m["key"], _fallback_tag(m)) for m in markets}
    except Exception:
        return {m["key"]: _fallback_tag(m) for m in markets}


def _countries(scoreboard: list[dict]) -> list[dict]:
    c = [m for m in scoreboard if m.get("kind") == "Country"]
    return c or scoreboard


def _val(m: dict, k: str):
    """NaN/None-safe numeric accessor (raw scoreboard may carry numpy NaN)."""
    v = m.get(k)
    try:
        v = float(v)
        return v if v == v else None  # NaN -> None
    except (TypeError, ValueError):
        return None


def _growthpct(m: dict) -> str:
    for k in ("fwd_growth", "earnings_growth", "rev_growth"):
        if _val(m, k) is not None:
            return _pct(m.get(k))
    return "n/a"


def smart_brief(scoreboard: list[dict], accuracy: dict) -> str:
    """One high-value synthesis for the top of the dashboard (country-level read)."""
    if not LLM_ENABLED:
        return _fallback_brief(scoreboard)
    scoreboard = _countries(scoreboard)
    has = lambda k: [m for m in scoreboard if _val(m, k) is not None]
    top_val = sorted(has("value_score"), key=lambda m: _val(m, "value_score"), reverse=True)[:6]
    top_growth = sorted(has("growth_score"), key=lambda m: _val(m, "growth_score"), reverse=True)[:6]
    garp = sorted([m for m in scoreboard if m.get("garp")],
                  key=lambda m: _val(m, "opportunity_score") or 0, reverse=True)[:6]
    traps = [m for m in scoreboard if m.get("value_trap")][:5]
    payload = {
        "cheapest_value": [_slim(m) for m in top_val],
        "highest_fundamental_growth": [_slim(m) for m in top_growth],
        "cheap_and_growing_garp": [_slim(m) for m in garp],
        "value_traps": [_slim(m) for m in traps],
        "model_track_record": accuracy,
    }
    system = (
        "You are a buy-side strategist writing the 1-paragraph headline read for a "
        "global equity-index dashboard. 'Growth' = FUNDAMENTAL revenue/earnings growth, "
        "NOT price momentum. Be specific and decisive: name the 2-3 best value buys, the "
        "2-3 highest fundamental-growth markets, and the best 'cheap AND growing' (GARP) "
        "ideas; flag value traps. <=130 words, no preamble, no bullet lists."
    )
    try:
        return _call(MODEL_SMART, system, json.dumps(payload), max_tokens=350)
    except Exception:
        return _fallback_brief(scoreboard)


# --- deterministic fallbacks (free, always available) ----------------------

def _slim(m: dict) -> dict:
    return {k: m.get(k) for k in ("name", "pe", "value_score", "growth_score",
                                  "earnings_growth", "fwd_growth", "opportunity_score")}


def _fallback_tag(m: dict) -> str:
    if m.get("garp"):
        return "Cheap and growing — GARP sweet spot"
    if m.get("value_trap"):
        return "Cheap but falling — possible value trap"
    vs = m.get("value_score") or 0
    if m.get("high_growth"):
        return "High fundamental growth" + (", fairly priced" if vs >= 50 else ", but pricey")
    if m.get("overvalued"):
        return "Expensive; little margin of safety"
    if vs >= 66:
        return "Cheap, but low growth"
    return "Mid-pack on value and growth"


def _fallback_brief(scoreboard: list[dict]) -> str:
    scoreboard = _countries(scoreboard)
    has = lambda k: [m for m in scoreboard if _val(m, k) is not None]
    val = sorted(has("value_score"), key=lambda m: _val(m, "value_score"), reverse=True)[:3]
    grw = sorted(has("growth_score"), key=lambda m: _val(m, "growth_score"), reverse=True)[:3]
    garp = sorted([m for m in scoreboard if m.get("garp")],
                  key=lambda m: _val(m, "opportunity_score") or 0, reverse=True)[:3]
    v = ", ".join(f"{m['name']} (P/E {m.get('pe')})" for m in val)
    g = ", ".join(f"{m['name']} ({_growthpct(m)} growth)" for m in grw)
    gp = ", ".join(m["name"] for m in garp) or "none screen cheap + high-growth right now"
    return (
        f"Cheapest value: {v}. Highest fundamental growth: {g}. "
        f"Cheap AND growing (GARP): {gp}. "
        "Scores are within-peer-group; cross-check value-trap flags before acting. "
        "(LLM narrative disabled — set ANTHROPIC_API_KEY for a strategist read.)"
    )


def _pct(v):
    try:
        v = float(v)
        return "n/a" if v != v else f"{v * 100:+.0f}%"
    except Exception:
        return "n/a"
