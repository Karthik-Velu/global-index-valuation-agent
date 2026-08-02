# Decision log (ADRs)

Why we made each significant architectural choice — so a future session (or a future
you) can see the reasoning, not just the result, before reconsidering it.

**Convention:** append a new entry at the **top** when a non-trivial decision is made.
Keep each entry short: _Decision · Context · Choice · Why · Rejected alternatives · Date_.
Don't rewrite history — if a decision is reversed, add a *new* entry that supersedes it.

---

### ADR-029 · A proposal must state what will CONSUME it; and scope is never widened silently
- **Context:** the first real approval, 2026-08-02. `capex_intensity` read *"propose for
  Industrial Materials: Capex Intensity"*. Its payload — a legacy backfilled row — carried
  no sector at all, so `_apply_catalog_kpi` defaulted `applies_to` to `"all"` and the KPI
  landed across **every sector**. The admin approved a sentence naming one sector and got a
  row covering all of them. Separately, asked "does this apply only to certain segments?",
  the console's chat answered "the record does not contain that" — truthfully, because the
  chat context omitted `payload`, the one field holding sector, XBRL tags and definition.
  Owner's verdict: *"right now i would mostly have to blindly take decision as there is not
  enough details in admin panel"*, and then the directive — *"along with definition - a
  'why' something is proposed and how it will be used going forward is clearly added for
  all proposals going forward."*
- **Choice, three parts:**
  1. **`how_used` as a first-class column** (migration 0014), not another key in `payload`.
     It is part of the fixed text a human reads, alongside `reason` and `expected_outcome`.
     All three proposing agents ask for it at source; `enrich()` fills it for legacy rows;
     it renders in the console, is sent to the chat, and is carried into the GitHub issue
     the Builder reads as its brief.
  2. **The console shows the WRITE, not the pitch.** A "Exactly what gets written" block
     renders the row approval will create, read off the same payload the apply step
     consumes. Where the prose names a sector the payload lacks, it says so in as many
     words.
  3. **Scope carries provenance.** Both apply paths recover a sector from the prose when the
     payload has none, record in `notes` that it was INFERRED rather than declared, and
     return which of declared/inferred/defaulted was used.
- **Why `"all"` needed to stop being a fallback:** it is a real decision — collect this for
  every company in the universe — that happened to be spelled the same way as "no data".
  Silent defaults are only safe when the default is inert, and this one isn't.
- **Why `needs_enrichment` gates approval rather than a check on the text:** approving an
  un-written-up proposal now asks for confirmation. The first implementation tested the
  prose with a length heuristic and let `"LLM sub-sector KPI proposal"` through at 27
  characters — waving past the exact proposal that caused this. `needs_enrichment` is set
  by the same completeness gate the engine uses, so the console and the engine cannot
  disagree about what "written up" means.
- **Rejected alternatives:** *fold how_used into `expected_outcome`* — they answer different
  questions ("what improves" vs "what reads it"), and merging them is how the second one
  gets dropped. *Block approval outright on an un-enriched proposal* — takes the decision
  away from the owner; a named confirmation preserves agency while making the gap
  impossible to miss. *Refuse to apply when scope is unknown* — would strand approvals on a
  data problem the admin can't fix from the console.
- **Follow-up left open:** `capex_intensity` is still `applies_to='all'`. Not obviously
  wrong — capex ÷ revenue is meaningful in every sector — but it was not knowingly chosen,
  so it is the owner's call to narrow, keep, or undo.
- **Date:** 2026-08-02

---

### ADR-028 · Proposals are decidable objects, deduped by DECISION not by wording; approved code goes through an English plan before any code exists
- **Context:** `docs/AGENTS.md` always promised that an agent's output is a *proposal* which
  a human turns into a deterministic rule. Only the first half was ever built. Agents
  appended free text to `taxonomy_changes` and **nothing read it back**, so the loop never
  closed. Measured on 2026-08-01: **166 proposals accumulated, zero were ever applied**;
  `capex_intensity` was proposed **15 times in 7 days**; Quality-Triage re-raised the same 4
  targets nightly; 281 sector-research lessons decayed and retired without being acted on.
  Nothing was broken — there was simply no way to say yes, no, or later.
- **Choice:** migration 0013 adds `proposals` (+ append-only `proposal_events`, a
  per-proposal chat thread, and `proposal_solutions` revisions), `engine/proposals.py` owns
  the lifecycle, a Supabase Edge Function actions decisions on click, `dashboard/admin.html`
  is the review console, and `engine/builder.py` turns approved *code* proposals into PRs.
- **Why dedup on `(kind, target)` and not on the proposal text:** the decision the admin
  makes is "do we add capex_intensity?" — identical however the model words its pitch. The
  real data settles it: `timeseries_jump` was raised **8 times in 8 distinct wordings**, and
  `capex_intensity` 15 times in 5. Hashing the text, even normalised, gives each of those
  its own row and faithfully reproduces the flood the queue exists to stop. It also makes
  "declined and not brought up again" actually hold — a rejected idea cannot return through
  a synonym. Backfill collapsed **166 rows → 61 real decisions**.
- **Why `declined` is terminal:** the user's requirement was "ones that i decline should be
  discarded and not brought up again." Against agents that re-propose nightly, that is only
  true if `capture()` refuses the dedup_key outright, so the block lives at the single write
  path rather than in a filter someone can forget to apply.
- **Why approving code does NOT mean the code is written:** no button can write and deploy
  Python. DATA kinds (`catalog_kpi`, `model_routing`) change the live system in-process;
  CODE kinds file a GitHub issue and hand off to the Builder. That split is surfaced in the
  UI with different button text and different wording, never flattened — "approved" quietly
  meaning two different things is precisely the class of silent lie this feature removes.
  A code proposal becomes `actioned` only when its **PR merges**, not when it was approved.
- **Why the Builder drafts English before code (owner decision, 2026-08-01):** the admin
  approves twice — once the proposal, once the solution plan. Reviewing intent is something
  a non-engineer can actually do; reviewing a diff is not. Feedback carries the admin's own
  words verbatim into the redraft, because paraphrasing is how a revision loop drifts.
- **Why search/replace edits, not whole-file rewrites:** a model asked to reproduce
  `engine/quality.py` in full will silently drop a check. A block that must match
  byte-for-byte either applies or fails loudly, and loudly is recoverable. Edits are
  **atomic** — all verified before any write — so a half-applied plan is unreachable.
- **Why a cheap Chinese coding model:** owner directive — "claude code would be costly,
  let's use some other cheaper chinese model that is good for coding." New `coder` role
  chain, Qwen3-Coder (Apache-2.0) first, degrading to $0 local Ollama.
- **Security note worth keeping:** the write-path allowlist originally checked the raw
  path string, so `engine/../.env` passed the prefix test *and* the containment test. The
  adversarial test caught it; `_safe_path` now normalises **before** checking. Ordering is
  the security property, not the allowlist itself.
- **Rejected alternatives:** *hash the normalised proposal text* — see above, reproduces the
  flood. *Let the browser write decisions straight to Postgres* — RLS gates rows but cannot
  express "may change status and nothing else" (no column-level policies), so actioning
  would be forgeable. *Auto-decline the single-mention backlog* — shortest queue, but
  `declined` is irreversible by design and a good one-off idea would be unrecoverable; the
  queue opens with all 61 visible, sorted by evidence, nothing auto-killed. *Builder pushes
  straight to a PR on approval* — faster, but makes the admin review code instead of intent.
  *GitHub's auto-merge* — GraphQL-only and silently unavailable on repos that haven't
  enabled it, so arming it would look like it worked and never fire; `poll()` merges on
  green instead, and treats "no checks configured" as NOT green.
- **Date:** 2026-08-01

---

### ADR-027 · "How to invest": issuer root-domain links + an LRS access route, never a broker or a guessed URL
- **Context:** user feedback (2026-07-31), and the sharpest of three UI gaps: *"there is no
  link to find the way to invest in the recommendations — which is most important, and for
  an Indian investor."* True — the dashboard ranked 132 markets and said nothing about how
  to act on any of them. The investability line (ADR-024) showed price/market-cap but was
  static text with no link anywhere in the app.
- **Choice:** new `engine/investing.py` emitting three things into `dashboard_data.json`:
  per-row `issuer` (display name + **root domain only**, `None` when unconfirmed), a single
  `meta.access_route` describing the India/LRS route, and `meta.issuer_coverage`. Rendered
  in the drawer as a "How to invest" block. New DISCLAIMER section covers it.
- **Why the three hard constraints:**
  1. **No fabricated URLs.** Issuer deep links are *not* derivable from a ticker — EWY's
     iShares page is `/products/239681/`, and nothing in "EWY" yields `239681`. Issuer
     sites also 403 automated lookups (verified: `ishares.com` returns 403 to WebFetch), so
     a generated deep link cannot be checked before shipping. Root domains always resolve;
     the ticker is displayed prominently so the user's own search is one step. Deep links
     are a follow-up needing an id-resolver run from an environment with issuer-site access.
  2. **No issuer guessing.** `_ISSUERS` covers the families we are sure of (113/132 = 85.6%);
     the other 19 render "issuer not attributed" rather than a plausible-looking guess.
     Wrong attribution is a factual error shown to someone making a money decision.
  3. **No broker recommendation.** We name the *mechanism* (LRS + any SEBI-registered
     platform offering US investing), never a provider — picking one is advice we are
     neither positioned nor licensed to give, and the user's own platform choice is theirs.
- **Rejected alternatives:** *INDmoney deep links* — closest to what was asked, but its MCP
  connector dropped mid-session and its URL scheme was unverifiable; shipping dead links is
  worse than shipping none (user chose this trade-off explicitly when asked). *Generic quote
  pages (Yahoo/Google Finance)* — a research page, not a buy path, so it doesn't answer the
  question. *Ticker-only with no link* — honest but thin.
- **Date:** 2026-07-31

---

### ADR-026 · Auth: Supabase magic-link (email OTP), client-side only, no server session
- **Context:** Phase D needs a real per-user identity for `user_watchlist` (migration
  0011, `auth.uid()`-scoped RLS) — the dashboard's existing feedback loop is anonymous
  (localStorage + an insert-only `feedback` table). The frontend is deliberately no-build
  (plain HTML/JS, `dashboard/app.js`) with no server to hold sessions.
- **Choice:** `dashboard/auth.js` wraps `supabase-js` (loaded from a CDN `<script>` tag,
  no bundler) and uses `signInWithOtp` (magic link — an email with a sign-in link, no
  password to choose, store, or leak). `engine/pipeline.py` embeds `SUPABASE_URL` /
  `SUPABASE_ANON_KEY` into `dashboard_data.json`'s `meta.supabase` (read from `.env` via
  `engine/config.py`) rather than hardcoding them into checked-in HTML, so an operator
  configures Supabase the same way as every other credential in this project.
- **Why:** the anon/publishable key is *designed* to be public (Supabase's own docs: it's
  an RLS-scoped client key, not a secret) — embedding it in a published JSON is no
  different from embedding it in HTML, and going through the JSON keeps `index.html`
  free of environment-specific values. Magic-link avoids building password reset/hashing
  entirely. Both `SUPABASE_URL`/`SUPABASE_ANON_KEY` empty is a valid, common state (no
  Supabase configured) — `Auth.init()` resolves `false` without throwing, and the whole
  sign-in/watchlist UI hides itself (`Auth.available()`), leaving the existing anonymous
  pin/dismiss flow as the only path — no regression for operators who don't set this up.
- **Rejected:** password auth (more surface: reset flows, breach risk, worse UX for a
  low-stakes hobby dashboard); a server-side session/cookie (would require standing up a
  backend this project doesn't have — the whole point of Tier A/B + a static frontend is
  no server to operate); OAuth-only (adds per-provider app registration for a feature
  meant to be optional and low-friction).
- **Date:** 2026-07-27.

### ADR-025 · Per-user watchlist: new `user_watchlist` table, not a retrofit of `feedback`
- **Context:** `docs/ARCHITECTURE.md`'s P3 roadmap calls out "fixing the localStorage
  dead-end" — pins made anonymously (via `feedback`, an insert-only signal log that
  drives `feedback_weights()` re-tuning) don't survive a cleared browser or follow a user
  across devices. `feedback` already has an unused `user_id text` column from Phase 1.
- **Choice:** migration 0011 adds a dedicated `user_watchlist(user_id uuid, market_key,
  note, created_at)` table with `auth.uid()`-scoped RLS (owner select/insert/delete, no
  UPDATE policy in v1, no anon policy at all) — the first table in this schema with real
  RLS policies rather than `rls_enabled` + zero policies.
- **Why:** `feedback` is an anonymous, insert-only, append-mostly event log (a market can
  be pinned by nobody, one person, or logged repeatedly — it's a signal stream, not a
  membership set) feeding a re-tuning function; a per-user watchlist is a real
  upsert/delete membership relation with a different lifecycle, different access pattern
  (RLS-scoped reads), and a different consumer (the signed-in user's own UI, not
  `feedback_weights()`). Overloading `feedback.user_id` would mean teaching that
  re-tuning function to distinguish "signal" rows from "membership" rows — more coupling
  for no real code reuse, since almost nothing about the query shape is shared.
- **Rejected:** reusing/populating `feedback.user_id` (conflates two different access
  patterns and consumers, see above); storing the watchlist as a JSON blob on a `users`
  profile table (loses row-level RLS granularity and natural-key `on conflict` semantics
  for pin/unpin idempotency).
- **Date:** 2026-07-27 (migration written earlier in this session; entry added now
  alongside the rest of Phase D so the decision record isn't split across sessions).

### ADR-024 · Investability panel: surface price/market_cap in Phase C's stock breakdown
- **Context:** Phase C's bottom-up stock breakdown (`stockvaluation.market_breakdown()`,
  rendered in the dashboard drawer) showed only ratios and scores (P/E, opportunity
  score, GARP flag) — genuinely useful for *ranking* stocks but silent on the more basic
  question a user actually has after seeing a top pick: "can I buy this, and roughly what
  does it cost?" Every other figure in the product (P/E, dividend yield %, growth %) is
  dimensionless by design (index-level scores are cross-sectional ratios) — price and
  market cap are the *only* genuinely currency-denominated numbers anywhere in the
  product, and they weren't being surfaced at all.
- **Choice:** `market_breakdown()` now includes `price`, `market_cap`, `currency`, and
  `country` per stock (sourced from `stockvaluation.score_frame()`'s existing
  `price`/`market_cap` columns and `_universe()`'s now-selected `currency`/`country`).
  The dashboard renders these as a compact line under each stock ("investability"),
  including a "US-listed" note, since every tracked security requires a US ticker (see
  `universescan.py`) regardless of the underlying company's domicile.
- **Why:** cheap to add (the columns were already computed by `score_frame()` for the P/E
  calc, just not passed through to the output dict) and directly answers a question the
  scores alone can't: two stocks with the same opportunity score can be a $50 and a
  $50,000 share price, or a $2B and a $2T company — context that changes what "investable"
  means for a given user, without pretending to be a broker integration.
- **Rejected:** a separate API call for price lookups on demand (adds latency + a second
  round-trip for something already computed in the same DataFrame); leaving price/market
  cap out entirely and only linking out to an external quote page (adds a dependency on a
  third party we don't control and can't degrade gracefully with).
- **Date:** 2026-07-27.

### ADR-023 · Display-currency conversion: client-side only, Frankfurter reference rates
- **Context:** ADR-024 surfaces USD-native price/market_cap in the dashboard. The
  project's user base (and the "global" in the product name) isn't US-only, so a raw
  USD-only number is less readable for a non-US user trying to build intuition for scale.
  But every SCORE the product computes is deliberately USD/dimensionless — there was a
  real risk of over-engineering a full multi-currency fundamentals pipeline (re-deriving
  `pe`/`pb`/etc. per currency) for what is, on inspection, a pure display convenience.
- **Choice:** `engine/sources/fx.py` is a new adapter pulling daily USD-base reference
  rates from Frankfurter (ECB rates, free, keyless — no new API key to manage, consistent
  with preferring free/public sources). Rates land in a new small Postgres table
  (`fx_rates`, migration 0012) via `engine.datapipeline`'s daily run; `engine/pipeline.py`
  reads the latest snapshot back and embeds it in `dashboard_data.json`'s `meta.fx`. The
  dashboard (`app.js`) does the actual multiplication client-side (`convertUSD()`) purely
  for display — it never touches `value_score`/`growth_score`/any ratio, and the DB never
  stores a re-derived non-USD fundamentals row.
- **Why:** keeps the currency-conversion surface area to exactly the two fields that are
  actually currency-denominated (ADR-024), instead of retrofitting currency-awareness
  into `stockvaluation.py`'s ratio math where it isn't needed. Frankfurter needs no key
  and has a generous free tier, matching every other data source's "$0, deterministic
  fallback if unavailable" bar — if the fetch fails, the dashboard just stays USD-only
  (`meta.fx` is `null`), same degrade-gracefully contract as `stock_breakdown`.
- **Rejected:** normalizing `fundamentals.currency` end-to-end so P/E etc. could be
  computed and stored in multiple currencies (real work with no real payoff — the ratios
  are dimensionless already, converting them would be a no-op multiplied by 1); a paid
  FX API (no need — reference-rate accuracy, not real-time execution pricing, is exactly
  what this use case calls for, and the DISCLAIMER.md addition makes that explicit to
  users); computing conversion server-side and shipping N pre-converted payloads (wasteful
  — one small rates table lets the client convert any figure to any offered currency on
  the fly, and currency switches don't need a network round-trip).
- **Date:** 2026-07-27.

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
