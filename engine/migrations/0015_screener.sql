-- Screener, watchlists, alerts on saved screens, price charts, AI screen
-- builder quota (ADR-037).
--
-- What lands here, and who may touch it:
--   app_allowlist       who besides the admins may see price-derived stock data
--   saved_screens       a user's screens (filter = the shared screen DSL, v1)
--   watchlists (+items) a user's lists of stocks / markets
--   screen_alerts       written ONLY by the daily/weekly alert job; the user may
--                       read, delete and flip `seen` — nothing else
--   screener_snapshots  the projected stock universe the screener runs over
--   chart_series        close-only display cache for trusted charts (ADR-037:
--                       a narrow, bounded exception to ADR-016 Choice 1)
--   ai_usage/ai_config  server-side daily caps for the AI screen builder
--
-- LICENSING is the reason for most of the shape below. Stock rows carry
-- Massive-derived ratios and chart_series carries raw Massive closes, which the
-- individual plan does not let us redistribute — so both are readable only by
-- is_trusted() callers (admins, or allowlisted addresses with can_view_prices),
-- and a stocks-scope screen can only be SAVED by a trusted caller, because the
-- alert job (running as the table owner, RLS bypassed) would otherwise turn an
-- untrusted user's saved screen into a daily oracle over the gated universe.
--
-- PRIVILEGES. Supabase's default privileges GRANT ALL on every new public
-- table to anon and authenticated. RLS stops most of that, but a column grant
-- such as `grant update (seen)` only ADDS to the table-level UPDATE that
-- already exists. So every table here starts with `revoke all ... from anon,
-- authenticated` and then grants back exactly what the UI needs.
--
-- RE-RUNNABLE. The runner (engine/db.py::apply_migrations) executes this file
-- as one statement batch in one transaction, and re-runs it whenever it was
-- applied out-of-band (0013's lesson). Every statement is idempotent: `if not
-- exists`, `create or replace`, `drop ... if exists` before every policy and
-- trigger. FROZEN once applied anywhere (dev-branch pipeline runs hit prod):
-- fixes go to 0016_*.sql, never into this file.

-- ---------------------------------------------------------------------------
-- Allowlist. Admins are trusted already (0013's `admins`); this table exists
-- for the owner's OTHER addresses. Lowercase-only so the exact-match rule in
-- is_trusted() and the admin Edge Function never depends on casing.
-- ---------------------------------------------------------------------------
create table if not exists public.app_allowlist (
  email            text primary key check (email = lower(btrim(email)) and email <> ''),
  can_view_prices  boolean not null default false,
  note             text,
  added_at         timestamptz not null default now()
);
comment on table public.app_allowlist is
  'Entries must be the owner''s own addresses. Granting can_view_prices to a '
  'third party requires a Massive business plan and a non-Yahoo market price '
  'source (ADR-037).';

alter table public.app_allowlist enable row level security;
revoke all on public.app_allowlist from anon, authenticated;
-- No policies: nobody reads or writes this from a browser. Edited by the owner
-- in the SQL editor; read only inside the SECURITY DEFINER functions below.

-- ---------------------------------------------------------------------------
-- Identity. Both functions read the CONFIRMED address from auth.users rather
-- than trusting the JWT's email claim: the claim is a snapshot (up to an hour
-- stale after an email change) and says nothing about whether the address was
-- ever proven. Anonymous sessions carry role `authenticated` but are never
-- trusted. search_path = '' and fully-qualified names, so a caller cannot
-- shadow `admins` / `app_allowlist` with objects of their own.
-- auth.uid() is null outside a PostgREST request, so the engine's own direct
-- connection sees false here — correct: jobs connect as the table owner and
-- bypass RLS; they never impersonate a user.
-- ---------------------------------------------------------------------------
create or replace function public.is_trusted() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
      and (lower(u.email) in (select lower(a.email) from public.admins a)
           or lower(u.email) in (select lower(l.email) from public.app_allowlist l
                                 where l.can_view_prices))
  );
$$;

-- Same signature and meaning as 0013 (the caller's address is in `admins`),
-- hardened the same way. 0013's policies call it unqualified; they pick up
-- this body on replace.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
      and lower(u.email) in (select lower(a.email) from public.admins a)
  );
$$;

-- Supabase also grants EXECUTE on new public functions to anon explicitly, so
-- revoking from PUBLIC alone is not enough.
revoke execute on function public.is_trusted() from public, anon;
grant execute on function public.is_trusted() to authenticated;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- ---------------------------------------------------------------------------
-- Saved screens.
-- last_matches / last_evaluated_asof / universe_n belong to the alert job: the
-- membership baseline it diffs against, the snapshot date it last evaluated,
-- and the universe size then (it refuses to diff against a much smaller one).
-- ---------------------------------------------------------------------------
create table if not exists public.saved_screens (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references auth.users(id) on delete cascade,
  name                 text not null check (length(btrim(name)) between 1 and 80),
  scope                text not null check (scope in ('stocks','markets')),
  filter               jsonb not null check (jsonb_typeof(filter) = 'object'
                                             and pg_column_size(filter) < 8192),
  alerts_enabled       boolean not null default false,
  last_matches         jsonb check (last_matches is null or pg_column_size(last_matches) < 65536),
  last_evaluated_asof  date,
  universe_n           int,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists ix_saved_screens_user on public.saved_screens(user_id, created_at desc);
-- The alert job only ever scans alerting screens.
create index if not exists ix_saved_screens_alerting on public.saved_screens(scope) where alerts_enabled;

-- A changed filter (or scope) is a different screen as far as alerts go: diffing
-- the new filter's matches against the old filter's would fire a burst of
-- spurious added/removed alerts. Reset to "no baseline" — the next run stores
-- one silently. updated_at tracks user edits only, not the job's bookkeeping.
create or replace function public.saved_screens_before_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.filter is distinct from old.filter or new.scope is distinct from old.scope then
    new.last_matches := null;
    new.last_evaluated_asof := null;
    new.universe_n := null;
  end if;
  if (new.name, new.scope, new.filter, new.alerts_enabled)
     is distinct from (old.name, old.scope, old.filter, old.alerts_enabled) then
    new.updated_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists saved_screens_before_update on public.saved_screens;
create trigger saved_screens_before_update before update on public.saved_screens
  for each row execute function public.saved_screens_before_update();

-- Per-user caps. Signup is open and the database is the 500 MB free tier the
-- daily pipeline also lives in, so every user-writable table is bounded.
-- SECURITY INVOKER on purpose: under RLS the count can only see the caller's own
-- rows, and it counts only new.user_id's rows either way.
create or replace function public.saved_screens_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.saved_screens s where s.user_id = new.user_id) >= 50 then
    raise exception 'saved screen limit reached (50 per user)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists saved_screens_cap on public.saved_screens;
create trigger saved_screens_cap before insert on public.saved_screens
  for each row execute function public.saved_screens_cap();

alter table public.saved_screens enable row level security;
revoke all on public.saved_screens from anon, authenticated;
grant select, insert, update, delete on public.saved_screens to authenticated;

drop policy if exists "saved_screens: owner select" on public.saved_screens;
create policy "saved_screens: owner select" on public.saved_screens
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "saved_screens: owner insert" on public.saved_screens;
create policy "saved_screens: owner insert" on public.saved_screens
  for insert to authenticated
  with check ((select auth.uid()) = user_id
              and (scope <> 'stocks' or (select public.is_trusted())));
drop policy if exists "saved_screens: owner update" on public.saved_screens;
create policy "saved_screens: owner update" on public.saved_screens
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id
              and (scope <> 'stocks' or (select public.is_trusted())));
drop policy if exists "saved_screens: owner delete" on public.saved_screens;
create policy "saved_screens: owner delete" on public.saved_screens
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Watchlists. The built-in "Starred" markets list stays user_watchlist (0011);
-- these are the user's named lists (incl. the auto-created "Starred stocks").
-- ---------------------------------------------------------------------------
create table if not exists public.watchlists (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 60),
  created_at  timestamptz not null default now(),
  unique (user_id, name)
);

create or replace function public.watchlists_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.watchlists w where w.user_id = new.user_id) >= 20 then
    raise exception 'watchlist limit reached (20 per user)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists watchlists_cap on public.watchlists;
create trigger watchlists_cap before insert on public.watchlists
  for each row execute function public.watchlists_cap();

alter table public.watchlists enable row level security;
revoke all on public.watchlists from anon, authenticated;
grant select, insert, update, delete on public.watchlists to authenticated;

drop policy if exists "watchlists: owner select" on public.watchlists;
create policy "watchlists: owner select" on public.watchlists
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "watchlists: owner insert" on public.watchlists;
create policy "watchlists: owner insert" on public.watchlists
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists "watchlists: owner update" on public.watchlists;
create policy "watchlists: owner update" on public.watchlists
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "watchlists: owner delete" on public.watchlists;
create policy "watchlists: owner delete" on public.watchlists
  for delete to authenticated using ((select auth.uid()) = user_id);

-- item_key = a stock ticker or a market key. user_id is denormalised so every
-- policy is a cheap equality, but it is never trusted alone: every policy also
-- requires the PARENT list to belong to the caller — on insert/update too, or a
-- user could file (or move) an item into another user's list by its uuid.
create table if not exists public.watchlist_items (
  watchlist_id  uuid not null references public.watchlists(id) on delete cascade,
  user_id       uuid not null references auth.users(id) on delete cascade,
  kind          text not null check (kind in ('stock','market')),
  item_key      text not null check (length(item_key) between 1 and 32),
  note          text check (note is null or length(note) <= 280),
  added_at      timestamptz not null default now(),
  primary key (watchlist_id, kind, item_key)
);
create index if not exists ix_watchlist_items_user on public.watchlist_items(user_id);

create or replace function public.watchlist_items_cap() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.watchlist_items i
      where i.watchlist_id = new.watchlist_id and i.user_id = new.user_id) >= 500 then
    raise exception 'watchlist item limit reached (500 per list)' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
drop trigger if exists watchlist_items_cap on public.watchlist_items;
create trigger watchlist_items_cap before insert on public.watchlist_items
  for each row execute function public.watchlist_items_cap();

alter table public.watchlist_items enable row level security;
revoke all on public.watchlist_items from anon, authenticated;
grant select, insert, update, delete on public.watchlist_items to authenticated;

drop policy if exists "watchlist_items: owner select" on public.watchlist_items;
create policy "watchlist_items: owner select" on public.watchlist_items
  for select to authenticated
  using ((select auth.uid()) = user_id and exists (
    select 1 from public.watchlists w
    where w.id = watchlist_id and w.user_id = (select auth.uid())));
drop policy if exists "watchlist_items: owner insert" on public.watchlist_items;
create policy "watchlist_items: owner insert" on public.watchlist_items
  for insert to authenticated
  with check ((select auth.uid()) = user_id and exists (
    select 1 from public.watchlists w
    where w.id = watchlist_id and w.user_id = (select auth.uid())));
drop policy if exists "watchlist_items: owner update" on public.watchlist_items;
create policy "watchlist_items: owner update" on public.watchlist_items
  for update to authenticated
  using ((select auth.uid()) = user_id and exists (
    select 1 from public.watchlists w
    where w.id = watchlist_id and w.user_id = (select auth.uid())))
  with check ((select auth.uid()) = user_id and exists (
    select 1 from public.watchlists w
    where w.id = watchlist_id and w.user_id = (select auth.uid())));
drop policy if exists "watchlist_items: owner delete" on public.watchlist_items;
create policy "watchlist_items: owner delete" on public.watchlist_items
  for delete to authenticated
  using ((select auth.uid()) = user_id and exists (
    select 1 from public.watchlists w
    where w.id = watchlist_id and w.user_id = (select auth.uid())));

-- ---------------------------------------------------------------------------
-- Alerts. One row per (screen, snapshot date) whose membership changed.
-- added/removed are capped at 50 tickers each by the job; n_added/n_removed
-- are the true counts. hidden_data_issue = names that left only because their
-- data_ok flipped (reported separately, never as "removed").
-- No insert path for anyone but the job (table owner). The user may read,
-- delete, and flip `seen`: the column grant works ONLY because the table-level
-- UPDATE from Supabase's default privileges is revoked first.
-- ---------------------------------------------------------------------------
create table if not exists public.screen_alerts (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users(id) on delete cascade,
  screen_id          uuid not null references public.saved_screens(id) on delete cascade,
  asof               date not null,
  added              text[] not null default '{}',
  removed            text[] not null default '{}',
  n_added            int not null default 0,
  n_removed          int not null default 0,
  hidden_data_issue  text[] not null default '{}',
  seen               boolean not null default false,
  created_at         timestamptz not null default now(),
  unique (screen_id, asof)
);
create index if not exists ix_screen_alerts_user on public.screen_alerts(user_id, seen, created_at desc);
-- The job prunes alerts older than 120 days.
create index if not exists ix_screen_alerts_created on public.screen_alerts(created_at);

alter table public.screen_alerts enable row level security;
revoke all on public.screen_alerts from anon, authenticated;
grant select, delete on public.screen_alerts to authenticated;
grant update (seen) on public.screen_alerts to authenticated;

drop policy if exists "screen_alerts: owner select" on public.screen_alerts;
create policy "screen_alerts: owner select" on public.screen_alerts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists "screen_alerts: owner update" on public.screen_alerts;
create policy "screen_alerts: owner update" on public.screen_alerts
  for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "screen_alerts: owner delete" on public.screen_alerts;
create policy "screen_alerts: owner delete" on public.screen_alerts
  for delete to authenticated using ((select auth.uid()) = user_id);

-- ---------------------------------------------------------------------------
-- Screener snapshot: the projected stock universe (columnar payload), one row
-- per scope, rewritten by the daily job. Markets need no row — the public
-- dashboard_data.json scoreboard already is that universe.
-- ---------------------------------------------------------------------------
create table if not exists public.screener_snapshots (
  scope       text primary key check (scope in ('stocks')),
  asof        date not null,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table public.screener_snapshots enable row level security;
revoke all on public.screener_snapshots from anon, authenticated;
grant select on public.screener_snapshots to authenticated;

drop policy if exists "screener_snapshots: trusted read" on public.screener_snapshots;
create policy "screener_snapshots: trusted read" on public.screener_snapshots
  for select to authenticated using ((select public.is_trusted()));

-- ---------------------------------------------------------------------------
-- Chart series: a DISPLAY CACHE (ADR-037), the one place daily closes touch
-- Postgres. Close-only (no OHLV), rebuildable from Tier B, never read by any
-- job, backtest or score; size-budgeted by the writer (≤ 25 MB).
-- One shared trading calendar row ('calendar:us', `days` = day offsets from
-- start_date) and one row per stock ('stock:<TICKER>', `closes` aligned to that
-- calendar, null for days without a bar) — per-row day arrays would double it.
-- ---------------------------------------------------------------------------
create table if not exists public.chart_series (
  key           text primary key check (length(key) between 1 and 64),
  kind          text not null,
  asof          date,
  start_date    date,
  days          smallint[],
  closes        real[],
  fundamentals  jsonb,
  updated_at    timestamptz not null default now()
);
comment on column public.chart_series.kind is
  '''stock'' for stock:<TICKER> rows, ''calendar'' for the shared calendar:us row.';
comment on column public.chart_series.fundamentals is
  'Annual revenue / net income from growthhistory.annual_series (EDGAR); '
  'null years stay null.';

alter table public.chart_series enable row level security;
revoke all on public.chart_series from anon, authenticated;
grant select on public.chart_series to authenticated;

drop policy if exists "chart_series: trusted read" on public.chart_series;
create policy "chart_series: trusted read" on public.chart_series
  for select to authenticated using ((select public.is_trusted()));

-- ---------------------------------------------------------------------------
-- AI screen builder quota. The Vercel function calls ai_quota_take() with the
-- caller's own token before any LLM call; untrusted callers always get false
-- and never touch a counter. False (or any error) means it falls
-- back to the deterministic rules parser. Two counters per UTC day: the
-- caller's, and a global one (the nil uuid) so N throwaway accounts cannot buy
-- N x the free-tier budget. Limits live here, server-side — never a parameter
-- a caller can choose. Neither table is visible to any browser.
-- ---------------------------------------------------------------------------
create table if not exists public.ai_config (
  id              boolean primary key default true check (id),   -- one row
  per_user_daily  int not null default 40 check (per_user_daily >= 0),
  global_daily    int not null default 150 check (global_daily >= 0),
  updated_at      timestamptz not null default now()
);
insert into public.ai_config(id) values (true) on conflict (id) do nothing;

-- No FK to auth.users: the global row's nil uuid is not a user. Old days are
-- pruned by ai_quota_take() itself.
create table if not exists public.ai_usage (
  user_id  uuid not null,
  day      date not null,
  n        int not null default 0,
  primary key (user_id, day)
);

alter table public.ai_config enable row level security;
revoke all on public.ai_config from anon, authenticated;
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- Counts only GRANTED calls: the conditional upsert does not increment a
-- counter that is already at its limit, and a global refusal hands the
-- caller's unit back. Row locks from the upserts serialise concurrent calls.
create or replace function public.ai_quota_take() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  uid        uuid := auth.uid();
  today      date := (now() at time zone 'utc')::date;
  nil        constant uuid := '00000000-0000-0000-0000-000000000000';
  per_user   int;
  global_cap int;
  got        int;
begin
  if uid is null or uid = nil
     or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) then
    return false;
  end if;
  -- Only trusted accounts may spend the shared budget. Signup is open, so without
  -- this any signed-in account could call this RPC directly (PostgREST) and drain
  -- the global counter, switching the AI builder off for the owner.
  if not public.is_trusted() then
    return false;
  end if;

  select c.per_user_daily, c.global_daily into per_user, global_cap
    from public.ai_config c limit 1;
  per_user := coalesce(per_user, 40);
  global_cap := coalesce(global_cap, 150);
  if per_user <= 0 or global_cap <= 0 then
    return false;
  end if;

  -- First call of a UTC day: drop counters older than a month (bookkeeping only).
  if not exists (select 1 from public.ai_usage where user_id = nil and day = today) then
    delete from public.ai_usage where day < today - 35;
  end if;

  got := null;
  insert into public.ai_usage as u (user_id, day, n) values (uid, today, 1)
    on conflict (user_id, day) do update set n = u.n + 1 where u.n < per_user
    returning u.n into got;
  if got is null then
    return false;                         -- caller is at their daily limit
  end if;

  got := null;
  insert into public.ai_usage as u (user_id, day, n) values (nil, today, 1)
    on conflict (user_id, day) do update set n = u.n + 1 where u.n < global_cap
    returning u.n into got;
  if got is null then
    update public.ai_usage set n = n - 1 where user_id = uid and day = today;
    return false;                         -- global daily cap reached
  end if;

  return true;
end;
$$;
revoke execute on function public.ai_quota_take() from public, anon;
grant execute on function public.ai_quota_take() to authenticated;
