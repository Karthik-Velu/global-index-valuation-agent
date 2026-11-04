"""The source catalog + evaluation ledger + data-needs — now on Postgres (Tier A),
the single source of truth shared with the rest of the engine.
"""
from __future__ import annotations

import json
from pathlib import Path

from psycopg.rows import dict_row

from .. import canonical, db

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
        upsert_source(s, authoritative=True)   # researched by hand: the catalogue IS the record
    return len(data.get("sources", []))


# On conflict, an authoritative write (an adapter declared in code, or the researched
# seed catalogue) replaces the row. Anything else may only fill blanks, and never
# touches the verified fields: licence, notes, verified_live, has_adapter, status,
# confidence. Proposal 146 ('finnhub') showed why: an invented lead colliding with the
# verified personal_only row rewrote its licence to the model's redistribution_ok.
_ON_CONFLICT = {
    True: """on conflict (id) do update set
                 name=excluded.name, provider=excluded.provider, kinds=excluded.kinds,
                 coverage=excluded.coverage, access_method=excluded.access_method,
                 endpoint=excluded.endpoint, auth=excluded.auth, free_tier=excluded.free_tier,
                 license=excluded.license, update_freq=excluded.update_freq, notes=excluded.notes,
                 sample_hint=excluded.sample_hint, verified_live=excluded.verified_live,
                 has_adapter=excluded.has_adapter, status=excluded.status,
                 confidence=excluded.confidence, updated_ts=now()""",
    False: """on conflict (id) do update set
                 coverage=coalesce(nullif(data_sources.coverage,''), excluded.coverage),
                 access_method=coalesce(nullif(data_sources.access_method,''), excluded.access_method),
                 endpoint=coalesce(nullif(data_sources.endpoint,''), excluded.endpoint),
                 sample_hint=coalesce(nullif(data_sources.sample_hint,''), excluded.sample_hint),
                 updated_ts=now()""",
}


def upsert_source(s: dict, authoritative: bool = False) -> None:
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
               """ + _ON_CONFLICT[bool(authoritative)],
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
    """Registry rows. Leads marked 'invented' by migration 0017 (model-made ids with no
    adapter and no research behind them) are not sources and are never returned."""
    if status:
        return _rows("select * from data_sources where status=%s and status <> 'invented'",
                     (status,))
    return _rows("select * from data_sources where coalesce(status,'') <> 'invented'")


# Most restrictive first: a provider with one personal-use row is personal-use.
_LICENSE_ORDER = ["prohibited", "personal_only", "unknown", "redistribution_ok", "public_domain"]


def verified_license(provider: str, kind: str | None = None,
                     sources: list[dict] | None = None) -> str | None:
    """The licence the registry holds for a provider, or None if it knows none.

    The licence gate in discovery uses this, never the model's claim: every new
    spelling of a provider used to claim redistribution_ok and pass. Rows serving
    `kind` decide when there are any; otherwise all the provider's rows do. Several
    rows -> the most restrictive wins, because licensing is the one place where a
    wrong yes costs more than a wrong no.
    """
    want = canonical.provider(provider)
    mine = [r for r in (list_sources() if sources is None else sources)
            if want in {canonical.provider(r.get("provider") or ""), canonical.provider(r["id"])}]
    if kind:
        mine = [r for r in mine if kind in str(r.get("kinds") or "").split(",")] or mine
    lic = [r.get("license") or "unknown" for r in mine]
    return min(lic, key=lambda x: _LICENSE_ORDER.index(x) if x in _LICENSE_ORDER else 2) if lic else None


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

def _need_params(n: dict) -> dict:
    return {"id": n["id"], "kind": n["kind"], "market_scope": n.get("market_scope", ""),
            "description": n.get("description", ""), "active_source_id": n.get("active_source_id"),
            "target_freq": n.get("target_freq", ""), "public_only": bool(n.get("public_only", True)),
            "status": n.get("status", "open"), "roadmap_ref": n.get("roadmap_ref"),
            "park_until": n.get("park_until"), "status_note": n.get("status_note")}


_NEED_INSERT = """insert into data_needs(id,kind,market_scope,description,active_source_id,
                 target_freq,public_only,status,roadmap_ref,park_until,status_note,updated_ts)
               values (%(id)s,%(kind)s,%(market_scope)s,%(description)s,%(active_source_id)s,
                 %(target_freq)s,%(public_only)s,%(status)s,%(roadmap_ref)s,%(park_until)s,
                 %(status_note)s,now())"""


def upsert_need(n: dict) -> None:
    """Insert, or refresh the description of, a need. The status fields are written
    on insert only: whether a need is open is the owner's call once it exists."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(
            _NEED_INSERT + """
               on conflict (id) do update set kind=excluded.kind, market_scope=excluded.market_scope,
                 description=excluded.description, target_freq=excluded.target_freq,
                 public_only=excluded.public_only, updated_ts=now()""",
            _need_params(n))
        conn.commit()


def add_need(n: dict) -> bool:
    """Insert a need if it is not there yet; never touch an existing one. True if added."""
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(_NEED_INSERT + " on conflict (id) do nothing returning id", _need_params(n))
        added = cur.fetchone() is not None
        conn.commit()
    return added


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
