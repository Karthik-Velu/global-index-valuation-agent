-- Analyst agent (ARCHITECTURE.md Pillar 1): falsifiable theses on markets,
-- written with a FIXED eval date and graded later against realized returns
-- (engine/agent/reflect.py). market_key is a plain text key (like
-- predictions.key), not a securities FK: v1 investigates INDEX-level markets
-- (indices.key); `kind` future-proofs stock-level reuse without a schema change.

create table if not exists theses (
  id               bigint generated always as identity primary key,
  market_key       text not null,
  kind             text not null default 'index',   -- index | stock
  asof             date not null,                    -- valuation-run date the thesis was written
  claim            text not null,                    -- one falsifiable sentence
  direction        text not null,                    -- up | down | flat
  eval_date        date not null,                     -- FIXED at write time, never moved
  confidence       double precision not null default 0.5,
  evidence         jsonb,                             -- the ReAct scratchpad (tool calls + results)
  model_id         text,
  status           text not null default 'open',      -- open | graded
  outcome          text,                               -- correct | incorrect | inconclusive
  realized_return  double precision,
  graded_ts        timestamptz,
  created_ts       timestamptz not null default now()
);
create index if not exists ix_theses_open_eval on theses(status, eval_date);
create index if not exists ix_theses_market on theses(market_key, asof desc);
