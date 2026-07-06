# Work journal

A running log of what happened each work session — the narrative that git history and
the decision log don't fully capture. Newest entry on top.

**Convention:** at the end of a session, prepend a dated entry: what was built, what was
learned, what's still open. Keep it to what a future session would want to know.

---

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
