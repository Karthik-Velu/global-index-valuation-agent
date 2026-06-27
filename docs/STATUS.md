# Project status & handoff

> Snapshot of where the build is, so work can resume cleanly. Pairs with
> [ROADMAP.md](ROADMAP.md) (plan), [ARCHITECTURE.md](ARCHITECTURE.md) (target design),
> [AGENTS.md](AGENTS.md) (jobs vs agents), [DATA_INGESTION.md](DATA_INGESTION.md).

## Live / working now

**Product (Phase 1, index level)**
- Public dashboard: <https://global-index-valuation-agent.vercel.app> (static snapshot on
  Vercel, free). ~90 indices ranked by value + fundamental growth + GARP.
- Repo (private): <https://github.com/Karthik-Velu/global-index-valuation-agent> (MIT).

**Data foundation (Phase 1, the current focus)**
- **Cloud DB (Tier A):** Supabase **Postgres** (project `global-index-valuation-agent`,
  ap-northeast-1 pooler). Schema in `engine/migrations/0001..0005`. It is the **single
  source of truth** — the source registry, valuation ledger, and tuner were moved off
  local SQLite onto Postgres. Only transient caches (snapshots, holding_growth) stay local.
- **Stock-level fundamentals (EDGAR):** `engine/sources/edgar.py` ingests SEC companyfacts
  XBRL → universal + sector-specific metrics, **point-in-time with restatement vintages**,
  into `fundamental_metrics` + `filings`. Driven by a **110-KPI sector catalog**
  (`engine/sources/metric_catalog.json`, 57 XBRL-mapped). **4 test companies ingested**
  (AAPL/JPM/ACN/CAT); **S&P 500 not yet ingested**.
- **Tier B (R2/Parquet for bulk prices): NOT set up** (needs a Cloudflare R2 account).
  No price time-series yet.

**Jobs (deterministic — no LLM)**
- **Valuation / scoring** — `engine.cli refresh` — weekly (`refresh.yml`).
- **Data pipeline** — `engine.datapipeline` — daily (`data-pipeline.yml`). One sequenced
  job: probe sources → ingest (EDGAR) → tag (SIC) → validate+auto-fix catalog →
  data-quality → recalibration. Validation runs right after ingestion.

**Agents (LLM — now activatable)**
- Provider-agnostic router (`engine/llm.py`): `scheme:model` → Ollama / OpenRouter / Groq /
  DeepSeek / GLM / Anthropic. JSON mode for reliable output.
- **Activated locally**: Ollama is running on the dev Mac; `.env` points `MODEL_*` at
  `ollama:llama3.2` → agents run live at **$0**. llama3.2 (3B) is weak; **qwen2.5
  recommended** (`ollama pull qwen2.5`).
- Wired into the pipeline behind `--agents` (off by default; agents improve the jobs,
  they don't run in the hot path). Hooks: source-discovery (`dataagent/discover.py`),
  sector-KPI research (`sectoragent/research.py`).

**CI**
- GitHub secrets set: `DATABASE_URL`, `SEC_USER_AGENT`. Workflows: `data-pipeline.yml`
  (daily), `refresh.yml` (weekly). They now run in the cloud once triggered.

## The five "things" (terminology: jobs vs agents)
1. Valuation/scoring (job) · 2. Data pipeline (job) — which includes source-probe,
EDGAR ingestion, sector tagging, catalog validation, data-quality, recalibration.
The LLM **agents** (source-discovery, sector-KPI research, + future analyst/strategist/
quality-triage/model-upgrade) are separate and infrequent — see [AGENTS.md](AGENTS.md).

## Immediate next step (decision pending)
**Ingest the S&P 500 with agents running.** Open question: pull `qwen2.5` first (better
agent quality, ~4.7GB, $0) vs run now on `llama3.2`. Then: non-US fundamentals
(EDINET/SimFin), Tier B (R2/prices), and Phase 2 (backtest).

## Backlog / not done
- S&P 500 (and broader) fundamentals ingestion at scale.
- Non-US fundamentals: EDINET (Japan), filings.xbrl.org (EU/UK), SimFin (needs free key).
- Tier B: Cloudflare R2 + Parquet/DuckDB for prices (needs R2 account; card on file).
- Wire data-quality issues → auto re-ingestion (feedback loop closure).
- Pull qwen2.5; later add a bigger/frontier model for hard research (monthly).
- Phase 2: backtest + validated ranking model (needs prices + stock-level history).
- Backward-recalibration trigger goes live once the first backtest exists.

## Keys / config notes
- `.env` (gitignored) holds: `DATABASE_URL` (Supabase pooler), `MODEL_CHEAP/SMART/AGENT`
  (= `ollama:llama3.2`), `SUPABASE_*`. `ANTHROPIC_API_KEY`, `SIMFIN_API_KEY`, `R2_*` unset.
- Run a migration-aware DB op: `python -c "from engine import db; db.apply_migrations()"`.
