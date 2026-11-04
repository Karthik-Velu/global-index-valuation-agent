"""Optional LLM layer: research the KPIs that drive sub-sectors with thin coverage
or newly-emerged industries, and propose additions to the catalog. Cheap tier;
no-op without an API key (the deterministic tagging + validation always run).

By the model-routing strategy this runs on the T1 cheap/owned tier (Qwen/GLM/
DeepSeek) once the provider abstraction lands; today it uses engine/llm's cheap model.

Deterministic wherever it can be (ADR-044), because the 31 Oct 2026 queue review
found the same four sub-sectors back every night in new spellings, 22 of 73 KPI
rows duplicating the catalogue, and guessed XBRL tags trusted as fact:
  * which sub-sectors: thinnest catalogue coverage first, rotated weekly;
  * the prompt lists the catalogue's codes, and a KPI already there (or a synonym
    of one) is never raised;
  * XBRL tags are normalised to "ns:Concept" and count as verified only when a
    deterministic check confirms some issuer files them (the SEC frames API, behind
    XBRL_VERIFY=1). Offline they stay unverified, and a KPI with no verified tag is
    filed against the non-XBRL need, never raised as an XBRL proposal.
"""
from __future__ import annotations

import json
import os
import time
from datetime import date

from .. import canonical, db, llm, memory, proposals

KPI_NEED_XBRL = "sector_kpi_xbrl"
KPI_NEED_OTHER = "sector_kpi_non_xbrl"
_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/{ns}/{concept}/{unit}/{period}.json"


def rotate(rows: list[tuple[str, int]], k: int, week: int) -> list[str]:
    """Pick k sub-sectors from `rows`, [(sub_sector, coverage)], thinnest first.

    Inside each coverage tier the starting point moves on by k every week, so a tier
    of n sub-sectors is fully covered in ceil(n / k) weeks and no sub-sector waits
    longer than that. Same rows and week, same answer.
    """
    tiers: dict[int, list[str]] = {}
    for sub, cov in rows:
        tiers.setdefault(int(cov or 0), []).append(sub)
    out: list[str] = []
    for cov in sorted(tiers):
        tier = sorted(tiers[cov])
        start = (week * k) % len(tier)
        out += tier[start:] + tier[:start]
    return out[:k]


def thin_subsectors(cur, k: int, today: date | None = None) -> list[str]:
    """Coverage = catalogue KPIs whose applies_to names the sub-sector."""
    cur.execute("""select t.sub_sector, count(m.metric_code) as coverage
                   from (select distinct sub_sector from security_tags
                         where sub_sector is not null and sub_sector <> '') t
                   left join metric_catalog m
                     on position(lower(t.sub_sector) in lower(coalesce(m.applies_to, ''))) > 0
                   group by t.sub_sector
                   order by coverage, t.sub_sector""")
    return rotate(cur.fetchall(), k, (today or date.today()).toordinal() // 7)


def _sec_frame(ns: str, concept: str, unit: str, period: str) -> bool:
    """True if the SEC frames API holds any fact for this concept, unit and period."""
    import requests

    from ..sources.edgar import _headers   # the SEC user-agent helper (SEC_USER_AGENT)
    r = requests.get(_FRAMES_URL.format(ns=ns, concept=concept, unit=unit, period=period),
                     headers=_headers(), timeout=20)
    time.sleep(0.15)                       # SEC fair use: well under 10 requests/s
    return r.status_code == 200 and bool(r.json().get("data"))


def _verify_enabled() -> bool:
    return os.getenv("XBRL_VERIFY", "").strip().lower() in {"1", "true", "sec"}


def verify_tags(tags: list[str], fetch=None) -> list[str]:
    """The tags a deterministic check confirms that some issuer actually files.

    Off unless XBRL_VERIFY=1. Offline, with no SEC_USER_AGENT, or on any error the
    tag stays unverified, which is the safe side: the KPI goes to the non-XBRL need.
    A model's guess is never enough: 5 of the 7 tagged payloads on 31 Oct named
    concepts no cached issuer files (us-gaap:Sales, us-gaap:NetIncome, ...).
    """
    if not _verify_enabled():
        return []
    fetch = fetch or _sec_frame
    y = date.today().year - 1
    tries = (("USD", f"CY{y}"), ("USD", f"CY{y}Q4I"), ("shares", f"CY{y}Q4I"),
             ("pure", f"CY{y}"), ("USD-per-shares", f"CY{y}"))
    out = []
    for tag in tags:
        ns, concept = tag.split(":", 1)
        for unit, period in tries:
            try:
                if fetch(ns, concept, unit, period):
                    out.append(tag)
                    break
            except Exception:  # noqa: BLE001 — unreachable SEC leaves it unverified
                break
    return out


def research_thin_subsectors(max_subsectors: int = 4) -> dict:
    if not llm.LLM_ENABLED:
        return {"skipped": "no API key — deterministic tagging + validation still ran"}

    with db.connect() as c, c.cursor() as cur:
        cur.execute("select id, status from data_needs where kind='sector_kpi'")
        needs = dict(cur.fetchall())
        # Agents propose against open needs only. With nothing a KPI could be filed
        # against, the model is not even asked: the XBRL need takes only verified
        # tags, so with verification off it cannot take anything.
        xbrl_open = needs.get(KPI_NEED_XBRL) == "open" and _verify_enabled()
        if not (xbrl_open or needs.get(KPI_NEED_OTHER) == "open"):
            return {"skipped": "no open sector-KPI need in the register"
                               + ("" if _verify_enabled() else " (XBRL_VERIFY is off, so "
                                  "nothing can be filed against the XBRL need)")}
        subs = thin_subsectors(cur, max_subsectors)
        codes = proposals.catalogue_codes(cur)

    system = (
        "You are an equity analyst. For the given equity sub-sector, list up to 5 of the "
        "MOST important KPIs that drive its growth/quality and are NOT generic income-"
        "statement items. Each one will be read by a non-engineer product owner who "
        "approves or rejects adding it to the metric catalog, so justify it in plain "
        "English.\n"
        "These metric codes are ALREADY in the catalogue. Never propose one of them or a "
        f"synonym of one: {', '.join(codes)}.\n"
        'Return ONLY a JSON object: {"metrics": [ up to 5 of {"metric_code": snake_case, '
        '"label", "definition", "unit", "source_hint", "xbrl_tags": [exact '
        '"us-gaap:Concept" or "ifrs-full:Concept" names ONLY if you are certain, else '
        "omit; each is checked against real filings before it counts], "
        '"reason": "WHY this is being proposed — what we cannot currently see without '
        'it, and what decision goes wrong today as a result. Never restate the '
        'definition here.", '
        '"expected_outcome": "what measurably improves and how we would know", '
        '"worked_examples": [2-3 of {"situation","today","after"} naming real companies '
        "in this sub-sector] } ]}.\n"
        # The owner reads these fields before approving, so a non-answer in any of them
        # is what makes a decision blind (directive 2026-08-02). Named explicitly
        # because the pre-existing legacy proposals failed exactly here: reason was the
        # literal string "LLM sub-sector KPI proposal", which says nothing at all.
        "reason and expected_outcome are what the owner reads before approving. Vague "
        "or self-referential answers there make the proposal un-decidable — be "
        "concrete or say plainly that you are unsure."
    )
    researched = []
    for sub in subs:
        try:
            txt, model_id = llm.call_with_model("sector_research", system, sub,
                                                max_tokens=2000, json_mode=True)
            obj = json.loads(txt)
            data = [d for d in obj.get("metrics", obj if isinstance(obj, list) else [])
                    if isinstance(d, dict)]
            with db.connect() as c, c.cursor() as cur:
                for d in data:
                    cur.execute(
                        "insert into taxonomy_changes(kind,target,change,reason,auto) "
                        "values('catalog_proposal',%s,%s,'LLM sub-sector KPI proposal',true)",
                        (d.get("metric_code", ""), f"propose for {sub}: {d.get('label', '')}"))
                c.commit()
            # The reviewable decision, one per concept and sector (engine/canonical.py):
            # the same KPI from two sub-sectors of one sector is ONE decision with two
            # scopes, and tomorrow's respelling of it is the same decision again.
            outcome = []
            for d in data:
                code = d.get("metric_code")
                if not code:
                    continue
                if canonical.resolve_kpi(code, codes):
                    outcome.append({"code": code, "action": "in_catalogue"})
                    continue
                tags = [t for t in dict.fromkeys(canonical.xbrl_tag(x)
                                                 for x in d.get("xbrl_tags") or []) if t]
                verified = verify_tags(tags)
                need = (canonical.kpi_need(code, needs)
                        or (KPI_NEED_XBRL if verified else KPI_NEED_OTHER))
                res = proposals.capture(
                    source_agent="sector-research", kind="catalog_kpi", target=code,
                    model_id=model_id,
                    proposal=(f"Add `{code}` ({d.get('label', '')}) to the metric catalog "
                              f"for {sub}: {d.get('definition', '')}").strip(),
                    reason=d.get("reason"), expected_outcome=d.get("expected_outcome"),
                    worked_examples=d.get("worked_examples"),
                    payload={"label": d.get("label"), "definition": d.get("definition"),
                             "unit": d.get("unit"), "applies_to": sub,
                             "xbrl_tags": verified, "xbrl_verified": bool(verified),
                             "proposed_tags": [t for t in tags if t not in verified],
                             "source_hint": d.get("source_hint"),
                             "proposed_for_sub_sector": sub},
                    need_id=need, signal=f"sub_sector:{sub}")
                outcome.append({"code": code, "need": need, "action": res.get("action")})
            researched.append({"sub_sector": sub, "proposed": outcome})
            # Feed semantic memory: each proposed KPI becomes a candidate lesson.
            for d in data:
                if d.get("metric_code") and d.get("label"):
                    memory.capture(
                        f"sector_research:{sub}",
                        f"{d['label']} ({d['metric_code']}) — {d.get('definition', '')}".strip(),
                        kind="kpi", origin="sector-research agent", confidence=0.40,
                        test_hint=d.get("source_hint"))
        except Exception as e:
            researched.append({"sub_sector": sub, "error": str(e)[:140]})
    return {"researched": researched}
