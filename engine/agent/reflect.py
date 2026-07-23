"""Reflection pass (ARCHITECTURE.md Pillar 1): grades matured theses
(status='open', eval_date <= asof) against realized returns, and distills the
outcome into semantic memory so it's injected into future Analyst prompts via
engine/knowledge.py's existing retrieval path — no extra plumbing needed.

Uses TODAY's price against the price recorded in `predictions` at the
thesis's write-time asof, same "grade against today, not exactly eval_date"
simplification engine/ledger.py::evaluate_accuracy already carries.
"""
from __future__ import annotations

from .. import db, memory


def _fetch_due(asof: str) -> list[dict]:
    if not db.have_db():
        return []
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "select id, market_key, asof, claim, direction, eval_date from theses "
            "where status='open' and eval_date <= %s::date", (asof,))
        return [{"id": r[0], "market_key": r[1], "asof": str(r[2]), "claim": r[3],
                "direction": r[4], "eval_date": str(r[5])} for r in cur.fetchall()]


def _price_at_write(market_key: str, write_asof: str) -> float | None:
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select price from predictions where key=%s and asof=%s",
                   (market_key, write_asof))
        row = cur.fetchone()
        return row[0] if row else None


def _mark_graded(thesis_id: int, outcome: str, realized: float, graded_asof: str) -> None:
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "update theses set status='graded', outcome=%s, realized_return=%s, "
            "graded_ts=now() where id=%s", (outcome, realized, thesis_id))
        c.commit()


def reflect(current_prices: dict[str, float], asof: str) -> dict:
    if not db.have_db():
        return {"graded": [], "n": 0, "note": "no database configured"}
    due = _fetch_due(asof)
    graded = []
    for t in due:
        price_then = _price_at_write(t["market_key"], t["asof"])
        price_now = current_prices.get(t["market_key"])
        if not price_then or price_now is None:
            continue  # leave open; try again next run once both prices are available
        realized = price_now / price_then - 1.0
        if t["direction"] == "flat":
            outcome = "correct" if abs(realized) < 0.02 else "incorrect"
        else:
            outcome = "correct" if (realized > 0) == (t["direction"] == "up") else "incorrect"
        _mark_graded(t["id"], outcome, realized, asof)
        claim_txt = (f"Thesis on {t['market_key']} ('{t['claim'][:80]}') predicting "
                    f"{t['direction']} by {t['eval_date']} was {outcome} "
                    f"(realized {realized:+.1%}).")
        memory.capture(f"analyst:{t['market_key']}", claim_txt, kind="thesis_outcome",
                       origin="analyst agent reflection", confidence=0.35, testable=True,
                       test_hint=f"re-check {t['market_key']} vs realized return")
        graded.append({"id": t["id"], "market_key": t["market_key"], "outcome": outcome,
                       "realized_return": round(realized, 4)})
    return {"graded": graded, "n": len(graded)}
