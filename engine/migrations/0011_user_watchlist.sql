-- Per-user watchlist: the login-gated "pin a market" mechanism (auth.uid()-
-- scoped), fixing the localStorage-only pin for signed-in users
-- (docs/ARCHITECTURE.md P3: "fixing the localStorage dead-end"). A NEW table,
-- not a retrofit of `feedback` (0001_core.sql, has an unused user_id text
-- column) — feedback is an anonymous insert-only signal log feeding
-- feedback_weights() re-tuning; this is a real per-user membership set
-- (upsert/delete), a different access pattern. First table in this schema
-- with real RLS policies + an auth.uid() reference. See ADR-025.

create table if not exists user_watchlist (
  user_id     uuid not null references auth.users(id) on delete cascade,
  market_key  text not null,
  note        text,
  created_at  timestamptz not null default now(),
  primary key (user_id, market_key)
);
create index if not exists ix_user_watchlist_user on user_watchlist(user_id, created_at desc);

alter table user_watchlist enable row level security;

-- Signed-in users see/change only their own rows. No policy for anon at all —
-- RLS defaults to deny (matching every other table in this schema, which is
-- rls_enabled with zero policies today). No UPDATE policy in v1 — insert
-- (pin) + delete (unpin) only; add one later only if a "note" edit ships.
create policy "watchlist: owner select" on user_watchlist
  for select to authenticated using (auth.uid() = user_id);
create policy "watchlist: owner insert" on user_watchlist
  for insert to authenticated with check (auth.uid() = user_id);
create policy "watchlist: owner delete" on user_watchlist
  for delete to authenticated using (auth.uid() = user_id);
