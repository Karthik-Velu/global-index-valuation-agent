"""Central configuration: paths, model routing, and scoring weights.

Everything tunable lives here so the "intelligent" behaviour (model choice) and
the "non-intelligent" behaviour (scoring math) are both transparent and cheap to
adjust. The market-feedback loop can rewrite SCORE_WEIGHTS over time.
"""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # dotenv is optional
    pass

# --- Paths -----------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "agent.db"
# Single JSON contract the dashboard reads. Engine writes, frontend consumes.
DASHBOARD_JSON = DATA_DIR / "dashboard_data.json"

# --- Model routing (provider-agnostic, WATERFALL) -------------------------
# model_id = "scheme:model" — scheme in: ollama | openrouter | groq | deepseek |
# zai/glm | anthropic. Each ROLE has an ordered CHAIN of models: tier 1 is tried
# first, and on rate-limit / auth / server error the router falls through to the
# next tier (engine/llm.py). Models without a key/endpoint are skipped silently, so
# the chain "just works" with whatever you've configured — down to $0 local Ollama.
#
# Reorder or swap tiers by setting MODEL_<ROLE>_CHAIN in .env to a comma-separated
# list, e.g.  MODEL_AGENT_CHAIN="groq:llama-3.3-70b-versatile, ollama:qwen2.5"
# A single MODEL_<ROLE> (back-compat) is honored as tier 1 if set.
_cheap_env = os.getenv("MODEL_CHEAP")
_smart_env = os.getenv("MODEL_SMART")
_agent_env = os.getenv("MODEL_AGENT")
MODEL_CHEAP = _cheap_env or "ollama:qwen2.5"
MODEL_SMART = _smart_env or "anthropic:claude-opus-4-8"
MODEL_AGENT = _agent_env or MODEL_CHEAP

# Default waterfalls (best/most-capable first). Unavailable tiers are skipped.
# `ollamacloud:` = Ollama Cloud hosted (needs OLLAMA_API_KEY); `ollama:` = local daemon.
_AGENT_FALLBACKS = [
    "ollamacloud:gpt-oss:120b",                       # Ollama Cloud — big, reliable JSON
    "ollamacloud:deepseek-v3.2",                      # cloud alt
    "groq:llama-3.3-70b-versatile",                   # Groq free tier — fast 70B
    "openrouter:deepseek/deepseek-chat-v3-0324:free", # OpenRouter free
    "ollama:qwen2.5",                                 # local, offline, $0
]
_CHEAP_FALLBACKS = [
    "ollamacloud:gpt-oss:20b",                        # Ollama Cloud — light/fast
    "groq:llama-3.3-70b-versatile",
    "openrouter:meta-llama/llama-3.3-70b-instruct:free",
    "ollama:qwen2.5",
]
_SMART_FALLBACKS = [
    "anthropic:claude-opus-4-8",                      # frontier for the rare weekly synthesis
    "ollamacloud:gpt-oss:120b",
    "ollamacloud:deepseek-v3.2",
    "groq:llama-3.3-70b-versatile",
]


def _dedupe(seq):
    seen, out = set(), []
    for x in seq:
        x = (x or "").strip()
        if x and x not in seen:
            seen.add(x)
            out.append(x)
    return out


def _chain(env_name, default):
    raw = os.getenv(env_name, "").strip()
    if raw:
        return _dedupe(raw.split(","))
    return _dedupe(default)


MODEL_AGENT_CHAIN = _chain("MODEL_AGENT_CHAIN", ([_agent_env] if _agent_env else []) + _AGENT_FALLBACKS)
MODEL_CHEAP_CHAIN = _chain("MODEL_CHEAP_CHAIN", ([_cheap_env] if _cheap_env else []) + _CHEAP_FALLBACKS)
MODEL_SMART_CHAIN = _chain("MODEL_SMART_CHAIN", ([_smart_env] if _smart_env else []) + _SMART_FALLBACKS)

# Let the learned scorecard reorder a role's chain by reliability. Off by default
# so your explicit tier order stays authoritative; flip on once metrics accumulate.
ADAPTIVE_ROUTING = os.getenv("ADAPTIVE_ROUTING", "false").lower() in ("1", "true", "yes", "on")

# Embedding model for semantic memory retrieval (engine/memory.py). Free + local by
# default; dim must match migration 0008 (nomic-embed-text = 768). No model -> memory
# retrieval degrades to lexical + scope/recency (still works).
MODEL_EMBED = os.getenv("MODEL_EMBED", "ollama:nomic-embed-text")
EMBED_DIM = int(os.getenv("EMBED_DIM", "768"))

# Semantic-memory lifecycle thresholds (engine/memory.py).
MEM_ACTIVATE_EVIDENCE = int(os.getenv("MEM_ACTIVATE_EVIDENCE", "2"))   # candidate->active
MEM_ACTIVATE_CONF = float(os.getenv("MEM_ACTIVATE_CONF", "0.60"))
MEM_PROMOTE_CONF = float(os.getenv("MEM_PROMOTE_CONF", "0.85"))        # active->promote (curate to .md)
MEM_RETIRE_CONF = float(os.getenv("MEM_RETIRE_CONF", "0.20"))          # below this -> retired
MEM_DECAY_HALFLIFE_DAYS = float(os.getenv("MEM_DECAY_HALFLIFE_DAYS", "180"))  # confidence decay

# Provider credentials / endpoints (only the ones you use need to be set).
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
ZAI_API_KEY = os.getenv("ZAI_API_KEY", "").strip()
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")
OLLAMA_API_KEY = os.getenv("OLLAMA_API_KEY", "").strip()  # set for Ollama Cloud (remote endpoint)

# --- Scoring weights -------------------------------------------------------
# Value (cheapness) is a blend of yield-style metrics. Higher yield = cheaper.
# Weights are normalised internally, so relative magnitude is what matters.
VALUE_WEIGHTS = {
    "earnings_yield": 0.40,  # E/P  — primary cheapness signal
    "book_yield": 0.20,      # B/P
    "sales_yield": 0.15,     # S/P
    "cashflow_yield": 0.10,  # CF/P
    "dividend_yield": 0.15,  # cash returned to holders
}

# Opportunity (true GARP): cheap AND growing in fundamentals, not overheated.
# `growth` is real revenue/earnings growth of the index's top holdings (+ forward
# analyst estimates), NOT price momentum. Momentum is demoted to confirmation only.
OPPORTUNITY_WEIGHTS = {
    "value": 0.40,         # being cheap (#3)
    "growth": 0.40,        # fundamental revenue/earnings growth (#4)
    "momentum": 0.12,      # price already turning up = mild confirmation
    "mean_reversion": 0.08,  # depressed vs its own range = room to recover
}

# --- Fundamental growth (top-holdings sampled) ---
GROWTH_TOP_N = 10           # holdings sampled per index proxy
GROWTH_WINSOR = (-0.50, 1.50)  # clip per-stock growth to [-50%, +150%] before weighting
GROWTH_FWD_WEIGHT = 0.5     # weight on forward (analyst) vs trailing realized growth
HIGH_GROWTH_QUANTILE = 0.75  # top 25% by growth (within kind) -> "high growth" tag
FETCH_FORWARD_GROWTH = True  # also pull analyst +1y estimates (slower; best-effort)

# Markets in the richest valuation quantile are gated out of "opportunity"
# (we want growth that is NOT, or less, overvalued — your requirement #4).
OVERVALUED_QUANTILE = 0.80  # top 20% by richness flagged "overvalued"

# A cheap market that is also deeply down + still falling is a likely value trap.
VALUE_TRAP_MOM_12M = -0.15   # 12m total return below -15%
VALUE_TRAP_DRAWDOWN = -0.20  # >20% below its 52w high

# How many headline insights to surface at the very top of the dashboard.
TOP_INSIGHTS = 6
