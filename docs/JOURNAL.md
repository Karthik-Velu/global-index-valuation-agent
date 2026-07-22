# Work journal

A running log of what happened each work session — the narrative that git history and
the decision log don't fully capture. Newest entry on top.

**Convention:** at the end of a session, prepend a dated entry: what was built, what was
learned, what's still open. Keep it to what a future session would want to know.

---

## 2026-07-22 (later) — Phase A hardening: growth_score confirmed, corp actions shipped, production audit

Picked up "Phase A" (from the roadmap discussion after the first real backtest)
plus an explicit user directive: a thorough hardcoding/dummy-data/dummy-connection
audit ahead of an imminent production launch.

**growth_score anomaly resolved with real numbers.** The earlier backtest run only
persisted the aggregate summary; re-ran `backtest.yml` after teaching
`backtest.py::_persist` to also store per-period detail (`backtest_runs` id=2), then
pulled the 6m growth_score series directly from Postgres. Confirmed: `hit_rate` is
**0% in all 9/9 periods** (not a coarse-statistic artifact as first hypothesized —
top-quartile-by-growth-score names' mean forward return trailed the bottom
quartile's every single time, by up to -29pp in Apr/May 2025), while `rank_ic` (the
full ~2,700-name Spearman correlation) is mildly positive Nov'24–Mar'25 then flips
negative Apr–Jul'25. Two live hypotheses, not distinguished yet: a real growth-trap
effect in this regime, or the documented latest-FY-only (not TTM) fundamentals
caveat. Needs more history/regimes, not chased further with 9 periods.

**Production-readiness audit** (two parallel sub-agents: backend data/sources,
dashboard/CI/config) surfaced real issues, now fixed:
- Dead Stooq adapter was still registered in `adapters.py` and probed daily by the
  ingestion agent, a year after Massive replaced it (ADR-017) — removed + deleted
  the module.
- `SEC_USER_AGENT` silently fell back to a hardcoded placeholder at 3 call sites
  (`edgar.py`, `universescan.py`, `sectoragent/tagging.py`) when unset — exactly
  what SEC's fair-use policy exists to catch. Added `config.sec_user_agent()`,
  raising loudly at call time (found a 4th call site — `sectoragent/tagging.py` —
  only because the local scratch test suite caught the resulting ImportError after
  the first pass; a reminder that "grep for the pattern" isn't the same as
  "run the tests").
- `probe.py`'s quality scorer gave a source that returned zero records (no error)
  hardcoded 60/70 completeness/sanity subscores instead of reflecting the empty
  response — a fully broken adapter scored ~43/100 ("middling") instead of near-
  zero, on the exact score that drives active-adapter selection. Fixed to
  short-circuit to 0 on an empty-but-no-error response.
- 5 one-shot migration/repair CI workflows (cutover, retruncate, activate,
  universe-backfill, universe-validate) all completed their job but still carried
  a `push:` trigger scoped to their own file — any future incidental edit would
  silently re-fire a destructive job (TRUNCATE, full-universe regen). Dropped to
  `workflow_dispatch` only (`price-backfill.yml`/`backtest.yml` keep their push
  trigger — still the only way this session's GitHub integration, no
  `actions:write`, can fire them).
- README/DISCLAIMER/dashboard footer's "no backtest yet" language was true when
  written, false now — updated to the accurate (still honest: not yet
  significant) status.
- `.env.example` didn't document `SEC_USER_AGENT`/`MASSIVE_API_KEY` (both actually
  required) and listed `SUPABASE_URL`/`ANON_KEY`/`SERVICE_ROLE_KEY`/`R2_*`, none of
  which any code in the repo reads — cleaned up.
- Stale "(Stooq)" references in CLAUDE.md (the always-loaded orientation file) and
  3 docs files.
- Still open, not code fixes I can make myself: rotate `OLLAMA_API_KEY`/
  `GROQ_API_KEY` (pasted into chat during initial setup, more pressing now the
  repo is public), and a minor disclosure-marker inconsistency in
  `llm.py::_fallback_tag` vs `_fallback_brief` (rated worth-fixing-not-urgent by
  the audit; deferred in favor of Phase A).

**Corporate actions ingestion shipped (ADR-018)** — the other half of Phase A, and
itself a real hardcoding fix: `stockvaluation.py` shipped with `dividend_yield`
**hardcoded to 0.0 for every single stock**, documented as a known gap. Built
`engine/sources/corpactions.py`: Massive's `/v3/reference/dividends` and
`/v3/reference/splits` are both ticker-optional and date-range filterable
(`.gte`/`.lte` suffixes), so one paginated bulk query per type pulls every
dividend/split across the whole market for a window — same one-call-covers-
everything shape as `prices.py`'s grouped-daily endpoint, not a per-ticker sweep.
New Postgres `dividends`/`splits` tables (migration 0009 — relational, low-volume,
same tier as `filings`, not Tier B). `stockvaluation.py::_dividend_features` now
computes real trailing-12-month dividends-per-share ÷ price, point-in-time
(`ex_dividend_date <= asof`, same no-look-ahead discipline as fundamentals/prices).
Splits are NOT re-applied to prices — `prices.py` already fetches split-adjusted
bars from the same provider, so the `splits` table is an audit trail, not a
derivation source. Wired into the daily pipeline (step 2d) + a new
`corpactions-backfill.yml` for one-time ~2y history (not yet fired this session).

**Side effect: migrations are now self-healing.** While wiring migration 0009,
found that NO CI workflow anywhere calls `db.apply_migrations()` — each of the
first 8 migrations needed someone to remember to run it by hand. Added it as step 0
of `datapipeline.py::run()` (idempotent, tracked in `schema_migrations`).

**Recalibration trigger confirmed wired** (by code review, not a live run):
`recalibration.py` reads the latest `backtest_runs` row — which now exists for
real (2 rows) — and `datapipeline.py` step 6 calls `recalibration.run()` on every
pipeline execution. The `pending_initial` branch ("no backtest yet") is already
behind us; no separate activation step needed.

**Tested:** all new code against the local sandbox Postgres (`tester@127.0.0.1:5445/
giva`) — a synthetic corp-actions scenario (dividend-payer, non-payer, split-only
ticker; an out-of-TTM-window old dividend correctly excluded; an untracked-ticker
row correctly dropped; idempotent re-ingest) end-to-end through
`stockvaluation.score_frame()`, confirming the real (not hardcoded) dividend_yield.
Re-ran the existing backtest/prices/universe scratch suites — all still green (the
universe test's one pre-existing failure reproduces identically on the unmodified
code too, confirmed via `git stash` — local test-DB state pollution in
`_ingest_universe`, not a regression from this session's changes).

---

## 2026-07-22 — FIRST REAL BACKTEST: opportunity_score shows the strongest early signal

`backtest.yml` finally ran clean after two instant failures (0 billable runner-ms
both times — a private-repo GitHub Actions minutes/spending cap, confirmed via a
control-test push to an unrelated, already-working workflow that failed identically).
**The user made the repo public** (unlimited free Actions minutes on public repos),
which fixed it immediately. A real bug was also found and fixed along the way
(`github.event.inputs.*` — the bare `inputs` context is invalid on a push trigger,
commit 36ffbde) but wasn't the actual blocker for this failure; both fixes are
correct and both are now shipped.

**Result** (`backtest_runs` id=1, queried directly from Supabase via MCP since the
GitHub Actions artifact download is blocked by this session's egress policy —
api.github.com direct access and signed-URL artifact downloads are both denied by
design, "do not retry or route around it"): window auto-detected as
**2024-10-20 .. 2025-07-17, 9 monthly rebalance dates** — narrower than the full
~2y price span because the walk-forward loop needs the 12m horizon's forward
return already sitting in Tier B too, which pins the window's end ~12 months
before the latest price date.

| horizon | signal | mean rank-IC | hit-rate | pct positive | t-stat | significant |
|---|---|---|---|---|---|---|
| 1m | opportunity_score | 0.009 | 77.8% | 55.6% | 1.15 | false |
| 1m | value_score | -0.006 | 77.8% | 44.4% | -0.29 | false |
| 3m | opportunity_score | 0.026 | 88.9% | 100% | 3.47 | false |
| 3m | value_score | 0.007 | 88.9% | 55.6% | 0.27 | false |
| 6m | **opportunity_score** | **0.042** | **100%** | **100%** | **5.84** | false |
| 6m | value_score | 0.023 | 100% | 55.6% | 0.91 | false |
| 12m | opportunity_score | 0.031 | 100% | 88.9% | 4.43 | false |
| 12m | value_score | 0.024 | 100% | 88.9% | 2.37 | false |

`opportunity_score` (the combined GARP score) is the standout across every single
horizon — positive rank-IC and improving hit-rate at every step, t-stats up to
5.84. **None are marked `significant`**, but not because the signal is weak: the
gate requires `n_periods >= 12`, and this maiden run only has 9 (the t-stat
threshold |t|>=2 is otherwise cleared comfortably at 3m/6m/12m). Read this as a
genuinely encouraging first look, not yet statistically proven — exactly the
"real data exposes what synthetic can't" moment this whole multi-week effort was
for, except this time the surprise is a promising signal rather than a bug.

`value_score` moves the same direction, weaker. `growth_score` and
`momentum_score` show no real signal; `growth_score` has an odd split — small
positive mean rank-IC alongside **0% hit-rate** at 6m and 12m — flagged as
unexplained, not investigated further this session (could be a very small
top/bottom-quartile bin size at n=9 periods producing noisy hit-rate, or
something more structural; worth a look once more periods accumulate).

**Also learned:** this session's sandboxed network cannot reach api.github.com
directly or download GitHub Actions artifacts (signed Azure blob URLs 403 at the
proxy) — by design, per the agent-proxy policy ("403/407: do not retry or route
around it, report the blocked host"). When CI produces a result that needs
pulling out of GitHub and Postgres has it too, query Postgres directly (Supabase
MCP) instead of fighting the artifact download.

**Status:** the critical path from "Massive adapter built" to "first real
backtest" is done. Recalibration should activate on the next daily pipeline run
now that `backtest_runs` has a real row — worth confirming on the next health
check. Next: corp actions (dividends/splits), the Quality-Triage agent, and
surfacing bottom-up rankings in the dashboard.

---

## 2026-07-20 (cont'd) — backtest.yml blocked: GitHub Actions capacity, not code

After the real backfill landed (1,420,695 rows), fired `backtest.yml` — it
failed at startup in 3 seconds, 0 billable runner-ms (no runner ever
assigned). First hypothesis: the run step referenced the bare `inputs`
context, valid only for `workflow_dispatch`, but this fires via `push`.
Fixed to use `github.event.inputs.*` instead — but the re-fire failed
**identically**. A control-test push to `price-validate.yml` (which had
fired successfully at 12:59 UTC) *also* failed the same way at 16:00 UTC.
All 10 workflows still show `state: active` (not disabled at the
definition level).

**Conclusion: this isn't a code/YAML issue.** Something blocked ALL new
workflow runs on this repo starting between 15:17 UTC (backfill completion)
and 15:53 UTC (first backtest fire) — most likely an Actions minutes quota
or spending-limit cap reached, tripped by the ~113-minute backfill job
plus the day's other runs. I have no billing/admin access to confirm or
fix this — **the user needs to check repo/org Settings → Billing and
plans → Actions** (spending limit or included-minutes usage) and either
wait for reset or raise the limit. The `github.event.inputs.*` fix stays
in `backtest.yml` regardless — it's a real, independent correctness fix,
just not what's blocking this specific failure.

**Status:** price data is safely landed (1,420,695 rows, real). The first
real backtest is one `backtest.yml` re-fire away once Actions capacity is
restored — no further code changes needed on this end.

---

## 2026-07-20 — MASSIVE_API_KEY added: first real-network run finds and fixes a real bug

User added the `MASSIVE_API_KEY` repo secret. Fired the chain: `price-validate.yml`
passed cleanly first try — 30/30 validation-batch coverage, ETF proxies (SPY/EWJ/EWG/
IXN/VT) confirmed present in grouped-daily, ~22 months of history entitled on the free
tier (3y/6y probes correctly 403 `NOT_AUTHORIZED`). Then `price-backfill.yml` completed
in under a minute with `written: 0` — clearly wrong for a ~105-minute backfill.

**Root cause:** `bulk_ingest`'s full-rebuild fresh start set `walk_from = date.today()`,
and `_weekdays_backward()` yields the start date itself first. Today's trading session
isn't complete when CI runs (pre-/mid-market), so grouped-daily has no data for it yet —
Massive returns a 403 that the code blanket-maps to `NotEntitled`, indistinguishable from
a genuine beyond-entitlement error. That made "today" a false floor before a single valid
day was ever tried, even though 2026-07-16 and 2024-09-27 had both just been proven to
work via validate. The incremental path had the same latent issue (window also ended at
`date.today()`), plus `fetch_day_into` had no catch-all for `NotEntitled` — a bad day
would have crashed daily ingestion uncaught rather than degrading gracefully.

**Fix:** `_last_complete_trading_day()` excludes today from both walks; hardened
`fetch_day_into`. The existing mock (`fake_get_full`) always returned valid data for
"today," which is precisely why this was untestable synthetically — real validation
against the live API caught something the sandbox structurally couldn't. Added two
regression scenarios (mid-window error doesn't crash; today-403 doesn't floor at day
zero) — this is the argument for why STATUS.md flagged "not yet run against real
market data" as a real risk, not a formality. All 12 prices.py scenarios plus
stockvaluation/backtest suites verified green (stood up a local Postgres 16 +
pgvector in-session to actually run the DB-backed scratch suite, since the DB
container from earlier sessions doesn't persist).

Re-fired `price-backfill.yml` with the fix. **Next: monitor to completion, then fire
`backtest.yml` for the first real rank-IC/hit-rate report.**

---

## 2026-07-14 — Massive adapter built (ADR-017): date-driven prices, gated on the key

**Decision context:** the user set the end-state directive (product is done only when
ALL agents are built — now in CLAUDE.md) and chose Massive (ex-Polygon.io) over
Tiingo. Verified against Massive's official client source + doc snapshots before
building: `api.massive.com`, Bearer auth, env convention literally `MASSIVE_API_KEY`,
grouped-daily = whole market per call, free tier = 5 req/min + 2y history, 429 on
limit, raw-redistribution needs a business plan (derived-data clause: human review
flagged). Full ADR-017.

**Built (engine/sources/prices.py rewritten):** ingestion is now DATE-driven —
grouped-daily gives 1 call/day operation and a ~105-min 2y backfill. Resumable full
rebuild (cursor persisted in `<store>/prices_meta.json` after EVERY day — min(date)
alone would never advance past zero-row holidays), capped incremental (30d max, 7d
on empty store, so the daily pipeline can't wander into backfill costs), per-ticker
split re-base path kept, 429 Retry-After (floored 60s), history floor detected
empirically (403 OR 5 consecutive empty weekdays — no US market week is all
holidays). ET-timezone date conversion for per-ticker bars (ms epochs are
ET-midnight-anchored; naive UTC conversion lands on the wrong calendar day).
9 mocked scenarios all pass; stockvaluation/backtest/tierb suites unaffected.

**CI:** price-validate.yml now asserts grouped coverage (≥25/30 batch tickers),
**SPY/ETF presence** (ETF-in-market=stocks is strongly indicated but not verbatim-
documented — we assert instead of assume), and probes the key's real history depth.
price-backfill.yml runs the resumable rebuild with --max-minutes 300. Everything
fails fast and loud if the `MASSIVE_API_KEY` secret is missing — the user adds it on
their own schedule; nothing else blocks.

## 2026-07-09 — Stooq is bot-walled from CI; two production days lost to the unmerged hydrate fix

**Stooq blocker:** `price-validate.yml` (30 known-good tickers) failed twice — first
a trivial import bug (fixed), then genuinely: every single request got back an
identical 796-byte "This site requires JavaScript to verify your browser" page,
HTTP 200, for all 30 tickers uniformly. Added `PRICES_DEBUG=1` (prints status/
headers/body-head per request — the only way to see this, since the dev sandbox
has no outbound network at all right now) to confirm it's a real anti-bot wall
against GitHub Actions' IPs, not a URL/parsing bug in our adapter. This is a hard
blocker for Stooq's per-ticker CSV endpoint from CI — not something worth trying
to route around (that's evasion territory, not a bug fix). ADR-016's Stooq choice
needs revisiting: either a keyed free-tier source (Tiingo was the pre-blessed
fallback in STATUS.md/ARCHITECTURE.md) or another keyless option — needs the
user's call since provisioning a key is their action, not something I can do.

**The other cost of holding PR #8 open:** the daily main-branch pipeline failed for
a SECOND consecutive day (2026-07-09, same "Tier B store missing" error as
2026-07-08) because the hydrate fix (commit d0cf8b9) was sitting unmerged in PR #8
while I held it back waiting on the backtest work to validate. The fix itself was
independently proven working (its own dev-branch verification run succeeded same
day it was written) — the cost was pure process, not a code problem. Lesson:
holding an open PR to sequence a risky follow-on change has a real cost if the PR
also contains an unrelated, already-verified production fix — split them, or merge
the safe part immediately instead of bundling. Merged PR #8 as soon as this became
visible; the backtest/valuation/prices code riding along is safe on main (additive,
gated on `tierb.enabled()`, and its own CI workflows only trigger on the feature
branch's own path, never main).

## 2026-07-08 (later) — prices, stock valuation, and the backtest harness built (ADR-016)

**User direction:** "let's get to backtesting" — the critical path item since Phase 1
completed. Built all three pieces in one session: prices, stock-level scoring, and
the walk-forward backtest.

**Built**
- **Prices in Tier B** — a second Parquet dataset (`security_id, date` PK, no
  restatement vintage). Generalized `tierb.py`'s base/delta write helpers to take a
  dataset dir + partition expression instead of duplicating them (the module's own
  docstring already anticipated "prices next"). `engine/sources/prices.py`: Stooq
  (free, keyless — every security already trades under a US ticker, so one adapter
  covers the whole universe with the uniform `TICKER.US` symbol format), daily
  incremental (anti-join append) + full/split-safe refresh (delete a ticker's
  history, then re-fetch — bounded memory throughout, never holds the whole store
  in Python, same discipline as the EDGAR OOM fix).
- **Stock-level valuation** (`engine/stockvaluation.py`) — point-in-time pe/pb/ps/
  pcf from `tierb.metrics_asof` + prices, trailing YoY growth (FY-only for flow
  metrics so a raw quarterly figure can't masquerade as annual; latest-available for
  balance-sheet snapshots), momentum/mean-reversion from price history. Hands off to
  the SAME `engine.metrics.compute()` the index product uses — one scoring formula,
  not two to keep in sync — peer-grouped by sector instead of country/style.
- **The backtest** (`engine/backtest.py`) — monthly walk-forward, no look-ahead
  (`metrics_asof(t)` + prices ≤ t), fixed-horizon (1/3/6/12m) forward returns via a
  bounded as-of price match, rank-IC + hit-rate + decile spread per signal, an
  IC-population guard and a t-stat significance gate. Persists to the `backtest_runs`
  table that's existed since ADR-005/migration 0005 — recalibration.py already reads
  it, so the trigger activates the moment a real run lands.
- CI: `price-validate.yml` (30 known-good tickers — the first REAL network test of
  the Stooq adapter, since the dev sandbox has no outbound access at all right now)
  gates `price-backfill.yml` (full-universe, multi-hour) before it fires;
  `backtest.yml` runs once price history exists. Daily pipeline gained a price
  step (step 2c) — cheap incremental, rides the monthly full-sweep flag for splits.

**Learned**
- `pandas.Series.add(other, fill_value=0.0)` rescues a genuinely-NaN VALUE in one
  operand (not just index-alignment gaps) — confirmed before trusting it: a stock
  with one missing valuation factor (e.g. no P/E because it's unprofitable) gets
  neutral-0 for that factor, not a NaN-poisoned whole score. This is what let
  `stockvaluation.py` reuse `metrics.compute()` unchanged at much sparser stock-level
  breadth than the index-level aggregates it was written for.
- The dev sandbox's outbound network went down mid-session (confirmed via the agent
  proxy status — even `sec.gov`, reachable all session until then, started 403ing).
  Everything price/backtest-related was built and verified with SYNTHETIC data
  instead — including an end-to-end test with an ENGINEERED signal (fundamental
  growth → forward price drift) that the backtest harness correctly recovered
  (mean rank-IC 0.8–0.95) and correctly refused to call "significant" despite huge
  t-stats when too few rebalance periods existed. Real-network validation is
  necessarily a CI-only next step (`price-validate.yml`), same as the Stooq/EDGAR
  URL-format uncertainties earlier in the project were resolved by iterating in CI.

**Open / next:** run `price-validate.yml`, then the full backfill, then the first
real backtest. Known, documented gaps: no survivorship control, no transaction
costs, no benchmark Sharpe, latest-FY (not TTM) multiples, no per-stock forward
growth, no dividend yield — all in PLAN.md.

## 2026-07-08 — refill repaired: Postgres 909 MB → 29 MB; two more failure modes closed

The re-truncate landed on run 4. The gate's journey taught two lessons:

- **Runs 1–2:** the superset gate refused — 4,691 "Postgres-only" rows that
  `export --incremental` could not close ("0 new rows"). They were **same-PK
  variants**, not missing data: both stores keep one row per PK
  (first-write-wins), but Tier B's base holds the June point-in-time capture
  while the refill held July's refetch (net_income ×2,153,
  cash_and_investments ×2,075, total_revenue ×292 … — in-place EDGAR
  revisions between fetches). Keeping the earlier capture IS the
  point-in-time semantics. `cutover` now separates the two cases: missing
  PKs still refuse; variants are archived to `<store>/pg_variants/` (carried
  by the bundle — nothing discarded) and the truncate proceeds.
- **Run 3:** hung 60 minutes on a dead pooler socket mid-stream —
  `pg_stat_activity` showed NO runner connection while the client blocked
  forever. `db.connect()` now sets TCP keepalives (+30s connect_timeout):
  dead peers raise in ~2 min instead of silently burning a job timeout.

End state: `fundamental_metrics` empty (32 kB), **database 29 MB** (was 909);
Tier B sole store at **3,527,837 rows / 21.3 MB**; bundle published as the
`tierb-store` release asset (durable hydration for `tierbsync pull`,
refreshed monthly by the pipeline).

## 2026-07-07 (later) — the refill incident: Postgres grew back to 3.5M rows

The post-cutover backfill quietly REFILLED `fundamental_metrics` (~900 MB, over the
Supabase cap). Chain: a CI cache miss dropped the Tier B store → `tierb.enabled()`
false → ingestion had no writer, and the "is Postgres empty?" check defaulted to
dual-write → ~444k rows landed in the truncated table → the NEXT run saw a
non-empty table, concluded "pre-cutover", and dual-wrote all 3.07M. Tier B itself
was fine (3,527,837 rows — a verified superset of the refill).

**Fixes** (all tested against scratch PG):
- `edgar.ingest_tickers` now ABORTS loudly when the store is missing AND Postgres
  is empty — the post-cutover cache-miss case must hydrate (`tierbsync pull`),
  never silently re-inflate Postgres.
- `tierbsync cutover` gate is now **superset** (every PG row ∈ Tier B), not full
  equality — Tier B legitimately holds more after partial runs, and equality
  would have blocked the repair.
- `tierb-retruncate.yml` one-shot: restore newest store → superset-gated cutover
  → publish the bundle as a **GitHub release asset** (`tierb-store` tag). The
  daily pipeline refreshes that asset on the monthly sweep — `tierbsync pull`
  now has a hydration source that survives cache eviction (the root cause).

Lesson: a data-detected mode switch (empty table = post-cutover) needs BOTH sides
guarded — the detector was fine, but the fallback when its co-input (the store)
vanished re-created the old mode. Fail loudly when state inputs disappear.

## 2026-07-07 — cutover executed; universe 501 → 2,983; the OOM saga

**Cutover (07:06 UTC):** all verify gates passed against production, store bundled
(90-day artifact), `fundamental_metrics` truncated. Postgres ~20 MB (ops/dashboard
only); Tier B is the sole metric store. Ingestion self-detects via the empty table.

**Universe:** US top-2,500 (public float, median-over-9-frames + size-proxy
cross-check) + foreign discovery finalized at **inclusion = files 20-F/40-F + has a
US ticker** (285 auto + 198 curated across 26+ markets: China 63, Israel 59, UK 49…).
Two discovery iterations were needed: USD-only frames kept just the USD-reporting
cohort (80), and even multi-currency frames proved SPARSE for IFRS filers — frames
sizing is ordering-only now.

**The OOM saga:** backfill runners died twice at ~40 min with "runner received a
shutdown signal". Root cause: `edgar._facts_cache` retains every companyfacts JSON
(1–10 MB each) — fine at 501 companies, OOM at ~700 of 3,300. Fix: `cache=False` in
bulk ingest (the cache serves only the adapter's repeated samples) + progress lines.
Lesson: module-level caches that survive a 500-item workload are still time bombs at
6× scale; and "runner shutdown signal" in Actions is the OOM signature, not infra flake.

**Still open:** transient quality collapse (0/100, no_fundamentals errors) until the
backfill completes — securities rows persisted from killed runs while their metric
rows died with the runner. Self-heals on the next successful sweep.

## 2026-07-06 (evening) — storage inversion + real scale (ADR-015)

**User direction:** much more than 1,200 companies; Postgres only for dashboard-facing
state; ETF proxies stay the priority signal (baskets later where no ETF exists).

**Built**
- **Immediate cutover (user-approved):** `tierbsync cutover` — verify gates must pass,
  bundle archived, then `truncate fundamental_metrics`. Ingestion **self-detects** the
  empty table and writes metrics Tier-B-only (the truncate IS the switch; no flag).
- **`discover-foreign`** (universescan): all 20-F/40-F filers from EDGAR's form
  indexes (the exact FPI definition), assets-ranked via us-gaap + ifrs-full instant
  frames, business-address country classification (Cayman-inc → China solved),
  ≥$100M assets, ≤1,000/market for the 30 target markets. Curated list becomes an
  override. `us_target` → 2,500.
- **Index universe 94 → 132:** global sectors (IXN/IXJ/…), US industries (IGV/KRE/
  ITB/…), factor styles incl. international (VLUE/SCHD/COWZ/EFV/IQLT/…), regions.
- **`tierb-cutover.yml`** one-shot: verify → archive → truncate → expand-us →
  discover-foreign → full backfill (multi-hour) → coverage + quality → compact/bundle.
- Full sweep cadence weekly → **monthly** (first Sunday); dailies stay incremental.

**Learned**
- The dual-write window and the scale-up are mutually exclusive: 23M rows ≈ 6 GB in
  Postgres vs ~150 MB in Parquet — the cutover had to come first, and the 6 live
  validation runs earlier today stood in for the proving window.

## 2026-07-06 (later) — global universe expansion built, gated on cutover

**Built** (ADR-014)
- **Universe as committed data** — `engine/sources/universe_stocks.json`: 198 curated
  SEC-filer (20-F/40-F) stocks across the top-10 markets of Europe, Asia, and the rest
  of the world (with honest per-market coverage gaps documented), plus `stocks_us`
  generated by `engine/universescan.py expand-us` (top ~1,000 by `dei:EntityPublicFloat`
  via the XBRL frames API). The pipeline reconciles the DB to the file — the old 501
  lived only in the DB.
- **IFRS canonical mappings** in `catalog._CANONICAL` (`Revenue`, `ProfitLoss`,
  `CashFlowsFromUsedInOperatingActivities`, …) so 20-F foreign filers resolve the same
  core metric_codes — quality checks and scoring work unchanged.
- **Incremental daily ingestion** — EDGAR's daily index filters the universe to
  companies that actually filed recently (+ new seed tickers); Sunday runs full-sweep.
  Keeps CI minutes flat while the universe grows ~2.5×. `edgar.ingest_tickers` now
  takes `country_by_ticker` (was hard-coded 'United States').
- **Expansion gate:** while Postgres still dual-writes (pre-cutover), only the
  30-company cross-region validation batch ingests (ADR-011) — the full expansion
  would blow the Supabase 500 MB cap. It joins automatically post-cutover.
- `universe-validate.yml` (one-shot CI): generates stocks_us, ingests the validation
  batch, prints per-market core-metric coverage + quality score.

**Gate A also passed today** (see below): 1,469,371 rows verified, store 6.6 MB.

## 2026-07-06 — Tier B built (Parquet + DuckDB), dormant until export

**Built**
- **`engine/tierb.py`** — the Tier-B access layer (mirror of `db.py`): in-memory DuckDB
  over `data/tierb/` Parquet with a PK-dedupe view (base + delta), `append_metrics()`
  (anti-join ≙ ON CONFLICT DO NOTHING), `delete_metric_code()` (atomic rewrite-and-swap),
  and **`metrics_asof()`** — the no-look-ahead point-in-time API the backtest will use.
- **`engine/tierbsync.py`** — export (full/incremental) / verify / compact / bundle /
  pull. Verify = Gate A: row counts, bidirectional set equality, AAPL net_income
  vintage identity, no-look-ahead behaviour on a real restatement.
- **Call sites wired, data-gated:** everything switches on `tierb.have_tierb()` — until
  the store exists, zero behaviour change. Once exported: EDGAR ingestion dual-writes,
  the pipeline reconciles (incremental export step 2b), quality/validate/recalibration
  read DuckDB (`quality_report.json` gains `"metrics_engine"`), suspect purges hit both
  stores. CI: daily workflow caches `data/tierb`, weekly workflow compacts + uploads a
  90-day bundle artifact.
- ADR-013 records the design (psycopg streaming, filings stay in Postgres, gated cutover).

**Learned / fixed**
- The DuckDB postgres extension is a **runtime download** — it failed behind the cloud
  session's egress policy (403). Switched to streaming via psycopg (already a dep):
  more portable, no moving parts, and lets incremental sync pull only rows past the
  `ingested_at` high-water mark (kind to Supabase free-tier egress).
- Tested end-to-end against a scratch Postgres 16: export → verify (all gates) →
  incremental (exact, idempotent) → compact → re-verify → bundle → pull; quality/
  validate produce **identical issues and verdicts on both engines** (Gate B rehearsal,
  every check exercised); dual-write adds identical row counts to both stores; the
  full-export refusal guard blocks the post-cutover data-loss scenario.
- `value` is a reserved-ish token in DuckDB — quote it as an alias.
- An adversarial multi-angle review before merge caught real gaps: a falsy-zero skip
  in the source-disagreement check (fixed in BOTH engines), an incremental-sync window
  that could permanently orphan rows missed by a failed dual-write (now self-heals on
  count drift), and silent Postgres fallbacks that could mask a broken store for the
  whole proving window (now one `tierb.enabled()` gate + count-parity guards that warn
  and fall back only when Tier B is genuinely behind).

**Open / next**
- **Activate**: run `tierbsync export` + `verify` with the real `DATABASE_URL` (this
  session had no keys), confirm quality stays 99/100 on `metrics_engine: tierb`,
  watch a ~1-week dual-write window, then cut over (pg_dump archive → Tier-B-only
  writes → truncate `fundamental_metrics` → DB ~20 MB).
- Then prices (Tiingo, into Tier B) → stock-level valuation → backtest.
- Still open: rotate `OLLAMA_API_KEY`/`GROQ_API_KEY`; bank revenue composition; FDXF.

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
