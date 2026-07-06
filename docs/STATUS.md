# Project status & handoff

> Snapshot of where the build is, so work can resume cleanly — **including from a fresh
> cloud/mobile session** that has none of the prior chat context. Pairs with
> [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [AGENTS.md](AGENTS.md),
> [MODEL_ROUTING.md](MODEL_ROUTING.md), [MEMORY.md](MEMORY.md), [DATA_INGESTION.md](DATA_INGESTION.md).
>
> Last updated: 2026-07-06.

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

## Immediate next step: merge PR #1, then watch the proving window (2026-07-06)
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
```
