"""Tier-B storage: bulk time-series in Parquet, queried in-process by DuckDB.

Tier A (engine/db.py, Postgres) keeps the small relational STATE; this module owns
the bulk TIME-SERIES — `fundamental_metrics` today, prices next. Local-first: the
store is a directory of Parquet files (default data/tierb/, override TIERB_ROOT);
the same layer later points at Cloudflare R2 with no call-site changes.

Layout:
  <root>/manifest.json                            counts + tombstones (informational)
  <root>/fundamental_metrics/base/year=YYYY/…     compacted bulk, hive-partitioned
  <root>/fundamental_metrics/delta/part-*.parquet small daily appends
  <root>/filings/filings.parquet                  read-only MIRROR (Postgres is truth)
  <root>/securities/securities.parquet            read-only SNAPSHOT (Postgres is truth)

Point-in-time semantics live in the DATA, not the layout: every restatement vintage
is its own row keyed by filed_date — the same primary key as Postgres migration 0003.
Nothing is ever overwritten; appends anti-join on the key (≙ ON CONFLICT DO NOTHING),
and a dedupe view keeps the first-written row if duplicates ever land between
compactions. Single writer assumed (the one daily pipeline job).

Until the store exists (created by `python -m engine.tierbsync export`), every caller
falls back to Postgres — so merging this layer changes nothing by itself.
"""
from __future__ import annotations

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path

from . import config

# Column order is the contract for append_metrics() rows and metrics_asof() results.
FM_COLUMNS = ("security_id", "period_end", "fiscal_period", "metric_code", "value",
              "unit", "report_type", "audited", "filed_date", "raw_tag", "source",
              "confidence", "ingested_at")
# The Postgres primary key (migration 0003) — one row per restatement vintage.
FM_KEY = ("security_id", "period_end", "fiscal_period", "metric_code", "source", "filed_date")
# What ingestion supplies; confidence/ingested_at are filled in by append_metrics.
FM_APPEND_COLUMNS = FM_COLUMNS[:11]

_FM_DDL = ("security_id BIGINT, period_end DATE, fiscal_period VARCHAR, "
           "metric_code VARCHAR, value DOUBLE, unit VARCHAR, report_type VARCHAR, "
           "audited BOOLEAN, filed_date DATE, raw_tag VARCHAR, source VARCHAR, "
           "confidence DOUBLE, ingested_at TIMESTAMPTZ")


def _fm_types() -> dict[str, str]:
    """column -> DuckDB type, parsed from the DDL (single source of truth)."""
    return {t.strip().split(" ", 1)[0]: t.strip().split(" ", 1)[1]
            for t in _FM_DDL.split(",")}


def root() -> Path:
    return Path(os.getenv("TIERB_ROOT", "").strip() or (config.DATA_DIR / "tierb"))


def _fm_dir() -> Path:
    return root() / "fundamental_metrics"


def _fm_globs() -> list[str]:
    """Parquet globs that actually match files (DuckDB errors on empty globs)."""
    globs = []
    if any((_fm_dir() / "base").rglob("*.parquet")):
        globs.append(str(_fm_dir() / "base" / "**" / "*.parquet"))
    if any((_fm_dir() / "delta").glob("*.parquet")):
        globs.append(str(_fm_dir() / "delta" / "*.parquet"))
    return globs


def have_tierb() -> bool:
    """True once the store has been initialized (by tierbsync export)."""
    return bool(_fm_globs())


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _sql_path(p) -> str:
    return str(p).replace("'", "''")


def connect():
    """In-memory DuckDB with the Tier-B datasets registered as views.

    `fundamental_metrics` reads base/ + delta/ and dedupes on the primary key
    (first-written row wins — the Parquet equivalent of ON CONFLICT DO NOTHING).
    """
    import duckdb

    con = duckdb.connect()
    cols = ", ".join(FM_COLUMNS)
    globs = _fm_globs()
    if globs:
        files = ", ".join(f"'{_sql_path(g)}'" for g in globs)
        con.execute(f"""
            create or replace view fundamental_metrics as
            select {cols} from (
              select *, row_number() over (
                partition by {', '.join(FM_KEY)} order by ingested_at) as _rn
              from read_parquet([{files}], union_by_name=true, hive_partitioning=false)
            ) where _rn = 1""")
    else:  # empty typed view so queries still parse before the first export
        empty = ", ".join(f"cast(null as {t.split(' ', 1)[1]}) as {t.split(' ', 1)[0]}"
                          for t in (s.strip() for s in _FM_DDL.split(",")))
        con.execute(f"create or replace view fundamental_metrics as select {empty} where false")
    for name in ("filings", "securities"):
        f = root() / name / f"{name}.parquet"
        if f.exists():
            con.execute(f"create or replace view {name} as "
                        f"select * from read_parquet('{_sql_path(f)}')")
    return con


def register_securities(con, rows: list[tuple]) -> None:
    """Overlay the authoritative (id, ticker) list from Postgres for joins."""
    con.execute("create or replace temp table securities_live (id bigint, ticker varchar)")
    if rows:
        con.executemany("insert into securities_live values (?, ?)", rows)


def append_metrics(rows) -> int:
    """Append metric rows (FM_APPEND_COLUMNS order), skipping ones already stored.

    The anti-join on FM_KEY replicates Postgres' ON CONFLICT DO NOTHING, so callers
    can (re-)feed complete EDGAR companyfacts and only genuinely new vintages land.
    Each call writes at most one delta file; compaction folds deltas into base.
    """
    import pandas as pd

    rows = list(rows)
    if not rows:
        return 0
    df = pd.DataFrame(rows, columns=list(FM_APPEND_COLUMNS))
    con = connect()
    con.register("_incoming_df", df)
    casts = ", ".join(f'cast("{c}" as {_fm_types()[c]}) as "{c}"' for c in FM_APPEND_COLUMNS)
    con.execute(f"""
        create temp table _new as
        select i.*, cast(null as double) as confidence, now() as ingested_at
        from (select distinct on ({', '.join(FM_KEY)}) {casts} from _incoming_df) i
        anti join fundamental_metrics f using ({', '.join(FM_KEY)})""")
    n = con.execute("select count(*) from _new").fetchone()[0]
    if n:
        delta = _fm_dir() / "delta"
        delta.mkdir(parents=True, exist_ok=True)
        out = delta / f"part-{_stamp()}.parquet"
        con.execute(f"copy _new to '{_sql_path(out)}' (format parquet, compression zstd)")
        _write_manifest()
    return n


def delete_metric_code(code: str, source: str = "xbrl") -> int:
    """Purge a metric (mis-mapped tag) by rewriting the dataset without it.

    The rewrite goes to a scratch dir first and is swapped in with renames, so a
    crash leaves either the old or the new store — never a half-written one.
    """
    con = connect()
    n = con.execute("select count(*) from fundamental_metrics where metric_code=? and source=?",
                    [code, source]).fetchone()[0]
    if not n:
        return 0
    con.execute("create temp table _keep as select * from fundamental_metrics "
                "where not (metric_code=? and source=?)", [code, source])
    tmp = root() / f".fm-rewrite-{_stamp()}"
    (tmp / "base").mkdir(parents=True)
    (tmp / "delta").mkdir()
    if con.execute("select count(*) from _keep").fetchone()[0]:
        con.execute(f"""copy (select *, year(period_end) as year from _keep)
                        to '{_sql_path(tmp / "base")}'
                        (format parquet, compression zstd, partition_by (year))""")
    old = root() / f".fm-old-{_stamp()}"
    _fm_dir().rename(old)
    tmp.rename(_fm_dir())
    shutil.rmtree(old)
    _write_manifest(tombstone={"metric_code": code, "source": source, "rows": n,
                               "at": datetime.now(timezone.utc).isoformat()})
    return n


def metrics_asof(asof, metric_codes: list[str] | None = None,
                 security_ids: list[int] | None = None,
                 source: str | None = None, con=None) -> list[tuple]:
    """Point-in-time read: the latest vintage of each metric filed on or before
    `asof` (per security/period/metric/source) — rows in FM_COLUMNS order. This is
    the no-look-ahead query the backtest is built on (ADR-005 / migration 0003).
    """
    con = con or connect()
    where, params = ["filed_date <= ?"], [asof]
    if metric_codes:
        where.append("metric_code in (select unnest(?::varchar[]))")
        params.append(list(metric_codes))
    if security_ids:
        where.append("security_id in (select unnest(?::bigint[]))")
        params.append(list(security_ids))
    if source:
        where.append("source = ?")
        params.append(source)
    key_no_vintage = ", ".join(c for c in FM_KEY if c != "filed_date")
    return con.execute(f"""
        select {', '.join(FM_COLUMNS)} from fundamental_metrics
        where {' and '.join(where)}
        qualify row_number() over (
          partition by {key_no_vintage} order by filed_date desc) = 1""",
        params).fetchall()


def counts() -> dict:
    con = connect()
    out = {"fundamental_metrics": con.execute(
        "select count(*) from fundamental_metrics").fetchone()[0]}
    if (root() / "filings" / "filings.parquet").exists():
        out["filings"] = con.execute("select count(*) from filings").fetchone()[0]
    return out


def stats() -> dict:
    """Store shape for pipeline reports: files, bytes, row counts, date span."""
    base_files = list((_fm_dir() / "base").rglob("*.parquet"))
    delta_files = list((_fm_dir() / "delta").glob("*.parquet"))
    out = {"root": str(root()), "initialized": have_tierb(),
           "base_files": len(base_files), "delta_files": len(delta_files),
           "bytes": sum(f.stat().st_size for f in base_files + delta_files)}
    if out["initialized"]:
        con = connect()
        out.update(counts())
        lo, hi = con.execute(
            "select min(period_end), max(period_end) from fundamental_metrics").fetchone()
        out["period_span"] = [str(lo), str(hi)]
    return out


def _write_manifest(tombstone: dict | None = None) -> None:
    """Informational sidecar — counts for cheap sanity checks + purge tombstones.
    The Parquet files themselves are the source of truth."""
    path = root() / "manifest.json"
    m = {"schema_version": 1, "tombstones": []}
    if path.exists():
        try:
            m = json.loads(path.read_text())
        except Exception:
            pass
    if tombstone:
        m.setdefault("tombstones", []).append(tombstone)
    m["updated_at"] = datetime.now(timezone.utc).isoformat()
    m["counts"] = counts()
    path.write_text(json.dumps(m, indent=2))


if __name__ == "__main__":
    print(json.dumps(stats(), indent=2))
