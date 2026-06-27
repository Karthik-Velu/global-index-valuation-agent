"""Provider-agnostic WATERFALL model router.

The ONLY place an LLM is used. Each ROLE (cheap / smart / agent / source_discovery /
sector_research / …) has an ordered chain of `scheme:model` candidates. `call()`:

  1. injects the shared, model-agnostic knowledge playbook (engine/knowledge.py),
  2. applies per-family prompt packaging (engine/modelrouting.py),
  3. tries tier 1; on rate-limit / auth / server / timeout it classifies the error,
     puts that model on a short cooldown, and falls through to the next tier,
  4. logs every attempt so the scorecard can learn which model to trust.

Models with no key / unreachable endpoint are skipped. If every tier is unavailable,
callers fall back to free deterministic text — the whole product still runs for $0.
"""
from __future__ import annotations

import json
import time

from . import config, knowledge, modelrouting
from .config import MODEL_AGENT, MODEL_CHEAP, MODEL_SMART  # noqa: F401 (back-compat exports)

_anthropic = None
_AVAIL: dict[str, tuple[bool, float]] = {}   # model_id -> (ok, monotonic_expiry)
_COOLDOWN: dict[str, float] = {}             # model_id -> monotonic_until
_COOLDOWN_SECS = {"rate_limit": 90, "auth": 3600, "server": 20, "timeout": 20, "other": 10}


def _parse(model_id: str) -> tuple[str, str]:
    scheme, _, model = (model_id or "").partition(":")
    return scheme, (model or scheme)


def _conf(scheme: str) -> tuple[str | None, str]:
    """(base_url, api_key) for OpenAI-compatible providers; ('anthropic', key) for Anthropic."""
    return {
        "anthropic": ("anthropic", config.ANTHROPIC_API_KEY),
        "ollama": (config.OLLAMA_BASE_URL, config.OLLAMA_API_KEY or "ollama"),
        "ollamacloud": ("https://ollama.com/v1", config.OLLAMA_API_KEY),  # hosted; keeps local ollama: separate

        "openrouter": ("https://openrouter.ai/api/v1", config.OPENROUTER_API_KEY),
        "groq": ("https://api.groq.com/openai/v1", config.GROQ_API_KEY),
        "deepseek": ("https://api.deepseek.com/v1", config.DEEPSEEK_API_KEY),
        "zai": ("https://api.z.ai/api/paas/v4", config.ZAI_API_KEY),
        "glm": ("https://api.z.ai/api/paas/v4", config.ZAI_API_KEY),
    }.get(scheme, (None, ""))


def _check_available(model_id: str) -> bool:
    scheme, _ = _parse(model_id)
    base, key = _conf(scheme)
    if scheme == "anthropic":
        return bool(key)
    if scheme == "ollama":
        # Remote (Ollama Cloud) endpoint: auth by key. Local daemon: ping it.
        if config.OLLAMA_API_KEY and "localhost" not in (base or "") and "127.0.0.1" not in (base or ""):
            return True
        try:
            import requests
            requests.get((base or "").replace("/v1", "") + "/api/tags", timeout=1.5)
            return True
        except Exception:
            return False
    return bool(key)


def available(model_id: str | None = None) -> bool:
    """Is this model usable right now? Cached 60s so we don't re-ping every call."""
    model_id = model_id or config.MODEL_CHEAP_CHAIN[0]
    hit = _AVAIL.get(model_id)
    if hit and hit[1] > time.monotonic():
        return hit[0]
    ok = _check_available(model_id)
    _AVAIL[model_id] = (ok, time.monotonic() + 60)
    return ok


def _cooling(model_id: str) -> bool:
    return _COOLDOWN.get(model_id, 0.0) > time.monotonic()


def _cooldown(model_id: str, kind: str) -> None:
    _COOLDOWN[model_id] = time.monotonic() + _COOLDOWN_SECS.get(kind, 10)


def _classify(exc: Exception) -> str:
    """Map any provider exception to: rate_limit | auth | server | timeout | other."""
    name = type(exc).__name__.lower()
    status = getattr(exc, "status_code", None) or getattr(getattr(exc, "response", None), "status_code", None)
    if status == 429 or "ratelimit" in name:
        return "rate_limit"
    if status in (401, 403) or "authentication" in name or "permission" in name:
        return "auth"
    if (isinstance(status, int) and 500 <= status < 600) or "internalserver" in name:
        return "server"
    if "timeout" in name or "connection" in name or "apiconnection" in name:
        return "timeout"
    return "other"


def _anthropic_client():
    global _anthropic
    if _anthropic is None:
        from anthropic import Anthropic
        _anthropic = Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _anthropic


def _call(model_id: str, system: str, user: str, max_tokens: int = 400,
          json_mode: bool = False) -> str:
    """Single-model primitive — raises on failure (the chain handles fallback)."""
    scheme, model = _parse(model_id)
    base, key = _conf(scheme)
    if scheme == "anthropic":
        msg = _anthropic_client().messages.create(
            model=model, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": user}])
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()
    # OpenAI-compatible (Ollama / Ollama Cloud / OpenRouter / Groq / DeepSeek / GLM)
    from openai import OpenAI
    client = OpenAI(base_url=base, api_key=key or "x")
    kwargs = {"model": model, "max_tokens": max_tokens,
              "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
    if json_mode:
        kwargs["response_format"] = {"type": "json_object"}
    try:
        resp = client.chat.completions.create(**kwargs)
    except Exception:
        if "response_format" in kwargs:  # provider may not support it — retry once plainly
            kwargs.pop("response_format", None)
            resp = client.chat.completions.create(**kwargs)
        else:
            raise
    return (resp.choices[0].message.content or "").strip()


def _json_parses(text: str) -> bool:
    """Is there a parseable JSON object in the text (strict, then tolerant slice)?"""
    for candidate in (text, text[text.find("{"): text.rfind("}") + 1] if "{" in text else ""):
        try:
            json.loads(candidate)
            return True
        except Exception:
            continue
    return False


def chain_for(role: str) -> list[str]:
    if role == "cheap":
        return config.MODEL_CHEAP_CHAIN
    if role == "smart":
        return config.MODEL_SMART_CHAIN
    return config.MODEL_AGENT_CHAIN  # agent + any specialised agent role


def call(role: str, system: str, user: str, max_tokens: int = 400,
         json_mode: bool = False) -> str:
    """Waterfall LLM call for a role. Raises RuntimeError if every tier is exhausted."""
    # The shared playbook + the most relevant learned lessons for THIS task (the user
    # message is the retrieval query) are injected into the system prompt.
    sys_shared = knowledge.system_prompt(role, system, query=user)
    candidates = [m for m in chain_for(role) if available(m) and not _cooling(m)]
    if config.ADAPTIVE_ROUTING:
        candidates = modelrouting.order_by_learning(role, candidates)
    last_err: Exception | None = None
    for i, model_id in enumerate(candidates, 1):
        prof = modelrouting.profile(model_id)
        sysm = sys_shared
        if json_mode and prof.get("force_json_suffix"):
            sysm += "\n\nReturn ONLY one valid JSON object — no other text."
        use_json = json_mode and prof.get("supports_json_mode", True)
        t0 = time.monotonic()
        try:
            out = _call(model_id, sysm, user, max_tokens=max_tokens, json_mode=use_json)
            if not (out or "").strip():
                # e.g. a reasoning model whose token budget was consumed before any
                # visible content — treat as a tier failure and fall through.
                raise RuntimeError("empty completion (token budget may be too small)")
            modelrouting.record(role, model_id, True, attempt=i, json_requested=json_mode,
                                json_ok=(_json_parses(out) if json_mode else None),
                                latency_ms=int((time.monotonic() - t0) * 1000))
            return out
        except Exception as e:  # noqa: BLE001 — classify + fall through to next tier
            kind = _classify(e)
            _cooldown(model_id, kind)
            modelrouting.record(role, model_id, False, error_kind=kind, attempt=i,
                                json_requested=json_mode,
                                latency_ms=int((time.monotonic() - t0) * 1000))
            last_err = e
    raise RuntimeError(f"all model tiers exhausted for role={role!r}: {last_err}")


def embed(texts: list[str]) -> list[list[float]] | None:
    """Embed texts with config.MODEL_EMBED (OpenAI-compatible). None if unavailable.

    Used by engine/memory.py for semantic retrieval; callers must handle None and
    fall back to lexical/scope retrieval, so embeddings stay strictly optional.
    """
    if not texts:
        return []
    model_id = config.MODEL_EMBED
    scheme, model = _parse(model_id)
    if scheme == "anthropic" or not available(model_id):
        return None  # Anthropic has no embeddings endpoint; or model unreachable
    base, key = _conf(scheme)
    try:
        from openai import OpenAI
        client = OpenAI(base_url=base, api_key=key or "x")
        resp = client.embeddings.create(model=model, input=texts)
        return [d.embedding for d in resp.data]
    except Exception:
        return None


def any_available() -> bool:
    seen: set[str] = set()
    for ch in (config.MODEL_CHEAP_CHAIN, config.MODEL_SMART_CHAIN, config.MODEL_AGENT_CHAIN):
        for m in ch:
            if m in seen:
                continue
            seen.add(m)
            if available(m):
                return True
    return False


# Any model configured anywhere in the chains? (agents/narration check this.)
LLM_ENABLED = any_available()


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
        "You label equity-index markets for a dashboard. For each market return a "
        "<=7-word, punchy plain-English tag describing its setup (e.g. 'Cheap and "
        "growing fast', 'Pricey but high growth', 'Deep value, no growth', 'Cheap, "
        "possible trap'). Return ONLY a JSON object mapping key->tag."
    )
    try:
        out = call("cheap", system, json.dumps(compact), max_tokens=900, json_mode=True)
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
        "global equity-index dashboard. Be specific and decisive: name the 2-3 best "
        "value buys, the 2-3 highest fundamental-growth markets, and the best 'cheap "
        "AND growing' (GARP) ideas; flag value traps. <=130 words, no preamble, no "
        "bullet lists."
    )
    try:
        return call("smart", system, json.dumps(payload), max_tokens=350)
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
        "(LLM narrative disabled — configure a model chain for a strategist read.)"
    )


def _pct(v):
    try:
        v = float(v)
        return "n/a" if v != v else f"{v * 100:+.0f}%"
    except Exception:
        return "n/a"
