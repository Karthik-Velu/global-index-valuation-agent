-- Phase 1 — Tier A (relational state) core schema.
-- Principle: point-in-time (as-of / filed dates) + source provenance on every row,
-- so the future backtest uses only what was knowable then. Bulk time-series (prices,
-- event history, backtest panels) live in Parquet/DuckDB (Tier B), not here.

-- Tradable entities: stocks and the ETF proxies.
create table if not exists securities (
  id          bigint generated always as identity primary key,
  ticker      text not null,
  exchange    text default '',
  name        text,
  country     text,
  currency    text,
  sector      text,
  cik         text,        -- SEC CIK (US)
  isin        text,
  figi        text,
  kind        text default 'stock',   -- stock | etf
  created_at  timestamptz default now(),
  unique (ticker, exchange)
);

-- The indices we track (proxy-based in Phase 1).
create table if not exists indices (
  key         text primary key,
  name        text,
  proxy_etf   text,
  country     text,
  region      text,
  index_kind  text          -- Country | Sector | Style | Region | Broad
);

-- Point-in-time index membership + weight (survivorship-safe history).
create table if not exists index_constituents (
  index_key   text not null references indices(key),
  security_id bigint not null references securities(id),
  weight      double precision,
  asof        date not null,
  source      text,
  primary key (index_key, security_id, asof)
);

-- Point-in-time stock fundamentals, as filed (filed_date = when it became knowable).
create table if not exists fundamentals (
  security_id         bigint not null references securities(id),
  period_end          date not null,
  fiscal_year         int,
  fiscal_period       text,            -- FY | Q1..Q4
  filed_date          date,            -- point-in-time availability
  currency            text,
  revenue             double precision,
  net_income          double precision,
  total_equity        double precision,
  total_assets        double precision,
  shares_diluted      double precision,
  rev_growth_yoy      double precision,
  earnings_growth_yoy double precision,
  source              text not null,
  ingested_at         timestamptz default now(),
  primary key (security_id, period_end, fiscal_period, source)
);
create index if not exists fundamentals_sec_idx on fundamentals (security_id, period_end);

-- Historized scoreboard (computed output, one row per index per run).
create table if not exists index_metrics (
  index_key         text not null references indices(key),
  asof              date not null,
  pe double precision, pb double precision, ps double precision,
  dividend_yield double precision,
  value_score double precision, growth_score double precision,
  momentum_score double precision, opportunity_score double precision,
  overvalued boolean, value_trap boolean, garp boolean,
  source text,
  primary key (index_key, asof)
);

-- Prediction ledger + grading (migrated from SQLite).
create table if not exists predictions (
  asof date, key text, symbol text, price double precision,
  value_score double precision, opportunity_score double precision,
  momentum_score double precision, mean_reversion_score double precision,
  growth_score double precision, overvalued boolean, value_trap boolean,
  primary key (asof, key)
);
create table if not exists accuracy (
  asof date primary key, horizon_days int, rank_ic double precision,
  hit_rate double precision, n int, detail jsonb
);

-- Data-ingestion agent: catalog + evals + needs + decisions.
create table if not exists data_sources (
  id text primary key, name text, provider text, kinds text, coverage text,
  access_method text, endpoint text, auth text, free_tier text, license text,
  update_freq text, notes text, sample_hint text,
  verified_live boolean, has_adapter boolean, status text, confidence text,
  added_ts timestamptz, updated_ts timestamptz
);
create table if not exists source_evals (
  ts timestamptz, source_id text, kind text, coverage_pct double precision,
  completeness_pct double precision, sanity_pct double precision,
  freshness_days double precision, latency_ms double precision, rate_ok boolean,
  quality_score double precision, sample_n int, error text, detail jsonb
);
create table if not exists data_needs (
  id text primary key, kind text, market_scope text, description text,
  active_source_id text, target_freq text, public_only boolean, updated_ts timestamptz
);
create table if not exists source_decisions (
  ts timestamptz, need_id text, from_source text, to_source text,
  reason text, auto boolean, applied boolean
);

-- News / macro event metadata (full history lands in Parquet; meta is queryable here).
create table if not exists events (
  id          bigint generated always as identity primary key,
  ts          timestamptz,
  source      text,
  kind        text,            -- news | filing | macro
  entity      text,
  security_id bigint references securities(id),
  index_key   text,
  event_type  text,
  sentiment   double precision,
  magnitude   double precision,
  headline    text,
  url         text,
  raw         jsonb
);
create index if not exists events_ts_idx on events (ts);

-- User feedback (per-user dimension ready for multi-user; RLS added in Phase 4).
create table if not exists feedback (
  ts timestamptz, user_id text, kind text, target text, signal text, note text
);
