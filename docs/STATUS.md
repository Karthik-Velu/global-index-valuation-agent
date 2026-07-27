# Project status & handoff

> Snapshot of where the build is, so work can resume cleanly — **including from a fresh
> cloud/mobile session** that has none of the prior chat context. Pairs with
> [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [AGENTS.md](AGENTS.md),
> [MODEL_ROUTING.md](MODEL_ROUTING.md), [MEMORY.md](MEMORY.md), [DATA_INGESTION.md](DATA_INGESTION.md).
>
> Last updated: 2026-07-27.

## Working from a cloud session (mobile) — read this first

Everything runtime is **already cloud-hosted**, so this repo runs anywhere:
- **DB:** Supabase Postgres (cloud). **LLMs:** Ollama Cloud + Groq (hosted). **Dashboard:** Vercel.
- Local-only pieces degrade gracefully: local Ollama is superseded by `ollamacloud:`;
  local embeddings (`nomic-embed-text`) just make memory retrieval fall back to lexical.

To continue in a Claude Code **cloud session**, set these env vars / secrets in that
environment (they live in the local `.env`, which is gitignored, and as GitHub Actions
secrets — a dev cloud session needs its own copy):

| Var | What | Where it's already set |
|---|---|---|
| `DATABASE_URL` | Supabase session-pooler URI | GitHub secret ✅ |
| `OLLAMA_API_KEY` | Ollama Cloud (tier-1 agent model) | GitHub secret ✅ |
| `GROQ_API_KEY` | Groq (fallback tier) | GitHub secret ✅ |
| `SEC_USER_AGENT` | polite UA for EDGAR | GitHub secret ✅ |

⚠️ **Rotate `OLLAMA_API_KEY` and `GROQ_API_KEY`** — they were pasted into chat during setup.

## Live / working now

**Product (Phase 1, index level)** — public dashboard on Vercel (~90 indices, value +
fundamental growth + GARP). Repo (private, MIT): `Karthik-Velu/global-index-valuation-agent`.

**Data foundation (Phase 1) — COMPLETE**
- **Tier A: Supabase Postgres** — single source of truth. Schema `engine/migrations/0001..0008`.
- **Stock fundamentals via SEC EDGAR** (`engine/sources/edgar.py`) — point-in-time with
  restatement vintages, driven by the 110-KPI catalog (`engine/sources/metric_catalog.json`).
  **501 large-caps ingested: 1.45M metric rows, 31k filings, data-quality 99/100.**
  Universe was a public large-cap US list (we redistribute only public-domain EDGAR data).
- Concept mapping is pinned in `catalog._CANONICAL` (core line items can't be stolen by
  ratio/derived metrics — the bug that once left AAPL with no net_income).
- **Tier B (Parquet/DuckDB): BUILT, awaiting activation.** `engine/tierb.py` (access
  layer, point-in-time `metrics_asof`) + `engine/tierbsync.py` (export/verify/compact/
  bundle/pull). Everything is gated on the store existing — nothing changes until
  `python -m engine.tierbsync export` runs against the real DB. See ADR-013.

**LLM waterfall** (`engine/llm.py`, the only LLM entrypoint: `call(role, …)`)
- Per-role chains, tier-1 = `ollamacloud:gpt-oss:120b`, fallback `groq:llama-3.3-70b-versatile`,
  then local Ollama; falls through on 429/error, degrades to deterministic text. In CI.
- Model-specific learning: `model_scorecard` (reliability) + `model_profiles` (packaging).

**Memory (3-tier)** — episodic logs → semantic `lessons` (Postgres, pgvector, provenance/
confidence/decay/point-in-time) → curated `engine/context/*.md`. Agents capture lessons;
pipeline consolidates. See [MEMORY.md](MEMORY.md). Embeddings need `ollama pull nomic-embed-text`
locally (else lexical retrieval).

**Jobs vs agents** — Jobs (deterministic): valuation/scoring (`engine.cli refresh`, weekly),
data pipeline (`engine.datapipeline`, daily, `--agents` in CI). **All 5 agents are now
built** (2026-07-23): source-discovery + sector-KPI research (active in CI today),
quality-triage (hooked into the daily pipeline, on findings), analyst + model-upgrade
(built, gated behind `refresh --agent`/`--model-upgrade`, both default off pending the
`refresh.yml` activation decision below). See [AGENTS.md](AGENTS.md).

**CI** — GitHub secrets: `DATABASE_URL`, `OLLAMA_API_KEY`, `GROQ_API_KEY`, `SEC_USER_AGENT`.
Workflows: `data-pipeline.yml` (daily, runs `--agents`), `refresh.yml` (weekly).

## Storage & cost (drives the next step)
- DB is **387 MB**; `fundamental_metrics` is 368 MB of it (95%). ~0.77 MB/company.
- Supabase free tier caps the DB at **500 MB** → we're at ~77%. Going to 1,000 stocks
  (+ prices) overflows it.
- **Extending on Supabase = jump to Pro $25/mo** (8 GB incl.). **Tier B (Parquet on
  Cloudflare R2) ≈ $0** (10 GB free, zero egress; Parquet compresses ~5–8× and drops
  index overhead). Conclusion: keep the ~15 MB relational state in Supabase free, move
  bulk time-series to Parquet/DuckDB.

## Current state: CUTOVER DONE, universe scaled (2026-07-07, ADR-015)
- **Cutover executed 2026-07-07 07:06 UTC** — all verify gates passed (1,469,371
  rows), store bundled as the rollback artifact, `fundamental_metrics` truncated.
  Tier B (Parquet/DuckDB) is the SOLE metric store; ingestion self-detects it
  (`tierb_only` in ingest stats). Postgres = thin dashboard/ops layer (~20 MB).
- **Universe: 2,983 companies across 26+ markets** — US top-2,500 by cross-checked
  public float + 285 auto-discovered foreign (20-F/40-F + US ticker) + 198 curated.
  Committed in `engine/sources/universe_stocks.json`; self-refreshes monthly.
- **Index universe: 132 ETF proxies** (global sectors, US industries, factor styles).
- **Automation:** daily incremental ingest 06:00 UTC (EDGAR daily index), monthly
  full sweep + universe refresh (1st Sunday), daily health check 07:15 UTC.
- Backfill note: two CI runners died mid-ingest before the `_facts_cache` OOM fix
  (see JOURNAL 2026-07-07); ingestion is PK-deduped/idempotent, so re-runs resume.
- **Refill incident (REPAIRED 2026-07-08):** a cache miss during the backfill silently
  refilled Postgres to 3.5M rows (909 MB); re-truncated after a PK-level superset gate
  (4,691 same-PK variants archived in the bundle — June point-in-time capture kept).
  Fixes shipped: loud abort in ingestion (missing store + empty PG), variant-aware
  cutover gate, TCP keepalives on all PG connections, and the **`tierb-store` release
  asset** (refreshed monthly) as the durable hydration source for `tierbsync pull`.
  End state: **database 29 MB**; **Tier B = 3,527,837 rows / 21.3 MB** across 1,645
  ingested companies (29 markets); quality 93/100 (known follow-ups in PLAN.md).

## Current state: REAL price data landed (2026-07-20) — first real backtest next
- **Prices (ADR-017: Massive, ex-Polygon.io) — LIVE.** `MASSIVE_API_KEY` added
  2026-07-20; `price-validate.yml` passed against the real service (30/30
  validation-batch coverage, ETF proxies confirmed, ~22mo history entitled on
  the free tier). `price-backfill.yml` then completed: **1,420,695 real OHLCV
  rows** written to Tier B, floor correctly hit at `403 NOT_AUTHORIZED` (the
  free tier's ~2-year window), zero errors.
- **Real-network bug found + fixed on the first backfill attempt:** the fresh
  full-rebuild's `walk_from = date.today()` hit today's own (not-yet-published)
  session first and false-floored with 0 rows written, before ever trying a
  day we'd already proven entitled. Fixed with `_last_complete_trading_day()`
  excluding today from both the full and incremental walks; also hardened
  `fetch_day_into`'s missing exception handling. See JOURNAL 2026-07-20 — a
  concrete case for why "not yet run against real market data" was flagged as
  a real risk, not a formality: the synthetic mock always modeled "today" as
  having valid data, so this was untestable before real-network validation.
- **Stock-level valuation + backtest:** built, synthetic-verified, merged
  (ADR-016) — **now unblocked**, real price data exists to run it against.
- **Licensing flag:** Massive's derived-data terms clause needs a human read before
  stock-level derived metrics go PUBLIC (raw redistribution definitively requires a
  business plan — we never republish raw bars anyway). See ADR-017.

## Current state: FIRST REAL BACKTEST completed (2026-07-22, `backtest_runs` id=1)
- Window auto-detected as **2024-10-20 .. 2025-07-17, 9 monthly rebalance dates**
  (narrower than the ~2y price span — the walk-forward loop needs the 12m
  horizon's forward return inside the store too, so the window's end is
  pinned ~12mo before the latest price date).
- **`opportunity_score` (the combined GARP score) is the standout across every
  horizon**: mean rank-IC 0.009 / 0.026 / **0.042** / 0.031 at 1m/3m/6m/12m,
  hit-rate 78% / 89% / **100%** / 100%, positive in every single period at
  3m/6m (`pct_positive_ic` 1.0). t-stats are the strongest in the whole table
  (3.47 / 5.84 / 4.43 at 3m/6m/12m) — but **none clear `significant: true`**,
  because the gate requires `n_periods >= 12` and this maiden run only has 9;
  the t-stat threshold (|t|>=2) is otherwise cleared comfortably. Read this as
  a genuinely encouraging early signal, not yet statistically proven.
- `value_score` trends the same direction (IC ~0 at 1m rising to 0.024 by
  12m, hit-rate reaching 100% at 6m/12m) — weaker, same small-sample caveat.
- `growth_score` and `momentum_score` show no real signal yet. **The
  growth_score hit-rate/rank-IC divergence is now confirmed with per-period
  data** (2026-07-22, `backtest_runs` id=2, which persists full per-period
  detail — see `engine/backtest.py::_persist`): at 6m, **hit_rate is 0% in
  all 9/9 periods** — the top-quartile-by-growth-score names' *mean* forward
  return trails the bottom quartile's every single time, by up to -29pp
  (Apr/May 2025). rank_ic (the full ~2,700-name Spearman correlation) is
  mildly *positive* in the first 5 periods (Nov'24–Mar'25, +0.01 to +0.14)
  then flips *negative* in the last 4 (Apr–Jul'25, -0.07 to -0.00). So this
  isn't just "hit-rate is a noisy statistic on two small buckets" as
  originally hypothesized — it's a real, consistent pattern in this window:
  high-growth-score names underperformed on a mean basis throughout,
  worst during a Apr–Jun 2025 stretch consistent with a growth-stock
  selloff. Two live hypotheses, not yet distinguished: (a) a genuine
  growth-trap effect in this specific regime, or (b) a signal-construction
  issue (latest-FY-only fundamentals, not TTM — the documented caveat in
  `engine/backtest.py`'s docstring). Needs more history/regimes before
  concluding either way; not chasing further with only 9 periods.
- **CI capacity note:** `backtest.yml` failed twice with 0 billable runner-ms
  before this — a private-repo GitHub Actions minutes/spending cap, confirmed
  via a control-test push to an unrelated, already-working workflow that
  failed identically. **The user made the repo public** (unlimited free
  Actions minutes on public repos), which fixed it immediately — no code
  change was the actual fix, despite an earlier real bug fix
  (`github.event.inputs.*`, commit 36ffbde) found along the way.
- Read the numbers with the documented methodology caveats front and center
  (see `engine/backtest.py` docstring): no survivorship-bias control,
  latest-FY-only fundamentals (not TTM), no transaction costs, single
  9-period window. This is a first look, not a validated edge.

## Backtest re-run (2026-07-24, `backtest_runs` id=3) — numbers essentially unchanged
Re-fired after recalibration flagged `full_rebacktest` twice (37 then 58 "material
corrections" since id=2). Window barely moved (2024-10-20 .. **2025-07-21**, still
9 monthly rebalances — 4 more days of price history wasn't enough to add a 10th
period) and the real numbers are nearly identical to the 2026-07-22 run:
`opportunity_score` mean rank-IC **0.0079 / 0.0239 / 0.0433 / 0.0323** at
1m/3m/6m/12m (was 0.009/0.026/0.042/0.031), hit-rate 78% / 89% / **100%** / 89%
(12m dipped slightly from 100%, still strong), t-stats 1.10 / 3.76 / **5.91** /
5.25 — still **not `significant: true`** (same `n_periods=9 < 12` gate). The
`growth_score` anomaly **persists unchanged**: 0% hit-rate at 6m AND 12m despite
positive mean rank-IC in both (0.028 @ 6m, though 12m flipped to -0.002).

**Real finding from re-running this, not just a "still not significant" result:**
the recalibration trigger's "material corrections" counter was double-counting.
`engine/recalibration.py` counts every `taxonomy_changes` row with `kind='catalog'`
as a correction — but `engine/sectoragent/research.py`'s Sector-KPI Research agent
(now running DAILY as part of Phase B, previously monthly) was writing its inert
KPI *proposals* under that same `kind='catalog'`, indistinguishable from
`validate.py`'s actually-applied catalog fixes. A proposal a human hasn't reviewed
yet cannot have moved any computed score, so it should never count toward "the
data changed, redo the backtest." This is exactly why 58 "corrections" in 2 days
produced a backtest that's numerically indistinguishable from the prior one.
**Fixed**: `research.py` now writes proposals under `kind='catalog_proposal'`
instead, so `recalibration.py`'s `kind='catalog'` filter naturally excludes them
going forward (only Quality-Triage's `kind='quality_check'` and Model-Upgrade's
`kind='model_routing'` were already correctly excluded — Sector-KPI Research was
the one gap). No schema change, no other reader depended on the old value
(checked via a full-repo grep for `kind='catalog'`).

## Backtest rebalance cadence: weekly, not monthly (ADR-022, 2026-07-25)
User asked why we can't just backfill 2 more years of price history to unblock the
`n_periods >= 12` significance gate faster. Investigated and confirmed in code
(`engine/sources/prices.py`): Massive's `403 NOT_AUTHORIZED` floor is a ROLLING,
server-side entitlement check against *today's* date — re-requesting older dates
hits the identical 403 immediately, no matter how we ask. Only a paid tier upgrade
changes that. Given the choice (paid tier / finer cadence / keep waiting), the user
chose **finer rebalance cadence**: `engine/backtest.py`'s `REBALANCE_FREQ` is now
`"W-FRI"` (weekly) instead of `"MS"` (monthly) — the same ~9-month window now
yields **~39 rebalance dates instead of 9**, clearing the significance gate with
real margin, at $0. The real tradeoff (made explicit in code/output, not buried):
weekly windows overlap heavily between adjacent periods, so the per-period IC
series is serially correlated in a way the current t-stat gate doesn't adjust
for — `result["significance_caveat"]` now populates whenever cadence isn't
monthly and prints alongside any `significant=true` result; `cadence` is
persisted in `backtest_runs.metrics` so this can never be silently misread as
a fully rigorous result downstream.

**Real results landed** (`backtest_runs` id=4, 2026-07-25, same window
2024-10-20..2025-07-21, now 39 W-FRI periods): **`opportunity_score` clears
`significant: true` at all four horizons for the first time** — mean rank-IC
0.0122 / 0.0296 / 0.0437 / 0.0272 at 1m/3m/6m/12m, hit-rate 79.5% / 92.3% /
**100%** / 94.9%, t-stats 3.07 / **8.08** / **15.39** / 8.88. `value_score`
clears significance at 6m/12m (t 2.39/3.31) but not 1m/3m. **Read every one of
these WITH the significance_caveat** (overlapping weekly windows are serially
correlated — the t-stat gate doesn't adjust for that, so these are real,
encouraging numbers but a weaker statistical guarantee than 39 truly
independent monthly periods would give). `momentum_score` stays null/negative
throughout, consistent with this project's "growth means fundamentals, never
momentum" stance. **The `growth_score` anomaly is now more clearly a red
flag, not less**: it clears `significant: true` at 3m (t=2.09) and 6m
(t=2.31) — rank-IC of 0.031/0.027 — while hit-rate stays **0% at 6m AND 12m**.
A metric that's "significantly correlated" by rank-IC while its top-quartile
picks lose to its bottom-quartile picks every single period is exactly the
profile of a real construction problem (likely latest-FY-only fundamentals
going stale, the documented hypothesis), not noise — the extra periods didn't
resolve the mystery, they sharpened it. Not chasing further this session;
flagged as the clearest concrete next investigation.

## Phase B agents: Analyst + Model-Upgrade verified live (2026-07-25)
Manually test-fired `refresh.yml` with both forced on (bypassing the monthly
gate for Model-Upgrade) rather than waiting for Monday's cron. Verified
directly against Postgres (not just "the step didn't crash"):
- **Analyst**: 24 real, successful LLM calls (`ollamacloud:gpt-oss:120b`,
  100% success) across its ReAct loop, investigating the run's flagged
  markets. **Wrote zero theses this run** — a legitimate first-run outcome,
  not a failure: the playbook explicitly instructs "no thesis beats a bad
  one," and 4 steps is a tight budget for a genuinely novel task. Worth
  watching whether it ever converges to a written thesis in future runs; not
  alarming yet.
- **Model-Upgrade**: correctly found zero proposals (`taxonomy_changes` where
  `kind='model_routing'` is empty) — expected, since no model/role pairing
  has yet accumulated the `MIN_N=20` evidence threshold this young into the
  system running. The deterministic gate worked correctly; there was nothing
  to flag.
- **`smart_brief`**: fell through 2 failing tiers (`ollamacloud:gpt-oss:120b`,
  `ollamacloud:deepseek-v3.2`) before succeeding on `groq:llama-3.3-70b-versatile`
  — the waterfall did exactly what it's designed to do.
- **Real incident, not a code bug**: the run's final "commit dashboard
  snapshot" step failed with a git `non-fast-forward` rejection — this
  session pushed 3 more commits to the same branch while the ~19-minute run
  had an already-stale checkout. The actual data-producing work (Postgres
  writes) all completed successfully before that; only the redundant static
  JSON commit was lost. Reverted the temporary `--model-upgrade` force back
  to its date-gated form once verification was complete.

## Phase A hardening (2026-07-22)
- **Corporate actions shipped (ADR-018), hardened through 4 real CI failures:**
  `engine/sources/corpactions.py` pulls dividends + splits from Massive's v3
  reference endpoints (bulk date-range, whole market per query) into new
  Postgres `dividends`/`splits` tables (migration 0009). `stockvaluation.py`'s
  `dividend_yield` is now a REAL trailing-12-month dividends-per-share ÷ price,
  point-in-time — replacing the hardcoded `0.0` every stock previously got.
  The one-time `corpactions-backfill.yml` needed 4 iterative fixes to get
  right: (1) a Postgres catalog race between two workflows applying the same
  migration concurrently, (2) zero progress visibility masking a 30-min
  timeout, plus pagination pacing far too aggressive for the provider's rate
  limit, (3) a `limit=5000` parameter exceeding the reference endpoints' real
  max of 1000 (a different, lower ceiling than the aggregates endpoints
  prices.py uses), and (4) the real architectural finding: the "whole US
  market" is far bigger than our ~3,000-ticker universe (394,000+ dividend
  rows in a 2-year window, still climbing, with splits not even started) —
  and the old design accumulated every page in memory, discarding all of it
  when a 90-minute timeout hit mid-fetch. Fixed by shrinking the backfill
  window from 2 years to ~13 months (dividend_yield only ever needs a
  trailing-12-month window; 2y was copied from prices.py's precedent without
  checking whether corp actions needed the same depth) and persisting PER
  PAGE instead of batching to the end, so an interrupted run keeps real
  progress and a re-fire extends coverage via `ON CONFLICT DO NOTHING`
  idempotency rather than repeating wasted work. Wired into the daily
  pipeline (step 2d, ~35d incremental window — shrunk from 400d for the same
  reason) + `corpactions-backfill.yml` (one-time ~13mo history; the 5th
  attempt, with all fixes in place, has not yet been confirmed complete).
- **Migrations are now self-healing:** found no CI step anywhere applied
  `engine/migrations/*.sql` automatically (each of the first 8 needed a manual
  `db.apply_migrations()` run) — added as `datapipeline.py` step 0.
- **Recalibration trigger confirmed wired:** `recalibration.py` reads
  `backtest_runs` (2 real rows now exist) and `datapipeline.py` step 6 calls it
  every run — no separate activation needed, the `pending_initial` branch is
  already behind us.
- **Full hardcoding/dummy-data audit (user directive, ahead of production):**
  removed the dead Stooq adapter (still registered/probed daily after Massive
  replaced it), closed 3 silent `SEC_USER_AGENT` placeholder-fallback call
  sites (now raise loudly if unset, matching prices.py's `_api_key()` pattern),
  fixed a data-quality scorer bug (empty adapter responses scored ~43/100
  instead of near-zero), dropped `push:` triggers from 5 completed one-shot
  migration workflows (destructive-job re-fire risk), refreshed stale
  "no backtest yet" claims in README/DISCLAIMER/dashboard now that a real
  backtest has run, and cleaned up `.env.example` (documented
  `SEC_USER_AGENT`/`MASSIVE_API_KEY`, dropped unused Supabase/R2 placeholders).
  Still open: rotate `OLLAMA_API_KEY`/`GROQ_API_KEY` (pasted into chat during
  initial setup — needs the user to generate new keys), a minor LLM-output
  disclosure-marker gap in `llm.py::_fallback_tag`.

## Phase B: the last 3 agents shipped (2026-07-23)
User directive (2026-07-10): "the product is DONE only when all the agents are
built." Quality-Triage (`engine/qualitytriage.py`), Model-Upgrade
(`engine/modelupgrade.py`, ADR-019 — deliberately scoped-down v1, no
`models.yaml`/golden-eval), and Analyst (`engine/agent/` package, ADR-020/021
— bounded ReAct loop, MAX_STEPS=4, 5 whitelisted tools, new `theses` table
via migration 0010, reflection-based grading) are all built, following the
existing `discover.py`/`research.py` pattern exactly. Full detail in
docs/PLAN.md's "Phase B" section and docs/JOURNAL.md's 2026-07-23 entry.

Scratch-tested (no local Postgres in this session): every no-DB/no-LLM
degradation path, react-loop step-budget/parse-failure/tool-dispatch
mechanics, Model-Upgrade's threshold logic both directions — all passing.
**Not yet done:** a real end-to-end run against the live DB + a configured
model (actual `theses`/`taxonomy_changes` rows, actual LLM tool selection).

**LLM path switched ON in production (2026-07-23, user go-ahead).** `refresh.yml`
now exports `OLLAMA_API_KEY`/`GROQ_API_KEY` (mirroring `data-pipeline.yml`) and
runs `engine.cli refresh --no-cache --agent $MU` (dropped `--no-llm`) — so
`cheap_tags`/`smart_brief`, the Analyst agent (every run — "per valuation run"
cadence), and Model-Upgrade (`--model-upgrade`, first 7 days of the month) are
all live. Every one of the three still degrades gracefully to the deterministic
path if a model tier is ever unavailable — this was never a hard dependency.

## Phase D: auth, per-user watchlist, display currency, investability panel (2026-07-27)
Closes the P3 "localStorage dead-end" (ARCHITECTURE.md) with real per-user identity, and
adds the practical "can I buy this, what does it cost" context Phase C's stock breakdown
was missing. Full detail in `docs/PLAN.md`'s "Phase D" section and ADR-023..026.
- **FX rates** (`engine/sources/fx.py`) — Frankfurter (ECB, free, keyless), new
  `fx_rates` table (migration 0012), wired into `datapipeline.py` + read back into
  `dashboard_data.json`'s `meta.fx` by `pipeline.py`. Display-only — never touches a score.
- **Investability panel** — `stockvaluation.market_breakdown()` now includes
  `price`/`market_cap`/`currency`/`country` per stock (previously ratios/scores only);
  `_universe()` coalesces the never-populated `securities.currency` to `'USD'` (every
  tracked security is US-ticker-listed).
- **Display-currency selector** (`dashboard/app.js`) — converts the investability
  panel's USD-native figures client-side using `meta.fx.rates`.
- **Supabase Auth + watchlist** (`dashboard/auth.js`, migration 0011) — magic-link
  sign-in via CDN `supabase-js`; a ★ toggle in the market drawer writes/deletes
  `user_watchlist` rows (RLS-scoped). `SUPABASE_URL`/`SUPABASE_ANON_KEY` both empty
  (the default until an operator sets them) hides the whole feature — zero regression
  for the existing anonymous localStorage pin/dismiss flow.
- `DISCLAIMER.md` — 2 new clauses (FX rates are indicative/display-only; watchlist data
  is user-generated, not advice, stored by Supabase under its own terms).
- **Not done, deliberately** (see ADR-023/P3): a multi-currency fundamentals pipeline,
  and turning the watchlist into a learning signal (`user_vector`/`user_predictions`) —
  today it's a saved list, not personalisation yet.

## Immediate next step
1. **Operator action needed to activate Phase D in production:** add `SUPABASE_URL` /
   `SUPABASE_ANON_KEY` (Settings → API in the Supabase dashboard — the anon/publishable
   key, not the service-role key) as **GitHub repo secrets**, then update
   `.github/workflows/refresh.yml`'s `env:` block to pass them through (done — see
   ADR-025/026). The static dashboard has no build step, so `pipeline.py` bakes both
   into the published `dashboard_data.json`'s `meta.supabase` at refresh time; until the
   secrets exist, that field stays empty and the feature stays correctly hidden.
2. Confirm the first real `refresh.yml` run with the LLM path on: check for a
   real `smart_brief` narrative (not the `_fallback_brief` deterministic text)
   in `dashboard_data.json`, and real `theses` rows from the Analyst agent.
3. `data-pipeline.yml`'s `--agents` step should show `quality_triage` firing
   next time `quality.run()` raises issues.
4. Re-run `backtest.yml` periodically as more price history accumulates —
   `n_periods >= 12` is what's needed to clear the significance gate on the
   strongest signal (`opportunity_score`).
5. Decide on a paid Massive tier (Starter $29/mo, 5y) for more usable periods
   per horizon once growth stabilizes.

## Superseded (kept for context): the original proving-window plan
**Gate A PASSED against the real DB** (CI run `tierb-activate.yml` #1, 2026-07-06):
full export of **1,469,371 rows**, and all verify gates green — exact row count,
bidirectional set equality, AAPL's 240 net_income vintage rows identical, and
no-look-ahead confirmed on a real restatement. The store is **6.6 MB** of zstd
Parquet (vs 368 MB in Postgres — ~55×). Bundle uploaded as a 90-day artifact;
actions cache seeded (`tierb-v1-…`, the daily pipeline restores by prefix).
1. **Merge PR #1.** The next daily pipeline run restores the store from cache and
   begins the dual-write proving window: EDGAR dual-writes, step 2b reconciles,
   quality/validate/recalibration read DuckDB (`quality_report.json` shows
   `"metrics_engine": "tierb"`; score must stay 99/100 — Gate B).
2. After ~1 clean week (Gate C): cut over — flip `edgar.ingest_tickers` to
   Tier-B-only, archive `pg_dump -t fundamental_metrics`, **truncate** (not drop) the
   table in Postgres → DB drops ~370 MB. Rollback = restore dump or re-export.
   **The global universe expansion (ADR-014) un-gates itself at this moment**: the
   committed seed (~1,000 US by public float + 198 stocks across the top-10 markets
   of Europe/Asia/RoW) ingests in full on the next sweep; pre-cutover only its
   30-company validation batch runs.
3. Then the **critical path to a credible product**:
   - **Prices** — a license-clean EOD source (e.g. Tiingo) used *server-side only*, stored
     in Tier B; publish only derived metrics (P/E, returns), never raw prices. (We already
     have shares-outstanding from EDGAR — only price is missing for P/E & market cap.)
   - **Stock-level valuation** — apply the value/growth/GARP scoring to the 501 using
     fundamentals + prices.
   - **Backtest** — record stock predictions, grade vs realized returns, tune the model.
     This turns the rankings from "experimental" → validated. Recalibration trigger goes
     live once the first backtest exists.
   - **Surface bottom-up in the dashboard.**

## Backlog / parallel tracks
- **Non-US fundamentals** — agents already proposed license-clean leads (FRED, ECB,
  UK Companies House, EU ESEF, Canada SEDAR); turn the best into adapters.
- **Sector-aware bank revenue** — GS/TFC/SYF have no single `Revenues` line; compose from
  net interest income + noninterest income (the 1 legit remaining quality flag).
- Re-ingest the 1 failed company (FDXF). Close the quality→re-ingest loop.
- Promotion agent (semantic memory → curated-playbook PRs); `testable`-lesson re-verification.

## Handy commands
```bash
python -c "from engine import db; print(db.apply_migrations())"   # apply schema
python -m engine.datapipeline --agents            # full data pipeline + agents
python -m engine.quality                          # data-quality score
python -m engine.memory                           # memory stats / promotions
python -m engine.modelrouting                     # model reliability scorecard
python -m engine.sources.prices ingest --full     # full-history price backfill (Massive)
python -m engine.sources.corpactions ingest --full # full-history dividends + splits (Massive)
python -m engine.backtest run                     # walk-forward stock backtest
python -m engine.cli refresh --agent --model-upgrade  # valuation run + Analyst + Model-Upgrade
```
