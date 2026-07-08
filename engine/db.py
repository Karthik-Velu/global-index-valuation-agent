"""Tier-A database access: Postgres (Supabase) for relational state.

Reads DATABASE_URL from the environment (.env, loaded by config). Secrets never
leave this process — callers get a connection, not the URL. Bulk time-series lives
in Parquet/DuckDB (Tier B), not here.
"""
from __future__ import annotations

import os
from pathlib import Path

from . import config  # noqa: F401  (ensures .env is loaded via config's load_dotenv)

MIGRATIONS_DIR = Path(__file__).parent / "migrations"


def database_url() -> str:
    return os.getenv("DATABASE_URL", "").strip()


def have_db() -> bool:
    return bool(database_url())


def connect():
    """Open a psycopg3 connection to Supabase Postgres (SSL required)."""
    import psycopg

    url = database_url()
    if not url:
        raise RuntimeError("DATABASE_URL not set — add it to .env (Supabase > Settings > Database).")
    # Supabase requires SSL; the pooler URI honors sslmode in the query string or via param.
    kwargs = {}
    if "sslmode=" not in url:
        kwargs["sslmode"] = "require"
    # TCP keepalives: when the pooler silently drops the server side mid-stream,
    # a keepalive-less client blocks FOREVER on the dead socket (a 3.5M-row
    # tierbsync stream hung a CI job to its 60-min timeout on 2026-07-07).
    # With these, the dead peer is detected in ~2 min and the call raises —
    # loud failure + retry beats a silent hang.
    kwargs.setdefault("connect_timeout", 30)
    kwargs.setdefault("keepalives", 1)
    kwargs.setdefault("keepalives_idle", 30)
    kwargs.setdefault("keepalives_interval", 15)
    kwargs.setdefault("keepalives_count", 6)
    return psycopg.connect(url, **kwargs)


def ping() -> str:
    """Return the server version string if reachable (raises otherwise)."""
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select version()")
        return cur.fetchone()[0]


def apply_migrations() -> list[str]:
    """Apply any *.sql migrations not yet applied (tracked in schema_migrations).

    Commits per-migration, so a failure in one (e.g. an optional pgvector step on a
    DB without the extension) leaves earlier migrations applied rather than rolling
    the whole batch back.
    """
    applied_now = []
    with connect() as conn:
        with conn.cursor() as cur:
            cur.execute("create table if not exists schema_migrations "
                        "(name text primary key, applied_at timestamptz default now())")
            cur.execute("select name from schema_migrations")
            done = {r[0] for r in cur.fetchall()}
        conn.commit()
        for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
            if f.name in done:
                continue
            try:
                with conn.cursor() as cur:
                    cur.execute(f.read_text())
                    cur.execute("insert into schema_migrations(name) values (%s)", (f.name,))
                conn.commit()
                applied_now.append(f.name)
            except Exception:
                conn.rollback()
                raise
    return applied_now


def tables() -> list[str]:
    with connect() as conn, conn.cursor() as cur:
        cur.execute("select table_name from information_schema.tables "
                    "where table_schema='public' order by table_name")
        return [r[0] for r in cur.fetchall()]
