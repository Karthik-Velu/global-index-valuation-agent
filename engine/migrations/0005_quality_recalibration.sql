-- Data-Quality Agent + Recalibration Orchestrator.

-- Every data issue the quality agent finds (the warning feed).
create table if not exists data_quality_issues (
  id          bigint generated always as identity primary key,
  ts          timestamptz default now(),
  check_name  text,
  severity    text,                 -- error | warn | info
  scope       text,                 -- security | metric | index | source | filing
  entity      text,                 -- ticker / metric_code / index_key
  metric_code text,
  detail      text,
  value       double precision,
  status      text default 'open',  -- open | acknowledged | resolved
  resolved_ts timestamptz
);
create index if not exists dqi_open_idx on data_quality_issues (status, severity);

-- A versioned snapshot of the data the model/backtest is calibrated on.
create table if not exists data_versions (
  id                  bigint generated always as identity primary key,
  ts                  timestamptz default now(),
  n_securities        int,
  n_fundamental_rows  int,
  corrections_to_date int,
  note                text
);

-- Which data vintage each backtest used (so we know when it's stale).
create table if not exists backtest_runs (
  id              bigint generated always as identity primary key,
  ts              timestamptz default now(),
  data_version_id bigint references data_versions(id),
  window_start    date,
  window_end      date,
  status          text,
  metrics         jsonb,
  note            text
);

-- The orchestrator's recommendations.
create table if not exists recalibration_recommendations (
  id        bigint generated always as identity primary key,
  ts        timestamptz default now(),
  recommend boolean,
  kind      text,                  -- pending_initial | full_rebacktest | forward_only | none
  reason    text,
  evidence  jsonb
);
