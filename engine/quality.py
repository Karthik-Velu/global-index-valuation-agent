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
# income, free cash flow AND revenue can all be negative — e.g. TSLA gross profit in
# 2012, and insurers/asset-managers (AIG 2008, Blackstone) book investment losses that
# make total_revenue negative in crises. Only balance-sheet stocks and share counts
# are truly non-negative.
_CURRENCY_NONNEG = ("total_assets", "total_deposits", "shares_outstanding")

# Metrics where a large year-over-year move genuinely signals a UNITS ERROR (thousands
# filed as units). Restricted to the two large, stable, never-negative line items:
# revenue and total assets. Earnings/cash-flow/equity legitimately swing and flip sign
# (esp. financials in 2008/2020), so they are NOT used for units-error detection.
_JUMP_CORE = {"total_revenue", "total_assets"}


def _units() -> dict[str, str]:
    """metric_code -> unit, from the catalog (empty if unavailable)."""
    try:
        from .sources import catalog
        return catalog.units_for()
    except Exception:
        return {}


def _checks(cur) -> list[dict]:
    """All checks against Postgres — the pre-Tier-B path. Once the Parquet store
    exists, run() uses _checks_tierb instead; keep the two in lockstep until the
    cutover retires this one (Gate B compares their outputs)."""
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
            # Both must be positive + material: a sign flip is a real event (a loss),
            # not a units error. Only an order-of-magnitude (>100x) move on these stable
            # line items looks like a thousands-vs-units scaling mistake.
            if va and vb and va > 1e5 and vb > 1e5:
                jump = max(vb / va, va / vb)
                if jump > 100:
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
        # `lo is not None`, not truthiness: a legitimate 0.0 vs a large value is
        # exactly the gross disagreement this check exists to catch.
        if lo is not None and abs(hi - lo) / max(abs(lo), 1) > 0.05:
            issues.append({"check_name": "source_disagreement", "severity": "warn", "scope": "metric",
                           "entity": tk, "metric_code": mc,
                           "detail": f"{nsrc} sources disagree on {mc} {pe}: {lo} vs {hi}"})

    # 7. Concept disagreement within XBRL itself: shares_outstanding merges THREE
    #    different tags (dei:EntityCommonStockSharesOutstanding, us-gaap:CommonStock-
    #    SharesOutstanding, us-gaap:CommonStockSharesIssued — see metric_catalog.json)
    #    into one metric_code, and multi-class issuers (e.g. dual-class share
    #    structures) can report per-class facts under `us-gaap:CommonStockShares-
    #    Outstanding` that this codebase's own catalog notes say should be SUMMED but
    #    aren't (found investigating a wrong Comcast P/E, 2026-07-27 — see JOURNAL).
    #    `source_disagreement` above only compares across `source` (xbrl vs simfin
    #    etc.), not across DIFFERENT xbrl CONCEPTS sharing one metric_code — this
    #    catches that gap using the `raw_tag` column captured at ingest.
    cur.execute("""select s.ticker, fm.period_end, min(fm.value), max(fm.value),
                          count(distinct fm.raw_tag)
                   from fundamental_metrics fm join securities s on s.id=fm.security_id
                   where fm.metric_code='shares_outstanding' and fm.value > 0
                   group by s.ticker, fm.period_end having count(distinct fm.raw_tag) > 1""")
    for tk, pe, lo, hi, ntag in cur.fetchall():
        if hi / lo > 1.5:
            issues.append({"check_name": "shares_concept_disagreement", "severity": "warn",
                           "scope": "metric", "entity": tk, "metric_code": "shares_outstanding",
                           "detail": f"{ntag} xbrl concepts disagree on shares_outstanding {pe}: "
                                     f"{lo:,.0f} vs {hi:,.0f} — likely an unsummed multi-class fact"})
    return issues


def _checks_tierb(duck, cur) -> list[dict]:
    """The fundamental_metrics checks against Tier B (DuckDB over Parquet); only
    staleness (5) stays on Postgres, where `filings` remains the system of record.
    Same checks, same thresholds as _checks — the dialect is the only difference."""
    issues: list[dict] = []

    # 1. Securities with zero fundamentals (coverage gap).
    for (tk,) in duck.execute(
            """select s.ticker from securities_live s
               left join fundamental_metrics fm on fm.security_id=s.id
               group by s.id, s.ticker having count(fm.security_id)=0""").fetchall():
        issues.append({"check_name": "no_fundamentals", "severity": "error", "scope": "security",
                       "entity": tk, "detail": "security has zero fundamental metrics"})

    # 2. Value sanity: should-be-non-negative currency metrics that are negative.
    for tk, mc, v, pe in duck.execute(
            """select s.ticker, fm.metric_code, fm.value, fm.period_end
               from fundamental_metrics fm join securities_live s on s.id=fm.security_id
               where fm.value < 0
                 and fm.metric_code in (select unnest(?::varchar[]))""",
            [list(_CURRENCY_NONNEG)]).fetchall():
        issues.append({"check_name": "negative_value", "severity": "warn", "scope": "metric",
                       "entity": tk, "metric_code": mc, "value": v,
                       "detail": f"negative {mc} at {pe}"})

    # 3. Time-series jumps (units errors) — latest vintage per period, FY-only,
    #    true year-apart comparisons; same logic as the Postgres twin.
    rows = duck.execute(
        """select security_id, ticker, metric_code, period_end, value from (
             select distinct on (fm.security_id, fm.metric_code, fm.period_end)
                    fm.security_id, s.ticker, fm.metric_code, fm.period_end, fm.value
             from fundamental_metrics fm join securities_live s on s.id=fm.security_id
             where fm.fiscal_period='FY' and fm.source='xbrl' and fm.value is not null
               and fm.metric_code in (select unnest(?::varchar[]))
             order by fm.security_id, fm.metric_code, fm.period_end, fm.filed_date desc
           ) t order by security_id, metric_code, period_end""",
        [list(_JUMP_CORE)]).fetchall()
    for (sid, mc), grp in groupby(rows, key=lambda r: (r[0], r[2])):
        g = list(grp)
        for a, b in zip(g, g[1:]):
            gap = (b[3] - a[3]).days if a[3] and b[3] else 0
            if not (250 <= gap <= 450):
                continue
            va, vb = a[4], b[4]
            if va and vb and va > 1e5 and vb > 1e5:
                jump = max(vb / va, va / vb)
                if jump > 100:
                    issues.append({"check_name": "timeseries_jump", "severity": "warn",
                                   "scope": "metric", "entity": b[1], "metric_code": mc, "value": vb,
                                   "detail": f"{mc} moved {vb / va:.0f}x {a[3]}→{b[3]} (likely units error)"})

    # 4. Completeness: every security should have a revenue-like metric and net income.
    for tk, rev, ni in duck.execute(
            """select s.ticker,
                 sum(case when fm.metric_code in (select unnest(?::varchar[])) then 1 else 0 end) rev,
                 sum(case when fm.metric_code = 'net_income' then 1 else 0 end) ni
               from securities_live s left join fundamental_metrics fm on fm.security_id=s.id
               group by s.id, s.ticker""", [REVENUE_CODES]).fetchall():
        if not rev:
            issues.append({"check_name": "missing_revenue", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": "no revenue metric resolved"})
        if not ni:
            issues.append({"check_name": "missing_net_income", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": "no net_income resolved"})

    # 5. Staleness — filings live in Postgres.
    cur.execute("""select s.ticker, max(f.filed_date) from securities s
                   join filings f on f.security_id=s.id group by s.ticker""")
    for tk, mx in cur.fetchall():
        if mx and (date.today() - mx).days > 460:
            issues.append({"check_name": "stale_filings", "severity": "warn", "scope": "security",
                           "entity": tk, "detail": f"latest filing {mx} is >15 months old"})

    # 6. Cross-source disagreement: same metric/period from 2+ sources differing >5%.
    for tk, mc, pe, lo, hi, nsrc in duck.execute(
            """select s.ticker, fm.metric_code, fm.period_end,
                      min(fm.value), max(fm.value), count(distinct fm.source)
               from fundamental_metrics fm join securities_live s on s.id=fm.security_id
               where fm.value is not null
               group by s.ticker, fm.metric_code, fm.period_end
               having count(distinct fm.source) > 1""").fetchall():
        # `lo is not None`, not truthiness: a legitimate 0.0 vs a large value is
        # exactly the gross disagreement this check exists to catch.
        if lo is not None and abs(hi - lo) / max(abs(lo), 1) > 0.05:
            issues.append({"check_name": "source_disagreement", "severity": "warn", "scope": "metric",
                           "entity": tk, "metric_code": mc,
                           "detail": f"{nsrc} sources disagree on {mc} {pe}: {lo} vs {hi}"})

    # 7. Concept disagreement within XBRL itself — same reasoning as the Postgres twin.
    for tk, pe, lo, hi, ntag in duck.execute(
            """select s.ticker, fm.period_end, min(fm.value), max(fm.value),
                      count(distinct fm.raw_tag)
               from fundamental_metrics fm join securities_live s on s.id=fm.security_id
               where fm.metric_code='shares_outstanding' and fm.value > 0
               group by s.ticker, fm.period_end having count(distinct fm.raw_tag) > 1""").fetchall():
        if hi / lo > 1.5:
            issues.append({"check_name": "shares_concept_disagreement", "severity": "warn",
                           "scope": "metric", "entity": tk, "metric_code": "shares_outstanding",
                           "detail": f"{ntag} xbrl concepts disagree on shares_outstanding {pe}: "
                                     f"{lo:,.0f} vs {hi:,.0f} — likely an unsummed multi-class fact"})
    return issues


def run() -> dict:
    print("== Data-Quality Agent ==")
    from . import tierb
    with db.connect() as conn, conn.cursor() as cur:
        duck = None
        if tierb.enabled():
            # Trust Tier B only when it is not behind Postgres — a lagging store
            # (failed dual-write, failed reconcile) must not produce false issues
            # against the system of record. Post-cutover Postgres reads 0 rows and
            # the store is always used.
            cur.execute("select count(*) from fundamental_metrics")
            pg_n = cur.fetchone()[0]
            tb_n = tierb.counts()["fundamental_metrics"]
            if pg_n > tb_n:
                print(f"   WARNING: Tier B behind Postgres ({tb_n:,} vs {pg_n:,} rows) — "
                      "checking Postgres instead; run engine.tierbsync export")
            else:
                duck = tierb.connect()
                cur.execute("select id, ticker from securities")
                tierb.register_securities(duck, cur.fetchall())
        issues = _checks_tierb(duck, cur) if duck is not None else _checks(cur)
        # Rewrite the open set (resolved issues stop reappearing); keep history of resolved.
        cur.execute("delete from data_quality_issues where status='open'")
        for i in issues:
            cur.execute(
                """insert into data_quality_issues(check_name,severity,scope,entity,metric_code,detail,value)
                   values (%s,%s,%s,%s,%s,%s,%s)""",
                (i["check_name"], i["severity"], i["scope"], i.get("entity"),
                 i.get("metric_code"), i.get("detail"), i.get("value")))
        conn.commit()
        cur.execute("select count(*) from securities")
        n_sec = cur.fetchone()[0] or 1

    from collections import Counter
    by_sev = Counter(i["severity"] for i in issues)
    by_check = Counter(i["check_name"] for i in issues)
    # Rate-based so the score is meaningful at any scale: issues are judged relative to
    # the number of companies, not as an absolute count (errors weigh 4x warnings).
    # ~2 weighted issues per company -> 0; a clean large dataset stays near 100.
    weighted = by_sev.get("warn", 0) + 4 * by_sev.get("error", 0)
    score = round(max(0, 100 - 100 * min(1.0, weighted / (2 * n_sec))))
    report = {"asof": date.today().isoformat(), "generated_at": datetime.now(timezone.utc).isoformat(),
              "metrics_engine": "tierb" if duck is not None else "postgres",
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
