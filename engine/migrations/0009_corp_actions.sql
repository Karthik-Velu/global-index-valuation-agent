-- Corporate actions: dividends + splits (Massive/Polygon.io reference data).
--
-- Splits are ALREADY reflected in price bars (engine/sources/prices.py fetches
-- adjusted=true, split-adjusted grouped-daily data) — the splits table exists
-- as an audit trail (explains a price series's rebasing) rather than something
-- downstream code re-derives prices from.
--
-- Dividends are NOT reflected in the (split-only) adjusted price series, so this
-- table is what lets stockvaluation.py compute a real trailing-12-month
-- dividend_yield instead of the hardcoded 0.0 placeholder it shipped with.

create table if not exists dividends (
  id                bigint generated always as identity primary key,
  security_id       bigint references securities(id),
  ticker            text not null,      -- Massive's ticker; rows for tickers we
                                         -- don't track are fetched but not matched
  cash_amount       double precision,   -- USD per share
  currency          text,
  dividend_type     text,               -- CD (regular), SC (special), LT, ST
  declaration_date  date,
  ex_dividend_date  date,
  record_date       date,
  pay_date          date,
  frequency         int,                -- 0 one-time,1 annual,2 semi,4 quarterly,12 monthly,52 weekly,...
  source            text not null default 'massive',
  ingested_at       timestamptz default now(),
  unique (ticker, ex_dividend_date, cash_amount)
);
create index if not exists dividends_security_exdate_idx on dividends(security_id, ex_dividend_date);

create table if not exists splits (
  id                bigint generated always as identity primary key,
  security_id       bigint references securities(id),
  ticker            text not null,
  execution_date    date,
  split_from        double precision,
  split_to          double precision,
  source            text not null default 'massive',
  ingested_at       timestamptz default now(),
  unique (ticker, execution_date, split_from, split_to)
);
create index if not exists splits_security_date_idx on splits(security_id, execution_date);
