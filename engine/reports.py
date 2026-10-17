"""Company financial statements for one security — the deterministic data job
behind the dashboard's "Key reports" section (no LLM anywhere in this module).

Reads Tier B `fundamental_metrics` (EDGAR XBRL, public domain, every restatement
vintage kept) for ONE security and emits a clean, provenance-tagged JSON of:

  * annual (FY) statements,
  * the last N DISCRETE quarters (default 8) plus a trailing-twelve-month roll,
  * balance-sheet snapshots,
  * derived margins and YoY FUNDAMENTAL growth (revenue / earnings — never
    share-price performance, per the project's hard rule),
  * a restatement log and an explicit list of data gaps.

Why this needs care — three traps in the raw store, each handled explicitly:

1. Filing vintages. The same period is reported again (as a comparative) by
   later filings, so one (concept, period_end) can carry several values. We take
   the LATEST filed value — except when the later filing merely ROUNDS the
   earlier one (CoreWeave switched from thousands to millions in its 2026
   filings: 981,600k -> 982M). That is not a restatement, and keeping the coarser
   number would leak rounding error into every quarter derived by subtraction,
   so the more precise earlier value is kept and the later one recorded as
   confirmation. A genuine change beyond rounding is a restatement: latest wins
   and the original is logged in `restatements`.

2. YTD-cumulative 10-Q flows. A 10-Q's cash-flow statement is year-to-date only,
   and the ingestion key (security, period_end, fiscal_period, metric, source,
   filed_date — engine/sources/edgar.py) has no duration column, so when a 10-Q
   tags both the 3-month and the year-to-date fact for its own period end, only
   the first one in EDGAR's companyfacts order survives. companyfacts lists a
   concept's facts start-date-ascending, so the survivor is the LONGEST
   (year-to-date) duration. Flow rows are therefore read as YTD and de-cumulated:
   Q1 = YTD3, Q2 = YTD6 - YTD3, Q3 = YTD9 - YTD6, Q4 = FY - YTD9. Verified for
   CRWV revenue against the company's press-release quarterlies (see
   tests/test_reports_engine.py for the synthetic proof of the arithmetic).

3. Odd fiscal_period labels. `fiscal_period` is the label of the FILING the fact
   came from, not of the fact's own period: period_end 2024-06-30 labelled "Q3"
   is the discrete prior-quarter roll-forward from the equity statement of a
   later Q3 10-Q, NOT a 9-month YTD figure. So rows are keyed on period_end plus
   an inferred duration: a flow row is used only when its label equals the
   period's NATURAL position in the fiscal year (a Jun-30 end is the 6-month YTD
   point for a December year-end company). Misaligned rows are never summed; they
   are used only to corroborate the derived discrete quarters. Balance-sheet
   (instant) rows have no duration, so their label is irrelevant.

Per-share flows (EPS, DPS) are not additive across quarters (the share count
moves), so they are reported as filed (YTD) and never de-cumulated; Q1 is the
only quarter where the YTD EPS is also the discrete EPS.

CLI:
  python -m engine.reports financials CRWV [--security-id 5913] [--tierb PATH]
      [--quarters 8] [--out dashboard/reports/data/crwv_financials.json]
"""
from __future__ import annotations

import json
import os
from collections import defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path

from . import tierb

# Forms whose XBRL describes the company's own periodic statements. Proxy
# statements (DEF 14A) re-tag a rounded net income for pay-vs-performance tables;
# letting that "later vintage" win would silently replace the audited 10-K value.
PERIODIC_FORMS = {"10-K", "10-K/A", "10-KT", "10-Q", "10-Q/A", "20-F", "20-F/A",
                  "40-F", "40-F/A"}

# XBRL concept -> (report field, kind). Keyed on the CONCEPT (raw_tag), not the
# metric_code: several catalog metric codes are composites whose raw rows are a
# component (e.g. `inventory_and_days` rows are CostOfGoodsAndServicesSold,
# `ppe_net` rows are AccumulatedDepreciation...), so the concept is the only
# unambiguous label of what a number is. Earlier entries win for a field when a
# company tags more than one synonym for the same period.
#   kind: "flow" = period total (YTD in 10-Qs, de-cumulated here)
#         "per_share" = period per-share figure (reported as filed, not additive)
#         "instant" = balance-sheet snapshot
CONCEPTS: dict[str, tuple[str, str]] = {
    "RevenueFromContractWithCustomerExcludingAssessedTax": ("revenue", "flow"),
    "Revenues": ("revenue", "flow"),
    "CostOfRevenue": ("cost_of_revenue", "flow"),
    "CostOfGoodsAndServicesSold": ("cost_of_revenue", "flow"),
    "GrossProfit": ("gross_profit_reported", "flow"),
    "ResearchAndDevelopmentExpense": ("rd_expense", "flow"),
    "OperatingIncomeLoss": ("operating_income", "flow"),
    "InterestExpense": ("interest_expense", "flow"),
    "InterestExpenseNonoperating": ("interest_expense", "flow"),
    "NetIncomeLoss": ("net_income", "flow"),
    "Depreciation": ("depreciation", "flow"),
    "DepreciationDepletionAndAmortization": ("depreciation", "flow"),
    "DepreciationAndAmortization": ("depreciation", "flow"),
    "ShareBasedCompensation": ("sbc", "flow"),
    "NetCashProvidedByUsedInOperatingActivities": ("operating_cash_flow", "flow"),
    "PaymentsToAcquirePropertyPlantAndEquipment": ("capex", "flow"),
    "PaymentsForRepurchaseOfCommonStock": ("buybacks", "flow"),
    "PaymentsOfDividends": ("dividends_paid", "flow"),
    "EarningsPerShareBasic": ("eps_basic", "per_share"),
    "EarningsPerShareDiluted": ("eps_diluted", "per_share"),
    "CommonStockDividendsPerShareDeclared": ("dps_declared", "per_share"),
    "WeightedAverageNumberOfDilutedSharesOutstanding": ("shares_diluted_wavg", "per_share"),
    "WeightedAverageNumberOfSharesOutstandingBasic": ("shares_basic_wavg", "per_share"),
    "CashAndCashEquivalentsAtCarryingValue": ("cash", "instant"),
    "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents":
        ("cash_incl_restricted", "instant"),
    "ContractWithCustomerLiability": ("deferred_revenue", "instant"),
    "ContractWithCustomerLiabilityCurrent": ("deferred_revenue_current", "instant"),
    "AccountsPayableCurrent": ("accounts_payable", "instant"),
    "AccumulatedDepreciationDepletionAndAmortizationPropertyPlantAndEquipment":
        ("accumulated_depreciation", "instant"),
    "PropertyPlantAndEquipmentNet": ("ppe_net", "instant"),
    "Assets": ("total_assets", "instant"),
    "LongTermDebt": ("long_term_debt", "instant"),
    "LongTermDebtNoncurrent": ("long_term_debt_noncurrent", "instant"),
    "LongTermDebtCurrent": ("long_term_debt_current", "instant"),
    "FinanceLeaseLiability": ("finance_lease_liability", "instant"),
    "StockholdersEquity": ("total_equity", "instant"),
    "RevenueRemainingPerformanceObligation": ("rpo", "instant"),
    "CommonStockSharesOutstanding": ("shares_outstanding", "instant"),
}

# Fields a fund-house statement pack expects; any not found become explicit gaps
# (a missing line must read as "not in the XBRL store", never as zero).
EXPECTED_FIELDS = ("revenue", "cost_of_revenue", "operating_income", "interest_expense",
                   "net_income", "depreciation", "sbc", "operating_cash_flow", "capex",
                   "eps_basic", "eps_diluted", "shares_diluted_wavg", "cash",
                   "long_term_debt", "finance_lease_liability", "total_assets",
                   "total_equity", "rpo", "shares_outstanding")

_YTD_LABEL = {3: "Q1", 6: "Q2", 9: "Q3", 12: "FY"}


# --------------------------------------------------------------------------- io
@contextmanager
def _store(path: str | os.PathLike | None):
    """Point tierb at an explicit store (e.g. a snapshot) for the duration.

    tierb.root() reads TIERB_ROOT on every call by design (one switch for every
    call site), so overriding the env var is the supported way to aim the shared
    reader + dedupe view at another store without forking that logic here.
    """
    if not path:
        yield
        return
    old = os.environ.get("TIERB_ROOT")
    os.environ["TIERB_ROOT"] = str(path)
    try:
        yield
    finally:
        if old is None:
            os.environ.pop("TIERB_ROOT", None)
        else:
            os.environ["TIERB_ROOT"] = old


def load_rows(security_id: int, store=None) -> list[dict]:
    """Every fundamental_metrics row (all vintages) for one security, via the
    shared Tier B reader so dedupe semantics match the rest of the engine."""
    with _store(store):
        if not tierb.have_tierb():
            raise FileNotFoundError(f"no Tier B fundamental_metrics under {tierb.root()}")
        con = tierb.connect()
        cur = con.execute(
            "select period_end, fiscal_period, metric_code, value, unit, report_type, "
            "filed_date, raw_tag from fundamental_metrics where security_id = ? "
            "order by raw_tag, period_end, filed_date", [int(security_id)])
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in cur.fetchall()]


def resolve_security(ticker_or_id: str, security_id: int | None = None) -> dict:
    """(id, ticker, name) — explicit id wins; otherwise the Postgres securities
    table (the authoritative ticker map; Tier B carries ids only)."""
    if security_id is None and str(ticker_or_id).isdigit():
        security_id = int(ticker_or_id)
    try:
        from . import db
        if db.have_db():
            with db.connect() as conn, conn.cursor() as cur:
                if security_id is not None:
                    cur.execute("select id, ticker, name from securities where id = %s",
                                (security_id,))
                else:
                    cur.execute("select id, ticker, name from securities where upper(ticker) = %s "
                                "order by id limit 1", (str(ticker_or_id).upper(),))
                row = cur.fetchone()
                if row:
                    return {"security_id": int(row[0]), "ticker": row[1], "name": row[2]}
    except Exception as e:  # offline is fine when the id was supplied
        if security_id is None:
            raise RuntimeError(f"cannot resolve {ticker_or_id!r}: {e}") from e
    if security_id is None:
        raise RuntimeError(f"cannot resolve {ticker_or_id!r} without DATABASE_URL — "
                           "pass --security-id")
    return {"security_id": int(security_id),
            "ticker": None if str(ticker_or_id).isdigit() else str(ticker_or_id).upper(),
            "name": None}


# ------------------------------------------------------------------ primitives
def _d(x) -> date:
    return x if isinstance(x, date) else date.fromisoformat(str(x)[:10])


def _eff_ym(pe: date) -> tuple[int, int]:
    """(year, month) a period end belongs to; 52/53-week filers end e.g. on
    Jun-28 or Jul-2, so an end in the first half of a month counts as the prior
    month."""
    if pe.day >= 15:
        return pe.year, pe.month
    return (pe.year - 1, 12) if pe.month == 1 else (pe.year, pe.month - 1)


def fiscal_year_end_month(rows: list[dict]) -> int:
    """Most common month of 10-K FY period ends (default December)."""
    counts: dict[int, int] = defaultdict(int)
    for r in rows:
        if r["fiscal_period"] == "FY" and str(r["report_type"]).startswith(("10-K", "20-F", "40-F")):
            counts[_eff_ym(_d(r["period_end"]))[1]] += 1
    return max(counts, key=counts.get) if counts else 12


def ytd_months(pe: date, fye_month: int) -> int:
    """Months from fiscal-year start to `pe` (3 / 6 / 9 / 12 for quarter ends)."""
    return (_eff_ym(pe)[1] - fye_month - 1) % 12 + 1


def fiscal_year(pe: date, fye_month: int) -> int:
    """Fiscal year a period end falls in, named by the calendar year it ends in."""
    y, m = _eff_ym(pe)
    return y if m <= fye_month else y + 1


def _scale(v: float) -> float:
    """Reporting precision of a value: the largest of 1e6/1e5/1e4/1e3 dividing it."""
    for s in (1e6, 1e5, 1e4, 1e3):
        if abs(v) >= s and abs(v - round(v / s) * s) < 1e-6:
            return s
    return 1.0


def pick_vintage(cands: list[dict], kind: str) -> tuple[dict, dict | None]:
    """Choose one row among a period's vintages -> (chosen, restatement|None).

    Latest filed wins, except that a later value which is only a ROUNDING of an
    earlier, more precise value keeps the precise one (see module docstring §1).
    """
    cands = sorted(cands, key=lambda r: (_d(r["filed_date"]), r["value"]))
    latest = cands[-1]
    if len(cands) == 1:
        return dict(latest), None
    tol_abs = 0.005 if kind == "per_share" else None
    best = dict(latest)
    restated = None
    for prev in reversed(cands[:-1]):
        diff = abs(prev["value"] - latest["value"])
        if kind == "per_share":
            if diff <= tol_abs:
                continue
        else:
            s = _scale(latest["value"])
            if diff <= s / 2 + 1e-6:
                if _scale(prev["value"]) < _scale(best["value"]):
                    best = dict(prev)
                    best["confirmed_filed"] = str(_d(latest["filed_date"]))
                continue
        if restated is None:
            restated = {"original_value": prev["value"], "original_filed": str(_d(prev["filed_date"])),
                        "restated_value": latest["value"],
                        "restated_filed": str(_d(latest["filed_date"]))}
    return best, restated


# ---------------------------------------------------------------------- core
def build_financials(rows: list[dict], quarters: int = 8) -> dict:
    """Pure transform: raw Tier B rows for ONE security -> statements dict.

    Kept free of I/O so the synthetic-fixture tests exercise exactly the code
    path the CLI runs on real data.
    """
    fye = fiscal_year_end_month(rows)
    ignored_forms: dict[str, int] = defaultdict(int)
    unmapped: dict[str, int] = defaultdict(int)
    inventory: dict[tuple, dict] = {}

    # (field, kind) -> period_end -> [rows]; misaligned flows kept apart
    aligned: dict[str, dict[date, list[dict]]] = defaultdict(lambda: defaultdict(list))
    misaligned: dict[str, list[dict]] = defaultdict(list)
    kinds: dict[str, str] = {}
    field_concept: dict[str, set] = {}
    prio = {c: i for i, c in enumerate(CONCEPTS)}

    for r in rows:
        concept = str(r["raw_tag"]).split(":", 1)[-1]
        pe = _d(r["period_end"])
        inv = inventory.setdefault((r["metric_code"], r["raw_tag"]), {
            "metric_code": r["metric_code"], "concept": r["raw_tag"], "unit": r["unit"],
            "rows": 0, "first_period": str(pe), "last_period": str(pe), "filings": set()})
        inv["rows"] += 1
        inv["first_period"] = min(inv["first_period"], str(pe))
        inv["last_period"] = max(inv["last_period"], str(pe))
        inv["filings"].add(str(_d(r["filed_date"])))
        if r["report_type"] not in PERIODIC_FORMS:
            ignored_forms[r["report_type"] or "?"] += 1
            continue
        if concept not in CONCEPTS:
            unmapped[r["raw_tag"]] += 1
            continue
        field, kind = CONCEPTS[concept]
        field_concept.setdefault(field, set()).add(r["raw_tag"])
        kinds[field] = kind
        n = ytd_months(pe, fye)
        if kind == "instant" or r["fiscal_period"] == _YTD_LABEL.get(n):
            aligned[field][pe].append(r)
        else:
            misaligned[field].append(r)

    restatements, chosen = [], {}
    for field, by_pe in aligned.items():
        chosen[field] = {}
        for pe, cands in by_pe.items():
            # synonyms: per period, the first concept in CONCEPTS order wins —
            # per period, not per field, because filers switch tags across years
            top = min(prio[str(c["raw_tag"]).split(":", 1)[-1]] for c in cands)
            cands = [c for c in cands if prio[str(c["raw_tag"]).split(":", 1)[-1]] == top]
            row, rest = pick_vintage(cands, kinds[field])
            chosen[field][pe] = row
            if rest:
                restatements.append({"field": field, "concept": row["raw_tag"],
                                     "period_end": str(pe), **rest})

    flows = [f for f, k in kinds.items() if k == "flow"]
    per_share = [f for f, k in kinds.items() if k == "per_share"]
    instants = [f for f, k in kinds.items() if k == "instant"]

    # ---- YTD map: field -> (fy, months) -> row
    ytd: dict[str, dict[tuple[int, int], dict]] = defaultdict(dict)
    for f in flows + per_share:
        for pe, row in chosen.get(f, {}).items():
            ytd[f][(fiscal_year(pe, fye), ytd_months(pe, fye))] = {**row, "_pe": pe}

    def src(row, n):
        return (f"{row['raw_tag']} · {'FY' if n == 12 else f'YTD{n}'} {row['_pe']} · "
                f"{row['report_type']} filed {_d(row['filed_date'])}")

    # ---- annual
    years = sorted({fy for f in flows + per_share for (fy, n) in ytd[f] if n == 12})
    annual = []
    for fy in years:
        p = {"fiscal_year": fy, "label": f"FY{fy}", "period_end": None, "values": {}, "sources": {}}
        for f in flows + per_share:
            row = ytd[f].get((fy, 12))
            if row:
                p["period_end"] = str(row["_pe"])
                p["values"][f] = row["value"]
                p["sources"][f] = src(row, 12)
        annual.append(p)

    # ---- discrete quarters
    qs: dict[tuple[int, int], dict] = {}
    checks = []
    for f in flows:
        for (fy, n), row in ytd[f].items():
            q = n // 3
            key = (fy, q)
            p = qs.setdefault(key, {"fiscal_year": fy, "quarter": q, "label": f"Q{q} FY{fy}",
                                    "period_end": str(row["_pe"]), "values": {}, "sources": {}})
            if n == 3:
                p["values"][f] = row["value"]
                p["sources"][f] = src(row, 3)
            else:
                prev = ytd[f].get((fy, n - 3))
                if prev is None:
                    continue
                p["values"][f] = row["value"] - prev["value"]
                p["sources"][f] = f"{src(row, n)} − {src(prev, n - 3)}"
        if f == "revenue":
            for key, p in qs.items():
                v = p["values"].get("revenue")
                if v is not None and v < 0:
                    checks.append(f"negative derived revenue {p['label']} — YTD assumption "
                                  "violated for this filer; quarter is unreliable")
    for f in per_share:  # only Q1 is discrete as filed; later quarters carry YTD
        for (fy, n), row in ytd[f].items():
            q = qs.get((fy, n // 3))
            if q is None or n == 12:
                continue
            fld = f if n == 3 else f + "_ytd"
            q["values"][fld] = row["value"]
            q["sources"][fld] = src(row, n)

    # corroborate with misaligned (discrete-quarter comparative) rows
    corroborated, uncorroborated = 0, []
    for f in flows:
        for r in misaligned.get(f, []):
            pe = _d(r["period_end"])
            p = qs.get((fiscal_year(pe, fye), ytd_months(pe, fye) // 3))
            v = p and p["values"].get(f)
            if v is None:
                continue
            if abs(v - r["value"]) <= max(_scale(r["value"]) / 2, abs(v) * 1e-4) + 1:
                corroborated += 1
            else:
                uncorroborated.append({"field": f, "period_end": str(pe),
                                       "label_in_filing": r["fiscal_period"],
                                       "filed": str(_d(r["filed_date"])), "value": r["value"],
                                       "derived_discrete": v})

    # keep 4 extra quarters so the oldest shown quarter still gets a YoY comparison
    quarterly = [qs[k] for k in sorted(qs) if qs[k]["values"]][-quarters - 4:]

    for p in annual + quarterly:
        _derive(p)
    _growth(annual, lambda p: p["fiscal_year"] - 1, key=lambda p: p["fiscal_year"])
    _growth(quarterly, lambda p: (p["fiscal_year"] - 1, p["quarter"]),
            key=lambda p: (p["fiscal_year"], p["quarter"]))
    shown = quarterly[-quarters:]

    ttm = None
    if len(shown) >= 4:
        last4 = shown[-4:]
        consec = all((b["fiscal_year"] * 4 + b["quarter"]) - (a["fiscal_year"] * 4 + a["quarter"]) == 1
                     for a, b in zip(last4, last4[1:]))
        if consec:
            vals = {f: sum(q["values"][f] for q in last4)
                    for f in flows if all(f in q["values"] for q in last4)}
            ttm = {"label": f"TTM to {last4[-1]['period_end']}",
                   "quarters": [q["label"] for q in last4], "values": vals, "sources": {}}
            _derive(ttm)

    # ---- balance sheet
    bs_dates = sorted({pe for f in instants for pe in chosen.get(f, {})})
    balance = []
    for pe in bs_dates:
        n, fy = ytd_months(pe, fye), fiscal_year(pe, fye)
        p = {"period_end": str(pe), "fiscal_year": fy,
             "label": f"FY{fy}" if n == 12 else f"Q{n // 3} FY{fy}", "values": {}, "sources": {}}
        for f in instants:
            row = chosen.get(f, {}).get(pe)
            if row:
                p["values"][f] = row["value"]
                p["sources"][f] = f"{row['raw_tag']} · {pe} · {row['report_type']} filed {_d(row['filed_date'])}"
        v = p["values"]
        if "long_term_debt" in v and "cash" in v:
            v["net_debt"] = v["long_term_debt"] - v["cash"]
            p["sources"]["net_debt"] = "long_term_debt − cash"
        if "long_term_debt" in v and v.get("total_equity", 0) > 0:
            v["debt_to_equity"] = v["long_term_debt"] / v["total_equity"]
            p["sources"]["debt_to_equity"] = "long_term_debt ÷ total_equity"
        balance.append(p)

    present = set(kinds)
    gaps = [f for f in EXPECTED_FIELDS if f not in present]
    for f in ("long_term_debt",):
        if f in present and bs_dates and bs_dates[-1] not in chosen.get(f, {}):
            gaps.append(f"{f}@{bs_dates[-1]} (not tagged in latest filing)")

    return {
        "fiscal_year_end_month": fye,
        "concept_by_field": {f: sorted(c) for f, c in sorted(field_concept.items())},
        "inventory": sorted(({**v, "filings": sorted(v["filings"])} for v in inventory.values()),
                            key=lambda x: x["metric_code"]),
        "annual": annual,
        "quarterly": shown,
        "ttm": ttm,
        "balance_sheet": balance,
        "restatements": sorted(restatements, key=lambda x: (x["field"], x["period_end"])),
        "checks": {"misaligned_rows_corroborated": corroborated,
                   "misaligned_rows_uncorroborated": uncorroborated,
                   "warnings": checks},
        "ignored_forms": dict(ignored_forms),
        "unmapped_concepts": dict(unmapped),
        "gaps": gaps,
    }


def _ratio(a, b):
    return None if a is None or not b else a / b


def _derive(p: dict) -> None:
    """Margins and GAAP-built subtotals. Gross profit is revenue − cost of revenue
    AS TAGGED (CoreWeave's cost of revenue excludes D&A, so this overstates a
    conventional gross margin); EBITDA here is operating income + depreciation —
    a GAAP-built proxy, NOT the company's non-GAAP adjusted EBITDA (which also adds
    back SBC and other items and is not in XBRL)."""
    v, s = p["values"], p["sources"]
    rev = v.get("revenue")
    if rev is not None and "cost_of_revenue" in v:
        v["gross_profit"] = rev - v["cost_of_revenue"]
        s["gross_profit"] = "revenue − cost_of_revenue (as tagged)"
    if "operating_income" in v and "depreciation" in v:
        v["ebitda_derived"] = v["operating_income"] + v["depreciation"]
        s["ebitda_derived"] = "operating_income + depreciation (GAAP proxy, not adj. EBITDA)"
        if "sbc" in v:
            v["ebitda_plus_sbc_derived"] = v["ebitda_derived"] + v["sbc"]
            s["ebitda_plus_sbc_derived"] = "operating_income + depreciation + sbc"
    if v.get("net_income") is not None and v.get("eps_basic"):
        # weighted-average basic shares implied by the filed EPS — a cross-check on
        # share count when the weighted-share concept itself is not in the store
        v["shares_basic_implied"] = v["net_income"] / v["eps_basic"]
        s["shares_basic_implied"] = "net_income ÷ eps_basic (implied weighted-average basic shares)"
    if "operating_cash_flow" in v and "capex" in v:
        v["free_cash_flow"] = v["operating_cash_flow"] - v["capex"]
        s["free_cash_flow"] = "operating_cash_flow − capex (PP&E purchases only)"
    m = {}
    for name, num in (("gross_margin", "gross_profit"), ("operating_margin", "operating_income"),
                      ("net_margin", "net_income"), ("ebitda_margin", "ebitda_derived"),
                      ("ocf_margin", "operating_cash_flow"), ("fcf_margin", "free_cash_flow"),
                      ("capex_to_revenue", "capex"), ("sbc_to_revenue", "sbc"),
                      ("rd_to_revenue", "rd_expense")):
        r = _ratio(v.get(num), rev)
        if r is not None:
            m[name] = r
    p["margins"] = m


def _growth(periods: list[dict], prior_key, key) -> None:
    """YoY FUNDAMENTAL growth. A percentage is only meaningful off a positive base
    and without a sign flip ("n.m." in a fund-house table); otherwise only the
    absolute change is reported (a widening loss is not "-40% growth", and a swing
    from +19M to -49M operating income is not "-355%")."""
    by = {key(p): p for p in periods}
    for p in periods:
        prev = by.get(prior_key(p))
        g = {}
        if prev:
            for f in ("revenue", "gross_profit", "operating_income", "net_income",
                      "ebitda_derived", "operating_cash_flow", "eps_basic"):
                a, b = p["values"].get(f), prev["values"].get(f)
                if a is None or b is None:
                    continue
                g[f + "_yoy"] = (a / b - 1) if b > 0 and a >= 0 else None
                g[f + "_yoy_change"] = a - b
        p["growth"] = g


# ----------------------------------------------------------------------- job
def financials(ticker_or_id: str, security_id: int | None = None, store=None,
               quarters: int = 8, name: str | None = None) -> dict:
    sec = resolve_security(ticker_or_id, security_id)
    rows = load_rows(sec["security_id"], store)
    if not rows:
        raise LookupError(f"no fundamental_metrics rows for security {sec['security_id']}")
    out = build_financials(rows, quarters=quarters)
    latest_filed = max(_d(r["filed_date"]) for r in rows if r["report_type"] in PERIODIC_FORMS)
    meta = {
        "security_id": sec["security_id"], "ticker": sec["ticker"],
        "name": name or sec["name"],
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "job": "engine.reports financials (deterministic, no LLM)",
        "source": "SEC EDGAR XBRL via Tier B fundamental_metrics (public domain)",
        "latest_filing_used": str(latest_filed),
        "units": "USD (per-share in USD/share); values unscaled",
        "conventions": [
            "Discrete quarters de-cumulated from YTD 10-Q facts: Q2=H1−Q1, Q3=9M−H1, Q4=FY−9M.",
            "Latest filed vintage per period; later values that only round an earlier "
            "precise value keep the precise one.",
            "Growth = fundamental YoY growth (revenue/earnings), never share-price performance; "
            "% growth only off a positive base, else absolute change.",
            "gross_profit = revenue − cost_of_revenue as tagged; ebitda_derived = operating "
            "income + depreciation (GAAP proxy, not company adjusted EBITDA).",
            "EPS is reported as filed (YTD) — only Q1 EPS is a discrete quarter.",
        ],
    }
    return {"meta": meta, **out}


def write(payload: dict, out: str | os.PathLike) -> Path:
    path = Path(out)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1, default=str) + "\n", encoding="utf-8")
    return path


if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(prog="engine.reports", description="Deterministic company report data")
    sub = p.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("financials", help="annual + discrete-quarter statements JSON")
    f.add_argument("ticker", help="ticker (resolved via Postgres) or numeric security id")
    f.add_argument("--security-id", type=int, help="skip ticker resolution (offline)")
    f.add_argument("--name", help="display name when Postgres is unavailable")
    f.add_argument("--tierb", help="Tier B store root (default: TIERB_ROOT or data/tierb)")
    f.add_argument("--quarters", type=int, default=8)
    f.add_argument("--out", help="write JSON here (default: print to stdout)")
    a = p.parse_args()
    if a.cmd == "financials":
        res = financials(a.ticker, a.security_id, a.tierb, a.quarters, a.name)
        if a.out:
            print(f"wrote {write(res, a.out)}  ({len(res['annual'])} FY, "
                  f"{len(res['quarterly'])} quarters, {len(res['restatements'])} restatements, "
                  f"gaps: {', '.join(res['gaps']) or 'none'})")
        else:
            print(json.dumps(res, indent=1, default=str))
