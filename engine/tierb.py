"""Tier-B storage: bulk time-series in Parquet, queried in-process by DuckDB.

Tier A (engine/db.py, Postgres) keeps the small relational STATE; this module owns
the bulk TIME-SERIES — `fundamental_metrics` and `prices`. Local-first: the store is
a directory of Parquet files (default data/tierb/, override TIERB_ROOT); the same
layer later points at Cloudflare R2 with no call-site changes.

Layout:
  <root>/manifest.json                            counts + tombstones (informational)
  <root>/fundamental_metrics/base/year=YYYY/…     compacted bulk, hive-partitioned
  <root>/fundamental_metrics/delta/part-*.parquet small daily appends
  <root>/prices/base/year=YYYY/…                  compacted daily OHLCV, hive-partitioned
  <root>/prices/delta/part-*.parquet              small daily appends
  <root>/filings/filings.parquet                  read-only MIRROR (Postgres is truth)

Point-in-time semantics live in the DATA, not the layout: every restatement vintage
is its own row keyed by filed_date — the same primary key as Postgres migration 0003.
Nothing is ever overwritten; appends anti-join on the key (≙ ON CONFLICT DO NOTHING),
and a dedupe view keeps the first-written row if duplicates ever land between
compactions. Single writer assumed (the one daily pipeline job).

Prices need no restatement vintage (one row per security per trading day is final
once printed) but DO need occasional full REPLACEMENT: a stock split re-bases a
source's entire historical series, which an anti-join append can't retroactively
fix. `replace_prices()` does a full rewrite-and-swap (used by the monthly full
refresh); `append_prices()` is the cheap daily incremental path.

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

# Daily OHLCV. No restatement vintage — a trading day's print is final — so the key
# is just (security_id, date). `source` records the provider (e.g. "stooq") in case
# a second price source is ever blended in.
PRICE_COLUMNS = ("security_id", "date", "open", "high", "low", "close", "volume",
                  "source", "ingested_at")
PRICE_KEY = ("security_id", "date")
PRICE_APPEND_COLUMNS = PRICE_COLUMNS[:8]  # ingested_at is filled in on write

_PRICE_DDL = ("security_id BIGINT, date DATE, open DOUBLE, high DOUBLE, low DOUBLE, "
              "close DOUBLE, volume DOUBLE, source VARCHAR, ingested_at TIMESTAMPTZ")


def _types(ddl: str) -> dict[str, str]:
    """column -> DuckDB type, parsed from a DDL string (single source of truth)."""
    return {t.strip().split(" ", 1)[0]: t.strip().split(" ", 1)[1]
            for t in ddl.split(",")}


def _fm_types() -> dict[str, str]:
    return _types(_FM_DDL)


def _price_types() -> dict[str, str]:
    return _types(_PRICE_DDL)


def _cast_select(cols, types: dict[str, str] | None = None) -> str:
    """`cast("c" as TYPE) as "c", …` — the one way rows get typed on entry."""
    types = types or _fm_types()
    return ", ".join(f'cast("{c}" as {types[c]}) as "{c}"' for c in cols)


def root() -> Path:
    return Path(os.getenv("TIERB_ROOT", "").strip() or (config.DATA_DIR / "tierb"))


def _fm_dir() -> Path:
    return root() / "fundamental_metrics"


def _price_dir() -> Path:
    return root() / "prices"


def _globs(base_dir: Path) -> list[str]:
    """Parquet globs that actually match files (DuckDB errors on empty globs)."""
    globs = []
    if any((base_dir / "base").rglob("*.parquet")):
        globs.append(str(base_dir / "base" / "**" / "*.parquet"))
    if any((base_dir / "delta").glob("*.parquet")):
        globs.append(str(base_dir / "delta" / "*.parquet"))
    return globs


def _fm_globs() -> list[str]:
    return _globs(_fm_dir())


def _price_globs() -> list[str]:
    return _globs(_price_dir())


def have_tierb() -> bool:
    """True once the store has been initialized (by tierbsync export)."""
    return bool(_fm_globs())


def have_prices() -> bool:
    """True once any price data has been ingested."""
    return bool(_price_globs())


def enabled() -> bool:
    """The one gate call sites use: store exists AND duckdb importable.

    Only a missing duckdb silences this; anything else (filesystem errors, a
    corrupt store) propagates — a broken store must fail loudly, not quietly
    fall back to Postgres and mask drift for the whole proving window.
    """
    try:
        import duckdb  # noqa: F401
    except ImportError:
        return False
    return have_tierb()


def _stamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def _sql_path(p) -> str:
    return str(p).replace("'", "''")


def _register_dedupe_view(con, name: str, columns, key, globs: list[str], types: dict[str, str]) -> None:
    """Create a DuckDB view over base/+delta/ Parquet, deduped on `key` (first
    ingested_at wins — the Parquet equivalent of ON CONFLICT DO NOTHING)."""
    cols = ", ".join(columns)
    if globs:
        files = ", ".join(f"'{_sql_path(g)}'" for g in globs)
        con.execute(f"""
            create or replace view {name} as
            select {cols} from (
              select *, row_number() over (
                partition by {', '.join(key)} order by ingested_at) as _rn
              from read_parquet([{files}], union_by_name=true, hive_partitioning=false)
            ) where _rn = 1""")
    else:  # empty typed view so queries still parse before the first export
        empty = ", ".join(f"cast(null as {t}) as {c}" for c, t in types.items())
        con.execute(f"create or replace view {name} as select {empty} where false")


def connect():
    """In-memory DuckDB with the Tier-B datasets registered as views.

    `fundamental_metrics` and `prices` each read base/ + delta/ and dedupe on their
    primary key (first-written row wins — the Parquet equivalent of ON CONFLICT DO
    NOTHING).
    """
    import duckdb

    con = duckdb.connect()
    _register_dedupe_view(con, "fundamental_metrics", FM_COLUMNS, FM_KEY, _fm_globs(), _fm_types())
    _register_dedupe_view(con, "prices", PRICE_COLUMNS, PRICE_KEY, _price_globs(), _price_types())
    filings = root() / "filings" / "filings.parquet"
    if filings.exists():
        con.execute("create or replace view filings as "
                    f"select * from read_parquet('{_sql_path(filings)}')")
    return con


def register_securities(con, rows: list[tuple]) -> None:
    """Overlay the authoritative (id, ticker) list from Postgres for joins."""
    con.execute("create or replace temp table securities_live (id bigint, ticker varchar)")
    if rows:
        con.executemany("insert into securities_live values (?, ?)", rows)


def _write_delta(con, relation: str, dataset_dir: Path | None = None) -> Path:
    """Write a relation as one new delta Parquet file and return its path."""
    dataset_dir = dataset_dir or _fm_dir()
    delta = dataset_dir / "delta"
    delta.mkdir(parents=True, exist_ok=True)
    out = delta / f"part-{_stamp()}.parquet"
    con.execute(f"copy {relation} to '{_sql_path(out)}' (format parquet, compression zstd)")
    return out


def _write_base(con, relation: str, dataset_dir: Path | None = None,
                partition_expr: str = "year(period_end)") -> Path:
    """Write a relation as a fresh year-partitioned base into a scratch dir.
    The scratch dir (with an empty delta/) is returned for _swap_in."""
    dataset_dir = dataset_dir or _fm_dir()
    tmp = root() / f".{dataset_dir.name}-rewrite-{_stamp()}"
    (tmp / "base").mkdir(parents=True)
    (tmp / "delta").mkdir()
    if con.execute(f"select count(*) from {relation}").fetchone()[0]:
        con.execute(f"""copy (select *, {partition_expr} as year from {relation})
                        to '{_sql_path(tmp / "base")}'
                        (format parquet, compression zstd, partition_by (year))""")
    return tmp


def _swap_in(tmp: Path, dataset_dir: Path | None = None) -> None:
    """Swap a freshly written dataset dir into place via renames: a crash leaves
    either the old or the new store, never a half-written one."""
    dataset_dir = dataset_dir or _fm_dir()
    old = root() / f".{dataset_dir.name}-old-{_stamp()}"
    if dataset_dir.exists():
        dataset_dir.rename(old)
    tmp.rename(dataset_dir)
    if old.exists():
        shutil.rmtree(old)


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
    con.execute(f"""
        create temp table _new as
        select i.*, cast(null as double) as confidence, now() as ingested_at
        from (select distinct on ({', '.join(FM_KEY)}) {_cast_select(FM_APPEND_COLUMNS)}
              from _incoming_df) i
        anti join fundamental_metrics f using ({', '.join(FM_KEY)})""")
    n = con.execute("select count(*) from _new").fetchone()[0]
    if n:
        _write_delta(con, "_new")
    return n


class MetricWriter:
    """Buffered Tier-B appender for ingestion loops: batches rows, flushes as
    delta files, and CAPTURES errors instead of raising — Tier B trouble must
    never break ingestion into the system of record. Callers surface `.error`.
    """

    def __init__(self, batch: int = 100_000):
        self.batch = batch
        self.rows: list[tuple] = []
        self.added = 0
        self.error: str | None = None

    def add(self, rows) -> None:
        self.rows.extend(rows)
        if len(self.rows) >= self.batch:
            self.flush()

    def flush(self) -> None:
        if not self.rows:
            return
        try:
            self.added += append_metrics(self.rows)
        except Exception as e:
            self.error = str(e)[:160]
        self.rows.clear()

    def close(self) -> None:
        self.flush()


def append_prices(rows) -> int:
    """Append OHLCV rows (PRICE_APPEND_COLUMNS order), skipping days already stored.

    The daily incremental path: cheap, anti-joins on (security_id, date) so re-feeding
    a ticker's recent window is idempotent. Cannot fix a stock split retroactively —
    that needs `replace_prices()`.
    """
    import pandas as pd

    rows = list(rows)
    if not rows:
        return 0
    df = pd.DataFrame(rows, columns=list(PRICE_APPEND_COLUMNS))
    con = connect()
    con.register("_incoming_df", df)
    con.execute(f"""
        create temp table _new as
        select i.*, now() as ingested_at
        from (select distinct on ({', '.join(PRICE_KEY)}) {_cast_select(PRICE_APPEND_COLUMNS, _price_types())}
              from _incoming_df) i
        anti join prices f using ({', '.join(PRICE_KEY)})""")
    n = con.execute("select count(*) from _new").fetchone()[0]
    if n:
        _write_delta(con, "_new", _price_dir())
    return n


def replace_prices(rows) -> int:
    """Full rewrite-and-swap of the ENTIRE prices store from a fresh fetch of every
    covered ticker's history. Used by the monthly full refresh (`prices.py --full`):
    a source's whole series shifts basis after a split, so only starting clean
    re-bases correctly. Rows in PRICE_APPEND_COLUMNS order, deduped by PK
    (first-in-batch wins — the batch itself should already be one row per PK)."""
    import pandas as pd

    rows = list(rows)
    if not rows:
        raise ValueError("replace_prices() refuses an empty batch — it would wipe the store")
    df = pd.DataFrame(rows, columns=list(PRICE_APPEND_COLUMNS))
    con = connect()
    con.register("_incoming_df", df)
    con.execute(f"""
        create temp table _all as
        select i.*, now() as ingested_at
        from (select distinct on ({', '.join(PRICE_KEY)}) {_cast_select(PRICE_APPEND_COLUMNS, _price_types())}
              from _incoming_df) i""")
    n = con.execute("select count(*) from _all").fetchone()[0]
    _swap_in(_write_base(con, "_all", _price_dir(), "year(date)"), _price_dir())
    return n


class PriceWriter:
    """Buffered Tier-B appender for the daily incremental price job — mirrors
    MetricWriter: batches rows, flushes as delta files, CAPTURES errors instead of
    raising (a Tier B write failure must not break the ingest loop)."""

    def __init__(self, batch: int = 200_000):
        self.batch = batch
        self.rows: list[tuple] = []
        self.added = 0
        self.error: str | None = None

    def add(self, rows) -> None:
        self.rows.extend(rows)
        if len(self.rows) >= self.batch:
            self.flush()

    def flush(self) -> None:
        if not self.rows:
            return
        try:
            self.added += append_prices(self.rows)
        except Exception as e:
            self.error = str(e)[:160]
        self.rows.clear()

    def close(self) -> None:
        self.flush()


def delete_price_securities(security_ids: list[int]) -> int:
    """Purge a batch of securities' ENTIRE price history — one rewrite-and-swap
    regardless of batch size. Used before re-fetching a ticker's full series (the
    clean way to re-base after a split: delete the old basis, then append fresh
    data with `append_prices`/PriceWriter — bounded memory throughout, no need to
    ever hold the whole store in Python)."""
    security_ids = [i for i in security_ids if i is not None]
    if not security_ids:
        return 0
    con = connect()
    n = con.execute(
        "select count(*) from prices where security_id in (select unnest(?::bigint[]))",
        [security_ids]).fetchone()[0]
    if not n:
        return 0
    con.execute(
        "create temp table _keep as select * from prices "
        "where security_id not in (select unnest(?::bigint[]))",
        [security_ids])
    _swap_in(_write_base(con, "_keep", _price_dir(), "year(date)"), _price_dir())
    return n


def delete_metric_codes(codes: list[str], source: str = "xbrl") -> int:
    """Purge metrics (mis-mapped tags) by rewriting the dataset without them —
    one rewrite-and-swap regardless of how many codes are purged."""
    codes = [c for c in codes if c]
    if not codes:
        return 0
    con = connect()
    n = con.execute(
        "select count(*) from fundamental_metrics "
        "where metric_code in (select unnest(?::varchar[])) and source=?",
        [codes, source]).fetchone()[0]
    if not n:
        return 0
    con.execute(
        "create temp table _keep as select * from fundamental_metrics "
        "where not (metric_code in (select unnest(?::varchar[])) and source=?)",
        [codes, source])
    _swap_in(_write_base(con, "_keep"))
    _write_manifest(tombstone={"metric_codes": codes, "source": source, "rows": n,
                               "at": datetime.now(timezone.utc).isoformat()})
    return n


def delete_metric_code(code: str, source: str = "xbrl") -> int:
    return delete_metric_codes([code], source)


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
    out["prices"] = con.execute("select count(*) from prices").fetchone()[0]
    if (root() / "filings" / "filings.parquet").exists():
        out["filings"] = con.execute("select count(*) from filings").fetchone()[0]
    return out


def stats() -> dict:
    """Store shape for pipeline reports: files, bytes, row counts, date span.
    Always includes the row counts (0 for an empty/uninitialized store)."""
    fm_files = list((_fm_dir() / "base").rglob("*.parquet")) + list((_fm_dir() / "delta").glob("*.parquet"))
    price_files = list((_price_dir() / "base").rglob("*.parquet")) + list((_price_dir() / "delta").glob("*.parquet"))
    out = {"root": str(root()), "initialized": have_tierb(),
           "base_files": len([f for f in fm_files if "base" in f.parts]),
           "delta_files": len([f for f in fm_files if "delta" in f.parts]),
           "prices_initialized": have_prices(),
           "prices_files": len(price_files),
           "bytes": sum(f.stat().st_size for f in fm_files + price_files)}
    out.update(counts())
    if out["fundamental_metrics"]:
        lo, hi = connect().execute(
            "select min(period_end), max(period_end) from fundamental_metrics").fetchone()
        out["period_span"] = [str(lo), str(hi)]
    if out["prices"]:
        lo, hi = connect().execute("select min(date), max(date) from prices").fetchone()
        out["price_span"] = [str(lo), str(hi)]
    return out


def _write_manifest(tombstone: dict | None = None) -> None:
    """Informational sidecar — counts for cheap sanity checks + purge tombstones.
    Written by the sync/purge operations (NOT the append hot path); the Parquet
    files themselves are the source of truth."""
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
