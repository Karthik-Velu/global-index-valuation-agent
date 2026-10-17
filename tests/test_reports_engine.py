"""engine/reports.py tests — stdlib only, no pytest or Tier B store needed:

    python tests/test_reports_engine.py

A synthetic filer "FXR" (December year-end) exercises the three traps the job
exists to handle: YTD-cumulative 10-Q flows (de-cumulation), multiple filing
vintages (rounding-only re-filings vs a real restatement), and comparative rows
whose fiscal_period label is the FILING's, not the period's. Everything runs
through build_financials(), the same pure function the CLI runs on real data.
pytest will collect the test_* functions too.
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine import reports  # noqa: E402

M = 1_000_000


def _r(concept, pe, fp, value, filed, form=None, code="x"):
    return {"period_end": date.fromisoformat(pe), "fiscal_period": fp, "metric_code": code,
            "value": float(value), "unit": "USD", "filed_date": date.fromisoformat(filed),
            "report_type": form or ("10-K" if fp == "FY" else "10-Q"),
            "raw_tag": f"us-gaap:{concept}"}


REV = "RevenueFromContractWithCustomerExcludingAssessedTax"
FXR_ROWS = [
    # --- revenue: FY2024 10-K, 2025 10-Qs (YTD) with prior-year comparatives
    _r(REV, "2024-12-31", "FY", 400 * M, "2025-02-15"),
    _r(REV, "2024-03-31", "Q1", 80 * M, "2025-05-10"),     # comparative, 3M
    _r(REV, "2024-06-30", "Q2", 170 * M, "2025-08-10"),    # comparative, YTD6
    _r(REV, "2024-09-30", "Q3", 270 * M, "2025-11-10"),    # comparative, YTD9
    _r(REV, "2025-03-31", "Q1", 100_400_000, "2025-05-10"),  # precise (thousands)
    _r(REV, "2025-03-31", "Q1", 100 * M, "2026-05-10"),    # later filing ROUNDS it
    _r(REV, "2025-06-30", "Q2", 230_400_000, "2025-08-10"),
    _r(REV, "2025-09-30", "Q3", 380_400_000, "2025-11-10"),
    _r(REV, "2025-12-31", "FY", 550 * M, "2026-02-15"),
    # misaligned: Jun-30 end labelled Q3 = discrete Q2 roll-forward from a later
    # Q3 10-Q. Must NOT be read as a 9-month YTD; only corroborates Q2.
    _r(REV, "2025-06-30", "Q3", 130 * M, "2025-11-10"),
    # --- net income: FY2024 genuinely restated in the FY2025 10-K
    _r("NetIncomeLoss", "2024-12-31", "FY", -50 * M, "2025-02-15"),
    _r("NetIncomeLoss", "2024-12-31", "FY", -60 * M, "2026-02-15"),
    _r("NetIncomeLoss", "2025-12-31", "FY", -40 * M, "2026-02-15"),
    _r("NetIncomeLoss", "2025-12-31", "", -41 * M, "2026-04-20", form="DEF 14A"),  # ignored
    _r("NetIncomeLoss", "2025-03-31", "Q1", -10 * M, "2025-05-10"),
    # --- per-share (not additive)
    _r("EarningsPerShareBasic", "2025-03-31", "Q1", -0.50, "2025-05-10"),
    _r("EarningsPerShareBasic", "2025-06-30", "Q2", -1.10, "2025-08-10"),
    # --- cash flow (YTD)
    _r("NetCashProvidedByUsedInOperatingActivities", "2025-03-31", "Q1", 30 * M, "2025-05-10"),
    _r("NetCashProvidedByUsedInOperatingActivities", "2025-06-30", "Q2", 50 * M, "2025-08-10"),
    _r("PaymentsToAcquirePropertyPlantAndEquipment", "2025-03-31", "Q1", 70 * M, "2025-05-10"),
    _r("PaymentsToAcquirePropertyPlantAndEquipment", "2025-06-30", "Q2", 200 * M, "2025-08-10"),
    # --- instants: label irrelevant (a 10-Q comparative of the FY-end balance)
    _r("CashAndCashEquivalentsAtCarryingValue", "2024-12-31", "Q1", 90 * M, "2025-05-10"),
    _r("CashAndCashEquivalentsAtCarryingValue", "2025-03-31", "Q1", 80 * M, "2025-05-10"),
    _r("LongTermDebt", "2025-03-31", "Q1", 300 * M, "2025-05-10"),
    _r("StockholdersEquity", "2025-03-31", "Q1", 100 * M, "2025-05-10"),
]


def _build():
    return reports.build_financials(FXR_ROWS, quarters=8)


def _q(out, label):
    return next(q for q in out["quarterly"] if q["label"] == label)


def test_ytd_decumulation():
    out = _build()
    got = {q["label"]: q["values"].get("revenue") for q in out["quarterly"]}
    want = {"Q1 FY2024": 80 * M, "Q2 FY2024": 90 * M, "Q3 FY2024": 100 * M, "Q4 FY2024": 130 * M,
            "Q1 FY2025": 100_400_000, "Q2 FY2025": 130 * M, "Q3 FY2025": 150 * M,
            "Q4 FY2025": 169_600_000}
    assert set(got) == set(want), got
    for k, v in want.items():
        assert abs(got[k] - v) < 1, (k, got[k], v)
    # annual + cash-flow de-cumulation + derived FCF
    q2 = _q(out, "Q2 FY2025")["values"]
    assert q2["operating_cash_flow"] == 20 * M and q2["capex"] == 130 * M
    assert q2["free_cash_flow"] == -110 * M
    assert [a["values"]["revenue"] for a in out["annual"]] == [400 * M, 550 * M]


def test_quarters_sum_to_fy():
    out = _build()
    fy25 = sum(q["values"]["revenue"] for q in out["quarterly"] if q["fiscal_year"] == 2025)
    assert abs(fy25 - 550 * M) < 1


def test_vintage_rounding_keeps_precise_value():
    out = _build()
    q1 = _q(out, "Q1 FY2025")
    assert q1["values"]["revenue"] == 100_400_000, "later rounded re-filing must not win"
    assert "filed 2025-05-10" in q1["sources"]["revenue"]
    assert not any(r["field"] == "revenue" for r in out["restatements"])


def test_real_restatement_latest_wins_and_is_logged():
    out = _build()
    fy24 = next(a for a in out["annual"] if a["fiscal_year"] == 2024)
    assert fy24["values"]["net_income"] == -60 * M
    rs = [r for r in out["restatements"] if r["field"] == "net_income"]
    assert len(rs) == 1 and rs[0]["original_value"] == -50 * M and rs[0]["restated_value"] == -60 * M


def test_non_periodic_forms_ignored():
    out = _build()
    fy25 = next(a for a in out["annual"] if a["fiscal_year"] == 2025)
    assert fy25["values"]["net_income"] == -40 * M, "DEF 14A vintage must not override the 10-K"
    assert out["ignored_forms"] == {"DEF 14A": 1}


def test_misaligned_label_only_corroborates():
    out = _build()
    assert out["checks"]["misaligned_rows_corroborated"] == 1
    assert out["checks"]["misaligned_rows_uncorroborated"] == []
    # had the Q3-labelled Jun-30 row been read as YTD9, Q3 FY2025 would be 250M
    assert abs(_q(out, "Q3 FY2025")["values"]["revenue"] - 150 * M) < 1


def test_per_share_not_decumulated():
    out = _build()
    assert _q(out, "Q1 FY2025")["values"]["eps_basic"] == -0.50
    q2 = _q(out, "Q2 FY2025")["values"]
    assert "eps_basic" not in q2 and q2["eps_basic_ytd"] == -1.10


def test_growth_is_fundamental_and_base_aware():
    out = _build()
    g = _q(out, "Q1 FY2025")["growth"]
    assert abs(g["revenue_yoy"] - (100_400_000 / (80 * M) - 1)) < 1e-12
    fy25 = next(a for a in out["annual"] if a["fiscal_year"] == 2025)["growth"]
    assert fy25["net_income_yoy"] is None, "no % growth off a loss base"
    assert fy25["net_income_yoy_change"] == 20 * M


def test_instants_and_balance_sheet():
    out = _build()
    bs = {b["period_end"]: b["values"] for b in out["balance_sheet"]}
    assert bs["2024-12-31"]["cash"] == 90 * M
    assert bs["2025-03-31"]["net_debt"] == 220 * M
    assert bs["2025-03-31"]["debt_to_equity"] == 3.0


def test_ttm_and_gaps():
    out = _build()
    assert out["ttm"]["quarters"] == ["Q1 FY2025", "Q2 FY2025", "Q3 FY2025", "Q4 FY2025"]
    assert abs(out["ttm"]["values"]["revenue"] - 550 * M) < 1
    assert "interest_expense" in out["gaps"]


def test_fiscal_calendar_helpers():
    # June year-end filer, incl. 52/53-week period ends
    assert reports.ytd_months(date(2025, 9, 30), 6) == 3
    assert reports.fiscal_year(date(2025, 9, 30), 6) == 2026
    assert reports.ytd_months(date(2025, 6, 28), 6) == 12
    assert reports.ytd_months(date(2025, 7, 2), 6) == 12
    assert reports.fiscal_year(date(2026, 1, 3), 12) == 2025
    assert reports.fiscal_year_end_month(FXR_ROWS) == 12


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e}")
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
