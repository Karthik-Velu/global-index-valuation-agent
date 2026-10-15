-- Manual RLS / privilege check for engine/migrations/0015_screener.sql.
--
-- Not run in CI (it needs a Postgres with Supabase's auth schema and API
-- roles). Run it against a LOCAL Supabase stack or a Supabase BRANCH database,
-- never prod — although everything below happens inside one transaction that
-- is rolled back, so it leaves no trace either way:
--
--   psql "$LOCAL_OR_BRANCH_DB_URL" -v ON_ERROR_STOP=1 -f tests/rls_0015.sql
--
-- Connect as `postgres` (needs to insert fixture rows into auth.users and to
-- SET ROLE anon / authenticated, exactly as PostgREST does per request). Every
-- check prints "ok   <label>" as a NOTICE; the first failure raises
-- "FAIL <label> ..." and stops the script. The last line on success is
-- "ALL 0015 RLS CHECKS PASSED".
--
-- Fixture identities are fictitious (example.test addresses, fixed uuids,
-- tickers FXA/FXB/...): nothing here is derived from real users or holdings.

\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null

begin;

-- ---------------------------------------------------------------------------
-- helpers (session-temporary; gone with the transaction)
-- ---------------------------------------------------------------------------

-- Switch identity the way PostgREST does: role + request.jwt.claims, both
-- transaction-local. become('postgres', null) returns to the table owner.
create function pg_temp.become(r text, claims jsonb) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', coalesce(claims::text, ''), true);
  perform set_config('role', r, true);
end $$;

create function pg_temp.expect(cond boolean, label text) returns void
language plpgsql as $$
begin
  if cond is distinct from true then
    raise exception 'FAIL %', label;
  end if;
  raise notice 'ok   %', label;
end $$;

-- Run `stmt`; it must fail with SQLSTATE `want` (42501 = insufficient
-- privilege / RLS with-check violation, 23514 = check_violation).
create function pg_temp.expect_error(stmt text, want text, label text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = want then
      raise notice 'ok   % (%)', label, sqlstate;
      return;
    end if;
    raise exception 'FAIL % — expected SQLSTATE %, got %: %', label, want, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL % — expected SQLSTATE %, but the statement succeeded', label, want;
end $$;

-- Run a DML statement; it must succeed and touch exactly `want` rows.
create function pg_temp.expect_rows(stmt text, want int, label text) returns void
language plpgsql as $$
declare n int;
begin
  execute stmt;
  get diagnostics n = row_count;
  if n <> want then
    raise exception 'FAIL % — expected % row(s), got %', label, want, n;
  end if;
  raise notice 'ok   % (% row(s))', label, n;
end $$;

-- ---------------------------------------------------------------------------
-- fixtures (as the table owner)
--   T trusted     allowlisted with can_view_prices, confirmed
--   U untrusted   confirmed, not allowlisted
--   N unconfirmed allowlisted with can_view_prices, email NOT confirmed
--   P no-prices   allowlisted, can_view_prices = false
--   A admin       in admins (stored lowercase; auth.users copy is mixed case)
-- ---------------------------------------------------------------------------
insert into auth.users (id, email, email_confirmed_at) values
  ('11111111-1111-4111-8111-111111111111', 'trusted@example.test',     now()),
  ('22222222-2222-4222-8222-222222222222', 'untrusted@example.test',   now()),
  ('33333333-3333-4333-8333-333333333333', 'unconfirmed@example.test', null),
  ('44444444-4444-4444-8444-444444444444', 'noprices@example.test',    now()),
  ('55555555-5555-4555-8555-555555555555', 'Admin@Example.TEST',       now());

insert into public.app_allowlist (email, can_view_prices, note) values
  ('trusted@example.test',     true,  'rls test'),
  ('unconfirmed@example.test', true,  'rls test'),
  ('noprices@example.test',    false, 'rls test');
insert into public.admins (email, note) values ('admin@example.test', 'rls test');

insert into public.chart_series (key, kind, asof, closes)
  values ('stock:FXA', 'stock', date '2026-10-13', '{10.5,10.7}');
insert into public.screener_snapshots (scope, asof, payload)
  values ('stocks', date '2026-10-13', '{"fields":["ticker"],"rows":[["FXA"]]}');

insert into public.watchlists (id, user_id, name) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'T list'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', 'U list');

insert into public.saved_screens (id, user_id, name, scope, filter) values
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', '11111111-1111-4111-8111-111111111111',
   'T stocks', 'stocks', '{"v":1,"scope":"stocks","where":[]}'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', '22222222-2222-4222-8222-222222222222',
   'U markets', 'markets', '{"v":1,"scope":"markets","where":[]}');

insert into public.screen_alerts (user_id, screen_id, asof, added, n_added) values
  ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
   date '2026-10-13', '{FXB}', 1);

-- ---------------------------------------------------------------------------
-- 1. anon: no table, no RPC
-- ---------------------------------------------------------------------------
select pg_temp.become('anon', null);
select pg_temp.expect_error('select public.is_trusted()',    '42501', 'anon cannot call is_trusted()');
select pg_temp.expect_error('select public.is_admin()',      '42501', 'anon cannot call is_admin()');
select pg_temp.expect_error('select public.ai_quota_take()', '42501', 'anon cannot call ai_quota_take()');
select pg_temp.expect_error('select 1 from public.saved_screens',      '42501', 'anon cannot read saved_screens');
select pg_temp.expect_error('select 1 from public.watchlist_items',    '42501', 'anon cannot read watchlist_items');
select pg_temp.expect_error('select 1 from public.screen_alerts',      '42501', 'anon cannot read screen_alerts');
select pg_temp.expect_error('select 1 from public.screener_snapshots', '42501', 'anon cannot read screener_snapshots');
select pg_temp.expect_error('select 1 from public.chart_series',       '42501', 'anon cannot read chart_series');
select pg_temp.expect_error(
  $q$insert into public.app_allowlist(email, can_view_prices) values ('x@example.test', true)$q$,
  '42501', 'anon cannot write app_allowlist');

-- ---------------------------------------------------------------------------
-- 2. trust gate: who is trusted
-- ---------------------------------------------------------------------------
select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select pg_temp.expect(public.is_trusted(), 'allowlisted + can_view_prices + confirmed is trusted');
select pg_temp.expect(not public.is_admin(), 'allowlisted user is not an admin');

select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","is_anonymous":true}');
select pg_temp.expect(not public.is_trusted(), 'anonymous session is never trusted');

select pg_temp.become('authenticated', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated","email":"trusted@example.test"}');
select pg_temp.expect(not public.is_trusted(), 'JWT email claim cannot impersonate an allowlisted address');

select pg_temp.become('authenticated', '{"sub":"33333333-3333-4333-8333-333333333333","role":"authenticated"}');
select pg_temp.expect(not public.is_trusted(), 'unconfirmed email is not trusted');

select pg_temp.become('authenticated', '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated"}');
select pg_temp.expect(not public.is_trusted(), 'allowlisted without can_view_prices is not trusted');

select pg_temp.become('authenticated', '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}');
select pg_temp.expect(public.is_admin(), 'admin (case-insensitive exact match) is admin');
select pg_temp.expect(public.is_trusted(), 'admin is trusted');
select pg_temp.expect((select count(*) from public.admins) >= 1, 'admin still reads admins via 0013 policy');

select pg_temp.become('authenticated', '{"role":"authenticated"}');
select pg_temp.expect(not public.is_trusted(), 'no sub claim: not trusted');

-- ---------------------------------------------------------------------------
-- 3. untrusted user U: gated data invisible, stocks screens refused,
--    alerts read-only except `seen`, no writes into other users' lists
-- ---------------------------------------------------------------------------
select pg_temp.become('authenticated', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select pg_temp.expect(not public.is_trusted(), 'confirmed but unlisted user is not trusted');
select pg_temp.expect((select count(*) from public.chart_series) = 0, 'untrusted sees no chart_series rows');
select pg_temp.expect((select count(*) from public.screener_snapshots) = 0, 'untrusted sees no screener_snapshots rows');
select pg_temp.expect((select count(*) from public.saved_screens) = 1, 'untrusted sees only own saved screen');
select pg_temp.expect((select count(*) from public.watchlists) = 1, 'untrusted sees only own watchlist');

select pg_temp.expect_error(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('22222222-2222-4222-8222-222222222222', 'oracle', 'stocks', '{"v":1}')$q$,
  '42501', 'untrusted cannot insert a stocks-scope screen');
select pg_temp.expect_rows(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('22222222-2222-4222-8222-222222222222', 'cheap markets', 'markets', '{"v":1}')$q$,
  1, 'untrusted can insert a markets-scope screen');
select pg_temp.expect_error(
  $q$update public.saved_screens set scope = 'stocks'
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'$q$,
  '42501', 'untrusted cannot flip a screen to stocks scope');
select pg_temp.expect_error(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('11111111-1111-4111-8111-111111111111', 'planted', 'markets', '{"v":1}')$q$,
  '42501', 'cannot insert a screen for another user');
select pg_temp.expect_error(
  $q$update public.saved_screens set user_id = '11111111-1111-4111-8111-111111111111'
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'$q$,
  '42501', 'cannot give a screen away to another user');
select pg_temp.expect_rows(
  $q$update public.saved_screens set name = 'hijack' where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'$q$,
  0, 'update of another user''s screen touches nothing');
select pg_temp.expect_error(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('22222222-2222-4222-8222-222222222222', 'big', 'markets',
             jsonb_build_object('pad', repeat(md5('x'), 400)))$q$,
  '23514', 'filter larger than 8 KB is refused');

select pg_temp.expect_error(
  $q$update public.screen_alerts set added = '{FXZ}'$q$,
  '42501', 'user cannot rewrite screen_alerts.added');
select pg_temp.expect_error(
  $q$update public.screen_alerts set asof = date '2026-01-01'$q$,
  '42501', 'user cannot rewrite screen_alerts.asof');
select pg_temp.expect_error(
  $q$insert into public.screen_alerts (user_id, screen_id, asof, added)
     values ('22222222-2222-4222-8222-222222222222', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
             date '2026-10-14', '{FXC}')$q$,
  '42501', 'user cannot insert screen_alerts');
select pg_temp.expect_rows(
  $q$update public.screen_alerts set seen = true$q$,
  1, 'user can mark own alert seen');

select pg_temp.expect_error(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '22222222-2222-4222-8222-222222222222', 'stock', 'FXA')$q$,
  '42501', 'cannot add an item to another user''s list (own user_id)');
select pg_temp.expect_error(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', '11111111-1111-4111-8111-111111111111', 'stock', 'FXA')$q$,
  '42501', 'cannot add an item to another user''s list (their user_id)');
select pg_temp.expect_rows(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', 'stock', 'FXA')$q$,
  1, 'can add an item to own list');
select pg_temp.expect_error(
  $q$update public.watchlist_items set watchlist_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
     where item_key = 'FXA'$q$,
  '42501', 'cannot move an item into another user''s list');
select pg_temp.expect_error(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key, note)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222',
             'stock', 'FXB', repeat('n', 281))$q$,
  '23514', 'item note over 280 chars is refused');

select pg_temp.expect_error('select 1 from public.app_allowlist', '42501', 'user cannot read app_allowlist');
select pg_temp.expect_error('select 1 from public.ai_usage',      '42501', 'user cannot read ai_usage');
select pg_temp.expect_error('update public.ai_config set per_user_daily = 100000', '42501', 'user cannot raise the AI quota');
select pg_temp.expect_error(
  $q$insert into public.chart_series (key, kind) values ('stock:FXZ', 'stock')$q$,
  '42501', 'user cannot write chart_series');
select pg_temp.expect_error(
  $q$update public.screener_snapshots set asof = date '2026-01-01'$q$,
  '42501', 'user cannot write screener_snapshots');

-- ---------------------------------------------------------------------------
-- 4. trusted user T: gated data visible, stocks screens allowed, a changed
--    filter resets the alert baseline
-- ---------------------------------------------------------------------------
select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select pg_temp.expect((select count(*) from public.chart_series) = 1, 'trusted sees chart_series');
select pg_temp.expect((select count(*) from public.screener_snapshots) = 1, 'trusted sees screener_snapshots');
select pg_temp.expect((select count(*) from public.screen_alerts) = 0, 'trusted does not see another user''s alerts');
select pg_temp.expect_rows(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('11111111-1111-4111-8111-111111111111', 'cheap stocks', 'stocks', '{"v":1}')$q$,
  1, 'trusted can insert a stocks-scope screen');

select pg_temp.become('postgres', null);
update public.saved_screens
   set last_matches = '["FXA","FXB"]', last_evaluated_asof = date '2026-10-13', universe_n = 3000
 where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select pg_temp.expect_rows(
  $q$update public.saved_screens set name = 'renamed', alerts_enabled = true
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'$q$, 1, 'rename own screen');
select pg_temp.expect(
  (select last_matches is not null and last_evaluated_asof is not null
     from public.saved_screens where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'),
  'rename keeps the alert baseline');
select pg_temp.expect_rows(
  $q$update public.saved_screens set filter = '{"v":1,"where":[{"field":"pe","op":"<","value":15}]}'
     where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'$q$, 1, 'edit own screen filter');
select pg_temp.expect(
  (select last_matches is null and last_evaluated_asof is null and universe_n is null
     from public.saved_screens where id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'),
  'changed filter resets the alert baseline');

-- ---------------------------------------------------------------------------
-- 5. per-user caps (statement is atomic: an over-cap batch inserts nothing)
-- ---------------------------------------------------------------------------
select pg_temp.become('authenticated', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select pg_temp.expect_error(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     select '22222222-2222-4222-8222-222222222222', 's' || g, 'markets', '{"v":1}'
     from generate_series(1, 60) g$q$,
  '23514', 'saved screen cap: 60 at once refused');
select pg_temp.expect_rows(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     select '22222222-2222-4222-8222-222222222222', 's' || g, 'markets', '{"v":1}'
     from generate_series(1, 50 - (select count(*) from public.saved_screens)::int) g$q$,
  48, 'saved screen cap: fill up to 50');
select pg_temp.expect_error(
  $q$insert into public.saved_screens (user_id, name, scope, filter)
     values ('22222222-2222-4222-8222-222222222222', 'one too many', 'markets', '{"v":1}')$q$,
  '23514', 'saved screen cap: 51st refused');

select pg_temp.expect_rows(
  $q$insert into public.watchlists (user_id, name)
     select '22222222-2222-4222-8222-222222222222', 'w' || g from generate_series(1, 19) g$q$,
  19, 'watchlist cap: fill up to 20');
select pg_temp.expect_error(
  $q$insert into public.watchlists (user_id, name) values ('22222222-2222-4222-8222-222222222222', 'w21')$q$,
  '23514', 'watchlist cap: 21st refused');

select pg_temp.expect_rows(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key)
     select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', 'market', 'FX' || g
     from generate_series(1, 499) g$q$,
  499, 'watchlist item cap: fill up to 500');
select pg_temp.expect_error(
  $q$insert into public.watchlist_items (watchlist_id, user_id, kind, item_key)
     values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', '22222222-2222-4222-8222-222222222222', 'market', 'FXOVER')$q$,
  '23514', 'watchlist item cap: 501st refused');

-- ---------------------------------------------------------------------------
-- 6. AI quota: per-user and global caps, counted server-side
-- ---------------------------------------------------------------------------
select pg_temp.become('postgres', null);
update public.ai_config set per_user_daily = 2, global_daily = 3;
delete from public.ai_usage;

select pg_temp.become('authenticated', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}');
select pg_temp.expect(not public.ai_quota_take(), 'quota: untrusted U refused (cannot drain the shared budget)');
select pg_temp.expect(not public.ai_quota_take(), 'quota: untrusted U refused again');

select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}');
select pg_temp.expect(public.ai_quota_take(), 'quota: T call 1 granted');
select pg_temp.expect(public.ai_quota_take(), 'quota: T call 2 granted');
select pg_temp.expect(not public.ai_quota_take(), 'quota: T call 3 refused (per-user cap)');

select pg_temp.become('authenticated', '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated"}');
select pg_temp.expect(public.ai_quota_take(), 'quota: A call 1 granted (global now 3)');
select pg_temp.expect(not public.ai_quota_take(), 'quota: A call 2 refused (global cap)');

select pg_temp.become('authenticated', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated","is_anonymous":true}');
select pg_temp.expect(not public.ai_quota_take(), 'quota: anonymous session refused');
select pg_temp.become('authenticated', '{"role":"authenticated"}');
select pg_temp.expect(not public.ai_quota_take(), 'quota: no sub claim refused');

select pg_temp.become('postgres', null);
select pg_temp.expect(
  not exists (select 1 from public.ai_usage where user_id = '22222222-2222-4222-8222-222222222222'),
  'quota: untrusted calls never touch a counter');
select pg_temp.expect(
  (select n from public.ai_usage where user_id = '11111111-1111-4111-8111-111111111111') = 2,
  'quota: refused calls are not counted (T stays at 2)');
select pg_temp.expect(
  (select n from public.ai_usage where user_id = '55555555-5555-4555-8555-555555555555') = 1,
  'quota: a global refusal hands the caller''s unit back (A stays at 1)');
select pg_temp.expect(
  (select n from public.ai_usage where user_id = '00000000-0000-0000-0000-000000000000') = 3,
  'quota: global counter = granted calls only');

\o
\echo ALL 0015 RLS CHECKS PASSED (rolling back)
rollback;
