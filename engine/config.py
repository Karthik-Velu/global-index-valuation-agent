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

# --- Model routing (provider-agnostic) ------------------------------------
# model_id = "scheme:model" — scheme in: ollama | openrouter | groq | deepseek |
# zai | anthropic | openai_compat. Cheap/owned tier for frequent agent work,
# frontier reserved for rare high-stakes synthesis. $0 default = local Ollama.
MODEL_CHEAP = os.getenv("MODEL_CHEAP", "ollama:qwen2.5")
MODEL_SMART = os.getenv("MODEL_SMART", "anthropic:claude-opus-4-8")
MODEL_AGENT = os.getenv("MODEL_AGENT", MODEL_CHEAP)

# Provider credentials / endpoints (only the ones you use need to be set).
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
DEEPSEEK_API_KEY = os.getenv("DEEPSEEK_API_KEY", "").strip()
ZAI_API_KEY = os.getenv("ZAI_API_KEY", "").strip()
OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "http://localhost:11434/v1")

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
