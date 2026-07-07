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
- ⬜ **Prices** — license-clean EOD source (e.g. Tiingo), server-side only, stored in Tier B;
  publish only derived metrics (P/E, returns)
- ⬜ **Stock-level valuation** — apply value/growth/GARP scoring to the 501 (needs prices)
- ⬜ **Backtest** — record stock predictions → grade vs realized returns → tune the model
  *(turns rankings from "experimental" → validated)*
- ⬜ Activate the **recalibration** trigger (goes live once the first backtest exists)
- ⬜ **Surface bottom-up** in the dashboard (which stocks within a cheap/growing market)

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
