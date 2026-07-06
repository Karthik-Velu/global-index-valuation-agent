# Decision log (ADRs)

Why we made each significant architectural choice — so a future session (or a future
you) can see the reasoning, not just the result, before reconsidering it.

**Convention:** append a new entry at the **top** when a non-trivial decision is made.
Keep each entry short: _Decision · Context · Choice · Why · Rejected alternatives · Date_.
Don't rewrite history — if a decision is reversed, add a *new* entry that supersedes it.

---

### ADR-012 · Two-tier storage: Postgres + Parquet/DuckDB (not a bigger DB)
- **Context:** DB hit 387 MB (95% in `fundamental_metrics`) at 501 stocks — near Supabase's
  500 MB free cap; 1,000 stocks + prices would overflow it.
- **Choice:** Keep the ~15 MB relational state in Supabase (free); move bulk time-series to
  **Parquet files queried by DuckDB** (local first, Cloudflare R2 later).
- **Why:** ≈$0 (R2 10 GB free, zero egress; Parquet compresses ~5–8× and drops index
  overhead) vs Supabase Pro **$25/mo**; DuckDB is also the *right* engine for the backtest's
  analytical scans. A bigger free Postgres (CockroachDB 10 GB, Xata 15 GB) only postpones the
  wall and costs a migration.
- **Rejected:** Supabase Pro ($25/mo); switching Postgres providers.
- 2026-06-27

### ADR-011 · Validate-before-scale for ingestion
- **Context:** About to ingest ~500 companies (~30–40 min, long feedback loop).
- **Choice:** Ingest a 30-company cross-sector batch first, verify end-to-end, then scale.
- **Why:** The batch exposed a critical mapping bug (Apple had no earnings) that would have
  corrupted all 500. Cheap insurance against expensive re-runs.
- 2026-06-27

### ADR-010 · Canonical XBRL concept map (`catalog._CANONICAL`)
- **Context:** Derived/ratio metrics listed raw XBRL concepts as computation inputs and, via
  first-wins `setdefault` in `xbrl_tag_map`, *stole* them from the real line items — leaving
  AAPL/MSFT/NVDA with no `net_income` and modern filers with no `total_revenue`.
- **Choice:** Pin core financial-statement line items to their concepts in `_CANONICAL`,
  winning over catalog order.
- **Why:** Core line items must be deterministic, not subject to catalog-ordering accidents.
- 2026-06-27

### ADR-009 · Rate-based data-quality scoring + scale-tuned checks
- **Context:** Absolute "−2 per warning" scoring drove any large dataset to 0/100; several
  checks false-positived at scale (negative revenue is real for insurers; earnings/CF/equity
  legitimately swing and flip sign).
- **Choice:** Score by weighted issues **per company**; run the units-error jump check only on
  stable never-negative line items (revenue, assets), both positive, >100×.
- **Why:** A quality score must be meaningful at any scale and flag only genuine problems.
- 2026-06-27

### ADR-008 · Providers: Ollama Cloud (tier-1) + Groq (fallback)
- **Choice:** `ollamacloud:gpt-oss:120b` as tier-1, `groq:llama-3.3-70b-versatile` as
  cross-provider fallback; local Ollama last.
- **Why:** Both have generous free tiers and work in CI (local Ollama can't). Two *independent*
  providers give real rate-limit resilience. Separate `ollamacloud:` scheme keeps local Ollama
  + local embeddings working too.
- 2026-06-27

### ADR-007 · 3-tier semantic memory (not a flat .md)
- **Context:** Learnings would grow unbounded, un-queryable, and un-decaying in an append-only file.
- **Choice:** episodic logs → semantic `lessons` (Postgres, pgvector, provenance/confidence/
  decay/point-in-time history) → curated `engine/context/*.md` promoted from it.
- **Why:** Nothing is lost; stale facts retire; retrieval is relevance-ranked; `belief_at()`
  reconstructs past knowledge for backtest integrity. User: "build what's right for the long term."
- 2026-06-27

### ADR-006 · Waterfall multi-provider LLM routing
- **Choice:** One entrypoint `llm.call(role,…)` with per-role ordered chains that fall through
  on rate-limit/error and degrade to deterministic text.
- **Why:** No lock-in; stays free; resilient. Model-specific reliability is *learned*
  (`model_scorecard`) and can reorder chains.
- 2026-06-27

### ADR-005 · Point-in-time fundamentals with restatement vintages
- **Choice:** `filed_date` in the `fundamental_metrics` primary key, so restatement vintages coexist.
- **Why:** Backtest integrity — score a past call against the data as it was *known then*, not
  as later restated.
- 2026-06-27

### ADR-004 · Cloud Postgres (Supabase) as single source of truth
- **Choice:** Move the source registry, valuation ledger, and tuner off local SQLite onto Postgres.
- **Why:** One durable, cloud-accessible store; enables CI + cloud/mobile sessions. Only transient
  caches stay local.
- 2026-06-27

### ADR-003 · Data licensing: redistribute only public-domain
- **Choice:** SEC EDGAR (public domain) is the fundamentals source; frame the stock universe as
  "large-cap US" (S&P 500 *membership* is S&P's IP). Yahoo is personal-use-only.
- **Why:** The product is meant to be public — only license-clean data can be redistributed.
- 2026-06-26

### ADR-002 · Jobs vs agents terminology
- **Choice:** "Jobs" = deterministic Python (frequent, free); "Agents" = LLM review that
  *improves the jobs* (infrequent, not in the hot path). Don't call a cron job an agent.
- **Why:** Precision; keeps the cost model and the architecture honest.
- 2026-06-27

### ADR-001 · "Growth" means fundamentals, not price momentum
- **Choice:** Growth = revenue/earnings growth (+ forward estimates); momentum is demoted to a
  minor confirmation signal in GARP.
- **Why:** The product ranks *business* growth vs valuation, not price trend. (User correction.)
- 2026-06-26
