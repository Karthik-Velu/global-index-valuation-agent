"""The sector KPI catalog: what fundamentals matter per sector and where each comes
from (an EDGAR XBRL concept vs. needs extraction). Seeded into `metric_catalog`.
"""
from __future__ import annotations

import json
from pathlib import Path

CATALOG_PATH = Path(__file__).parent / "metric_catalog.json"

# Canonical concept -> metric for the core financial-statement line items. These win
# over catalog order, so derived/ratio metrics (e.g. free_cash_flow_conversion,
# rd_intensity) that list a raw concept as a computation INPUT can't steal it from the
# real line item via first-wins ordering. (That collision is what left AAPL with no
# net_income — it reports NetIncomeLoss, which free_cash_flow_conversion had claimed.)
_CANONICAL: dict[str, str] = {
    # Top-line revenue (modern ASC 606 concepts + legacy)
    "RevenueFromContractWithCustomerExcludingAssessedTax": "total_revenue",
    "RevenueFromContractWithCustomerIncludingAssessedTax": "total_revenue",
    "Revenues": "total_revenue",
    "SalesRevenueNet": "total_revenue",
    # Profitability
    "NetIncomeLoss": "net_income",
    "OperatingIncomeLoss": "operating_income",
    "GrossProfit": "gross_profit",
    # Cash flow
    "NetCashProvidedByUsedInOperatingActivities": "operating_cash_flow",
    # Balance-sheet core
    "Assets": "total_assets",
    "StockholdersEquity": "total_equity",
    # --- IFRS equivalents (20-F/40-F foreign filers tag ifrs-full concepts; the
    # tag map is namespace-stripped, so these pin the same metric_codes and the
    # whole downstream — quality checks, scoring — works unchanged). Assets and
    # GrossProfit share their us-gaap names and are already pinned above.
    "Revenue": "total_revenue",
    "RevenueFromContractsWithCustomers": "total_revenue",
    "ProfitLossAttributableToOwnersOfParent": "net_income",
    "ProfitLoss": "net_income",
    "ProfitLossFromOperatingActivities": "operating_income",
    "CashFlowsFromUsedInOperatingActivities": "operating_cash_flow",
    "Equity": "total_equity",
    "EquityAttributableToOwnersOfParent": "total_equity",
}


def load() -> list[dict]:
    return json.loads(CATALOG_PATH.read_text())["metrics"]


def xbrl_tag_map() -> dict[str, str]:
    """XBRL concept (without namespace prefix) -> metric_code, for in_xbrl metrics.

    Canonical core line items are pinned first (and win); the rest of the catalog then
    claims remaining concepts in file order.
    """
    out: dict[str, str] = dict(_CANONICAL)
    for m in load():
        if m.get("in_xbrl"):
            for tag in m.get("xbrl_tags", []):
                concept = str(tag).split(":")[-1]
                out.setdefault(concept, m["metric_code"])  # won't override canonical
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
