-- Semantic memory: the consolidated, queryable middle tier between the raw episodic
-- logs (model_invocations, source_evals, predictions, …) and the curated, version-
-- controlled playbooks in engine/context/*.md. This is where learnings persist with
-- provenance, confidence, lifecycle status, and a full audit history so nothing is
-- lost and the past belief-state can be reconstructed for backtests.

create table if not exists lessons (
    id                bigserial primary key,
    scope             text not null,                 -- 'global' | role | 'sector_research:banks' | 'source:stooq'
    kind              text not null default 'fact',  -- rule | fact | gotcha | source_status | kpi
    claim             text not null,                 -- the lesson itself (one atomic statement)
    dedup_key         text not null unique,          -- normalized scope+claim, for merge-on-capture
    status            text not null default 'candidate',  -- candidate | active | promoted | retired | superseded
    confidence        numeric(4,3) not null default 0.500,
    evidence_count    integer not null default 1,
    contradiction_count integer not null default 0,
    origin            text,                          -- which agent / run / human produced it
    testable          boolean not null default false,
    test_hint         text,                          -- how to re-verify it (for the decay job)
    superseded_by     bigint references lessons(id),
    first_seen        timestamptz not null default now(),
    last_confirmed    timestamptz not null default now(),
    last_contradicted timestamptz,
    last_used         timestamptz,
    promoted_at       timestamptz,
    -- generated lexical index so retrieval works even with no embedding model
    search            tsvector generated always as (to_tsvector('english', coalesce(claim, ''))) stored
);
create index if not exists ix_lessons_scope_status on lessons(scope, status);
create index if not exists ix_lessons_status_conf on lessons(status, confidence desc);
create index if not exists ix_lessons_search on lessons using gin(search);

-- Append-only history: every state change, so we can answer "what did the system
-- believe at time T?" (point-in-time integrity for backtests) and audit the loop.
create table if not exists lesson_events (
    id          bigserial primary key,
    lesson_id   bigint not null references lessons(id) on delete cascade,
    ts          timestamptz not null default now(),
    event       text not null,            -- captured | confirmed | contradicted | promoted | retired | superseded | status_change
    from_status text,
    to_status   text,
    confidence  numeric(4,3),
    detail      text,
    origin      text
);
create index if not exists ix_lesson_events_lesson on lesson_events(lesson_id, ts);
create index if not exists ix_lesson_events_ts on lesson_events(ts);

-- Bootstrap the durable facts we already know (status='promoted' = also curated in
-- the .md playbooks). Idempotent via the unique dedup_key.
insert into lessons (scope, kind, claim, dedup_key, status, confidence, evidence_count, origin, testable, test_hint, promoted_at)
values
 ('source:stooq', 'source_status',
  'Stooq added a SHA-256 proof-of-work bot challenge and returns 404 to plain HTTP; treat as dead for automated use until a verified workaround exists.',
  'source:stooq|stooq-dead-pow-challenge', 'promoted', 0.900, 3, 'data-quality probe', true,
  'GET a stooq CSV endpoint; if 404/challenge, still dead.', now()),
 ('global', 'rule',
  'Yahoo / yfinance data is license-restricted (personal use) and is NOT usable for the public product; prefer SEC EDGAR (public domain) for fundamentals.',
  'global|yahoo-license-restricted', 'promoted', 0.950, 5, 'human', false, null, now()),
 ('sector_research:catalog', 'gotcha',
  'gross_margin, asset_turnover, net_debt_to_ebitda, sga_ratio and interest_coverage are ratios that must be COMPUTED from components, not pulled as a direct XBRL tag (they were mis-tagged and demoted).',
  'sector_research:catalog|computed-ratio-metrics', 'promoted', 0.900, 1, 'sector validator', false, null, now())
on conflict (dedup_key) do nothing;

insert into lesson_events (lesson_id, event, to_status, confidence, detail, origin)
select id, 'captured', status, confidence, 'seeded from known durable facts', origin
from lessons where dedup_key in (
  'source:stooq|stooq-dead-pow-challenge',
  'global|yahoo-license-restricted',
  'sector_research:catalog|computed-ratio-metrics')
on conflict do nothing;
