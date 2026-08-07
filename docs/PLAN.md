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
- ✅ **Backtest re-run confirmed** (`backtest_runs` id=3, 2026-07-24) — numbers
  essentially unchanged from id=2 (`opportunity_score` rank-IC 0.008/0.024/0.043/0.032
  vs 0.009/0.026/0.042/0.031, still n_periods=9, not significant; `growth_score`
  anomaly unchanged). Found + fixed a real bug along the way: `recalibration.py`
  was counting Sector-KPI Research's unapplied KPI proposals as "material
  corrections" (same `kind='catalog'` as actually-applied fixes) — now
  `kind='catalog_proposal'`, excluded from the count. Still needs `n_periods >= 12`
  to clear the significance gate (accumulate more monthly price history).
- ✅ **Phase B agents verified producing real output in production** (2026-07-24) —
  queried Postgres directly: `model_invocations` 100% success (11/11 calls across
  source-discovery/sector-research/quality-triage), real proposals in
  `taxonomy_changes`/`lessons` (4 quality-check root-causes, 20 sub-sector KPIs).
  Analyst/Model-Upgrade still pending their first live `refresh.yml` firing
  (next: 2026-07-27; also test-fired manually 2026-07-25, see below).
- ✅ **Backtest rebalance cadence: weekly, not monthly** (ADR-022, 2026-07-25) —
  user-directed: investigated why n_periods was stuck at 9 (confirmed Massive's
  `403` floor is a rolling per-request entitlement check, not workaroundable by
  re-asking), presented paid-tier/finer-cadence/wait options, user chose finer
  cadence. `REBALANCE_FREQ` now `"W-FRI"` — same window, ~39 periods instead of
  9. Tradeoff (overlapping-window serial correlation) made explicit in code
  output (`significance_caveat` field), not just docs.
  **Re-fired, real results landed (`backtest_runs` id=4):** `opportunity_score`
  clears `significant: true` at all 4 horizons for the first time (t-stats
  3.07/8.08/15.39/8.88); `value_score` at 6m/12m. `growth_score`'s anomaly is
  now sharper, not resolved: significant rank-IC at 3m/6m alongside 0% hit-rate
  at 6m/12m — a real construction-problem signature, flagged as the clearest
  next investigation, not chased further this session.
- ✅ **Manual test-fire of `refresh.yml` with Analyst + Model-Upgrade forced on**
  (2026-07-25) — both verified working against real Postgres data: Analyst made
  24 successful LLM calls investigating markets but wrote zero theses this run
  (legitimate — "no thesis beats a bad one" is in its own playbook); Model-Upgrade
  correctly found zero proposals (no model/role has 20+ accumulated calls yet).
  `smart_brief` fell through 2 tiers before succeeding on Groq — waterfall working
  as designed. One real incident (not a code bug): the final dashboard-snapshot
  git commit failed with a non-fast-forward rejection from concurrent pushes
  during the ~19min run — the actual Postgres writes all succeeded regardless.
  Temporary `--model-upgrade` force reverted back to its monthly date gate.
- ✅ **Phase C v1 — surface bottom-up in the dashboard** (2026-07-25) —
  `stockvaluation.market_breakdown()`: reuses the (ticker, weight) top-holdings
  `datasource.py` already fetches for the index-level growth calc, matches
  against our EDGAR-tracked stock universe, scores the matched stocks with the
  SAME `score_frame()`/`metrics.compute()` used everywhere else (one
  universe-wide call, sliced per market — not N calls), ranks by
  `opportunity_score`. Wired into `pipeline.py` (new `stock_breakdown` payload
  key, best-effort/non-fatal, needs Postgres) and `dashboard/app.js` (a new
  "Top stocks within this market" section in the market drill-down drawer,
  reusing existing `scoreColor`/`fmt` helpers). Scratch-tested with synthetic
  data (no local DB) — caught and fixed a real bug (`set_index("ticker")`
  silently drops the ticker column from each row's dict; needed `drop=False`).
  Coverage will vary by market (only holdings we've actually EDGAR-ingested get
  a breakdown; foreign/thin markets may show nothing) — that's expected, not a
  bug, given the current ~2,983-company US-heavy universe.
- ✅ **Survivorship bias MEASURED (2026-08-07)** — `engine/sources/secfsds.py` +
  `survivorship-probe.yml`, against SEC Financial Statement Data Sets (public domain).
  2024Q3: **5,303 operating companies filed periodic reports, we hold 2,399, 2,904
  missing (54.8%)** — but that headline splits in two, and only one half is bias:
  **894 (16.9%) DELISTED** — filed then, not in `company_tickers.json` now. Gone from
  the market, absent *because of how they ended*, unrecoverable by scaling the
  universe. **This is the survivorship number.** ≈8%/yr attrition, which matches
  historical US delisting rates — an independent check that the measure is sound.
  2,010 (37.9%) **still listed**, just outside our ~2,500-US size cut. Symmetric
  across winners and losers; fixed by ingesting more, not a bias in the same sense.
  Measurement only — the fix is scoped below and not yet funded.
- ⬜ **Survivorship FIX (needs a decision):** backfill the ~894 delisted CIKs per
  quarter — companyfacts still serves them (EDGAR keeps a CIK forever), so
  fundamentals are free; **prices are the open question**, since Massive's coverage
  of delisted tickers is unverified and that gates the whole thing. Probe prices for
  a sample of delisted CIKs before committing to the backfill.
- ⬜ **Backtest follow-ups (documented gaps, not solved yet):**
  transaction costs, benchmark-relative Sharpe
  (needs an index-level price series over the same window), TTM (trailing-twelve-
  month) multiples instead of latest-FY-only (up to ~12mo stale for calendar-quarter
  reporters), forward (analyst-estimate) growth at stock level,
  continuous/live prediction-ledger grading (vs. today's historical-only harness).

## Phase B — the last 3 agents  ✅ BUILT 2026-07-23
User directive (2026-07-10, CLAUDE.md): "the product is DONE only when all the
agents are built" — Analyst, Quality-Triage, Source-Discovery, Sector-KPI,
Model-Upgrade. Source-Discovery + Sector-KPI Research already shipped and are
active in production; this phase built the remaining 3.
- ✅ **Quality-Triage** (`engine/qualitytriage.py`) — explains root causes for
  the data-quality checks firing most this run, proposes one new deterministic
  check per firing check (`taxonomy_changes`, kind='quality_check') + feeds
  semantic memory. Hooked into `datapipeline.py` step 7, gated on
  `quality.run()` actually raising issues ("on findings," no new schedule).
- ✅ **Model-Upgrade** (`engine/modelupgrade.py`, ADR-019 — scoped-down v1) —
  pure-SQL threshold analysis over the already-populated `model_scorecard`
  view; flags configured-chain models for demotion (low success rate / high
  rate-limit-hit fraction) and strong out-of-chain models for promotion;
  optional one-line LLM narrative. Advisory only — never mutates
  `config.py`/env. Monthly gate (`--model-upgrade`, day-of-month ≤7, mirroring
  `data-pipeline.yml`'s existing idiom) added to `refresh.yml`.
- ✅ **Analyst** (`engine/agent/` package, ADR-020/021 — Pillar 1) — deterministic
  gate (`select.py`) picks 3-8 genuinely ambiguous markets (value traps, thin-
  coverage GARP, big rank movers, theses due for re-check); a bounded, hand-
  rolled ReAct loop (`react.py`, MAX_STEPS=4 — no tool-use API exists in
  `llm.py`, see ADR-020) over 5 whitelisted tools (`tools.py`: `query_ledger`,
  `get_market_detail`, `fill_growth_gap`, `fetch_news` via Google News RSS,
  `write_thesis` as the only mutation) writes falsifiable theses (new `theses`
  table, migration 0010) to Postgres; `reflect.py` grades matured theses
  against realized returns and feeds outcomes back into semantic memory.
  Hooked into `pipeline.py` between surfacing and brief generation
  (`--agent` flag, default off). Advises only — never writes into scores.
- ✅ Scratch-tested (no local Postgres available this session): every no-DB/
  no-LLM degradation path, the react loop's step-budget/JSON-parse-failure/
  tool-dispatch/duplicate-kwarg-safety mechanics via a monkeypatched
  `llm.call`, and the Model-Upgrade threshold logic in both directions —
  all passing. Real end-to-end verification pending a live CI run (next step).
- ✅ **LLM path switched on in production (2026-07-23, user go-ahead):**
  `refresh.yml` now exports `OLLAMA_API_KEY`/`GROQ_API_KEY` and runs
  `--agent` every week + `--model-upgrade` on the first 7 days of the month;
  `--no-llm` dropped. `cheap_tags`/`smart_brief`/Analyst/Model-Upgrade are all
  live in production now, not just built.

## Phase D — auth, per-user watchlist, display currency, investability panel  ✅ BUILT 2026-07-27
Closes the "localStorage dead-end" called out in `docs/ARCHITECTURE.md` P3 (anonymous-only
pin/dismiss) with a real, optional per-user identity, and adds the "can I actually buy
this, and what does it cost" context Phase C's stock breakdown was missing. See
ADR-023..026.
- ✅ **FX reference rates** (`engine/sources/fx.py`, ADR-023) — Frankfurter (ECB, free,
  keyless) daily USD-base rates for 17 major currencies; new `fx_rates` table (migration
  0012); wired into `datapipeline.py`'s daily run and read back by `pipeline.py` into
  `dashboard_data.json`'s `meta.fx`. Pure display convenience — never touches a score.
- ✅ **Investability panel** (`stockvaluation.market_breakdown()`, ADR-024) — Phase C's
  stock breakdown now carries `price`/`market_cap`/`currency`/`country` per stock (was
  ratios/scores only); `_universe()` coalesces `securities.currency` to `'USD'` (never
  populated at ingest — every tracked security is US-ticker-listed, see
  `universescan.py`). Rendered as a compact line under each stock in the drawer.
- ✅ **Display-currency selector** (`dashboard/app.js`) — `convertUSD()`/`money()`/
  `marketCap()` convert the investability panel's USD-native figures into the selected
  currency client-side using `meta.fx.rates`; a header `<select>` populated from whatever
  currencies the latest FX snapshot has. Falls back to USD-only if `meta.fx` is null.
- ✅ **Supabase Auth + per-user watchlist** (`dashboard/auth.js`, migration 0011,
  ADR-025/026) — magic-link (email OTP) sign-in via `supabase-js` (CDN, no build step);
  `SUPABASE_URL`/`SUPABASE_ANON_KEY` read from `.env`, embedded in `meta.supabase` by
  `pipeline.py`. A ★ toggle in the market drawer writes/deletes `user_watchlist` rows
  (RLS-scoped to `auth.uid()`). Both env vars empty → the whole auth/watchlist UI hides
  itself; the existing anonymous localStorage pin/dismiss flow is unaffected either way.
- ✅ `DISCLAIMER.md` — two new clauses: FX rates are indicative/display-only (not
  execution rates), and account/watchlist data is user-generated (not advice) and stored
  by Supabase under its own terms.
- ⬜ Not done this phase (documented gap, not a bug): a full multi-currency fundamentals
  pipeline (re-deriving P/E etc. in non-USD) — deliberately out of scope, see ADR-023;
  the pre-existing multi-currency 20-F PK-collision issue below is a separate, unrelated
  problem (fundamentals ingestion, not display).

## Phase E — the proposal review loop (closing the meta-loop)  ✅ BUILT 2026-08-01
`docs/AGENTS.md` always promised an agent's output is a *proposal* a human turns into a
rule. Only the first half existed: **166 proposals accumulated, zero were ever applied**
(`capex_intensity` 15× in 7 days; `timeseries_jump` 8× in 8 distinct wordings; 281
sector-research lessons decayed unused). See ADR-028.
- ✅ **Schema** (`engine/migrations/0013_admin_proposals.sql`) — `proposals` + append-only
  `proposal_events` + per-proposal chat (`proposal_messages`) + Builder revisions
  (`proposal_solutions`), all admin-only under RLS via an `admins` table (an INSERT adds a
  reviewer, not a migration).
- ✅ **Lifecycle** (`engine/proposals.py`) — capture/dedup/decide/apply/park/unpark/enrich.
  Dedup key is **`(kind, target)`** — one row per decision, not per phrasing. `declined` is
  terminal and blocks re-capture at the single write path. Park carries a date **or** an
  evidence threshold so "later" resurfaces on its own.
- ✅ **Backfill** — 166 legacy rows → **61 real decisions** (56 catalog KPIs from 135
  mentions, 5 quality checks from 31), evidence counts + first/last-seen carried over.
  Nothing auto-declined: `declined` is irreversible by design.
- ✅ **Instant actioning** (`supabase/functions/admin/index.ts`, deployed + ACTIVE) —
  approve → the change happens (DATA kinds) or a GitHub issue is filed (CODE kinds), under
  the service role, with admin identity re-derived from the JWT on every request.
- ✅ **Review console** (`dashboard/admin.html` + `admin.js`) — the 4-part format, worked
  examples, evidence history, per-proposal chat, and decision buttons whose wording differs
  by kind so "approved" never silently means two things.
- ✅ **Builder agent** (`engine/builder.py` + `.github/workflows/builder.yml`, hourly) —
  approved code proposals → plain-English plan → admin approves *that* → atomic
  search/replace edits behind a compile+import gate → `builder/proposal-<id>` branch → PR →
  merged on green. Runs on the cheap `coder` chain (Qwen3-Coder first).
- ✅ **Pipeline wiring** — `datapipeline.run()` step 9 does unpark + retry-failed + enrich
  after the agents, so tonight's proposals are reviewable English tomorrow morning.
- ✅ **Sign-in config is live** — the 2026-08-01 `refresh.yml` run published `meta.supabase`
  (url + anon key) into `dashboard_data.json`, so the console authenticates as soon as this
  deploys. No operator action left.
- ✅ **Proven end-to-end 2026-08-02.** It shipped unproven — the build sandbox can't reach
  the Supabase host, so the handlers were verified by construction and against a client
  harness, never a live round trip. The first real click settled it: decide → apply →
  `metric_catalog` row, over real HTTP.
- ✅ **The loop is proven** — first real approval 2026-08-02 (`capex_intensity`, raised 15×):
  decided in the console, actioned by the Edge Function, `metric_catalog` row created.
- ✅ **Proposals must state what will consume them** (ADR-029, migration 0014) — new
  `how_used` column asked for by all three agents, filled by `enrich()` for legacy rows,
  rendered in the console and carried into the Builder's GitHub issue.
- ✅ **Scope is no longer widened silently** — that first approval applied a KPI described
  as "for Industrial Materials" to every sector, because the sector lived only in the prose.
  The console now shows the exact row approval writes, and apply records whether scope was
  declared, inferred from the text, or defaulted.
- 🔁 **The enrichment backlog has drained.** It was 60 undecided and 53 un-written-up on
  08-02; the nightly `enrich()` (limit 20) did 6 / 17 / 15 / 17 / 4 on successive runs, and
  the falling tail is the queue emptying, not the job stalling. Deciding them is the part
  that stays open — approving an un-written-up proposal warns first.

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
- ✅ **Rotate `OLLAMA_API_KEY` + `GROQ_API_KEY`** — done 2026-07 week 5 (they had been
  pasted in chat during setup)
- 🔁 Keep `JOURNAL.md` / `DECISIONS.md` / `STATUS.md` / this file current each session
