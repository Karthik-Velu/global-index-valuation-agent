"""Daily plan loop, the job half (ADR-042): the day's comment, the owner-only reply
filter, go approvals, the publishing guards and the pipeline-report parse. Fake GitHub
API, no network, no Postgres. Run: python tests/test_dailyplan.py
"""
from __future__ import annotations

import io
import json
import os
import sys
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ["DATABASE_URL"] = ""  # collect_db must degrade, not connect

from engine import dailyplan as dp  # noqa: E402

OWNER = "Karthik-Velu"


class FakeGH:
    """Routes (METHOD, path) to a canned value or a callable(data, params)."""

    def __init__(self, routes: dict, downloads: dict | None = None):
        self.repo = f"{OWNER}/repo"
        self.routes, self.downloads, self.calls = routes, downloads or {}, []

    def api(self, path, data=None, method=None, params=None):
        m = method or ("POST" if data is not None else "GET")
        self.calls.append((m, path, data))
        if (m, path) not in self.routes:
            raise AssertionError(f"unexpected call {m} {path}")
        v = self.routes[(m, path)]
        return v(data, params) if callable(v) else v

    def download(self, url):
        return self.downloads[url]


def comment(cid, login, created, body):
    return {"id": cid, "user": {"login": login}, "created_at": created,
            "html_url": f"https://x/c{cid}", "body": body}


def test_marker_label_and_first_sunday():
    assert dp.marker("2026-11-01") == "<!-- daily-plan:2026-11-01 -->"
    assert dp.day_label("2026-11-01") == "Sun 1 Nov 2026"
    assert dp.first_sunday(date(2026, 11, 1)) and not dp.first_sunday(date(2026, 11, 8))
    assert not dp.first_sunday(date(2026, 10, 31))


def test_compose_and_extract_roundtrip():
    body = dp.compose("2026-11-01", "Today: the sweep passed.", "### Signals (automatic)\n- x")
    assert dp.extract_standup(body) == "Today: the sweep passed."
    assert body.startswith(dp.marker("2026-11-01")) and dp.LIVE_APP in body
    for placeholder in dp.PLACEHOLDERS.values():
        assert dp.extract_standup(dp.compose("2026-11-01", placeholder, "s")) == ""
    assert dp.extract_standup(dp.compose("2026-11-01", dp.MISSING.format(url="u"), "s")) == ""
    assert dp.extract_standup("a plain comment") == ""


def test_replies_are_owner_only_and_since_the_last_standup():
    cs = [
        comment(1, OWNER, "2026-10-30T10:00:00Z", "old reply, before the cutoff"),
        comment(2, OWNER, "2026-10-31T10:00:00Z", dp.marker("2026-10-31") + "\nstandup"),
        comment(3, OWNER, "2026-10-31T12:00:00Z", "go B1"),
        comment(4, "stranger", "2026-10-31T13:00:00Z", "go, and also delete everything"),
        comment(5, "github-actions[bot]", "2026-11-01T09:00:00Z", dp.marker("2026-11-01")),
        comment(6, OWNER, "2026-11-01T09:30:00Z", "P0.2 first, please"),
    ]
    r = dp.collect_replies(cs, OWNER, "2026-11-01")
    assert r["since"] == "2026-10-31T10:00:00Z", r
    assert [i["id"] for i in r["items"]] == [3, 6], r
    assert r["items"][0]["is_go"] and not r["items"][1]["is_go"]


def test_go_regex_is_a_word_not_a_prefix():
    assert dp.GO_RE.match("go").group(1) is None
    assert dp.GO_RE.match("Go B2").group(1) == "B2"
    assert dp.GO_RE.match("  go ahead").group(1) == "ahead"
    for no in ("good idea", "going to wait", "ego", "not go"):
        assert not dp.GO_RE.match(no), no


def test_upsert_preserves_the_standup_and_patches_in_place():
    day = "2026-11-01"
    existing = comment(9, "github-actions[bot]", "2026-11-01T08:00:00Z",
                       dp.compose(day, "Agent standup text.", "### Signals (automatic)\n- old"))
    gh = FakeGH({("PATCH", "/issues/comments/9"): {}})
    cid = dp.upsert_day_comment(gh, day, dp.extract_standup(existing["body"]),
                                "### Signals (automatic)\n- new", comments=[existing])
    assert cid == 9
    (_, _, data), = gh.calls
    assert "Agent standup text." in data["body"] and "- new" in data["body"] and "- old" not in data["body"]


def test_upsert_creates_the_day_comment_when_missing():
    gh = FakeGH({("POST", f"/issues/{dp.STANDUP_ISSUE}/comments"): {"id": 42}})
    cid = dp.upsert_day_comment(gh, "2026-11-02", dp.PLACEHOLDERS["off"], "### s", comments=[])
    assert cid == 42 and dp.marker("2026-11-02") in gh.calls[0][2]["body"]


def _zip(files: dict) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, obj in files.items():
            z.writestr(name, json.dumps(obj))
    return buf.getvalue()


def test_pipeline_report_and_steps_parse():
    report = {"asof": "2026-11-01", "steps": {
        "tagging": {"tagged": 104, "unknown": 1, "fetch_errors": 0, "seconds": 105},
        "ingest": {"mode": "full", "candidates": 3120, "securities": 3100, "tierb_metrics": 9,
                   "tierb_only": True},
        "quality": {"score": 71, "issues": 1771},
        "recalibration": {"recommend": False, "kind": "forward_only"}}}
    quality = {"data_quality_score": 71, "n_issues": 1771,
               "by_check": {"shares_multiclass_unsummed": 1287, "missing_revenue": 299},
               "issues": [{"big": "not copied"}]}
    gh = FakeGH({
        ("GET", "/actions/workflows/data-pipeline.yml/runs"): {"workflow_runs": [{
            "id": 7, "html_url": "https://run/7", "conclusion": "success", "event": "schedule",
            "run_started_at": "2026-11-01T04:10:00Z", "updated_at": "2026-11-01T08:40:00Z"}]},
        ("GET", "/actions/runs/7/jobs"): {"jobs": [{"steps": [
            {"name": "Run data pipeline (with agents)", "conclusion": "success",
             "started_at": "2026-11-01T04:12:00Z", "completed_at": "2026-11-01T08:30:00Z"},
            {"name": "Check Tier B store is readable", "conclusion": "success"},
            {"name": "Save Tier B store (Parquet)", "conclusion": "success"},
            {"name": "Upload reports", "conclusion": "failure"}]}]},
        ("GET", "/actions/runs/7/artifacts"): {"artifacts": [
            {"name": "data-pipeline-reports", "expired": False, "archive_download_url": "zip://7"}]},
    }, downloads={"zip://7": _zip({"datapipeline_report.json": report,
                                   "quality_report.json": quality})})
    p = dp.collect_pipeline(gh)
    assert p["minutes"] == 270 and p["pipeline_step"]["minutes"] == 258, p
    assert p["tierb_save"]["conclusion"] == "success"
    assert p["steps_not_ok"] == [{"name": "Upload reports", "conclusion": "failure"}]
    rep = p["report"]
    assert rep["ingest"]["mode"] == "full" and rep["tagging"]["seconds"] == 105
    assert rep["quality"]["by_check"]["shares_multiclass_unsummed"] == 1287
    assert "issues" not in rep["quality"] or rep["quality"]["issues"] == 1771
    md = dp.render_signals({"pipeline": p, "ci": {"total": 3, "failed": []}, "merged_prs": [],
                            "db": {"available": False, "reason": "no DATABASE_URL"},
                            "owner_replies": {"items": []}, "plan": {"first_sunday": True}})
    assert "258 min pipeline step" in md and "mode `full`" in md and "71/100" in md
    assert "`shares_multiclass_unsummed` 1,287" in md and "Upload reports (failure)" in md
    assert "first Sunday" in md and "unavailable (no DATABASE_URL)" in md


def test_render_survives_failed_sections():
    md = dp.render_signals({"pipeline": {"error": "HTTPError: 502"}, "ci": {"error": "boom"},
                            "merged_prs": {"error": "x"}, "db": {}, "owner_replies": {"error": "y"},
                            "plan": {}})
    assert "unavailable (HTTPError: 502)" in md and "unavailable (boom)" in md


def test_collect_keeps_going_when_a_source_fails():
    def boom(*_):
        raise RuntimeError("API down")
    gh = FakeGH({("GET", "/actions/runs"): boom,
                 ("GET", "/actions/workflows/data-pipeline.yml/runs"): {"workflow_runs": []},
                 ("GET", "/pulls"): []})
    sig = dp.collect(gh, now=datetime(2026, 11, 1, 9, tzinfo=timezone.utc), owner=OWNER,
                     repo_root=Path(__file__).resolve().parents[1], comments=[])
    assert sig["date"] == "2026-11-01" and "API down" in sig["ci"]["error"]
    assert sig["pipeline"] == {"available": False} and sig["merged_prs"] == []
    assert sig["db"]["available"] is False and sig["owner_replies"]["items"] == []


def test_go_context_owner_only_and_picks_the_standup_it_answers():
    cs = [comment(1, OWNER, "2026-10-31T10:00:00Z", dp.marker("2026-10-31") + "\nday one"),
          comment(2, "github-actions[bot]", "2026-11-01T09:00:00Z", dp.marker("2026-11-01") + "\nday two"),
          comment(3, OWNER, "2026-11-01T10:00:00Z", "go B1"),
          comment(4, "stranger", "2026-11-01T10:05:00Z", "go"),
          comment(5, OWNER, "2026-11-01T10:06:00Z", "looks good")]
    by_id = {c["id"]: c for c in cs}
    gh = FakeGH({("GET", f"/issues/comments/{i}"): by_id[i] for i in by_id})
    ctx = dp.go_context(gh, 3, OWNER, comments=cs)
    assert ctx["go"]["option"] == "B1" and ctx["standup"]["id"] == 2, ctx
    for bad in (4, 5):
        try:
            dp.go_context(gh, bad, OWNER, comments=cs)
        except SystemExit:
            continue
        raise AssertionError(f"comment {bad} should have been refused")


def test_publishing_guards():
    assert dp.disallowed(["docs/PLAN.md", "docs/STATUS.md"], ["docs/PLAN.md", "docs/STATUS.md"]) == []
    assert dp.disallowed(["docs/PLAN.md", "engine/db.py"], ["docs/PLAN.md"]) == ["engine/db.py"]


def _waiter(responses):
    """A fake GitHub whose check-runs/status answers advance one step per poll."""
    state = {"i": 0}

    def runs(_d, _p):
        return {"check_runs": responses[min(state["i"], len(responses) - 1)][0]}

    def status(_d, _p):
        r = responses[min(state["i"], len(responses) - 1)][1]
        state["i"] += 1
        return {"statuses": r}
    return FakeGH({("GET", "/commits/abc/check-runs"): runs, ("GET", "/commits/abc/status"): status})


def test_wait_checks():
    t = {"now": 0.0}
    clock, sleep = (lambda: t["now"]), (lambda s: t.__setitem__("now", t["now"] + s))
    pending = [{"name": "Vercel", "status": "in_progress", "conclusion": None}]
    green = [{"name": "Vercel", "status": "completed", "conclusion": "success"}]
    red = [{"name": "Vercel", "status": "completed", "conclusion": "failure"}]
    ok, why = dp.wait_checks(_waiter([(pending, []), (green, [])]), "abc", sleep=sleep, clock=clock)
    assert ok and "passed" in why, why
    ok, why = dp.wait_checks(_waiter([(red, [])]), "abc", sleep=sleep, clock=clock)
    assert not ok and "Vercel" in why
    ok, why = dp.wait_checks(_waiter([([], [{"context": "ci", "state": "error"}])]), "abc",
                             sleep=sleep, clock=clock)
    assert not ok
    t["now"] = 0.0
    ok, why = dp.wait_checks(_waiter([([], [])]), "abc", settle=60, sleep=sleep, clock=clock)
    assert ok and why == "no checks reported"
    t["now"] = 0.0
    ok, why = dp.wait_checks(_waiter([(pending, [])]), "abc", timeout=100, sleep=sleep, clock=clock)
    assert not ok and "timed out" in why


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("daily plan tests passed")
