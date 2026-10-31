-- Two findings from Supabase's security advisor (2026-10-31).
--
-- 1. model_scorecard was readable by anyone holding the public anon key, at
--    /rest/v1/model_scorecard. A plain view runs with its owner's rights, so it
--    skipped the RLS on model_invocations underneath it. Nothing in it is secret
--    (per-model success rates and latencies), but it was never meant to be public,
--    and only the engine reads it, over DATABASE_URL as the table owner. Run it as
--    the caller and take it off the public API. If 0006's `create or replace view`
--    is ever re-run, it keeps these settings; a drop-and-create would not.
alter view public.model_scorecard set (security_invoker = true);
revoke all on public.model_scorecard from anon, authenticated;

-- 2. rls_auto_enable() is the function behind the `ensure_rls` event trigger
--    (Supabase created it, not a migration here). It was executable by anon and
--    authenticated over /rest/v1/rpc. Postgres refuses to run an event-trigger
--    function outside a trigger, so this is tidying, not a live hole. postgres
--    (the engine and the dashboard SQL editor) keeps EXECUTE, and a rolled-back
--    dry run on the live database confirmed a table created afterwards still gets
--    RLS switched on. Guarded so a database without the function still applies.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end
$$;
