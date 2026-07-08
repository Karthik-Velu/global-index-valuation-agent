# Work journal

A running log of what happened each work session — the narrative that git history and
the decision log don't fully capture. Newest entry on top.

**Convention:** at the end of a session, prepend a dated entry: what was built, what was
learned, what's still open. Keep it to what a future session would want to know.

---

## 2026-07-08 (later) — prices, stock valuation, and the backtest harness built (ADR-016)

**User direction:** "let's get to backtesting" — the critical path item since Phase 1
completed. Built all three pieces in one session: prices, stock-level scoring, and
the walk-forward backtest.

**Built**
- **Prices in Tier B** — a second Parquet dataset (`security_id, date` PK, no
  restatement vintage). Generalized `tierb.py`'s base/delta write helpers to take a
  dataset dir + partition expression instead of duplicating them (the module's own
  docstring already anticipated "prices next"). `engine/sources/prices.py`: Stooq
  (free, keyless — every security already trades under a US ticker, so one adapter
  covers the whole universe with the uniform `TICKER.US` symbol format), daily
  incremental (anti-join append) + full/split-safe refresh (delete a ticker's
  history, then re-fetch — bounded memory throughout, never holds the whole store
  in Python, same discipline as the EDGAR OOM fix).
- **Stock-level valuation** (`engine/stockvaluation.py`) — point-in-time pe/pb/ps/
  pcf from `tierb.metrics_asof` + prices, trailing YoY growth (FY-only for flow
  metrics so a raw quarterly figure can't masquerade as annual; latest-available for
  balance-sheet snapshots), momentum/mean-reversion from price history. Hands off to
  the SAME `engine.metrics.compute()` the index product uses — one scoring formula,
  not two to keep in sync — peer-grouped by sector instead of country/style.
- **The backtest** (`engine/backtest.py`) — monthly walk-forward, no look-ahead
  (`metrics_asof(t)` + prices ≤ t), fixed-horizon (1/3/6/12m) forward returns via a
  bounded as-of price match, rank-IC + hit-rate + decile spread per signal, an
  IC-population guard and a t-stat significance gate. Persists to the `backtest_runs`
  table that's existed since ADR-005/migration 0005 — recalibration.py already reads
  it, so the trigger activates the moment a real run lands.
- CI: `price-validate.yml` (30 known-good tickers — the first REAL network test of
  the Stooq adapter, since the dev sandbox has no outbound access at all right now)
  gates `price-backfill.yml` (full-universe, multi-hour) before it fires;
  `backtest.yml` runs once price history exists. Daily pipeline gained a price
  step (step 2c) — cheap incremental, rides the monthly full-sweep flag for splits.

**Learned**
- `pandas.Series.add(other, fill_value=0.0)` rescues a genuinely-NaN VALUE in one
  operand (not just index-alignment gaps) — confirmed before trusting it: a stock
  with one missing valuation factor (e.g. no P/E because it's unprofitable) gets
  neutral-0 for that factor, not a NaN-poisoned whole score. This is what let
  `stockvaluation.py` reuse `metrics.compute()` unchanged at much sparser stock-level
  breadth than the index-level aggregates it was written for.
- The dev sandbox's outbound network went down mid-session (confirmed via the agent
  proxy status — even `sec.gov`, reachable all session until then, started 403ing).
  Everything price/backtest-related was built and verified with SYNTHETIC data
  instead — including an end-to-end test with an ENGINEERED signal (fundamental
  growth → forward price drift) that the backtest harness correctly recovered
  (mean rank-IC 0.8–0.95) and correctly refused to call "significant" despite huge
  t-stats when too few rebalance periods existed. Real-network validation is
  necessarily a CI-only next step (`price-validate.yml`), same as the Stooq/EDGAR
  URL-format uncertainties earlier in the project were resolved by iterating in CI.

**Open / next:** run `price-validate.yml`, then the full backfill, then the first
real backtest. Known, documented gaps: no survivorship control, no transaction
costs, no benchmark Sharpe, latest-FY (not TTM) multiples, no per-stock forward
growth, no dividend yield — all in PLAN.md.

## 2026-07-08 — refill repaired: Postgres 909 MB → 29 MB; two more failure modes closed

The re-truncate landed on run 4. The gate's journey taught two lessons:

- **Runs 1–2:** the superset gate refused — 4,691 "Postgres-only" rows that
  `export --incremental` could not close ("0 new rows"). They were **same-PK
  variants**, not missing data: both stores keep one row per PK
  (first-write-wins), but Tier B's base holds the June point-in-time capture
  while the refill held July's refetch (net_income ×2,153,
  cash_and_investments ×2,075, total_revenue ×292 … — in-place EDGAR
  revisions between fetches). Keeping the earlier capture IS the
  point-in-time semantics. `cutover` now separates the two cases: missing
  PKs still refuse; variants are archived to `<store>/pg_variants/` (carried
  by the bundle — nothing discarded) and the truncate proceeds.
- **Run 3:** hung 60 minutes on a dead pooler socket mid-stream —
  `pg_stat_activity` showed NO runner connection while the client blocked
  forever. `db.connect()` now sets TCP keepalives (+30s connect_timeout):
  dead peers raise in ~2 min instead of silently burning a job timeout.

End state: `fundamental_metrics` empty (32 kB), **database 29 MB** (was 909);
Tier B sole store at **3,527,837 rows / 21.3 MB**; bundle published as the
`tierb-store` release asset (durable hydration for `tierbsync pull`,
refreshed monthly by the pipeline).

## 2026-07-07 (later) — the refill incident: Postgres grew back to 3.5M rows

The post-cutover backfill quietly REFILLED `fundamental_metrics` (~900 MB, over the
Supabase cap). Chain: a CI cache miss dropped the Tier B store → `tierb.enabled()`
false → ingestion had no writer, and the "is Postgres empty?" check defaulted to
dual-write → ~444k rows landed in the truncated table → the NEXT run saw a
non-empty table, concluded "pre-cutover", and dual-wrote all 3.07M. Tier B itself
was fine (3,527,837 rows — a verified superset of the refill).

**Fixes** (all tested against scratch PG):
- `edgar.ingest_tickers` now ABORTS loudly when the store is missing AND Postgres
  is empty — the post-cutover cache-miss case must hydrate (`tierbsync pull`),
  never silently re-inflate Postgres.
- `tierbsync cutover` gate is now **superset** (every PG row ∈ Tier B), not full
  equality — Tier B legitimately holds more after partial runs, and equality
  would have blocked the repair.
- `tierb-retruncate.yml` one-shot: restore newest store → superset-gated cutover
  → publish the bundle as a **GitHub release asset** (`tierb-store` tag). The
  daily pipeline refreshes that asset on the monthly sweep — `tierbsync pull`
  now has a hydration source that survives cache eviction (the root cause).

Lesson: a data-detected mode switch (empty table = post-cutover) needs BOTH sides
guarded — the detector was fine, but the fallback when its co-input (the store)
vanished re-created the old mode. Fail loudly when state inputs disappear.

## 2026-07-07 — cutover executed; universe 501 → 2,983; the OOM saga

**Cutover (07:06 UTC):** all verify gates passed against production, store bundled
(90-day artifact), `fundamental_metrics` truncated. Postgres ~20 MB (ops/dashboard
only); Tier B is the sole metric store. Ingestion self-detects via the empty table.

**Universe:** US top-2,500 (public float, median-over-9-frames + size-proxy
cross-check) + foreign discovery finalized at **inclusion = files 20-F/40-F + has a
US ticker** (285 auto + 198 curated across 26+ markets: China 63, Israel 59, UK 49…).
Two discovery iterations were needed: USD-only frames kept just the USD-reporting
cohort (80), and even multi-currency frames proved SPARSE for IFRS filers — frames
sizing is ordering-only now.

**The OOM saga:** backfill runners died twice at ~40 min with "runner received a
shutdown signal". Root cause: `edgar._facts_cache` retains every companyfacts JSON
(1–10 MB each) — fine at 501 companies, OOM at ~700 of 3,300. Fix: `cache=False` in
bulk ingest (the cache serves only the adapter's repeated samples) + progress lines.
Lesson: module-level caches that survive a 500-item workload are still time bombs at
6× scale; and "runner shutdown signal" in Actions is the OOM signature, not infra flake.

**Still open:** transient quality collapse (0/100, no_fundamentals errors) until the
backfill completes — securities rows persisted from killed runs while their metric
rows died with the runner. Self-heals on the next successful sweep.

## 2026-07-06 (evening) — storage inversion + real scale (ADR-015)

**User direction:** much more than 1,200 companies; Postgres only for dashboard-facing
state; ETF proxies stay the priority signal (baskets later where no ETF exists).

**Built**
- **Immediate cutover (user-approved):** `tierbsync cutover` — verify gates must pass,
  bundle archived, then `truncate fundamental_metrics`. Ingestion **self-detects** the
  empty table and writes metrics Tier-B-only (the truncate IS the switch; no flag).
- **`discover-foreign`** (universescan): all 20-F/40-F filers from EDGAR's form
  indexes (the exact FPI definition), assets-ranked via us-gaap + ifrs-full instant
  frames, business-address country classification (Cayman-inc → China solved),
  ≥$100M assets, ≤1,000/market for the 30 target markets. Curated list becomes an
  override. `us_target` → 2,500.
- **Index universe 94 → 132:** global sectors (IXN/IXJ/…), US industries (IGV/KRE/
  ITB/…), factor styles incl. international (VLUE/SCHD/COWZ/EFV/IQLT/…), regions.
- **`tierb-cutover.yml`** one-shot: verify → archive → truncate → expand-us →
  discover-foreign → full backfill (multi-hour) → coverage + quality → compact/bundle.
- Full sweep cadence weekly → **monthly** (first Sunday); dailies stay incremental.

**Learned**
- The dual-write window and the scale-up are mutually exclusive: 23M rows ≈ 6 GB in
  Postgres vs ~150 MB in Parquet — the cutover had to come first, and the 6 live
  validation runs earlier today stood in for the proving window.

## 2026-07-06 (later) — global universe expansion built, gated on cutover

**Built** (ADR-014)
- **Universe as committed data** — `engine/sources/universe_stocks.json`: 198 curated
  SEC-filer (20-F/40-F) stocks across the top-10 markets of Europe, Asia, and the rest
  of the world (with honest per-market coverage gaps documented), plus `stocks_us`
  generated by `engine/universescan.py expand-us` (top ~1,000 by `dei:EntityPublicFloat`
  via the XBRL frames API). The pipeline reconciles the DB to the file — the old 501
  lived only in the DB.
- **IFRS canonical mappings** in `catalog._CANONICAL` (`Revenue`, `ProfitLoss`,
  `CashFlowsFromUsedInOperatingActivities`, …) so 20-F foreign filers resolve the same
  core metric_codes — quality checks and scoring work unchanged.
- **Incremental daily ingestion** — EDGAR's daily index filters the universe to
  companies that actually filed recently (+ new seed tickers); Sunday runs full-sweep.
  Keeps CI minutes flat while the universe grows ~2.5×. `edgar.ingest_tickers` now
  takes `country_by_ticker` (was hard-coded 'United States').
- **Expansion gate:** while Postgres still dual-writes (pre-cutover), only the
  30-company cross-region validation batch ingests (ADR-011) — the full expansion
  would blow the Supabase 500 MB cap. It joins automatically post-cutover.
- `universe-validate.yml` (one-shot CI): generates stocks_us, ingests the validation
  batch, prints per-market core-metric coverage + quality score.

**Gate A also passed today** (see below): 1,469,371 rows verified, store 6.6 MB.

## 2026-07-06 — Tier B built (Parquet + DuckDB), dormant until export

**Built**
- **`engine/tierb.py`** — the Tier-B access layer (mirror of `db.py`): in-memory DuckDB
  over `data/tierb/` Parquet with a PK-dedupe view (base + delta), `append_metrics()`
  (anti-join ≙ ON CONFLICT DO NOTHING), `delete_metric_code()` (atomic rewrite-and-swap),
  and **`metrics_asof()`** — the no-look-ahead point-in-time API the backtest will use.
- **`engine/tierbsync.py`** — export (full/incremental) / verify / compact / bundle /
  pull. Verify = Gate A: row counts, bidirectional set equality, AAPL net_income
  vintage identity, no-look-ahead behaviour on a real restatement.
- **Call sites wired, data-gated:** everything switches on `tierb.have_tierb()` — until
  the store exists, zero behaviour change. Once exported: EDGAR ingestion dual-writes,
  the pipeline reconciles (incremental export step 2b), quality/validate/recalibration
  read DuckDB (`quality_report.json` gains `"metrics_engine"`), suspect purges hit both
  stores. CI: daily workflow caches `data/tierb`, weekly workflow compacts + uploads a
  90-day bundle artifact.
- ADR-013 records the design (psycopg streaming, filings stay in Postgres, gated cutover).

**Learned / fixed**
- The DuckDB postgres extension is a **runtime download** — it failed behind the cloud
  session's egress policy (403). Switched to streaming via psycopg (already a dep):
  more portable, no moving parts, and lets incremental sync pull only rows past the
  `ingested_at` high-water mark (kind to Supabase free-tier egress).
- Tested end-to-end against a scratch Postgres 16: export → verify (all gates) →
  incremental (exact, idempotent) → compact → re-verify → bundle → pull; quality/
  validate produce **identical issues and verdicts on both engines** (Gate B rehearsal,
  every check exercised); dual-write adds identical row counts to both stores; the
  full-export refusal guard blocks the post-cutover data-loss scenario.
- `value` is a reserved-ish token in DuckDB — quote it as an alias.
- An adversarial multi-angle review before merge caught real gaps: a falsy-zero skip
  in the source-disagreement check (fixed in BOTH engines), an incremental-sync window
  that could permanently orphan rows missed by a failed dual-write (now self-heals on
  count drift), and silent Postgres fallbacks that could mask a broken store for the
  whole proving window (now one `tierb.enabled()` gate + count-parity guards that warn
  and fall back only when Tier B is genuinely behind).

**Open / next**
- **Activate**: run `tierbsync export` + `verify` with the real `DATABASE_URL` (this
  session had no keys), confirm quality stays 99/100 on `metrics_engine: tierb`,
  watch a ~1-week dual-write window, then cut over (pg_dump archive → Tier-B-only
  writes → truncate `fundamental_metrics` → DB ~20 MB).
- Then prices (Tiingo, into Tier B) → stock-level valuation → backtest.
- Still open: rotate `OLLAMA_API_KEY`/`GROQ_API_KEY`; bank revenue composition; FDXF.

## 2026-06-27 — providers, waterfall, memory, full ingestion, cloud handoff

**Built**
- **Waterfall LLM router** (`engine/llm.py`): per-role provider chains, cooldowns on
  429/error, degrades to deterministic text. Model-specific learning (`model_scorecard`,
  `model_profiles`, migration 0006). Shared model-agnostic playbooks in `engine/context/`.
- **3-tier semantic memory** (`engine/memory.py`, migrations 0007–0008): capture →
  consolidate → verify/decay → promote; pgvector retrieval (3 graceful modes);
  `belief_at()` for point-in-time. Wired into agents + the pipeline.
- **Providers keyed:** Ollama Cloud (`ollamacloud:gpt-oss:120b`, tier-1) + Groq
  (`llama-3.3-70b-versatile`, fallback), both in `.env` + GitHub secrets + CI.
- **Full universe ingested:** 501 large-caps, **1.45M point-in-time metric rows**, 31k
  filings.
- **Cloud/mobile handoff:** refreshed `docs/STATUS.md`, added `CLAUDE.md` (auto-loads),
  this journal + `docs/DECISIONS.md`.

**Learned / fixed**
- 🐛 **Apple had no earnings** — derived/ratio metrics stole raw XBRL concepts via first-wins
  mapping. Fixed with `catalog._CANONICAL` (ADR-010). Validate-before-scale (ADR-011) caught it.
- Data-quality checks were over-sensitive and the score didn't scale: negative revenue is
  *real* for insurers (AIG 2008), earnings/CF/equity legitimately swing/flip. Rate-based
  scoring + scale-tuned checks → **99/100** across 501 companies (ADR-009).
- `gpt-oss` is a reasoning model — small token budgets got consumed before output; raised
  agent budgets to 1500 and added an empty-completion fall-through.
- Storage at 501 stocks = 387 MB (near Supabase's 500 MB free cap) → decided on Tier B
  (Parquet/DuckDB) over a bigger DB (ADR-012).
- Agents proposed genuinely useful license-clean sources for the non-US expansion: FRED,
  ECB, UK Companies House, EU ESEF, Canada SEDAR, ASX — recorded as leads + lessons.

**Open / next**
- **Build Tier B** (Parquet + DuckDB, local first) — move `fundamental_metrics` out of
  Postgres, then **prices → stock-level valuation → backtest** (the critical path).
- Rotate `OLLAMA_API_KEY` + `GROQ_API_KEY` (pasted in chat during setup).
- `ollama pull nomic-embed-text` to enable semantic (vs lexical) memory retrieval.
- Sector-aware bank revenue (GS/TFC/SYF); re-ingest failed company FDXF.

## 2026-06-26 — Phase 1 foundation

Index-level product live on Vercel; cloud Postgres as source of truth; SEC EDGAR
stock-level ingestion designed (point-in-time, sector-aware 110-KPI catalog); jobs-vs-agents
architecture and the sequenced data pipeline established. See `docs/STATUS.md` history.
