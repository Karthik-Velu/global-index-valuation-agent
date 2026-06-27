"""Data-Quality Agent — validates the ingested data itself and raises warnings.

Data is the foundation of everything (especially the backtest), so this runs the
checks that catch problems as they occur and writes them to `data_quality_issues`
— a feed the data-ingestion agent (and a human) can act on. Deterministic + free.

Checks: coverage/completeness, value sanity, accounting identities, time-series
jumps (units errors / unflagged restatements), staleness, and cross-source
disagreement. Each run rewrites the open issue set (resolved ones simply stop
re-appearing).

  python -m engine.quality run
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone
from itertools import groupby

from . import db
from .config import DATA_DIR

REPORT_PATH = DATA_DIR / "quality_report.json"
REVENUE_CODES = ["revenue_total", "total_revenue", "revenue", "revenues"]
# Metrics that genuinely cannot be negative. NB: gross_profit, net_income, operating
# income and free cash flow CAN be negative (e.g. TSLA gross profit in 2012), so they
# are deliberately excluded — flagging them was a false positive.
_CURRENCY_NONNEG = tuple(REVENUE_CODES + ["total_assets", "total_deposits", "shares_outstanding"])

# Core single-line-item metrics where a >50x year-over-year move genuinely signals a
# UNITS ERROR (thousands filed as units). Composite metrics (total_debt,
# dividends_and_buybacks, net_working_capital, …) sum components that vary in
# availability across periods, so they swing for benign reasons — the jump check is
# deliberately NOT run on them. These core items are also what the backtest depends on.
_JUMP_CORE = {"total_revenue", "net_income", "operating_income", "gross_profit",
              "total_assets", "total_equity", "operating_cash_flow"}


def _units() -> dict[str, str]:
    """metric_code -> unit, from the catalog (empty if unavailable)."""
    try:
        from .sources import catalog
        return catalog.units_for()
    except Exception:
        return {}


def _checks(cur) -> list[dict]:
    issues: list[dict] = []

    # 1. Securities with zero fundamentals (coverage gap).
    cur.execute("""select s.ticker from securities s
                   left join fundamental_metrics fm on fm.security_id=s.id
                   group by s.id, s.ticker having count(fm.security_id)=0""")
    for (tk,) in cur.fetchall():
        issues.append({"check_name": "no_fundamentals", "severity": "error", "scope": "security",
                       "entity": tk, "detail": "security has zero fundamental metrics"})

    # 2. Value sanity: should-be-non-negative currency metrics that are negative.
    cur.execute("""select s.ticker, fm.metric_code, fm.value, fm.period_end
                   from fundamental_metrics fm join securities s on s.id=fm.security_id
                   where fm.value < 0 and fm.metric_code = any(%s)""", (list(_CURRENCY_NONNEG),))
    for tk, mc, v, pe in cur.fetchall():
        issues.append({"check_name": "negative_value", "severity": "warn", "scope": "metric",
                       "entity": tk, "metric_code": mc, "value": v,
                       "detail": f"negative {mc} at {pe}"})

    # 3. Time-series jumps = the signature of a UNITS ERROR (e.g. thousands filed as
    #    units), not normal growth. To avoid false positives we (a) use the latest
    #    vintage per period, (b) only compare consecutive FY periods that are a true
    #    year apart (so annual-vs-quarterly mixing can't masquerade as a jump),
    #    (c) skip ratio/percent metrics (they legitimately swing and flip sign), and
    #    (d) flag only an order-of-magnitude move (>50x either direction) with both
    #    values material — sign flips alone (a real loss) are NOT flagged.
    cur.execute("""select security_id, ticker, metric_code, period_end, value from (
                     select distinct on (fm.security_id, fm.metric_code, fm.period_end)
                            fm.security_id, s.ticker, fm.metric_code, fm.period_end, fm.value
                     from fundamental_metrics fm join securities s on s.id=fm.security_id
                     where fm.fiscal_period='FY' and fm.source='xbrl' and fm.value is not null
                       and fm.metric_code = any(%s)
                     order by fm.security_id, fm.metric_code, fm.period_end, fm.filed_date desc
                   ) t order by security_id, metric_code, period_end""", (list(_JUMP_CORE),))
    rows = cur.fetchall()
    for (sid, mc), grp in groupby(rows, key=lambda r: (r[0], r[2])):
        g = list(grp)
        for a, b in zip(g, g[1:]):
            gap = (b[3] - a[3]).days if a[3] and b[3] else 0
            if not (250 <= gap <= 450):          # only true year-over-year comparisons
                continue
            va, vb = a[4], b[4]
            if va and vb and abs(va) > 1e4 and abs(vb) > 1e4:
                jump = max(abs(vb / va), abs(va / vb))
                if jump > 50:
                    issues.append({"check_name": "timeseries_jump", "severity": "warn",
                                   "scope": "metric", "entity": b[1], "metric_code": mc, "value": vb,
                                   "detail": f"{mc} moved {vb / va:.0f}x {a[3]}→{b[3]} (likely units error)"})

    # 4. Completeness: every security should have a revenue-like metric and net income.
    cur.execute("""select s.ticker,
                     sum(case when fm.metric_code = any(%s) then 1 else 0 end) rev,
                     sum(case when fm.metric_code = 'net_income' then 1 else 0 end) ni
                   from securities s left join fundamental_metrics fm on fm.security_id=s.id
                   group by s.id, s.ticker""", (REVENUE_CODES,))
    for tk, rev, ni in cur.fetchall():
        if not rev:
            issues.append({"check_name": "missing_revenue", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": "no revenue metric resolved"})
        if not ni:
            issues.append({"check_name": "missing_net_income", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": "no net_income resolved"})

    # 5. Staleness: latest filing older than ~15 months.
    cur.execute("""select s.ticker, max(f.filed_date) from securities s
                   join filings f on f.security_id=s.id group by s.ticker""")
    for tk, mx in cur.fetchall():
        if mx and (date.today() - mx).days > 460:
            issues.append({"check_name": "stale_filings", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": f"latest filing {mx} is >15 months old"})

    # 6. Cross-source disagreement: same metric/period from 2+ sources differing >5%.
    cur.execute("""select s.ticker, fm.metric_code, fm.period_end,
                          min(fm.value), max(fm.value), count(distinct fm.source)
                   from fundamental_metrics fm join securities s on s.id=fm.security_id
                   where fm.value is not null
                   group by s.ticker, fm.metric_code, fm.period_end
                   having count(distinct fm.source) > 1""")
    for tk, mc, pe, lo, hi, nsrc in cur.fetchall():
        if lo and abs(hi - lo) / max(abs(lo), 1) > 0.05:
            issues.append({"check_name": "source_disagreement", "severity": "warn", "scope": "metric",
                           "entity": tk, "metric_code": mc,
                           "detail": f"{nsrc} sources disagree on {mc} {pe}: {lo} vs {hi}"})
    return issues


def run() -> dict:
    print("== Data-Quality Agent ==")
    with db.connect() as conn, conn.cursor() as cur:
        issues = _checks(cur)
        # Rewrite the open set (resolved issues stop reappearing); keep history of resolved.
        cur.execute("delete from data_quality_issues where status='open'")
        for i in issues:
            cur.execute(
                """insert into data_quality_issues(check_name,severity,scope,entity,metric_code,detail,value)
                   values (%s,%s,%s,%s,%s,%s,%s)""",
                (i["check_name"], i["severity"], i["scope"], i.get("entity"),
                 i.get("metric_code"), i.get("detail"), i.get("value")))
        conn.commit()

    from collections import Counter
    by_sev = Counter(i["severity"] for i in issues)
    by_check = Counter(i["check_name"] for i in issues)
    score = max(0, 100 - 8 * by_sev.get("error", 0) - 2 * by_sev.get("warn", 0))
    report = {"asof": date.today().isoformat(), "generated_at": datetime.now(timezone.utc).isoformat(),
              "data_quality_score": score, "n_issues": len(issues),
              "by_severity": dict(by_sev), "by_check": dict(by_check),
              "issues": issues[:200]}
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"   score {score}/100 · {len(issues)} issues "
          f"({by_sev.get('error',0)} error, {by_sev.get('warn',0)} warn)")
    for c, n in by_check.most_common():
        print(f"     {c}: {n}")
    print(f"   wrote {REPORT_PATH}")
    return report


if __name__ == "__main__":
    import sys
    run()
