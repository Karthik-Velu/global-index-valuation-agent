"""Tagging scope (D02): new securities daily + a rotating ~1/30 of tagged ones,
a wall-clock budget, and the GIVA_TAGGING=off kill switch. Fake DB and SEC
fetch — no network, no Postgres. Run: python tests/test_tagging.py
"""
from __future__ import annotations

import os
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
        if sql.startswith("select s.id, s.ticker, s.cik"):
            self._result = list(self.db.securities)
        elif sql.startswith("select sector, sub_sector from security_tags"):
            self._result = [self.db.tags[params[0]]] if params[0] in self.db.tags else []
        elif sql.startswith("insert into security_tags"):
            self.db.tags[params[0]] = (params[3], params[4])
            self.db.upserts.append(params[0])
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
    """securities rows arrive as the real query orders them: untagged first,
    then tagged oldest-refreshed first."""
    def __init__(self, n_untagged, n_tagged):
        self.securities = ([(i, f"NEW{i}", 1000 + i, False) for i in range(n_untagged)]
                           + [(100 + i, f"OLD{i}", 2000 + i, True) for i in range(n_tagged)])
        self.tags = {100 + i: ("Technology", "Software") for i in range(n_tagged)}
        self.upserts = []


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


def test_scope_new_plus_rotation():
    tagging._submission = lambda cik: {"sic": "7372", "sicDescription": "Prepackaged software"}
    db = FakeDB(n_untagged=3, n_tagged=90)
    st = run(db)
    assert st["scope"] == {"new": 3, "rotation": 3, "universe": 93}, st
    assert db.upserts == [0, 1, 2, 100, 101, 102], db.upserts   # new first, then oldest tagged
    assert st["tagged"] == 6 and st["changed"] == 3, st          # only the new ones are changes


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
