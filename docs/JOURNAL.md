# Work journal

A running log of what happened each work session — the narrative that git history and
the decision log don't fully capture. Newest entry on top.

**Convention:** at the end of a session, prepend a dated entry: what was built, what was
learned, what's still open. Keep it to what a future session would want to know.

---

## 2026-07-31 (night) — growth_score anomaly: not blocked after all, and now diagnosable

I had listed the `growth_score` anomaly as "needs more price history" and moved
on. That was wrong: run id=4's **full 39-period detail is persisted in Postgres**
(`backtest_runs.metrics.periods`, 86 KB) and this session has DB access. The data
to investigate has been sitting there since 07-25.

**What the real data says.** Pulled every period × horizon × signal:

| signal | 6m mean rank-IC | 6m hit-rate | 1m → 12m hit-rate |
|---|---|---|---|
| opportunity_score | +0.0437 | **1.000** (39/39) | 0.795 → 0.923 → 1.000 → 0.949 |
| value_score | +0.0244 | **1.000** (39/39) | 0.795 → 0.872 → 1.000 → 1.000 |
| growth_score | **+0.0266** | **0.000** (0/39) | 0.282 → 0.154 → 0.000 → 0.000 |

`value_score` and `growth_score` have *near-identical* positive 6m IC and
*opposite* quartile verdicts. And growth's hit-rate degrades **monotonically with
horizon** — that pattern is the clue.

**Ruled out: a sign/ordering bug.** Read `_evaluate_period` — `sort_values()` is
ascending, `[:q]` is bottom, `[-q:]` is top, `hit_rate = top > bottom`. Correct.
And hit_rate is clearly not globally broken, since other signals score 39/39.

**The actual explanation: the two statistics measure different things.**
`rank_ic` is a Spearman correlation over the whole ~2,700-name cross-section and
is immune to outliers. `hit_rate` compares **arithmetic means** of the extreme
quartiles and is dominated by them. One period makes it vivid — growth_score at
6m: `rank_ic +0.0978`, yet `top_q_ret -5.83%` vs `bottom_q_ret +3.68%`. A handful
of blowups in the top-growth quartile crush its *mean* while most of its members
still rank fine; longer horizons give blowups more time to compound, which is
exactly the monotonic degradation observed.

**Shipped the test rather than the conclusion.** Added median quartile returns
(`hit_rate_median`, `top_q_med`, `bottom_q_med`, `spread_median`) plus a summary
`hit_rate_mean_vs_median_gap`. Median is robust to precisely this, so if the
hypothesis holds the next run will show growth_score's mean- and median-based
hit-rates disagreeing while the other signals agree. Reported **alongside** the
mean-based figures, never replacing them — the existing metric isn't wrong, and
silently swapping it would break comparability with runs 1–4.

Verified the diagnostic discriminates before shipping: a synthetic fat-tail
fixture (positive rank relationship + 40 blowups injected into the top quartile)
reproduces the exact observed signature — IC +0.064, mean-hit 0.0, median-hit 1.0
— while a clean fixture has both agree. `_aggregate` also tolerates runs 1–4,
which predate the fields, instead of crashing on re-aggregation.

**Lesson worth keeping:** "blocked on data" deserves re-checking before it's
repeated. This one was self-inflicted — the data was already persisted, by an
earlier commit in this same session whose whole point was to persist it.

---

## 2026-07-31 (evening) — Closing two audit items: LLM tag provenance, issuer attribution 85.7% → 97%

Picked off the unfinished items that did NOT need the live data access this
sandbox lacks.

**1. `_fallback_tag` disclosure gap (open since the 2026-07-22 audit).**
`_fallback_brief` always disclosed itself in its own text ("LLM narrative
disabled — ..."), but `_fallback_tag` returned strings like "Cheap and growing —
GARP sweet spot" that are **indistinguishable from model output**. A reader
couldn't tell a rule-derived label from a model's read.

Fixed with structured provenance rather than by appending "(deterministic)" to
the text — the tag is user-facing UI copy, and that suffix on 133 rows is noise.
`cheap_tags_with_provenance()` returns `{tag, source}` per market; `tag_source`
rides in the published JSON; the dashboard marks only the fallback ("· rule-based"
with a tooltip), since labelling the normal case would be clutter.

The case that made per-key provenance necessary rather than a single run-level
flag: **partial fallback**. When the model answers but omits some keys (or
returns a blank string for one), those individual markets silently fall back, so
one run can mix generated and deterministic tags. Verified all four paths — LLM
off, full answer, partial/blank answer, and call raising — plus that the legacy
`cheap_tags()` still returns plain strings for any other caller.

**2. Issuer attribution 114/133 → 129/133 (97%).** Researched the 19 unattributed
proxies against primary sources instead of recall. Confirmed and added: the
Global X single-country family (ARGT, GREK, PGAL, NORW, NGE, PAK, GXG — verified
against Global X Funds SEC filings, CIK 1432353); four more iShares (**VLUE**,
KSA, QAT, UAE — verified against ishares.com/blackrock.com product pages); plus
KWEB (KraneShares), SCHD (Schwab), COWZ (Pacer), ASHR (Xtrackers/DWS).

VLUE mattered most — it is the dashboard's current top-ranked pick, and was
showing "issuer not attributed" on the one row a user is most likely to click.

Two of the new entries carry `url=None`: the issuer NAME is confirmed but the
root domain wasn't verified from here, so the UI renders the name as plain text
rather than a link. That is a third UI state, now handled explicitly — a link we
haven't checked is precisely what ADR-027 refuses to ship.

**Still unattributed, deliberately: JETS, DXJ, DEM, GULF.** Plausible answers
exist for each; none confirmed against a primary source in this sweep, so they
render ticker-only. Guessing here would be a factual error shown to someone
making a money decision.

---

## 2026-07-31 (later) — Questionnaire sweep: quality check narrowed, backtest HAC-corrected, regional sectors researched

Ran an open-questions questionnaire past the user and worked the answers.

**Corrected a stale claim of my own.** The questionnaire offered "extend backtest
depth (only 9 periods, gate needs 12+)" — that was already solved on 07-25 by
ADR-022's weekly cadence (39 periods; `opportunity_score` significant at all four
horizons). The genuinely open weakness was the *uncorrected overlap*, which ADR-022
had explicitly deferred as a caveat. Fixed that instead.

**1. `shares_concept_disagreement` → `shares_multiclass_unsummed`.** The v1 check
fired exactly 421× on three consecutive runs, unchanged even after the ADR-027
tie-break shipped — because it flagged *normal EDGAR*: the three concepts behind
`shares_outstanding` legitimately differ (cover-page date vs balance-sheet date vs
issued-incl-treasury). Narrowed to the actually-broken case: the SAME concept
carrying multiple values for one (security, period_end), i.e. an unsummed
dual-class issuer. Verified on a DuckDB fixture — a CMCSA-shaped cross-concept
spread no longer fires; a GOOG-shaped same-concept split does.

**2. Newey-West (HAC) t-stat in the backtest.** Weekly rebalancing makes adjacent
ICs serially correlated; the plain t-stat assumes independence and so overstates
significance worst where overlap is worst. Added a Bartlett-kernel HAC SE with the
lag derived from real window overlap; `significant` now gates on the corrected
statistic, with `t_stat_naive` kept alongside (synthetic: 13.31 → 6.64).

Two bugs found *by testing the estimator instead of trusting it* — worth
remembering, since both would have silently produced confident-looking numbers:
- At 12m/weekly the theoretical lag is 52 against n≈39. Bartlett HAC destabilises
  as lag → n: measured, lag=25 gave a **smaller** SE than lag=0, which would have
  made an overlapping series look *more* significant — the exact inverse of the
  correction's purpose. Capped at n/4, with `lag_capped` reported so partial
  correction stays visible.
- The degenerate guard `gamma0 <= 0` let a constant series' float dust (~3e-17)
  through, yielding an absurd t-stat off zero variance. Now a relative tolerance.

**3. Regional sectors — researched, and the gap is mostly structural.** The user's
"no sectors under Europe/Asia-Pacific" turns out to have a real, checkable answer:
US-listed *regional sector* ETFs barely exist. The iShares MSCI Europe sector family
(ESIF/ESIH/ESIT/ESIN/ESIE) is **UCITS**, listed on LSE/Xetra — adopting it would
break both the US-listed invariant this universe rests on and the LRS access route
ADR-027 documents. **EUFN** is the one usable addition (US-listed, $3.89B AUM, 99
holdings, iShares since 2010) and is now in the universe, so Europe shows 1 sector
instead of 0. No liquid US-listed **Asia-Pacific sector** ETF was found — the
nearest, KTEC, is China/HK tech, a country-tech slice rather than a regional
sector — so Asia-Pacific stays at zero and the empty state says so honestly.

**Also:** fixed `~/.claude/stop-hook-git-check.sh` to skip commits committed by
`GitHub <noreply@github.com>` (PR merge commits) — it had been flagging them every
session, and its suggested `--reset-author` fix would have rewritten published
`main` history *and* reattributed the user's merge commit to us. Verified against
all four cases (GitHub merge, our signed commit, our unsigned commit, wrong email).

**4. Tier B dump job — the recurring blocker, made non-recurring.** Twice now an
investigation has died on the same wall: Tier B is the sole metric store but only
materialises inside a CI runner, and `data.sec.gov` is unreachable from the
sandbox, so "what do this issuer's raw rows actually look like?" can't be answered
where the analysis happens. Both times (CMCSA 07-27, multi-class 07-29) the answer
came from reading code rather than data — which found real bugs, but left the
data question open. `engine/tierbdump.py` + `.github/workflows/tierb-dump.yml`
fix that: dispatch, download the artifact, analyse anywhere.

Deliberately **parameterised presets, not a `--sql` flag.** Arbitrary SQL was the
obvious first instinct and is more flexible, but it would turn a dispatchable
workflow into a general query endpoint against production data with results
published as an artifact. The three presets cover the real investigations; a new
shape needs a reviewed commit, which is the point. Job is `permissions:
contents: read` so it cannot push even by accident. Verified all three presets on
a DuckDB fixture (the multiclass preset correctly returns GOOG-shaped rows and
skips CMCSA-shaped cross-concept spreads) plus every error path — no store, bad
preset, missing `--tickers`.

**Still open:** the 19 unattributed issuers; deep per-fund links (need issuer-site
access — `ishares.com` 403s automated fetches); per-class share summing itself
(now *detected* by the narrowed check and *dumpable* via the new job, but nothing
sums yet — the next session has both tools it was missing); and the operator
actions the user said they'd do — rotate `OLLAMA_API_KEY`/`GROQ_API_KEY` (repo is
public) and set the Supabase secrets.

---

## 2026-07-31 — UI: "how to invest" (ADR-027) + two silent-blank fixes the user hit

User feedback, three specific gaps — all reproduced against the real snapshot before
touching anything, all real:

1. **"No sectors when I click Europe or Asia-Pacific."** Confirmed, and it is a
   *universe* gap, not a filter bug: all 37 sector proxies are tagged `Global` (14)
   or `North America` (23). Zero non-US regional sectors exist, because the liquid
   sector ETFs are US- or globally-scoped. Filtering to Europe correctly matched
   nothing — and then rendered a completely blank table, which reads as breakage.
2. **"No stock-level breakdown from a sector/index."** Partly a misread, mostly ours:
   all 37 sectors *do* have breakdowns, but **61 of 132 markets don't** (41 countries,
   10 regions, 5 broad, 5 style), and `stockBreakdownBlock()` returned `''` for them —
   a silent blank with no explanation. The cause is structural: our stock universe is
   EDGAR-derived (US filers), so a market with no SEC-filing constituents has nothing
   to break down.
3. **"No links on how to invest — most important, and for an Indian investor."**
   Entirely true. There was no link anywhere in the app; the investability line was
   static text.

**Shipped.** New `engine/investing.py` → `meta.access_route` (India/LRS explainer),
per-row `issuer`, `meta.issuer_coverage`, `meta.stock_coverage`; a "How to invest"
block in the drawer; a real empty-state for the table that *names the actual reason*
(derived from the data: "Sectors coverage currently spans Global, North America") with
a Clear-filters escape hatch; and an explained empty-state for missing breakdowns.
New DISCLAIMER section (route info ≠ advice; no broker endorsement; tax/LRS points are
general and time-sensitive).

**Three constraints held deliberately (ADR-027).** No fabricated URLs — issuer deep
links aren't derivable from a ticker (EWY → `/products/239681/`) and issuer sites 403
automated lookups, so deep links can't be verified pre-ship; root domains only. No
issuer guessing — 113/132 (85.6%) attributed, the other 19 render "issuer not
attributed" rather than a plausible guess. No broker named — the LRS *mechanism*, not
a provider. The user was asked and explicitly chose this trade-off over INDmoney deep
links (its MCP connector had dropped, so the URL scheme was unverifiable).

Verified by rendering the actual HTML fragments against the live snapshot with a DOM
stub (`scratchpad/render_test.js`) — empty state, both breakdown states, invest block
with and without a known issuer — and asserting only root domains appear in `href`s.

**Still open:** regional sector coverage needs real research into which regional sector
ETFs exist and are liquid — that's a Source-Discovery agent job, not something to guess
tickers for. Deep per-fund issuer links need an id-resolver run from an environment
with issuer-site access. The 19 unattributed issuers need a verified source.

---

## 2026-07-29 — Daily health check: tierb_only visibility fix confirmed live; shares_outstanding tie-break fixed

Two consecutive daily health checks (07-28, 07-29) confirmed the `tierb_only` fix
shipped in PR #15 is working — `'tierb_only': True` now appears in the ingest stats
line for the first time since cutover. No `tierb_error`, tierb reconcile clean no-op
both days. Recurring, non-actionable pattern: `data-pipeline.yml`'s 06:00 UTC cron has
fired 2-3 hours late for 3 days running (platform-side GitHub Actions scheduling,
confirmed via YAML/config review — not a repo issue).

**The `shares_concept_disagreement` check (shipped 07-27) found a real, widespread
problem, not a one-off.** It fired 421 times out of 1,005 securities in the 07-28 run
(~42%) — the single largest issue category, pulling quality score from 93→86/100 (still
well above collapse). Quality-Triage ran on it automatically twice (07-28, 07-29) but
both proposals were too generic to act on. Couldn't verify real per-ticker XBRL data
this session either (Tier B is CI-only, not present locally; `data.sec.gov` returned
403 from this sandbox) — so traced the actual bug by reading code instead:
`stockvaluation.py::_nth_per_security()` picks the latest `period_end` per
(security_id, metric_code) via a plain sort+`tail(1)`, with **no tie-break** when
multiple XBRL concepts (dei vs us-gaap tags) report `shares_outstanding` for the exact
same `period_end` — common (e.g. a 10-K cover-page date matching fiscal year end). The
winner was whichever row happened to be inserted last — an ingest-order accident, not a
choice. That's the real mechanism behind the wrong CMCSA P/E.

**Fixed:** added `_resolve_shares_concept()` — deterministically prefers
`dei:EntityCommonStockSharesOutstanding` > `us-gaap:CommonStockSharesOutstanding` >
`us-gaap:CommonStockSharesIssued`, per `metric_catalog.json`'s own documented guidance
("dei:... is the cleanest for current market cap"). Verified with a synthetic fixture
reproducing the CMCSA shape (two concepts, same period_end, ~2x value gap) plus a
shuffled-row-order run to confirm the pick is order-independent, and confirmed it
composes correctly with the existing latest-period selection. **Still open:** true
per-class summing (Class A + Class B reported separately under the SAME concept via
XBRL dimensional members) is a different failure mode this does NOT fix — needs
per-class dimensional data `fundamental_metrics` doesn't carry today. Recorded as an
update to lesson 807 (now `active`, confidence 0.65) rather than a new lesson, so the
investigation trail stays in one place.

---

## 2026-07-27 — Phase D: auth + per-user watchlist, display currency, investability panel

Closed the P3 "localStorage dead-end" (ARCHITECTURE.md) and gave Phase C's stock
breakdown the "can I actually buy this" context it was missing since it shipped
(2026-07-25) with ratios/scores only.

**Investigated before building anything.** Grepped the whole ingestion path for
`currency` handling before assuming what "currency" in the task scope meant: found
`securities.currency` exists in the schema (migration 0001) but `edgar.py` never sets
it on insert — every tracked security is US-ticker-listed by construction
(`universescan.py`), so it's silently always NULL today. Also confirmed
`dashboard_data.json` had genuinely zero currency-denominated fields anywhere — every
number the dashboard shows (P/E, dividend yield %, growth %) is dimensionless by
design. That ruled out "fix a currency bug" as the scope and pointed at the real gap:
Phase C's `market_breakdown()` computes `price`/`market_cap` internally (needed for the
P/E calc) but never passed them through to the dashboard. Built the feature around that
actual gap rather than a guessed one.

**Shipped**, in dependency order (full detail: `docs/PLAN.md` Phase D, ADR-023..026):
1. `engine/sources/fx.py` — Frankfurter (ECB, free, keyless) daily rates, new
   `fx_rates` table (migration 0012), wired into `datapipeline.py`'s daily run.
2. `pipeline.py` reads the latest FX snapshot back into `dashboard_data.json`'s
   `meta.fx`, and embeds `SUPABASE_URL`/`SUPABASE_ANON_KEY` (new `engine/config.py`
   constants, read from `.env`) into `meta.supabase` — the no-build frontend has
   nowhere else to safely get config without hardcoding it into checked-in HTML.
3. `stockvaluation.py`: `_universe()` now selects `currency` (coalesced to `'USD'` —
   see investigation above) and `market_breakdown()`'s per-stock output gained
   `price`/`market_cap`/`currency`/`country` — the investability panel's data.
4. `dashboard/auth.js` (new) — thin `supabase-js` wrapper: magic-link sign-in,
   `user_watchlist` CRUD (migration 0011, written earlier this session but never
   wired to any UI until now). Degrades to `Auth.available() === false` (never
   throws) when Supabase isn't configured or the CDN script didn't load.
5. `dashboard/app.js` — `convertUSD()`/`money()`/`marketCap()` for client-side
   display-currency conversion (never touches a score); a ★ toggle in the market
   drawer wired to `Auth.toggleWatch`; sign-in/sign-out header controls.
6. `index.html` — supabase-js CDN script (loaded synchronously, *not* `defer` —
   first draft used `defer` and would have raced `auth.js`, which runs unde­ferred
   at the bottom of body and executes before a deferred head script does; caught
   before shipping, not in review).
7. `DISCLAIMER.md` — FX rates are indicative/display-only; watchlist data is
   user-generated, not advice, stored by Supabase under its own terms.

**Learned:** the biggest risk on a loosely-specified task list (task names like "Update
dashboard/app.js: currency, investability panel, watchlist star, auth UI" with no
further spec) wasn't the implementation — it was guessing the wrong feature shape.
Reading the actual data contract (`dashboard_data.json`, `market_breakdown()`'s output
dict) before writing any frontend code turned "currency" from an ambiguous word into a
concrete, small, correctly-scoped feature (display-only conversion of two fields that
already existed one function-return away from being shipped).

**Not done, deliberately:** a multi-currency fundamentals pipeline (ADR-023 — the
ratios are dimensionless, re-deriving them per currency would be a no-op); turning the
watchlist into a learning signal / `user_vector` (still P3's unbuilt half — a watchlist
is a saved list today, not personalisation yet). Operator action still needed to
activate in production: add `SUPABASE_URL`/`SUPABASE_ANON_KEY` as GitHub repo secrets
(refresh.yml is already wired to pass them through — no build step to inject client-side
config otherwise).

**Addendum, same day — the investability panel immediately found a real bug.** The
user spotted Comcast (CMCSA) showing an implausible P/E (2.46x) in the just-shipped
panel. Investigated with the tools actually available in this sandbox (Postgres via
Supabase MCP; SEC EDGAR and Tier B's Parquet store were both unreachable — the proxy
blocks `data.sec.gov`, and Tier B only exists in CI): confirmed `market_cap` implies
only ~2.06B CMCSA shares vs. Comcast's real multi-billion count, and found two real
code issues by reading `engine/sources/edgar.py` and cross-checking production data:
(1) **confirmed & fixed** — `filing_rows[accn]` took whichever XBRL fact was iterated
first as the filing's `period_end`/`fiscal_period`, not necessarily the filing's own
primary period (a 10-Q's comparative prior-year figures can be iterated first); proven
via prod query: 3 real CMCSA 10-Qs filed months apart all recorded
`period_end='2024-12-31'`. Fixed to keep the fact with the latest `end` per accession.
(2) **suspected, not fixed** — `shares_outstanding` merges 3 XBRL concepts into one
metric_code with no per-class dedup key; `metric_catalog.json`'s own notes say
multi-class issuers' per-class facts should be summed, but no code does that. Rather
than guess a fix I couldn't verify without live data, added a new quality.py check
(`shares_concept_disagreement`, comparing `raw_tag` variants) to surface this class of
issue going forward, and recorded a `lessons` row (id 807, scope
`quality:shares_concept_disagreement`) with the full investigation so a future session
with real Tier B/EDGAR access can finish the diagnosis without re-deriving it. This is
exactly the Quality-Triage feedback loop (`engine/qualitytriage.py`) working as
designed — the new check will fire on the next ingest, triage will explain root cause
+ propose a follow-up check via LLM, and it'll land in the same `lessons` table
alongside this manual entry.

---

## 2026-07-25 — Weekly rebalance cadence gives the first `significant: true` results; Analyst/Model-Upgrade verified live; Phase C shipped

Three real threads today, all started from direct user follow-ups on
yesterday's work.

**1. "What about the other two agents?"** Manually test-fired `refresh.yml`
(added a push trigger mirroring `backtest.yml`'s, temporarily forced
`--model-upgrade` past its monthly gate) instead of waiting for Monday.
Verified against Postgres directly, not just "the step didn't crash": Analyst
made 24 real successful LLM calls but wrote zero `theses` — legitimate, not a
bug (its own playbook says "no thesis beats a bad one," and 4 ReAct steps is
tight for a genuinely novel task). Model-Upgrade correctly found nothing to
flag (no model/role has 20+ accumulated calls yet — the deterministic gate
working as designed, not a failure). `smart_brief` fell through 2 failing
tiers before succeeding on Groq. One real, boring incident: the run's final
git-commit step failed with a `non-fast-forward` rejection because this
session pushed 3 more commits to the branch while the ~19-minute run had an
already-stale checkout — the Postgres writes (the actual verification target)
were unaffected. Reverted the temporary force once done.

**2. "Why do we need to wait for time to pass?"** — a sharp catch. Recalibration
had been stuck at 9 backtest periods for days; I'd been telling the user to
just wait for more history to accumulate. They asked why we couldn't just
backfill 2 more years. Investigated and confirmed in `engine/sources/prices.py`:
Massive's `403 NOT_AUTHORIZED` floor is a ROLLING entitlement evaluated fresh
against *today's* date on every request — re-requesting older dates today
hits the identical 403 immediately, no workaround exists on the free tier.
Presented three real options (paid tier / finer rebalance cadence / keep
waiting); user chose finer cadence. `REBALANCE_FREQ` went from `"MS"`
(monthly) to `"W-FRI"` (weekly) — same ~9-month window, ~39 periods instead
of 9. Made the real tradeoff (overlapping windows → serially correlated IC
series → the t-stat gate doesn't adjust for it) explicit in the DATA itself
(`significance_caveat` field, `cadence` persisted in `backtest_runs.metrics`),
not just in comments, so a "significant: true" downstream can never be
silently misread as fully rigorous. Documented as ADR-022.

Re-fired `backtest.yml` under the new cadence — real result: **`opportunity_score`
clears `significant: true` at ALL FOUR horizons for the first time**
(t-stats 3.07/8.08/15.39/8.88, mean rank-IC 0.012/0.030/0.044/0.027,
hit-rate up to 100% at 6m). `value_score` clears it at 6m/12m. And — this is
the part worth remembering — **the extra data didn't resolve the growth_score
mystery, it sharpened it**: growth_score now clears `significant: true` at 3m
AND 6m by rank-IC, while its hit-rate is STILL 0% at 6m and 12m. A metric
that's "significantly correlated" while its top-quartile picks lose to its
bottom-quartile picks every single period is exactly what a real signal-
construction bug (not noise) looks like. Flagged as the clearest concrete
next investigation; not chased further this session — today's job was to
unblock the significance gate, not re-litigate growth_score.

**3. "Let's do Phase C changes as well."** Built `stockvaluation.market_breakdown()`
— reuses the (ticker, weight) top-holdings `datasource.py` already fetches
for the index-level growth calc, matches against the EDGAR-tracked stock
universe, scores matches with the same `score_frame()` used everywhere else
(one universe-wide call, sliced per market — not N calls), ranks by
`opportunity_score`. Wired into `pipeline.py` (new `stock_breakdown` payload
key, best-effort/non-fatal) and `dashboard/app.js` (a new "Top stocks within
this market" section in the drill-down drawer). Scratch-tested with synthetic
data and caught a real bug before it shipped: `scored.set_index("ticker")`
silently drops the ticker column from each row's dict (it becomes the index
key instead, not a field) — every breakdown row's `ticker` was coming back
`None`. Fixed with `drop=False`. Coverage will be uneven across markets (only
holdings we've actually EDGAR-ingested show up) — expected given the current
US-heavy universe, not a bug.

**Process note for a future session**: when firing a long-running CI job
(15-20+ min) from this branch, avoid pushing MORE commits to the same branch
while it's in flight if that workflow ends in a `git push` step — it doesn't
break the actual work (Postgres writes succeed independently), but it does
reliably lose the final "commit results back to git" step to a
non-fast-forward rejection. Either batch pushes before firing, or accept the
snapshot-commit loss on genuinely concurrent runs.

---

## 2026-07-24 (later) — Verified Phase B agents produced real output; re-ran backtest, found a real bug in recalibration's counter

Two things closed out today, both started from the user asking "did agents work?"
and "let's get to next steps" — genuine verification led to a genuine finding.

**Agents verified end-to-end, not just "didn't crash."** Queried Postgres directly
(user explicitly authorized this after I'd flagged I couldn't reach the CI artifact
— its download URL is Azure blob storage, blocked by this sandbox's egress policy,
confirmed via a live 403). `model_invocations` showed 100% success (4/4 quality_triage,
4/4 sector_research, 3/3 source_discovery, all `ollamacloud:gpt-oss:120b`).
`taxonomy_changes`/`lessons` had real, substantive content: Quality-Triage's 4 root-
cause diagnoses (one correctly identified that financial-institution filers don't
use a universal `TotalRevenue` XBRL tag), Sector-KPI Research's 20 real KPI proposals
across 4 thin sub-sectors. This closes the loop PR #11/#12 had left open ("scratch-
tested, not live-verified").

**Re-ran `backtest.yml`** (recalibration had flagged `full_rebacktest` twice, 37→58
corrections). Real result: numbers came back nearly IDENTICAL to the 2026-07-22 run
(`opportunity_score` rank-IC 0.008/0.024/0.043/0.032 vs 0.009/0.026/0.042/0.031 —
noise-level difference), window barely moved (+4 days, still 9 periods), still not
significant (`n_periods=9 < 12`), `growth_score`'s 0%-hit-rate anomaly unchanged.

That near-identical result was itself the signal: 58 "material corrections" in 2
days should have moved *something*, and it didn't. Investigated and found a real
bug: `recalibration.py` counts every `taxonomy_changes` row with `kind='catalog'`
as a correction that invalidates the last backtest — but `research.py`'s Sector-KPI
Research agent (daily as of Phase B, was monthly) writes its UNAPPLIED KPI
*proposals* under that same `kind`, indistinguishable from `validate.py`'s actually-
applied catalog fixes. A proposal nobody's reviewed yet cannot have moved a score.
Fixed by giving proposals their own `kind='catalog_proposal'` (`research.py`) —
confirmed via grep that no other code path reads `kind='catalog'`, so this is a
pure precision fix, not a behavior change anywhere else. Quality-Triage
(`kind='quality_check'`) and Model-Upgrade (`kind='model_routing'`) were already
correctly excluded from the count; Sector-KPI Research was the one gap, and it
only became a live problem once its cadence went from monthly to daily.

Lesson for next time: when a "material corrections" counter and a re-run's actual
numeric delta disagree, trust the numbers and go looking in the counter, not the
other way around.

---

## 2026-07-23 (later) — LLM path switched on in production

Right after PR #11 merged, the user gave the explicit go-ahead on the open
decision flagged in that PR: turn the LLM path back on in `refresh.yml`.
Added `OLLAMA_API_KEY`/`GROQ_API_KEY` to the workflow's `env:` (mirroring
`data-pipeline.yml`), dropped `--no-llm`, and added `--agent` (the Analyst
agent now runs every weekly refresh, matching its "per valuation run"
cadence in docs/AGENTS.md) alongside the already-conditional
`--model-upgrade` gate. `cheap_tags`/`smart_brief` — built long ago but dark
in production this whole time — are live now too. Everything still degrades
to the deterministic path if a model tier is ever unavailable; nothing here
is a hard dependency. Next real check: confirm the first live `refresh.yml`
run actually produces a non-fallback `smart_brief` and real `theses` rows.

---

## 2026-07-23 — Phase B: the last 3 agents (Quality-Triage, Model-Upgrade, Analyst)

User said "let's start phase B" after the Phase A hardening wrapped. Researched
first (docs/AGENTS.md, docs/ARCHITECTURE.md's Pillar 1/5 specs, docs/MEMORY.md,
existing agent code — `discover.py`/`research.py` — and the DB schema) before
writing any code, then had a Plan subagent turn that research into a concrete
design, verified its more surprising claims by reading the actual files myself
(all confirmed correct), then built all 3.

**What shipped:** `engine/qualitytriage.py`, `engine/modelupgrade.py`, and a
new `engine/agent/` package (`select.py`/`tools.py`/`react.py`/`reflect.py`/
`agent.py`) plus migration `0010_theses.sql`. Full design rationale lives in
ADR-019/020/021 and docs/PLAN.md's new "Phase B" section — not repeating it
here. Two things worth a future session re-reading before touching this code:

1. **No tool-use API exists anywhere in `engine/llm.py`** — checked both the
   Anthropic and OpenAI-compat branches of `_call()`; neither sends a
   `tools=`/function-calling parameter. The Analyst's ReAct loop is therefore a
   manual JSON-action-per-turn loop (model replies `{"thought","tool","args"}`,
   we dispatch and feed the result back), not a call into a real tool-use
   API. This was a deliberate choice (ADR-020), not an oversight — extending
   `llm.py` to support real tool-use is real scope creep against "build the 3
   agents" and would touch infrastructure every other agent depends on.
2. **`fetch_news` (Google News RSS, no key) is a genuine licensing judgment
   call**, not settled precedent — ADR-003's "redistribute only public-domain
   data" was written about what the public dashboard serves, and I read
   "an LLM transiently reads a few headlines to inform one sentence" as a
   different shape of use. Recorded explicitly as ADR-021 so it's a decision a
   future session (or the user) can revisit on its own terms rather than an
   implicit choice buried in `tools.py`.

**Testing:** no local Postgres was available this session (unlike the
corpactions work, which had one), so verification is scratch-tested against
the no-DB/no-LLM degradation paths every agent in this codebase is held to,
plus the DB-independent pure-Python logic (react loop step budget, JSON-parse-
failure handling, tool dispatch, a duplicate-kwarg-safety check for when the
model hallucinates a protected arg name, and Model-Upgrade's threshold logic
in both directions) via monkeypatched `llm.call`/`modelrouting.scorecard`. All
passing. Real end-to-end verification (actual `theses`/`taxonomy_changes` rows
landing, actual LLM tool selection) is still pending a live CI run against the
real DB and a configured model — flagged as the natural next check once this
merges, not claimed as already proven.

**Left open, flagged to the user rather than decided unilaterally:**
`refresh.yml` (the weekly production refresh) currently runs
`engine.cli refresh --no-cache --no-llm` and doesn't export
`OLLAMA_API_KEY`/`GROQ_API_KEY` at all — so the already-built `cheap_tags`/
`smart_brief` LLM path has been dark in production this whole time, not just
the new agents. Wiring in `--agent`/`--model-upgrade` accomplishes nothing
there until that's turned on. That's a bigger call than "add 3 agents" (it
activates a previously-dormant feature in the weekly cron), so it's a PR-review
question for the user rather than something bundled in silently.

---

## 2026-07-22 (even later) — corpactions-backfill.yml: 4 real CI failures, 4 real fixes

After PR #10 went up, subscribed to its activity and babysat `corpactions-backfill.yml`
through 4 consecutive failures — each one a genuinely different root cause, not the
same bug recurring, which is why each got its own fix rather than a blanket retry:

1. **Postgres catalog race.** The new migration 0009 landed in the same commit as an
   edit to `data-pipeline.yml`, so both workflows' push-triggered runs fired
   simultaneously and both tried `CREATE TABLE IF NOT EXISTS dividends` on the same
   production DB at once — `CREATE TABLE IF NOT EXISTS` is NOT safe under concurrent
   execution; Postgres can still raise `UniqueViolation` on the internal `pg_type`
   catalog entry. Confirmed with a local two-thread reproduction. Fixed:
   `db.apply_migrations()` now treats that specific race (UniqueViolation +
   "already exists" in the message) as success rather than a failure, since the
   loser of the race achieved the same end state as the winner.
2. **Zero progress visibility + too-aggressive pacing.** The next run consumed its
   full 30-minute timeout with NOT ONE LINE of output before being killed.
   `corpactions.py` had no progress logging anywhere, and its default pagination
   pacing (1s/page) was far more aggressive than `prices.py`'s proven-safe 13s/page
   for the same provider/tier — consistent with silent repeated 429 backoffs, though
   without any logging there was no way to actually confirm that from the log alone.
   Fixed: per-page progress prints, pacing matched to 13s, page size raised
   1000→5000 (incorrectly, see #3).
3. **`limit=5000` → 400 Bad Request.** The very next run "succeeded" in under a
   minute — but wrote zero rows. Both dividends and splits fetches 400'd instantly.
   The progress logging from fix #2 is what surfaced this cleanly: Polygon/Massive's
   v3 REFERENCE endpoints (dividends, splits) cap `limit` at 1000, a lower, different
   ceiling than the aggregates/grouped-daily endpoints `prices.py` uses (up to
   50000) — fix #2's own page-size bump had silently broken things. Reverted to
   1000. Also hardened `_get()` to include the response body in raised errors
   (`requests`' default discards it — exactly the detail that would have made this
   diagnosable on the FIRST 400, not after another guess-and-check round), and made
   the CLI exit non-zero when `ingest()` reports fetch errors, so a fully-failed run
   can't report a misleading green checkmark again.
4. **The real one: architecture, not a parameter.** With pacing and limit both
   correct, the next run made clean, steady, error-free progress — 394,000 dividend
   rows across 394 pages at a rock-solid ~13.5s/page — and STILL hit the 90-minute
   timeout mid-fetch, having not even started on splits. Worse: because the old
   design accumulated every page into a Python list and only wrote to Postgres
   ONCE, at the very end, ALL 394,000 already-fetched rows were discarded when the
   timeout cancelled the job. This was the "stop and reconsider the approach"
   moment flagged in my own check-in instructions rather than a 5th blind patch.
   Root cause: the "whole US market" (Massive's reference endpoints have no
   multi-ticker filter, so a bulk query can't ask for less server-side) is vastly
   bigger than our ~3,000-ticker tracked universe, and a full 2-year window was
   simply too much total data to fetch in one CI job at a safe pace. But the 2-year
   window itself was the wrong ask: `stockvaluation.py`'s `dividend_yield` only ever
   needs a TRAILING 12-MONTH window (see `_dividend_features`) — the 2y figure was
   copied from `prices.py`'s precedent (which genuinely needs deep history for
   backtesting) without checking whether corp actions needed the same depth. Fixed:
   shrunk `_FULL_DAYS` 730→400 (~13mo, covers TTM with a buffer — empirically
   roughly half the request volume) and `_INCREMENTAL_DAYS` 400→35 (the daily
   pipeline step needs to be fast, not just eventually-consistent); rewrote
   `_paginated`/`ingest()` to persist PER PAGE via an `on_page` callback instead of
   accumulating and batching at the end — verified with a new interruption-safety
   test (mocks a failure on page 2, confirms page 1's row is already durably in
   Postgres). Idempotent `ON CONFLICT DO NOTHING` means a run that still doesn't
   finish in one sitting isn't wasted — a re-fire makes real forward progress
   instead of repeating the same doomed fetch.

**Lesson for future capacity planning:** before defaulting a new bulk-fetch job's
window to match an existing job's precedent (prices.py's 2y), check whether the
NEW job's actual downstream need is the same depth — it often isn't, and copying
the number without re-deriving it from the actual requirement is how a 4x-larger-
than-necessary fetch volume ends up silently baked into a timeout budget.

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
