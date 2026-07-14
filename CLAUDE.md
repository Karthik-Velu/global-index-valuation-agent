# Global Index Valuation Agent — session orientation

**This file auto-loads at the start of every Claude Code session (local or cloud).**
It exists so a fresh session — with none of the prior chat — starts fully oriented.

➡️ **First, read [`docs/STATUS.md`](docs/STATUS.md)** for current state + the next step.
Accumulated *learnings* live in the cloud Postgres `lessons` table (run
`python -m engine.memory`) — they travel with the DB, not with any chat.

## What this is
A cost-effective research agent that ranks world equity **markets** — and (Phase 2) the
**stocks** within them — by *value* and *fundamental growth*, surfaces the few calls that
matter, and grades its own past calls against realized returns. Delivered as an
interactive dashboard on Vercel, not a report.

## Hard requirements (from the user — do not regress)
- **"Growth" ALWAYS means FUNDAMENTALS** — revenue/earnings growth + forward estimates —
  **never** price momentum.
- **Runs for ~$0 / cost-optimized:** deterministic code does all non-intelligent work;
  LLMs only see aggregated data, through a waterfall of free/cheap models; deterministic
  fallbacks mean it works with no API key.
- **Two feedback loops:** user (pin/dismiss/rate) + market (grade predictions vs returns).
- **The product is DONE only when all the agents are built** (user directive 2026-07-10):
  Analyst, Quality-Triage, Source-Discovery, Sector-KPI, Model-Upgrade — see
  `docs/AGENTS.md`. Evaluate every architecture/source decision against that END
  STATE (agents querying sources, MCP tooling, news/corp-actions data), not just
  against what runs today.
- **Phased:** Phase 1 = index level (done). Phase 2 = bottom-up stock level: prices +
  valuation + backtest harness are BUILT (ADR-016), pending real-network validation.
- **Data integrity is foundational** — especially for the backtest. Validate before scaling.

## Terminology (precise — the user cares)
- **Jobs** = deterministic Python, no LLM; frequent, ~free.
- **Agents** = LLM-powered review that *improves the jobs*; infrequent, never in the hot path.
  Do **not** call a plain cron job an "agent."

## Architecture (one-liners; deep dives in `docs/`)
- **Data** — Tier A: Supabase **Postgres** (relational state, source of truth). Tier B:
  **Parquet + DuckDB** for bulk time-series (`engine/tierb.py`; dormant until
  `engine.tierbsync export` initializes the store). Stock fundamentals via SEC
  **EDGAR** (public domain), point-in-time with restatement vintages. Core XBRL concepts
  are pinned in `catalog._CANONICAL`. → `docs/DATA_INGESTION.md`
- **LLM** — one entrypoint `engine/llm.py::call(role, …)`: a per-role **waterfall** across
  providers (Ollama Cloud → Groq → … → local), falls through on rate-limit/error, degrades
  to deterministic text. → `docs/MODEL_ROUTING.md`
- **Memory** — 3-tier: episodic logs → semantic `lessons` (Postgres, pgvector, provenance/
  decay/point-in-time) → curated `engine/context/*.md`. → `docs/MEMORY.md`
- Jobs vs agents → `docs/AGENTS.md` · roadmap → `docs/ROADMAP.md` · target design → `docs/ARCHITECTURE.md`

## Current state (2026-07-08)
Phase 1 **COMPLETE**: Tier B (Parquet/DuckDB) is the sole metric store (3.5M rows,
21 MB), universe scaled to 2,983 companies / 29 markets, Postgres a thin 29 MB
dashboard layer. Phase 2: prices (`engine/sources/prices.py`, Stooq), stock-level
valuation (`engine/stockvaluation.py`, reuses `engine.metrics.compute()`), and the
walk-forward backtest (`engine/backtest.py`) are BUILT and synthetic-tested (ADR-016)
— **not yet run against real market data**, since the dev sandbox has no outbound
network. `price-validate.yml` (30 tickers) must confirm the Stooq adapter works
before `price-backfill.yml` (full universe) and `backtest.yml` fire. Details in
`docs/STATUS.md`.

## Living context — keep these growing
This project's memory is deliberately durable, in layers. **Maintain them as you work:**
- **`docs/PLAN.md`** — the done-vs-pending checklist. Check items off as they land; it's the
  source of truth for "where are we."
- **`docs/JOURNAL.md`** — at the end of a work session, prepend a dated entry (what you
  built, what you learned, what's still open).
- **`docs/DECISIONS.md`** — when you make a non-trivial architectural choice, prepend an
  ADR (decision · context · why · rejected alternatives).
- **`docs/STATUS.md`** — keep the "current state / next step" section current.
- **Semantic memory** (Postgres `lessons`) — agents capture learnings automatically; the
  pipeline consolidates them. Durable knowledge gets promoted into `engine/context/*.md`.
- **Commit messages** — write the "why," not just the "what"; `git log` is a decision trail.

Nothing important should live only in a chat — push it into these so it survives a new session.

## Guardrails / conventions
- **Secrets never in the repo.** `.env` is gitignored. Env vars a session needs:
  `DATABASE_URL`, `OLLAMA_API_KEY`, `GROQ_API_KEY`, `SEC_USER_AGENT`.
- **Merging:** once a Claude PR is green (tests + verify gates pass), merge it without
  waiting for manual approval — standing user instruction, 2026-07-06. Destructive
  data operations (e.g. truncating `fundamental_metrics` at cutover) still need an
  explicit go-ahead.
- **Licensing matters:** we redistribute only public-domain data (EDGAR). Yahoo is
  personal-use-only. Prefer public-domain / redistribution-OK sources.
- Keep the deterministic path free and the LLM path optional; match existing code style.
- **Commit messages carry the "why"** — `git log` is a decision log; read recent commits.

## Handy commands
```bash
python -c "from engine import db; print(db.apply_migrations())"  # apply schema
python -m engine.datapipeline --agents   # data pipeline + agents (now includes prices)
python -m engine.quality                 # data-quality score
python -m engine.memory                  # semantic-memory stats / promotions
python -m engine.sources.prices ingest --full   # full-history price backfill (Stooq)
python -m engine.backtest run            # walk-forward stock backtest
```
