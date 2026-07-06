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
- **Phased:** Phase 1 = index level (done). Phase 2 = bottom-up stock level (in progress).
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

## Current state (2026-07-06)
Phase 1 data foundation **COMPLETE**: 501 large-caps ingested (1.45M point-in-time metric
rows, data-quality 99/100). Ollama Cloud + Groq keyed and in CI. Tier B (Parquet/DuckDB)
is **built but dormant** — activate with `python -m engine.tierbsync export` + `verify`
(needs `DATABASE_URL`). **Next: activate Tier B → prices → stock-level valuation →
backtest.** Details in `docs/STATUS.md`.

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
- **Licensing matters:** we redistribute only public-domain data (EDGAR). Yahoo is
  personal-use-only. Prefer public-domain / redistribution-OK sources.
- Keep the deterministic path free and the LLM path optional; match existing code style.
- **Commit messages carry the "why"** — `git log` is a decision log; read recent commits.

## Handy commands
```bash
python -c "from engine import db; print(db.apply_migrations())"  # apply schema
python -m engine.datapipeline --agents   # data pipeline + agents
python -m engine.quality                 # data-quality score
python -m engine.memory                  # semantic-memory stats / promotions
```
