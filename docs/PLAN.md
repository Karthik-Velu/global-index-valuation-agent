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
- 🔜 **Tier B activation** — ✅ Gate A PASSED in CI 2026-07-06 (1,469,371 rows exported,
  all verify gates green, store = 6.6 MB zstd Parquet vs 368 MB in Postgres; cache +
  artifact seeded). Remaining: merge PR #1 → ~1-week dual-write window (Gates B/C) →
  cut over (EDGAR Tier-B-only + truncate `fundamental_metrics`)  *(next task)*
- ⬜ **Prices** — license-clean EOD source (e.g. Tiingo), server-side only, stored in Tier B;
  publish only derived metrics (P/E, returns)
- ⬜ **Stock-level valuation** — apply value/growth/GARP scoring to the 501 (needs prices)
- ⬜ **Backtest** — record stock predictions → grade vs realized returns → tune the model
  *(turns rankings from "experimental" → validated)*
- ⬜ Activate the **recalibration** trigger (goes live once the first backtest exists)
- ⬜ **Surface bottom-up** in the dashboard (which stocks within a cheap/growing market)

## Parallel tracks (don't block the critical path)  ⬜
- 🔜 **Global universe expansion (ADR-014)** — committed seed built: ~1,000 US (by
  public float, `universescan expand-us`) + 198 curated SEC-filer stocks across the
  top-10 markets of Europe/Asia/rest-of-world; IFRS core concepts mapped; incremental
  daily ingestion (EDGAR daily index) + Sunday full sweep. **30-company validation
  batch ingests now; the rest auto-joins after the Tier B cutover** (Supabase cap).
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
