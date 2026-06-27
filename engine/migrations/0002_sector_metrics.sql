-- Phase 1b — sector-aware fundamentals: catalog + flexible metric store + filings.
-- A flat table can't hold sector-specific KPIs (bank NIM/CET1, IT-services bookings,
-- REIT FFO, retail same-store sales...). So: a key-value metric store + a catalog
-- that says what each metric is and where it comes from (XBRL tag vs extraction).

alter table securities add column if not exists industry text;
alter table securities add column if not exists gics_sector text;

-- Definition of every metric we capture, per sector, and its provenance.
create table if not exists metric_catalog (
  metric_code        text primary key,
  label              text,
  definition         text,
  unit               text,        -- ratio|pct|currency|count|days|x
  category           text,        -- income|balance|cashflow|valuation|kpi|segment|quality|growth
  applies_to         text,        -- sectors/industries this matters for
  in_xbrl            boolean,     -- available in EDGAR us-gaap/dei XBRL?
  xbrl_tags          jsonb,       -- list of concept tags
  source_if_not_xbrl text,        -- mgmt_mdna|8k_press|investor_deck|computed|n_a
  importance         text,        -- critical|high|medium
  notes              text
);

-- Source documents (audited 10-K / quarterly 10-Q / management 8-K), point-in-time.
create table if not exists filings (
  id            bigint generated always as identity primary key,
  security_id   bigint references securities(id),
  form          text,             -- 10-K | 10-Q | 8-K | 20-F | ...
  period_end    date,
  fiscal_period text,
  filed_date    date,             -- point-in-time availability
  accession     text,
  audited       boolean,
  url           text,
  source        text,
  unique (security_id, accession)
);

-- Flexible metric store: any KPI, any sector, point-in-time + provenance.
-- `source` distinguishes xbrl (structured) from mgmt_extracted (LLM) so the backtest
-- can weight trust; restatements coexist as separate (filed_date, source) rows.
create table if not exists fundamental_metrics (
  security_id   bigint references securities(id),
  period_end    date not null,
  fiscal_period text not null,    -- FY|Q1..Q4
  metric_code   text not null,
  value         double precision,
  unit          text,
  report_type   text,             -- 10-K|10-Q|8-K|press|deck
  audited       boolean,
  filed_date    date,
  source        text not null,    -- xbrl | mgmt_extracted | computed | <provider>
  confidence    double precision, -- for LLM-extracted values (0..1)
  raw_tag       text,             -- the source field/concept
  ingested_at   timestamptz default now(),
  primary key (security_id, period_end, fiscal_period, metric_code, source)
);
create index if not exists fundmetrics_code_idx on fundamental_metrics (metric_code, period_end);
create index if not exists fundmetrics_sec_idx on fundamental_metrics (security_id, period_end);
