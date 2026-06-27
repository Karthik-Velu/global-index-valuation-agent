"""Feedback loops — now on Postgres (Tier A), the single source of truth.

  1. Market feedback: predictions + realized-return grading (rank-IC, hit-rate).
  2. User feedback: pin/dismiss/rate, fed back into surfacing.
"""
from __future__ import annotations

import json
from datetime import date

import numpy as np
import pandas as pd

from . import db


def _f(v):
    try:
        v = float(v)
        return None if np.isnan(v) else v
    except Exception:
        return None


# --- prediction ledger -----------------------------------------------------

def record_predictions(df: pd.DataFrame, asof: str | None = None) -> int:
    asof = asof or date.today().isoformat()
    rows = [(asof, r["key"], r["symbol"], _f(r.get("price")), _f(r.get("value_score")),
             _f(r.get("opportunity_score")), _f(r.get("momentum_score")),
             _f(r.get("mean_reversion_score")), _f(r.get("growth_score")),
             bool(r.get("overvalued")), bool(r.get("value_trap")))
            for _, r in df.iterrows()]
    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """insert into predictions
               (asof,key,symbol,price,value_score,opportunity_score,momentum_score,
                mean_reversion_score,growth_score,overvalued,value_trap)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict (asof,key) do update set price=excluded.price,
                 value_score=excluded.value_score, opportunity_score=excluded.opportunity_score,
                 momentum_score=excluded.momentum_score, mean_reversion_score=excluded.mean_reversion_score,
                 growth_score=excluded.growth_score, overvalued=excluded.overvalued,
                 value_trap=excluded.value_trap""", rows)
        conn.commit()
    return len(rows)


# --- market feedback: did past calls work? ---------------------------------

def evaluate_accuracy(current_prices: dict[str, float], asof: str | None = None,
                      min_horizon_days: int = 25) -> list[dict]:
    asof = asof or date.today().isoformat()
    today = pd.Timestamp(asof)
    results: list[dict] = []
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select distinct asof from predictions where asof < %s::date order by asof", (asof,))
        past_dates = [r[0] for r in cur.fetchall()]
        for pd_date in past_dates:
            horizon = (today - pd.Timestamp(pd_date)).days
            if horizon < min_horizon_days:
                continue
            cur.execute("select key,symbol,price,opportunity_score from predictions where asof=%s",
                        (pd_date,))
            recs = []
            for key, sym, price, opp in cur.fetchall():
                now = current_prices.get(key)
                if price and now and opp is not None:
                    recs.append((opp, now / price - 1.0))
            if len(recs) < 5:
                continue
            opp_arr = np.array([x[0] for x in recs])
            fwd = np.array([x[1] for x in recs])
            ic = _spearman(opp_arr, fwd)
            order = np.argsort(opp_arr)
            q = max(1, len(recs) // 4)
            bottom, top = fwd[order[:q]].mean(), fwd[order[-q:]].mean()
            rec = {"asof": str(pd_date), "horizon_days": int(horizon),
                   "rank_ic": round(float(ic), 3), "hit_rate": float(top > bottom), "n": len(recs),
                   "top_q_ret": round(float(top), 4), "bottom_q_ret": round(float(bottom), 4)}
            cur.execute(
                """insert into accuracy(asof,horizon_days,rank_ic,hit_rate,n,detail)
                   values (%s,%s,%s,%s,%s,%s)
                   on conflict (asof) do update set horizon_days=excluded.horizon_days,
                     rank_ic=excluded.rank_ic, hit_rate=excluded.hit_rate, n=excluded.n,
                     detail=excluded.detail""",
                (pd_date, int(horizon), rec["rank_ic"], rec["hit_rate"], len(recs), json.dumps(rec)))
            results.append(rec)
        conn.commit()
    return results


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3:
        return 0.0
    ra, rb = pd.Series(a).rank().values, pd.Series(b).rank().values
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def accuracy_summary() -> dict:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select asof,horizon_days,rank_ic,hit_rate,n from accuracy order by asof")
        rows = cur.fetchall()
    if not rows:
        return {"evaluations": 0, "avg_rank_ic": None, "avg_hit_rate": None, "history": []}
    hist = [{"asof": str(r[0]), "horizon_days": r[1], "rank_ic": r[2], "hit_rate": r[3], "n": r[4]}
            for r in rows]
    return {"evaluations": len(rows),
            "avg_rank_ic": round(float(np.mean([r[2] for r in rows])), 3),
            "avg_hit_rate": round(float(np.mean([r[3] for r in rows])), 3), "history": hist}


# --- user feedback ---------------------------------------------------------

def add_feedback(kind: str, target: str, signal: str, note: str = "", ts: str | None = None):
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("insert into feedback(ts,kind,target,signal,note) values (now(),%s,%s,%s,%s)",
                    (kind, target, signal, note))
        conn.commit()


def feedback_weights() -> dict[str, float]:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select target,signal from feedback where kind='market'")
        rows = cur.fetchall()
    score: dict[str, float] = {}
    for target, signal in rows:
        delta = {"pin": 1.0, "up": 0.5, "down": -0.5, "dismiss": -1.0}.get(signal, 0.0)
        score[target] = max(-1.0, min(1.0, score.get(target, 0.0) + delta))
    return score
