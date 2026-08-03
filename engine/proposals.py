"""The proposal review queue — the missing second half of the agent meta-loop.

docs/AGENTS.md always promised this: "an agent's output is a *proposal* ... a
human or a follow-up step turns the proposal into a deterministic rule." The
follow-up step was never built. Agents appended free text to `taxonomy_changes`
and nothing read it back, so:

  * the same idea was re-proposed every single day, forever (capex_intensity 15x
    in 7 days; Quality-Triage cycling the same 4 targets nightly),
  * 166 proposals accumulated and **zero** were ever applied,
  * semantic memory filled with near-duplicate paraphrases that decayed and
    retired without ever being acted on (281 retired sector-research lessons).

This module makes a proposal a durable, decidable object:

    capture()  -> upsert by dedup_key. A repeat bumps evidence_count instead of
                  creating row #16. A DECLINED key is refused outright, which is
                  what "discarded and not brought up again" actually requires.
    enrich()   -> fills the fixed 4-part English format the admin reads
                  (proposal / reason / expected outcome / worked examples).
    decide()   -> the status machine + audit log. approve | decline | park.
    apply()    -> approved proposals get actioned. Data kinds change the system
                  directly; code kinds file a GitHub issue and hand off to the
                  Builder (engine/builder.py).
    unpark()   -> "park for later" resurfaces when the data actually accumulates.

Everything degrades to a no-op without a DB, matching the rest of the engine.
"""
from __future__ import annotations

import datetime as _dt
import hashlib
import json
import os
import re
import urllib.error
import urllib.request

from . import db, llm

# Which kinds are DATA (actionable right now, in-process) vs CODE (needs a human
# or the Builder agent to write Python). Getting this wrong is the difference
# between "approved -> done" and a silent lie, so it's explicit, not inferred.
DATA_KINDS = {"catalog_kpi", "model_routing"}
CODE_KINDS = {"quality_check", "source_adapter"}
ALL_KINDS = DATA_KINDS | CODE_KINDS

_TERMINAL = {"declined", "actioned"}
GITHUB_REPO = os.getenv("GITHUB_REPOSITORY", "Karthik-Velu/global-index-valuation-agent")


# --------------------------------------------------------------------------- #
# capture
# --------------------------------------------------------------------------- #

def dedup_key(kind: str, target: str, variant: str = "") -> str:
    """Identity of a DECISION, not of a phrasing.

    (kind, target) and nothing else, by design. The decision the admin makes is
    "do we add capex_intensity to the catalog?" — that question is identical
    however the model words its pitch, and the observed failure was exactly this:
    the same KPI arrived 15 times in 7 days as "...reflecting investment level
    relative to sales" / "...indicating investment level relative to sales" /
    "CAPEX Intensity ...". Hashing the text (even normalised) gives each of those
    its own row and reproduces the flood we are here to stop.

    It also makes "declined and not brought up again" actually hold: a rejected
    idea cannot sneak back through a synonym.

    `variant` is the escape hatch for the genuinely rare case where one target
    warrants two independent decisions; callers must opt into it explicitly
    rather than getting fragmentation by accident.
    """
    tail = ""
    if variant:
        tail = ":" + hashlib.sha256(
            re.sub(r"[^a-z0-9]+", "", variant.lower()).encode()).hexdigest()[:8]
    return f"{kind}:{target}{tail}"


def capture(*, source_agent: str, kind: str, target: str, proposal: str,
            reason: str | None = None, expected_outcome: str | None = None,
            how_used: str | None = None, worked_examples: list | None = None,
            payload: dict | None = None, model_id: str | None = None,
            variant: str = "") -> dict:
    """Record (or re-confirm) a proposal. Returns {status, id, action}.

    action is one of: created | bumped | blocked_declined | skipped.

    `how_used` is required for a proposal to count as fully enriched (owner
    directive, 2026-08-02). `reason` says why it was raised and
    `expected_outcome` says what improves; neither answers "once this exists,
    what actually consumes it?" — which is the question that makes the
    difference between an informed approval and a blind one.
    """
    if not db.have_db() or not (proposal or "").strip():
        return {"action": "skipped", "reason": "no db or empty proposal"}
    if kind not in ALL_KINDS:
        return {"action": "skipped", "reason": f"unknown kind {kind!r}"}

    key = dedup_key(kind, target, variant)
    examples = worked_examples if isinstance(worked_examples, list) else []
    enriched = bool(reason and expected_outcome and how_used and examples)

    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id, status, evidence_count from proposals where dedup_key=%s", (key,))
        row = cur.fetchone()

        if row:
            pid, status, ev = row
            # "ones that i decline should be discarded and not brought up again"
            # — enforced here, at the only write path. Without this the nightly
            # agents would resurrect every rejected idea by tomorrow morning.
            if status == "declined":
                return {"action": "blocked_declined", "id": pid}
            # Bump the evidence, and while it's still un-reviewed let the newest
            # wording win — the agents genuinely do phrase it better some nights,
            # and there's no reason to show the admin the worst draft. Once it's
            # been decided or enriched the text is frozen: the admin must be
            # deciding on the words they actually read.
            cur.execute(
                """update proposals
                   set evidence_count = evidence_count + 1,
                       last_seen = now(),
                       proposal = case when status='pending' and needs_enrichment
                                       then %s else proposal end,
                       reason = case when status='pending' and needs_enrichment
                                     then coalesce(%s, reason) else reason end
                   where id=%s returning evidence_count""",
                (proposal.strip(), reason, pid))
            new_ev = cur.fetchone()[0]
            _event(cur, pid, "evidence_bumped", actor=source_agent,
                   detail=f"re-proposed; evidence {ev} -> {new_ev}")
            c.commit()
            return {"action": "bumped", "id": pid, "evidence_count": new_ev}

        cur.execute(
            """insert into proposals
               (source_agent, kind, target, model_id, dedup_key, proposal, reason,
                expected_outcome, how_used, worked_examples, needs_enrichment, payload)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (source_agent, kind, target, model_id, key, proposal.strip(), reason,
             expected_outcome, how_used, json.dumps(examples), not enriched,
             json.dumps(payload or {}, default=str)))
        pid = cur.fetchone()[0]
        _event(cur, pid, "captured", to_status="pending", actor=source_agent,
               detail=f"{kind} / {target}")
        c.commit()
        return {"action": "created", "id": pid}


def _event(cur, proposal_id: int, event: str, *, from_status: str | None = None,
           to_status: str | None = None, actor: str = "system", detail: str = "") -> None:
    cur.execute(
        "insert into proposal_events(proposal_id,event,from_status,to_status,actor,detail) "
        "values (%s,%s,%s,%s,%s,%s)",
        (proposal_id, event, from_status, to_status, actor, (detail or "")[:2000]))


# --------------------------------------------------------------------------- #
# enrich — produce the fixed 4-part format
# --------------------------------------------------------------------------- #

_ENRICH_SYSTEM = (
    "You prepare agent proposals for review by a non-engineer product owner of a "
    "global equity valuation system. Rewrite the raw proposal into PLAIN ENGLISH a "
    "smart reader with no knowledge of this codebase can decide on. Be concrete and "
    "honest; if the proposal is vague or looks low-value, say so in the reason.\n"
    "Return ONLY a JSON object with exactly these keys:\n"
    '  "proposal": one or two sentences — what would change, stated as an action.\n'
    '  "reason": why the agent raised it — the underlying problem, and what breaks '
    "today if nothing is done. Be specific about the problem, never restate the "
    'proposal. "LLM sub-sector KPI proposal" is the kind of non-answer that makes '
    "a proposal impossible to decide on.\n"
    '  "expected_outcome": what measurably improves if this is approved, and how we '
    "would know. Name the metric or behaviour, not a vague benefit.\n"
    '  "how_used": once this exists, what actually CONSUMES it going forward — '
    "which score, dashboard view, job or report changes behaviour, and from when. "
    "For a new metric say whether it feeds valuation/growth scoring, only shows in "
    "the stock breakdown, or is reference-only for now; and which companies it is "
    "collected for. If the honest answer is 'nothing consumes it yet, it is only "
    "collected', SAY THAT — an admin approving a metric that nothing reads deserves "
    "to know that before approving, not after.\n"
    '  "worked_examples": an array of 2-3 objects, each '
    '{"situation", "today", "after"} — a concrete case, what the system does now, '
    "and what it would do instead. Use REAL identifiers from the context when "
    "given (tickers, metric codes, check names); never invent numbers you were not "
    "given — describe the behaviour instead."
)


def enrich(limit: int = 6, model_role: str = "cheap") -> dict:
    """Fill the 4-part format for proposals that lack it. Cheap, batched, idempotent.

    Runs in the daily pipeline. Legacy backfilled rows and any agent that emitted
    only a bare proposal get turned into something reviewable. Without an LLM this
    is a clean no-op — the raw proposal text still shows in the console, just
    without the polished framing.
    """
    if not db.have_db():
        return {"skipped": "no db"}
    if not llm.LLM_ENABLED:
        return {"skipped": "no model configured"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """select id, source_agent, kind, target, proposal, reason, payload
               from proposals
               where needs_enrichment and status in ('pending','parked')
               order by evidence_count desc, last_seen desc limit %s""", (limit,))
        rows = cur.fetchall()

    done, failed = [], []
    for pid, agent, kind, target, proposal, reason, payload in rows:
        ctx = json.dumps({"source_agent": agent, "kind": kind, "target": target,
                          "raw_proposal": proposal, "raw_reason": reason,
                          "context": payload}, default=str)[:6000]
        try:
            txt, model_id = llm.call_with_model(model_role, _ENRICH_SYSTEM, ctx,
                                                max_tokens=1600, json_mode=True)
            obj = json.loads(txt)
        except Exception as e:  # noqa: BLE001 — one bad row must not stop the batch
            failed.append({"id": pid, "error": str(e)[:160]})
            continue

        examples = obj.get("worked_examples")
        if not isinstance(examples, list):
            examples = []
        # A row is only "enriched" if it actually gained the fields that make it
        # decidable. Clearing the flag on a model that skipped how_used would
        # retire the proposal from the enrichment queue while still leaving the
        # admin without the answer they asked for.
        complete = bool(obj.get("reason") and obj.get("expected_outcome")
                        and obj.get("how_used"))
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                """update proposals set proposal=coalesce(nullif(%s,''), proposal),
                       reason=%s, expected_outcome=%s, how_used=%s, worked_examples=%s,
                       needs_enrichment=%s, model_id=coalesce(model_id,%s)
                   where id=%s""",
                ((obj.get("proposal") or "").strip(), obj.get("reason"),
                 obj.get("expected_outcome"), obj.get("how_used"),
                 json.dumps(examples), not complete, model_id, pid))
            _event(cur, pid, "enriched", actor=f"enricher/{model_id}",
                   detail=f"{len(examples)} worked example(s)"
                          + ("" if complete else "; INCOMPLETE — how_used missing, will retry"))
            c.commit()
        (done if complete else failed).append(
            pid if complete else {"id": pid, "error": "model omitted how_used"})
    return {"enriched": done, "failed": failed}


# --------------------------------------------------------------------------- #
# decide — the status machine
# --------------------------------------------------------------------------- #

def decide(proposal_id: int, action: str, *, actor: str, note: str = "",
           park_until: str | None = None, park_min_evidence: int | None = None,
           applies_to: str | None = None) -> dict:
    """approve | decline | park. Every transition is audited.

    Terminal states are refused rather than silently overwritten: re-deciding an
    already-actioned proposal would make the audit log lie about what happened.
    """
    if action not in {"approve", "decline", "park"}:
        return {"error": f"unknown action {action!r}"}
    if not db.have_db():
        return {"error": "no db"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute("select status, kind from proposals where id=%s", (proposal_id,))
        row = cur.fetchone()
        if not row:
            return {"error": f"proposal {proposal_id} not found"}
        status, kind = row
        if status in _TERMINAL:
            return {"error": f"proposal {proposal_id} is already {status} — cannot re-decide"}

        new = {"approve": "approved", "decline": "declined", "park": "parked"}[action]
        cur.execute(
            """update proposals set status=%s, decided_at=now(), decided_by=%s,
                   decision_note=%s, park_until=%s, park_min_evidence=%s
               where id=%s""",
            (new, actor, note or None,
             park_until if action == "park" else None,
             park_min_evidence if action == "park" else None, proposal_id))
        _event(cur, proposal_id, "decided", from_status=status, to_status=new,
               actor=actor, detail=note or "")
        c.commit()

    result = {"id": proposal_id, "status": new, "kind": kind}
    if new == "approved":
        # "once that i have approved - get actioned immediately."
        result["action_result"] = apply(proposal_id, actor=actor, applies_to=applies_to)
    return result


# --------------------------------------------------------------------------- #
# apply — actioning
# --------------------------------------------------------------------------- #

def apply(proposal_id: int, *, actor: str = "system",
          applies_to: str | None = None) -> dict:
    """Action an approved proposal. Dispatches on kind; never guesses.

    DATA kinds change the live system here and now. CODE kinds cannot — no button
    can write and deploy Python instantly — so they file a GitHub issue carrying
    the full reviewed spec and move to `queued_build`, where engine/builder.py
    picks them up. The distinction is surfaced in the console rather than hidden,
    because "approved" meaning two different things silently is exactly the kind
    of quiet lie this whole module exists to remove.
    """
    if not db.have_db():
        return {"error": "no db"}
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "select kind, target, proposal, reason, expected_outcome, worked_examples, "
            "payload, status, how_used, decision_note from proposals where id=%s",
            (proposal_id,))
        row = cur.fetchone()
    if not row:
        return {"error": f"proposal {proposal_id} not found"}
    (kind, target, proposal, reason, outcome, examples, payload, status,
     how_used, note) = row
    if status not in {"approved", "failed"}:
        return {"error": f"proposal {proposal_id} is {status}, not approved"}

    try:
        if kind == "catalog_kpi":
            detail = _apply_catalog_kpi(target, payload or {}, proposal or "",
                                        override=applies_to, note=note or "")
            _finish(proposal_id, "actioned", detail, actor)
            return {"applied": True, "detail": detail}

        if kind == "model_routing":
            detail = _apply_model_routing(target, payload or {})
            _finish(proposal_id, "actioned", detail, actor)
            return {"applied": True, "detail": detail}

        # CODE kinds -> GitHub issue -> Builder
        url = _file_issue(proposal_id, kind, target, proposal, reason, outcome,
                          examples, how_used, note)
        _finish(proposal_id, "queued_build",
                f"filed {url}" if url else "no GITHUB_TOKEN — issue not filed, Builder "
                                           "will pick this up from the DB directly",
                actor, issue_url=url)
        return {"applied": True, "queued_build": True, "issue_url": url}

    except Exception as e:  # noqa: BLE001 — record and let the daily job retry
        _finish(proposal_id, "failed", f"{type(e).__name__}: {e}"[:500], actor)
        return {"applied": False, "error": str(e)[:300]}


def _finish(proposal_id: int, status: str, detail: str, actor: str,
            issue_url: str | None = None) -> None:
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "update proposals set status=%s, actioned_at=now(), action_detail=%s, "
            "issue_url=coalesce(%s, issue_url) where id=%s",
            (status, detail[:2000], issue_url, proposal_id))
        _event(cur, proposal_id, "actioned" if status != "failed" else "action_failed",
               to_status=status, actor=actor, detail=detail)
        c.commit()


_SCOPE_RE = re.compile(r"\bfor\s+([A-Z][\w&/ -]{2,40}?)\s*[::]")


def _infer_scope(proposal: str) -> str | None:
    """Recover a sub-sector the prose names but the payload doesn't carry.

    The legacy rows were free text — "propose for Industrial Materials: Capex
    Intensity" — so the scope exists only in the sentence. Defaulting straight to
    "all" silently applied a sector KPI market-wide on the first real approval
    (proposal #9, 2026-08-02): the admin approved a sentence naming one sector
    and got a row covering every sector. Reading it back out of the prose is a
    guess, so callers record it as inferred rather than as declared.
    """
    m = _SCOPE_RE.search(proposal or "")
    return m.group(1).strip() if m else None


def _apply_catalog_kpi(target: str, payload: dict, proposal: str = "",
                       override: str | None = None, note: str = "") -> str:
    """Add (or re-enable) a KPI in the live metric_catalog table.

    New KPIs land as `computed` unless the proposal names actual XBRL tags — an
    unverified tag guess is how the catalog got 7 metrics auto-demoted for
    returning the wrong concept (engine/sectoragent/validate.py), so we don't
    repeat it on a model's say-so.

    Scope resolution is deliberately explicit about provenance. "all" is a real
    decision (collect this for every company), not a neutral fallback, so where
    it came from is written into `notes` and echoed in the returned detail.

    `override` is the scope the approver typed in the console, and it outranks
    everything: a guess read out of the agent's prose is still a guess, whereas
    this is the human saying what they meant. It is a typed field rather than
    something parsed back out of `note`, because inferring meaning from free
    text is the exact failure this argument exists to fix.
    """
    tags = payload.get("xbrl_tags") or []
    in_xbrl = bool(tags)
    declared = (payload.get("applies_to") or payload.get("sector")
                or payload.get("proposed_for_sub_sector"))
    chosen = (override or "").strip() or None
    inferred = None if (chosen or declared) else _infer_scope(proposal)
    scope = chosen or declared or inferred or "all"
    prov = "added via admin-approved agent proposal"
    if chosen:
        prov += f' · scope "{chosen}" set by the approver'
    elif inferred:
        prov += f' · scope "{inferred}" INFERRED from the proposal text, not declared'
    elif not declared:
        prov += " · no scope given — applied to all sectors"
    if note.strip():
        # The approver's own words, kept next to the row they changed. Without
        # this the note lived only in `proposals.decision_note`, where nothing
        # looking at the catalog would ever find it.
        prov += f' · approver\'s note: "{note.strip()[:400]}"'
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """insert into metric_catalog
                 (metric_code, label, definition, unit, category, applies_to, in_xbrl,
                  xbrl_tags, source_if_not_xbrl, importance, notes)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict (metric_code) do update set
                 label = excluded.label,
                 definition = coalesce(excluded.definition, metric_catalog.definition),
                 -- Only a scope the approver typed may narrow an existing row.
                 -- A defaulted or inferred one must not silently rewrite what is
                 -- already there.
                 applies_to = case when %s then excluded.applies_to
                                   else metric_catalog.applies_to end,
                 notes = coalesce(metric_catalog.notes,'') || ' | ' || excluded.notes
               returning metric_code, applies_to""",
            (target, payload.get("label") or target.replace("_", " ").title(),
             payload.get("definition"), payload.get("unit") or "ratio",
             payload.get("category") or "sector_kpi", scope,
             in_xbrl, json.dumps(tags),
             None if in_xbrl else "computed", payload.get("importance") or "medium",
             prov, bool(chosen)))
        code, live_scope = cur.fetchone()
        c.commit()
    how = ("set by you at approval" if chosen else "declared" if declared
           else "inferred from the text" if inferred else "defaulted")
    detail = (f'metric_catalog upserted: {code} — applies_to="{live_scope}" ({how}), '
              f"in_xbrl={in_xbrl}")
    if not in_xbrl:
        # Saying "the next data run collects it" would be false: nothing fetches
        # a metric with no XBRL tags until someone writes the formula.
        detail += " — no XBRL tags, so nothing collects it yet"
    return detail


def _apply_model_routing(target: str, payload: dict) -> str:
    """Record an approved routing change.

    The chains live in env vars (MODEL_<ROLE>_CHAIN), not the DB, so this cannot
    take effect in-process without a redeploy. It is recorded as an applied
    decision plus the exact env line to set — deliberately NOT reported as a live
    change, which would be false.
    """
    role = payload.get("role", "agent")
    chain = payload.get("chain") or []
    line = f'MODEL_{role.upper()}_CHAIN="{", ".join(chain)}"' if chain else "(no chain given)"
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            "insert into taxonomy_changes(kind,target,change,reason,auto) "
            "values('model_routing',%s,%s,'admin-approved routing proposal',false)",
            (target, line))
        c.commit()
    return f"approved routing change recorded; set in env to take effect: {line}"


def _file_issue(proposal_id: int, kind: str, target: str, proposal: str,
                reason: str | None, outcome: str | None, examples,
                how_used: str | None = None, note: str | None = None) -> str | None:
    """Open a GitHub issue carrying the reviewed spec. None without a token."""
    token = os.getenv("GITHUB_TOKEN", "").strip()
    if not token:
        return None
    try:
        ex = examples if isinstance(examples, list) else json.loads(examples or "[]")
    except Exception:  # noqa: BLE001
        ex = []
    lines = [f"**Approved agent proposal #{proposal_id}** — `{kind}` / `{target}`", "",
             "## Proposal", proposal or "(none)", "",
             "## Why it was raised", reason or "(not recorded)", "",
             "## Expected outcome", outcome or "(not recorded)", "",
             "## How it gets used", how_used or "(not recorded)", ""]
    if note:
        # The admin's instruction at approval time outranks the agent's pitch:
        # the agent proposed, the human decided, and this is what they decided.
        lines += ["## Instruction from the approver — follow this", note, ""]
    if ex:
        lines.append("## Worked examples")
        for e in ex:
            if isinstance(e, dict):
                lines += [f"- **{e.get('situation', 'case')}**",
                          f"  - today: {e.get('today', '?')}",
                          f"  - after: {e.get('after', '?')}"]
    lines += ["", "---",
              "Approved by the admin in the review console. Picked up by the Builder "
              "agent (`engine/builder.py`), which drafts a plain-English solution for "
              "review before any code is pushed."]
    body = json.dumps({"title": f"[{kind}] {target}", "body": "\n".join(lines),
                       "labels": ["agent-proposal", kind]}).encode()
    req = urllib.request.Request(
        f"https://api.github.com/repos/{GITHUB_REPO}/issues", data=body,
        headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
                 "Content-Type": "application/json", "User-Agent": "giva-proposals"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read()).get("html_url")
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"GitHub issue creation failed: {e.code} {e.read()[:200]!r}") from e


# --------------------------------------------------------------------------- #
# unpark + retry — the daily sweep
# --------------------------------------------------------------------------- #

def unpark() -> dict:
    """Resurface parked proposals once the data has actually accumulated.

    "i can also say park for later - and these ones would come up for discussion
    later as more data accumulates." Two independent triggers, whichever fires
    first: a calendar date, or the agents having re-raised it enough more times
    to clear park_min_evidence.
    """
    if not db.have_db():
        return {"skipped": "no db"}
    today = _dt.date.today()
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """update proposals set status='pending', park_until=null, park_min_evidence=null
               where status='parked'
                 and ((park_until is not null and park_until <= %s)
                   or (park_min_evidence is not null and evidence_count >= park_min_evidence))
               returning id, evidence_count""", (today,))
        rows = cur.fetchall()
        for pid, ev in rows:
            _event(cur, pid, "unparked", from_status="parked", to_status="pending",
                   actor="daily-pipeline", detail=f"evidence now {ev}")
        c.commit()
    return {"unparked": [r[0] for r in rows]}


def retry_failed(limit: int = 5) -> dict:
    """Re-action anything that was approved but whose actioning errored.

    The Edge Function actions on click; this is the safety net for the case where
    that call failed (GitHub down, transient DB error) and the approval would
    otherwise sit silently un-actioned.
    """
    if not db.have_db():
        return {"skipped": "no db"}
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id from proposals where status in ('approved','failed') "
                    "order by decided_at limit %s", (limit,))
        ids = [r[0] for r in cur.fetchall()]
    return {"retried": {pid: apply(pid, actor="daily-pipeline") for pid in ids}}


def run_maintenance(enrich_limit: int = 20) -> dict:
    """The whole daily proposal-queue pass, in one call for datapipeline.py.

    The limit is 20, not the 6 this shipped with. 6 was sized for the steady
    state — a handful of new proposals a night — and is badly wrong for the
    backfilled backlog: 61 legacy proposals would take ten days to become
    readable, which is ten days of the admin deciding on raw agent text. At 20 it
    clears in three nights. The calls are role="cheap" (free tier) and add ~3
    minutes to a ~107-minute job, so the cost argument for keeping it low is
    weaker than the cost of un-reviewable proposals.
    """
    return {"unpark": unpark(), "retry": retry_failed(), "enrich": enrich(limit=enrich_limit)}


# --------------------------------------------------------------------------- #
# backfill — collapse the 166 legacy taxonomy_changes rows
# --------------------------------------------------------------------------- #

_LEGACY_KIND = {"quality_check": "quality_check", "catalog_proposal": "catalog_kpi"}
_LEGACY_AGENT = {"quality_check": "quality-triage", "catalog_proposal": "sector-research"}


def backfill_from_taxonomy() -> dict:
    """One-shot: import the proposals that were written before this queue existed.

    166 rows collapse to far fewer distinct ideas (capex_intensity alone was
    proposed 15 times). Evidence counts and first/last-seen carry over, so the
    review queue opens already sorted by how insistently each was raised.
    Idempotent: re-running bumps nothing, because dedup_key already exists.
    """
    if not db.have_db():
        return {"skipped": "no db"}
    # Group by the DECISION unit — (kind, target) — not by the text, so the
    # rewordings collapse. distinct_wordings is kept because it is itself the
    # evidence for why this queue exists: 166 rows, 61 real decisions.
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """select kind, target,
                      (array_agg(change order by ts desc))[1]  as latest_change,
                      (array_agg(reason order by ts desc))[1]  as latest_reason,
                      count(*)                                  as occurrences,
                      count(distinct change)                    as distinct_wordings,
                      min(ts), max(ts)
               from taxonomy_changes
               where kind in ('quality_check','catalog_proposal')
                 and coalesce(target,'') <> ''
               group by 1,2""")
        rows = cur.fetchall()

    created = bumped = 0
    for lkind, target, change, reason, n, wordings, first, last in rows:
        kind = _LEGACY_KIND.get(lkind)
        if not kind:
            continue
        res = capture(source_agent=_LEGACY_AGENT.get(lkind, "legacy"), kind=kind,
                      target=target, proposal=change or f"(legacy proposal for {target})",
                      reason=reason,
                      payload={"legacy": True, "legacy_kind": lkind, "occurrences": n,
                               "distinct_wordings": wordings})
        if res.get("action") == "created":
            created += 1
            # Carry the real history over, so the queue opens sorted by how
            # insistently each idea was actually raised.
            with db.connect() as c, c.cursor() as cur:
                cur.execute(
                    "update proposals set evidence_count=%s, first_seen=%s, last_seen=%s "
                    "where id=%s", (n, first, last, res["id"]))
                c.commit()
        elif res.get("action") == "bumped":
            bumped += 1
    return {"legacy_groups": len(rows), "created": created, "merged_into_existing": bumped}


if __name__ == "__main__":  # pragma: no cover
    import sys
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "backfill":
        print(json.dumps(backfill_from_taxonomy(), indent=2))
    elif cmd == "maintenance":
        print(json.dumps(run_maintenance(), indent=2, default=str))
    elif cmd == "enrich":
        print(json.dumps(enrich(limit=int(sys.argv[2]) if len(sys.argv) > 2 else 6),
                         indent=2, default=str))
    else:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select status, count(*) from proposals group by 1 order by 2 desc")
            print(json.dumps(dict(cur.fetchall()), indent=2))
