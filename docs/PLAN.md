# Plan — done vs pending

The single at-a-glance progress checklist. For the *snapshot* see [STATUS.md](STATUS.md),
for the *why* see [DECISIONS.md](DECISIONS.md), for detailed sequencing see [ROADMAP.md](ROADMAP.md).

**Convention:** check items off as they land; add new items under the right section. Keep
this the source of truth for "where are we."

Legend: ✅ done · 🔜 next · ⬜ pending · 🔁 ongoing

---

## Phase 1 — Data foundation & platform  ✅ COMPLETE
- ✅ Index-level product live (Vercel), ~90 indices ranked by value + fundamental growth + GARP
- ✅ Cloud **Postgres** (Supabase) as single source of truth; migrations `0001..0008`
- ✅ Registry, valuation ledger, tuner moved off SQLite → Postgres
- ✅ **SEC EDGAR** stock ingestion — point-in-time, restatement vintages, 110-KPI catalog
- ✅ Canonical XBRL concept mapping (`catalog._CANONICAL`) — core line items pinned
- ✅ **501 large-caps ingested** — 1.45M metric rows, 31k filings, **quality 99/100**
- ✅ Sequenced data pipeline (probe → ingest → tag → validate → quality → recalibration)
- ✅ **Waterfall LLM router** (Ollama Cloud + Groq, in CI) + model-specific scorecard
- ✅ **3-tier semantic memory** (episodic → `lessons` + pgvector → curated `context/*.md`)
- ✅ Cloud/mobile handoff: `CLAUDE.md`, `STATUS.md`, `DECISIONS.md`, `JOURNAL.md`, `PLAN.md`

## Phase 2 — Bottom-up valuation & the backtest  🔜 CRITICAL PATH
- ✅ **Tier B storage built** — `engine/tierb.py` (DuckDB/Parquet layer: PK-dedupe view,
  `append_metrics`, `delete_metric_code`, point-in-time `metrics_asof`) +
  `engine/tierbsync.py` (export/verify/compact/bundle/pull); ingestion dual-writes,
  quality/validate/recalibration read DuckDB once the store exists; CI caches the store
  (ADR-013). `filings` stays in Postgres; only `fundamental_metrics` moves.
- ✅ **Tier B CUTOVER + scale-up (ADR-015)** — executed 2026-07-07: verify gates →
  archive → truncate; Tier-B-only ingestion self-detected; universe regenerated to
  **2,983 companies / 26+ markets** (US 2,500 + foreign 483); index universe 132
  ETF proxies; monthly full sweep + universe refresh; daily health check trigger.
- ✅ **Post-cutover durability** — store bundle published as a GitHub release asset
  (`tierb-store`), refreshed on the monthly sweep; ingestion aborts loudly if the
  store is missing post-cutover (the 2026-07-07 refill incident can't recur).
  R2 remains the eventual home.
- ✅ **Prices (ADR-017: Massive, supersedes Stooq) — REAL DATA LANDED 2026-07-20.**
  `price-validate.yml` passed against the live service (30/30 coverage, ETFs
  confirmed, ~22mo entitled); `price-backfill.yml` completed: **1,420,695 real
  OHLCV rows** in Tier B, floor correctly hit at the free tier's ~2y window,
  zero errors. Found + fixed a real bug on the first attempt (`walk_from =
  date.today()` false-floored on today's own unpublished session — see
  JOURNAL 2026-07-20); untestable synthetically since the mock always modeled
  today as having data. Licensing note: derived-data clause needs a human read
  before stock-level derived metrics go public (ADR-017).
- ✅ **First real backtest — COMPLETE 2026-07-22** (`backtest_runs` id=1, window
  2024-10-20..2025-07-17, 9 monthly rebalances). `opportunity_score` is the
  standout: mean rank-IC 0.009/0.026/0.042/0.031 at 1m/3m/6m/12m, hit-rate up
  to 100% at 6m/12m, positive every period at 3m/6m — but `n_periods=9` is
  below the significance gate's floor of 12, so nothing is formally
  `significant` yet despite t-stats up to 5.84. `value_score` trends the same
  direction, weaker. `growth_score`/`momentum_score` show no signal yet
  (growth_score has an odd 0%-hit-rate-despite-positive-IC split at 6m/12m,
  unexplained, flagged for later). Full numbers in JOURNAL 2026-07-22.
  CI note: `backtest.yml` needed the repo made public to actually run — two
  attempts failed at 0 billable runner-ms (private-repo Actions minutes cap).
- ✅ **Stock-level valuation** — `engine/stockvaluation.py`: point-in-time pe/pb/ps/
  pcf/growth/momentum per security, REUSES `engine.metrics.compute()` (one scoring
  formula, index + stock share it), peer-grouped by sector. Verified: point-in-time
  correctness, negative-earnings guard, cross-sectional ranking.
- ✅ **Backtest (initial, historical)** — `engine/backtest.py`: monthly walk-forward,
  no look-ahead, fixed-horizon (1/3/6/12m) rank-IC/hit-rate/decile-spread per signal,
  IC-population + significance gates, persists to Postgres `backtest_runs`. Verified
  end-to-end against an ENGINEERED synthetic signal (recovered mean rank-IC
  0.8–0.95), and now against the real market too (above).
- ✅ **Recalibration trigger wired to real data** — `recalibration.py` reads
  `backtest_runs` (now has 2 real rows, 2026-07-22); `datapipeline.py` step 6 calls
  it on every run, so the daily pipeline moves off the `pending_initial` branch
  automatically — no separate activation needed, confirmed by code path.
- ✅ **Corporate actions ingestion (ADR-018)** — `engine/sources/corpactions.py`:
  bulk date-range pull of dividends + splits from Massive's v3 reference endpoints
  (ticker-optional, one paginated query per type covers the whole market), new
  Postgres `dividends`/`splits` tables (migration 0009). `dividend_yield` in
  stockvaluation.py is now REAL trailing-12-month dividends-per-share ÷ price,
  point-in-time — no longer the hardcoded 0.0 placeholder. Wired into the daily
  pipeline (step 2d) + a one-time `corpactions-backfill.yml` for ~2y history.
  Self-healing migrations added as a side effect (datapipeline step 0 —
  no CI step previously applied `engine/migrations/*.sql` automatically).
- ⬜ **Surface bottom-up** in the dashboard (which stocks within a cheap/growing market)
- ⬜ **Backtest follow-ups (documented gaps, not solved yet):** survivorship-bias
  control (universe = current SEC filers only — a delisted-before-ingestion company
  is invisible to the whole backtest), transaction costs, benchmark-relative Sharpe
  (needs an index-level price series over the same window), TTM (trailing-twelve-
  month) multiples instead of latest-FY-only (up to ~12mo stale for calendar-quarter
  reporters), forward (analyst-estimate) growth at stock level,
  continuous/live prediction-ledger grading (vs. today's historical-only harness).

## Parallel tracks (don't block the critical path)  ⬜
- ✅ **Global universe expansion (ADR-014/015)** — universe is committed data:
  US top-2,500 by cross-checked public float + `discover-foreign` (all 20-F/40-F
  filers, assets-ranked, country-classified, ≤1,000/market) + 198 curated overrides;
  IFRS core concepts mapped; incremental daily ingestion + monthly full sweep.
- ⬜ **Constituent baskets (Phase 2)** — where the rankings surface a segment with
  no investable ETF, build a small basket from the underlying stocks (needs prices;
  ETF proxies stay the primary, actionable signal).
- ⬜ **IFRS follow-ups from the validation batch** — (a) NVS + TLK resolve net_income
  but not revenue: map their IFRS revenue-concept variants; (b) multi-currency 20-F
  facts (e.g. IDR + USD units) share a PK row — prefer reporting currency or add unit
  to the dedupe to stop cross-currency `timeseries_jump` warns
- ⬜ **Non-US fundamentals (native adapters)** — close the documented seed gaps
  (Saudi Arabia, Malaysia; thin: Germany, Sweden, HK, Indonesia, Thailand, UAE) via
  ESEF, EDINET, SEDAR, UK Companies House
- ⬜ **Sector-aware bank revenue** — compose GS/TFC/SYF revenue from net interest + noninterest income
- ⬜ Re-ingest the 1 failed company (FDXF); close the **quality → re-ingest** loop
- ⬜ **Promotion agent** — semantic memory → curated-playbook PRs (human-in-loop)
- ⬜ `testable`-lesson re-verification; embeddings backfill (`ollama pull nomic-embed-text`)

## Housekeeping  🔁
- ⬜ **Rotate `OLLAMA_API_KEY` + `GROQ_API_KEY`** (were pasted in chat during setup)
- 🔁 Keep `JOURNAL.md` / `DECISIONS.md` / `STATUS.md` / this file current each session
