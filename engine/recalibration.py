"""Recalibration Orchestrator — decides WHEN a backtest must be redone.

There are two kinds of calibration:
  * forward  — update the model as NEW (future) data arrives (the live feedback loop).
  * backward — REDO the backtest + recalibration because PAST data we backtested on was
               since corrected (fixed catalog tags, restatements, source swaps, quality
               fixes). A backtest run on bad history is invalid.

This agent reads the other agents' change ledgers (sector agent's `taxonomy_changes`,
ingestion agent's `source_decisions`, the quality agent's `data_quality_issues`),
tracks the data "vintage", and recommends a full re-backtest when material corrections
have accumulated since the last backtest. (The backtest engine itself is Phase 2; this
records vintages now so the trigger works the moment backtesting exists.)

  python -m engine.recalibration run
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from . import db
from .config import DATA_DIR

REPORT_PATH = DATA_DIR / "recalibration_report.json"
MATERIAL_THRESHOLD = 25   # corrections since last backtest that warrant a redo


def _count_since(cur, table: str, ts, extra: str = "") -> int:
    q, params = f"select count(*) from {table} where true", []
    if ts is not None:
        q += " and ts > %s"
        params.append(ts)
    if extra:
        q += f" and {extra}"
    cur.execute(q, params)
    return cur.fetchone()[0]


def run() -> dict:
    print("== Recalibration Orchestrator ==")
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from securities")
        nsec = cur.fetchone()[0]
        # Fundamental rows live in Tier B once the Parquet store exists.
        nrows = None
        try:
            from . import tierb
            if tierb.have_tierb():
                nrows = tierb.counts()["fundamental_metrics"]
        except Exception:
            nrows = None
        if nrows is None:
            cur.execute("select count(*) from fundamental_metrics")
            nrows = cur.fetchone()[0]
        cur.execute("select count(*) from taxonomy_changes where kind='catalog'")
        cat_total = cur.fetchone()[0]

        cur.execute("select ts, window_start, window_end from backtest_runs order by ts desc limit 1")
        last = cur.fetchone()
        last_ts = last[0] if last else None

        cat_since = _count_since(cur, "taxonomy_changes", last_ts, "kind='catalog'")
        src_since = _count_since(cur, "source_decisions", last_ts)
        dq_since = _count_since(cur, "data_quality_issues", last_ts, "severity='error'")
        material = cat_since + src_since + dq_since

        cur.execute("""insert into data_versions
                       (n_securities,n_fundamental_rows,corrections_to_date,note)
                       values (%s,%s,%s,'auto snapshot') returning id""",
                    (nsec, nrows, cat_total))
        cur.execute("select currval(pg_get_serial_sequence('data_versions','id'))")

        if last is None:
            recommend, kind = False, "pending_initial"
            reason = (f"No backtest run yet (backtest is Phase 2 — needs price history). Baseline "
                      f"vintage recorded: {nsec} securities, {nrows} fundamental rows, {cat_total} "
                      f"catalog corrections to date. Once the first backtest runs, further corrections "
                      f"are tracked against it and a re-backtest is recommended automatically.")
        elif material >= MATERIAL_THRESHOLD:
            recommend, kind = True, "full_rebacktest"
            reason = (f"{material} material data corrections since the last backtest "
                      f"(catalog {cat_since}, source {src_since}, data errors {dq_since}). The history "
                      f"that backtest used has changed materially — redo the backtest + FULL "
                      f"recalibration on the corrected past (this is backward recalibration, separate "
                      f"from forward calibration on new data).")
        else:
            recommend, kind = False, "forward_only"
            reason = (f"Only {material} corrections since the last backtest (< {MATERIAL_THRESHOLD}). "
                      f"Forward calibration on new data is sufficient; no backward re-backtest needed.")

        evidence = {"n_securities": nsec, "n_fundamental_rows": nrows,
                    "catalog_corrections_to_date": cat_total,
                    "since_last_backtest": {"catalog": cat_since, "source": src_since,
                                            "data_errors": dq_since},
                    "last_backtest": str(last_ts) if last_ts else None}
        cur.execute("""insert into recalibration_recommendations(recommend,kind,reason,evidence)
                       values (%s,%s,%s,%s)""", (recommend, kind, reason, json.dumps(evidence, default=str)))
        conn.commit()

    report = {"asof": date.today().isoformat(), "generated_at": datetime.now(timezone.utc).isoformat(),
              "recommend": recommend, "kind": kind, "reason": reason, "evidence": evidence}
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"   recommend re-backtest: {recommend}  ({kind})")
    print(f"   {reason}")
    return report


if __name__ == "__main__":
    run()
