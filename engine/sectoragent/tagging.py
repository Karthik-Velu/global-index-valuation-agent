"""Stock tagging — bootstrap each security's sector/sub-sector from its SEC SIC code
(free, in EDGAR submissions). LLM refinement of sub-sectors layers on later.
"""
from __future__ import annotations

import time

import requests

from .. import db
from ..sources.edgar import _HEADERS
from . import sic_map

_SUB_URL = "https://data.sec.gov/submissions/CIK{cik:010d}.json"


def _submission(cik: int) -> dict | None:
    r = requests.get(_SUB_URL.format(cik=int(cik)), headers=_HEADERS, timeout=20)
    return r.json() if r.status_code == 200 else None


def tag_securities(limit: int | None = None, sleep: float = 0.15) -> dict:
    stats = {"tagged": 0, "changed": 0, "unknown": 0}
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select id, ticker, cik from securities where cik is not null"
                    + (f" limit {int(limit)}" if limit else ""))
        rows = cur.fetchall()

    with db.connect() as conn:
        for sec_id, ticker, cik in rows:
            sub = _submission(int(cik))
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
