"""Auto-tuning: let the market feedback adjust the scoring weights over time.

The opportunity score blends value / momentum / mean-reversion. Each run records
those component scores; once enough runs have a realized forward return, we measure
each component's rank-IC (does a higher component score predict higher returns?) and
shift the opportunity weights toward the components that actually worked — blended
heavily with the priors so it adapts without overfitting to a few data points.

Safe by construction: with too little history it is a no-op and the config defaults
stand. Effective weights live in data/weights.json so a run is fully reproducible.
"""
from __future__ import annotations

import json
import sqlite3

import numpy as np
import pandas as pd

from .config import DATA_DIR, DB_PATH, OPPORTUNITY_WEIGHTS, VALUE_WEIGHTS

WEIGHTS_PATH = DATA_DIR / "weights.json"
MIN_EVALUATIONS = 4   # need at least this many graded runs before tuning kicks in
PRIOR_BLEND = 0.7     # 70% prior, 30% learned — deliberately conservative


def current_value_weights() -> dict:
    return _load().get("value", dict(VALUE_WEIGHTS))


def current_opportunity_weights() -> dict:
    return _load().get("opportunity", dict(OPPORTUNITY_WEIGHTS))


def _load() -> dict:
    if WEIGHTS_PATH.exists():
        try:
            return json.loads(WEIGHTS_PATH.read_text())
        except Exception:
            pass
    return {}


def status() -> dict:
    d = _load()
    return {
        "tuned": bool(d),
        "opportunity_weights": d.get("opportunity", dict(OPPORTUNITY_WEIGHTS)),
        "component_ic": d.get("component_ic"),
        "evaluations_used": d.get("evaluations_used", 0),
    }


def retune() -> dict:
    """Measure each opportunity component's rank-IC vs realized forward returns and
    re-weight. Returns a summary; writes weights.json only when it actually tunes."""
    pairs = _component_return_pairs()
    n_runs = len({p["asof"] for p in pairs})
    if n_runs < MIN_EVALUATIONS or len(pairs) < 20:
        return {"tuned": False, "reason": f"need >= {MIN_EVALUATIONS} graded runs (have {n_runs})"}

    df = pd.DataFrame(pairs)
    components = ["value_score", "growth_score", "momentum_score", "mean_reversion_score"]
    ic = {}
    for c in components:
        if c not in df:
            ic[c] = 0.0
            continue
        sub = df[[c, "fwd_ret"]].dropna()
        ic[c] = _spearman(sub[c].values, sub["fwd_ret"].values) if len(sub) >= 10 else 0.0

    # Map components -> opportunity keys; only positive IC earns extra weight.
    key_map = {"value_score": "value", "growth_score": "growth",
               "momentum_score": "momentum", "mean_reversion_score": "mean_reversion"}
    pos = {key_map[c]: max(ic[c], 0.0) for c in components}
    s = sum(pos.values())
    learned = ({k: v / s for k, v in pos.items()} if s > 0 else dict(OPPORTUNITY_WEIGHTS))

    tuned = {k: round(PRIOR_BLEND * OPPORTUNITY_WEIGHTS[k] + (1 - PRIOR_BLEND) * learned.get(k, 0), 3)
             for k in OPPORTUNITY_WEIGHTS}
    norm = sum(tuned.values()) or 1.0
    tuned = {k: round(v / norm, 3) for k, v in tuned.items()}

    out = {"opportunity": tuned, "value": dict(VALUE_WEIGHTS),
           "component_ic": {k: round(v, 3) for k, v in ic.items()},
           "evaluations_used": n_runs}
    WEIGHTS_PATH.write_text(json.dumps(out, indent=2))
    return {"tuned": True, **out}


def _component_return_pairs() -> list[dict]:
    """Join each past prediction's component scores to its realized forward return,
    measured to the most recent price we have for that market."""
    from . import db
    try:
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute("select key, price from predictions "
                        "where asof=(select max(asof) from predictions)")
            latest = dict(cur.fetchall())
            cur.execute(
                """select asof,key,price,value_score,momentum_score,mean_reversion_score,growth_score
                   from predictions where asof < (select max(asof) from predictions)""")
            rows = cur.fetchall()
    except Exception:
        return []

    pairs = []
    for asof, key, price, vs, ms, mr, gs in rows:
        now = latest.get(key)
        if price and now and price > 0:
            pairs.append({"asof": asof, "key": key, "fwd_ret": now / price - 1.0,
                          "value_score": vs, "momentum_score": ms,
                          "mean_reversion_score": mr, "growth_score": gs})
    return pairs


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3:
        return 0.0
    ra, rb = pd.Series(a).rank().values, pd.Series(b).rank().values
    if ra.std() == 0 or rb.std() == 0:
        return 0.0
    return float(np.corrcoef(ra, rb)[0, 1])
