"""Dump Tier B rows as a CI artifact — investigation tooling for a constraint
that keeps recurring.

The problem this exists to solve: Tier B is the sole metric store, but it only
lives inside CI (restored from the Actions cache / `tierb-store` release asset).
An interactive session has no copy, and `data.sec.gov` is unreachable from the
sandbox, so questions of the form "what do CMCSA's raw share-count rows actually
look like?" can't be answered where the analysis happens. That has blocked the
same investigation twice now (the CMCSA P/E dig on 2026-07-27, then the
multi-class question on 07-29), each time resolved by reading code and reasoning
rather than by looking at data — which found real bugs, but left the underlying
data question open both times.

This makes the data reachable: run the workflow, download the artifact, analyse
it anywhere.

**Why parameterised filters and not arbitrary SQL.** A `--sql` flag would be more
flexible and is the obvious first instinct, but it turns a workflow anyone with
write access can dispatch into a general query endpoint against production data,
with the result published as an artifact. The filters below cover the real
investigations (look at one issuer's rows for a metric; find the rows a check
fired on) without that. If a genuinely new shape is needed, add a preset here in
a reviewed commit — that's a feature, not friction.
"""
from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path

from . import db, tierb

OUT_DIR = Path("data")

# Named investigations. Each returns (sql, params) against the Tier B views, and
# exists because some question needed it — keep the "why" attached.
PRESETS = {
    # The still-open half of the CMCSA dig (ADR-027): which securities have ONE
    # xbrl concept reporting SEVERAL values for a single period? Those are
    # dual-class issuers whose per-class facts metric_catalog says to SUM but
    # nothing sums, so market_cap is understated. quality.py's
    # shares_multiclass_unsummed check flags these; this dumps the underlying
    # rows so the fix can be written against real data instead of a hypothesis.
    "multiclass_shares": (
        """select s.ticker, fm.period_end, fm.raw_tag, fm.value, fm.fiscal_period,
                  fm.report_type, fm.filed_date, fm.unit
           from fundamental_metrics fm join securities_live s on s.id = fm.security_id
           where fm.metric_code = 'shares_outstanding' and fm.value > 0
             and (s.ticker, fm.period_end, fm.raw_tag) in (
               select s2.ticker, f2.period_end, f2.raw_tag
               from fundamental_metrics f2 join securities_live s2 on s2.id = f2.security_id
               where f2.metric_code = 'shares_outstanding' and f2.value > 0
               group by s2.ticker, f2.period_end, f2.raw_tag
               having count(distinct f2.value) > 1)
           order by s.ticker, fm.period_end, fm.raw_tag, fm.value""", []),
    # Every share-count row for the tickers given via --tickers. The plain
    # "show me everything for this company" view that both prior investigations
    # actually wanted.
    "shares_by_ticker": (
        """select s.ticker, fm.period_end, fm.raw_tag, fm.value, fm.fiscal_period,
                  fm.report_type, fm.filed_date, fm.unit
           from fundamental_metrics fm join securities_live s on s.id = fm.security_id
           where fm.metric_code = 'shares_outstanding'
             and s.ticker in (select unnest(?::varchar[]))
           order by s.ticker, fm.period_end, fm.raw_tag""", ["tickers"]),
    # Arbitrary metric(s) for arbitrary ticker(s) — the general escape hatch,
    # still parameterised.
    "metrics_by_ticker": (
        """select s.ticker, fm.metric_code, fm.period_end, fm.fiscal_period, fm.value,
                  fm.unit, fm.raw_tag, fm.report_type, fm.filed_date, fm.source
           from fundamental_metrics fm join securities_live s on s.id = fm.security_id
           where s.ticker in (select unnest(?::varchar[]))
             and (?::varchar[] is null or fm.metric_code in (select unnest(?::varchar[])))
           order by s.ticker, fm.metric_code, fm.period_end""", ["tickers", "metrics", "metrics"]),
}


def _connect():
    """Tier B reader with the Postgres (id -> ticker) overlay registered, so
    dumps are keyed by ticker rather than opaque security ids."""
    if not tierb.enabled():
        raise SystemExit(
            "Tier B store not present. This is expected outside CI — the store lives in "
            "the Actions cache / tierb-store release asset. Run this via "
            ".github/workflows/tierb-dump.yml, or hydrate first with "
            "`python -m engine.tierbsync pull`.")
    con = tierb.connect()
    if db.have_db():
        with db.connect() as conn, conn.cursor() as cur:
            cur.execute("select id, ticker from securities")
            tierb.register_securities(con, cur.fetchall())
    else:
        raise SystemExit("DATABASE_URL is required — securities (id -> ticker) lives in Postgres.")
    return con


def dump(preset: str, tickers: list[str] | None = None,
         metrics: list[str] | None = None, limit: int = 5000) -> dict:
    if preset not in PRESETS:
        raise SystemExit(f"unknown preset {preset!r}; choose from {', '.join(sorted(PRESETS))}")
    sql, param_names = PRESETS[preset]
    supplied = {"tickers": [t.upper() for t in (tickers or [])], "metrics": metrics or None}
    if "tickers" in param_names and not supplied["tickers"]:
        raise SystemExit(f"preset {preset!r} needs --tickers")
    params = [supplied[n] for n in param_names]

    con = _connect()
    rows = con.execute(f"select * from ({sql}) t limit {int(limit)}").fetchall()
    cols = [d[0] for d in con.description]
    print(f"   {preset}: {len(rows):,} rows"
          + (f" (LIMIT {limit} reached — narrow the filters)" if len(rows) >= limit else ""))

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path, json_path = OUT_DIR / f"tierb_{preset}.csv", OUT_DIR / f"tierb_{preset}.json"
    with csv_path.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        w.writerows(rows)
    dicts = [dict(zip(cols, r)) for r in rows]
    json_path.write_text(json.dumps(
        {"preset": preset, "tickers": supplied["tickers"], "metrics": supplied["metrics"],
         "n_rows": len(rows), "truncated": len(rows) >= limit,
         "store": tierb.stats(), "rows": dicts}, indent=2, default=str))
    print(f"   wrote {csv_path} and {json_path}")

    # A dump nobody reads is wasted CI time — surface the shape in the log so the
    # run page alone often answers the question without downloading anything.
    if dicts and preset in ("multiclass_shares", "shares_by_ticker"):
        by_tk: dict[str, list] = {}
        for d in dicts:
            by_tk.setdefault(d["ticker"], []).append(d)
        print(f"   {len(by_tk)} distinct tickers; first few:")
        for tk in sorted(by_tk)[:5]:
            vals = by_tk[tk]
            lo, hi = min(v["value"] for v in vals), max(v["value"] for v in vals)
            print(f"     {tk}: {len(vals)} rows, {lo:,.0f} .. {hi:,.0f}, "
                  f"tags={sorted({v['raw_tag'] for v in vals})}")
    return {"preset": preset, "n_rows": len(rows)}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("preset", choices=sorted(PRESETS))
    ap.add_argument("--tickers", default="", help="comma-separated, e.g. CMCSA,GOOG")
    ap.add_argument("--metrics", default="", help="comma-separated metric_codes (optional)")
    ap.add_argument("--limit", type=int, default=5000)
    a = ap.parse_args(argv)
    dump(a.preset,
         [t.strip() for t in a.tickers.split(",") if t.strip()],
         [m.strip() for m in a.metrics.split(",") if m.strip()] or None,
         a.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
