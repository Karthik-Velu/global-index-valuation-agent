"""Stock tagging — bootstrap each security's sector/sub-sector from its SEC SIC code
(free, in EDGAR submissions). LLM refinement of sub-sectors layers on later.

Scope (D02, 2026-10-28): every security with no SIC tag yet, plus the ~1/30 of
already-tagged securities refreshed least recently. Tagging the whole ~3,100-name
universe every day cost 41-56 min of each run (one SEC call per security) and
pushed the monthly full sweep to 308 of GitHub's hard 360-min job limit, while
SIC codes almost never change. The rotation needs no cursor: a successful
upsert stamps updated_ts, so a security that fails or isn't reached today stays
at the head of tomorrow's queue. Because only a slice is re-fetched, every run
first re-applies sic_map to the SIC codes already stored (no SEC calls), so a
sic_map fix still reaches every security the next day, not over a month.
"""
from __future__ import annotations

import math
import os
import time

import requests

from .. import db
from ..sources.edgar import _headers
from . import sic_map

_SUB_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"


def _submission(cik: int) -> dict | None:
    r = requests.get(_SUB_URL.format(cik=int(cik)), headers=_headers(), timeout=20)
    return r.json() if r.status_code == 200 else None


ROTATION_DAYS = 30


def select_batch(untagged: list, tagged_oldest_first: list,
                 rotation_days: int = ROTATION_DAYS) -> tuple[list, int]:
    """Today's batch: all untagged securities, then the least recently refreshed
    1/rotation_days of the tagged ones. Returns (batch, rotation slice size)."""
    n_slice = math.ceil(len(tagged_oldest_first) / rotation_days) if rotation_days > 0 else 0
    return list(untagged) + list(tagged_oldest_first[:n_slice]), n_slice


def _budget_seconds() -> float | None:
    """Wall-clock cap (env TAGGING_BUDGET_MIN, default 55; 0 = none). A safety net
    for the monthly sweep: securities not reached keep their old stamp, so the
    rotation resumes with them next run."""
    try:
        minutes = float(os.environ.get("TAGGING_BUDGET_MIN", "55"))
    except ValueError:
        minutes = 55.0
    return minutes * 60 if minutes > 0 else None


def reclassify_stored() -> int:
    """Re-apply sic_map to every stored SIC tag; write only the ones whose
    sector/sub-sector changed. Leaves updated_ts alone (rotation order)."""
    n = 0
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("""select t.security_id, s.ticker, t.sic_code, t.sic_description,
                              t.sector, t.sub_sector
                       from security_tags t join securities s on s.id = t.security_id
                       where t.source = 'sic'""")
        for sec_id, ticker, sic, sicd, old_sector, old_sub in cur.fetchall():
            sector, sub_sector = sic_map.classify(sic)
            if (sector, sub_sector) == (old_sector, old_sub):
                continue
            industry = sicd or sub_sector
            cur.execute("update security_tags set sector=%s, sub_sector=%s, industry=%s "
                        "where security_id=%s and source='sic'",
                        (sector, sub_sector, industry, sec_id))
            cur.execute("update securities set sector=%s, industry=%s where id=%s",
                        (sector, industry, sec_id))
            cur.execute("insert into taxonomy_changes(kind,target,change,reason,auto) "
                        "values('tag',%s,%s,'SIC map change',true)",
                        (ticker, f"{sector} / {sub_sector} ({sicd})"))
            n += 1
        conn.commit()
    return n


def tag_securities(limit: int | None = None, sleep: float = 0.15) -> dict:
    stats = {"tagged": 0, "changed": 0, "unknown": 0, "fetch_errors": 0}
    if os.environ.get("GIVA_TAGGING", "").strip().lower() == "off":
        stats["skipped"] = "GIVA_TAGGING=off"
        return stats
    stats["reclassified"] = reclassify_stored()
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("""select s.id, s.ticker, s.cik, t.security_id is not null,
                              coalesce(t.updated_ts, t.asof::timestamptz)
                       from securities s
                       left join security_tags t on t.security_id = s.id and t.source = 'sic'
                       where s.cik is not null""")
        found = cur.fetchall()
    # Ordered here rather than in SQL so the rotation order is unit-tested:
    # untagged by id, then tagged least-recently-refreshed first.
    untagged = [r[:3] for r in sorted((r for r in found if not r[3]), key=lambda r: r[0])]
    tagged = [r[:3] for r in sorted((r for r in found if r[3]),
                                    key=lambda r: (r[4] is not None, r[4] or 0, r[0]))]
    rows, n_slice = select_batch(untagged, tagged)
    if limit:
        rows = rows[:int(limit)]
    stats["scope"] = {"new": len(untagged), "rotation": n_slice, "universe": len(found)}

    budget, t0 = _budget_seconds(), time.monotonic()
    with db.connect() as conn:
        for i, (sec_id, ticker, cik) in enumerate(rows):
            if budget is not None and time.monotonic() - t0 > budget:
                stats["budget_stopped"] = True
                stats["not_reached"] = len(rows) - i
                break
            # One slow SEC response used to kill the whole pipeline run (2026-10-02:
            # a 20s read timeout on a single CIK). A tag that
            # can't be fetched today is simply refreshed tomorrow — the same thing
            # the non-200 branch below already does — so skip it, but keep the
            # first error's text: a bare count can't be diagnosed from the log.
            try:
                sub = _submission(int(cik))
            except requests.RequestException as e:
                stats["fetch_errors"] += 1
                stats.setdefault("first_error", f"{ticker}: {str(e)[:160]}")
                continue
            if not sub:
                continue
            sic = sub.get("sic")
            sicd = sub.get("sicDescription")
            sector, sub_sector = sic_map.classify(sic)
            industry = sicd or sub_sector
            if sector == "Unknown":
                stats["unknown"] += 1
            with conn.cursor() as cur:
                cur.execute("select sector, sub_sector from security_tags "
                            "where security_id=%s and source='sic'", (sec_id,))
                prev = cur.fetchone()
                cur.execute(
                    """insert into security_tags
                       (security_id,sic_code,sic_description,sector,sub_sector,industry,source,confidence,asof)
                       values (%s,%s,%s,%s,%s,%s,'sic',0.7,current_date)
                       on conflict (security_id, source) do update set
                         sic_code=excluded.sic_code, sic_description=excluded.sic_description,
                         sector=excluded.sector, sub_sector=excluded.sub_sector,
                         industry=excluded.industry, updated_ts=now()""",
                    (sec_id, str(sic) if sic else None, sicd, sector, sub_sector, industry),
                )
                cur.execute("update securities set sector=%s, industry=%s where id=%s",
                            (sector, industry, sec_id))
                if prev is None or prev[0] != sector or prev[1] != sub_sector:
                    cur.execute(
                        "insert into taxonomy_changes(kind,target,change,reason,auto) "
                        "values('tag',%s,%s,'SIC classification',true)",
                        (ticker, f"{sector} / {sub_sector} ({sicd})"),
                    )
                    stats["changed"] += 1
            conn.commit()
            stats["tagged"] += 1
            time.sleep(sleep)
    return stats
