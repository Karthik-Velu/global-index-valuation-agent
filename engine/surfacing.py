"""Insight surfacing — the "user does no research, insights rise to the top" layer.

Deterministic selection of the handful of things worth attention, generated PER
kind (so every focus lens — Countries, Sectors, Styles… — has content), ordered by
importance and nudged by accumulated user feedback. The LLM only adds language on
top of these already-chosen insights.
"""
from __future__ import annotations

import math

import pandas as pd

from .ledger import feedback_weights

# How many of each insight type to surface per kind.
PER_KIND = {"garp": 2, "value": 2, "growth": 2, "opportunity": 1, "avoid": 1, "expensive": 1}


def build_insights(df: pd.DataFrame) -> list[dict]:
    fb = feedback_weights()
    insights: list[dict] = []

    def push(kind, title, detail, market_key, priority):
        priority += fb.get(market_key, 0.0) * 10
        insights.append({"kind": kind, "title": title, "detail": detail,
                         "market_key": market_key, "priority": round(priority, 1)})

    for grp, g in df.groupby("kind"):
        # GARP sweet spot: cheap AND growing in fundamentals (your #3 + #4 together)
        for _, r in g[g.get("garp", False)].sort_values("opportunity_score", ascending=False) \
                .head(PER_KIND["garp"]).iterrows():
            push("garp", f"{r['name']}: cheap AND growing",
                 f"Value {r['value_score']:.0f} + growth {r['growth_score']:.0f}/100. "
                 f"Earnings growth {_pct(r['earnings_growth'])}, fwd {_pct(r['fwd_growth'])}, "
                 f"at P/E ~{_n(r['pe'])}. The GARP sweet spot.", r["key"], 100 + r["opportunity_score"] / 10)

        # High fundamental growth (not overvalued) — the growth-potential tag
        for _, r in g[(g["high_growth"]) & (~g["overvalued"])] \
                .sort_values("growth_score", ascending=False).head(PER_KIND["growth"]).iterrows():
            push("growth", f"{r['name']}: high growth potential",
                 f"Growth score {r['growth_score']:.0f}/100 (vs {grp.lower()} peers). "
                 f"Revenue {_pct(r['rev_growth'])}, earnings {_pct(r['earnings_growth'])}, "
                 f"forward {_pct(r['fwd_growth'])}. Fundamentals, not price.",
                 r["key"], 88 + r["growth_score"] / 10)

        # Best value buys (cheap, not flagged as traps)
        for _, r in g[(g["value_score"] >= 66) & (~g["value_trap"])] \
                .sort_values("value_score", ascending=False).head(PER_KIND["value"]).iterrows():
            push("value", f"{r['name']} screens cheap",
                 f"P/E ~{_n(r['pe'])}, value score {r['value_score']:.0f}/100 "
                 f"(vs {grp.lower()} peers), growth {_n(r.get('growth_score'))}, 12m {_pct(r['ret_12m'])}.",
                 r["key"], 90 + r["value_score"] / 10)

        # Best opportunity (cheap + improving, not overvalued)
        for _, r in g[~g["overvalued"]].sort_values("opportunity_score", ascending=False) \
                .head(PER_KIND["opportunity"]).iterrows():
            push("opportunity", f"{r['name']}: growth-vs-valuation setup",
                 f"Opportunity {r['opportunity_score']:.0f}/100 "
                 f"(value {r['value_score']:.0f}, momentum {r['momentum_score']:.0f}). "
                 f"Not in the expensive cohort.", r["key"], 85 + r["opportunity_score"] / 10)

        # Value traps to avoid
        for _, r in g[g["value_trap"]].sort_values("value_score", ascending=False) \
                .head(PER_KIND["avoid"]).iterrows():
            push("avoid", f"{r['name']} looks cheap but is falling",
                 f"Value {r['value_score']:.0f} yet 12m {_pct(r['ret_12m'])} and "
                 f"{_pct(r['drawdown_52w'])} off its 52w high — likely value trap.",
                 r["key"], 80)

        # Most overvalued / crowded
        for _, r in g[g["overvalued"]].sort_values("momentum_score", ascending=False) \
                .head(PER_KIND["expensive"]).iterrows():
            push("expensive", f"{r['name']} is richly valued",
                 f"Among the most expensive {grp.lower()} (P/E ~{_n(r['pe'])}); "
                 f"momentum {r['momentum_score']:.0f} is holding it up.", r["key"], 70)

    insights.sort(key=lambda x: x["priority"], reverse=True)
    return insights


def _n(v):
    try:
        v = float(v)
        return "n/a" if math.isnan(v) else f"{v:.1f}"
    except Exception:
        return "n/a"


def _pct(v):
    try:
        v = float(v)
        return "n/a" if math.isnan(v) else f"{v * 100:+.1f}%"
    except Exception:
        return "n/a"
