"""The 5 whitelisted tools for the Analyst's bounded ReAct loop
(ARCHITECTURE.md Pillar 1). Every tool is best-effort: a failure returns
{"error": ...} rather than raising, so a bad tool call becomes evidence the
loop can react to next step instead of crashing the run.

`write_thesis` is the ONLY mutation — every other tool is read-only, matching
"advises only, never writes into scores."
"""
from __future__ import annotations

import xml.etree.ElementTree as ET
from datetime import date, timedelta
from urllib.parse import quote

import requests

from .. import db

_NEWS_URL = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"


def query_ledger(market_key: str, **_) -> dict:
    """Past predictions for this market + its own prior theses. (accuracy is only
    tracked in aggregate, not per-market, so we surface the latest overall
    rank-IC/hit-rate for context rather than a per-market figure that doesn't exist.)"""
    if not db.have_db():
        return {"error": "no database configured"}
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "select asof,price,value_score,growth_score,opportunity_score,value_trap "
            "from predictions where key=%s order by asof desc limit 8", (market_key,))
        preds = [{"asof": str(r[0]), "price": r[1], "value_score": r[2], "growth_score": r[3],
                 "opportunity_score": r[4], "value_trap": r[5]} for r in cur.fetchall()]
        cur.execute(
            "select asof,claim,direction,eval_date,status,outcome from theses "
            "where market_key=%s order by asof desc limit 5", (market_key,))
        theses = [{"asof": str(r[0]), "claim": r[1], "direction": r[2], "eval_date": str(r[3]),
                  "status": r[4], "outcome": r[5]} for r in cur.fetchall()]
        cur.execute("select asof,rank_ic,hit_rate,n from accuracy order by asof desc limit 1")
        row = cur.fetchone()
        latest_accuracy = ({"asof": str(row[0]), "rank_ic": row[1], "hit_rate": row[2], "n": row[3]}
                           if row else None)
    return {"predictions": preds, "past_theses": theses, "latest_overall_accuracy": latest_accuracy}


def get_market_detail(market_key: str, df_by_key: dict | None = None, **_) -> dict:
    """The full scoreboard row for this market, read from the in-memory df this
    run already computed — no re-fetch."""
    row = (df_by_key or {}).get(market_key)
    if row is None:
        return {"error": f"unknown market_key {market_key!r}"}
    return {k: v for k, v in row.items() if v is not None and k != "holdings"}


def fill_growth_gap(market_key: str, asof: str | None = None, **_) -> dict:
    """Re-fetch trailing/forward growth for this market's holdings that are
    missing it, filling (not bypassing) the existing per-day cache — a plain
    re-run of enrich_growth() would silently skip exactly the gaps we want
    filled, since it only fetches symbols NOT already in the cache, which is
    also true here: we only refetch symbols still missing after the cache hit.
    READ-ONLY against the live scoreboard: recomputes and returns a fresh
    weighted growth estimate but never re-persists to predictions/scores."""
    from .. import datasource

    asof = asof or date.today().isoformat()
    try:
        snaps = datasource.load_snapshots(asof)
    except Exception as e:
        return {"error": f"could not load snapshots for {asof}: {str(e)[:120]}"}
    snap = next((s for s in snaps if s.key == market_key), None)
    if snap is None or not snap.holdings:
        return {"error": f"no holdings on file for {market_key!r} as of {asof}"}

    cache = datasource._growth_cache(asof)
    missing = [sym for sym, _w in snap.holdings if datasource._valid_sym(sym) and sym not in cache]
    for sym in missing:
        g = datasource._stock_growth(sym)
        datasource._growth_cache_put(asof, sym, g)
        cache[sym] = g

    def clip(x):
        lo, hi = -2.0, 5.0
        return None if x is None else max(lo, min(hi, x))

    rev = datasource._wavg(snap.holdings, cache, "rev", clip)
    earn = datasource._wavg(snap.holdings, cache, "earn", clip)
    fwd = datasource._wavg(snap.holdings, cache, "fwd", clip)
    growth_cov = round(max(rev["cov"], earn["cov"], fwd["cov"]), 3)
    return {"rev_growth": rev["val"], "earnings_growth": earn["val"], "fwd_growth": fwd["val"],
           "growth_cov": growth_cov, "newly_fetched": len(missing)}


def fetch_news(query: str, max_results: int = 5, **_) -> list[dict]:
    """Google News RSS — free, no API key. Transient headline read for
    thesis-writing context, NOT bulk/redistributed data (see docs/DECISIONS.md
    for the licensing judgment call this makes). Best-effort: any failure -> []."""
    query = (query or "").strip()
    if not query:
        return []
    try:
        resp = requests.get(_NEWS_URL.format(q=quote(query)), timeout=8)
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    except Exception:
        return []
    out = []
    for item in root.findall(".//item")[:max_results]:
        title = (item.findtext("title") or "").strip()
        link = (item.findtext("link") or "").strip()
        pub = (item.findtext("pubDate") or "").strip()
        source = (item.findtext("source") or "").strip()
        if title:
            out.append({"headline": title, "url": link, "published": pub, "source": source})
    return out


_DIRECTIONS = {"up", "down", "flat"}


def write_thesis(market_key: str, claim: str, direction: str, eval_date: str,
                 confidence: float, evidence: dict | list | None = None,
                 asof: str | None = None, model_id: str | None = None, **_) -> dict:
    """The ONLY mutation this agent performs. Validates inputs; inserts into
    `theses`. Returns {"id": ...} on success, {"error": ...} on a bad action
    (fed back to the model as evidence, not raised)."""
    import json as _json

    direction = (direction or "").strip().lower()
    if direction not in _DIRECTIONS:
        return {"error": f"direction must be one of {sorted(_DIRECTIONS)}, got {direction!r}"}
    try:
        confidence = float(confidence)
    except Exception:
        return {"error": f"confidence must be a number in [0,1], got {confidence!r}"}
    if not (0.0 <= confidence <= 1.0):
        return {"error": f"confidence must be in [0,1], got {confidence}"}
    asof_d = date.fromisoformat(asof) if asof else date.today()
    try:
        eval_d = date.fromisoformat(str(eval_date)[:10])
    except Exception:
        return {"error": f"eval_date must be YYYY-MM-DD, got {eval_date!r}"}
    if not (asof_d < eval_d <= asof_d + timedelta(days=365)):
        return {"error": f"eval_date {eval_d} must be after {asof_d} and within 365 days"}
    if not (claim or "").strip():
        return {"error": "claim must be a non-empty falsifiable statement"}
    if not db.have_db():
        return {"error": "no database configured — thesis not persisted"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "insert into theses(market_key,asof,claim,direction,eval_date,confidence,"
            "evidence,model_id) values (%s,%s,%s,%s,%s,%s,%s,%s) returning id",
            (market_key, asof_d, claim.strip(), direction, eval_d, confidence,
             _json.dumps(evidence or [], default=str), model_id))
        thesis_id = cur.fetchone()[0]
        c.commit()
    return {"id": thesis_id}


TOOLS = {
    "query_ledger": query_ledger,
    "get_market_detail": get_market_detail,
    "fill_growth_gap": fill_growth_gap,
    "fetch_news": fetch_news,
    "write_thesis": write_thesis,
}
