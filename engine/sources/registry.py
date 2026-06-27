"""The source catalog + evaluation ledger + data-needs — now on Postgres (Tier A),
the single source of truth shared with the rest of the engine.
"""
from __future__ import annotations

import json
from pathlib import Path

from psycopg.rows import dict_row

from .. import db

SEED_CATALOG = Path(__file__).parent / "seed_catalog.json"


def _rows(sql: str, params=()) -> list[dict]:
    with db.connect() as conn, conn.cursor(row_factory=dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


# --- sources ---------------------------------------------------------------

def seed_from_catalog() -> int:
    if not SEED_CATALOG.exists():
        return 0
    data = json.loads(SEED_CATALOG.read_text())
    for s in data.get("sources", []):
        s = dict(s)
        s.setdefault("status", "lead")
        s.setdefault("has_adapter", False)
        upsert_source(s)
    return len(data.get("sources", []))


def upsert_source(s: dict) -> None:
    kinds = ",".join(s.get("kinds", [])) if isinstance(s.get("kinds"), list) else (s.get("kinds") or "")
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """insert into data_sources
               (id,name,provider,kinds,coverage,access_method,endpoint,auth,free_tier,
                license,update_freq,notes,sample_hint,verified_live,has_adapter,status,
                confidence,added_ts,updated_ts)
               values (%(id)s,%(name)s,%(provider)s,%(kinds)s,%(coverage)s,%(access_method)s,
                %(endpoint)s,%(auth)s,%(free_tier)s,%(license)s,%(update_freq)s,%(notes)s,
                %(sample_hint)s,%(verified_live)s,%(has_adapter)s,%(status)s,%(confidence)s,now(),now())
               on conflict (id) do update set
                 name=excluded.name, provider=excluded.provider, kinds=excluded.kinds,
                 coverage=excluded.coverage, access_method=excluded.access_method,
                 endpoint=excluded.endpoint, auth=excluded.auth, free_tier=excluded.free_tier,
                 license=excluded.license, update_freq=excluded.update_freq, notes=excluded.notes,
                 sample_hint=excluded.sample_hint, verified_live=excluded.verified_live,
                 has_adapter=excluded.has_adapter, status=excluded.status,
                 confidence=excluded.confidence, updated_ts=now()""",
            {"id": s["id"], "name": s.get("name", s["id"]), "provider": s.get("provider", ""),
             "kinds": kinds, "coverage": s.get("coverage", ""),
             "access_method": s.get("access_method", ""), "endpoint": s.get("endpoint", ""),
             "auth": s.get("auth", ""), "free_tier": s.get("free_tier", ""),
             "license": s.get("license", "unknown"), "update_freq": s.get("update_freq", ""),
             "notes": s.get("notes", ""), "sample_hint": s.get("sample_hint", ""),
             "verified_live": bool(s.get("verified_live")), "has_adapter": bool(s.get("has_adapter")),
             "status": s.get("status", "lead"), "confidence": s.get("confidence", "")})
        conn.commit()


def list_sources(status: str | None = None) -> list[dict]:
    if status:
        return _rows("select * from data_sources where status=%s", (status,))
    return _rows("select * from data_sources")


# --- evaluations -----------------------------------------------------------

def record_eval(e: dict) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """insert into source_evals
               (ts,source_id,kind,coverage_pct,completeness_pct,sanity_pct,freshness_days,
                latency_ms,rate_ok,quality_score,sample_n,error,detail)
               values (now(),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (e["source_id"], e["kind"], e.get("coverage_pct"), e.get("completeness_pct"),
             e.get("sanity_pct"), e.get("freshness_days"), e.get("latency_ms"),
             bool(e.get("rate_ok", True)), e.get("quality_score"), e.get("sample_n"),
             e.get("error"), json.dumps(e.get("detail", {}))))
        conn.commit()


def latest_evals(kind: str | None = None) -> list[dict]:
    rows = _rows(
        """select e.* from source_evals e
           join (select source_id,kind,max(ts) mx from source_evals group by source_id,kind) m
             on e.source_id=m.source_id and e.kind=m.kind and e.ts=m.mx""")
    return [o for o in rows if (kind is None or o["kind"] == kind)]


# --- needs + decisions -----------------------------------------------------

def upsert_need(n: dict) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            """insert into data_needs(id,kind,market_scope,description,active_source_id,
                 target_freq,public_only,updated_ts)
               values (%(id)s,%(kind)s,%(market_scope)s,%(description)s,%(active_source_id)s,
                 %(target_freq)s,%(public_only)s,now())
               on conflict (id) do update set kind=excluded.kind, market_scope=excluded.market_scope,
                 description=excluded.description, target_freq=excluded.target_freq,
                 public_only=excluded.public_only, updated_ts=now()""",
            {"id": n["id"], "kind": n["kind"], "market_scope": n.get("market_scope", ""),
             "description": n.get("description", ""), "active_source_id": n.get("active_source_id"),
             "target_freq": n.get("target_freq", ""), "public_only": bool(n.get("public_only", True))})
        conn.commit()


def list_needs() -> list[dict]:
    return _rows("select * from data_needs")


def set_active_source(need_id: str, to_source: str, reason: str, auto: bool, applied: bool = True) -> None:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select active_source_id from data_needs where id=%s", (need_id,))
        row = cur.fetchone()
        frm = row[0] if row else None
        if applied:
            cur.execute("update data_needs set active_source_id=%s, updated_ts=now() where id=%s",
                        (to_source, need_id))
        cur.execute(
            "insert into source_decisions(ts,need_id,from_source,to_source,reason,auto,applied) "
            "values (now(),%s,%s,%s,%s,%s,%s)",
            (need_id, frm, to_source, reason, auto, applied))
        conn.commit()


def recent_decisions(limit: int = 20) -> list[dict]:
    return _rows("select ts,need_id,from_source,to_source,reason,auto,applied "
                 "from source_decisions order by ts desc limit %s", (limit,))
