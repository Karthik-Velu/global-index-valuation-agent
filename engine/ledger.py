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


# --- index-level scoreboard, persisted with history ------------------------

# A ratio that moves more than this between consecutive snapshots is almost
# certainly a data problem, not a market move: index P/E is a slow aggregate and
# these are weekly-to-daily snapshots. Not a hard error — a flag for a human.
_DRIFT_FACTOR = 1.5


def record_index_metrics(df: pd.DataFrame, asof: str | None = None,
                         source: str = "pipeline") -> dict:
    """Persist the index-level scoreboard to Postgres, keyed (index_key, asof).

    Until 2026-08 the scoreboard lived ONLY in dashboard/dashboard_data.json:
    one file, rewritten each refresh, no history and no second copy. That made a
    whole class of question unanswerable — "was this P/E the same yesterday?",
    "does the published number match what the engine computed?" — and it showed:
    an external source put COWZ at 11.9x against our 15.9x and there was nothing
    to reconcile against. `index_metrics` has been in the schema since
    0001_core.sql and nothing ever wrote to it.

    Also refreshes `indices`, which the FK points at and which had gone stale —
    93 rows against a universe of 133, so a straight insert would have failed
    the foreign key for every index added since it was last seeded.

    Returns row counts plus any drift flagged against the previous snapshot.
    """
    from . import universe

    asof = asof or date.today().isoformat()
    ix_rows = [(ix.key, ix.name, ix.proxy, ix.country, ix.region, ix.kind)
               for ix in universe.UNIVERSE]
    rows = [(r["key"], asof, _f(r.get("pe")), _f(r.get("pb")), _f(r.get("ps")),
             _f(r.get("dividend_yield")), _f(r.get("value_score")),
             _f(r.get("growth_score")), _f(r.get("momentum_score")),
             _f(r.get("opportunity_score")), bool(r.get("overvalued")),
             bool(r.get("value_trap")), bool(r.get("garp")), source)
            for _, r in df.iterrows()]

    with db.connect() as conn, conn.cursor() as cur:
        cur.executemany(
            """insert into indices (key,name,proxy_etf,country,region,index_kind)
               values (%s,%s,%s,%s,%s,%s)
               on conflict (key) do update set name=excluded.name,
                 proxy_etf=excluded.proxy_etf, country=excluded.country,
                 region=excluded.region, index_kind=excluded.index_kind""", ix_rows)
        # Rows whose key isn't a tracked index would violate the FK and abort the
        # whole batch. Drop them here, and SAY which — silently writing 131 of 133
        # is how you end up trusting a store that quietly lost things.
        cur.execute("select key from indices")
        known = {k for (k,) in cur.fetchall()}
        keep = [r for r in rows if r[0] in known]
        skipped = sorted({r[0] for r in rows} - known)
        cur.executemany(
            """insert into index_metrics
               (index_key,asof,pe,pb,ps,dividend_yield,value_score,growth_score,
                momentum_score,opportunity_score,overvalued,value_trap,garp,source)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict (index_key,asof) do update set
                 pe=excluded.pe, pb=excluded.pb, ps=excluded.ps,
                 dividend_yield=excluded.dividend_yield,
                 value_score=excluded.value_score, growth_score=excluded.growth_score,
                 momentum_score=excluded.momentum_score,
                 opportunity_score=excluded.opportunity_score,
                 overvalued=excluded.overvalued, value_trap=excluded.value_trap,
                 garp=excluded.garp, source=excluded.source""", keep)
        conn.commit()

    out = {"indices": len(ix_rows), "metrics": len(keep), "asof": asof}
    if skipped:
        out["skipped_unknown_index"] = skipped
        print(f"   WARNING: {len(skipped)} scoreboard rows have no `indices` entry "
              f"and were NOT persisted: {', '.join(skipped[:8])}"
              f"{' …' if len(skipped) > 8 else ''}")
    drift = index_metric_drift(asof)
    if drift:
        out["drift"] = drift
        print(f"   index drift vs previous snapshot: {len(drift)} ratio(s) moved >"
              f"{_DRIFT_FACTOR}x — {', '.join(d['index_key'] + '.' + d['field'] for d in drift[:6])}")
    return out


def index_metric_drift(asof: str, factor: float = _DRIFT_FACTOR) -> list[dict]:
    """P/E or P/B that moved more than `factor` (either way) since the previous
    snapshot. This is the check the single-JSON-file design could not do at all:
    with no history there was nothing to compare a published ratio against.
    Returns [] when there is no earlier snapshot yet."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select max(asof) from index_metrics where asof < %s", (asof,))
        row = cur.fetchone()
        prev = row[0] if row else None
        if not prev:
            return []
        cur.execute(
            """with cur as (
                 select index_key, unnest(array['pe','pb']) as field,
                        unnest(array[pe,pb]) as val
                   from index_metrics where asof=%s),
               prv as (
                 select index_key, unnest(array['pe','pb']) as field,
                        unnest(array[pe,pb]) as val
                   from index_metrics where asof=%s)
               select c.index_key, c.field, p.val, c.val
                 from cur c join prv p
                   on p.index_key=c.index_key and p.field=c.field
                where c.val is not null and p.val is not null
                  and p.val > 0 and c.val > 0
                  and (c.val / p.val > %s or p.val / c.val > %s)
                order by 1, 2""",
            (asof, prev, factor, factor))
        return [{"index_key": k, "field": fld, "prev": pv, "cur": cv,
                 "prev_asof": str(prev)} for k, fld, pv, cv in cur.fetchall()]


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
