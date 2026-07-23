"""Orchestration: one cheap, deterministic pass end-to-end.

refresh -> score -> record prediction -> evaluate past calls -> surface insights
-> (cheap LLM tags + one smart brief) -> write the single JSON the dashboard reads.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd

from . import datasource, ledger, llm, metrics, surfacing, tuning
from .config import DASHBOARD_JSON


def _clean(obj):
    """JSON-safe: NaN/inf -> None, numpy types -> python."""
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_clean(v) for v in obj]
    if isinstance(obj, (np.integer,)):
        return int(obj)
    if isinstance(obj, (np.floating, float)):
        return None if (obj is None or np.isnan(obj) or np.isinf(obj)) else float(obj)
    if isinstance(obj, (np.bool_,)):
        return bool(obj)
    if isinstance(obj, pd.Timestamp):
        return obj.isoformat()
    return obj


COLUMNS = [
    "key", "symbol", "name", "country", "region", "development", "kind", "price",
    "pe", "pb", "ps", "pcf", "dividend_yield",
    "earnings_yield", "ret_1m", "ret_3m", "ret_6m", "ret_12m",
    "ma200_ratio", "pct_52w_range", "drawdown_52w",
    "rev_growth", "earnings_growth", "fwd_growth", "growth_cov",
    "value_score", "value_band", "momentum_score", "mean_reversion_score",
    "growth_score", "high_growth", "garp",
    "opportunity_score", "overvalued", "value_trap", "tag",
]


def run(asof: str | None = None, use_cache: bool = True, with_llm: bool = True,
        with_agent: bool = False, with_model_upgrade: bool = False) -> dict:
    asof = asof or date.today().isoformat()
    print(f"== Global Index Valuation Agent — run {asof} ==")

    # 1. Data (cached, free)
    snaps = datasource.refresh(asof=asof, use_cache=use_cache)
    df = datasource.to_frame(snaps)

    # 2. Score (deterministic)
    df = metrics.compute(df)

    # 3. Market-feedback: evaluate older predictions against today's prices
    current_prices = {r["key"]: r["price"] for _, r in df.iterrows() if r.get("price")}
    accuracy_runs = ledger.evaluate_accuracy(current_prices, asof=asof)
    accuracy = ledger.accuracy_summary()
    if accuracy_runs:
        print(f"   evaluated {len(accuracy_runs)} past run(s); "
              f"avg rank-IC {accuracy['avg_rank_ic']}, hit-rate {accuracy['avg_hit_rate']}")

    # 4. Record this run's prediction, then let feedback re-tune the weights
    ledger.record_predictions(df, asof=asof)
    tune = tuning.retune()
    if tune.get("tuned"):
        print(f"   auto-tuned opportunity weights from {tune['evaluations_used']} runs: "
              f"{tune['opportunity']}")

    # 5. Surface insights (deterministic) + cheap LLM tags
    markets = df.to_dict(orient="records")
    tags = llm.cheap_tags(markets) if with_llm else {m["key"]: "" for m in markets}
    df["tag"] = df["key"].map(tags)

    scoreboard = df[[c for c in COLUMNS if c in df.columns]].to_dict(orient="records")
    insights = surfacing.build_insights(df)

    # 5b. Analyst agent (optional, infrequent): investigates the few genuinely
    # ambiguous markets and writes falsifiable theses. Advises only — runs
    # between surfacing and brief generation, never touches the scores above.
    analyst_result = None
    if with_agent and llm.available():
        try:
            from .agent.agent import run as run_analyst
            analyst_result = run_analyst(df, asof, current_prices, max_markets=8)
        except Exception as e:
            analyst_result = {"active": False, "error": str(e)[:160]}

    brief = llm.smart_brief(scoreboard, accuracy) if with_llm else llm._fallback_brief(scoreboard)

    # 5c. Model-Upgrade agent (optional, monthly): advisory chain-health proposals
    # from model_scorecard. The proposal computation itself is deterministic SQL
    # (no LLM needed) — only the optional narrative gloss requires a model, and
    # that degrades gracefully on its own. Never mutates config — proposals only.
    model_upgrade_result = None
    if with_model_upgrade:
        try:
            from .modelupgrade import propose_upgrades
            model_upgrade_result = propose_upgrades()
        except Exception as e:
            model_upgrade_result = {"error": str(e)[:160]}

    payload = {
        "asof": asof,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "universe_size": len(scoreboard),
        "phase": 1,
        "brief": brief,
        "insights": insights,
        "scoreboard": scoreboard,
        "accuracy": accuracy,
        "tuning": tuning.status(),
        "analyst": analyst_result,
        "model_upgrade": model_upgrade_result,
        "kinds": sorted(df["kind"].unique().tolist()),
        "meta": {
            "data_source": "Yahoo Finance ETF holdings (single-methodology proxies)",
            "growth_signal": "fundamental: revenue + earnings growth of top-10 holdings, "
                             "weighted, blended with forward analyst estimates",
            "note": "Scores are cross-sectional within each kind (countries vs countries, etc.).",
        },
    }
    payload = _clean(payload)
    DASHBOARD_JSON.write_text(json.dumps(payload, indent=2))
    print(f"   wrote {DASHBOARD_JSON}  ({len(scoreboard)} markets, {len(insights)} insights)")
    return payload


if __name__ == "__main__":
    run(use_cache=True)
