-- Agents v2 (ADR-044): a needs register, canonical dedup keys, expiry, and the
-- invented source leads marked.
--
-- On 31 Oct 2026 the owner cleared the proposal queue: 161 open, 152 declined,
-- 7 parked, 0 approved. Nearly all of it was noise from the three proposal agents,
-- and the owner's question was the right one: "I am OK to decline all, but the issues might
-- still be real. What is the future plan for genuine issues?" Declining a proposal
-- rejects that SOLUTION, never the underlying NEED. So the need gets its own row and
-- its own status, and a proposal links to it.
--
-- Re-runnable, like every migration here: columns and indexes are IF NOT EXISTS,
-- each constraint is dropped before it is added, and every UPDATE is guarded so a
-- second run changes nothing. No rows are deleted.

-- ---------------------------------------------------------------------------
-- 1. The needs register. data_needs already held the source needs (seeded by
--    engine/dataagent/agent.py::seed_needs); it now also holds sector-KPI and
--    data-quality needs, and says whether each is still open.
--      open                -> agents may propose solutions against it
--      answered_by_roadmap -> a planned piece of work answers it (roadmap_ref)
--      parked              -> deliberately deferred until park_until
--      met                 -> solved
-- ---------------------------------------------------------------------------
alter table data_needs add column if not exists status text not null default 'open';
alter table data_needs add column if not exists roadmap_ref text;
alter table data_needs add column if not exists park_until date;
alter table data_needs add column if not exists status_note text;
alter table data_needs drop constraint if exists data_needs_status_check;
alter table data_needs add constraint data_needs_status_check
  check (status in ('open', 'answered_by_roadmap', 'parked', 'met'));

-- The two pre-existing needs the 31 Oct review settled. New needs are seeded with
-- their status by seed_needs (insert-only, so it never reverts an owner's edit);
-- these rows already exist in production, so their status is set once, here.
update data_needs
   set status = 'answered_by_roadmap',
       roadmap_ref = 'Phase 2 bottom-up valuation from EDGAR constituents (docs/PLAN.md)',
       status_note = 'No proposed source qualified on 31 Oct 2026: all personal-use, paid, '
                     'price-only or vendor-copyrighted.',
       updated_ts = now()
 where id = 'index_valuation' and status = 'open' and roadmap_ref is null;
update data_needs
   set status = 'answered_by_roadmap',
       roadmap_ref = 'ADR-031: regulators jurisdiction by jurisdiction, Europe (ESEF) first',
       status_note = 'Japan (EDINET) is its own parked need, japan_fundamentals.',
       updated_ts = now()
 where id = 'stock_fundamentals' and status = 'open' and roadmap_ref is null;

-- ---------------------------------------------------------------------------
-- 2. Proposals link to a need, carry a canonical key, and count distinct signals.
--    canonical_key is NOT unique: the legacy synonyms ('FRED', 'fred', 'fred_idx')
--    share one, which is the point. engine/proposals.py backfills it in Python,
--    where the alias maps live (engine/canonical.py), before any agent captures.
-- ---------------------------------------------------------------------------
alter table proposals add column if not exists need_id text;
alter table proposals add column if not exists canonical_key text;
alter table proposals add column if not exists signals jsonb not null default '[]'::jsonb;
create index if not exists ix_proposals_canonical on proposals(canonical_key);
create index if not exists ix_proposals_need on proposals(need_id, status);

comment on column proposals.signals is
  'Distinct supporting signals (a sub-sector, a firing check, a need). evidence_count '
  'is their number, not the number of nights an agent re-raised the idea.';

-- 'expired': the proposal's trigger is gone (a retired check, a need now answered,
-- or no agent re-raised it for PROPOSAL_EXPIRY_DAYS). Recorded with an audit event.
-- The 0013 constraint is an inline column check; drop it whatever it was named.
do $$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'proposals'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) like '%status%'
  loop
    execute format('alter table proposals drop constraint %I', c.conname);
  end loop;
end
$$;
alter table proposals add constraint proposals_status_check
  check (status in ('pending', 'approved', 'actioned', 'queued_build',
                    'declined', 'parked', 'failed', 'expired'));

-- ---------------------------------------------------------------------------
-- 3. Mark the invented source leads. Discovery upserted every model-invented id as
--    a data_sources "lead" (214 of 216 rows had no adapter). A row with no adapter,
--    no live verification and no entry in the researched seed catalogue
--    (engine/sources/seed_catalog.json, listed below and checked against the file by
--    tests/test_proposals.py) is invented. Marked, not deleted, so the record of what
--    the model said survives; registry.list_sources() skips them.
-- ---------------------------------------------------------------------------
update data_sources
   set status = 'invented', updated_ts = now()
 where coalesce(has_adapter, false) = false
   and coalesce(verified_live, false) = false
   and coalesce(status, '') <> 'invented'
   and id <> all (array[
    'edinet_api_v2_japan_fsa', 'filings_xbrl_org_esef_uksef_filing_index',
    'uk_companies_house_free_accounts_data_pr', 'eodhd_fundamentals_data_feed',
    'simfin_api_bulk_datasets', 'financial_modeling_prep_fmp', 'finnhub',
    'financialreports_eu_api', 'tiingo_fundamentals_add_on',
    'yfinance_yahoo_finance_unofficial', 'india_nse_bse_corporate_filings_xbrl',
    'stooq_free_historical_bulk_market_data',
    'yahoo_finance_chart_api_v8_global_index_',
    'ishares_blackrock_etf_holdings_csv_index',
    'twelve_data_api_global_indices_equities',
    'marketstack_api_apilayer_72_global_excha',
    'alpha_vantage_api_global_equities_fx_lim',
    'eodhd_eod_historical_data_api_60_exchang',
    'dbnomics_open_economic_financial_time_se',
    'tiingo_api_eod_prices_us_china_weak_non_', 'gdelt_2_0_doc_api',
    'gdelt_gkg_events_bulk_files_bigquery', 'sec_edgar_data_sec_gov_apis_submissions_',
    'sec_edgar_full_text_search_efts_api', 'edinet_api_v2', 'marketaux_news_api',
    'finnhub_news_api_company_news_market_new', 'gnews_api', 'currents_api',
    'lse_regulatory_news_service_rns_public_a',
    'sedar_canadian_securities_administrators', 'frankfurter_currency_data_api',
    'ecb_data_portal_sdmx_2_1_rest_api', 'world_bank_indicators_api_v2',
    'world_bank_data360_api_beta', 'imf_data_api_sdmx_2_1_3_0', 'dbnomics_web_api',
    'exchangerate_api_open_access', 'afx_kwayisi_gse_api_african_exchanges',
    'financial_modeling_prep_fmp_calendars_co']);
