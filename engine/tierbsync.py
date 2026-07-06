"""Tier-B sync job — export / verify / compact / bundle / pull. Deterministic, no LLM.

Moves `fundamental_metrics` (the 95%-of-Postgres bulk) into the Parquet/DuckDB store
and keeps the two tiers reconciled during the transition:

  python -m engine.tierbsync export            # Postgres -> Parquet, full rebuild
  python -m engine.tierbsync export --incremental  # append only rows Tier B lacks
  python -m engine.tierbsync verify            # parity gates vs Postgres (Gate A)
  python -m engine.tierbsync compact           # fold delta/ into base/
  python -m engine.tierbsync bundle            # tar the store for artifact/release upload
  python -m engine.tierbsync pull              # hydrate a fresh environment

Postgres rows reach DuckDB through psycopg (already a dependency) rather than the
DuckDB postgres extension — extensions are a runtime download that can fail in
locked-down environments, and at ~1.5M rows streaming is plenty fast. Incremental
export only pulls rows newer than the store's high-water mark (cheap on Supabase
free-tier egress); the anti-join on the primary key keeps it exact either way.

Safety first (data integrity is foundational): a full export refuses to run if
Postgres holds fewer rows than the store (that's the post-cutover state — a rebuild
would destroy data Postgres no longer has), and `verify` must pass before any reader
is trusted. Postgres stays the system of record until the explicit cutover.
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import shutil
import tarfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import db, tierb

FM_COLS = ", ".join(tierb.FM_COLUMNS)
# Row equality excludes ingested_at: it's load metadata, not filed data (and its
# timezone rendering differs between engines).
FM_DATA_COLS = ", ".join(c for c in tierb.FM_COLUMNS if c != "ingested_at")


def _bundle_path() -> Path:
    return tierb.root().parent / "tierb-store.tar.gz"


def _iso(v):
    return v.isoformat() if isinstance(v, (_dt.date, _dt.datetime)) else v


def _stream_pg(con, sql, params=(), batch: int = 100_000) -> str:
    """Stream a Postgres query into the DuckDB temp table `_pg` (typed like
    fundamental_metrics). Dates/timestamps travel as ISO strings and are cast on
    insert — explicit and engine-portable."""
    import pandas as pd

    con.execute(f"create or replace temp table _pg ({tierb._FM_DDL})")
    casts = ", ".join(f'cast("{c}" as {tierb._fm_types()[c]}) as "{c}"'
                      for c in tierb.FM_COLUMNS)
    with db.connect() as pgc, pgc.cursor(name="tierb_stream") as cur:
        cur.execute(sql, params)
        while True:
            rows = cur.fetchmany(batch)
            if not rows:
                break
            df = pd.DataFrame([[_iso(v) for v in r] for r in rows],
                              columns=list(tierb.FM_COLUMNS))
            con.register("_stream_df", df)
            con.execute(f"insert into _pg select {casts} from _stream_df")
            con.unregister("_stream_df")
    return "_pg"


def _pg_scalar(sql: str, params=()) -> int:
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchone()[0]


def _swap_in(tmp: Path) -> None:
    """Swap a freshly written fundamental_metrics dir into place via renames:
    a crash leaves either the old or the new store, never a half-written one."""
    fm = tierb.root() / "fundamental_metrics"
    old = tierb.root() / f".fm-old-{tierb._stamp()}"
    if fm.exists():
        fm.rename(old)
    tmp.rename(fm)
    if old.exists():
        shutil.rmtree(old)


def _export_companions(con) -> None:
    """Small read-only companions: filings mirror + securities snapshot (Postgres
    stays the system of record for both)."""
    import pandas as pd

    specs = {"filings": "select id, security_id, form, period_end, fiscal_period, "
                        "filed_date, accession, audited, url, source from filings",
             "securities": "select id, ticker, name, country, sector, cik, kind "
                           "from securities"}
    for name, sql in specs.items():
        with db.connect() as pgc, pgc.cursor() as cur:
            cur.execute(sql)
            cols = [d.name for d in cur.description]
            df = pd.DataFrame([[_iso(v) for v in r] for r in cur.fetchall()], columns=cols)
        d = tierb.root() / name
        d.mkdir(parents=True, exist_ok=True)
        con.register("_companion_df", df)
        con.execute(f"copy _companion_df to '{tierb._sql_path(d / f'{name}.parquet')}' "
                    "(format parquet, compression zstd)")
        con.unregister("_companion_df")


def export(incremental: bool = False) -> dict:
    print("== Tier-B export ==")
    con = tierb.connect()
    pg_n = _pg_scalar("select count(*) from fundamental_metrics")

    if incremental:
        if not tierb.have_tierb():
            raise RuntimeError("no Tier B store yet — run a full export first")
        # Fast path: only pull rows newer than the store's high-water mark (with a
        # generous margin); the PK anti-join makes the result exact regardless.
        hwm = con.execute("select max(ingested_at) from fundamental_metrics").fetchone()[0]
        cutoff = (hwm - timedelta(days=7)) if hwm else None
        sql = f"select {FM_COLS} from fundamental_metrics"
        params: tuple = ()
        if cutoff:
            sql += " where ingested_at >= %s"
            params = (cutoff,)
        _stream_pg(con, sql, params)
        con.execute(f"""create temp table _missing as
                        select {FM_COLS} from _pg
                        anti join fundamental_metrics f using ({', '.join(tierb.FM_KEY)})""")
        n = con.execute("select count(*) from _missing").fetchone()[0]
        if n:
            out = tierb.root() / "fundamental_metrics" / "delta" / f"part-{tierb._stamp()}.parquet"
            con.execute(f"copy _missing to '{tierb._sql_path(out)}' "
                        "(format parquet, compression zstd)")
        print(f"   incremental: {n} new rows (Postgres {pg_n:,} total)")
    else:
        tb_n = tierb.counts()["fundamental_metrics"] if tierb.have_tierb() else 0
        if pg_n < tb_n:
            raise RuntimeError(
                f"Postgres has {pg_n:,} rows but Tier B has {tb_n:,} — a full export "
                "would LOSE data (post-cutover?). Refusing; use --incremental if anything.")
        _stream_pg(con, f"select {FM_COLS} from fundamental_metrics")
        tmp = tierb.root() / f".fm-rewrite-{tierb._stamp()}"
        (tmp / "base").mkdir(parents=True)
        (tmp / "delta").mkdir()
        con.execute(f"""copy (select *, year(period_end) as year from _pg)
                        to '{tierb._sql_path(tmp / "base")}'
                        (format parquet, compression zstd, partition_by (year))""")
        _swap_in(tmp)
        n = pg_n
        print(f"   full export: {n:,} rows")

    _export_companions(con)
    tierb._write_manifest()
    st = tierb.stats()
    print(f"   store: {st['fundamental_metrics']:,} rows, {st['bytes'] / 1e6:.1f} MB "
          f"({st['base_files']} base + {st['delta_files']} delta files)")
    return {"rows_exported": n, "postgres_rows": pg_n, **st}


def verify() -> dict:
    """Parity gates vs Postgres — all must pass before any reader trusts Tier B."""
    print("== Tier-B verify (vs Postgres) ==")
    con = tierb.connect()
    _stream_pg(con, f"select {FM_COLS} from fundamental_metrics")
    checks: dict[str, dict] = {}

    def gate(name, ok, detail):
        checks[name] = {"pass": bool(ok), "detail": detail}
        print(f"   {'PASS' if ok else 'FAIL'}  {name}: {detail}")

    pg_n = con.execute("select count(*) from _pg").fetchone()[0]
    tb_n = con.execute("select count(*) from fundamental_metrics").fetchone()[0]
    gate("row_count", pg_n == tb_n, f"postgres {pg_n:,} vs tierb {tb_n:,}")

    only_pg = con.execute(f"""select count(*) from (
        select {FM_DATA_COLS} from _pg
        except select {FM_DATA_COLS} from fundamental_metrics)""").fetchone()[0]
    only_tb = con.execute(f"""select count(*) from (
        select {FM_DATA_COLS} from fundamental_metrics
        except select {FM_DATA_COLS} from _pg)""").fetchone()[0]
    gate("set_equality", only_pg == 0 and only_tb == 0,
         f"{only_pg} rows only in postgres, {only_tb} only in tierb")

    # The ADR-010 regression guard: AAPL's net_income vintages, tuple-for-tuple.
    aapl = None
    try:
        aapl = _pg_scalar("select id from securities where ticker='AAPL'")
    except Exception:
        pass
    if aapl:
        q = ("select period_end, fiscal_period, filed_date, value, source from {} "
             "where security_id=? and metric_code='net_income' "
             "order by period_end, fiscal_period, filed_date, source, value")
        a = con.execute(q.format("_pg"), [aapl]).fetchall()
        b = con.execute(q.format("fundamental_metrics"), [aapl]).fetchall()
        gate("aapl_net_income_vintages", a == b and len(a) > 0,
             f"{len(a)} vintage rows in postgres, {len(b)} in tierb, identical={a == b}")
    else:
        gate("aapl_net_income_vintages", False, "AAPL not found in securities")

    # Point-in-time behaviour on a real restatement: asof between two vintages
    # must return the EARLIER one (no look-ahead, ADR-005).
    r = con.execute("""select security_id, period_end, fiscal_period, metric_code
                       from fundamental_metrics where source='xbrl'
                       group by 1,2,3,4 having count(distinct filed_date) >= 2
                       limit 1""").fetchone()
    if r:
        sid, pe, fp, mc = r
        vintages = [v[0] for v in con.execute(
            """select filed_date from fundamental_metrics
               where security_id=? and period_end=? and fiscal_period=? and metric_code=?
                 and source='xbrl' order by filed_date""", [sid, pe, fp, mc]).fetchall()]
        asof = vintages[1] - timedelta(days=1)
        rows = tierb.metrics_asof(asof, metric_codes=[mc], security_ids=[sid],
                                  source="xbrl", con=con)
        got = [x for x in rows if str(x[1]) == str(pe) and x[2] == fp]
        ok = len(got) == 1 and got[0][8] == vintages[0]
        gate("asof_no_lookahead", ok,
             f"{mc} sec={sid} {pe}: asof {asof} -> filed {got[0][8] if got else None} "
             f"(expected {vintages[0]})")
    else:
        gate("asof_no_lookahead", False, "no restatement (>=2 vintages) found to test")

    ok = all(c["pass"] for c in checks.values())
    print(f"   verify: {'ALL GATES PASS' if ok else 'FAILED'}")
    return {"pass": ok, "checks": checks,
            "asof": datetime.now(timezone.utc).isoformat()}


def compact() -> dict:
    """Fold delta files into the partitioned base (dedupe applied via the view)."""
    print("== Tier-B compact ==")
    if not tierb.have_tierb():
        print("   nothing to compact (no store)")
        return {"compacted": 0}
    n_delta = len(list((tierb.root() / "fundamental_metrics" / "delta").glob("*.parquet")))
    con = tierb.connect()
    con.execute("create temp table _all as select * from fundamental_metrics")
    n = con.execute("select count(*) from _all").fetchone()[0]
    tmp = tierb.root() / f".fm-rewrite-{tierb._stamp()}"
    (tmp / "base").mkdir(parents=True)
    (tmp / "delta").mkdir()
    con.execute(f"""copy (select *, year(period_end) as year from _all)
                    to '{tierb._sql_path(tmp / "base")}'
                    (format parquet, compression zstd, partition_by (year))""")
    _swap_in(tmp)
    tierb._write_manifest()
    print(f"   compacted {n_delta} delta files into base ({n:,} rows)")
    return {"compacted": n_delta, "rows": n}


def bundle() -> Path:
    """Tar the store for upload as a CI artifact / release asset."""
    if not tierb.have_tierb():
        raise RuntimeError("no Tier B store to bundle")
    path = _bundle_path()
    path.parent.mkdir(exist_ok=True)
    with tarfile.open(path, "w:gz") as tar:
        tar.add(tierb.root(), arcname="tierb")
    print(f"   bundled {tierb.root()} -> {path} ({path.stat().st_size / 1e6:.1f} MB)")
    return path


def pull() -> dict:
    """Hydrate a fresh environment, best source first: already-present store ->
    Postgres re-export (pre-cutover) -> GitHub release asset. (R2 becomes the top
    of this waterfall when the store moves remote.)"""
    print("== Tier-B pull ==")
    if tierb.have_tierb():
        st = tierb.stats()
        print(f"   store already present ({st['fundamental_metrics']:,} rows) — nothing to do")
        return {"source": "existing", **st}
    if db.have_db():
        export()
        return {"source": "postgres", **tierb.stats()}
    tok, repo = os.getenv("GITHUB_TOKEN", ""), os.getenv("GITHUB_REPOSITORY", "")
    if tok and repo:
        import requests
        r = requests.get(f"https://api.github.com/repos/{repo}/releases/latest",
                         headers={"Authorization": f"Bearer {tok}"}, timeout=30)
        if r.ok:
            asset = next((a for a in r.json().get("assets", [])
                          if a["name"] == _bundle_path().name), None)
            if asset:
                dl = requests.get(asset["url"], timeout=300, headers={
                    "Authorization": f"Bearer {tok}", "Accept": "application/octet-stream"})
                dl.raise_for_status()
                _bundle_path().write_bytes(dl.content)
                with tarfile.open(_bundle_path()) as tar:
                    tar.extractall(tierb.root().parent)
                print(f"   pulled release asset {asset['name']}")
                return {"source": "release_asset", **tierb.stats()}
        print("   no usable release asset found")
    raise RuntimeError(
        "cannot hydrate Tier B: no store, no DATABASE_URL, no release asset. "
        "Set DATABASE_URL (pre-cutover) or publish a tierb-store.tar.gz release asset.")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(prog="engine.tierbsync", description="Tier-B sync job")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="Postgres -> Parquet")
    e.add_argument("--incremental", action="store_true",
                   help="append only rows the store lacks (default: full rebuild)")
    sub.add_parser("verify", help="parity gates vs Postgres")
    sub.add_parser("compact", help="fold delta files into base")
    sub.add_parser("bundle", help="tar the store for artifact/release upload")
    sub.add_parser("pull", help="hydrate a fresh environment")
    a = p.parse_args()
    if a.cmd == "export":
        export(incremental=a.incremental)
    elif a.cmd == "verify":
        report = verify()
        (tierb.root() / "verify_report.json").write_text(
            json.dumps(report, indent=2, default=str))
        raise SystemExit(0 if report["pass"] else 1)
    elif a.cmd == "compact":
        compact()
    elif a.cmd == "bundle":
        bundle()
    elif a.cmd == "pull":
        pull()
