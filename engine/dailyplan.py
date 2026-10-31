"""Daily plan loop, the job half: deterministic, no LLM (ADR-042).

`.github/workflows/daily-plan.yml` runs this after each data pipeline run on main, with
a fallback in the evening. It gathers the day's signals (CI runs, the pipeline report,
the latest backtest, proposal counts, merged PRs, the owner's replies in the standup
issue) and keeps ONE comment per day in the pinned standup issue current. That comment
is written even when the agent half (claude-code-action on the owner's subscription) is
off or fails, so there is an update every day.

The agent half reads `.daily-plan/signals.json`, edits docs/PLAN.md and writes
`.daily-plan/standup.md`; `standup` below then puts the standup into the day's comment.
Every GitHub write goes through this module, never through the agent.

Public by construction: the repo and the standup issue are public, and anything the
agent reads can end up in public text. So only non-sensitive fields are collected:
counts, ids, kinds and targets from the admin console (never decision notes or
payloads), and no prices.

    python -m engine.dailyplan signals [--out .daily-plan/signals.json]
    python -m engine.dailyplan standup .daily-plan/signals.json .daily-plan/standup.md
    python -m engine.dailyplan agent-missing .daily-plan/signals.json --run-url URL [--reason-file F]
    python -m engine.dailyplan agent-error EXECUTION_FILE [--out .daily-plan/agent_error.txt]
    python -m engine.dailyplan go-context COMMENT_ID [--out .daily-plan/go_context.json]
    python -m engine.dailyplan check-paths CHANGED_LIST --allow docs/PLAN.md ...
    python -m engine.dailyplan touches CHANGED_LIST .github/workflows/
    python -m engine.dailyplan wait-checks SHA [--timeout 900]
"""
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import zipfile
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

DEFAULT_REPO = "Karthik-Velu/global-index-valuation-agent"
STANDUP_ISSUE = int(os.getenv("DAILY_PLAN_ISSUE", "58"))
LIVE_APP = "https://global-index-valuation-agent.vercel.app"
PIPELINE_WORKFLOW = "data-pipeline.yml"
PIPELINE_ARTIFACT = "data-pipeline-reports"
LOOKBACK_HOURS = 30  # a little over a day, so a pipeline that ran late still counts

MARKER_RE = re.compile(r"<!-- daily-plan:(\d{4}-\d{2}-\d{2}) -->")
STANDUP_START, STANDUP_END = "<!-- standup:start -->", "<!-- standup:end -->"
GO_RE = re.compile(r"^\s*go\b(?:[ \t]+(\S+))?", re.IGNORECASE)

PLACEHOLDERS = {
    "pending": "_The planning agent is writing today's standup; it appears here when it "
               "finishes. The signals below are automatic._",
    "off": "_The planning agent is off. Add the `CLAUDE_CODE_OAUTH_TOKEN` repo secret to "
           "turn it on (ADR-042). The signals below are automatic._",
}
MISSING = ("_The planning agent didn't finish today ([run]({url})){reason}. "
           "The signals below are current._")
# Anything shaped like a credential is redacted before an error reaches a public log.
TOKEN_RE = re.compile(r"(sk-ant-[A-Za-z0-9_-]{6,}|gh[opsu]_[A-Za-z0-9]{12,}|Bearer\s+\S+)")
BAD_CONCLUSIONS = {"failure", "timed_out", "cancelled", "action_required", "startup_failure", "stale"}


# --------------------------------------------------------------------------- #
# GitHub
# --------------------------------------------------------------------------- #

class GitHub:
    """Thin REST client. Tests pass a fake with the same `api` / `download` methods.

    `requests` (not urllib) because artifact downloads redirect to blob storage, and
    requests drops the Authorization header on that cross-host hop; urllib forwards it
    and the blob store rejects the request.
    """

    def __init__(self, repo: str | None = None, token: str | None = None):
        import requests

        self.repo = repo or os.getenv("GITHUB_REPOSITORY") or DEFAULT_REPO
        token = (token if token is not None else os.getenv("GITHUB_TOKEN", "")).strip()
        if not token:
            raise RuntimeError("no GITHUB_TOKEN")
        self._s = requests.Session()
        self._s.headers.update({"Authorization": f"Bearer {token}",
                                "Accept": "application/vnd.github+json",
                                "X-GitHub-Api-Version": "2022-11-28",
                                "User-Agent": "giva-dailyplan"})

    def api(self, path: str, data: dict | None = None, method: str | None = None,
            params: dict | None = None) -> dict | list:
        url = path if path.startswith("http") else f"https://api.github.com/repos/{self.repo}{path}"
        r = self._s.request(method or ("POST" if data is not None else "GET"), url,
                            json=data, params=params, timeout=45)
        r.raise_for_status()
        return r.json() if r.content else {}

    def download(self, url: str) -> bytes:
        r = self._s.get(url, timeout=120)
        r.raise_for_status()
        return r.content


def _issue_comments(gh) -> list[dict]:
    """Every comment on the standup issue, oldest first (paginated)."""
    out, page = [], 1
    while True:
        batch = gh.api(f"/issues/{STANDUP_ISSUE}/comments", params={"per_page": 100, "page": page})
        out.extend(batch)
        if len(batch) < 100:
            return out
        page += 1


# --------------------------------------------------------------------------- #
# The day's comment
# --------------------------------------------------------------------------- #

def marker(day: str) -> str:
    return f"<!-- daily-plan:{day} -->"


def day_label(day: str) -> str:
    d = date.fromisoformat(day)
    return f"{d:%a} {d.day} {d:%b %Y}"


def first_sunday(d: date) -> bool:
    """The data pipeline's monthly full sweep runs on the first Sunday."""
    return d.weekday() == 6 and d.day <= 7


def extract_standup(body: str | None) -> str:
    """The agent-written block of a day's comment, or "" if absent or a placeholder."""
    body = body or ""
    if STANDUP_START not in body or STANDUP_END not in body:
        return ""
    text = body.split(STANDUP_START, 1)[1].split(STANDUP_END, 1)[0].strip()
    if text in PLACEHOLDERS.values() or (text.startswith("_The planning agent didn't finish")):
        return ""
    return text


def compose(day: str, standup: str, signals_md: str) -> str:
    return "\n".join([marker(day), f"## {day_label(day)}", "", STANDUP_START, standup.strip(),
                      STANDUP_END, "", signals_md.strip(), "", f"Live app: {LIVE_APP}", ""])


def find_day_comment(comments: list[dict], day: str) -> dict | None:
    m = marker(day)
    return next((c for c in comments if m in (c.get("body") or "")), None)


def upsert_day_comment(gh, day: str, standup: str, signals_md: str,
                       comments: list[dict] | None = None) -> int:
    comments = _issue_comments(gh) if comments is None else comments
    body = compose(day, standup, signals_md)
    existing = find_day_comment(comments, day)
    if existing:
        gh.api(f"/issues/comments/{existing['id']}", {"body": body}, method="PATCH")
        return existing["id"]
    return gh.api(f"/issues/{STANDUP_ISSUE}/comments", {"body": body})["id"]


# --------------------------------------------------------------------------- #
# Signals
# --------------------------------------------------------------------------- #

def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse(ts: str | None) -> datetime | None:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def _pick(d: dict | None, *keys: str) -> dict:
    return {k: (d or {}).get(k) for k in keys}


def collect_ci(gh, now: datetime) -> dict:
    since = now - timedelta(hours=LOOKBACK_HOURS)
    runs = []
    for r in gh.api("/actions/runs", params={"created": f">={_iso(since)}", "per_page": 100}
                    ).get("workflow_runs", []):
        runs.append({"workflow": r.get("name"), "event": r.get("event"),
                     "branch": r.get("head_branch"), "status": r.get("status"),
                     "conclusion": r.get("conclusion"), "created_at": r.get("created_at"),
                     "url": r.get("html_url")})
    failed = [r for r in runs if r["conclusion"] in BAD_CONCLUSIONS - {"cancelled"}]
    return {"since": _iso(since), "total": len(runs), "failed": failed, "runs": runs}


def _step(steps: list[dict], prefix: str) -> dict | None:
    s = next((s for s in steps if (s.get("name") or "").startswith(prefix)), None)
    if not s:
        return None
    a, b = _parse(s.get("started_at")), _parse(s.get("completed_at"))
    return {"conclusion": s.get("conclusion"),
            "minutes": round((b - a).total_seconds() / 60) if a and b else None}


def _pipeline_report(gh, run_id: int) -> dict | None:
    arts = gh.api(f"/actions/runs/{run_id}/artifacts").get("artifacts", [])
    art = next((a for a in arts if a.get("name") == PIPELINE_ARTIFACT and not a.get("expired")), None)
    if not art:
        return None
    z = zipfile.ZipFile(io.BytesIO(gh.download(art["archive_download_url"])))

    def load(name: str) -> dict:
        n = next((x for x in z.namelist() if x.endswith(name)), None)
        return json.loads(z.read(n)) if n else {}

    dp, q = load("datapipeline_report.json"), load("quality_report.json")
    steps = dp.get("steps", {})
    return {"asof": dp.get("asof"),
            "tagging": _pick(steps.get("tagging"), "tagged", "unknown", "fetch_errors", "seconds"),
            "ingest": _pick(steps.get("ingest"), "mode", "candidates", "securities",
                            "tierb_metrics", "tierb_only"),
            "quality": {"score": q.get("data_quality_score", (steps.get("quality") or {}).get("score")),
                        "issues": q.get("n_issues", (steps.get("quality") or {}).get("issues")),
                        "by_check": q.get("by_check")},
            "recalibration": _pick(steps.get("recalibration"), "recommend", "kind")}


def collect_pipeline(gh) -> dict:
    runs = gh.api(f"/actions/workflows/{PIPELINE_WORKFLOW}/runs",
                  params={"branch": "main", "status": "completed", "per_page": 1}
                  ).get("workflow_runs", [])
    if not runs:
        return {"available": False}
    r = runs[0]
    out = {"available": True, "run_id": r["id"], "url": r.get("html_url"),
           "conclusion": r.get("conclusion"), "event": r.get("event"),
           "started_at": r.get("run_started_at") or r.get("created_at"),
           "updated_at": r.get("updated_at")}
    a, b = _parse(out["started_at"]), _parse(out["updated_at"])
    out["minutes"] = round((b - a).total_seconds() / 60) if a and b else None
    jobs = gh.api(f"/actions/runs/{r['id']}/jobs", params={"per_page": 50}).get("jobs", [])
    steps = [s for j in jobs for s in j.get("steps", [])]
    out["pipeline_step"] = _step(steps, "Run data pipeline")
    out["tierb_readable"] = _step(steps, "Check Tier B store is readable")
    out["tierb_save"] = _step(steps, "Save Tier B store")
    out["steps_not_ok"] = [{"name": s.get("name"), "conclusion": s.get("conclusion")}
                           for s in steps if s.get("conclusion") in BAD_CONCLUSIONS]
    out["report"] = _pipeline_report(gh, r["id"])
    return out


def collect_merged_prs(gh, now: datetime) -> list[dict]:
    since = now - timedelta(hours=LOOKBACK_HOURS)
    prs = gh.api("/pulls", params={"state": "closed", "sort": "updated",
                                   "direction": "desc", "per_page": 30})
    return [{"number": p["number"], "title": p["title"], "url": p["html_url"],
             "merged_at": p["merged_at"]}
            for p in prs if p.get("merged_at") and _parse(p["merged_at"]) >= since]


def collect_replies(comments: list[dict], owner: str, today: str) -> dict:
    """The owner's comments since the previous day's standup. Nobody else's text is
    passed on: the issue is public, and the agent must never take instructions from it."""
    prev = [c["created_at"] for c in comments
            if (m := MARKER_RE.search(c.get("body") or "")) and m.group(1) != today]
    cutoff = max(prev, default=None)
    items = []
    for c in comments:
        body = c.get("body") or ""
        if ((c.get("user") or {}).get("login", "").lower() != owner.lower()
                or MARKER_RE.search(body)
                or (cutoff and c["created_at"] <= cutoff)):
            continue
        items.append({"id": c["id"], "created_at": c["created_at"], "url": c.get("html_url"),
                      "is_go": bool(GO_RE.match(body)), "body": body[:4000]})
    return {"since": cutoff, "items": items}


def collect_db() -> dict:
    """Read-only, non-sensitive Postgres signals: the latest backtest + proposal counts."""
    try:
        from . import db
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": f"engine.db import failed: {e}"}
    if not db.have_db():
        return {"available": False, "reason": "no DATABASE_URL"}
    out: dict = {"available": True}
    try:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select id, ts, status, window_start, window_end, note "
                        "from backtest_runs order by id desc limit 1")
            row = cur.fetchone()
            if row:
                out["backtest"] = {"id": row[0], "ts": row[1].isoformat() if row[1] else None,
                                   "status": row[2], "window": [str(row[3]), str(row[4])],
                                   "note": (row[5] or "")[:300]}
            cur.execute("select status, count(*) from proposals group by status")
            out["proposals_by_status"] = {s: n for s, n in cur.fetchall()}
            cur.execute("select id, kind, target, status, decided_at from proposals "
                        "where decided_at >= now() - interval '30 hours' "
                        "order by decided_at desc limit 20")
            out["proposals_decided"] = [
                {"id": i, "kind": k, "target": t, "status": s,
                 "decided_at": d.isoformat() if d else None} for i, k, t, s, d in cur.fetchall()]
    except Exception as e:  # noqa: BLE001
        return {"available": False, "reason": f"{type(e).__name__}: {str(e)[:160]}"}
    return out


def plan_meta(today: str, repo_root: str | Path = ".") -> dict:
    try:
        text = Path(repo_root, "docs/PLAN.md").read_text()
    except OSError:
        text = ""
    return {"has_today_entry": f"### {today}" in text,
            "first_sunday": first_sunday(date.fromisoformat(today))}


def collect(gh, now: datetime | None = None, owner: str | None = None,
            repo_root: str | Path = ".", comments: list[dict] | None = None) -> dict:
    """Every section is best-effort: one failing source must not cost the day's update."""
    now = now or datetime.now(timezone.utc)
    today = now.date().isoformat()
    owner = owner or os.getenv("DAILY_PLAN_OWNER") or gh.repo.split("/")[0]
    sig: dict = {"generated_at": _iso(now), "date": today, "repo": gh.repo,
                 "standup_issue": STANDUP_ISSUE, "owner": owner}

    def guard(fn):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            return {"error": f"{type(e).__name__}: {str(e)[:200]}"}

    if comments is None:
        comments = guard(lambda: _issue_comments(gh))
    sig["ci"] = guard(lambda: collect_ci(gh, now))
    sig["pipeline"] = guard(lambda: collect_pipeline(gh))
    sig["merged_prs"] = guard(lambda: collect_merged_prs(gh, now))
    sig["owner_replies"] = (comments if isinstance(comments, dict)
                            else guard(lambda: collect_replies(comments, owner, today)))
    sig["db"] = collect_db()
    sig["plan"] = plan_meta(today, repo_root)
    return sig


# --------------------------------------------------------------------------- #
# Rendering
# --------------------------------------------------------------------------- #

def _err(section) -> str | None:
    return section.get("error") if isinstance(section, dict) else None


def render_signals(sig: dict) -> str:
    L = ["### Signals (automatic)"]
    p = sig.get("pipeline") or {}
    if _err(p):
        L.append(f"- **Data pipeline:** unavailable ({_err(p)})")
    elif not p.get("available"):
        L.append("- **Data pipeline:** no completed run on main found")
    else:
        rep = p.get("report") or {}
        ing, tag = rep.get("ingest") or {}, rep.get("tagging") or {}
        step = p.get("pipeline_step") or {}
        took = (f"{step['minutes']} min pipeline step" if step.get("minutes") is not None
                else f"{p.get('minutes')} min run")
        L.append(f"- **Data pipeline:** {p.get('conclusion')} ([run]({p.get('url')}), "
                 f"started {(p.get('started_at') or '')[:16].replace('T', ' ')} UTC, "
                 f"{took}, mode `{ing.get('mode', '?')}`)")
        save, readable = p.get("tierb_save") or {}, p.get("tierb_readable") or {}
        if save or readable:
            L.append(f"  - Tier B: readable check {readable.get('conclusion', 'n/a')}, "
                     f"save {save.get('conclusion', 'n/a')}")
        if p.get("steps_not_ok"):
            L.append("  - Steps not OK: " + ", ".join(f"{s['name']} ({s['conclusion']})"
                                                      for s in p["steps_not_ok"]))
        if tag:
            L.append(f"  - Tagging: {tag.get('tagged')} tagged in {tag.get('seconds')} s, "
                     f"{tag.get('fetch_errors')} fetch errors")
        q = rep.get("quality") or {}
        if q.get("score") is not None:
            top = sorted((q.get("by_check") or {}).items(), key=lambda kv: -kv[1])[:3]
            tops = ", ".join(f"`{k}` {v:,}" for k, v in top)
            L.append(f"  - Data quality: {q['score']}/100, {q.get('issues', 0):,} issues"
                     + (f" (top: {tops})" if tops else ""))
        rc = rep.get("recalibration") or {}
        if rc.get("kind"):
            L.append(f"  - Recalibration: `{rc['kind']}`")
    ci = sig.get("ci") or {}
    if _err(ci):
        L.append(f"- **CI, last {LOOKBACK_HOURS} h:** unavailable ({_err(ci)})")
    else:
        failed, total = ci.get("failed") or [], ci.get("total", 0)
        L.append(f"- **CI, last {LOOKBACK_HOURS} h:** {total} run{'' if total == 1 else 's'}, "
                 f"{len(failed)} failed"
                 + ("".join(f"\n  - [{f['workflow']}]({f['url']}): {f['conclusion']}"
                            for f in failed[:8])))
    prs = sig.get("merged_prs")
    if isinstance(prs, list):
        L.append(f"- **Merged PRs:** " + (", ".join(f"[#{x['number']}]({x['url']}) {x['title']}"
                                                   for x in prs) or "none"))
    d = sig.get("db") or {}
    if not d.get("available"):
        L.append(f"- **Database signals:** unavailable ({d.get('reason', 'unknown')})")
    else:
        bt = d.get("backtest")
        if bt:
            L.append(f"- **Latest backtest:** id {bt['id']}, {(bt.get('ts') or '')[:10]}, "
                     f"`{bt.get('status')}`")
        by = d.get("proposals_by_status") or {}
        L.append(f"- **Console proposals:** {by.get('pending', 0)} pending, "
                 f"{len(d.get('proposals_decided') or [])} decided in the last {LOOKBACK_HOURS} h")
    rp = sig.get("owner_replies") or {}
    if not _err(rp):
        n = len(rp.get("items") or [])
        L.append(f"- **Your replies since the last standup:** {n}")
    if (sig.get("plan") or {}).get("first_sunday"):
        L.append("- Today is the first Sunday: the monthly full sweep day.")
    return "\n".join(L)


# --------------------------------------------------------------------------- #
# go: the owner's approval comment
# --------------------------------------------------------------------------- #

def go_context(gh, comment_id: int, owner: str, comments: list[dict] | None = None) -> dict:
    c = gh.api(f"/issues/comments/{comment_id}")
    login = (c.get("user") or {}).get("login", "")
    if login.lower() != owner.lower():
        raise SystemExit(f"comment {comment_id} is by {login}, not the owner")
    body = c.get("body") or ""
    m = GO_RE.match(body)
    if not m:
        raise SystemExit(f"comment {comment_id} is not a `go`")
    comments = _issue_comments(gh) if comments is None else comments
    standups = [x for x in comments
                if MARKER_RE.search(x.get("body") or "") and x["created_at"] <= c["created_at"]]
    s = standups[-1] if standups else None
    return {"go": {"id": c["id"], "url": c.get("html_url"), "created_at": c["created_at"],
                   "option": m.group(1), "body": body[:4000]},
            "standup": ({"id": s["id"], "url": s.get("html_url"), "body": s["body"][:20000]}
                        if s else None)}


# --------------------------------------------------------------------------- #
# Publishing guards
# --------------------------------------------------------------------------- #

def read_paths(list_file: str) -> list[str]:
    return [ln.strip() for ln in Path(list_file).read_text().splitlines() if ln.strip()]


def disallowed(paths: list[str], allow: list[str]) -> list[str]:
    return [p for p in paths if p not in set(allow)]


def agent_error(exec_file: str | Path) -> str:
    """Why the agent failed, from claude-code-action's execution file (redacted, short).

    The action keeps Claude's output out of the log unless show_full_output is on, which
    would publish the whole conversation in a public repo; this pulls out only the final
    result's error text, so a failure says why (auth, usage limit, refused output).
    """
    try:
        data = json.loads(Path(exec_file).read_text())
    except (OSError, ValueError):
        return "no execution log was written (the agent may not have started)"
    msgs = data if isinstance(data, list) else data.get("messages", [data])
    res = next((m for m in reversed(msgs) if isinstance(m, dict) and m.get("type") == "result"), None)
    if res is None:
        return "the execution log has no result"
    if not res.get("is_error"):
        return "the agent finished, but its output was refused (see the run log)"
    text = res.get("result") or res.get("error") or ", ".join(map(str, res.get("errors") or [])) \
        or res.get("subtype") or "unknown error"
    return TOKEN_RE.sub("[redacted]", " ".join(str(text).split()))[:300]


def wait_checks(gh, sha: str, timeout: float = 900, settle: float = 180, interval: float = 20,
                sleep=time.sleep, clock=time.monotonic) -> tuple[bool, str]:
    """Wait for the commit's checks. Pass when every check has finished green; fail on
    any red; pass after `settle` seconds if no check ever appears (nothing to wait for)."""
    start = clock()
    while True:
        runs = gh.api(f"/commits/{sha}/check-runs", params={"per_page": 100}).get("check_runs", [])
        statuses = gh.api(f"/commits/{sha}/status").get("statuses", [])
        failed = ([r["name"] for r in runs if r.get("conclusion") in BAD_CONCLUSIONS]
                  + [s["context"] for s in statuses if s.get("state") in ("failure", "error")])
        pending = ([r["name"] for r in runs if r.get("status") != "completed"]
                   + [s["context"] for s in statuses if s.get("state") == "pending"])
        seen = len(runs) + len(statuses)
        if failed:
            return False, "failed: " + ", ".join(failed)
        if seen and not pending:
            return True, f"{seen} check(s) passed"
        elapsed = clock() - start
        if not seen and elapsed >= settle:
            return True, "no checks reported"
        if elapsed >= timeout:
            return False, "timed out waiting for: " + (", ".join(pending) or "checks")
        sleep(interval)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #

def _output(**kv) -> None:
    """Write step outputs for GitHub Actions (no-op locally)."""
    path = os.getenv("GITHUB_OUTPUT")
    if path:
        with open(path, "a") as f:
            for k, v in kv.items():
                f.write(f"{k}={v}\n")


def _cmd_signals(a) -> None:
    gh = GitHub()
    comments = _issue_comments(gh)
    sig = collect(gh, comments=comments)
    day = sig["date"]
    has_token = os.getenv("HAS_AGENT_TOKEN", "").lower() == "true"
    event = os.getenv("GITHUB_EVENT_NAME", "workflow_dispatch")
    existing = find_day_comment(comments, day)
    standup = extract_standup(existing.get("body") if existing else "")
    # At most one automatic agent run a day (it spends the owner's allowance); a manual
    # dispatch always runs it.
    run_agent = has_token and (event in ("workflow_dispatch", "push") or not standup)
    if not standup:  # here run_agent is simply "is the agent switched on"
        standup = PLACEHOLDERS["pending" if run_agent else "off"]
    sig["run_agent"] = run_agent
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(sig, indent=2, default=str))
    cid = upsert_day_comment(gh, day, standup, render_signals(sig), comments=comments)
    _output(date=day, run_agent=str(run_agent).lower(), comment_id=cid)
    print(f"daily plan {day}: signals posted to #{STANDUP_ISSUE} (comment {cid}); "
          f"run_agent={run_agent}")


def _cmd_standup(a) -> None:
    gh = GitHub()
    sig = json.loads(Path(a.signals).read_text())
    standup = Path(a.standup).read_text().strip() if Path(a.standup).exists() else ""
    if not standup:
        raise SystemExit("standup file missing or empty")
    cid = upsert_day_comment(gh, sig["date"], standup, render_signals(sig))
    print(f"standup posted to #{STANDUP_ISSUE} (comment {cid})")


def _cmd_agent_missing(a) -> None:
    gh = GitHub()
    sig = json.loads(Path(a.signals).read_text())
    comments = _issue_comments(gh)
    existing = find_day_comment(comments, sig["date"])
    if existing and extract_standup(existing.get("body")):
        print("a standup is already in place; leaving it")
        return
    reason = ""
    if a.reason_file and Path(a.reason_file).exists():
        reason = Path(a.reason_file).read_text().strip()
    upsert_day_comment(gh, sig["date"],
                       MISSING.format(url=a.run_url, reason=f": {reason}" if reason else ""),
                       render_signals(sig), comments=comments)
    print("noted that the planning agent didn't finish" + (f" ({reason})" if reason else ""))


def _cmd_agent_error(a) -> None:
    why = agent_error(a.execution_file)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(why + "\n")
    print(f"::error title=Planning agent::{why}")


def _cmd_go_context(a) -> None:
    gh = GitHub()
    owner = os.getenv("DAILY_PLAN_OWNER") or gh.repo.split("/")[0]
    ctx = go_context(gh, int(a.comment_id), owner)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(json.dumps(ctx, indent=2))
    _output(option=ctx["go"]["option"] or "", standup_url=(ctx["standup"] or {}).get("url", ""))
    print(f"go context written: option={ctx['go']['option']!r}")


def _cmd_check_paths(a) -> None:
    bad = disallowed(read_paths(a.changed), a.allow)
    if bad:
        print("refusing: changes outside the allowed files:\n  " + "\n  ".join(bad))
        sys.exit(1)
    print("paths ok")


def _cmd_touches(a) -> None:
    hits = [p for p in read_paths(a.changed) if p.startswith(a.prefix)]
    print("\n".join(hits))
    sys.exit(0 if hits else 1)


def _cmd_wait_checks(a) -> None:
    ok, why = wait_checks(GitHub(), a.sha, timeout=a.timeout)
    print(why)
    sys.exit(0 if ok else 1)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="engine.dailyplan", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("signals")
    s.add_argument("--out", default=".daily-plan/signals.json")
    s.set_defaults(fn=_cmd_signals)
    s = sub.add_parser("standup")
    s.add_argument("signals")
    s.add_argument("standup")
    s.set_defaults(fn=_cmd_standup)
    s = sub.add_parser("agent-missing")
    s.add_argument("signals")
    s.add_argument("--run-url", required=True)
    s.add_argument("--reason-file")
    s.set_defaults(fn=_cmd_agent_missing)
    s = sub.add_parser("agent-error")
    s.add_argument("execution_file")
    s.add_argument("--out", default=".daily-plan/agent_error.txt")
    s.set_defaults(fn=_cmd_agent_error)
    s = sub.add_parser("go-context")
    s.add_argument("comment_id")
    s.add_argument("--out", default=".daily-plan/go_context.json")
    s.set_defaults(fn=_cmd_go_context)
    s = sub.add_parser("check-paths")
    s.add_argument("changed")
    s.add_argument("--allow", nargs="+", required=True)
    s.set_defaults(fn=_cmd_check_paths)
    s = sub.add_parser("touches")
    s.add_argument("changed")
    s.add_argument("prefix")
    s.set_defaults(fn=_cmd_touches)
    s = sub.add_parser("wait-checks")
    s.add_argument("sha")
    s.add_argument("--timeout", type=float, default=900)
    s.set_defaults(fn=_cmd_wait_checks)
    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
