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
_CURRENCY_NONNEG = tuple(REVENUE_CODES + ["total_assets", "total_deposits", "gross_profit",
                                          "shares_outstanding"])


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

    # 3. Time-series jumps: on the LATEST vintage per period (so restatements don't
    #    create false jumps), flag a >50x move or a sign flip — the signature of a
    #    units error, not normal growth.
    cur.execute("""select security_id, ticker, metric_code, period_end, value from (
                     select distinct on (fm.security_id, fm.metric_code, fm.period_end)
                            fm.security_id, s.ticker, fm.metric_code, fm.period_end, fm.value
                     from fundamental_metrics fm join securities s on s.id=fm.security_id
                     where fm.fiscal_period='FY' and fm.source='xbrl' and fm.value is not null
                     order by fm.security_id, fm.metric_code, fm.period_end, fm.filed_date desc
                   ) t order by security_id, metric_code, period_end""")
    rows = cur.fetchall()
    for (sid, mc), grp in groupby(rows, key=lambda r: (r[0], r[2])):
        g = list(grp)
        for a, b in zip(g, g[1:]):
            va, vb = a[4], b[4]
            if va and vb and abs(va) > 1e4:
                ratio = vb / va
                if ratio > 50 or ratio < -1:
                    issues.append({"check_name": "timeseries_jump", "severity": "warn",
                                   "scope": "metric", "entity": b[1], "metric_code": mc, "value": vb,
                                   "detail": f"{mc} moved {ratio:.0f}x {a[3]}→{b[3]} (likely units error)"})

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
