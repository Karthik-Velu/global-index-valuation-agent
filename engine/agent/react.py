"""The bounded ReAct loop (ARCHITECTURE.md Pillar 1): MAX_STEPS=4, one
llm.call() per step. There is no function-calling/tool-use parameter anywhere
in engine/llm.py's provider path (confirmed: `_call`'s OpenAI-compat branch
sends only model/max_tokens/messages/optional response_format) — so tool
selection is a manual JSON-action loop: the system prompt describes the tool
menu, the model replies with one JSON object {"thought","tool","args"} each
step, and the executed tool's result is appended to the scratchpad for the
next step.

TOKEN_BUDGET is a cap on REQUESTED max_tokens summed across steps, not true
usage accounting — llm.py's call() doesn't surface actual consumption today,
so this is a caller-side discipline, stated explicitly rather than implied.
"""
from __future__ import annotations

import json

from .. import config, llm
from . import tools

MAX_STEPS = 4
TOKEN_BUDGET = 2200

_TOOL_MENU = """Available tools (call exactly one per step):
- query_ledger: {} -> past predictions + prior theses for this market.
- get_market_detail: {} -> the full current scoreboard row for this market.
- fill_growth_gap: {} -> re-fetch missing fundamental growth for this market's holdings.
- fetch_news: {"query": str, "max_results": int (optional, default 5)} -> recent headlines.
- write_thesis: {"claim": str, "direction": "up"|"down"|"flat", "eval_date": "YYYY-MM-DD",
  "confidence": float 0-1, "evidence": {...summary of what you found...}} -> commits your
  thesis. This is the ONLY way to conclude with a finding.
- finish: {} -> stop without writing a thesis (use when the evidence doesn't support a
  confident, falsifiable claim within your step budget — no thesis beats a bad one).

Reply with ONLY one JSON object: {"thought": "<=40 words", "tool": "<name>", "args": {...}}."""


def _system_prompt(market: dict, scratchpad: list[dict]) -> str:
    parts = [
        "You are the Analyst agent for a global equity-index research tool. You "
        "investigate ONE ambiguous market per invocation using tools, then either "
        "write a falsifiable thesis or finish without one. A thesis must be "
        "concrete enough to grade later against realized price movement. Cite "
        "only evidence your tools actually returned — never invent a headline, "
        "ledger entry, or growth number.",
        _TOOL_MENU,
        f"Market under investigation: {market.get('key')} ({market.get('name', '')}).",
    ]
    if scratchpad:
        parts.append("Scratchpad so far:\n" + json.dumps(scratchpad, default=str))
    return "\n\n".join(parts)


def _user_prompt(market: dict) -> str:
    slim = {k: v for k, v in market.items()
           if k in ("key", "name", "value_score", "growth_score", "opportunity_score",
                    "value_trap", "garp", "growth_cov", "overvalued", "pe")}
    return json.dumps(slim, default=str)


def _safe_call(fn, kwargs: dict):
    """kwargs is a pre-merged dict (protected context keys already win over
    anything the model's `args` might have collided with) so a single **kwargs
    unpack can never raise a duplicate-keyword TypeError before we can catch it."""
    try:
        return fn(**kwargs)
    except Exception as e:
        return {"error": str(e)[:200]}


def investigate_market(market: dict, df_by_key: dict, asof: str,
                       max_steps: int = MAX_STEPS, token_budget: int = TOKEN_BUDGET) -> dict:
    scratchpad: list[dict] = []
    tokens_used = 0
    for step in range(1, max_steps + 1):
        remaining = token_budget - tokens_used
        if remaining <= 150:
            break
        step_tokens = min(700, remaining)
        try:
            raw = llm.call("analyst", _system_prompt(market, scratchpad), _user_prompt(market),
                           max_tokens=step_tokens, json_mode=True)
        except Exception as e:
            return {"market_key": market["key"], "outcome": "error", "steps": scratchpad,
                   "error": str(e)[:160]}
        tokens_used += step_tokens
        try:
            action = json.loads(raw)
        except Exception:
            scratchpad.append({"step": step, "error": "unparseable action", "raw": (raw or "")[:200]})
            continue

        tool = action.get("tool")
        args = action.get("args") or {}

        if not isinstance(args, dict):
            args = {}

        if tool == "write_thesis":
            merged = {**args, "market_key": market["key"], "asof": asof,
                     "model_id": config.MODEL_AGENT}
            result = _safe_call(tools.write_thesis, merged)
            scratchpad.append({"step": step, "tool": tool, "args": args, "result": result})
            if isinstance(result, dict) and result.get("id"):
                return {"market_key": market["key"], "outcome": "thesis_written",
                       "thesis_id": result["id"], "steps": scratchpad}
            continue  # invalid write_thesis args -> the error becomes evidence, try again

        if tool in (None, "finish"):
            return {"market_key": market["key"], "outcome": "no_thesis", "steps": scratchpad}

        fn = tools.TOOLS.get(tool)
        if fn is None:
            result = {"error": f"unknown tool {tool!r}"}
        else:
            merged = {**args, "market_key": market["key"], "df_by_key": df_by_key, "asof": asof}
            result = _safe_call(fn, merged)
        scratchpad.append({"step": step, "tool": tool, "args": args, "result": result})

    return {"market_key": market["key"], "outcome": "no_thesis_max_steps", "steps": scratchpad}
