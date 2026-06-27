-- Sector-Intelligence Agent: per-stock tagging + continuous catalog validation +
-- a change ledger, so sector tagging and KPI collection improve over time instead
-- of being static.

create table if not exists security_tags (
  security_id    bigint references securities(id),
  sic_code       text,
  sic_description text,
  sector         text,
  sub_sector     text,
  industry       text,
  source         text not null,        -- sic | llm | manual
  confidence     double precision,
  asof           date,
  updated_ts     timestamptz default now(),
  primary key (security_id, source)
);

-- Did each catalogued XBRL metric actually resolve (and look sane) in real filings?
create table if not exists catalog_validation (
  ts          timestamptz default now(),
  metric_code text,
  resolves    boolean,
  n_companies int,
  n_values    int,
  median_abs  double precision,
  sample      jsonb,
  verdict     text,                     -- ok | no_data | suspect
  note        text
);

-- Everything the agent changes (tagging, catalog fixes, taxonomy edits).
create table if not exists taxonomy_changes (
  ts     timestamptz default now(),
  kind   text,                          -- tag | catalog | taxonomy
  target text,
  change text,
  reason text,
  auto   boolean
);
