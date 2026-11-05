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

    capture()  -> upsert by canonical key (engine/canonical.py, ADR-044), against an
                  OPEN need in the register (data_needs). A repeat merges into the
                  existing row instead of creating row #16. A DECLINED key, or any
                  synonym of it, is refused outright, which is what "discarded and
                  not brought up again" actually requires.
    enrich()   -> fills the fixed 4-part English format the admin reads
                  (proposal / reason / expected outcome / worked examples).
    decide()   -> the status machine + audit log. approve | decline | park.
    apply()    -> approved proposals get actioned. Data kinds change the system
                  directly; code kinds file a GitHub issue and hand off to the
                  Builder (engine/builder.py).
    unpark()   -> "park for later" resurfaces when the data actually accumulates.
    expire_stale() -> a pending proposal whose trigger is gone expires, audited.

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

from . import canonical, db, llm

# Which kinds are DATA (actionable right now, in-process) vs CODE (needs a human
# or the Builder agent to write Python). Getting this wrong is the difference
# between "approved -> done" and a silent lie, so it's explicit, not inferred.
DATA_KINDS = {"catalog_kpi", "model_routing"}
CODE_KINDS = {"quality_check", "source_adapter"}
ALL_KINDS = DATA_KINDS | CODE_KINDS

_TERMINAL = {"declined", "actioned", "expired"}
# Agents run weekly (PR #70), so this is six missed runs.
EXPIRY_DAYS = int(os.getenv("PROPOSAL_EXPIRY_DAYS", "42"))
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

    It was meant to make "declined and not brought up again" hold against synonyms
    too, and it did not: the target is the model's raw string, so 'FRED', 'fred'
    and 'fred_idx' were three keys (ADR-044). capture() now matches on the
    canonical key; this stays as the row's unique id, with the canonical key as
    the variant for new rows.

    `variant` is the escape hatch for the genuinely rare case where one target
    warrants two independent decisions; callers must opt into it explicitly
    rather than getting fragmentation by accident.
    """
    tail = ""
    if variant:
        tail = ":" + hashlib.sha256(
            re.sub(r"[^a-z0-9]+", "", variant.lower()).encode()).hexdigest()[:8]
    return f"{kind}:{target}{tail}"


# Which row wins when several share a canonical key (the legacy synonyms do). A parked
# decision outranks a pending synonym, or the synonym would bypass the parked block.
_PREFER = {"parked": 0, "pending": 1, "expired": 2, "queued_build": 3, "approved": 4,
           "failed": 5, "actioned": 6}


def capture(*, source_agent: str, kind: str, target: str, proposal: str,
            reason: str | None = None, expected_outcome: str | None = None,
            worked_examples: list | None = None, payload: dict | None = None,
            model_id: str | None = None, variant: str = "",
            need_id: str | None = None, signal: str | None = None) -> dict:
    """Record (or re-confirm) a proposal. Returns {status, id, action}.

    action is one of: created | bumped | seen | revived | blocked_declined |
    blocked_parked | blocked_need | in_catalogue | skipped.

    Identity is the canonical key (engine/canonical.py, ADR-044), so a synonym of a
    declined or parked idea is blocked like the original. `need_id` links the
    proposal to the needs register, and a need that is not open takes no
    proposals: declining a solution leaves its need open, but an answered or
    parked need is not re-litigated every week. `signal` names the independent
    support (a sub-sector, a firing check, a need); evidence is the number of
    DISTINCT signals, because the same idea re-raised each night is not evidence.

    `how_used` is not the agent's to write (owner directive, 2026-08-02, that every
    proposal says how it will be used): it is built from CONSUMERS, the fixed list
    of what the code actually reads, because the agents named consumers that do
    not exist ("ESG scoring engine").
    """
    if not db.have_db() or not (proposal or "").strip():
        return {"action": "skipped", "reason": "no db or empty proposal"}
    if kind not in ALL_KINDS:
        return {"action": "skipped", "reason": f"unknown kind {kind!r}"}

    backfill_canonical()
    payload = dict(payload or {})
    examples = worked_examples if isinstance(worked_examples, list) else []
    enriched = bool(reason and expected_outcome and examples)
    ckey = canonical.canonical_key(kind, target, payload, need_id)
    sig = signal or f"agent:{source_agent}"

    with db.connect() as c, c.cursor() as cur:
        if kind == "catalog_kpi":
            code = canonical.resolve_kpi(target, catalogue_codes(cur))
            if code:
                return {"action": "in_catalogue", "code": code}
        if need_id:
            cur.execute("select status from data_needs where id=%s", (need_id,))
            need = cur.fetchone()
            if not need or need[0] != "open":
                return {"action": "blocked_need", "need": need_id,
                        "need_status": need[0] if need else "missing"}

        cur.execute(
            """select id, status, canonical_key, evidence_count, signals, payload
               from proposals where canonical_key = any(%s)""",
            (canonical.blocking_keys(ckey),))
        rows = cur.fetchall()
        # "ones that i decline should be discarded and not brought up again"
        # — enforced here, at the only write path, and on the canonical key, so the
        # nightly agents cannot resurrect a rejected idea under a new spelling.
        declined = [r for r in rows if r[1] == "declined"]
        if declined:
            return {"action": "blocked_declined", "id": declined[0][0]}
        same = sorted((r for r in rows if r[2] == ckey), key=lambda r: _PREFER.get(r[1], 9))
        if same:
            res = _merge(cur, same[0], kind=kind, sig=sig, payload=payload,
                         proposal=proposal, reason=reason, actor=source_agent)
            c.commit()
            return res
        wider = [r for r in rows if r[1] == "parked"]
        if wider:
            return {"action": "blocked_parked", "id": wider[0][0]}

        if kind == "catalog_kpi":
            payload = canonical.merge_payload(kind, {}, payload)
        cur.execute(
            """insert into proposals
               (source_agent, kind, target, model_id, dedup_key, canonical_key, need_id,
                signals, proposal, reason, expected_outcome, how_used, worked_examples,
                needs_enrichment, payload)
               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) returning id""",
            (source_agent, kind, target, model_id, dedup_key(kind, target, variant or ckey),
             ckey, need_id, json.dumps([sig]), proposal.strip(), reason, expected_outcome,
             grounded_how_used(kind), json.dumps(examples), not enriched,
             json.dumps(payload, default=str)))
        pid = cur.fetchone()[0]
        _event(cur, pid, "captured", to_status="pending", actor=source_agent,
               detail=f"{kind} / {target} ({ckey})")
        c.commit()
        return {"action": "created", "id": pid}


def _merge(cur, row, *, kind: str, sig: str, payload: dict, proposal: str,
           reason: str | None, actor: str) -> dict:
    """Fold a re-proposal into the row that already holds its decision.

    A new signal raises the evidence; the same signal again only refreshes
    last_seen (which keeps it from expiring). While the decision is still open the
    payload merges, so a KPI raised for a second sub-sector gains that scope rather
    than losing it. The newest wording wins only while the row is pending and
    un-enriched: once decided or enriched, the admin must be deciding on the words
    they actually read.
    """
    pid, status, _, ev, signals, old_payload = row
    signals = list(signals or [])
    grew = sig not in signals
    if grew:
        signals.append(sig)
    new_ev = max(len(signals), 1)
    open_ = status in {"pending", "parked", "expired"}
    merged = canonical.merge_payload(kind, old_payload, payload) if open_ else (old_payload or {})
    cur.execute(
        """update proposals
           set signals = %s, evidence_count = %s, last_seen = now(), payload = %s,
               status = %s,
               proposal = case when status='pending' and needs_enrichment
                               then %s else proposal end,
               reason = case when status='pending' and needs_enrichment
                             then coalesce(%s, reason) else reason end
           where id=%s""",
        (json.dumps(signals), new_ev, json.dumps(merged, default=str),
         "pending" if status == "expired" else status, proposal.strip(), reason, pid))
    if status == "expired":
        _event(cur, pid, "revived", from_status="expired", to_status="pending", actor=actor,
               detail=f"re-raised ({sig}), so its trigger is back")
    if grew:
        scope = merged.get("applies_to") if kind == "catalog_kpi" else None
        _event(cur, pid, "evidence_bumped", actor=actor,
               detail=f"new supporting signal {sig}; evidence {ev} -> {new_ev}"
                      + (f"; scope now {scope}" if scope else ""))
    action = ("revived" if status == "expired" else "blocked_parked" if status == "parked"
              else "bumped" if grew else "seen")
    return {"action": action, "id": pid, "evidence_count": new_ev}


def catalogue_codes(cur) -> list[str]:
    """Every live KPI code: the table (which holds approved additions) plus the
    curated file ingestion reads."""
    from .sources import catalog
    cur.execute("select metric_code from metric_catalog")
    return sorted({r[0] for r in cur.fetchall()} | {m["metric_code"] for m in catalog.load()})


def decided_keys(kind: str, statuses: tuple = ("declined",),
                 need_id: str | None = None) -> list[str]:
    """Canonical keys of this kind already decided (optionally for one need), so an
    agent's prompt can say what the owner has already turned down."""
    if not db.have_db():
        return []
    backfill_canonical()
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select distinct canonical_key from proposals "
                    "where kind=%s and status = any(%s) and canonical_key is not null "
                    "and (%s::text is null or need_id = %s)",
                    (kind, list(statuses), need_id, need_id))
        return sorted(r[0] for r in cur.fetchall())


_BACKFILLED = False


def backfill_canonical(force: bool = False) -> dict:
    """Give every proposal its canonical key, need and signals (ADR-044).

    Idempotent: only rows without a canonical_key are touched. capture() runs it
    first in every process, so the declined block covers the legacy synonyms before
    any agent writes. evidence_count is recomputed as the number of distinct signals,
    and the change is audited per row: 99, 94 and 87 "evidence" on ids 60, 63 and 67
    were nights the check fired, not support. A legacy KPI row with no scope gets the
    one its original taxonomy_changes text named, as an INFERRED scope, and an
    undecided row's how_used is replaced by the grounded one (decided rows keep the
    words the admin actually read).
    """
    global _BACKFILLED
    if (_BACKFILLED and not force) or not db.have_db():
        return {"skipped": True}
    n = 0
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id from data_needs")
        need_ids = {r[0] for r in cur.fetchall()}
        cur.execute("select id, kind, target, proposal, payload, need_id, evidence_count, "
                    "status from proposals where canonical_key is null order by id")
        for pid, kind, target, proposal, payload, need_id, ev, status in cur.fetchall():
            p = dict(payload or {})
            if (kind == "catalog_kpi" and not canonical.scope_list(p)
                    and not p.get("inferred_scope")):
                cur.execute("select change from taxonomy_changes "
                            "where kind='catalog_proposal' and target=%s", (target,))
                found = [x for x in dict.fromkeys(_infer_scope(r[0]) for r in cur.fetchall()) if x]
                found = found or [x for x in [_infer_scope(proposal)] if x]
                if found:
                    p["inferred_scope"] = "; ".join(found)
            nid = need_id or _legacy_need(kind, target, p, need_ids)
            sigs = _legacy_signals(kind, target, p, nid)
            key = canonical.canonical_key(kind, target, p, nid)
            how = grounded_how_used(kind) if status in {"pending", "parked"} else None
            cur.execute(
                "update proposals set canonical_key=%s, need_id=%s, signals=%s, "
                "evidence_count=%s, payload=%s, how_used=coalesce(%s, how_used) where id=%s",
                (key, nid, json.dumps(sigs), max(len(sigs), 1), json.dumps(p, default=str),
                 how, pid))
            _event(cur, pid, "rekeyed", actor="backfill",
                   detail=f"canonical key {key}; evidence {ev} -> {max(len(sigs), 1)} "
                          "(distinct signals, ADR-044)")
            n += 1
        c.commit()
    _BACKFILLED = True
    return {"rekeyed": n}


def _legacy_need(kind: str, target: str, p: dict, need_ids: set) -> str | None:
    if kind == "quality_check":
        return f"quality:{p.get('fires_for') or target}"
    if kind == "source_adapter":
        return (p.get("need") or {}).get("id") if isinstance(p.get("need"), dict) else None
    if kind == "catalog_kpi":
        return (canonical.kpi_need(target, need_ids)
                or ("sector_kpi_xbrl" if p.get("xbrl_verified") else "sector_kpi_non_xbrl"))
    return None


def _legacy_signals(kind: str, target: str, p: dict, need_id: str | None) -> list[str]:
    if kind == "quality_check":
        return [f"check:{p.get('fires_for') or target}"]
    if kind == "catalog_kpi":
        scopes = canonical.scope_list(p) or canonical.scope_list({"applies_to": p.get("inferred_scope")})
        return [f"sub_sector:{s}" for s in scopes]
    if kind == "source_adapter" and need_id:
        return [f"need:{need_id}"]
    return []


def _event(cur, proposal_id: int, event: str, *, from_status: str | None = None,
           to_status: str | None = None, actor: str = "system", detail: str = "") -> None:
    cur.execute(
        "insert into proposal_events(proposal_id,event,from_status,to_status,actor,detail) "
        "values (%s,%s,%s,%s,%s,%s)",
        (proposal_id, event, from_status, to_status, actor, (detail or "")[:2000]))


# --------------------------------------------------------------------------- #
# enrich — produce the fixed 4-part format
# --------------------------------------------------------------------------- #

# What the code ACTUALLY reads, per kind, taken from the code on 2026-11-05. how_used
# is built from this list and nothing else: the agents, left to describe consumers
# themselves, named ones that do not exist ("ESG scoring engine", "Pricing-Power
# Factor"). Update it when a real consumer lands; the enricher can only pick from it.
CONSUMERS = {
    "catalog_kpi": {
        "ingestion": "EDGAR and ESEF ingestion (engine/sources/edgar.py, esef.py), which "
                     "collect a KPI by its XBRL tags as listed in engine/sources/metric_catalog.json",
        "validation": "catalogue validation (engine/sectoragent/validate.py), which checks "
                      "that in_xbrl KPIs in metric_catalog.json resolve to sane values",
        "console": "the review console (dashboard/admin.js), which shows the metric_catalog row",
    },
    "quality_check": {
        "quality_score": "the data-quality score and the data_quality_issues feed "
                         "(engine/quality.py), on every daily pipeline run",
        "picks": "Top picks and the stock screener, which leave out companies with an open "
                 "issue from a check in picks.EXCLUDE_CHECKS, so a new check counts only once "
                 "it is added there (engine/picks.py via engine/pipeline.py, and "
                 "engine/screenjobs.py)",
        "triage": "Quality-Triage (engine/qualitytriage.py), which reads the checks that fire most",
        "daily_plan": "the daily plan signals (engine/dailyplan.py), which report the quality score",
    },
    "source_adapter": {
        "probe": "the data pipeline's source probe (engine/dataagent/agent.py), which scores "
                 "adapters per need and sets data_needs.active_source_id",
        "routing": "adapter routing (engine/sources/adapters.py active_adapter), which "
                   "ingestion asks for a need's source",
    },
    "model_routing": {
        "llm": "the model waterfall (engine/llm.py), through the MODEL_<ROLE>_CHAIN env vars",
    },
}
_CONSUMER_CAVEAT = {
    "catalog_kpi": "Approving writes the metric_catalog table, which ingestion does not read "
                   "(it reads metric_catalog.json), and no score reads a sector KPI today "
                   "(engine/stockvaluation.py and engine/growthhistory.py use core line "
                   "items only).",
    "quality_check": "All of this only once the check's code is merged and it writes "
                     "data_quality_issues.",
    "source_adapter": "All of this only once the adapter is written and registered in "
                      "engine/sources/adapters.py.",
    "model_routing": "Only after the env var is set and the job redeployed.",
}


def grounded_how_used(kind: str, ids=None) -> str:
    """how_used, from CONSUMERS only. `ids` is the enricher's pick: None, or only
    unknown names, means every real consumer of the kind; [] means none of them."""
    menu = CONSUMERS.get(kind, {})
    picked = [i for i in ids if i in menu] if isinstance(ids, list) else None
    if picked is None or (ids and not picked):
        picked = list(menu)
    head = ("Read by: " + "; ".join(menu[i] for i in picked) + ".") if picked else \
        "Nothing in the code reads this yet; it would only be recorded."
    return f"{head} {_CONSUMER_CAVEAT.get(kind, '')}".strip()


_ENRICH_SYSTEM = (
    "You prepare agent proposals for review by a non-engineer product owner of a "
    "global equity valuation system. Rewrite the raw proposal into PLAIN ENGLISH a "
    "smart reader with no knowledge of this codebase can decide on. Be concrete and "
    "honest; if the proposal is vague or looks low-value, say so in the reason.\n"
    "Return ONLY a JSON object with exactly these keys:\n"
    '  "proposal": one or two sentences — what would change, stated as an action. '
    "If the context names a sub-sector or scope, keep it in the sentence.\n"
    '  "reason": why the agent raised it — the underlying problem, and what breaks '
    "today if nothing is done. Be specific about the problem, never restate the "
    'proposal. "LLM sub-sector KPI proposal" is the kind of non-answer that makes '
    "a proposal impossible to decide on.\n"
    '  "expected_outcome": what measurably improves if this is approved, and how we '
    "would know. Name the metric or behaviour, not a vague benefit.\n"
    '  "consumers": the ids, from the `consumers` object in the context, of what '
    "would actually read this once it exists. Pick ONLY from that object; it is the "
    "complete list of real consumers in the code. If none would, return []. The "
    "owner reads the list's own wording, so never describe a consumer yourself.\n"
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

    Two things it must not lose (ADR-044). The scope: a legacy KPI row's sub-sector
    lived only in its prose ("propose for Telecom: ..."), which this rewrite used to
    overwrite, so approval later wrote applies_to='all'. It is saved into the payload
    as an inferred scope first. And how_used: built from CONSUMERS, not the model's
    words.
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
        payload = dict(payload or {})
        if (kind == "catalog_kpi" and not canonical.scope_list(payload)
                and not payload.get("inferred_scope") and _infer_scope(proposal)):
            payload["inferred_scope"] = _infer_scope(proposal)
        ctx = json.dumps({"source_agent": agent, "kind": kind, "target": target,
                          "raw_proposal": proposal, "raw_reason": reason,
                          "context": payload, "consumers": CONSUMERS.get(kind, {})},
                         default=str)[:6000]
        try:
            txt, model_id = llm.call_with_model(model_role, _ENRICH_SYSTEM, ctx,
                                                max_tokens=1600, json_mode=True)
            obj = json.loads(txt)
            if not isinstance(obj, dict):
                raise ValueError("model reply is not a JSON object")
        except Exception as e:  # noqa: BLE001 — one bad row must not stop the batch
            failed.append({"id": pid, "error": str(e)[:160]})
            continue

        examples = obj.get("worked_examples")
        if not isinstance(examples, list):
            examples = []
        # A row is only "enriched" if it actually gained the fields that make it
        # decidable. how_used no longer depends on the model, so it cannot be the
        # missing piece.
        complete = bool(obj.get("reason") and obj.get("expected_outcome"))
        with db.connect() as c, c.cursor() as cur:
            cur.execute(
                """update proposals set proposal=coalesce(nullif(%s,''), proposal),
                       reason=%s, expected_outcome=%s, how_used=%s, worked_examples=%s,
                       needs_enrichment=%s, model_id=coalesce(model_id,%s), payload=%s
                   where id=%s""",
                ((obj.get("proposal") or "").strip(), obj.get("reason"),
                 obj.get("expected_outcome"), grounded_how_used(kind, obj.get("consumers")),
                 json.dumps(examples), not complete, model_id,
                 json.dumps(payload, default=str), pid))
            _event(cur, pid, "enriched", actor=f"enricher/{model_id}",
                   detail=f"{len(examples)} worked example(s)"
                          + ("" if complete else "; INCOMPLETE, reason or outcome missing, will retry"))
            c.commit()
        (done if complete else failed).append(
            pid if complete else {"id": pid, "error": "model omitted reason or outcome"})
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
    """Add a KPI to the live metric_catalog table, or leave an existing one alone.

    NO CLOBBER (ADR-044). On 31 Oct 2026 approving proposal #7 (capacity_utilization,
    a code already in the catalogue) overwrote the curated row: label, applies_to
    (a list of materials and refining industries became "all"), category,
    importance and source_if_not_xbrl. It was restored by hand from
    metric_catalog.json. A code that already exists is now never written: approval
    appends a note and reports "already in catalogue, no change". That includes a
    scope the approver typed, which is recorded in the note rather than applied;
    a curated row is edited by hand or in metric_catalog.json, not by an approval.
    The console path (applyCatalogKpi in supabase/functions/admin/index.ts) does
    the same.

    New KPIs land as `computed` unless the payload carries XBRL tags that a
    deterministic check VERIFIED (xbrl_verified, set by sectoragent/research.py). A
    model's guess is not enough: 5 of the 7 tagged payloads on 31 Oct named concepts
    no cached issuer files, and an unverified guess is how the catalog got 7 metrics
    auto-demoted for returning the wrong concept (engine/sectoragent/validate.py).

    Scope resolution is deliberately explicit about provenance. "all" is a real
    decision (collect this for every company), not a neutral fallback, so where
    it came from is written into `notes` and echoed in the returned detail.

    `override` is the scope the approver typed in the console, and it outranks
    everything: a guess read out of the agent's prose is still a guess, whereas
    this is the human saying what they meant. It is a typed field rather than
    something parsed back out of `note`, because inferring meaning from free
    text is the exact failure this argument exists to fix.
    """
    tags = list(payload.get("xbrl_tags") or []) if payload.get("xbrl_verified") else []
    in_xbrl = bool(tags)
    declared = (payload.get("applies_to") or payload.get("sector")
                or payload.get("proposed_for_sub_sector"))
    chosen = (override or "").strip() or None
    inferred = None if (chosen or declared) else (payload.get("inferred_scope")
                                                  or _infer_scope(proposal))
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
        cur.execute("select metric_code from metric_catalog where metric_code=%s", (target,))
        created = None
        if cur.fetchone() is None:
            cur.execute(
                """insert into metric_catalog
                     (metric_code, label, definition, unit, category, applies_to, in_xbrl,
                      xbrl_tags, source_if_not_xbrl, importance, notes)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (metric_code) do nothing
                   returning metric_code""",
                (target, payload.get("label") or target.replace("_", " ").title(),
                 payload.get("definition"), payload.get("unit") or "ratio",
                 payload.get("category") or "sector_kpi", scope,
                 in_xbrl, json.dumps(tags),
                 None if in_xbrl else "computed", payload.get("importance") or "medium",
                 prov))
            created = cur.fetchone()
        if created is None:
            # Already there (or inserted by someone else a moment ago): curated
            # fields stay exactly as they are. Only a note is appended.
            extra = "approved again via agent proposal: already in catalogue, no change"
            if chosen:
                extra += f' · approver\'s scope "{chosen}" recorded here, not applied'
            if note.strip():
                extra += f' · approver\'s note: "{note.strip()[:400]}"'
            cur.execute(
                "update metric_catalog set notes = case when coalesce(notes,'') = '' "
                "then %s else notes || ' | ' || %s end where metric_code=%s",
                (extra, extra, target))
            c.commit()
            return (f"already in catalogue, no change: {target} keeps its curated label, "
                    "scope, category, importance and source; a note was appended")
        c.commit()
    how = ("set by you at approval" if chosen else "declared" if declared
           else "inferred from the text" if inferred else "defaulted")
    detail = (f'metric_catalog row added: {target} — applies_to="{scope}" ({how}), '
              f"in_xbrl={in_xbrl}")
    if not in_xbrl:
        # Saying "the next data run collects it" would be false: nothing fetches
        # a metric with no XBRL tags until someone writes the formula.
        detail += " — no verified XBRL tags, so nothing collects it yet"
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
    to clear park_min_evidence. last_seen restarts, so a proposal resurfaced today
    is not expired tonight for having been parked a long time.

    Parked NEEDS reopen on their date too (ADR-044), so the agents may propose
    against them again.
    """
    if not db.have_db():
        return {"skipped": "no db"}
    today = _dt.date.today()
    with db.connect() as c, c.cursor() as cur:
        cur.execute(
            """update proposals set status='pending', park_until=null, park_min_evidence=null,
                   last_seen=now()
               where status='parked'
                 and ((park_until is not null and park_until <= %s)
                   or (park_min_evidence is not null and evidence_count >= park_min_evidence))
               returning id, evidence_count""", (today,))
        rows = cur.fetchall()
        for pid, ev in rows:
            _event(cur, pid, "unparked", from_status="parked", to_status="pending",
                   actor="daily-pipeline", detail=f"evidence now {ev}")
        cur.execute(
            """update data_needs set status='open', updated_ts=now()
               where status='parked' and park_until is not null and park_until <= %s
               returning id""", (today,))
        needs = [r[0] for r in cur.fetchall()]
        c.commit()
    return {"unparked": [r[0] for r in rows], "needs_reopened": needs}


def expiry_reason(kind: str, target: str, payload: dict, need_id: str | None,
                  need_status: str | None, codes, last_seen, now, days: int,
                  checks) -> str | None:
    """Why a pending proposal's trigger is gone, or None if it still stands.

    * a quality proposal's firing check no longer exists (id 62 targeted a check
      retired under ADR-027; see the comment above check 7 in engine/quality.py);
    * a KPI proposal's code is now in the catalogue;
    * its need is answered_by_roadmap or met;
    * no agent re-raised it for `days` days.
    """
    if kind == "quality_check":
        fires = payload.get("fires_for") or (target if payload.get("legacy") else None)
        if fires and fires not in checks:
            return f"trigger gone: the check {fires} was retired"
    if kind == "catalog_kpi":
        code = canonical.resolve_kpi(target, codes)
        if code:
            return f"trigger gone: {code} is already in the catalogue"
    if need_status in {"answered_by_roadmap", "met"}:
        return f"trigger gone: its need {need_id} is {need_status}"
    if last_seen is not None and (now - last_seen).days >= days:
        return f"trigger gone: no agent re-raised it for {days} days"
    return None


def expire_stale(max_age_days: int | None = None) -> dict:
    """Expire pending proposals whose trigger is gone, each with an audit event.

    Nothing used to expire: Quality-Triage only looks at the top four firing checks,
    so a proposal about a check that stopped firing, or was retired, sat pending
    forever. An expired proposal an agent raises again is revived by capture().
    """
    if not db.have_db():
        return {"skipped": "no db"}
    from .quality import CHECKS
    # This runs daily, the agents (whose capture() re-keys) only on Wednesdays, and a
    # legacy row has no need_id until it is re-keyed.
    backfill_canonical()
    days = max_age_days or EXPIRY_DAYS
    now = _dt.datetime.now(_dt.timezone.utc)
    expired = []
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id, status from data_needs")
        needs = dict(cur.fetchall())
        codes = catalogue_codes(cur)
        cur.execute("select id, kind, target, payload, need_id, last_seen from proposals "
                    "where status='pending'")
        for pid, kind, target, payload, need_id, last_seen in cur.fetchall():
            why = expiry_reason(kind, target, payload or {}, need_id, needs.get(need_id),
                                codes, last_seen, now, days, CHECKS)
            if not why:
                continue
            cur.execute("update proposals set status='expired', action_detail=%s "
                        "where id=%s and status='pending'", (why, pid))
            _event(cur, pid, "expired", from_status="pending", to_status="expired",
                   actor="daily-pipeline", detail=why)
            expired.append(pid)
        c.commit()
    return {"expired": expired}


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

    Expiry runs after unpark, so a proposal resurfaced today is judged on today's
    triggers.
    """
    return {"unpark": unpark(), "expire": expire_stale(), "retry": retry_failed(),
            "enrich": enrich(limit=enrich_limit)}


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
    elif cmd == "rekey":
        print(json.dumps(backfill_canonical(force=True), indent=2))
    elif cmd == "maintenance":
        print(json.dumps(run_maintenance(), indent=2, default=str))
    elif cmd == "enrich":
        print(json.dumps(enrich(limit=int(sys.argv[2]) if len(sys.argv) > 2 else 6),
                         indent=2, default=str))
    else:
        with db.connect() as c, c.cursor() as cur:
            cur.execute("select status, count(*) from proposals group by 1 order by 2 desc")
            print(json.dumps(dict(cur.fetchall()), indent=2))
