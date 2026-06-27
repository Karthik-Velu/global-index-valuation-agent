-- Model-specific learning: outcome metrics that feed adaptive waterfall routing,
-- and per-family prompt-packaging profiles. The model-AGNOSTIC knowledge lives in
-- engine/context/*.md (version-controlled), NOT here.

-- Every LLM attempt (success or fail) logged here -> the scorecard learns which
-- model is actually reliable/fast for each role.
create table if not exists model_invocations (
    id             bigserial primary key,
    ts             timestamptz not null default now(),
    role           text not null,            -- agent | cheap | smart | source_discovery | sector_research | ...
    model_id       text not null,            -- the scheme:model that was tried
    ok             boolean not null,
    error_kind     text,                     -- rate_limit | auth | server | timeout | other | null
    json_requested boolean default false,
    json_ok        boolean,                  -- did the caller's JSON parse succeed (optional, set later)
    latency_ms     integer,
    attempt        smallint default 1        -- position in the waterfall (1 = tier 1)
);
create index if not exists ix_model_inv_role_model on model_invocations(role, model_id, ts desc);

-- Learned reliability per (role, model): the order the waterfall *could* adapt to.
create or replace view model_scorecard as
select
    role,
    model_id,
    count(*)                                                          as n,
    round(avg(case when ok then 1 else 0 end)::numeric, 3)           as success_rate,
    round(avg(case when json_requested
                   then (case when json_ok then 1 else 0 end) end)::numeric, 3) as json_rate,
    percentile_cont(0.5) within group (order by latency_ms)          as p50_latency_ms,
    sum(case when error_kind = 'rate_limit' then 1 else 0 end)       as rate_limit_hits,
    max(ts)                                                          as last_seen
from model_invocations
group by role, model_id;

-- Per-family prompt-packaging quirks. profile() falls back to heuristics if empty,
-- so this table is optional — it just makes the packaging explicit and editable.
create table if not exists model_profiles (
    family             text primary key,     -- claude | gpt-oss | deepseek | llama | qwen | glm | mistral | ...
    supports_json_mode boolean default true, -- does response_format work?
    force_json_suffix  boolean default false,-- append a hard "JSON only" nudge?
    notes              text,
    updated_at         timestamptz default now()
);

insert into model_profiles(family, supports_json_mode, force_json_suffix, notes) values
    ('claude',   false, false, 'Anthropic: no response_format param; strong instruction-following'),
    ('gpt-oss',  true,  false, 'Ollama Cloud OSS (gpt-oss:20b/120b); reliable JSON'),
    ('deepseek', true,  false, 'Strong JSON + reasoning'),
    ('llama',    true,  true,  'Smaller variants drop fields without a hard JSON-only nudge'),
    ('qwen',     true,  true,  'Small local variants need a JSON-only nudge'),
    ('glm',      true,  false, 'GLM-4-Flash free tier'),
    ('mistral',  true,  false, null)
on conflict (family) do nothing;
