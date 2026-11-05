"""An in-memory stand-in for the handful of Postgres statements the proposal queue,
the needs register and the three proposal agents run (ADR-044). No network, no
Postgres. Each statement is routed by its normalised text, so a query the code
issues that this fake does not know fails the test loudly instead of passing
silently. Shared by tests/test_proposals.py and tests/test_agents.py.
"""
from __future__ import annotations

import json
import os
import re
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["DATABASE_URL"] = ""   # nothing may reach a real database

# engine.sources.registry imports psycopg's dict_row at module level; CI's bare
# Python has no psycopg, and nothing here needs it.
try:
    import psycopg.rows  # noqa: F401
except ImportError:
    pg = types.ModuleType("psycopg")
    rows = types.ModuleType("psycopg.rows")
    rows.dict_row = "dict_row"
    pg.rows = rows
    sys.modules["psycopg"], sys.modules["psycopg.rows"] = pg, rows

from engine import db, llm, memory  # noqa: E402


def _j(v):
    return json.loads(v) if isinstance(v, str) else v


class FakeDB:
    def __init__(self):
        self.proposals: dict[int, dict] = {}
        self.events: list[dict] = []
        self.needs: dict[str, dict] = {}
        self.catalog: dict[str, dict] = {}
        self.sources: dict[str, dict] = {}
        self.taxonomy: list[dict] = []
        self.sub_sectors: list[str] = []
        self.now = datetime.now(timezone.utc)   # expire_stale compares with the real clock
        self._next = 1

    # -- helpers for tests ---------------------------------------------------
    def add_proposal(self, **kw) -> int:
        pid = self._next
        self._next += 1
        row = {"id": pid, "source_agent": "x", "kind": "catalog_kpi", "target": "t",
               "model_id": None, "dedup_key": f"k{pid}", "canonical_key": None,
               "need_id": None, "signals": [], "proposal": "p", "reason": None,
               "expected_outcome": None, "how_used": None, "worked_examples": [],
               "needs_enrichment": True, "evidence_count": 1, "first_seen": self.now,
               "last_seen": self.now, "status": "pending", "decided_at": None,
               "decided_by": None, "decision_note": None, "park_until": None,
               "park_min_evidence": None, "actioned_at": None, "action_detail": None,
               "issue_url": None, "payload": {}}
        row.update(kw)
        self.proposals[pid] = row
        return pid

    def events_for(self, pid: int) -> list[str]:
        return [e["event"] for e in self.events if e["proposal_id"] == pid]


class FakeCursor:
    def __init__(self, fdb: FakeDB, dict_rows: bool = False):
        self.db, self.dict_rows, self._r = fdb, dict_rows, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def fetchall(self):
        return list(self._r)

    def fetchone(self):
        return self._r[0] if self._r else None

    def execute(self, sql, p=()):  # noqa: C901 — one router, read top to bottom
        s = " ".join(sql.split())
        d = self.db
        P = d.proposals
        self._r = []

        # ---- proposal_events ----------------------------------------------
        if s.startswith("insert into proposal_events"):
            d.events.append(dict(zip(("proposal_id", "event", "from_status", "to_status",
                                      "actor", "detail"), p)))
        # ---- proposals ------------------------------------------------------
        elif s.startswith("select id, kind, target, proposal, payload, need_id, evidence_count, "
                          "status from proposals where canonical_key is null"):
            self._r = [(r["id"], r["kind"], r["target"], r["proposal"], r["payload"],
                        r["need_id"], r["evidence_count"], r["status"])
                       for r in sorted(P.values(), key=lambda r: r["id"])
                       if r["canonical_key"] is None]
        elif s.startswith("update proposals set canonical_key=%s"):
            key, nid, sigs, ev, pay, how, pid = p
            P[pid].update(canonical_key=key, need_id=nid, signals=_j(sigs),
                          evidence_count=ev, payload=_j(pay),
                          how_used=how if how is not None else P[pid]["how_used"])
        elif s.startswith("select id, status, canonical_key, evidence_count, signals, payload "
                          "from proposals where canonical_key = any(%s)"):
            keys = p[0]
            self._r = [(r["id"], r["status"], r["canonical_key"], r["evidence_count"],
                        r["signals"], r["payload"]) for r in P.values()
                       if r["canonical_key"] in keys]
        elif s.startswith("update proposals set signals = %s"):
            sigs, ev, pay, status, text, reason, pid = p
            r = P[pid]
            if r["status"] == "pending" and r["needs_enrichment"]:
                r["proposal"] = text
                r["reason"] = reason if reason is not None else r["reason"]
            r.update(signals=_j(sigs), evidence_count=ev, last_seen=d.now,
                     payload=_j(pay), status=status)
        elif s.startswith("insert into proposals"):
            cols = re.search(r"\(([^)]*)\) values", s).group(1).replace(" ", "").split(",")
            row = dict(zip(cols, p))
            for k in ("signals", "worked_examples", "payload"):
                row[k] = _j(row[k])
            if any(r["dedup_key"] == row["dedup_key"] for r in P.values()):
                raise AssertionError(f"unique violation on dedup_key {row['dedup_key']}")
            pid = d.add_proposal(**row)
            self._r = [(pid,)]
        elif s.startswith("select distinct canonical_key from proposals where kind=%s"):
            kind, statuses, need, _ = p
            self._r = sorted({(r["canonical_key"],) for r in P.values()
                              if r["kind"] == kind and r["status"] in statuses
                              and r["canonical_key"] and (need is None or r["need_id"] == need)})
        elif s.startswith("select status, kind from proposals where id=%s"):
            r = P.get(p[0])
            self._r = [(r["status"], r["kind"])] if r else []
        elif s.startswith("update proposals set status=%s, decided_at=now()"):
            status, by, note, until, min_ev, pid = p
            P[pid].update(status=status, decided_at=d.now, decided_by=by, decision_note=note,
                          park_until=until, park_min_evidence=min_ev)
        elif s.startswith("select kind, target, proposal, reason, expected_outcome"):
            r = P.get(p[0])
            self._r = [tuple(r[k] for k in ("kind", "target", "proposal", "reason",
                                            "expected_outcome", "worked_examples", "payload",
                                            "status", "how_used", "decision_note"))] if r else []
        elif s.startswith("update proposals set status=%s, actioned_at=now()"):
            status, detail, url, pid = p
            P[pid].update(status=status, actioned_at=d.now, action_detail=detail,
                          issue_url=url or P[pid]["issue_url"])
        elif s.startswith("select id, kind, target, payload, need_id, last_seen from proposals "
                          "where status='pending'"):
            self._r = [(r["id"], r["kind"], r["target"], r["payload"], r["need_id"],
                        r["last_seen"]) for r in P.values() if r["status"] == "pending"]
        elif s.startswith("update proposals set status='expired'"):
            why, pid = p
            if P[pid]["status"] == "pending":
                P[pid].update(status="expired", action_detail=why)
        elif s.startswith("update proposals set status='pending', park_until=null"):
            today = p[0]
            out = []
            for r in P.values():
                if r["status"] == "parked" and (
                        (r["park_until"] and r["park_until"] <= today)
                        or (r["park_min_evidence"] and r["evidence_count"] >= r["park_min_evidence"])):
                    r.update(status="pending", park_until=None, park_min_evidence=None,
                             last_seen=d.now)
                    out.append((r["id"], r["evidence_count"]))
            self._r = out
        elif s.startswith("select id, source_agent, kind, target, proposal, reason, payload "
                          "from proposals where needs_enrichment"):
            self._r = [(r["id"], r["source_agent"], r["kind"], r["target"], r["proposal"],
                        r["reason"], r["payload"]) for r in P.values()
                       if r["needs_enrichment"] and r["status"] in ("pending", "parked")][:p[0]]
        elif s.startswith("update proposals set proposal=coalesce(nullif(%s,''), proposal)"):
            text, reason, outcome, how, ex, needs, model, pay, pid = p
            r = P[pid]
            r.update(proposal=text or r["proposal"], reason=reason, expected_outcome=outcome,
                     how_used=how, worked_examples=_j(ex), needs_enrichment=needs,
                     model_id=r["model_id"] or model, payload=_j(pay))
        # ---- data_needs -----------------------------------------------------
        elif s == "select id from data_needs":
            self._r = [(k,) for k in d.needs]
        elif s == "select id, status from data_needs":
            self._r = [(k, v["status"]) for k, v in d.needs.items()]
        elif s.startswith("select id, status from data_needs where kind='sector_kpi'"):
            self._r = [(k, v["status"]) for k, v in d.needs.items() if v["kind"] == "sector_kpi"]
        elif s.startswith("select status from data_needs where id=%s"):
            n = d.needs.get(p[0])
            self._r = [(n["status"],)] if n else []
        elif s.startswith("select id, status, description, status_note from data_needs"):
            self._r = [(k, v["status"], v["description"], v["status_note"])
                       for k, v in d.needs.items() if k in p[0]]
        elif s.startswith("insert into data_needs"):
            row = dict(p)
            if row["id"] in d.needs:
                if "do nothing" not in s:
                    d.needs[row["id"]].update({k: row[k] for k in (
                        "kind", "market_scope", "description", "target_freq", "public_only")})
                self._r = []
            else:
                d.needs[row["id"]] = row
                self._r = [(row["id"],)]
        elif s.startswith("update data_needs set status='open'"):
            today = p[0]
            out = []
            for k, v in d.needs.items():
                pu = v.get("park_until")
                pu = datetime.fromisoformat(pu).date() if isinstance(pu, str) else pu
                if v["status"] == "parked" and pu and pu <= today:
                    v["status"] = "open"
                    out.append((k,))
            self._r = out
        elif s == "select * from data_needs":
            self._r = [dict(v) for v in d.needs.values()]
        # ---- metric_catalog -------------------------------------------------
        elif s == "select metric_code from metric_catalog":
            self._r = [(k,) for k in d.catalog]
        elif s.startswith("select metric_code from metric_catalog where metric_code=%s"):
            self._r = [(p[0],)] if p[0] in d.catalog else []
        elif s.startswith("insert into metric_catalog"):
            cols = ("metric_code", "label", "definition", "unit", "category", "applies_to",
                    "in_xbrl", "xbrl_tags", "source_if_not_xbrl", "importance", "notes")
            row = dict(zip(cols, p))
            row["xbrl_tags"] = _j(row["xbrl_tags"])
            if row["metric_code"] in d.catalog:
                assert "do nothing" in s, "a catalogue write must never update a curated row"
                self._r = []
            else:
                d.catalog[row["metric_code"]] = row
                self._r = [(row["metric_code"],)]
        elif s.startswith("update metric_catalog set notes = case"):
            extra, _, code = p
            r = d.catalog[code]
            r["notes"] = extra if not r.get("notes") else f"{r['notes']} | {extra}"
        # ---- data_sources ---------------------------------------------------
        elif s.startswith("insert into data_sources"):
            row = dict(p)
            if row["id"] not in d.sources:
                d.sources[row["id"]] = row
            elif "license=excluded.license" in s.replace(" ", ""):
                d.sources[row["id"]] = row          # authoritative: replace
            else:
                cur = d.sources[row["id"]]
                for k in ("coverage", "access_method", "endpoint", "sample_hint"):
                    if not cur.get(k):
                        cur[k] = row[k]
                assert "license=" not in s.split("do update set", 1)[1].replace(" ", ""), \
                    "a non-authoritative upsert must not write the licence"
        elif s.startswith("select * from data_sources where coalesce(status,'') <> 'invented'"):
            self._r = [dict(v) for v in d.sources.values() if v.get("status") != "invented"]
        # ---- sector research --------------------------------------------------
        elif s.startswith("select t.sub_sector, count(m.metric_code) as coverage"):
            rows = [(sub, sum(1 for m in d.catalog.values()
                              if sub.lower() in (m.get("applies_to") or "").lower()))
                    for sub in sorted(set(d.sub_sectors))]
            self._r = sorted(rows, key=lambda r: (r[1], r[0]))
        # ---- taxonomy_changes -------------------------------------------------
        elif s.startswith("insert into taxonomy_changes"):
            d.taxonomy.append({"sql": s, "params": p})
        elif s.startswith("select change from taxonomy_changes where kind='catalog_proposal'"):
            self._r = [(t["change"],) for t in d.taxonomy
                       if t.get("kind") == "catalog_proposal" and t.get("target") == p[0]]
        else:
            raise AssertionError(f"FakeDB does not know this statement: {s[:160]}")


class FakeConn:
    def __init__(self, fdb):
        self.db = fdb

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self, row_factory=None):
        return FakeCursor(self.db, dict_rows=row_factory is not None)

    def commit(self):
        pass

    def rollback(self):
        pass


def install(fdb: FakeDB | None = None, *, llm_reply=None) -> FakeDB:
    """Point engine.db at a fresh FakeDB, stub semantic memory, and either disable
    the LLM or answer every call with `llm_reply(role, system, user)`."""
    fdb = fdb or FakeDB()
    db.have_db = lambda: True
    db.connect = lambda: FakeConn(fdb)
    memory.capture = lambda *a, **k: None
    from engine import proposals
    proposals._BACKFILLED = False
    llm.LLM_ENABLED = llm_reply is not None

    def call(role, system, user, **kw):
        if llm_reply is None:
            raise AssertionError("no LLM call expected")
        return llm_reply(role, system, user), "fake:model"
    llm.call_with_model = call
    return fdb


def days_ago(fdb: FakeDB, n: int) -> datetime:
    return fdb.now - timedelta(days=n)
