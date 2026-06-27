"""The sector KPI catalog: what fundamentals matter per sector and where each comes
from (an EDGAR XBRL concept vs. needs extraction). Seeded into `metric_catalog`.
"""
from __future__ import annotations

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "metric_catalog.json"


def load() -> list[dict]:
    return json.loads(CATALOG_PATH.read_text())["metrics"]


def xbrl_tag_map() -> dict[str, str]:
    """XBRL concept (without namespace prefix) -> metric_code, for in_xbrl metrics."""
    out: dict[str, str] = {}
    for m in load():
        if m.get("in_xbrl"):
            for tag in m.get("xbrl_tags", []):
                concept = str(tag).split(":")[-1]
                out.setdefault(concept, m["metric_code"])
    return out


def units_for() -> dict[str, str]:
    return {m["metric_code"]: m.get("unit", "") for m in load()}


def seed_db() -> int:
    from .. import db

    rows = load()
    with db.connect() as conn, conn.cursor() as cur:
        for m in rows:
            cur.execute(
                """insert into metric_catalog
                   (metric_code,label,definition,unit,category,applies_to,in_xbrl,
                    xbrl_tags,source_if_not_xbrl,importance,notes)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   on conflict (metric_code) do update set
                     label=excluded.label, definition=excluded.definition, unit=excluded.unit,
                     category=excluded.category, applies_to=excluded.applies_to,
                     in_xbrl=excluded.in_xbrl, xbrl_tags=excluded.xbrl_tags,
                     source_if_not_xbrl=excluded.source_if_not_xbrl,
                     importance=excluded.importance, notes=excluded.notes""",
                (m["metric_code"], m.get("label"), m.get("definition"), m.get("unit"),
                 m.get("category"), m.get("applies_to"), bool(m.get("in_xbrl")),
                 json.dumps(m.get("xbrl_tags", [])), m.get("source_if_not_xbrl"),
                 m.get("importance"), m.get("notes")),
            )
        conn.commit()
        cur.execute("select count(*) from metric_catalog")
        return cur.fetchone()[0]
