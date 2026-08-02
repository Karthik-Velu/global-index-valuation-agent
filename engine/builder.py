"""The Builder agent — turns an approved CODE proposal into a reviewed pull request.

`engine/proposals.py::apply()` can action DATA proposals in-process (a new KPI is
an INSERT). CODE proposals can't work that way: no button writes and deploys
Python. Those move to `queued_build` and land here.

The loop is deliberately English-first (owner decision, 2026-08-01) — the admin
approves twice, and the second approval is on a plan they can actually read:

    draft()  -> reads the repo, writes a PLAIN-ENGLISH solution: what changes,
                which files, what could break, how we'd know it worked. Stored as
                proposal_solutions revision N, status 'draft'. No code yet.
    (admin)  -> reads it in the console. Asks for changes -> status 'revising',
                which draft() picks up and redrafts as revision N+1, carrying the
                feedback. Or says push it -> status 'push_ok'.
    build()  -> only now is code written. Edits are exact search/replace blocks,
                verified against the file before anything is touched, then
                compile-gated, committed to a branch, pushed, PR opened with
                auto-merge armed.
    poll()   -> watches the PR. Merged -> the proposal is finally 'actioned'.

Why search/replace and not whole-file rewrites: a model asked to reproduce
engine/quality.py in full will silently drop a check. A block that must match
byte-for-byte either applies or fails loudly, and "fails loudly" is recoverable.

Safety rails, in order of how much they'd hurt if missing:
  * writes are confined to an allowlist of source paths — never .env, .github/
    workflows, migrations already applied, or anything outside the repo root;
  * every edit must match exactly once (0 matches = stale plan, 2+ = ambiguous);
  * the tree must compile before a commit is made, and the touched modules must
    import;
  * pushes only ever go to a fresh `builder/proposal-<id>` branch. Never main.

Without a coder model, or without a GitHub token, every entry point is a clean
no-op that records why — same contract as the rest of the engine.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.error
import urllib.request
from pathlib import Path

from . import db, llm
from .proposals import GITHUB_REPO, _event

REPO_ROOT = Path(__file__).resolve().parent.parent

# Where the Builder may write. Anything else is refused, loudly, before the model
# is even asked — the blast radius of a bad edit is the thing we control, not the
# model's willingness to make one.
_ALLOWED_PREFIXES = ("engine/", "dashboard/", "docs/", "scripts/")
_FORBIDDEN = (
    ".env", ".github/",           # secrets + the workflows that hold them
    "engine/migrations/",         # applied migrations are immutable history
    "requirements.txt",           # a dependency change needs a human
)
_MAX_FILE_BYTES = 60_000          # context guard; larger files go in as an outline


# --------------------------------------------------------------------------- #
# repo context
# --------------------------------------------------------------------------- #

def _safe_path(rel: str) -> Path | None:
    """Resolve a model-supplied path, or None if it escapes the rails.

    Every check runs on the NORMALIZED path, never the raw string. That ordering
    is the whole security property: `engine/../.env` starts with an allowed
    prefix and resolves to a file inside the repo, so a raw-string allowlist plus
    a containment check both pass it. Normalising first turns it back into
    `.env`, which the forbidden list then catches.
    """
    raw = (rel or "").strip()
    if not raw:
        return None
    p = (REPO_ROOT / raw.lstrip("/")).resolve()
    try:
        norm = p.relative_to(REPO_ROOT).as_posix()   # also rejects anything outside the repo
    except ValueError:
        return None
    if not norm.startswith(_ALLOWED_PREFIXES):
        return None
    if any(norm == f or norm.startswith(f) for f in _FORBIDDEN):
        return None
    return p


def _read(rel: str) -> str:
    p = _safe_path(rel)
    if not p or not p.is_file():
        return ""
    txt = p.read_text(encoding="utf-8", errors="replace")
    if len(txt) > _MAX_FILE_BYTES:
        # Give the model the shape of the file rather than a truncated middle —
        # a half-file invites edits anchored on text that isn't there.
        heads = [l for l in txt.splitlines()
                 if re.match(r"^\s*(def |class |# ---|_[A-Z_]+ =|[A-Z_]{3,} =)", l)]
        return (txt[:8000] + "\n\n# ... [truncated — outline of the rest] ...\n"
                + "\n".join(heads[:200]))
    return txt


def _candidate_files(kind: str, target: str) -> list[str]:
    """Deterministically pick the files this proposal probably touches.

    Kind gives the neighbourhood; grepping for the target name finds the exact
    street. Deterministic on purpose — letting the model pick its own context
    means paying for it to read the repo every revision.
    """
    by_kind = {
        "quality_check": ["engine/quality.py", "engine/qualitytriage.py"],
        "source_adapter": ["engine/sources/catalog.py", "engine/datapipeline.py"],
        "catalog_kpi": ["engine/sources/catalog.py", "engine/metrics.py"],
        "model_routing": ["engine/config.py", "engine/llm.py", "engine/modelrouting.py"],
    }
    files = [f for f in by_kind.get(kind, []) if (REPO_ROOT / f).is_file()]
    if target:
        try:
            hit = subprocess.run(
                ["git", "grep", "-l", "--fixed-strings", target, "--", "engine", "dashboard"],
                cwd=REPO_ROOT, capture_output=True, text=True, timeout=20)
            for line in hit.stdout.splitlines()[:4]:
                if line and line not in files and _safe_path(line):
                    files.append(line)
        except Exception:  # noqa: BLE001 — context is best-effort, never fatal
            pass
    return files[:6]


def _context_blob(kind: str, target: str) -> tuple[str, list[str]]:
    files = _candidate_files(kind, target)
    parts = [f"### {f}\n```python\n{_read(f)}\n```" for f in files if _read(f)]
    return "\n\n".join(parts)[:48_000], files


# --------------------------------------------------------------------------- #
# draft — plain English, no code
# --------------------------------------------------------------------------- #

_DRAFT_SYSTEM = (
    "You are the Builder for a global equity valuation engine. An approved "
    "proposal needs code. Write the SOLUTION PLAN that a non-engineer product "
    "owner will read and approve BEFORE any code exists. No code in this output.\n"
    "Ground every claim in the repository excerpts given — name real functions and "
    "real files. If the excerpts don't show you enough to be sure, say exactly "
    "what you'd need; do not invent structure.\n"
    "Return ONLY a JSON object with these keys:\n"
    '  "plan": 3-6 sentences of plain English. What changes, where, and how it '
    "behaves differently afterwards. Written for someone who will never read the diff.\n"
    '  "files_touched": array of repo-relative paths you would edit or create.\n'
    '  "risks": what could break or regress, honestly. If something is genuinely '
    "risky, say so — an approved bad change is worse than a rejected good one.\n"
    '  "test_plan": how we would know it worked, concretely — the command to run '
    "and the observable result to expect."
)


def draft(limit: int = 3, model_role: str = "coder") -> dict:
    """Write (or redraft) the English solution for proposals awaiting a plan."""
    if not db.have_db():
        return {"skipped": "no db"}
    if not llm.LLM_ENABLED:
        return {"skipped": "no model configured"}

    with db.connect() as c, c.cursor() as cur:
        # Two populations: never-drafted queued builds, and ones the admin sent
        # back. A single query so revisions can't starve behind new work.
        cur.execute(
            """select p.id, p.kind, p.target, p.proposal, p.reason, p.expected_outcome,
                      p.how_used, p.decision_note,
                      s.id, coalesce(s.revision,0), s.feedback
               from proposals p
               left join lateral (
                   select id, revision, feedback, status from proposal_solutions
                   where proposal_id = p.id order by revision desc limit 1
               ) s on true
               where p.status = 'queued_build'
                 and (s.id is null or s.status = 'revising')
               order by p.evidence_count desc limit %s""", (limit,))
        rows = cur.fetchall()

    drafted, failed = [], []
    for (pid, kind, target, proposal, reason, outcome, how_used, note,
         _sid, last_rev, feedback) in rows:
        blob, files = _context_blob(kind, target)
        payload = {
            "kind": kind, "target": target, "approved_proposal": proposal,
            "why_raised": reason, "expected_outcome": outcome,
            # What is meant to consume this. Without it the Builder writes a check
            # that fires into the void — it knows what to detect and nothing about
            # who acts on the detection.
            "how_it_will_be_used": how_used,
            "repository_excerpts": blob,
        }
        if note:
            # The admin's own words at the moment they approved. This was being
            # written to the DB and read by nothing — proposal #64 was approved
            # with "along with flagging - it should result in information being
            # used by one of the agents to eventually suggest next steps", an
            # explicit scope instruction the Builder would have silently ignored.
            # It outranks the agent's original pitch: the agent proposed, the
            # human decided, and this is what they decided.
            payload["admin_instruction_at_approval"] = note
            payload["note_on_priority"] = (
                "admin_instruction_at_approval is a direct instruction from the "
                "person who approved this. Where it conflicts with or extends the "
                "original proposal, follow the instruction.")
        if feedback:
            # The admin's own words, verbatim and prominent. Paraphrasing here
            # is how a revision loop quietly drifts away from what was asked.
            payload["admin_requested_changes"] = feedback
            payload["note"] = ("Revision %d was rejected. Address the admin's "
                               "requested changes directly." % last_rev)
        try:
            txt, model_id = llm.call_with_model(
                model_role, _DRAFT_SYSTEM, json.dumps(payload, default=str)[:52_000],
                max_tokens=1800, json_mode=True)
            obj = json.loads(txt)
        except Exception as e:  # noqa: BLE001 — one bad draft must not stop the batch
            failed.append({"proposal_id": pid, "error": str(e)[:160]})
            continue

        touched = obj.get("files_touched")
        if not isinstance(touched, list) or not touched:
            touched = files
        touched = [f for f in touched if isinstance(f, str) and _safe_path(f)]

        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                """insert into proposal_solutions
                   (proposal_id, revision, plan, files_touched, risks, test_plan,
                    status, model_id)
                   values (%s,%s,%s,%s,%s,%s,'draft',%s) returning id, revision""",
                (pid, last_rev + 1, (obj.get("plan") or "").strip() or "(no plan produced)",
                 json.dumps(touched), obj.get("risks"), obj.get("test_plan"), model_id))
            sid, rev = cur.fetchone()
            _event(cur, pid, "solution_drafted", actor=f"builder/{model_id}",
                   detail=f"revision {rev}; {len(touched)} file(s)")
            c.commit()
        drafted.append({"proposal_id": pid, "solution_id": sid, "revision": rev})
    return {"drafted": drafted, "failed": failed}


# --------------------------------------------------------------------------- #
# build — now, and only now, write code
# --------------------------------------------------------------------------- #

_BUILD_SYSTEM = (
    "You are the Builder for a global equity valuation engine. The admin has "
    "APPROVED the solution plan below. Implement it — exactly it, nothing extra.\n"
    "Match the surrounding code's style, naming and comment density. Comments in "
    "this codebase explain WHY, not what; write them that way or omit them.\n"
    "Return ONLY a JSON object:\n"
    '  "edits": array of {"file", "search", "replace"}. `search` MUST be copied '
    "byte-for-byte from the file shown, including indentation, and must appear "
    "EXACTLY ONCE in it. Keep each block tight — a few lines of unique anchor, not "
    "a whole function — but large enough to be unambiguous.\n"
    '  "new_files": array of {"file", "content"} for files that do not exist yet.\n'
    '  "commit_message": one line, imperative, saying WHY. No prefix like "feat:".\n'
    '  "summary": 2-3 sentences for the PR body, plain English.\n'
    "If the plan cannot be implemented from what you were shown, return "
    '{"edits": [], "new_files": [], "blocked": "<what you would need>"} rather '
    "than guessing. A wrong edit costs more than an honest block."
)


def _apply_edits(edits: list, new_files: list) -> tuple[list[str], list[str]]:
    """Apply edits to the working tree. Returns (written, errors).

    Nothing is written until every edit has been verified to match exactly once,
    so a half-applied plan is not a state this can leave the tree in.
    """
    staged: dict[Path, str] = {}
    errors: list[str] = []

    for e in edits or []:
        if not isinstance(e, dict):
            continue
        rel, search, replace = e.get("file", ""), e.get("search", ""), e.get("replace", "")
        p = _safe_path(rel)
        if not p:
            errors.append(f"{rel}: outside the writable allowlist")
            continue
        if not p.is_file():
            errors.append(f"{rel}: no such file")
            continue
        cur = staged.get(p, p.read_text(encoding="utf-8"))
        if not search:
            errors.append(f"{rel}: empty search block")
            continue
        n = cur.count(search)
        if n != 1:
            errors.append(f"{rel}: search block matched {n} times (need exactly 1)")
            continue
        staged[p] = cur.replace(search, replace, 1)

    for f in new_files or []:
        if not isinstance(f, dict):
            continue
        p = _safe_path(f.get("file", ""))
        if not p:
            errors.append(f"{f.get('file')}: outside the writable allowlist")
            continue
        if p.exists():
            errors.append(f"{f.get('file')}: already exists — use an edit, not a new file")
            continue
        staged[p] = f.get("content") or ""

    if errors:
        return [], errors

    written = []
    for p, txt in staged.items():
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(txt, encoding="utf-8")
        written.append(str(p.relative_to(REPO_ROOT)))
    return written, []


def _gate(files: list[str]) -> tuple[bool, str]:
    """Compile the tree and import what changed. The minimum bar for a push.

    This repo has no test suite, so this IS the local gate — it catches the
    failure mode that actually happens (a syntax error or a bad import shipped
    into the nightly pipeline). CI is the real check; this stops the obvious.
    """
    r = subprocess.run(["python", "-m", "compileall", "-q", "engine"],
                       cwd=REPO_ROOT, capture_output=True, text=True, timeout=180)
    if r.returncode != 0:
        return False, f"compileall failed:\n{(r.stdout + r.stderr)[:1500]}"

    mods = [f[:-3].replace("/", ".") for f in files
            if f.startswith("engine/") and f.endswith(".py") and "migrations" not in f]
    for m in mods:
        r = subprocess.run(["python", "-c", f"import {m}"], cwd=REPO_ROOT,
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return False, f"import {m} failed:\n{(r.stdout + r.stderr)[:1500]}"
    return True, f"compileall ok; imported {len(mods)} changed module(s)"


def _git(*args: str, check: bool = True) -> str:
    r = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True,
                       text=True, timeout=180)
    if check and r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}: {(r.stderr or r.stdout)[:400]}")
    return r.stdout.strip()


def build(limit: int = 2, model_role: str = "coder") -> dict:
    """Implement solutions the admin marked push_ok: code, gate, branch, PR."""
    if not db.have_db():
        return {"skipped": "no db"}
    if not llm.LLM_ENABLED:
        return {"skipped": "no model configured"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """select s.id, s.proposal_id, s.revision, s.plan, s.files_touched,
                      s.test_plan, p.kind, p.target, p.proposal
               from proposal_solutions s join proposals p on p.id = s.proposal_id
               where s.status = 'push_ok' order by s.updated_at limit %s""", (limit,))
        rows = cur.fetchall()

    built, failed = [], []
    for sid, pid, rev, plan, touched, test_plan, kind, target, proposal in rows:
        try:
            files = touched if isinstance(touched, list) else json.loads(touched or "[]")
        except Exception:  # noqa: BLE001
            files = []
        files = [f for f in files if _safe_path(f)] or _candidate_files(kind, target)

        # Show the model the files its own plan named, at current content.
        blob = "\n\n".join(f"### {f}\n```python\n{_read(f)}\n```"
                           for f in files if _read(f))[:52_000]
        ask = json.dumps({"approved_plan": plan, "test_plan": test_plan,
                          "original_proposal": proposal, "kind": kind, "target": target,
                          "files": files, "current_contents": blob}, default=str)[:56_000]

        branch = f"builder/proposal-{pid}"
        try:
            txt, model_id = llm.call_with_model(model_role, _BUILD_SYSTEM, ask,
                                                max_tokens=6000, json_mode=True)
            obj = json.loads(txt)
            if obj.get("blocked"):
                raise RuntimeError(f"builder reported blocked: {obj['blocked']}"[:400])

            written, errors = _apply_edits(obj.get("edits"), obj.get("new_files"))
            if errors:
                raise RuntimeError("edits rejected: " + "; ".join(errors)[:400])
            if not written:
                raise RuntimeError("model returned no edits")

            ok, detail = _gate(written)
            if not ok:
                _git("checkout", "--", ".", check=False)
                raise RuntimeError(detail[:600])

            base = _git("rev-parse", "--abbrev-ref", "HEAD")
            _git("checkout", "-B", branch)
            _git("add", *written)
            msg = (obj.get("commit_message") or f"Implement approved proposal #{pid}").strip()
            body = (f"{msg}\n\nApproved proposal #{pid} ({kind}/{target}), solution "
                    f"revision {rev}. Plan reviewed and approved in the admin console "
                    f"before any code was written.\n\n{obj.get('summary') or ''}".strip())
            _git("commit", "-m", body)
            _push(branch)
            _git("checkout", base, check=False)

            pr = _open_pr(branch, base, pid, kind, target, msg, plan,
                          obj.get("summary"), test_plan, rev)
            _solution_status(sid, pid, "pushed", branch=branch, pr_url=pr,
                             model_id=model_id,
                             detail=f"{len(written)} file(s); {detail}; PR {pr or '(not opened)'}")
            built.append({"proposal_id": pid, "branch": branch, "pr_url": pr,
                          "files": written})
        except Exception as e:  # noqa: BLE001 — record, leave the tree clean, move on
            _git("checkout", "--", ".", check=False)
            _solution_status(sid, pid, "failed", detail=f"{type(e).__name__}: {e}"[:900])
            failed.append({"proposal_id": pid, "error": str(e)[:300]})
    return {"built": built, "failed": failed}


def _push(branch: str) -> None:
    """Push with the token in the URL, retrying transient network failures."""
    import time
    token = os.getenv("GITHUB_TOKEN", "").strip()
    remote = (f"https://x-access-token:{token}@github.com/{GITHUB_REPO}.git"
              if token else "origin")
    last = ""
    for attempt, wait in enumerate((2, 4, 8, 16, 0)):
        r = subprocess.run(["git", "push", "-u", remote, branch, "--force-with-lease"],
                           cwd=REPO_ROOT, capture_output=True, text=True, timeout=240)
        if r.returncode == 0:
            return
        last = (r.stderr or r.stdout)[:400]
        # Only retry what retrying can fix. A rejected push is not a network blip.
        if not any(s in last.lower() for s in ("could not resolve", "timed out",
                                               "connection reset", "failed to connect")):
            break
        if wait:
            time.sleep(wait)
    raise RuntimeError(f"git push failed after retries: {last}")


def _solution_status(sid: int, pid: int, status: str, *, branch: str | None = None,
                     pr_url: str | None = None, model_id: str | None = None,
                     detail: str = "") -> None:
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """update proposal_solutions set status=%s, updated_at=now(),
                   branch=coalesce(%s,branch), pr_url=coalesce(%s,pr_url),
                   model_id=coalesce(%s,model_id)
               where id=%s""", (status, branch, pr_url, model_id, sid))
        _event(cur, pid, f"solution_{status}", actor="builder", detail=detail[:2000])
        c.commit()


# --------------------------------------------------------------------------- #
# GitHub
# --------------------------------------------------------------------------- #

def _gh(path: str, data: dict | None = None, method: str | None = None) -> dict:
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        raise RuntimeError("no GITHUB_TOKEN")
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}{path}",
        data=json.dumps(data).encode() if data is not None else None, method=method,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "giva-builder"})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read() or "{}")


def _open_pr(branch: str, base: str, pid: int, kind: str, target: str, title: str,
             plan: str, summary: str | None, test_plan: str | None, rev: int) -> str | None:
    if not os.getenv("GITHUB_TOKEN", "").strip():
        return None
    body = "\n".join([
        f"Implements approved agent proposal **#{pid}** — `{kind}` / `{target}`.", "",
        "## What this does", summary or title, "",
        "## Approved plan (revision %d)" % rev, plan or "(none)", "",
        "## How to verify", test_plan or "(none recorded)", "",
        "---",
        "Built by the Builder agent. The plan above was approved in the admin "
        "console *before* any code was written; this PR implements exactly that plan.",
    ])
    try:
        pr = _gh("/pulls", {"title": title, "head": branch, "base": base, "body": body})
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"PR creation failed: {e.code} {e.read()[:200]!r}") from e
    num = pr.get("number")
    if num:
        # Labels only. Merging is poll()'s job — GitHub's real auto-merge is
        # GraphQL-only and silently unavailable on repos that haven't enabled it,
        # so arming it here would look like it worked and quietly never fire.
        try:
            _gh(f"/issues/{num}/labels", {"labels": ["agent-built", "agent-proposal"]})
        except Exception:  # noqa: BLE001 — a missing label is not worth failing a build
            pass
    return pr.get("html_url")


def _checks_green(sha: str) -> tuple[bool, str]:
    """Have all required checks passed for this commit?

    Treats "no checks configured at all" as NOT green. This repo's workflows are
    schedule/dispatch-triggered, so a Builder PR can legitimately have zero check
    runs — and auto-merging on an empty check set is auto-merging on nothing.
    A human can always merge it by hand; the bot shouldn't.
    """
    try:
        st = _gh(f"/commits/{sha}/status")
        runs = _gh(f"/commits/{sha}/check-runs").get("check_runs", [])
    except Exception as e:  # noqa: BLE001
        return False, f"could not read checks: {str(e)[:120]}"

    combined = st.get("state")            # success | pending | failure (statuses API)
    done = [r for r in runs if r.get("status") == "completed"]
    bad = [r for r in runs if r.get("status") == "completed"
           and r.get("conclusion") not in ("success", "neutral", "skipped")]
    pending = [r for r in runs if r.get("status") != "completed"]

    if bad:
        return False, f"{len(bad)} failing check(s): " + ", ".join(r.get("name", "?") for r in bad[:4])
    if pending:
        return False, f"{len(pending)} check(s) still running"
    if combined == "failure":
        return False, "commit status is failure"
    if not done and combined not in ("success",):
        return False, "no checks reported — not merging on an empty check set"
    return True, f"{len(done)} check(s) green"


def poll(merge_on_green: bool = True) -> dict:
    """Follow pushed PRs to their end state, merging the green ones.

    "once a Claude PR is green (tests + verify gates pass), merge it without
    waiting for manual approval" — the standing instruction in CLAUDE.md. This is
    where that happens for Builder PRs: green and mergeable -> squash-merge ->
    the proposal finally becomes 'actioned'.
    """
    if not db.have_db() or not os.getenv("GITHUB_TOKEN", "").strip():
        return {"skipped": "no db or no token"}
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id, proposal_id, pr_url from proposal_solutions "
                    "where status='pushed' and pr_url is not null")
        rows = cur.fetchall()

    out = []
    for sid, pid, url in rows:
        m = re.search(r"/pull/(\d+)", url or "")
        if not m:
            continue
        num = m.group(1)
        try:
            pr = _gh(f"/pulls/{num}")
        except Exception as e:  # noqa: BLE001
            out.append({"proposal_id": pid, "error": str(e)[:120]})
            continue

        if pr.get("merged"):
            _mark_merged(sid, pid, url)
            out.append({"proposal_id": pid, "merged": True})
            continue
        if pr.get("state") == "closed":
            _solution_status(sid, pid, "failed", detail=f"PR closed unmerged: {url}")
            out.append({"proposal_id": pid, "closed_unmerged": True})
            continue

        green, why = _checks_green(pr.get("head", {}).get("sha", ""))
        if not (merge_on_green and green):
            out.append({"proposal_id": pid, "state": "open", "green": green, "why": why})
            continue
        if pr.get("mergeable") is False:
            out.append({"proposal_id": pid, "state": "open",
                        "why": f"conflicts ({pr.get('mergeable_state')})"})
            continue
        try:
            _gh(f"/pulls/{num}/merge", {"merge_method": "squash"}, method="PUT")
        except Exception as e:  # noqa: BLE001 — branch protection, race, etc.
            out.append({"proposal_id": pid, "merge_failed": str(e)[:160]})
            continue
        _mark_merged(sid, pid, url)
        out.append({"proposal_id": pid, "merged": True, "why": why})
    return {"polled": out}


def _mark_merged(sid: int, pid: int, url: str) -> None:
    """A code proposal is done when the PR is merged — not when it was approved.

    Marking it 'actioned' at approval time was the tempting shortcut and would
    have been a lie in exactly the case that matters: the build failed.
    """
    _solution_status(sid, pid, "merged", detail=f"merged: {url}")
    with db.connect() as c, c.cursor() as cur:
        cur.execute("update proposals set status='actioned', actioned_at=now(), "
                    "action_detail=%s where id=%s", (f"merged {url}", pid))
        _event(cur, pid, "actioned", to_status="actioned", actor="builder",
               detail=f"PR merged: {url}")
        c.commit()


def run(draft_limit: int = 3, build_limit: int = 2) -> dict:
    """One full Builder pass, for builder.yml."""
    return {"poll": poll(), "draft": draft(limit=draft_limit), "build": build(limit=build_limit)}


if __name__ == "__main__":  # pragma: no cover
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    fn = {"draft": draft, "build": build, "poll": poll, "run": run}.get(cmd, run)
    print(json.dumps(fn(), indent=2, default=str))
