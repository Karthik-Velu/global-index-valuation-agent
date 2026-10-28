"""Tagging scope (D02): new securities daily + a rotating ~1/30 of tagged ones,
a wall-clock budget, and the GIVA_TAGGING=off kill switch. Fake DB and SEC
fetch — no network, no Postgres. Run: python tests/test_tagging.py
"""
from __future__ import annotations

import itertools
import os
import random
import sys
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# engine.db / engine.sources.edgar pull in psycopg and friends; the tagging
# logic under test needs neither, so stub them before import.
for name, attrs in {"engine.db": {"connect": None},
                    "engine.sources.edgar": {"_headers": lambda: {}}}.items():
    mod = types.ModuleType(name)
    mod.__dict__.update(attrs)
    sys.modules.setdefault(name, mod)

from engine.sectoragent import tagging  # noqa: E402


class FakeCursor:
    def __init__(self, db):
        self.db, self._result = db, []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql, params=None):
        sql = " ".join(sql.split())
        db = self.db
        if sql.startswith("select s.id, s.ticker, s.cik"):
            # The real query has no ORDER BY: rows arrive in any order.
            rows = [(i, t, c, i in db.tags, db.stamp.get(i)) for i, t, c in db.securities]
            db.rng.shuffle(rows)
            self._result = rows
        elif sql.startswith("select t.security_id, s.ticker, t.sic_code"):
            tick = {i: t for i, t, _ in db.securities}
            self._result = [(i, tick[i], db.sic.get(i), "desc", sec, sub)
                            for i, (sec, sub) in db.tags.items()]
        elif sql.startswith("select sector, sub_sector from security_tags"):
            self._result = [db.tags[params[0]]] if params[0] in db.tags else []
        elif sql.startswith("insert into security_tags"):
            db.tags[params[0]] = (params[3], params[4])
            db.sic[params[0]] = params[1]
            if "updated_ts=now()" in sql.replace(" ", ""):   # rotation depends on it
                db.stamp[params[0]] = next(db.clock)
            db.upserts.append(params[0])
        elif sql.startswith("update security_tags set sector"):
            db.tags[params[3]] = (params[0], params[1])
            db.reclassified.append(params[3])
        # update securities / insert taxonomy_changes: no state needed

    def fetchall(self):
        return self._result

    def fetchone(self):
        return self._result[0] if self._result else None


class FakeConn:
    def __init__(self, db):
        self.db = db

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return FakeCursor(self.db)

    def commit(self):
        pass


class FakeDB:
    """Untagged ids 0.., tagged ids 100.. whose stamps rise with the id, so the
    least-recently-refreshed tagged security is id 100."""
    def __init__(self, n_untagged, n_tagged, seed=7):
        self.securities = ([(i, f"NEW{i}", 1000 + i) for i in range(n_untagged)]
                           + [(100 + i, f"OLD{i}", 2000 + i) for i in range(n_tagged)])
        self.tags = {100 + i: tagging.sic_map.classify("7372") for i in range(n_tagged)}
        self.sic = {100 + i: "7372" for i in range(n_tagged)}
        self.stamp = {100 + i: i for i in range(n_tagged)}
        self.clock = itertools.count(10_000)
        self.rng = random.Random(seed)
        self.upserts, self.reclassified = [], []


def run(db, **env):
    saved = {k: os.environ.get(k) for k in ("GIVA_TAGGING", "TAGGING_BUDGET_MIN")}
    try:
        for k in saved:
            os.environ.pop(k, None)
        os.environ.update(env)
        tagging.db.connect = lambda: FakeConn(db)
        return tagging.tag_securities(sleep=0)
    finally:
        for k, v in saved.items():
            os.environ.pop(k, None)
            if v is not None:
                os.environ[k] = v


def test_select_batch():
    batch, n = tagging.select_batch(["n1", "n2"], [f"t{i}" for i in range(3120)])
    assert n == 104, n                                  # ceil(3120 / 30)
    assert batch[:2] == ["n1", "n2"] and batch[2] == "t0" and batch[-1] == "t103"
    assert len(batch) == 106
    assert tagging.select_batch([], [])[0] == []
    assert tagging.select_batch([], ["a"])[1] == 1      # a lone tagged name still rotates


def _sw(cik):
    return {"sic": "7372", "sicDescription": "Prepackaged software"}


def test_scope_new_plus_rotation():
    tagging._submission = _sw
    db = FakeDB(n_untagged=3, n_tagged=90)
    st = run(db)
    assert st["scope"] == {"new": 3, "rotation": 3, "universe": 93}, st
    assert db.upserts == [0, 1, 2, 100, 101, 102], db.upserts   # new first, then oldest tagged
    assert st["tagged"] == 6 and st["changed"] == 3, st          # only the new ones are changes
    assert st["reclassified"] == 0, st


def test_full_rotation_in_30_runs():
    tagging._submission = _sw
    db = FakeDB(n_untagged=0, n_tagged=90)
    for _ in range(30):
        run(db)
    assert sorted(db.upserts) == list(range(100, 190)), db.upserts   # each exactly once
    first = db.upserts[:3]
    db.upserts.clear()
    run(db)
    assert db.upserts == first, (db.upserts, first)                  # cycle restarts


def test_sic_map_change_reaches_every_tag_without_sec_calls():
    db = FakeDB(n_untagged=0, n_tagged=60)
    db.tags[105] = ("Healthcare", "Medical Devices")                  # stale mapping
    db.sic[105] = "3812"
    calls = []
    tagging._submission = lambda cik: calls.append(cik) or _sw(cik)
    st = run(db)
    assert st["reclassified"] == 1 and db.reclassified == [105], (st, db.reclassified)
    assert db.tags[105][0] == tagging.sic_map.classify("3812")[0] != "Healthcare", db.tags[105]
    assert 2005 not in calls, calls                                  # fixed without a fetch


def test_fetch_failure_keeps_its_place():
    calls = []

    def flaky(cik):
        calls.append(cik)
        return None if cik == 2000 else {"sic": "7372", "sicDescription": "x"}
    tagging._submission = flaky
    db = FakeDB(n_untagged=0, n_tagged=60)
    st = run(db)
    assert 100 not in db.upserts and 101 in db.upserts, db.upserts  # no upsert -> stamp unchanged
    assert st["tagged"] == 1, st


def test_kill_switch():
    db = FakeDB(n_untagged=5, n_tagged=30)
    st = run(db, GIVA_TAGGING="off")
    assert st.get("skipped") == "GIVA_TAGGING=off" and db.upserts == [], st


def test_budget_stops_cleanly():
    tagging._submission = lambda cik: {"sic": "7372", "sicDescription": "x"}
    db = FakeDB(n_untagged=4, n_tagged=0)
    clock = iter([0.0, 0.0, 30.0, 61.0, 61.0, 61.0, 61.0])
    real = tagging.time.monotonic
    tagging.time.monotonic = lambda: next(clock)
    try:
        st = run(db, TAGGING_BUDGET_MIN="1")
    finally:
        tagging.time.monotonic = real
    assert st.get("budget_stopped") is True and st["not_reached"] == 2, st
    assert db.upserts == [0, 1], db.upserts


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("tagging tests passed")
