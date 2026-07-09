# Project status & handoff

> Snapshot of where the build is, so work can resume cleanly — **including from a fresh
> cloud/mobile session** that has none of the prior chat context. Pairs with
> [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [AGENTS.md](AGENTS.md),
> [MODEL_ROUTING.md](MODEL_ROUTING.md), [MEMORY.md](MEMORY.md), [DATA_INGESTION.md](DATA_INGESTION.md).
>
> Last updated: 2026-07-08.

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
data pipeline (`engine.datapipeline`, daily, `--agents` in CI). Agents (LLM, infrequent):
source-discovery, sector-KPI research — they *improve* jobs. See [AGENTS.md](AGENTS.md).

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

## Current state: prices BLOCKED on source choice; valuation + backtest BUILT (2026-07-09)
- **Prices — Stooq is bot-walled from CI (2026-07-09 finding).** `price-validate.yml`
  (30 known-good tickers) got an identical anti-bot JavaScript-challenge page back
  for all 30 requests (HTTP 200, "verify your browser") — confirmed via
  `PRICES_DEBUG=1`, not a URL/parsing bug. This blocks Stooq's per-ticker CSV
  endpoint from GitHub Actions' IPs entirely; not something to route around.
  **Needs a source decision from the user** (a keyed free-tier source like Tiingo —
  the pre-blessed fallback — vs. another keyless option) before backfill can proceed.
  `engine/tierb.py`'s prices dataset and `engine/sources/prices.py`'s ingestion
  logic (incremental/full/split-safe refresh) are source-agnostic at the storage
  layer — only `fetch_ticker_prices()`'s HTTP call needs to change for a new source.
- **Stock-level valuation:** `engine/stockvaluation.py` — point-in-time pe/pb/ps/
  pcf/growth/momentum per security, reusing `engine.metrics.compute()` (the SAME
  scoring formula as the index product), peer-grouped by sector. Built + merged.
- **Backtest:** `engine/backtest.py` — monthly walk-forward, no look-ahead,
  fixed-horizon rank-IC/hit-rate/significance, persists to `backtest_runs`.
  Verified end-to-end against an engineered synthetic signal (recovered mean
  rank-IC 0.8–0.95). Built + merged. Needs real price history to run for real.
- All new code is synthetic-data tested (point-in-time correctness, split
  handling, negative-earnings guard, cross-sectional ranking, signal recovery)
  and merged to main (PR #8) — safe/inert without prices (gated on `tierb.enabled()`).

## Immediate next step
1. **User decision needed:** price source — Tiingo (free tier, needs an API key
   the user provisions) vs. another keyless alternative.
2. Swap `fetch_ticker_prices()` to the chosen source; re-run `price-validate.yml`.
3. Fire `price-backfill.yml` (full-universe daily history, multi-hour) once validated.
4. Fire `backtest.yml` → the first REAL backtest result.
5. Surface bottom-up (which stocks within a cheap/growing market) in the dashboard.

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
python -m engine.sources.prices ingest --full     # full-history price backfill (Stooq)
python -m engine.backtest run                     # walk-forward stock backtest
```
