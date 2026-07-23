"""Deterministic gate for the Analyst agent: which 3-8 markets are genuinely
ambiguous enough to spend LLM budget investigating this run (ARCHITECTURE.md
Pillar 1). Returns [] if fewer than 3 qualify — no forced/partial
investigation on a quiet run.
"""
from __future__ import annotations

from .. import db


def _big_rank_movers(df, asof: str, top_n: int = 5) -> list[str]:
    """Markets whose opportunity_score rank shifted a lot vs the prior run."""
    if not db.have_db():
        return []
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select distinct asof from predictions where asof < %s::date "
                       "order by asof desc limit 1", (asof,))
            row = cur.fetchone()
            if not row:
                return []
            prior_asof = row[0]
            cur.execute("select key, opportunity_score from predictions where asof=%s",
                       (prior_asof,))
            prior = {k: v for k, v in cur.fetchall() if v is not None}
    except Exception:
        return []
    if not prior:
        return []
    cur_scores = df.set_index("key")["opportunity_score"].dropna()
    prior_rank = {k: r for r, k in enumerate(sorted(prior, key=prior.get, reverse=True))}
    cur_rank = {k: r for r, k in enumerate(cur_scores.sort_values(ascending=False).index)}
    moves = []
    for key in cur_rank:
        if key in prior_rank:
            moves.append((key, abs(cur_rank[key] - prior_rank[key])))
    moves.sort(key=lambda kv: kv[1], reverse=True)
    return [k for k, delta in moves[:top_n] if delta > 0]


def _theses_due(asof: str) -> list[str]:
    if not db.have_db():
        return []
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select distinct market_key from theses where status='open' "
                       "and eval_date <= %s::date", (asof,))
            return [r[0] for r in cur.fetchall()]
    except Exception:
        return []


def pick_ambiguous_markets(df, asof: str, limit: int = 8) -> list[dict]:
    value_traps = df.loc[df["value_trap"].fillna(False), "key"].tolist() if "value_trap" in df else []
    thin_garp = (df.loc[df["garp"].fillna(False) & (df["growth_cov"].fillna(1.0) < 0.5), "key"].tolist()
                if "garp" in df and "growth_cov" in df else [])
    movers = _big_rank_movers(df, asof)
    due = _theses_due(asof)

    seen: set[str] = set()
    ordered: list[str] = []
    for pool in (value_traps, thin_garp, due, movers):
        for k in pool:
            if k not in seen:
                seen.add(k)
                ordered.append(k)

    if len(ordered) < 3:
        return []

    by_key = df.set_index("key").to_dict(orient="index")
    return [{"key": k, **by_key[k]} for k in ordered[:limit] if k in by_key]
