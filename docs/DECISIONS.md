# Decision log (ADRs)

Why we made each significant architectural choice — so a future session (or a future
you) can see the reasoning, not just the result, before reconsidering it.

**Convention:** append a new entry at the **top** when a non-trivial decision is made.
Keep each entry short: _Decision · Context · Choice · Why · Rejected alternatives · Date_.
Don't rewrite history — if a decision is reversed, add a *new* entry that supersedes it.

---

### ADR-022 · Backtest rebalance cadence: weekly (`W-FRI`), not monthly — user-directed tradeoff
- **Context:** the backtest's significance gate needs `n_periods >= 12`; two real runs
  (2026-07-22, 2026-07-24) both had exactly 9 monthly periods, capped by the ~9-month
  usable window (`window_end = latest_price - 12mo` minus `window_start = earliest_price
  + 90d`, with `earliest_price` bounded by Massive's free-tier entitlement). User asked
  why we couldn't just backfill 2 more years to reach further back — confirmed in code
  (`engine/sources/prices.py:363-375`) that the `403 NOT_AUTHORIZED` floor is a ROLLING,
  server-side, plan-level entitlement check evaluated fresh per request against *today's*
  date, not a function of how far our own walk has gone — so re-requesting older dates
  today hits the identical 403 immediately. No workaround exists on the free tier; only
  a paid plan upgrade (Starter, $29/mo, 5y) changes the actual entitlement.
- **Choice:** presented the user with three real options (paid tier / finer rebalance
  cadence / keep waiting ~3mo for organic monthly accumulation — the window DOES grow
  over time since already-ingested history is durably stored in Tier B and doesn't roll
  off, only the *newly requestable* floor rolls). User chose finer cadence: switched
  `REBALANCE_FREQ` from `"MS"` (month-start) to `"W-FRI"` (weekly, Friday-anchored) —
  same ~9-month window now yields ~39 rebalance dates instead of 9, clearing the
  significance gate's `n_periods` threshold with real margin, at $0 and immediately.
- **The real tradeoff, made explicit in code and output, not just here:** weekly
  rebalances make forward-return windows overlap heavily between adjacent periods (a
  1m-forward return measured a week apart shares 3/4 of its window with the previous
  one), which makes the per-period IC series serially correlated — the existing t-stat/
  `significant` gate assumes independent samples and does NOT adjust for this. This
  isn't a NEW class of problem (the 3/6/12m horizons already overlapped at monthly
  cadence, per the module's pre-existing "known gaps" list) — it makes an existing,
  already-documented weakness quantitatively worse across all horizons in exchange for
  more data sooner. `result["significance_caveat"]` is now populated whenever cadence
  isn't `"MS"` and gets printed alongside any `significant=true` result, and `cadence`
  is persisted in `backtest_runs.metrics` — so this can't be silently misread as a
  rigorous result downstream.
- **Rejected:** the paid tier (real ongoing cost, needs the user's billing action —
  left as a documented option, not taken without being asked); doing nothing / waiting
  (correct but slow, ~3 months to reach n=12 organically); a proper Newey-West-adjusted
  effective-sample-size correction (would need scipy/statsmodels, a new dependency, and
  is real future work — flagged, not built, to keep this change scoped to what the user
  actually asked for).
- **Date:** 2026-07-25.

### ADR-021 · `fetch_news` reads headlines transiently — a narrower reading than ADR-003's redistribution rule
- **Context:** the Analyst agent's whitelisted `fetch_news` tool (ADR-020) needed
  a free, keyless headline source. ADR-003 (implicit throughout this codebase,
  restated in CLAUDE.md) says "redistribute only public-domain data" — written
  about what the **public dashboard serves** (Yahoo ETF holdings data, EDGAR
  filings). `fetch_news` is a different shape of use: Google News RSS headlines
  (title/url/timestamp/source) read into ONE LLM prompt per investigation, never
  rendered raw to a user, stored only inside `theses.evidence` (an internal
  research artifact a human can inspect, not a public API response).
- **Choice:** treat "an LLM transiently reads a few headlines to inform one
  sentence it writes" as materially different from "redistributing a dataset,"
  and build `fetch_news` on Google News RSS on that basis.
- **Why:** no existing precedent in this codebase rules on this specific
  question — ADR-003/ADR-017's "never republish raw bars" language is about bulk
  data the product re-serves, not an ephemeral research read. Recording this
  explicitly so it's a decision a future session can re-litigate on its own
  terms, not an implicit choice buried in `engine/agent/tools.py`.
- **Rejected:** GDELT's DOC API (name-checked in ARCHITECTURE.md's Pillar 6) —
  more complex query grammar and observed reliability issues; RSS needs zero
  registration and returns exactly the 4 fields `fetch_news` needs. Also
  rejected: skipping `fetch_news` / stubbing it to always return `[]` until this
  is settled — would leave the Analyst agent short one of its 5 mandated tools
  for no forcing reason.
- **Date:** 2026-07-23.

### ADR-020 · Analyst agent: a manual ReAct loop, not a tool-use API
- **Context:** building the Analyst agent (ARCHITECTURE.md Pillar 1 — a bounded
  ReAct loop, MAX_STEPS=4, over `query_ledger`/`get_market_detail`/
  `fill_growth_gap`/`fetch_news`/`write_thesis`). Checked `engine/llm.py::_call`
  for a function-calling / tool-use parameter to hang this off of: there isn't
  one, on EITHER provider path (Anthropic or the OpenAI-compatible branch
  covering Ollama/Groq/DeepSeek/GLM/OpenRouter) — `_call` sends only
  `model`/`max_tokens`/`messages`/optional `response_format`.
- **Choice:** a hand-rolled loop (`engine/agent/react.py`) — one `llm.call(...,
  json_mode=True)` per step, the tool menu described in the system prompt as
  text, the model replies with one JSON object `{"thought","tool","args"}`, the
  chosen tool executes and its result is appended to a scratchpad fed into the
  next step's prompt. `role="analyst"` for every step (both tool-selection and
  the final `write_thesis` step) — `chain_for()` maps any non-cheap/non-smart
  role to the single shared `MODEL_AGENT_CHAIN` anyway, so there's no real T1/T2
  split to route between; using `smart` (frontier) per-market up to 8×/week
  would blow past the stated <$0.05/week budget.
- **Why:** zero changes to `llm.py`, the one entrypoint every other agent in
  this codebase depends on and whose waterfall/cooldown/scorecard-logging
  behavior is load-bearing. Adding real tool-use support is a change to shared,
  proven infrastructure — worth doing only when an agent genuinely needs
  parallel/native tool calls, not preemptively for one caller.
- **Known limitation, accepted:** `TOKEN_BUDGET` (2200) is a cap on *requested*
  `max_tokens` summed across steps, not true consumption accounting — `llm.py`
  doesn't surface actual token usage today. Caller-side discipline, not real
  metering; stated here so it isn't mistaken for the latter later.
- **Rejected:** adding a `tools=` parameter to `_call`'s OpenAI-compat branch —
  real scope creep for this task, revisit if/when an agent needs it badly enough
  to justify touching shared plumbing.
- **Date:** 2026-07-23.

### ADR-019 · Model-Upgrade v1 is a `model_scorecard` threshold advisory, not full Pillar 5
- **Context:** ARCHITECTURE.md's Pillar 5 vision is a `models.yaml` provider
  registry + a golden-eval gate + an upgrade controller. None of that exists;
  building it is a new subsystem, not "finish the agent that's supposed to
  exist." What DOES already exist: `model_invocations`/`model_scorecard`
  (migration 0006), populated automatically by every single `llm.call()` since
  it shipped — exactly the input a threshold-based advisory needs, with zero
  new ingestion.
- **Choice:** `engine/modelupgrade.py` v1 — pure SQL/threshold analysis over
  `model_scorecard` (flag a configured-chain model for demotion below 70%
  success rate or >15% rate-limit-hit fraction; flag an out-of-chain model for
  promotion above 95% success with ≥20 attempts of evidence), writes advisory
  proposals to `taxonomy_changes` + `lessons`, optional one-line LLM narrative
  over the proposals (role="cheap"). **Never auto-mutates `config.py`/env** — a
  human hand-edits `MODEL_<ROLE>_CHAIN`.
- **Why:** delivers the actual value docs/AGENTS.md's table promises ("eval a
  candidate model vs champion; promote if better/cheaper") using data that's
  free and already flowing, without inventing a registry/eval-harness subsystem
  nothing else in the codebase needs yet.
- **Rejected:** blocking Model-Upgrade until full Pillar 5 lands — would leave
  it permanently unbuilt against the user's "all 5 agents" bar (CLAUDE.md,
  directive 2026-07-10). Revisit the full vision if/when the model roster
  outgrows manual `.env` chain edits.
- **Date:** 2026-07-23.

---

### ADR-018 · Corporate actions (dividends + splits) via Massive reference endpoints
- **Context:** stockvaluation.py shipped (ADR-016) with `dividend_yield` **hardcoded
  to 0.0 for every stock** — documented as a known gap ("no dividend data yet"),
  surfaced again by the 2026-07-22 hardcoding/dummy-data audit (user directive:
  "we do not want hardcoding or dummy data or dummy connections anywhere — we plan
  to go to production pretty soon"). ADR-017 already flagged Massive's
  `/v3/reference/dividends` and `/v3/reference/splits` as the planned end-state
  source for this.
- **Choice:** `engine/sources/corpactions.py` — both endpoints are TICKER-OPTIONAL
  and date-range filterable (`ex_dividend_date.gte/.lte`, `execution_date.gte/.lte`),
  so one paginated bulk query per type covers the WHOLE market for a window, the
  same one-call-covers-everything shape as prices.py's grouped-daily endpoint
  (not a per-ticker sweep). New Postgres tables `dividends`/`splits` (migration
  0009) — relational, low-volume (unlike prices/fundamentals), same tier as
  `filings`. `stockvaluation.py::_dividend_features` computes real trailing-12-month
  dividends-per-share ÷ price, point-in-time on `ex_dividend_date <= asof` (same
  no-look-ahead discipline as fundamentals/prices) — 0.0 now means "confirmed
  non-payer," not "no data source."
- **Splits are NOT re-applied to prices:** prices.py already fetches
  `adjusted=true` (split-adjusted) bars from the SAME provider, so the price
  series is already correctly rebased. The `splits` table is an audit trail
  (explains a rebasing event), not something downstream code derives prices from.
- **Self-healing migrations:** while building this, found NO CI step anywhere
  applies `engine/migrations/*.sql` automatically — each of the 8 prior migrations
  required someone to remember to run `db.apply_migrations()` by hand. Added it as
  step 0 of `datapipeline.py::run()` (idempotent, tracked in `schema_migrations`,
  a no-op most days) so a shipped migration can never again silently fail to
  reach production between sessions.
- **Rejected:** deriving a synthetic/estimated yield from EDGAR's
  `CommonStockDividendsPerShareDeclared` tag instead — real per-event dividend
  data (with ex-date) is strictly better for point-in-time correctness and EDGAR's
  tag isn't in the catalog yet either; would've been solving the same problem twice.
- **Date:** 2026-07-22.

### ADR-017 · Massive (ex-Polygon.io) replaces Stooq as the price source
- **Context:** ADR-016 chose Stooq (free, keyless). Empirically DEAD from CI
  (JOURNAL 2026-07-09): its per-ticker CSV API serves a JS anti-bot challenge and
  its bulk archive requires a CAPTCHA — both confirmed, neither circumventable
  legitimately. Meanwhile the user set the end-state directive (2026-07-10,
  CLAUDE.md): judge every source decision against the FULL agent build-out, not
  just today's batch needs.
- **Choice: Massive** (Polygon.io rebrand, 2025-10-30; `api.massive.com`, Bearer
  auth, env convention `MASSIVE_API_KEY`). Decisive factors, in order:
  1. **Grouped-daily endpoint** (`/v2/aggs/grouped/locale/us/market/stocks/{date}`):
     the whole US market in ONE call per trading day — the 5-req/min free tier
     yields 1 call/day operation and a ~105-min 2-year backfill. Ingestion becomes
     DATE-driven; a resumable cursor lives in `<store>/prices_meta.json` (advances
     past holidays, which a min(date) high-water mark never would).
  2. **End-state data**: same key/vendor later serves corp actions
     (`/v3/reference/splits`, `/v3/reference/dividends` → real dividend_yield),
     ticker news (Analyst agent), fundamentals-from-filings (a second source for
     the quality job's cross-source disagreement check), WebSockets (P4 alerts),
     and an **official MCP server** — a ready-made tool for the Quality-Triage and
     Analyst agents to query the source directly.
  3. Our whole universe is US-tickered by construction (EDGAR discovery requires
     it), so US-market coverage == full coverage, ETF proxies included (asserted
     at validation, not assumed — not verbatim-documented).
- **Tier economics:** free = 2y history/EOD (enough for a real 1m/3m-horizon
  backtest; thin at 12m) → Starter $29/mo (5y) is the cheapest meaningful upgrade,
  decided only after free-tier results are seen.
- **Licensing posture:** raw-data redistribution explicitly requires a business
  plan — we never republish raw bars (standing rule). The DERIVED-data clause of
  their market-data terms could not be machine-read (bot-walled PDF) —
  **flagged for human review before stock-level derived metrics go public.**
- **Rejected:** Tiingo (free tier's unique-symbols/month cap can't cover 2,983
  tickers; no bulk endpoint; no adjacent news/corp-actions/MCP for the agents);
  Snowflake Public Data (needs paid compute + terms restrict off-platform export;
  kept as a one-shot cross-validation idea); EODHD/Marketstack free tiers
  (20 calls/day / 100 calls/month — orders of magnitude short).
- 2026-07-14

### ADR-016 · Prices → stock valuation → walk-forward backtest (Pillar 2, Phase 2)
- **Context:** user direction 2026-07-08: "let's get to backtesting" — the critical
  path blocked on prices (no P/E, no forward returns) since Phase 1 completed.
- **Choice 1 — prices live in Tier B, never Postgres.** A second Parquet dataset
  alongside `fundamental_metrics`: `PRICE_KEY = (security_id, date)`, no restatement
  vintage (a trading day's print is final). `tierb.py`'s base/delta write helpers
  (`_write_base`/`_write_delta`/`_swap_in`) were generalized to take a dataset dir +
  partition expression (backward-compatible defaults) instead of duplicating ~150
  lines for a second dataset — the module's own docstring already anticipated this
  ("fundamental_metrics today, prices next").
- **Choice 2 — Stooq, not Yahoo/Tiingo/a paid source.** Free, keyless, and every
  security in our universe already trades under a US ticker (that's the precondition
  EDGAR auto-discovery imposed) — so Stooq's uniform `TICKER.US` daily-bars endpoint
  covers the whole universe with zero per-exchange logic. License is UNKNOWN/
  unverified for redistribution (same caveat the existing lightweight `stooq.py`
  probe adapter already carries) — acceptable because prices are SERVER-SIDE ONLY,
  same posture already used for Yahoo-sourced index-proxy holdings: never
  republished raw, only derived signals (P/E, returns, scores) leave the engine.
  Rejected: Tiingo/paid sources (breaks the $0 requirement at this stage); Yahoo
  (already ruled out — personal-use-only, and yfinance is explicitly the thing
  ARCHITECTURE.md's Phase 0 wants OFF).
- **Choice 3 — splits handled by delete+re-fetch, not perpetual full-store
  rewrites.** Daily incremental appends (anti-join, cheap, bounded) are the primary
  path. A stock split re-bases a source's ENTIRE historical series, which an
  anti-join append can't retroactively fix — so `tierb.delete_price_securities()`
  purges a ticker's history first, then a normal bounded append re-populates it
  (`prices.bulk_ingest(full=True)`, invoked on the same monthly-sweep cadence as the
  fundamentals full re-feed). Never holds the whole store in Python memory — same
  discipline as the EDGAR OOM fix (JOURNAL 2026-07-07).
- **Choice 4 — stock scoring REUSES `engine/metrics.py`, not a parallel
  implementation.** `stockvaluation.py` is a data-preparation layer only: pulls
  point-in-time fundamentals (`tierb.metrics_asof`) + prices, computes raw pe/pb/
  ps/pcf/growth/momentum inputs, then hands off to the SAME `metrics.compute()`
  that scores indices — one value/growth/GARP formula, shared. Peer group is
  sector (`kind` column) instead of country/style. Verified pandas'
  `Series.add(..., fill_value=0.0)` treats a single missing factor (e.g. no P/E for
  an unprofitable company) as neutral, not NaN-poisoning — the existing code
  already degrades gracefully at stock-level breadth, no changes needed.
- **Choice 5 — backtest evaluates historical point-in-time scores, not a live
  ledger.** Per ROADMAP.md's "Initial (historical, walk-forward, point-in-time)"
  spec: monthly rebalance dates, `stockvaluation.score_frame(t)` (no look-ahead —
  `metrics_asof(t)` + prices ≤ t), fixed-horizon (1/3/6/12m) forward returns via a
  bounded as-of price match, rank-IC + hit-rate + decile spread per signal, an
  IC-population guard (≥20 names) and a simple t-stat significance gate (|t|≥2,
  ≥12 periods). Verified end-to-end with an ENGINEERED synthetic relationship
  (growth → forward drift) — the harness recovered mean rank-IC 0.8–0.95 and
  correctly refused "significant" with too few periods despite huge t-stats.
  Known, documented gaps: no survivorship control (universe = current SEC filers
  only), no transaction costs, no benchmark-relative Sharpe — deferred, not solved.
  Live/continuous prediction-ledger grading (ROADMAP's "Continuous" backtest) is a
  separate, later follow-up — this ADR covers the initial historical harness only.
- **Rejected: DuckDB ASOF JOIN for point-in-time price lookups at scale.** Correct
  and idiomatic, but the per-rebalance-date Python loop calling `score_frame()`
  repeatedly is simpler to write correctly and fast enough at current universe
  size (dozens of rebalance dates × ~2,900 securities); revisit if the backtest
  window grows enough to make per-call overhead the bottleneck.
- 2026-07-08

---

### ADR-015 · Storage inversion + universe scale: Tier B primary, thin Postgres
- **Context:** User direction 2026-07-06: "much more than 1,200 companies", rethink
  the design so Postgres holds only dashboard-facing state. At scale (23M+ metric
  rows) Postgres could never follow anyway (~6 GB row-store vs ~150 MB Parquet).
- **Choice 1 — immediate cutover (user-approved destructive step).** Verify → bundle
  archive → truncate `fundamental_metrics`. Ingestion SELF-DETECTS the empty table
  and writes metrics Tier-B-only from then on — no config flag; the truncate is the
  switch. The ADR-014 expansion gate opens at the same moment.
- **Choice 2 — Postgres stays, but thin (~20–50 MB):** securities registry, filings,
  catalog/ledgers, quality issues, semantic memory (pgvector), user feedback (ACID +
  future RLS). Everything ANALYTICAL — fundamentals, prices, backtest panels — lives
  in Parquet/DuckDB. Rejected: dropping Postgres entirely (memory + feedback +
  multi-user need a transactional DB; it's free at this size).
- **Choice 3 — universe targets:** US top-2,500 by cross-checked public float;
  foreign via `discover-foreign` — ALL 20-F/40-F filers (the exact FPI definition,
  from EDGAR's form indexes), assets-ranked (us-gaap + ifrs-full instant frames),
  business-address country classification (Cayman-inc Chinese cos land in China),
  ≥$100M assets, capped 1,000/market. Availability is the real limiter: only
  Canada/China/Israel reach hundreds via SEC filings; most markets yield 10–60
  until native adapters (ESEF/EDINET/SEDAR) close the gaps. Non-target markets
  stay index-only.
- **Choice 4 — signal stays investable:** ETF proxies are the priority surface
  (universe expanded 94 → 132: global sectors, US industries, factor styles,
  regional). Constituent-built BASKETS come in Phase 2 only where no investable
  ETF exists for a segment the rankings surface — they need prices first.
- **Choice 5 — CI cadence:** daily incremental (~flat as universe grows); full
  sweep monthly (first Sunday) instead of weekly — a 3,000+ company sweep is
  multi-hour.
- 2026-07-06

### ADR-014 · Global stock universe: committed seed, EDGAR-first, gated expansion
- **Context:** Expand from 501 US large-caps to ~1,000 US + the top-10 markets of
  Europe, Asia, and the rest of the world. The old universe lived only in the DB
  (not reproducible); `country` was hard-coded; the catalog had zero IFRS tags, so
  20-F filers would ingest nothing; and daily full re-feeds would blow both the CI
  minutes budget and — during the dual-write window — the Supabase 500 MB cap.
- **Choice 1 — the universe is committed DATA** (`engine/sources/universe_stocks.json`):
  curated foreign stocks per market + a generated US list; the pipeline reconciles
  the DB to the file. Reproducible from a clone, reviewable in PRs.
- **Choice 2 — EDGAR-first foreign coverage.** Only SEC 20-F/40-F filers (public
  domain, ADR-003), with IFRS core concepts pinned in `catalog._CANONICAL`
  (`Revenue`, `ProfitLoss`, … → the same metric_codes, so quality/scoring work
  unchanged). Honest per-market gaps are documented in the seed (Saudi Arabia and
  Malaysia have no SEC filers; Germany/Sweden/HK thin) — the native-adapter track
  (ESEF, EDINET, SEDAR) closes them later.
- **Choice 3 — US top-N ranked by `dei:EntityPublicFloat`** via the XBRL frames API
  (`engine/universescan.py expand-us`): the SEC's own size measure, one request,
  no index-membership IP (ADR-003), no price feed needed.
- **Choice 4 — incremental daily ingestion.** Daily runs pull EDGAR's daily index
  and re-fetch only companies that actually filed (+ new seed tickers); Sundays do
  a full sweep. Keeps CI minutes flat as the universe grows ~2.5×.
- **Choice 5 — expansion is gated on the Tier B cutover.** While Postgres still
  dual-writes, only the ~30-company cross-region validation batch ingests
  (ADR-011); the remaining ~1,170 join automatically once `fundamental_metrics`
  is truncated — a full expansion pre-cutover would overflow the 500 MB free tier.
- **Rejected:** paid fundamentals vendors (licensing, cost); index membership
  lists (S&P/MSCI IP); building native adapters first (weeks of work before any
  coverage; EDGAR ADRs deliver the majors today).
- 2026-07-06

### ADR-013 · Tier B design: psycopg streaming, filings stay in Postgres, gated cutover
- **Context:** Implementing ADR-012 (`engine/tierb.py` + `engine/tierbsync.py`). Three
  sub-decisions shaped the build.
- **Choice 1 — Postgres reaches DuckDB via psycopg, not the DuckDB postgres extension.**
  Extensions are a runtime download that can fail in locked-down environments (it did,
  in the cloud dev session); psycopg is already a dependency, and at ~1.5M rows
  streaming into a DuckDB temp table is plenty fast. Incremental sync pulls only rows
  past the store's `ingested_at` high-water mark (cheap on Supabase free-tier egress);
  a primary-key anti-join keeps it exact regardless.
- **Choice 2 — only `fundamental_metrics` moves.** `filings` (31k rows, identity PK,
  FK + accession-conflict semantics) stays in Postgres as system of record and is
  mirrored read-only into Parquet. Cutover blast radius = exactly one table.
- **Choice 3 — activation is data-gated, not code-gated.** Every caller switches on
  `tierb.have_tierb()` (does the store exist?), so merging the code changes nothing
  until `python -m engine.tierbsync export` runs; from then on ingestion dual-writes
  and readers use DuckDB. Full export refuses to run if Postgres holds fewer rows than
  the store (the post-cutover state) — a rebuild then would destroy data. Postgres
  remains authoritative until an explicit cutover after `verify` gates + a dual-write
  proving window.
- **Layout:** hive-partitioned by `year(period_end)` + small `delta/` appends,
  zstd Parquet; restatement vintages stay distinct rows keyed by `filed_date` (same PK
  as migration 0003); the dedupe view = ON CONFLICT DO NOTHING. `metrics_asof()` is
  the no-look-ahead point-in-time API the backtest will use.
- **Rejected:** DuckDB postgres extension (runtime download); moving `filings` too
  (needless blast radius); steady-state dual-write (defeats the storage goal);
  committing Parquet to the repo (size/churn — CI uses actions/cache + weekly bundle
  artifact instead).
- 2026-07-06

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
