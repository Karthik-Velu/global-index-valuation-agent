-- Admin proposal review (ADR-028) — the missing second half of the meta-loop.
--
-- docs/AGENTS.md promises: "an agent's output is a proposal ... a human or a
-- follow-up step turns the proposal into a deterministic rule." That follow-up
-- step never existed. Agents wrote free-text rows into `taxonomy_changes` and
-- nothing ever read them, so the same fix was re-proposed daily forever
-- (capex_intensity 15x in 7 days; Quality-Triage cycling the same 4 targets).
-- 166 proposals accumulated; zero were ever applied.
--
-- This schema makes a proposal a first-class reviewable object with:
--   * a UNIQUE dedup_key            -> re-proposing bumps evidence, never duplicates
--   * a decision status machine      -> declined is terminal and blocks re-capture
--   * the fixed 4-part English format the admin reads (proposal / reason /
--     expected outcome / worked examples)
--   * an append-only audit log       -> every transition, who and when
--   * a chat thread                  -> ask before deciding
--   * a Builder solution record      -> for proposals that are code, not data
--
-- `taxonomy_changes` is NOT retrofitted: it stays what it always was, an
-- append-only event log of what the agents *said*. This is the review queue —
-- a different lifetime (one row per distinct idea, mutated by decisions) and a
-- different access pattern. The 166 legacy rows are collapsed into this table
-- by engine/proposals.py::backfill_from_taxonomy().

-- ---------------------------------------------------------------------------
-- Who may review. A table, not a hardcoded email, so adding a second reviewer
-- is an INSERT rather than a migration + redeploy. Seeded with the owner.
-- ---------------------------------------------------------------------------
create table if not exists admins (
  email       text primary key,
  note        text,
  created_at  timestamptz not null default now()
);

insert into admins(email, note) values ('kaartik.velu@gmail.com', 'owner')
  on conflict (email) do nothing;

-- auth.jwt() is null outside a PostgREST request (e.g. the engine's own direct
-- psycopg connection), so this is false for the batch jobs — which is correct:
-- they bypass RLS by connecting as the table owner, they don't impersonate one.
-- SECURITY DEFINER + a pinned search_path so a caller can't shadow `admins`.
create or replace function is_admin() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------------------------------------------------------------------------
-- The review queue.
-- ---------------------------------------------------------------------------
create table if not exists proposals (
  id              bigint generated always as identity primary key,

  -- provenance
  source_agent    text not null,               -- quality-triage | sector-research | source-discovery | model-upgrade
  kind            text not null,               -- catalog_kpi | quality_check | source_adapter | model_routing
  target          text not null,               -- the metric_code / check_name / source_id being talked about
  model_id        text,                        -- the model that ACTUALLY answered (not the configured default)

  -- identity: the whole point. One row per distinct idea, forever.
  dedup_key       text not null unique,

  -- the fixed 4-part format the admin reads. `proposal` is the only field an
  -- agent must supply; the other three are enriched (see needs_enrichment).
  proposal          text not null,
  reason            text,
  expected_outcome  text,
  worked_examples   jsonb not null default '[]'::jsonb,
  needs_enrichment  boolean not null default true,

  -- how strongly the agents keep asking for this
  evidence_count  integer not null default 1,
  first_seen      timestamptz not null default now(),
  last_seen       timestamptz not null default now(),

  -- decision
  -- pending  -> awaiting review
  -- approved -> decided yes, not yet actioned
  -- actioned -> applied to the system (data kinds), terminal-happy
  -- queued_build -> approved, is code, GitHub issue filed, Builder owns it
  -- declined -> terminal. capture() refuses to ever raise this dedup_key again.
  -- parked   -> resurfaces when park_until passes OR evidence reaches park_min_evidence
  -- failed   -> approved but actioning errored; retried by the daily pipeline
  status            text not null default 'pending'
                    check (status in ('pending','approved','actioned','queued_build',
                                      'declined','parked','failed')),
  decided_at        timestamptz,
  decided_by        text,
  decision_note     text,

  -- park semantics: "bring this back when there's more data"
  park_until          date,
  park_min_evidence   integer,

  -- actioning outcome
  actioned_at     timestamptz,
  action_detail   text,                        -- what was actually done, or the error
  issue_url       text,                        -- code kinds: the filed GitHub issue

  payload         jsonb not null default '{}'::jsonb   -- the agent's raw structured output
);

create index if not exists ix_proposals_queue on proposals(status, evidence_count desc, last_seen desc);
create index if not exists ix_proposals_kind on proposals(kind, status);
-- Partial index for the daily unpark sweep, which only ever scans parked rows.
create index if not exists ix_proposals_parked on proposals(park_until) where status = 'parked';

-- ---------------------------------------------------------------------------
-- Audit log. Append-only: no update/delete policy exists for anyone, so a
-- decision trail cannot be rewritten from the client even by an admin.
-- ---------------------------------------------------------------------------
create table if not exists proposal_events (
  id           bigint generated always as identity primary key,
  proposal_id  bigint not null references proposals(id) on delete cascade,
  ts           timestamptz not null default now(),
  event        text not null,        -- captured | evidence_bumped | enriched | decided | actioned | action_failed | unparked | message | solution_*
  from_status  text,
  to_status    text,
  actor        text not null,        -- an admin email, or an agent name for automated transitions
  detail       text
);
create index if not exists ix_proposal_events_p on proposal_events(proposal_id, ts desc);

-- ---------------------------------------------------------------------------
-- Chat: ask questions before deciding. Scoped to one proposal.
-- ---------------------------------------------------------------------------
create table if not exists proposal_messages (
  id           bigint generated always as identity primary key,
  proposal_id  bigint not null references proposals(id) on delete cascade,
  ts           timestamptz not null default now(),
  role         text not null check (role in ('admin','assistant')),
  body         text not null,
  model_id     text,                 -- which model answered (assistant rows only)
  author       text                  -- admin email (admin rows only)
);
create index if not exists ix_proposal_messages_p on proposal_messages(proposal_id, ts);

-- ---------------------------------------------------------------------------
-- Builder solutions: for proposals that are CODE. The admin approves English
-- twice — once the proposal, once the solution plan — before anything is pushed.
-- One row per revision, so the whole negotiation is auditable.
-- ---------------------------------------------------------------------------
create table if not exists proposal_solutions (
  id            bigint generated always as identity primary key,
  proposal_id   bigint not null references proposals(id) on delete cascade,
  revision      integer not null default 1,
  plan          text not null,          -- the plain-English solution, what the admin reads
  files_touched jsonb not null default '[]'::jsonb,
  risks         text,
  test_plan     text,
  -- draft        -> awaiting admin read
  -- revising     -> admin asked for changes; Builder is redrafting
  -- push_ok      -> admin said "push it"
  -- pushed       -> branch + PR exist
  -- merged       -> PR merged
  -- failed       -> Builder or CI could not deliver it
  status        text not null default 'draft'
                check (status in ('draft','revising','push_ok','pushed','merged','failed')),
  feedback      text,                   -- the admin's requested changes for this revision
  branch        text,
  pr_url        text,
  ci_state      text,
  model_id      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (proposal_id, revision)
);
create index if not exists ix_proposal_solutions_p on proposal_solutions(proposal_id, revision desc);

-- ---------------------------------------------------------------------------
-- RLS. Every table here is admin-only — there is no anonymous or ordinary-user
-- read path. The engine's batch jobs connect directly as the table owner and
-- are unaffected (RLS is not enforced for the owner); the Edge Function uses
-- the service-role key, which bypasses RLS by design. So these policies govern
-- exactly one caller: a browser holding a signed-in user's JWT.
-- ---------------------------------------------------------------------------
alter table admins enable row level security;
alter table proposals enable row level security;
alter table proposal_events enable row level security;
alter table proposal_messages enable row level security;
alter table proposal_solutions enable row level security;

-- An admin may see the admin list (to render "you're signed in as"), never edit it.
create policy "admins: read" on admins
  for select to authenticated using (is_admin());

-- Proposals: admins read everything and may only ever change the decision —
-- column-level control isn't available in a policy, so the write path that
-- must not be forgeable (actioning, evidence counts) lives server-side in the
-- Edge Function under the service role. This UPDATE policy exists so an admin
-- can park/annotate directly if the function is ever down.
create policy "proposals: admin read" on proposals
  for select to authenticated using (is_admin());
create policy "proposals: admin update" on proposals
  for update to authenticated using (is_admin()) with check (is_admin());

-- Audit log: readable, insertable, and deliberately NOT updatable or deletable.
create policy "events: admin read" on proposal_events
  for select to authenticated using (is_admin());
create policy "events: admin insert" on proposal_events
  for insert to authenticated with check (is_admin());

-- Chat: an admin may read the thread and post their own questions. Assistant
-- rows are written server-side, so the role check stops a client from forging
-- a model answer into the record.
create policy "messages: admin read" on proposal_messages
  for select to authenticated using (is_admin());
create policy "messages: admin insert" on proposal_messages
  for insert to authenticated with check (is_admin() and role = 'admin');

-- Solutions: an admin reads the Builder's plan and may set feedback / push_ok.
create policy "solutions: admin read" on proposal_solutions
  for select to authenticated using (is_admin());
create policy "solutions: admin update" on proposal_solutions
  for update to authenticated using (is_admin()) with check (is_admin());
