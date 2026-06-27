"""Semantic memory — the middle tier of the project's memory, so learnings persist
with provenance, confidence, lifecycle, and history rather than being lost in an
append-only file.

Three tiers (see docs/MEMORY.md):
  episodic   — raw logs already in Postgres (model_invocations, source_evals, …)
  semantic   — THIS module: the `lessons` table (capture/consolidate/verify/retrieve)
  curated    — engine/context/*.md playbooks, the trusted core promoted from here

Lifecycle:  capture (candidate) -> consolidate (-> active) -> verify/decay
            -> promote (-> curated .md) ; retire/supersede when wrong or stale.

Retrieval degrades gracefully: pgvector semantic search if embeddings + the vector
column exist; else Postgres full-text; else scope/recency ordering. Always optional —
every DB op is best-effort so the LLM path still runs with no DB and no embeddings.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timezone

from . import config, db

_HAVE_VECTORS: bool | None = None  # cached column-exists check


# --- keys / helpers --------------------------------------------------------

def _norm(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _dedup_key(scope: str, claim: str) -> str:
    """Stable merge key. Short claims key on full text; long ones on a hash tail."""
    base = _norm(claim)
    tail = base if len(base) <= 80 else hashlib.sha1(base.encode()).hexdigest()[:16]
    return f"{scope}|{tail}"


def _vec_str(v: list[float]) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in v) + "]"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def have_vectors() -> bool:
    """Does the lessons.embedding column exist (migration 0008 applied)?"""
    global _HAVE_VECTORS
    if _HAVE_VECTORS is not None:
        return _HAVE_VECTORS
    if not db.have_db():
        _HAVE_VECTORS = False
        return False
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select 1 from information_schema.columns "
                        "where table_name='lessons' and column_name='embedding'")
            _HAVE_VECTORS = cur.fetchone() is not None
    except Exception:
        _HAVE_VECTORS = False
    return _HAVE_VECTORS


def _event(cur, lesson_id, event, *, to_status=None, from_status=None,
           confidence=None, detail=None, origin=None):
    cur.execute(
        "insert into lesson_events(lesson_id,event,from_status,to_status,confidence,detail,origin) "
        "values (%s,%s,%s,%s,%s,%s,%s)",
        (lesson_id, event, from_status, to_status, confidence, detail, origin))


def _embed_one(text: str) -> str | None:
    """Best-effort embedding of one claim as a pgvector literal, or None."""
    if not have_vectors():
        return None
    try:
        from . import llm
        vecs = llm.embed([text])
        if vecs and vecs[0] and len(vecs[0]) == config.EMBED_DIM:
            return _vec_str(vecs[0])
    except Exception:
        pass
    return None


# --- capture / confirm / contradict ---------------------------------------

def capture(scope: str, claim: str, *, kind: str = "fact", origin: str = "agent",
            confidence: float = 0.5, testable: bool = False, test_hint: str | None = None) -> int | None:
    """Record a learning as a CANDIDATE (or confirm an existing one). Returns id.

    Merges by dedup_key: a re-capture bumps evidence_count + confidence and refreshes
    last_confirmed rather than creating a duplicate. Embeds the claim on first insert.
    Silent no-op (returns None) without a DB.
    """
    if not db.have_db() or not claim:
        return None
    key = _dedup_key(scope, claim)
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "insert into lessons(scope,kind,claim,dedup_key,status,confidence,origin,testable,test_hint) "
                "values (%s,%s,%s,%s,'candidate',%s,%s,%s,%s) "
                "on conflict (dedup_key) do update set "
                "  evidence_count = lessons.evidence_count + 1, "
                "  confidence = least(0.98, lessons.confidence + 0.08), "
                "  last_confirmed = now() "
                "returning id, (xmax = 0) as inserted, status, confidence",
                (scope, kind, claim, key, confidence, origin, testable, test_hint))
            lid, inserted, status, conf = cur.fetchone()
            _event(cur, lid, "captured" if inserted else "confirmed",
                   to_status=status, confidence=conf, detail=claim[:200], origin=origin)
            c.commit()
        if inserted:
            emb = _embed_one(claim)
            if emb:
                try:
                    with db.connect() as c, c.cursor() as cur:
                        cur.execute("update lessons set embedding=%s::vector where id=%s", (emb, lid))
                        c.commit()
                except Exception:
                    pass
        return lid
    except Exception:
        return None


def contradict(scope: str, claim: str, *, origin: str = "verify", detail: str | None = None) -> None:
    """Record evidence AGAINST a lesson: drop confidence, maybe retire it."""
    if not db.have_db():
        return
    key = _dedup_key(scope, claim)
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select id,status,confidence from lessons where dedup_key=%s", (key,))
            row = cur.fetchone()
            if not row:
                return
            lid, status, conf = row
            new_conf = max(0.0, float(conf) * 0.5 - 0.05)
            new_status = "retired" if new_conf < config.MEM_RETIRE_CONF else status
            cur.execute(
                "update lessons set confidence=%s, contradiction_count=contradiction_count+1, "
                "last_contradicted=now(), status=%s where id=%s", (new_conf, new_status, lid))
            _event(cur, lid, "contradicted", from_status=status, to_status=new_status,
                   confidence=new_conf, detail=detail, origin=origin)
            if new_status == "retired" and status != "retired":
                _event(cur, lid, "retired", from_status=status, to_status="retired",
                       confidence=new_conf, origin=origin)
            c.commit()
    except Exception:
        pass


# --- lifecycle jobs (deterministic) ---------------------------------------

def consolidate() -> dict:
    """Promote candidates that have earned trust to 'active' (injectable via retrieval)."""
    if not db.have_db():
        return {"skipped": "no db"}
    activated = 0
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                "select id,status,confidence from lessons "
                "where status='candidate' and (evidence_count >= %s or confidence >= %s)",
                (config.MEM_ACTIVATE_EVIDENCE, config.MEM_ACTIVATE_CONF))
            rows = cur.fetchall()
            for lid, status, conf in rows:
                cur.execute("update lessons set status='active' where id=%s", (lid,))
                _event(cur, lid, "status_change", from_status=status, to_status="active",
                       confidence=conf, detail="consolidated", origin="consolidate")
                activated += 1
            c.commit()
    except Exception as e:
        return {"error": str(e)[:160]}
    return {"activated": activated}


def verify_decay() -> dict:
    """Apply time-decay to confidence (half-life on last_confirmed); retire stale
    candidate/active lessons that fall below the floor. Promoted/curated lessons are
    NOT auto-retired (they require an explicit contradiction) to stay in sync with .md."""
    if not db.have_db():
        return {"skipped": "no db"}
    retired = decayed = 0
    half = max(1.0, config.MEM_DECAY_HALFLIFE_DAYS)
    now = _now()
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select id,status,confidence,last_confirmed from lessons "
                        "where status in ('candidate','active')")
            for lid, status, conf, last_conf in cur.fetchall():
                age_days = max(0.0, (now - last_conf).total_seconds() / 86400.0)
                factor = 0.5 ** (age_days / half)
                new_conf = round(float(conf) * factor, 3)
                if abs(new_conf - float(conf)) < 0.001:
                    continue
                new_status = "retired" if new_conf < config.MEM_RETIRE_CONF else status
                cur.execute("update lessons set confidence=%s, status=%s where id=%s",
                            (new_conf, new_status, lid))
                _event(cur, lid, "retired" if new_status == "retired" else "decayed",
                       from_status=status, to_status=new_status, confidence=new_conf,
                       detail=f"decay factor {factor:.3f} over {age_days:.0f}d", origin="verify_decay")
                decayed += 1
                retired += int(new_status == "retired" and status != "retired")
            c.commit()
    except Exception as e:
        return {"error": str(e)[:160]}
    return {"decayed": decayed, "retired": retired}


# --- retrieval (3-mode, graceful) -----------------------------------------

def retrieve(scopes: list[str], query: str | None = None, k: int = 8) -> list[dict]:
    """Top-k ACTIVE lessons for the given scope patterns, relevant to `query`.

    Mode 1 (vector): pgvector cosine search if embeddings + the column exist.
    Mode 2 (lexical): Postgres full-text on the claim.
    Mode 3 (scope):  confidence x recency ordering.
    Promoted lessons are excluded — they already live in the curated .md core.
    """
    if not db.have_db() or not scopes:
        return []
    try:
        from psycopg.rows import dict_row
        rows: list[dict] = []
        with db.connect() as c, c.cursor(row_factory=dict_row) as cur:
            # Mode 1 — semantic
            if query and have_vectors():
                emb = _embed_one(query)
                if emb:
                    cur.execute(
                        "select id, scope, kind, claim, confidence, "
                        "       1 - (embedding <=> %s::vector) as sim "
                        "from lessons where status='active' and embedding is not null "
                        "  and scope like any(%s) "
                        "order by embedding <=> %s::vector limit %s",
                        (emb, scopes, emb, k))
                    rows = cur.fetchall()
            # Mode 2 — lexical
            if not rows and query:
                cur.execute(
                    "select id, scope, kind, claim, confidence, "
                    "       ts_rank(search, plainto_tsquery('english', %s)) as sim "
                    "from lessons where status='active' and scope like any(%s) "
                    "  and search @@ plainto_tsquery('english', %s) "
                    "order by sim desc, confidence desc limit %s",
                    (query, scopes, query, k))
                rows = cur.fetchall()
            # Mode 3 — scope / recency
            if not rows:
                cur.execute(
                    "select id, scope, kind, claim, confidence, null as sim "
                    "from lessons where status='active' and scope like any(%s) "
                    "order by confidence desc, last_confirmed desc limit %s",
                    (scopes, k))
                rows = cur.fetchall()
            if rows:
                cur.execute("update lessons set last_used=now() where id = any(%s)",
                            ([r["id"] for r in rows],))
                c.commit()
        return rows
    except Exception:
        return []


# --- promotion (curate into the .md core; human-in-loop) -------------------

def propose_promotions(limit: int = 20) -> list[dict]:
    """Active, durable, high-confidence lessons not yet curated into a playbook."""
    if not db.have_db():
        return []
    try:
        from psycopg.rows import dict_row
        with db.connect() as c, c.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "select id, scope, kind, claim, confidence, evidence_count "
                "from lessons where status='active' and confidence >= %s "
                "order by confidence desc, evidence_count desc limit %s",
                (config.MEM_PROMOTE_CONF, limit))
            return cur.fetchall()
    except Exception:
        return []


def apply_promotion(lesson_id: int, origin: str = "human") -> bool:
    """Mark a lesson 'promoted' and curate it into the matching .md playbook."""
    if not db.have_db():
        return False
    try:
        from . import knowledge
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select scope, claim, status from lessons where id=%s", (lesson_id,))
            row = cur.fetchone()
            if not row:
                return False
            scope, claim, status = row
            knowledge.append_curated(scope, claim)
            cur.execute("update lessons set status='promoted', promoted_at=now() where id=%s", (lesson_id,))
            _event(cur, lesson_id, "promoted", from_status=status, to_status="promoted",
                   detail=claim[:200], origin=origin)
            c.commit()
        return True
    except Exception:
        return False


# --- point-in-time + stats -------------------------------------------------

def belief_at(scopes: list[str], as_of: datetime) -> list[dict]:
    """What did the system believe (active/promoted lessons) at `as_of`?

    Reconstructed from lesson_events history — for backtest integrity, so a past run
    can be scored against the knowledge it actually had, not today's."""
    if not db.have_db() or not scopes:
        return []
    try:
        from psycopg.rows import dict_row
        with db.connect() as c, c.cursor(row_factory=dict_row) as cur:
            cur.execute(
                "select distinct on (le.lesson_id) le.lesson_id, le.to_status, "
                "       l.scope, l.kind, l.claim "
                "from lesson_events le join lessons l on l.id = le.lesson_id "
                "where le.ts <= %s and l.scope like any(%s) "
                "order by le.lesson_id, le.ts desc",
                (as_of, scopes))
            return [r for r in cur.fetchall() if r["to_status"] in ("active", "promoted")]
    except Exception:
        return []


def stats() -> dict:
    if not db.have_db():
        return {"skipped": "no db"}
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select status, count(*) from lessons group by status")
            by_status = {s: n for s, n in cur.fetchall()}
            cur.execute("select count(*) from lessons where embedding is not null") \
                if have_vectors() else None
            embedded = cur.fetchone()[0] if have_vectors() else 0
            cur.execute("select count(*) from lesson_events")
            events = cur.fetchone()[0]
        return {"by_status": by_status, "embedded": embedded, "events": events,
                "vectors": have_vectors()}
    except Exception as e:
        return {"error": str(e)[:160]}


if __name__ == "__main__":  # python -m engine.memory
    import json as _json
    print("stats:", _json.dumps(stats(), default=str))
    print("\nconsolidate:", consolidate())
    print("decay:", verify_decay())
    props = propose_promotions()
    print(f"\n{len(props)} promotion candidate(s):")
    for p in props:
        print(f"  [{p['id']}] ({p['confidence']}) {p['scope']}: {p['claim'][:90]}")
