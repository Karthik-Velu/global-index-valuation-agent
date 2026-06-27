"""Feedback loops — what makes this an agent, not a report.

Two loops:
  1. Market feedback: every run records a prediction (value/opportunity score +
     the proxy price). Later runs measure realized forward return per market and
     score how well the rankings predicted performance (rank correlation +
     hit-rate of the top vs bottom quartile). This accuracy can drive weight
     tuning over time.
  2. User feedback: pin / dismiss / rate insights and markets. Stored and fed
     back so the surfacing logic learns what this user cares about.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date

import numpy as np
import pandas as pd

from .config import DB_PATH


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS predictions (
            asof TEXT, key TEXT, symbol TEXT,
            price REAL, value_score REAL, opportunity_score REAL,
            momentum_score REAL, mean_reversion_score REAL,
            overvalued INTEGER, value_trap INTEGER,
            PRIMARY KEY (asof, key)
        );
        CREATE TABLE IF NOT EXISTS feedback (
            ts TEXT, kind TEXT, target TEXT, signal TEXT, note TEXT
        );
        CREATE TABLE IF NOT EXISTS accuracy (
            asof TEXT PRIMARY KEY, horizon_days INTEGER,
            rank_ic REAL, hit_rate REAL, n INTEGER, detail TEXT
        );
        """
    )
    # Migrate older DBs that predate the component-score columns.
    cols = {r[1] for r in c.execute("PRAGMA table_info(predictions)").fetchall()}
    for col in ("momentum_score", "mean_reversion_score", "growth_score"):
        if col not in cols:
            c.execute(f"ALTER TABLE predictions ADD COLUMN {col} REAL")
    return c


# --- prediction ledger -----------------------------------------------------

def record_predictions(df: pd.DataFrame, asof: str | None = None) -> int:
    asof = asof or date.today().isoformat()
    c = _conn()
    with c:
        for _, r in df.iterrows():
            c.execute(
                """INSERT OR REPLACE INTO predictions
                   (asof,key,symbol,price,value_score,opportunity_score,
                    momentum_score,mean_reversion_score,growth_score,overvalued,value_trap)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    asof, r["key"], r["symbol"],
                    _f(r.get("price")), _f(r.get("value_score")),
                    _f(r.get("opportunity_score")),
                    _f(r.get("momentum_score")), _f(r.get("mean_reversion_score")),
                    _f(r.get("growth_score")),
                    int(bool(r.get("overvalued"))), int(bool(r.get("value_trap"))),
                ),
            )
    c.close()
    return len(df)


def _f(v):
    try:
        v = float(v)
        return None if np.isnan(v) else v
    except Exception:
        return None


# --- market feedback: did past calls work? ---------------------------------

def evaluate_accuracy(current_prices: dict[str, float], asof: str | None = None,
                      min_horizon_days: int = 25) -> list[dict]:
    """For each past run older than `min_horizon_days`, measure how well the
    opportunity ranking predicted the realized forward return to today.

    Returns one accuracy record per evaluated past run.
    """
    asof = asof or date.today().isoformat()
    today = pd.Timestamp(asof)
    c = _conn()
    past_dates = [r[0] for r in c.execute(
        "SELECT DISTINCT asof FROM predictions WHERE asof < ? ORDER BY asof", (asof,)
    ).fetchall()]

    results: list[dict] = []
    for pd_date in past_dates:
        horizon = (today - pd.Timestamp(pd_date)).days
        if horizon < min_horizon_days:
            continue
        rows = c.execute(
            "SELECT key,symbol,price,opportunity_score FROM predictions WHERE asof=?",
            (pd_date,),
        ).fetchall()
        recs = []
        for key, sym, price, opp in rows:
            now = current_prices.get(key)
            if price and now and opp is not None:
                recs.append((opp, now / price - 1.0))
        if len(recs) < 5:
            continue
        opp_arr = np.array([x[0] for x in recs])
        fwd = np.array([x[1] for x in recs])
        # Spearman rank IC between predicted opportunity and realized return.
        ic = _spearman(opp_arr, fwd)
        # Hit rate: did the top quartile beat the bottom quartile?
        order = np.argsort(opp_arr)
        q = max(1, len(recs) // 4)
        bottom = fwd[order[:q]].mean()
        top = fwd[order[-q:]].mean()
        hit = float(top > bottom)
        rec = {
            "asof": pd_date, "horizon_days": int(horizon),
            "rank_ic": round(float(ic), 3), "hit_rate": hit, "n": len(recs),
            "top_q_ret": round(float(top), 4), "bottom_q_ret": round(float(bottom), 4),
        }
        with c:
            c.execute(
                """INSERT OR REPLACE INTO accuracy
                   (asof,horizon_days,rank_ic,hit_rate,n,detail) VALUES (?,?,?,?,?,?)""",
                (pd_date, int(horizon), rec["rank_ic"], hit, len(recs), json.dumps(rec)),
            )
        results.append(rec)
    c.close()
    return results


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3:
        return 0.0
    ra = pd.Series(a).rank().values
    rb = pd.Series(b).rank().values
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])


def accuracy_summary() -> dict:
    c = _conn()
    rows = c.execute(
        "SELECT asof,horizon_days,rank_ic,hit_rate,n FROM accuracy ORDER BY asof"
    ).fetchall()
    c.close()
    if not rows:
        return {"evaluations": 0, "avg_rank_ic": None, "avg_hit_rate": None, "history": []}
    hist = [
        {"asof": r[0], "horizon_days": r[1], "rank_ic": r[2], "hit_rate": r[3], "n": r[4]}
        for r in rows
    ]
    return {
        "evaluations": len(rows),
        "avg_rank_ic": round(float(np.mean([r[2] for r in rows])), 3),
        "avg_hit_rate": round(float(np.mean([r[3] for r in rows])), 3),
        "history": hist,
    }


# --- user feedback ---------------------------------------------------------

def add_feedback(kind: str, target: str, signal: str, note: str = "", ts: str | None = None):
    """kind: 'insight'|'market'  signal: 'pin'|'dismiss'|'up'|'down'."""
    ts = ts or date.today().isoformat()
    c = _conn()
    with c:
        c.execute(
            "INSERT INTO feedback(ts,kind,target,signal,note) VALUES (?,?,?,?,?)",
            (ts, kind, target, signal, note),
        )
    c.close()


def feedback_weights() -> dict[str, float]:
    """Aggregate user feedback into a per-market surfacing nudge in [-1, 1]."""
    c = _conn()
    rows = c.execute("SELECT target,signal FROM feedback WHERE kind='market'").fetchall()
    c.close()
    score: dict[str, float] = {}
    for target, signal in rows:
        delta = {"pin": 1.0, "up": 0.5, "down": -0.5, "dismiss": -1.0}.get(signal, 0.0)
        score[target] = max(-1.0, min(1.0, score.get(target, 0.0) + delta))
    return score
