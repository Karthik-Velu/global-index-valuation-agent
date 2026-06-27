"""The source catalog + evaluation ledger + the data-needs the agent serves.

All in the existing SQLite DB so the ingestion agent shares state with the rest of
the engine. A source moves through: lead (discovered) -> candidate (adapter exists,
probed) -> active (wired into a need) / retired.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import date, datetime, timezone
from pathlib import Path

from ..config import DB_PATH

SEED_CATALOG = Path(__file__).parent / "seed_catalog.json"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.executescript(
        """
        CREATE TABLE IF NOT EXISTS data_sources(
            id TEXT PRIMARY KEY, name TEXT, provider TEXT, kinds TEXT, coverage TEXT,
            access_method TEXT, endpoint TEXT, auth TEXT, free_tier TEXT, license TEXT,
            update_freq TEXT, notes TEXT, sample_hint TEXT,
            verified_live INTEGER DEFAULT 0, has_adapter INTEGER DEFAULT 0,
            status TEXT DEFAULT 'lead', confidence TEXT, added_ts TEXT, updated_ts TEXT);
        CREATE TABLE IF NOT EXISTS source_evals(
            ts TEXT, source_id TEXT, kind TEXT, coverage_pct REAL, completeness_pct REAL,
            sanity_pct REAL, freshness_days REAL, latency_ms REAL, rate_ok INTEGER,
            quality_score REAL, sample_n INTEGER, error TEXT, detail TEXT);
        CREATE TABLE IF NOT EXISTS data_needs(
            id TEXT PRIMARY KEY, kind TEXT, market_scope TEXT, description TEXT,
            active_source_id TEXT, target_freq TEXT, public_only INTEGER DEFAULT 1,
            updated_ts TEXT);
        CREATE TABLE IF NOT EXISTS source_decisions(
            ts TEXT, need_id TEXT, from_source TEXT, to_source TEXT,
            reason TEXT, auto INTEGER, applied INTEGER);
        """
    )
    return c


# --- sources ---------------------------------------------------------------

def upsert_source(s: dict) -> None:
    """Insert/update a catalog entry. `s` keys mirror the columns; kinds is a list."""
    c = _conn()
    kinds = ",".join(s.get("kinds", [])) if isinstance(s.get("kinds"), list) else (s.get("kinds") or "")
    with c:
        c.execute(
            """INSERT INTO data_sources
               (id,name,provider,kinds,coverage,access_method,endpoint,auth,free_tier,
                license,update_freq,notes,sample_hint,verified_live,has_adapter,status,
                confidence,added_ts,updated_ts)
               VALUES (:id,:name,:provider,:kinds,:coverage,:access_method,:endpoint,:auth,
                :free_tier,:license,:update_freq,:notes,:sample_hint,:verified_live,
                :has_adapter,:status,:confidence,
                COALESCE((SELECT added_ts FROM data_sources WHERE id=:id), :now), :now)
               ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, provider=excluded.provider, kinds=excluded.kinds,
                coverage=excluded.coverage, access_method=excluded.access_method,
                endpoint=excluded.endpoint, auth=excluded.auth, free_tier=excluded.free_tier,
                license=excluded.license, update_freq=excluded.update_freq, notes=excluded.notes,
                sample_hint=excluded.sample_hint, verified_live=excluded.verified_live,
                has_adapter=excluded.has_adapter, status=excluded.status,
                confidence=excluded.confidence, updated_ts=excluded.updated_ts""",
            {
                "id": s["id"], "name": s.get("name", s["id"]), "provider": s.get("provider", ""),
                "kinds": kinds, "coverage": s.get("coverage", ""),
                "access_method": s.get("access_method", ""), "endpoint": s.get("endpoint", ""),
                "auth": s.get("auth", ""), "free_tier": s.get("free_tier", ""),
                "license": s.get("license", "unknown"), "update_freq": s.get("update_freq", ""),
                "notes": s.get("notes", ""), "sample_hint": s.get("sample_hint", ""),
                "verified_live": int(bool(s.get("verified_live"))),
                "has_adapter": int(bool(s.get("has_adapter"))),
                "status": s.get("status", "lead"), "confidence": s.get("confidence", ""),
                "now": _now(),
            },
        )
    c.close()


def seed_from_catalog() -> int:
    """Load the research-verified source catalog as `lead`s (idempotent)."""
    if not SEED_CATALOG.exists():
        return 0
    data = json.loads(SEED_CATALOG.read_text())
    for s in data.get("sources", []):
        s = dict(s)
        s.setdefault("status", "lead")
        s.setdefault("has_adapter", False)
        upsert_source(s)
    return len(data.get("sources", []))


def list_sources(status: str | None = None) -> list[dict]:
    c = _conn()
    q = "SELECT * FROM data_sources"
    rows = c.execute(q + (" WHERE status=?" if status else ""), (status,) if status else ()).fetchall()
    cols = [d[0] for d in c.execute("SELECT * FROM data_sources LIMIT 0").description]
    c.close()
    return [dict(zip(cols, r)) for r in rows]


# --- evaluations -----------------------------------------------------------

def record_eval(e: dict) -> None:
    c = _conn()
    with c:
        c.execute(
            """INSERT INTO source_evals
               (ts,source_id,kind,coverage_pct,completeness_pct,sanity_pct,freshness_days,
                latency_ms,rate_ok,quality_score,sample_n,error,detail)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (_now(), e["source_id"], e["kind"], e.get("coverage_pct"), e.get("completeness_pct"),
             e.get("sanity_pct"), e.get("freshness_days"), e.get("latency_ms"),
             int(bool(e.get("rate_ok", True))), e.get("quality_score"), e.get("sample_n"),
             e.get("error"), json.dumps(e.get("detail", {}))),
        )
    c.close()


def latest_evals(kind: str | None = None) -> list[dict]:
    """Most recent eval per (source, kind)."""
    c = _conn()
    rows = c.execute(
        """SELECT e.* FROM source_evals e
           JOIN (SELECT source_id,kind,MAX(ts) mx FROM source_evals GROUP BY source_id,kind) m
             ON e.source_id=m.source_id AND e.kind=m.kind AND e.ts=m.mx"""
    ).fetchall()
    cols = [d[0] for d in c.execute("SELECT * FROM source_evals LIMIT 0").description]
    c.close()
    out = [dict(zip(cols, r)) for r in rows]
    return [o for o in out if (kind is None or o["kind"] == kind)]


# --- needs + decisions -----------------------------------------------------

def upsert_need(n: dict) -> None:
    c = _conn()
    with c:
        c.execute(
            """INSERT INTO data_needs(id,kind,market_scope,description,active_source_id,
                 target_freq,public_only,updated_ts)
               VALUES (:id,:kind,:market_scope,:description,:active_source_id,:target_freq,:public_only,:now)
               ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,market_scope=excluded.market_scope,
                 description=excluded.description,target_freq=excluded.target_freq,
                 public_only=excluded.public_only,updated_ts=excluded.updated_ts""",
            {"id": n["id"], "kind": n["kind"], "market_scope": n.get("market_scope", ""),
             "description": n.get("description", ""), "active_source_id": n.get("active_source_id"),
             "target_freq": n.get("target_freq", ""), "public_only": int(bool(n.get("public_only", True))),
             "now": _now()},
        )
    c.close()


def list_needs() -> list[dict]:
    c = _conn()
    rows = c.execute("SELECT * FROM data_needs").fetchall()
    cols = [d[0] for d in c.execute("SELECT * FROM data_needs LIMIT 0").description]
    c.close()
    return [dict(zip(cols, r)) for r in rows]


def set_active_source(need_id: str, to_source: str, reason: str, auto: bool, applied: bool = True) -> None:
    c = _conn()
    cur = c.execute("SELECT active_source_id FROM data_needs WHERE id=?", (need_id,)).fetchone()
    frm = cur[0] if cur else None
    with c:
        if applied:
            c.execute("UPDATE data_needs SET active_source_id=?, updated_ts=? WHERE id=?",
                      (to_source, _now(), need_id))
        c.execute(
            "INSERT INTO source_decisions(ts,need_id,from_source,to_source,reason,auto,applied) VALUES (?,?,?,?,?,?,?)",
            (_now(), need_id, frm, to_source, reason, int(auto), int(applied)),
        )
    c.close()


def recent_decisions(limit: int = 20) -> list[dict]:
    c = _conn()
    rows = c.execute("SELECT ts,need_id,from_source,to_source,reason,auto,applied "
                     "FROM source_decisions ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    c.close()
    keys = ["ts", "need_id", "from_source", "to_source", "reason", "auto", "applied"]
    return [dict(zip(keys, r)) for r in rows]
