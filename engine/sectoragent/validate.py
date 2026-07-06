"""Continuous catalog validation — the auto-curation core.

For every catalogued in_xbrl metric, check whether it actually resolved in the
ingested filings and whether its values are plausible for its unit. This catches
the LLM's bad tag guesses (e.g. a ratio metric whose tag actually returns a cash
balance) without a human curation pass. Runs free, every week.

Verdicts:
  ok       -> resolves with plausible values
  suspect  -> resolves but values implausible for the unit (likely mis-mapped tag) -> FIX
  no_data  -> didn't resolve; usually just means no ingested company covers it yet
              (inconclusive until ingestion scales) -> not necessarily a problem
"""
from __future__ import annotations

import json

from .. import db
from ..sources import catalog

# Units whose values should be "small"; a huge median implies a mis-mapped tag.
_SMALL_UNITS = {"x", "ratio", "pct", "percent", "days", "count"}
_SMALL_MAX = 1000.0


def validate_catalog() -> list[dict]:
    metrics = [m for m in catalog.load() if m.get("in_xbrl")]
    results = []
    # Metric values come from Tier B (Parquet/DuckDB) once the store exists;
    # verdict/sample writes stay on Postgres either way. A store that is BEHIND
    # Postgres is not trusted — a suspect verdict from a lagging store would
    # trigger auto_fix_suspects' destructive purge on the system of record.
    from .. import tierb
    with db.connect() as conn, conn.cursor() as cur:
        duck = None
        if tierb.enabled():
            cur.execute("select count(*) from fundamental_metrics")
            pg_n = cur.fetchone()[0]
            tb_n = tierb.counts()["fundamental_metrics"]
            if pg_n > tb_n:
                print(f"   WARNING: Tier B behind Postgres ({tb_n:,} vs {pg_n:,} rows) — "
                      "validating against Postgres; run engine.tierbsync export")
            else:
                duck = tierb.connect()
                cur.execute("select id, ticker from securities")
                tierb.register_securities(duck, cur.fetchall())
        for m in metrics:
            code = m["metric_code"]
            unit = (m.get("unit") or "").lower()
            if duck is not None:
                ncomp, nval, med = duck.execute(
                    """select count(distinct security_id), count(*),
                              quantile_cont(abs(value), 0.5)
                       from fundamental_metrics
                       where metric_code=? and value is not null""", [code]).fetchone()
            else:
                cur.execute(
                    """select count(distinct security_id), count(*),
                              percentile_cont(0.5) within group (order by abs(value))
                       from fundamental_metrics
                       where metric_code=%s and value is not null""", (code,))
                ncomp, nval, med = cur.fetchone()
            resolves = (nval or 0) > 0

            if not resolves:
                verdict, note = "no_data", "no values yet (need a company in this sector ingested)"
            elif unit in _SMALL_UNITS and med is not None and med > _SMALL_MAX:
                verdict = "suspect"
                note = f"unit '{unit}' but median |value|={med:,.0f} — tag likely returns the wrong concept"
            else:
                verdict, note = "ok", ""

            if duck is not None:
                srows = duck.execute(
                    """select s.ticker, fm.value, fm.period_end from fundamental_metrics fm
                       join securities_live s on s.id=fm.security_id
                       where fm.metric_code=? and fm.value is not null
                       order by fm.period_end desc limit 2""", [code]).fetchall()
            else:
                cur.execute(
                    """select s.ticker, fm.value, fm.period_end from fundamental_metrics fm
                       join securities s on s.id=fm.security_id
                       where fm.metric_code=%s and fm.value is not null
                       order by fm.period_end desc limit 2""", (code,))
                srows = cur.fetchall()
            sample = [{"ticker": r[0], "value": r[1], "period": str(r[2])} for r in srows]

            cur.execute(
                """insert into catalog_validation
                   (metric_code,resolves,n_companies,n_values,median_abs,sample,verdict,note)
                   values (%s,%s,%s,%s,%s,%s,%s,%s)""",
                (code, resolves, ncomp, nval, med, json.dumps(sample), verdict, note))
            if verdict == "suspect":
                cur.execute(
                    "insert into taxonomy_changes(kind,target,change,reason,auto) "
                    "values('catalog',%s,'flagged suspect tag',%s,true)", (code, note))

            results.append({"metric_code": code, "resolves": resolves, "n_companies": ncomp,
                            "n_values": nval, "median_abs": med, "verdict": verdict,
                            "note": note, "sample": sample})
        conn.commit()
    return results


def auto_fix_suspects(results: list[dict]) -> list[str]:
    """The agent doesn't just flag — it fixes: demote suspect XBRL metrics to
    'computed', purge their wrong data, and self-correct the committed catalog JSON
    so collection improves over time."""
    suspects = [r["metric_code"] for r in results if r["verdict"] == "suspect"]
    if not suspects:
        return []
    with db.connect() as conn, conn.cursor() as cur:
        for code in suspects:
            cur.execute(
                "update metric_catalog set in_xbrl=false, source_if_not_xbrl='computed', "
                "xbrl_tags='[]'::jsonb, notes=coalesce(notes,'')||' [auto-demoted: suspect XBRL tag]' "
                "where metric_code=%s", (code,))
            cur.execute("delete from fundamental_metrics where metric_code=%s and source='xbrl'", (code,))
            cur.execute(
                "insert into taxonomy_changes(kind,target,change,reason,auto) "
                "values('catalog',%s,'demoted in_xbrl->computed; purged bad rows','suspect tag',true)",
                (code,))
        conn.commit()

    # Purge the same rows from Tier B (both stores get writes during the transition)
    # — one rewrite for all suspects. A failure here leaves tierb-only rows that
    # `tierbsync verify` will flag.
    try:
        from .. import tierb
        if tierb.enabled():
            tierb.delete_metric_codes(suspects, source="xbrl")
    except Exception as e:
        print(f"   WARNING: tierb purge failed (verify will catch the drift): {str(e)[:120]}")

    # Persist the correction back to the committed catalog seed.
    data = json.loads(catalog.CATALOG_PATH.read_text())
    for m in data["metrics"]:
        if m["metric_code"] in suspects:
            m["in_xbrl"] = False
            m["source_if_not_xbrl"] = "computed"
            m["xbrl_tags"] = []
            m["notes"] = (m.get("notes", "") + " [auto-demoted: suspect XBRL tag]").strip()
    catalog.CATALOG_PATH.write_text(json.dumps(data, indent=2))
    return suspects
