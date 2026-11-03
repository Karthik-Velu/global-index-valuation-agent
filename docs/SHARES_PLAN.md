# Share counts, done properly: staged plan (ADR-043)

Replaces the multi-class item that `docs/PLAN.md` carried until S0 (now the "Share counts,
done properly" checklist there) and the B1 / B1a method options in standup #58. The
decision is ADR-043 in `docs/DECISIONS.md`. File and line citations are to origin/main at
`e16e2ad`. Figures marked "cache" come from a companyfacts simulation over the
investigation's probe cache (688 CIKs, biased towards the flagged set, never committed);
`python -m engine.sharescensus --cache DIR` reproduces them, and the S0 census in CI
replaces each with a universe figure.

**Status.** S0's code has landed: `engine/sharescensus.py`, `engine/shares.py`,
`.github/workflows/shares-census.yml` and `tests/test_shares_census.py`. Next: dispatch the
census in `store` and then `companyfacts` mode, and record every threshold in JOURNAL and
PLAN before S1.

## What is wrong, in one paragraph

`shares_multiclass_unsummed` flags 691 issuers (1,287 rows) and `picks.EXCLUDE_CHECKS`
(`engine/picks.py:41-44`) keeps all of them out of picks and out of the screener's default
view. None of the 691 is an unsummed multi-class issuer: companyfacts carries no
dimensional facts, so the check can only see disagreement between vintages, and most of
that is legitimate split restatement or old scale and tagging slips that touch no number
we compute (prices start 2024-10-04). The defects that do move live market caps sit
elsewhere, and the check cannot see them.

| Live defect | Examples | Fixed in |
|---|---|---|
| Mislabelled check excludes 691 issuers | TSCO, WSM, CP, SHOE, IMAX, DLTR, AAPL | S3 |
| Ingest key `(sec_id, end, fp, mc, 'xbrl', filed)` at `edgar.py:173-176` has no concept, so Issued beats the dei cover and balance-sheet outstanding counts | EMN 1.96x, RDWR 1.49x, INMD 1.39x, AGNT 1.28x, FMC 1.20x, EDU, TEVA, DNA; MCD, CL, MMM, NOW, LECO, OI on stale January covers | S4, S5 |
| The same key mixes parent and consolidated numerators | `net_income` won by ProfitLoss for 15 of 685 cached issuers, `total_equity` by equity including NCI for 41; Magic Software, Steven Madden, Applied Digital | S5b |
| Dimensional-only or class-incomplete counts | META, CRWV: no count; MBLY 0.31x and HEI 0.39x of their own weighted average; BRK-B | S6 (weighted average), S9b and S10 (exact) |
| Single-vintage scale errors | SJ 34,743,152,000 shares from a 2022 6-K | S3 (quarantine), S5 (fix), S6 (fresh count) |
| Very old counts | 11 cached live counts older than twice the age limit (BRK 2011, REGN 2012, LEVI 2019) | S5 (quarantine past the ceiling), S6 (fresh count) |
| ADS ratios | BABA 8x too high | S5 (companyfacts tag), S10 (all ADS listings) |
| Security master | GOOG/GOOGL, BF-A/BF-B, LC/HAPN, AGGI/BSCL, TWOD, `'NONE.'`; XPRO and CLBK CIK overwritten at `edgar.py:154`; BRK-B may be unpriced | S8a, S8b, S8c; S8d (owner decision) |
| Split basis | live names between a split and their next filing; backtest dates between a split and the next filing (TSCO, Fridays 2025-01-03 to 2025-02-14); backtest dates before an in-window split (FAST, ORLY) read too cheap | S3 (quarantine after the split), S7b (factor for every date) |
| Missing inputs score "Cheap" | about 300 stocks with no multiples | S2 |
| USD market cap over non-USD fundamentals | every non-USD reporter | S2 |
| Same-day look-ahead | a 10-Q filed after the close on t is paired with close(t) | S7a |

## The approach

- Keep every share fact as a vintage with its accession, filing date, concept, duration and
  class member (`share_facts`, Tier B). Raw values are never changed.
- Resolve one economic share count per security per date, using only facts filed before
  that date, validated against evidence from the same filing and earlier filings.
- Make the numerators count the same owners as the shares (the parent's).
- When the rules cannot stand behind a value, quarantine the value: shares become NaN, so
  market cap and the multiples are NaN. The stock stays scored and visible. Never exclude
  the stock.
- Lift the blanket exclusion early (S3), behind measured gates, then fix the real defects
  stage by stage.

## Stage order at a glance

Eighteen PRs. Seventeen make up the share fix; S8d is a separate, owner-gated universe
decision that the share fix does not depend on.

| Stage | Title | SEC_USER_AGENT | Size | Corrects live |
|---|---|---|---|---|
| S0 | Share census (measurement) | companyfacts mode only | M | nothing (read-only) |
| S1 | Rules-version gate for both alert scopes, the feedback loop and the quality score | no | M | nothing |
| S2 | Missing or non-comparable valuation inputs | no | S | about 300 bogus "Cheap" labels; every stock and index row with a missing yield is scored on the yields it has; mixed-currency multiples |
| S3 | Lift the blanket exclusion; quarantine the live value; splits backfill | no (Massive key, in CI) | M | about 690 issuers back in picks; conflicting, outlier, post-split and non-positive counts NaN |
| S4 | `share_facts`: every share and proxy fact as a vintage | yes (backfill, daily ingest) | M | nothing (data only) |
| S5 | Resolver: accession-first selection with same-filing validation | no | L | EMN, FMC, MCD, CL, MMM and the collision set; scale fixes; BABA /8; counts past twice the age limit NaN |
| S5b | Parent numerators for P/E and P/B | no | S | P/E, P/B and earnings growth where the stored numerator includes NCI |
| S6 | Weighted-average fallback, class completeness, float unit check | no | M | META, CRWV and about 200 no-cap stocks; MBLY, HEI undercounts; BRK-B NaN |
| S7a | Knowledge cut-off | no | S | backtest only: a filing is no longer paired with its filing day's close |
| S7b | Split basis | no (Massive key, in CI) | L | split transients valued; every backtest date on one basis; returns and momentum |
| S8a | Price tickers for class listings | no | S | class-suffix tickers (BRK-B) priced |
| S8b | CIK history | yes | M | XPRO, CLBK; CIK changes recorded and verified, never silent |
| S8c | One listing per CIK in picks and the backtest | no | S | GOOG/GOOGL, BF-A/BF-B counted once in picks and rank-IC |
| S8d | Universe hygiene (owner decision, outside the share fix) | no | S | non-stocks and duplicate listings leave the stock ranks, if the owner approves |
| S9a | Instance and FSDS spike | yes | S | nothing |
| S9b | Per-class and ADS facts from filing instances | yes | L | nothing (data only) |
| S10 | Economic conversion: class sums and ADS ratios | yes (CI validation step; curation needs a person with SEC access) | M | BRK-B, GOOG/GOOGL, about 200 ADS listings |
| S11 | Remaining consumers, catalogue fix, legacy retirement | no | M | Key reports and the driver model match the screener; catalogue stops storing share counts as money and EPS |

Critical path to the owner's goal: S0, S1, S2, S3. The full fix: S4, S5, S5b, S6, S7a,
S7b. S7a moves no share count and can ship any time after S1. Under T6, S8a ships straight
after S0. S8b, S8c, S9a, S9b, S10 and S11 overlap once S5 is live, in the order the S0
thresholds set. S8d waits for the owner.

## Rules every stage follows

1. **Value, not stock.** No `shares_*` check ever enters `picks.EXCLUDE_CHECKS`. A
   quarantined value is a NaN share count. `picks.exclusion_reasons` (`picks.py:214-254`)
   lets a NaN market cap pass (`below_min_mcap` at `:245` is a positive test), so the row
   stays `data_ok` in the screener; the picks liquid gate
   (`market_cap.fillna(0) >= PICK_MIN_MARKET_CAP`, `picks.py:286`) keeps it out of picks.
   S2 lands first so a NaN market cap can never score "Cheap".
2. **Point in time.** Every decision uses facts filed before the date being scored,
   evidence from the same accession or earlier ones, and corporate actions executed on or
   before that date. Never a later filing, never a later split, never a modal vote across
   vintages. Every resolver stage carries a truncation-invariance property test: for each
   golden CIK and 20 random dates, resolving against the full store (facts and `splits`)
   equals resolving against a store cut at that date.
3. **Census gate.** Every stage that moves a share count or a numerator (S3, S5, S5b, S6,
   S7b, S8b, S10) re-runs S0 (companyfacts mode) with the stage's code. A market-cap or
   multiple move above 5% that the census did not predict blocks the merge. S2, S7a, S8a
   and S8c move no share count; each carries its own measured gate, stated in the stage.
4. **Gate bump.** Every stage that changes a value the screener, picks or backtest
   computes bumps `screenjobs.DATA_GATE_VERSION` (S1) in the same PR: S2, S3, S5, S5b, S6,
   S7a, S7b, S8a, S8b, S8c, S8d and S10. The version is a counter; each stage takes the
   next integer in merge order. The bump writes a `data_versions` row, which also makes
   the recalibration orchestrator recommend a re-backtest (S1), and makes that session's
   stock alerts and the next weekly market alerts diff against the previous run re-scored
   under the new rules, so data-driven changes do not alert and genuine moves still do.
5. **Backtest criterion.** After every stage that bumps `DATA_GATE_VERSION`, re-run
   `backtest.yml` and record rank-IC per signal and horizon in JOURNAL, with the stage's
   caveats. S3 changes cross-sections through quarantines; S8c changes them through the
   CIK dedupe (`backtest.py:331-337`), not through any value. If value or opportunity
   rank-IC at any horizon falls by more than two Newey-West standard errors
   (`backtest._newey_west_se`, `backtest.py:196`), the next stage waits until JOURNAL
   explains the drop. If the cause is a resolver bug (a golden or census regression), flip
   the kill switch and fix it. A correct fix is never reverted for IC alone. Every run
   between S3 and S7b carries the mixed-basis caveat: backtest dates before an in-window
   split pair a post-split bar with a pre-split count (S0 section J counts the pairs, T10),
   and no signal conclusion is drawn from such a run without it.
6. **Licensing.** `share_facts` and `share_counts` hold EDGAR data only. No Actions
   artifact or published file (census, dumps, `share_counts`) carries a price, close,
   market cap, price-derived ratio, a Massive corporate-action field (`split_from`,
   `split_to`, `execution_date`) or a value derived from one (a basis date, a basis method,
   a split factor). Each output has a schema test against
   `price|close|mcap|market_cap|split_from|split_to|execution_date|basis_|split_factor`.
   Split-basis decisions are made in memory at read time. Price-derived checks (the float
   unit check, S6) run in memory and their issue text and `value` carry no numbers.
7. **Kill switch.** `GIVA_SHARES_RESOLVER=legacy` restores the S3 path (legacy resolver plus
   the interim guard), in the style of `GIVA_TAGGING` (ADR-041). It never restores the
   blanket exclusion; S3's own rollback is under "Safe removal of the blanket exclusion".
8. **Tests and workflows.** Each stage's tests are plain scripts run as
   `python tests/test_x.py`, with no pytest, following `screens-tests.yml:85-100`. Each gets
   its own step there that installs what it needs: `pandas>=2.2` and `numpy>=1.26`, plus
   `duckdb>=1.0,<2` (the `requirements.txt` pin) for any test that uses in-memory DuckDB
   (S0, S3, S4, S5, S5b, S6, S7a, S7b, S9b). Each stage adds its new source files to both
   path-filter lists (`:16-38` and `:39-62`). Workflow files are landed by a session
   (ADR-042).
9. **Docs.** Each stage ticks its PLAN line, adds a JOURNAL entry with census numbers and
   updates STATUS. S0's PR prepends ADR-043.

---

## S0 Share census (measurement first)

**Goal.** Measure, across all ~3,100 securities, what each later stage would change; check
the companyfacts simulation against the rows the Tier B store actually holds; evaluate the
thresholds that re-order the plan. Read-only.

**Zero-code step, today.** Dispatch the existing `tierb-dump.yml` (choices at `:19-26`):
preset `shares_by_ticker` and preset `metrics_by_ticker` with metrics
`eps_basic_diluted,stock_based_compensation,net_income,total_equity`, for EMN, MCD, BABA,
SJ, META, CRWV, BRK-B, GOOG, GOOGL, TSCO, MBLY, HEI, CL, MMM, FMC, LEVI, AOS, BSCL, AGGI,
DSY, MGIC, SHOO, APLD. This shows what the store holds for the goldens before any code
exists. Done on 2026-10-31: the `--cache` simulation reproduced the store exactly for the
20 tickers with share rows (1,965 share rows, today's row for all 20, and 2,747 numerator
rows for the 11 tickers the truncated metrics dump holds in full); META and CRWV have no
share rows on either side, and MGIC is not in the store (its CIK, 876779, is listed as
RMTHF).

**One module, three modes.**
- S0a `--cache DIR` (local; no SEC, no database): the probe cache (688 CIKs). It tests the
  logic. Its numbers are biased towards the flagged set and never set a threshold.
- S0b `--store` (CI; `DATABASE_URL` and a read-only Tier B restore; no SEC): what the store
  holds, today's resolved row and live numerator rows per security, the interim-guard
  projection (S3).
- S0c `--companyfacts` (CI; needs `SEC_USER_AGENT`): every later stage's rules on fresh
  companyfacts, reconciled against S0b.

**Files and changes.**
- `engine/sharescensus.py` (new): promotes the investigation's probe scripts (the flag
  replication, the newest-accession band mini-census, the cached census, the same-filing
  classifier prototype and the numerator census). Reproduces
  today's row with `tierb.metrics_asof` (`tierb.py:417-441`) and
  `stockvaluation._resolve_shares_concept` (`stockvaluation.py:73-101`). Reads Postgres
  `securities`, `security_tags.sic_code` and `splits` (`0009_corp_actions.sql:31-42`);
  counts price rows per security (counts only, no values); fetches
  `edgar._companyfacts(cik, cache=False)` (`edgar.py:54-66`) at 5 requests per second or
  fewer.
- `engine/shares.py` (new, pure functions, not imported by the pipeline yet): `fact_rows`,
  `classify_accessions`, `select`. S0 runs the exact code later stages ship.
- `.github/workflows/shares-census.yml` (new): `workflow_dispatch` with input
  `mode: store | companyfacts`; `permissions: contents: read`; restores the Tier B cache
  read-only like `backtest.yml` and never saves; does not join the `tierb-writer` group.
- `tests/fixtures/shares/extract.py` and trimmed public-domain companyfacts fixtures in
  `tests/fixtures/shares/companyfacts/` for the golden CIKs.
- `docs/DECISIONS.md:10`: prepend ADR-043. `docs/PLAN.md:466-469`: replace with the
  stage checklist ("Share counts, done properly", S0 to S11).

**Report** (`data/shares_census.json` and `.csv`; aggregate counts plus per-ticker EDGAR
counts, ratios, dates and reason codes; no Massive field per ticker):

| Section | Measures | Threshold |
|---|---|---|
| A Population | securities with a CIK and with a share row; today's method split (dei, CSO, CSI) and count age; the old check reproduced (691 issuers, 1,287 rows) as a sanity line | |
| B Store vs simulation | today's stored row against the companyfacts simulation of today's ingest and resolver; mismatch rate and list | T11 |
| C Collision | per-security move under accession-first selection: counts above 1%, 5%, 20%, 2x; top 50 by log ratio; how many pick-eligible; how many in the 691 | T1 |
| D Interim guard | which securities the S3 rules would quarantine and why, re-run after the S3 splits backfill; for the 690 re-admitted and for the currently eligible set, the share whose live count is more than 1.25x from the same filing's weighted average | T2 |
| E Band | newest accession's cover, CSO and CSI over the validated weighted average, by concept; every out-of-band case labelled with a class from the table under the scale-error policy, or "unexplained" | T5 |
| F Weighted average | present in the newest periodic filing; mis-scaled against prior counts; p50 and p90 of log(C/W) on accepted pairs (the error bound of a weighted average used as a count); quarter-on-quarter drift | T3, T4 |
| G Missing and stale | no count today; recoverable by the weighted average; needing instance facts (BRK-type); past the 400/550-day limit and past twice it (cache: 21 and 11) | T3 |
| H Scale | classifier verdicts on own-date counts filed since 2023-07-01; every FIX and QUARANTINE in a newest accession; verdicts that flip when every band moves 10% | T5 |
| I ADS and currency | 20-F and 40-F filers; listings with `dei:EntityListingDepositoryReceiptRatio` and its effective dates; USD and non-USD reporters | T8, T14 |
| J Splits (counts only) | splits rows by year since 2023-01-01; securities with a live transient; securities whose EDGAR split-ratio tag (`StockholdersEquityNoteStockSplitConversionRatio1`, filed in the last 400 days) has no `splits` row (per-ticker rows carry only the EDGAR ratio and filing date); (security, rebalance date) pairs in the backtest window whose bar and count bases differ; bars fetched on an execution date. No execution date, ratio or ticker list from Massive | T9, T10 |
| K Security master | CIKs with more than one security; companyfacts CIK history vs `securities.cik`, each change classed verified or candidate by the S8b rules; tickers missing from SEC's ticker map; class-suffix tickers with zero price rows; SIC 6221 securities in the stock universe | T6, T7, T15 |
| L Numerators and NCI | the live `raw_tag` of `net_income` (the FY row `growthhistory.annual_series` keeps) and `total_equity` (the latest instant), counted by concept; for each consolidated winner, the same-context parent value, the NCI fact and the gap; NCI at 2% of equity or more; diluted/basic weighted average above 1.15 (Up-C and exchangeable candidates) | T13, T16 |
| M Volume | projected `share_facts` rows; census runtime | T12 |

**Thresholds that re-order the plan.**

| | Measure | Result and action |
|---|---|---|
| T1 | securities moving more than 5% in C | under 20 and none pick-eligible: ship S5 and S6 as one PR and one gate bump. Over 150: ship S5 alone with a one-day picks review before S6 |
| T2 | S3 quarantine size; re-admitted vs eligible out-of-band rate | quarantine above 2% of securities, or re-admitted rate above the eligible rate plus 1 point: S3 ships its first commit only (the guard, with check 7 and the exclusion kept); its second commit, the removal, moves to S6 |
| T3 | missing, stale or class-incomplete securities with a valid weighted average in the newest periodic filing | 80% or more: keep the order. Under 50%: move S9b ahead of S6 and treat S6 as partial |
| T4 | p90 of log(C/W) on accepted same-filing pairs | above 5%: the S6 fallback takes only a weighted average whose period ended within 200 days |
| T5 | accepted C/W p1 and p99; unexplained share of out-of-band cases | p1 or p99 outside [0.67, 1.5], or unexplained above 10%: re-derive the bands before S5 freezes `rules_version` 1 |
| T6 | class-suffix tickers with zero price rows | any: ship S8a straight after S0 |
| T7 | SIC 6221 or other non-common securities in the stock universe | any: put the S8d universe-hygiene decision in #58 for the owner |
| T8 | ADS listings carrying the companyfacts ratio tag | 50% or more: S5 covers most ADS listings and S9b's ADS work shrinks to the rest. Under 10%: S9a, S9b and S10 move ahead of S8b for 20-F and 40-F filers |
| T9 | live split transients; in-window splits | 5 or more transients at once, or 30 or more in-window splits: move S7b ahead of S6, straight after S5 |
| T10 | (security, rebalance date) pairs whose bar and count bases differ | any: S3's backtest re-run records the count as its mixed-basis caveat; no signal conclusion until S7b's re-run |
| T11 | store vs simulation mismatch | above 2% of securities: investigate the ingest and dedupe path before S5; goldens are re-derived from the store |
| T12 | projected `share_facts` rows | above 8M: ingest EPS and net income proxies only for filings since 2019 |
| T13 | issuers with material NCI or exchangeable units | 20 or more with an ownership gap above 5%: bring the P/S and P/CF convention decision forward to S6 |
| T14 | non-USD reporters | above 300: put the FX conversion decision ahead of S10 |
| T15 | CIKs with several listings that are not class listings | any: they go on the S8d retirement list for the owner |
| T16 | securities whose live `net_income` or `total_equity` is a consolidated concept with a same-context parent value more than 2% away | 20 or more: S5b ships straight after S5, before S6. Otherwise it may follow S6 |

**Tests.** `tests/test_shares_census.py` over the fixtures: EMN collision ratio 1.960
(224,221,189 issued against cover 114,380,456); FMC 1.196; BABA unchanged at
18,580,374,278 with the 1,858,037,427 cover rejected and ratio facts 1 (to 2019-07-29)
and 8 (from 2019-07-30); SJ stale and 832x its own FY2025 weighted average of 41,776,414;
META and CRWV with no count and a weighted average; BRK with neither after 2015; MCD's
fresher cover 707,641,531 and its weighted average in millions (about 709); TSCO tagged
split ratio 5; MBLY class-incomplete at 0.31; AAL cover dated 2027-07-17; a Magic-shaped
IFRS issuer whose live `net_income` is `ifrs-full:ProfitLoss` with its parent value found
in the same accession. Guard test: no output column matches the rule 6 pattern, and the
module never reads price values.

**Acceptance.** Covers at least 98% of securities with a CIK; reproduces 691 issuers and
1,287 rows; writes every section; runs in under 60 minutes; every threshold is evaluated
and recorded in JOURNAL and PLAN.

**SEC_USER_AGENT.** S0a and S0b no; S0c yes (CI has it).

**Corrects live.** Nothing.

---

## S1 Rules-version gate for both alert scopes, the feedback loop and the quality score

**Goal.** Let later stages move many values without a wave of saved-screen alerts, stock
or market, without silencing genuine moves, and with a machine-readable marker that the
market feedback loop, the recalibration orchestrator and the quality score all read.

**Files and changes.**
- `engine/screenjobs.py:53-66`: `DATA_GATE_VERSION = 1` and `DATA_GATE_NOTE`, with the
  rule: bump in the same PR as any change that moves a value the screener, picks or
  backtest computes (rule 4).
- `engine/screenjobs.py:231-249` (`publish_stock_snapshot`): `payload["gate"]`; docstring
  at `:32-36`.
- `engine/screenjobs.py:187-197` (`previous_snapshot`): also returns `payload->'gate'`
  (missing means 1).
- `engine/screenjobs.py:566-595` (`_run_daily`): when the previous gate differs, re-score
  the previous session under the new rules
  (`project_stock_rows(stockvaluation.score_frame(prev_asof), flagged)`) and pass it as
  `run_alerts(..., baseline_rows=..., baseline_asof=prev_asof)`. Insert one `data_versions`
  row (`0005_quality_recalibration.sql:20-27`) per version, with note
  `rules v<N>: <note>` and the newest auto snapshot's `n_securities`,
  `n_fundamental_rows` and `corrections_to_date` copied in. `backtest._persist` links the
  newest `data_versions` row (`backtest.py:382`), so a backtest run on a bump day links the
  rules row instead of that day's auto snapshot; the copied counts keep the vintage size
  on it, and `metrics.rules_version` (below) records the version whatever row is linked.
- `engine/screenjobs.py:403-492` (`run_alerts`): with `baseline_rows`, a screen whose
  `last_evaluated_asof` equals `baseline_asof` diffs against
  `screens.matching_keys(filter, baseline_rows)` instead of `last_matches` (counted
  `rebased_on_rules`). A screen last evaluated on another date (it was `skipped_shrunk`,
  untrusted, new or invalid that day) has no comparable baseline, so it is re-baselined:
  it stores today's matches and alerts nothing (counted `rebaselined_on_rules`).
  Savepoints, the shrink guard and retention are unchanged.
- Market scope, `engine/pipeline.py:253-265` and `screenjobs.run_market_alerts`
  (`:495-514`): the scoreboard JSON carries `meta.gate`. Before the weekly market alerts,
  read the previous week's `dashboard/dashboard_data.json` (committed by
  `refresh.yml:89-95`, still unchanged when `pipeline.py:263` runs). When its `meta.gate`
  (missing means 1) differs, re-score its scoreboard rows with `metrics.compute` (they carry
  every input: `pe`, `pb`, `ps`, `pcf`, `dividend_yield`, returns, moving-average ratios,
  growth, `kind`; `pipeline.py:35-47`) and pass them as `baseline_rows`, with
  `baseline_asof` its `asof`. If the re-score fails, the market screens are re-baselined
  without alerting (counted), never diffed against rows scored under the old rules.
- `engine/quality.py`: `CHECKS_VERSION = 1` and `CHECKS_CHANGED_ON`; the report
  (`:315-327`) gains `checks_version`, `checks_changed_on` and `by_check_scored` (warn and
  error only). `engine/dailyplan.py:214-222` and `:378-382` carry them and print "check
  definitions changed on <date>" for 7 days after a change, so the daily plan reads a
  score step as a definition change, not a data change.
- `engine/qualitytriage.py:22-23`: rank `by_check_scored` when present, so info rows never
  become the triaged checks.
- `engine/recalibration.py:71-74`: `rules_since = _count_since(cur, "data_versions", last_ts,
  "note like 'rules v%'")`. Any rules row since the last backtest recommends
  `full_rebacktest` (kind `rules_change`), and the evidence records it. Today only catalogue,
  source and error corrections count as material, so a rules bump would never trigger the
  recommendation and rule 5 would rest on manual re-runs alone. The recalibration step
  (datapipeline step 6) runs before the screens step (7b), so the recommendation appears in
  the run after the bump.
- `engine/ledger.py:246` (`accuracy_summary`): report rank-IC separately for predictions
  made since the latest `rules v` row. `engine/backtest.py:382-395`: write
  `metrics.rules_version`.

**Schema and backfill.** None (one JSONB field, one JSON field; `data_versions` rows).

**Tests.** `tests/test_screenjobs.py` (fictitious tickers, per its convention):
- gate unchanged: alerts as today;
- gate bumped with baseline rows where FXEMN's P/E halves (a data change) and FXMOVE
  crosses a screen on price: FXEMN raises no alert, FXMOVE does; the next run alerts
  normally; a payload without `gate` triggers nothing on deploy;
- a screen last evaluated two sessions before `baseline_asof` is re-baselined, not diffed;
- market scope: a bumped `meta.gate` where FXMKT's value score moves only because of the
  rules change raises no alert, a market that moved on price does; a failed re-score
  re-baselines.

`tests/test_dailyplan.py`: the annotation. A triage test: info checks are never in the top
four. `tests/test_recalibration.py` (new, fake cursor): one rules row since the last
backtest recommends `full_rebacktest`; none leaves today's behaviour.

**Acceptance.** Deployed at version 1, the screens step output and the weekly market
alerts are identical; the extra `score_frame` runs only on bump days and takes under 3
minutes; `screens-tests.yml` green.

**SEC_USER_AGENT.** No. **Corrects live.** Nothing.

---

## S2 Missing or non-comparable valuation inputs

**Goal.** Before any stage produces NaN market caps, make sure a missing input can never
make a stock look cheap (`PLAN.md:462-465`, which asks for exactly this rule), and stop
dividing USD market caps by non-USD fundamentals.

**Scope, stated fully.** Today `metrics.compute` adds each yield's z-score with
`fill_value=0.0` and divides by the full weight sum (`metrics.py:53-59`), so a missing
yield counts as an average one. Dividing by the weights present changes `value_raw` for
every row with any missing yield, not only the about 300 stocks with none: P/E coverage is
only about 0.64 on a healthy day (`screenjobs.py:177-178`), so about a third of stocks
(loss-makers) move, and so do index rows with a missing P/E, P/B, P/S or P/CF. Rows with
every yield present keep an identical `value_raw`; their `value_score` can still move,
because the percentile rank within `kind` re-sorts around them.

**Files and changes.**
- `engine/metrics.py:52-59`: `value_raw` is the weighted z-sum over present yields divided
  by the present weights; NaN when none of earnings, book, sales or cash-flow yield is
  present (dividend yield alone is not a valuation: it is filled with 0.0 at
  `metrics.py:50` and `stockvaluation.py:363`).
- `engine/metrics.py:62-65`: `overvalued` is False when `value_raw` is NaN.
- `engine/metrics.py:122-130`: the opportunity blend uses `value_score.fillna(50)` as a
  neutral input, as `growth_score_eff` does at `:117`; `value_score` itself stays NaN.
- `engine/metrics.py:132-144`: `value_trap` and `garp` require a real score; `value_band` is
  None, not the string `'nan'`.
- `engine/stockvaluation.py:359-362`: P/E, P/B, P/S and P/CF only where
  `reporting_currency` is USD or unknown. Index-level scoring is untouched by this line.
- Bumps `DATA_GATE_VERSION`; S1 rebases both alert scopes.

**Schema and backfill.** None.

**Tests.** `tests/test_metrics.py` (new, synthetic, plain script): a CRWV-shaped row with
no multiples scores NaN, band None, not GARP, not overvalued; a P/E-only row's `value_raw`
equals its E/P z-score; a row with every yield present has a bit-identical `value_raw`;
`tests/fixtures/screen_markets.json` rows with every yield present are unchanged; a
JPY-reporting row gets NaN multiples.

**Measured gate (S2's own; the census does not cover it).** A shadow run of today's
`score_frame` and the latest index frame under the old and new `metrics.compute`, written
to the PR (counts only):
- invariant: every stock and index row with all four yields present has a bit-identical
  `value_raw`, or the merge is blocked;
- the stock `value_band` transition matrix (Expensive, Fair, Cheap, None), split by rows
  with and without a missing yield;
- the number of stocks whose `value_score` moves more than 10 points, split the same way;
- every index row whose value score or band moved, with its missing inputs;
- the picks diff (tickers only).

**Acceptance.** No stock with zero valuation inputs is "Cheap" (about 300 of about 330
today); the invariant holds; the shadow report is in the PR; the backtest criterion holds.

**SEC_USER_AGENT.** No.

**Corrects live.** About 300 stocks lose a bogus "Cheap", GARP or value-trap label. Every
stock and index row with a missing yield is scored on the yields it has. Non-USD reporters
(already hidden by `non_usd_reporter` and out of picks) lose multiples, so domestic peers'
z-scores stop mixing currencies.

---

## S3 Lift the blanket exclusion; quarantine the live value

**Goal.** The owner's goal, early. Retire `shares_multiclass_unsummed` and its exclusion,
and put a value quarantine on today's share count using only rows the store already holds
plus a splits backfill. The re-admitted stocks are then no riskier than the ~2,400 never
flagged: the collision and stale-count defects hit both groups alike, and the undercounts
that create false picks (MBLY-type) were never visible to the old check.

**Two commits, so that the T2 fallback and the rollback are exact.**

*Commit 1, the guard (safe alone; removes no exclusion):*
- **Splits backfill.** `engine/sources/corpactions.py:153-253`: `ingest(..., kinds=("dividends",
  "splits"))` and CLI `--splits-only` beside the existing `--start` (`:256-274`).
  `.github/workflows/corpactions-backfill.yml:62-97` gains a `workflow_dispatch` input
  (`mode: full | splits_since_2023`); the second runs
  `ingest --splits-only --start 2023-01-01`. Every recorded splits window so far is the
  400-day `_FULL_DAYS` window (`corpactions.py:67`; `JOURNAL.md:481` records 2025-08-02 to
  2026-09-06 for the September sweep), so TSCO (2024-12-20) and FAST (2025-05-22) have no
  row, and ORLY (2025-06-10) probably none. The 2023 start covers counts up to 550 days old
  at the 2024-10-04 price start. Whole-market splits are a small fraction of the dividend
  volume that made the 2-year pull fail, so the run fits the 90-minute job. It is
  dispatched from the S3 branch before the merge gates are measured: it only inserts
  `splits` rows (ON CONFLICT DO NOTHING), which no current code reads for values
  (ADR-018). The daily 35-day and monthly 400-day windows are unchanged, and rows persist.
- **Vintage read.** `engine/tierb.py`: `metric_vintages(asof, metric_code, security_ids,
  con=None)`, every vintage filed on or before asof with no `qualify`, because
  `metrics_asof` keeps only the latest vintage per `(period_end, fiscal_period)`
  (`tierb.py:435-441`) and rule (a) needs every vintage of the live row.
- **Restructure.** `engine/stockvaluation.py`: a new `shares_frame(asof, security_ids,
  con=None)` runs `metrics_asof` for `shares_outstanding` only, `_resolve_shares_concept`,
  then keeps the latest row per security with its `raw_tag`, `period_end` and
  `filed_date` (before any pivot: `_nth_per_security`, `:104-114`, pivots them away, and
  rules (a) and (c) need them), then `_interim_guard`, and returns `shares_outstanding,
  shares_raw_tag, shares_period_end, shares_filed_date, shares_flags`.
  `_fundamentals_frame` (`:117-188`) takes the shares column from it; `INSTANT_CODES` keeps
  `total_equity` on the existing path.
- **The guard.** Shares become NaN, with a reason code in `shares_flags`, when:
  - (a) **conflict:** the live row's `(period_end, raw_tag)` carries two or more values more
    than 1.5x apart among vintages filed on or before asof (the old check's own test,
    applied to the live row only; DSY today), unless a `splits` row executed between the
    two vintages' filing dates explains the ratio within 25%;
  - (b) **outlier:** the live count is more than 3x or under a third of the median of the
    security's resolved counts in the 400 days before its period end, and no `splits` row
    executed in that window explains the ratio within 25% (SJ, 2,245x its neighbours;
    BSCL's 1-for-500 passes once its split row exists);
  - (c) **after a split:** a `splits` row has `execution_date` after the count's basis date
    and on or before asof. The basis date is the count's period end for the dei cover (it
    reflects no split after its own date) and its filing date for CSO and CSI (SAB Topic 4C
    restates balance-sheet counts through the issue date). A bar dated on or after the
    split is on the post-split basis whenever it was fetched, so the count and the price
    disagree. Live, that is a name that split since its last filing. In the backtest, it is
    the dates between an in-window split and the next filing: TSCO's affected dates are the
    Fridays from 2025-01-03 to 2025-02-14, since `backtest._default_window` starts at the
    price start plus 90 days (`backtest.py:96-108`) with a `W-FRI` cadence;
  - (d) the value is zero or negative.
- **Why rule (c) uses only splits on or before asof.** Quarantining every date before a
  split whose bar was fetched later would make the cross-section at t depend on a split
  after t, and future splitters (usually past winners) would drop out of earlier periods.
  So S3 leaves those dates as they are today, a post-split bar paired with a pre-split
  count (FAST from 2025-01-03 to its 2025-05-22 split reads 2x too cheap, ORLY 15x), and
  records them: S0 section J counts the pairs (T10), and every backtest run until S7b
  carries the caveat (rule 5). S7b corrects them with the split factor, which needs no
  quarantine.
- **Quality data flow.** `quality.run()` runs at datapipeline step 5 (`:229`), before the
  screens step (7b, `:262-278`), and never calls `score_frame`. So `engine/quality.py`
  gains `_shares_checks(duck, cur)` in the Tier B path (`_checks_tierb`, `:177-279`), which
  calls `stockvaluation.shares_frame(date.today(), stock_ids, con=duck)`, the same function
  `score_frame` uses, and reads `splits` through `cur`. It needs no price read and is not a
  second scoring: one metric code, one vintage query, one Postgres read (under 30 seconds).
  It emits `shares_value_quarantined` (warn, `value` None, the detail a reason code only).
  The Postgres twin gets a comment: share checks are Tier B only, since Postgres holds no
  fundamentals after the cutover.
- Bumps `CHECKS_VERSION` and `DATA_GATE_VERSION`.

*Commit 2, the removal:*
- `engine/quality.py:141-173` and `:265-278`: delete check 7 in both twins and leave a
  pointer to ADR-043; this also removes the `ADR-027` mis-citation at `:154`.
- `engine/quality.py:30`: drop `shares_outstanding` from `_CURRENCY_NONNEG`.
  `negative_value` (`:191-200`) scans every vintage with no age filter and is itself in
  `EXCLUDE_CHECKS`, so one historical negative row excludes an issuer today (Group 1,
  Byrna). Rule (d) handles live values.
- `engine/picks.py:39-44`: remove `"shares_multiclass_unsummed"`; update the comment ("690
  tickers") and the docstring at `:10-13`. No share check is added.
- `engine/tierbdump.py:40-58` and `:135` (`preset in ("multiclass_shares", ...)`): rename
  `multiclass_shares` to `share_vintage_conflicts` (diagnostic only) and fix the `ADR-027`
  citation at `:41`; `.github/workflows/tierb-dump.yml:21` (the default) and `:23` (the
  option) follow.
- Bumps `CHECKS_VERSION`.
- No change needed to `tests/test_dailyplan.py:123,145,151` (a synthetic report) or
  `tests/fixtures/jobs_picks_golden.json` (its frame carries no such flag); the
  `EXCLUDE_CHECKS` assertions in `tests/test_screenjobs.py:163,203,247` are dynamic. The PR
  says so.

**Schema and backfill.** No schema change. One `corpactions-backfill.yml` dispatch with
`mode: splits_since_2023`.

**Tests.** `tests/test_shares_interim.py` (in-memory DuckDB, plain script):
- DSY-shaped conflict is NaN; a TSCO-shaped restated vintage with its split row is kept;
- SJ-shaped outlier is NaN; a BSCL-shaped reverse split is kept with its split row and NaN
  without;
- TSCO-shaped split: the count filed 2024-11-07 is NaN at 2025-01-10 (split executed
  2024-12-20, before asof), is not quarantined at 2024-11-15 (the split is after asof, so
  that date keeps its mixed basis and is counted), and the count filed 2025-02-20 is used
  at 2025-03-01;
- a negative count is NaN; the live rows of TSCO, WSM, CP, SHOE, IMAX, DLTR and AAPL are
  unchanged;
- truncation invariance over `splits` as well as facts;
- `quality._shares_checks` and `score_frame` give the same verdict per security.

`tests/test_screenjobs.py`: FXTSCO, flagged only by the old check, becomes `data_ok`. A
quality test: no issue named `shares_multiclass_unsummed` is ever produced (commit 2).

**Acceptance (merge gates).** See "Safe removal of the blanket exclusion" below: G1 to G5,
plus the quality-score change reported exactly (about +20: the check is 1,287 of 1,771
open issues), and the backtest re-run with the mixed-basis caveat (rule 5).

**SEC_USER_AGENT.** No (the G1 measurement comes from S0c in CI; the backfill needs the
Massive key, a CI secret).

**Corrects live.** About 690 issuers return to picks, on-sale and the default screener
view. Conflicting, SJ-type, post-split and non-positive counts become NaN instead of
wrong. Backtest dates between an in-window split and the next filing become NaN instead of
off by the split ratio; dates before a split keep today's mixed basis until S7b.

---

## S4 `share_facts`: every share and proxy fact as a vintage

**Goal.** Persist every share and proxy fact with its accession, filing date (the
knowledge date), namespaced concept, duration and class member, keyed by CIK. This
recovers the dei and outstanding counts the ingest key drops (in 606 of 623 cached issuers
companyfacts lists Issued first) and the parent numerators it drops, without touching
`fundamental_metrics` or `FM_KEY` (`tierb.py:46`), which every metric reads. No consumer
yet.

**Files and changes.**
- `engine/tierb.py:42-64`: `SF_COLUMNS`, `SF_KEY`, `SF_APPEND_COLUMNS`, `_SF_DDL`.
- `engine/tierb.py:91-124`: `_sf_dir()`, `_sf_globs()`, `have_share_facts()`;
  `:167-183` registers a `share_facts` dedupe view (first `ingested_at` wins);
  `:230-284` adds `append_share_facts()` (the `append_metrics` anti-join) and an
  `append=` parameter on `MetricWriter` so one buffered, error-capturing writer serves both
  datasets; `:444-473` counts and stats; the layout docstring at `:8-16`.
- `engine/shares.py`, `SHARE_CONCEPTS`: dei cover count; CommonStockSharesOutstanding,
  CommonStockSharesIssued, TreasuryStockShares, TreasuryStockCommonShares; ifrs-full
  NumberOfSharesOutstanding.
- `engine/shares.py`, `PROXY_CONCEPTS`:
  - weighted averages: basic, diluted and basic-and-diluted; ifrs-full WeightedAverageShares;
  - EPS: basic and basic-and-diluted; ifrs basic EPS;
  - net income, parent and consolidated: NetIncomeLoss,
    NetIncomeLossAvailableToCommonStockholdersBasic, ProfitLoss,
    NetIncomeLossAttributableToNoncontrollingInterest; ifrs-full ProfitLoss,
    ProfitLossAttributableToOwnersOfParent, ProfitLossAttributableToNoncontrollingInterests;
  - equity, parent and consolidated: StockholdersEquity,
    StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest, MinorityInterest;
    ifrs-full Equity, EquityAttributableToOwnersOfParent, NoncontrollingInterests;
  - dei EntityPublicFloat; dei EntityListingDepositoryReceiptRatio;
    StockholdersEquityNoteStockSplitConversionRatio1.

  `fact_rows(cik, facts)` emits every fact; there is no `setdefault`.
- `engine/sources/edgar.py:103`: a second writer,
  `tierb.MetricWriter(append=tierb.append_share_facts)`. After the successful write
  (`:212-213`), `share_writer.add(shares.fact_rows(cik, facts))`; close it and report
  `tierb_share_facts` beside the existing writer's close and report at `:219-224`. The
  Postgres insert (`:191-199`) and `metric_rows` are untouched, so the legacy rows keep
  feeding S3 and the kill switch.
- `engine/tierbsync.py:230-256`: `compact()` folds `share_facts` deltas, partitioned by
  `year(filed_date)`; `bundle()` (`:259-268`) already tars the root.
- `engine/shares.py backfill [--ciks]`: one companyfacts fetch per distinct CIK (GOOG and
  GOOGL share one), resumable, `--max-minutes`.
- `.github/workflows/share-facts-backfill.yml` (new): `concurrency:
  tierb-writer-${{ github.ref_name }}` as at `data-pipeline.yml:39-40`; restore, hydrate and
  save copied from `price-backfill.yml`; `SEC_USER_AGENT`; compacts at the end.
- `.github/workflows/data-pipeline.yml:121-132`: the store readability check also opens
  `share_facts` once `have_share_facts()`.
- `engine/tierbdump.py`: preset `share_facts_by_ticker` (EDGAR only).

**Schema.** Tier B dataset `share_facts`:
- layout `<root>/share_facts/base/year=YYYY/*.parquet` and `<root>/share_facts/delta/part-*.parquet`;
- columns: `cik BIGINT, accession VARCHAR, filed_date DATE, form VARCHAR, fiscal_year INT,
  fiscal_period VARCHAR, concept VARCHAR, class_member VARCHAR, period_start DATE,
  period_end DATE, duration_days INT, unit VARCHAR, value DOUBLE, value_text VARCHAR,
  decimals INT, source VARCHAR, ingested_at TIMESTAMPTZ`;
- key `(cik, accession, concept, class_member, period_end, duration_days, unit)`, every key
  column NOT NULL with sentinels (`class_member ''` when non-dimensional, `duration_days 0`
  for instants), so the existing anti-join and dedupe patterns work unchanged;
- `value` is as filed, never altered (ADR-005); `value_text` is NULL from companyfacts and
  carries `TradingSymbol` and `Security12bTitle` from instances (S9b);
- `source` is `companyfacts`, `xbrl_instance` or `fsds`. No Postgres change.

**Backfill.** One `share-facts-backfill.yml` dispatch: about 3,100 companyfacts requests at
5 per second or fewer, about 15 to 25 minutes; then the daily ingest of recent filers keeps
it current and the monthly re-feed is idempotent. About 1,600 rows per issuer in the cache
with the numerator concepts (46% of the rows), so about 5.0M rows (T12; S0 section M).

**Tests.** `tests/test_share_facts.py` (in-memory DuckDB, plain script): EMN keeps both dei
114,349,960 and CSI 224,190,693 in accession 0000915389-26-000099 (today's key keeps only
the CSI); MCD keeps dei 707,641,531 and CSI 1,660,600,000 at 2026-06-30; META keeps its
3-month weighted average 2,552,000,000 and its 9-month 2,543,000,000 as two rows; BABA
keeps both ratio facts (1 to 2019-07-29, 8 from 2019-07-30); a Magic-shaped IFRS issuer
keeps ProfitLoss and ProfitLossAttributableToOwnersOfParent as two rows; a second identical
append adds 0 rows; a re-feed with one new accession adds exactly its rows; no NULL key;
`MetricWriter(append=...)` captures errors; the legacy metric rows for every fixture hash
identically before and after.

**Acceptance.** Every active security with a CIK has rows or is on the census "no
companyfacts" list; row count within 20% of the projection; the daily pipeline gains under
3 minutes; the first monthly sweep after merge gains under 10 minutes (ADR-041 budget);
every score and flag byte-identical.

**SEC_USER_AGENT.** Yes, for the backfill and the daily ingest (CI has it).

**Corrects live.** Nothing.

---

## S5 Resolver: accession-first selection with same-filing validation

**Goal.** Fix today's count everywhere it comes from a collision survivor, a stale cover or
a scale slip: the newest periodic accession filed before the date wins; within it the
cleanest concept wins; each candidate is checked against independent evidence from the same
filing and earlier filings; bad values are quarantined.

**Files and changes.**
- `engine/shares.py`, `classify_accessions(rows, prior, splits)`. It is asof-invariant: a
  verdict uses only the accession's own facts, earlier accessions and splits executed on or
  before its filing date.
  - **Own-date candidates:** the cover count at the accession's latest dei date, unless that
    date is more than 120 days before `filed_date`; CSO and CSI at the accession's period
    end (the latest end of its duration facts); `issued_minus_treasury` from the same
    accession and date; the basic weighted average with the shortest duration ending at the
    period end (used from S6). Comparatives and date-mixed contexts are history, never
    candidates.
  - **Evidence groups, one vote each:** cover; balance sheet; income (net income over basic
    EPS for the same duration, with |EPS| of at least 0.05 and matching currencies, else the
    weighted average; NI/EPS and the weighted average count as ONE group because they share
    the filer's income-statement scaling: SHOE's 2012-12-06 10-Q tagged both in
    thousands); prior (the previous accession's validated count, adjusted in memory for
    splits executed on or before this filing date).
  - **The weighted average is checked first:** rejected as evidence and as a fallback when it
    is about 10^k away from the log-median of the issuer's counts accepted in the prior 400
    days (k of plus or minus 3 within 30%, or plus or minus 1 within 3%): MCD about 709, WAT
    98.2B, AVXL 92.7B.
  - **Verdicts** follow the scale-error policy below. CSO equal to CSI in the same
    accession, with treasury shares reported, is treated as an issued count (EMN's FY 10-K
    tags CSO 223,938,047, its issued number).
  - **Future-dated covers:** a period end more than 31 days after `filed_date` sets
    `count_date` to `filed_date` (AAL 2027-07-17, REPX 2029-04-03), so staleness never sees
    a fake date.
- `engine/shares.py`, `build_counts()`: writes the derived
  `<root>/share_counts/share_counts.parquet`, rebuilt and swapped in full each run like the
  filings mirror (`tierb.py:179-182`).
- `engine/shares.py`, `economic_shares_asof(asof, security_ids)`:
  - **Visible accessions:** periodic forms (`edgar.FUNDAMENTAL_FORMS`, `edgar.py:232-234`)
    filed by asof, using the same cut-off as `tierb.metrics_asof` through one constant,
    `tierb.FILED_BEFORE_ASOF` (False until S7a flips it); 6-K counts only with at least one
    agreeing group; 8-K never.
  - **Selection:** the newest visible accession with a usable candidate. Within it: cover,
    then CSO, then `issued_minus_treasury`, then CSI (only at 1.15x the same filing's
    validated weighted average or less, or when there is none). If none is usable, step back
    one accession and flag `shares_stale_accession`.
  - **Age:** a count older than `MAX_COUNT_AGE_DAYS` (400; 550 when the newest periodic form
    is a 20-F or 40-F, whose cover is dated at year-end and filed up to four months later)
    is kept but flagged `shares_stale` (warn); S6 replaces it. A count older than twice the
    limit (800; 1,100) is NaN (`shares_value_quarantined`, reason `stale_beyond_ceiling`),
    whatever T1 decides about merging S5 and S6. In the cache 21 live counts are past the
    limit and 11 past the ceiling: BRK (2011), REGN (2012), Phibro (2014), LEVI (2019), WMG
    and AOS (2020), VICR and Gray (2021), SoundHound and Scienjoy (2022), Baijiayun (2023).
  - **ADS:** where companyfacts tags `dei:EntityListingDepositoryReceiptRatio`, the ratio in
    effect at `count_date` (the latest effective date on or before it, among facts filed by
    asof) converts ordinary shares to ADS units. BABA tags 1 to 2019-07-29 and 8 from
    2019-07-30 (its 8-for-1 subdivision), so the effective date matters. A 20-F or 40-F
    filer with no ratio keeps ratio 1 with the info flag `ads_ratio_unverified`.
  - **Splits:** the S3 rule (c) carries over until S7b.
  - **Output (in memory, never written to a file):** `security_id, shares_outstanding`
    (listing units), `shares_method, shares_count_date, shares_accession, shares_filed_date,
    shares_flags`.
- `engine/stockvaluation.py:37-41`: `INSTANT_CODES = ("total_equity",)` when the resolver is
  on. `shares_frame` (S3) calls `economic_shares_asof` and keeps its signature, so
  `_fundamentals_frame`, `score_frame` and `quality._shares_checks` all switch at once. A
  security whose CIK has no `share_facts` rows uses the S3 path (per-security legacy
  fallback); the kill switch restores it for all. `:358` is unchanged.
- `engine/datapipeline.py`, a new step 2f after corporate actions (2d, `:177-191`) and
  before tagging and quality (step 5, `:229`): `steps["shares"] = shares.build_counts()`,
  non-fatal (on error the previous file is used). It must follow corporate actions because
  `classify_accessions` reads `splits`: a split ingested that day is then seen the same day.
- `engine/quality.py` (`_shares_checks`, now fed by `economic_shares_asof` over
  `share_counts.parquet`, still no second scoring): `shares_value_fixed` (info),
  `shares_value_quarantined` (warn), `shares_stale` (warn), `shares_count_date_future`
  (info), `ads_ratio_unverified` (info). Bumps `CHECKS_VERSION`.
- `docs/DATA_INGESTION.md`: share-facts section. Bumps `DATA_GATE_VERSION`.

**Schema.** Derived Tier B file `share_counts.parquet`, deterministic and fully rebuildable,
EDGAR-only: `cik, accession, filed_date, form, candidate, class_member, count_date,
value_raw, value_clean (NULL = quarantined), verdict, fix_code, reason, votes (JSON of group
verdict labels), rules_version, built_at`. No price-derived column and no Massive field or
value derived from one: a vote that a split explains records only the label
`split_explained`, never a ratio or a date from `splits`. A schema test enforces rule 6, so
the `share_counts` dump preset is safe to publish.

**Backfill.** `build_counts` over all of `share_facts` on the first run after merge.

**Tests.** `tests/test_shares_resolve.py`, in-memory DuckDB over fixture facts, plain script,
asof 2026-10-31 unless stated. The live values come from the cached simulation (the S0
`--cache` run) and are re-confirmed by S0c.
- **Selection goldens:**
  - EMN 114,380,456 (cover, accession 0000915389-26-000172); at 2026-10-29 the previous
    filing's cover (the 10-30 filing is invisible);
  - MCD 707,641,531 (not the January cover 710,398,642, not issued 1,660,600,000);
  - FMC 155,558,399; CL 794,920,513; MMM 516,729,574; NOW 1,038,000,000;
  - AGNT 167,117,937; TEVA 1,165,296,084; RDWR 43,145,971; INMD 63,358,750;
    EDU 1,549,068,783; DNA 63,711,102;
  - GOOGL 12,294,000,000; TSCO 521,040,137;
  - BABA 18,580,374,278 ordinary shares, with the cover 1,858,037,427 quarantined, divided by
    8 = 2,322,546,785;
  - AAL `count_date` clamped to 2026-07-23; AGGI/BSCL 40,388,706 accepted;
  - LEVI's 2019 count is NaN (`stale_beyond_ceiling`); a count 500 days old is kept and
    flagged `shares_stale`.
- **Classifier goldens:**
  - SHOE 10-Q filed 2011-12-08, CSI 13,652: FIX x1000;
  - SHOE 10-Q filed 2012-12-06, cover 20,430,373: OK, not fixed (the income-group trap);
  - SJ 6-K 0001213900-22-036326, 34,743,152,000: FIX /1000;
  - AAPL 10-Q filed 2014-04-24, 861,745: FIX x1000; DLTR 2011 10-Qs, 122: FIX x1e6;
    SYK 10-Q filed 2011-10-28, 383: FIX x1e6;
  - EMN FY 10-K, CSO 223,938,047: QUARANTINE;
  - a CCBG cover dated more than 120 days before its filing is not a candidate.
- **Properties:** truncation invariance (facts and `splits`); 20 shuffles of input order give
  identical output; with no `share_facts` the output equals the S3 path; `share_counts`
  passes the rule 6 schema test.

**Acceptance.** Goldens exact; census re-run: every move above 5% is on S0's C list; price
and market-cap coverage within 1 point of the previous snapshot, less the securities
quarantined past the ceiling, each listed (`COVERAGE_MIN` 0.8 at `screenjobs.py:56` never
at risk); resolver under 2 seconds per `score_frame` call and `build_counts` under 3
minutes; securities resolving to Issued fall from 307 to those with no cover or CSO within
the age limit; the backtest criterion holds.

**SEC_USER_AGENT.** No (reads S4).

**Corrects live.** Market cap and all four multiples: EMN about -49% (P/E halves), RDWR
-33%, INMD -28%, AGNT -22%, Paysafe -20%, FMC -16%, EDU -9%, TEVA -8%, DNA -5%. MCD, CL,
MMM, NOW, LECO and OI move onto their newest covers. SJ's count is fixed to 34.7M (still
stale until S6). BABA's market cap falls to an eighth (it stays out of picks through
`foreign_listing`). Counts past twice the age limit become NaN until S6 gives them a
weighted average. In the cached 693, 12 issuers move more than 5% and 20 get a fresher
count; S0 gives the universe figure.

---

## S5b Parent numerators for P/E and P/B

**Goal.** Make the numerators count the same owners as the economic shares, the parent's.
Today `net_income` takes whichever of NetIncomeLoss,
NetIncomeLossAvailableToCommonStockholdersBasic or ProfitLoss (and, for IFRS filers,
ProfitLoss or ProfitLossAttributableToOwnersOfParent) wins the ingest key for each
`(period_end, fiscal_period, filed_date)`: `catalog.py:33-34` pins ProfitLoss through a
namespace-stripped tag map (`catalog.py:50-61`), and the key at `edgar.py:173` has no
concept. `total_equity` likewise takes StockholdersEquity, the version including NCI, ifrs
Equity or EquityAttributableToOwnersOfParent, whichever comes first.

**Evidence (cache; S0 section L gives the universe figure).** Of 504 issuers filing both
NetIncomeLoss and ProfitLoss, 4 list ProfitLoss first, and 53 have FY facts filed since
2024-07-01 tagged only as ProfitLoss. The live FY `net_income` row is a consolidated concept
for 15 of 685 issuers and the live `total_equity` row for 41 of 685. Most of these report
no NCI in that context, so consolidated equals parent, but not all: Magic Software (IFRS;
NCI 14.8% of profit, 7.9% of equity), Steven Madden (8.9% of profit), J-Long (2.7% of
equity), and Applied Digital, whose consolidated loss is 26% smaller than its parent loss.
IFRS filers are the likely concentration (ifrs Equity and ProfitLoss sort ahead of the
parent concepts), and the cache barely covers them. NetIncomeLossAvailableToCommonStockholdersBasic
(29 cached live rows) is already the basic-EPS numerator and is left as is.

**Files and changes.**
- `engine/shares.py`, `parent_numerators(rows, cik_by_sid, con)`. For each `net_income` or
  `total_equity` row whose `raw_tag` is a consolidated concept (us-gaap:ProfitLoss,
  ifrs-full:ProfitLoss,
  us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest,
  ifrs-full:Equity):
  - find the stored fact in `share_facts` (same CIK, `filed_date`, `period_end`, concept and
    value), which gives its accession and duration;
  - take the parent value from the same accession, period end and duration: NetIncomeLoss,
    then ProfitLossAttributableToOwnersOfParent, for income; StockholdersEquity, then
    EquityAttributableToOwnersOfParent, for equity;
  - else the consolidated value minus the same-context NCI fact
    (NetIncomeLossAttributableToNoncontrollingInterest or
    ProfitLossAttributableToNoncontrollingInterests; MinorityInterest or
    NoncontrollingInterests), info `numerator_parent_derived`;
  - else keep the row with info `numerator_consolidated` (no NCI is reported in that
    context);
  - `value` and `raw_tag` change in the returned frame only; stored rows never change.
- `engine/stockvaluation.py:131-132`: apply it to `flow` before `growthhistory.annual_series`
  and to the `total_equity` instant rows before the pick, so P/E, P/B, earnings growth and
  the growth-history features all use one parent series.
- `engine/screenjobs.py:309-315`: the chart-series fundamentals go through the same
  function, so the published net-income series matches the P/E.
- `engine/quality.py`: `numerator_parent_substituted`, `numerator_parent_derived` and
  `numerator_consolidated` (info). Bumps `CHECKS_VERSION` and `DATA_GATE_VERSION`.

**Schema and backfill.** None (reads S4).

**Tests.** `tests/test_parent_numerators.py` (in-memory DuckDB, plain script): a
Magic-shaped IFRS row takes ProfitLossAttributableToOwnersOfParent and
EquityAttributableToOwnersOfParent; an Applied-Digital-shaped row takes NetIncomeLoss from
the same accession; a row with only ProfitLoss and an NCI fact gets the difference; a row
with only ProfitLoss and no NCI fact is kept and flagged; earnings growth uses parent values
in both years; a parent fact from a later accession is never used (truncation invariance);
rows won by a parent concept hash identically before and after.

**Acceptance.** Census L re-run: every moved P/E or P/B is on the L list; no row won by a
parent concept changes; the backtest criterion holds.

**SEC_USER_AGENT.** No.

**Corrects live.** P/E, P/B and earnings growth for issuers whose stored numerator includes
NCI (cache: 15 income and 41 equity rows checked, a handful moved); S0 gives the count
(T16).

---

## S6 Weighted-average fallback, class completeness and the float unit check

**Goal.** Give a market cap to every issuer with a recent EPS share count (META, CRWV and
about 200 others); replace stale and single-class counts; catch counts in the wrong class
units with a check that needs no weighted average.

**Files and changes.**
- `engine/shares.py`, the decision on candidate C against the validated basic weighted
  average W from the same accession (or from the newest periodic accession when C is
  missing). Starting bands are initial and frozen only after S0c (T5).
  - **In band:** 0.67 <= C/W <= 1.5: use C.
  - **Below band,** C/W < 0.67, not about a power of ten and not explained by a split
    executed on or before the filing:
    - **partial class** (use W, method `waso_basic`, warn `shares_partial_class`) when the
      low ratio persists: the previous periodic accession's own-date count over its own W is
      also below 0.67 and within 25% of this ratio, or the same accession's period-end CSO
      is also below 0.67 of W. MBLY sat at 0.27, 0.27, 0.30, 0.31 and 0.31 over its last
      five 10-Qs (cover 252,403,844 against 824,000,000); HEI's CSO is 0.39 to 0.40 of W in
      every filing that tags it (55,143,000 against 139,702,000);
    - **post-period reduction** (keep C, info `shares_post_period_reduction`) when the same
      accession's period-end CSO, or the previous accession's count, agrees with W and only
      the later-dated cover is low: a large tender or buyback after the period, where W, an
      average over the period, overstates today's shares;
    - **otherwise** NaN (warn `shares_value_quarantined`, reason `low_count_unexplained`)
      until the next filing settles it: a persistent ratio then reads as a partial class,
      and after a tender the next W falls back into band.
  - **Above band:** C/W > 1.5 for a cover or CSO count. If NCI is material (MinorityInterest
    at 2% or more of equity including NCI, same accession), use W (Up-C shape). Otherwise
    keep C as post-period issuance (info `shares_post_period_issuance`): CLBK 2.66 after its
    second-step conversion, Spyre, Viridian. About 20 of 683 cached issuers sit here with
    correct counts, so this never gates.
  - **Missing or stale:** C missing, older than the age limit or quarantined past the S5
    ceiling, and W's period end within the limit: use W (info `shares_from_wa`).
  - **Otherwise:** NaN (warn `shares_value_quarantined`, reason `no_valid_count`).
  - **Weighted-average bias bound:** if T4 finds p90 of log(C/W) above 5%, the fallback
    takes only a W whose period ended within 200 days.
- `engine/stockvaluation.py`, a new `share_price_checks(asof, security_ids, shares,
  con=None)` called after the price merge (`:355-356`). It reads two closes per security
  (the latest bar on or before asof within 10 sessions, and the bar at the float date), not
  the momentum window, and runs:
  - the **float unit check:** implied float shares are `dei:EntityPublicFloat` (USD, from
    the latest 10-K filed by asof within 550 days) divided by the close at the float date,
    on the same split basis as the count (from S7b; before S7b only when no split lies
    between the float date and asof). Economic shares below half the implied float shares
    quarantine the market cap (NaN, warn `shares_unit_mismatch`). With no bar at the float
    date, a market cap under a fifth of the float does the same. It catches BRK-type counts
    in another class's units and Class-A-only counts that agree with a Class-A-only
    weighted average: the undercounts that make false picks;
  - **`missing_market_cap`** (warn): a bar in the last 10 sessions, a NaN market cap, and no
    other share warning already explaining it (`PLAN.md:466-468`).

  `quality._shares_checks` calls the same function (two point reads per security, seconds),
  so quality still never runs `score_frame`; the issues carry no numbers and `value` None.
- `engine/sources/share_overrides.json` (new, committed, optional stopgap until S9b):
  curated per-class counts for issuers with neither count nor W (BRK first). Each carries
  `cik, accession, filed_date, period_end`, class counts, ratio to the priced class and a
  source note. Used only from `filed_date`, expires by the age limit, must pass the float
  check and a validator test.
- `engine/quality.py`: `shares_partial_class`, `shares_unit_mismatch`, `missing_market_cap`
  (warn); `shares_from_wa`, `shares_post_period_issuance`, `shares_post_period_reduction`
  (info). Bumps `CHECKS_VERSION`.
- Bumps `DATA_GATE_VERSION` (one bump with S5 under T1).

**Schema and backfill.** None.

**Tests.** Goldens, all from companyfacts, in `tests/test_shares_fallback.py` (in-memory
DuckDB, plain script):
- **Weighted-average fallback:** META 2,552,000,000 (3-month Q3-2026); CRWV 551,000,000;
  LEVI 386,075,414 (was 375,874,600 from 2019); AOS 135,363,668 (was 164,534,881 issued from
  2020); SJ 41,776,414 (FY2025 20-F); VICR 46,129,000 (was 11,758,218 from 2021); WMG's
  latest weighted average (was 1,069 shares from 2020).
- **Partial class:** MBLY 824,000,000; HEI 139,702,000.
- **Post-period reduction:** a synthetic tender where the period-end CSO agrees with W and the
  later cover is 0.55 of W keeps the cover; a first-time 0.55 with no CSO and an in-band
  prior is NaN, and the next filing settles it.
- **Unchanged:** MCD stays 707,641,531 (its weighted average of about 709 is rejected); WAT
  and AVXL keep C (their x1000 weighted averages are rejected); GOOGL stays 12,294,000,000.
- **Above band:** CLBK keeps 269,545,135 with the issuance flag.
- **No count:** BRK-B is NaN; with a curated override it is A x 1,500 + B in B units, and only
  from the override's filing date.
- **Float check:** a BRK-shaped count in Class A units is quarantined; FXCRASH (price down 85%
  since the float date) is not; quality and `score_frame` agree per security.
- **Truncation invariance.**

**Acceptance.** Securities with no market cap fall from about 219 to those with neither a
count nor a weighted average within the age limit, each listed; no switch to W inside a
power-of-ten band; no switch to W on a first-time low ratio; accepted C/W p1 and p99 inside
[0.67, 1.5], else re-derive before freezing; `pe` coverage rises; `coverage_guard` passes;
the backtest criterion holds.

**SEC_USER_AGENT.** No.

**Corrects live.**
- META, CRWV and about 200 other no-market-cap stocks get market caps and multiples.
- About 25 stale counts are replaced: LEVI, AOS, REGN (2012), WMG, VICR, GTN, SJ, SOUN, CHR.
- Class-incomplete undercounts are fixed: MBLY about 3.3x, HEI about 2.5x.
- BRK-B shows NaN instead of about 1/2,300 of its true market cap (if it is priced at all, T6).

---

## S7a Knowledge cut-off

**Goal.** Close the same-day look-ahead in its own small PR, so its rank-IC effect is not
mixed with the split-basis change. A filing made after the close on t is not knowable at
close(t), so a fact is visible only when `filed_date < asof`.

**Files and changes.**
- `engine/tierb.py:417-441` (`metrics_asof`): `filed_date < ?`, through
  `FILED_BEFORE_ASOF = True` (the constant S5 already reads); docstring "filed before".
  ADR-005 names no operator (`DECISIONS.md:1295-1299`); the inclusive `<=` lives here
  (`tierb.py:420-425`) and in the migration 0003 comment (`0003_metric_vintages.sql:1-3`),
  which is history and is not edited.
- Every caller moves with it, and the PR lists them: `stockvaluation._fundamentals_frame`
  (`:123`), the chart series (`screenjobs.py:309`), the `tierbsync` verify gate
  (`tierbsync.py:201-218`), `shares.economic_shares_asof` and `tierb.metric_vintages` (S3)
  through the same constant. Docstrings at `stockvaluation.py:10-14`, `backtest.py:5` and
  `growthhistory.py:94`.
- `engine/tierbsync.py:213-220`: the `asof_no_lookahead` gate sets `asof = vintages[1] - 1
  day`; under `<` it fails whenever the two vintages were filed one day apart. It becomes
  two checks: at `asof = vintages[1]` the earlier vintage is returned (the later one is
  invisible on its own filing date), and at `vintages[1] + 1 day` the later one is.
- Live is unchanged in practice: the daily run starts at 06:00 UTC (`data-pipeline.yml:16`),
  before any same-day EDGAR filing, so everything it sees was filed on an earlier date. The
  backtest sees each filing one session later.
- Bumps `DATA_GATE_VERSION` (no live alert moves; the bump writes the `data_versions` marker
  that triggers the re-backtest recommendation).

**Schema and backfill.** None.

**Tests.** `tests/test_knowledge_cutoff.py` (in-memory DuckDB, plain script): a fact filed on
t is invisible at t and visible at t+1 through `metrics_asof`, `metric_vintages` and
`economic_shares_asof`; the reworked verify gate passes on two vintages filed one day apart
and fails on a deliberate `<=` regression.

**Measured gate.** On a normal day the stock snapshot rows from the old and new code hash
identically (live unchanged); `tierbsync verify` passes; the backtest re-run is recorded
(rule 5) as the cut-off effect alone.

**SEC_USER_AGENT.** No.

**Corrects live.** Nothing live. The backtest stops pairing a filing with the close of the
day it was filed.

---

## S7b Split basis

**Goal.** Correct market cap between a split and the next filing, at every backtest date
around an in-window split, and in returns and momentum, without double-adjusting restated
comparatives or assuming one store-wide price basis. It replaces the S3 rule (c)
quarantine and removes the mixed-basis caveat.

**Files and changes.**
- `engine/shares.py`: `split_index()` builds a cumulative factor K(d) per security from
  `splits` (backfilled from 2023-01-01 in S3), in memory. Each candidate's basis date is
  set at read time by the split-basis policy below and is never written to `share_counts`
  or any artifact (rule 6).
- `engine/stockvaluation.py:199-205`: select `ingested_at`. Momentum and range inputs use
  basis-consistent closes (close x K(bar basis) / K(latest bar basis)). `:358` becomes
  `price x shares x K(bar basis) / K(fact basis)`, NaN when either basis is unknown. This
  replaces the S3 rule (c).
- `engine/backtest.py:76-89`: `_price_near` also returns `ingested_at`; `:121` becomes
  `fwd_ret = (fwd_close / close) x K(basis_fwd) / K(basis_t) - 1`.
- `engine/datapipeline.py`, after corporate actions (`:177-191`): a re-base hook. Tracked
  securities with a split executed in the last 35 days whose pre-split bars were fetched on
  or before the execution date get `prices.bulk_ingest(full=True, tickers=[...])`
  (`prices.py:268-301`), one Massive range call each.
- `engine/sources/prices.py`: CLI `verify-basis`. For every in-window split it compares closes
  across the execution date against each bar's fetch date and prints aggregate pass and fail
  counts only. It must pass before K is wired into market cap.
- `engine/quality.py`: `price_basis_unresolved` (warn: ambiguous bars older than 2 days),
  `split_table_gap` (warn: an EDGAR split-ratio tag filed in the last 400 days with no
  `splits` row within 400 days), `shares_split_basis_ambiguous` (warn). Bumps
  `CHECKS_VERSION`.
- `docs/DECISIONS.md`: ADR-045, splits feed market cap (amends ADR-018's "audit trail
  only"). ADR-044 is reserved for the agents work. Bumps `DATA_GATE_VERSION`.

**Schema and backfill.** No schema change (the `splits` table and `prices.ingested_at`,
which compaction preserves). One targeted re-fetch for any security the census found on a
mixed basis.

**Tests.** `tests/test_split_basis.py` (in-memory DuckDB, plain script), synthetic bars only
(no Massive data in fixtures):
- **TSCO 5:1, executed 2024-12-20:**
  - at 2024-11-15, bars fetched after the split: the count filed 2024-11-07 (106,839,001)
    times 5; bars not yet re-based: times 1;
  - at 2025-01-10: times 5 = 534,195,005;
  - at 2025-03-01: the count filed 2025-02-20 (531,548,314) times 1;
  - the FY2024 10-K's restated comparative (539,878,000 at 2023-12-30) is not multiplied
    again;
  - a bar fetched on the execution date gives NaN.
- **Other splits:** ORLY 15:1, NFLX 10:1, FAST 2:1, IBKR 4:1, BSCL 1-for-500.
- **Properties:** adj x K(b)/K(f) equals raw x K(t)/K(f); the forward-return identity holds;
  truncation invariance over `splits`.

**Acceptance.** `verify-basis` passes for at least 95% of in-window splits, failures listed;
the TSCO, FAST, ORLY, IBKR and NFLX market-cap series show no step at execution beyond the
price move; `price_basis_unresolved` is 0 after the hook's first run; no backtest forward
return above 80% in size coincides with a split; the backtest is re-run (T10) without the
mixed-basis caveat and the criterion holds.

**SEC_USER_AGENT.** No (the Massive key is a CI secret).

**Corrects live.** Names that split since their last filing get correct market caps
instead of NaN. Every backtest date around an in-window split is valued on one basis.
Returns, momentum and on-sale stop seeing fake split-day moves.

---

## S8a Price tickers for class listings

**Goal.** Price class-suffix tickers whose Massive symbol differs (BRK.B against BRK-B).
Under T6 this ships straight after S0.

**Files and changes.**
- `engine/migrations/0016_price_ticker.sql` (new, additive; migrations are numbered in merge
  order and renumbered if another lands first): `alter table securities add column if not
  exists price_ticker text`.
- `engine/sources/prices.py:168-177` and `:262`, `engine/sources/corpactions.py:146-151`: map
  by `coalesce(price_ticker, ticker)`. Seed BRK-B to BRK.B, BF-B to BF.B, MOG-A to MOG.A,
  CRD-A to CRD.A and AKO-A to AKO.A where T6 confirms them.
- Bumps `DATA_GATE_VERSION` (rows that gain a price are a data change, not a market move).

**Tests.** `tests/test_price_ticker.py`: a Massive row for BRK.B lands on the BRK-B security;
a security without `price_ticker` maps as today; a seed lint rejects a row without a
source.

**Measured gate.** Every seeded ticker gains price rows on the first run; no other security's
price rows change (counts per security, before and after).

**SEC_USER_AGENT.** No. **Corrects live.** Class-suffix tickers get prices.

---

## S8b CIK history

**Goal.** Stop re-ingest overwriting `securities.cik`; record CIK history; make every CIK
change visible, verified or held, never silent.

**Files and changes.**
- `engine/migrations/0017_security_ciks.sql` (new, additive): `security_ciks` (`security_id`
  referencing `securities(id)`, `cik text`, `relation` in (primary, predecessor,
  candidate), `valid_from`, `valid_to`, `source`, `noted_at`, primary key
  `(security_id, cik)`), seeded with XPRO 1575828 and CLBK 1723596 as predecessors.
- `engine/sources/edgar.py:125-160`: read the stored CIK first. When SEC's ticker map
  (`cik_for`, `:125`) gives a different one:
  - **verified** (applied) when the new CIK's submissions JSON lists the old entity name in
    `formerNames`, or the old CIK has filed no periodic form since the new CIK's first one,
    or a committed seed row says so. The old CIK goes to `security_ciks` as `predecessor`,
    with `valid_to` the new CIK's first periodic filing date, and `securities.cik` becomes
    the new CIK;
  - **unverified** (held) otherwise. The new CIK is written as `candidate` and warn
    `cik_changed_unverified` is raised. Ingest still fetches the new CIK's companyfacts
    (`:132`), and its `share_facts` land under that CIK, which the resolver's CIK set
    (primary plus predecessors) does not read. For that ticker the run writes neither legacy
    metric rows nor `securities.cik`, so the legacy path and the resolver both keep
    resolving from the stored CIK and agree. The count then ages: flagged `shares_stale`
    past the age limit and NaN past the S5 ceiling, with the warning repeated daily. A
    committed seed row in `engine/sources/security_ciks.json` (owner-reviewed) promotes a
    candidate to successor, and the next build uses the facts already stored, with no
    re-fetch. Held changes are therefore bounded and listed, and a reassigned ticker never
    attaches another company's facts.
- `engine/shares.py`: a listing's CIK set as of asof is `securities.cik` plus its
  `predecessor` rows. Predecessor facts are used only for filings before the successor's
  first.
- `engine/quality.py`: `cik_changed_unverified` (warn). Bumps `CHECKS_VERSION` and
  `DATA_GATE_VERSION`.

**Schema and backfill.** Postgres migration 0017; `share_facts` re-fed for predecessor CIKs
only (a handful of requests).

**Tests.** `tests/test_security_master.py`: an XPRO-shaped predecessor merge resolves a
current count; a verified change writes a history row and moves `securities.cik`; an
unverified change writes a candidate row, leaves `securities.cik` and the legacy rows
alone, and its count goes stale and then NaN on schedule; a seed row promotes a candidate
without a re-fetch; a seed lint rejects a row without a source.

**Acceptance.** XPRO and CLBK have current counts; every CIK change in census K is verified
or held with a warning; census re-run (rule 3).

**SEC_USER_AGENT.** Yes (submissions JSON, predecessor companyfacts and SEC's ticker map).

**Corrects live.** XPRO and CLBK regain valuations; future CIK changes are recorded instead
of overwriting.

---

## S8c One listing per CIK in picks and the backtest

**Goal.** Count each company once wherever an aggregate or a cross-section is built, while
the screener keeps every listing.

**Files and changes.**
- `engine/stockvaluation.py:263-281` (`_universe`): select `cik`. No filter.
- `engine/picks.py:279-292`: when a `cik` column exists, one card per CIK. The primary is the
  listing with the higher trailing 60-session median dollar volume as of asof (ties go to the
  shorter ticker); the card names its siblings. Without `cik` nothing changes, so
  `jobs_picks_golden.json` stays byte-identical.
- `engine/backtest.py:331-337`: dedupe each cross-section by CIK with the same rule before
  `_evaluate_period`.
- `dashboard/screen_fields.json`: `listing_group`. Screener rows keep both listings; info
  check `shares_listing_shared_cik`.
- Bumps `DATA_GATE_VERSION` (picks and backtest cross-sections change; no value moves).

**Tests.** `picks.build` never returns both GOOG and GOOGL; the backtest cross-section
shrinks by exactly the duplicate count; the golden is byte-identical without `cik`.

**Measured gate.** The picks diff (tickers only) shows only sibling swaps and the freed
slots; the backtest re-run records rank-IC before and after the dedupe (rule 5).

**SEC_USER_AGENT.** No. **Corrects live.** GOOG/GOOGL and BF-A/BF-B are counted once in
picks and rank-IC.

---

## S8d Universe hygiene (owner decision, outside the share fix)

**Goal.** Take non-stocks and duplicate listings out of the stock ranks, if the owner
approves the list in #58. Nothing in S0 to S11 depends on it. It removes about 28 listings
from scoring (the SIC 6221 trusts such as GLD, GBTC, USO, FXE and PPLT; TWOD, a note; LC and
AGGI, duplicates of listings that stay), so it is kept apart from the share fix, given the
owner's "do not exclude stocks". None of them is an operating company's only listing.

**Files and changes (only after approval).**
- `engine/migrations/0018_listing_status.sql`: `listing_status text not null default
  'active'` checked in (active, retired, not_common).
- `engine/stockvaluation.py:263-281` (`_universe`): filter `listing_status = 'active'`.
- `engine/sources/universe_stocks.json`: LC (renamed HAPN, CIK 1409970) and AGGI (same
  company as BSCL, CIK 1109262) retired; TWOD and the SIC 6221 trusts set to `not_common`;
  `'NONE.'` corrected (EBR Systems, CIK 1347123). No `securities` row is deleted, so
  predictions and watchlists keep resolving.
- `engine/universescan.py:165-172`: skip tickers failing `^[A-Z]{1,5}([.-][A-Z]{1,2})?$` and
  CIKs already tracked.
- Bumps `DATA_GATE_VERSION`.

**Acceptance.** Every retirement is listed in the PR with the owner's approval; the screener
row drop stays inside `SHRINK_MIN` (`screenjobs.py:58`).

**SEC_USER_AGENT.** No. **Corrects live.** Non-stocks leave the stock ranks.

---

## S9a Instance and FSDS spike

**Goal.** Test the one source no design could test here (www.sec.gov returned 403): the
dimensional facts companyfacts omits.

**Changes (its own small PR, CI).** Capture trimmed instance fixtures for GOOGL, META, BRK,
CRWV, MBLY, BABA and HDB, and test whether the FSDS 2026q2 `num.txt` segments column
carries per-class cover counts for the same CIKs (`engine/sources/secfsds.py`). The result
picks the backfill source: FSDS if it does (cheaper, all filers), instances otherwise;
instances always for the daily increment. JOURNAL records the verdict.

**SEC_USER_AGENT.** Yes. **Corrects live.** Nothing.

---

## S9b Per-class and ADS facts from filing instances

**Goal.** Fetch, point in time, per-class cover counts on
`us-gaap:StatementClassOfStockAxis`, `dei:TradingSymbol` per class, `dei:Security12bTitle`
and per-class EPS.

**Files and changes.**
- `engine/sources/xbrlinstance.py` (new, from the investigation's instance-confirmation
  probe):
  - **Target set:** no non-dimensional count in the newest accession; `shares_partial_class`;
    `shares_from_wa`; registry issuers; 20-F and 40-F filers; CIKs with two or more listings.
  - **Fetch:** for each target, the submissions JSON lists periodic filings filed on or after
    2023-07-01; for each, the `*_htm.xml` instance through the Archives index, read with a
    streaming iterparse that keeps only cover facts, share facts and per-class EPS.
  - **Write:** rows go to `share_facts` with `source 'xbrl_instance'` and `class_member` set;
    `TradingSymbol`, `Security12bTitle` and `SecurityExchangeName` go in `value_text`.
  - **Pacing:** 5 requests per second or fewer with `edgar._headers()`.
- `engine/datapipeline.py`: daily increment for target CIKs among
  `edgar.recent_filer_ciks(days=7, forms=edgar.FUNDAMENTAL_FORMS)`, the keyword form
  `datapipeline.py:83` already uses (the signature is `recent_filer_ciks(days=7,
  forms=None)`, `edgar.py:275`, so a positional frozenset would bind to `days`).
- `.github/workflows/shares-instance-backfill.yml` (new): resumable, `tierb-writer`
  concurrency, cache save, `SEC_USER_AGENT`.

**Schema and backfill.** No new dataset: `share_facts` has carried `class_member` and
`value_text` since S4. One backfill dispatch (filings since 2023-07-01), then the daily
increment.

**Tests.** `tests/test_xbrlinstance.py` on the S9a fixtures (plain script): GOOGL Class A, B
and C; META A and B; BRK A and B; CRWV A, B and C; MBLY A and B; BABA's title "each
representing eight ordinary shares" parses to 8; HDB 3; non-cover contexts ignored;
idempotent append.

**Acceptance.** At least 95% of the target set has per-class or ADS facts for its newest
periodic filing; fetch errors under 2%; the backfill finishes in under 90 minutes or two
resumable runs; the daily increment takes under 5 minutes.

**SEC_USER_AGENT.** Yes. **Corrects live.** Nothing (S10 consumes it).

---

## S10 Economic conversion: class sums and ADS ratios

**Goal.** Express economic shares in the priced listing's units, point in time: BRK-B =
Class A x 1,500 + Class B; GOOG and GOOGL = A + B + C; each ADS listing = ordinary shares /
ordinaries per ADS.

**Files and changes.**
- `engine/sources/share_classes.json` (new, committed, curated, keyed by CIK): priced
  listings, and per class `member`, `ticker` (or null), `ratio_to_priced`,
  `effective_from`, `valid_from` (the filing date of the disclosing filing),
  `source_accession`, `note`. First entries: BRK (A = 1,500 B); the 1:1 dual classes
  (Alphabet, META, BF, HEI, LEN, Z); Up-C non-economic Class B at ratio 0. Accessions are
  sourced by a person with SEC access, never hand-dated.
- `engine/shares.py`, class-sum candidate per accession: the sum of class counts times the
  ratio known at asof (`valid_from` before asof; effective window containing the fact's
  basis date).
  - **Without a registry entry:** 1:1 only when the sum agrees with the same filing's
    non-dimensional W (in [0.9, 1.35]); if listed classes alone agree, unlisted classes get
    ratio 0 (Up-C); otherwise warn `share_class_ratio_missing` and use W.
  - **Ratio inference:** per-class EPS from the same filing gives the ratio (BRK about
    1,500); the registry wins.
  - **Priority** becomes cover total, class sum, CSO, and so on. W is converted with the same
    ratios (BRK's weighted average is in Class A equivalents).
- **ADS ratio sources,** in order, each with an effective date and a knowledge date:
  - the same accession's dei ratio, or its `Security12bTitle` parsed (digits, number words,
    fractions);
  - the latest earlier filing;
  - the registry.

  A title that says ADS with an unparsed ratio gives NaN (warn `ads_ratio_missing`); no
  information at all keeps ratio 1 with info `ads_ratio_unverified`.
- **Registry cross-checks** (the fix for curation errors), as a CI test. Every curated ratio
  must pass at least one independent same-filing check:
  - the per-class EPS ratio within 1%;
  - the class sum times the ratio against the non-dimensional W within [0.9, 1.1];
  - the float unit check.

  A ratio failing all three fails CI. A CI step in `shares-census.yml` (with
  `SEC_USER_AGENT`) asserts each `valid_from` equals its accession's filing date
  (submissions JSON).
- Per-class prices: where both classes are priced, the issuer market cap is the sum of each
  listing's price times its class count; otherwise flag `single_price_approx`.
- `engine/picks.py:202-208`: docstring only (relaxing `_domestic` is an owner decision).
- `engine/quality.py`: `share_class_ratio_missing` (warn), `ads_ratio_missing` (warn). Bumps
  `CHECKS_VERSION`.
- Bumps `DATA_GATE_VERSION`. `docs/DECISIONS.md`: ADR-046 (class facts, ratios, ADS).

**Schema and backfill.** None (committed JSON plus S9b data).

**Tests.**
- **Class sums:** BRK-B = A x 1,500 + B; GOOG and GOOGL both A + B + C; QSR stays 348,600,694
  (exchangeable units excluded by the convention).
- **ADS:** BABA 18,580,374,278 / 8 = 2,322,546,785 (the cover is still rejected); a BABA count
  dated 2019-07-29 uses ratio 1 and one dated 2019-07-30 uses 8; HDB / 3; Rentokil / 5.
- **Point in time:** BRK-B before the registry entry's `valid_from` gets no class sum.
- **Registry:** the validator and the cross-checks.

**Acceptance.** At least 90% of the S9b target set has a known ratio; no ADS listing is left
without a ratio unless warned; BRK-B's market cap is of the right order (about $1T);
GOOG and GOOGL caps differ only by the class price spread; the backtest criterion holds.

**SEC_USER_AGENT.** Yes for the CI validation step; the registry curation needs a person
with SEC access.

**Corrects live.**
- About 200 ADS listings are corrected by their ratio in the screener, the backtest and the
  market drawer (`stockvaluation.market_breakdown`, `:284-338`); picks are unchanged while
  `_domestic` holds.
- BRK-B is valued.
- GOOG and GOOGL carry the whole company.

---

## S11 Remaining consumers, catalogue fix, legacy retirement

**Goal.** Route every remaining share reader through the resolver, retire the legacy path
and fix the catalogue mis-maps that store share counts under money and per-share metric
codes.

**Files and changes.**
- `engine/reports.py:134` and `:143`: Key reports take `economic_shares_asof` at the report
  date (value, method, accession), not raw CommonStockSharesOutstanding.
- `dashboard/model-engine.js:2089`: no logic change; `opening.shares` arrives resolved
  through the report JSON; a provenance note at the field.
- **Catalogue.** `engine/sources/metric_catalog.json:552`: remove
  `us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding` from `stock_based_compensation`
  (unit USD). Removing it there alone would not fix anything: `xbrl_tag_map`'s `setdefault`
  (`catalog.py:50-61`) would hand the concept to `eps_basic_diluted` (unit `USD_per_share`,
  `metric_catalog.json:1538-1543`), which lists it too and already holds
  `WeightedAverageNumberOfShareOutstandingBasicAndDiluted`. So also remove both share
  concepts from `eps_basic_diluted`. Both live in `share_facts` (S4).
- **Purge and re-feed.** A new `tierb.delete_metric_rows(pairs)` modelled on
  `delete_metric_codes` (`tierb.py:390-410`) removes the rows whose `(metric_code,
  raw_tag)` is either share concept under either metric code, run under the `tierb-writer`
  group. Then `edgar.ingest_tickers` re-feeds the affected tickers (or the next monthly
  sweep does): the EPS and SBC facts that lost the ingest key to a share count take the
  freed keys, since `append_metrics` anti-joins on `FM_KEY`.
- **Lint** (in `tests/test_catalog.py`, plain script): through `xbrl_tag_map()`, so
  `setdefault` hand-offs are caught, no concept reported in a `shares` unit maps to a metric
  whose catalogue unit is not `shares`.
- Noted, not fixed: EarningsPerShareBasic and EarningsPerShareDiluted still share one
  `eps_basic_diluted` key per filing. No scoring path reads that metric; the only reference
  is the CRWV report inventory (`dashboard/reports/data/crwv_financials.json:209`).
- `engine/sources/metric_catalog.json:1621-1637`: the `shares_outstanding` notes say it is
  the legacy collapsed row, superseded by `share_facts` (ADR-043).
- `engine/stockvaluation.py:43-101`: delete `_resolve_shares_concept`, its constants and the
  S3 guard after two weeks of the resolver with no fallback hits; `shares_frame` stays as the
  wrapper over `economic_shares_asof`; move the `tierbdump` share presets to `share_counts`.
- A grep test: no code path computes market cap from raw share rows.
- Backtest re-run: rank-IC per signal and horizon on the old and new share bases, in JOURNAL.

**Schema and backfill.** One Tier B purge of the mis-mapped rows under two metric codes,
then a targeted re-feed.

**Tests.** `tests/test_reports_engine.py` gains a dei-vs-Issued collision case and a
CRWV-shaped case that use the resolved count; the catalogue lint; `delete_metric_rows`
removes exactly the named pairs and leaves every other row's hash unchanged.

**Acceptance.** Report counts equal the resolver's at the report date for every reported
ticker; no production reader of `fundamental_metrics.shares_outstanding` remains outside the
legacy dump; the lint passes.

**SEC_USER_AGENT.** No (the re-feed runs in CI, which has it).

**Corrects live.** Key reports and the driver model's opening market cap match the
screener; `stock_based_compensation` and `eps_basic_diluted` stop holding share counts.

---

## The economic-shares convention

**Definition.** Market cap of a listing = that listing's price x the issuer's economic
shares, expressed in that listing's units. Economic shares are the parent's common shares
that share in parent-attributable earnings: the basic-EPS population (ASC 260, IAS 33),
counted point in time from facts filed before the date.

**Included.** Every class of common stock, listed or not, at its economic (dividend and
liquidation) equivalence to the priced class, not its votes: GOOG, GOOGL and Class B at
1:1; META and CRWV classes at 1:1; BRK Class A = 1,500 Class B. ADS listings at 1 /
ordinaries per ADS (BABA 8, HDB 3, Rentokil 5).

**Excluded.** Treasury and unissued shares (so Issued is a guarded last resort); options,
warrants, RSUs outside basic EPS and convertibles (the count is basic, never diluted);
non-economic voting classes (Up-C Class B at ratio 0); subsidiary-level exchangeable, LLC
and OP units, which are non-controlling interest on the parent's books (QSR's partnership
units).

**Numerators must match.** P/E and P/B divide by parent-only shares, so their numerators
must be the parent's too, and today they are not always. `net_income` takes whichever of
NetIncomeLoss, NetIncomeLossAvailableToCommonStockholdersBasic or ProfitLoss (or the IFRS
pair) wins the ingest key for each period and filing date (`catalog.py:33-34` and the
namespace-stripped map at `:50-61`; `edgar.py:173`), and `total_equity` likewise takes
StockholdersEquity, the version including NCI or the IFRS pair. In the cache the live FY
`net_income` row is consolidated for 15 of 685 issuers and the live `total_equity` row for
41 of 685; most report no NCI in that context, but Magic Software, Steven Madden and Applied
Digital differ by 9% to 26%. S5b substitutes the parent's value from the same filing, so
P/E and P/B become parent over parent. NetIncomeLossAvailableToCommonStockholdersBasic, the
basic-EPS numerator, stays.

**Known bias, flagged, not hidden.** P/S and P/CF divide a parent-only market cap into
consolidated revenue and operating cash flow, so Up-C, UPREIT and exchangeable-unit issuers
read cheaper on those two (QSR about 24%). Such issuers get the info flag
`shares_material_nci` (diluted/basic weighted average above 1.15 with NCI, or NCI equity
above 10%). A second convention for some issuers would bias cross-sectional ranks, so the
alternatives (scaling P/S and P/CF by the parent's ownership, or an as-exchanged market cap)
are an owner decision, brought forward if T13 fires.

**Precedence of point-in-time counts.** Cover count, then balance-sheet outstanding, then
issued minus treasury from the same filing, then issued (guarded), then the basic weighted
average from the latest periodic filing when the count is missing, stale, past the ceiling
or class-incomplete (method `waso_basic`, flagged), then (S10) the class sum. Recomputed per
date, so the live board and every backtest date use the same rules on the facts knowable
then.

## The scale-error policy

1. **Quarantine the value, never the stock.** The raw fact is never changed in Tier B
   (ADR-005); `value_raw` is always kept beside `value_clean`.
2. **Point in time.** A verdict uses only the accession's own facts, earlier accessions and
   splits executed on or before its filing date; never modal frequency across vintages,
   never a later filing.
3. **Candidates are own-date counts only** (see S5). Comparatives and date-mixed contexts are
   history.
4. **Evidence groups, one vote each:** cover; balance sheet; income (NI/EPS, else the
   weighted average, as one group); prior (the previous accession's validated count,
   split-adjusted in memory). From S6 the float unit check is a separate, score-time guard,
   not a vote.
5. **A vote** is "agree" when value over proxy is inside the band (count against count 1/1.35
   to 1.35; count against income 1/1.5 to 1.5; issued counts allow up to 3 for treasury);
   "scale k" when value / (proxy x 1000^k) is in 0.8 to 1.25 for some k other than 0;
   otherwise "disagree".
6. **FIX** (`value_clean = value / 1000^k`, `fix_code` such as `scale_div_1e3` or
   `scale_mul_1e6`) only when at least two groups vote the same k, none votes another k, and
   they outnumber the agreeing groups. Only powers of 1,000 are ever corrected.
7. **QUARANTINE** when non-agreeing groups outnumber agreeing ones, or the value is zero or
   negative. A 10x slip (BABA's cover), a digit typo, an authorised count or a 2,245x mixture
   is quarantined, never rescaled. The resolver falls to the next candidate in the same
   accession, then the previous accession, then (S6) the weighted average, then NaN.
8. **UNVERIFIED** with no groups at all: kept, unless below 1e4 or above 6e10.
9. **Splits first.** Before any scale vote, split hypotheses for splits in
   (`count_date`, `filed_date`] are tested; a ratio explained by a known split is a basis
   question, not a scale error, and is recorded only as the label `split_explained`.
   Same-filing restatement keeps reverse splits safe: BSCL's post-split 10-Q agrees with its
   own restated weighted average, so the 1/500 against the prior vote cannot outvote it.
10. **Bands are initial.** S0 reports the verdicts that flip when every band moves 10%;
    `rules_version` 1 is frozen only after S0c.

The prototype, now `engine/shares.classify_accessions`, gives the intended verdict on the
cache for SHOE 2011 to 2013 including the 2012-12 trap, SJ (/1000), BABA (cover
quarantined), AGGI (accepted), AAPL 2014 (x1000), DLTR 2011 and SYK 2011 (x1e6).

**Out-of-band cases expected before the census** (the census labels each case against this
table; T5 counts the unexplained rest):

| Band | Legitimate | Error |
|---|---|---|
| Issued 1.1 to 10x W | treasury stock (53 of 583 cached newest filings at 1.5 to 10x: KO, CL, MMM, TSCO, WFC) | none; this is why Issued is last |
| Cover or CSO above 1.5x W | post-period issuance, second-step conversion, IPO or SPAC (CLBK 2.66, Spyre, Viridian); a forward split after the period | CSO tagged at the issued value (EMN FY 10-K; an EG-shaped CSO equal to CSI); an authorised count; x1000 |
| Cover or CSO under 0.67x W | one class of several, persistent across filings (MBLY 0.27 to 0.31, HEI 0.39); a reverse split after the period; a large tender after the period (the period-end CSO agrees with W, only the later cover is low) | a 10x typo (BABA cover 0.10); /1000 |
| W itself 10^k off prior counts | none | the weighted average tagged in thousands or millions (MCD, WAT, AVXL): W rejected |

## The split-basis policy

**Until S7b.** S3's rule (c) quarantines a count only when a split executed after its basis
date and on or before the date scored, so no cross-section depends on a later split.
Backtest dates before an in-window split keep today's mixed basis, a post-split bar against
a pre-split count; S0 section J counts them and every backtest run until S7b carries the
caveat.

**Price basis per bar (S7b).** Each bar's basis is the US Eastern date of its `ingested_at`,
the date it was fetched with `adjusted=true` (`prices.py:17-20`). Splits executed before
that date are in the bar; later ones are not. A split executed on the fetch date is
ambiguous: K is NaN, so that bar's market cap and returns are NaN, never guessed. The
re-base hook re-fetches such tickers, so ambiguity lasts about a day. There is no
store-wide basis date: bars are re-based only by the monthly sweep or a targeted refresh.

**Share basis per fact (S7b).** Each candidate gets a basis date, the latest date through
which splits are reflected, computed in memory at read time.
- With no split in (`count_date`, `filed_date`], it is `filed_date`.
- Otherwise each hypothesis (the first j of those splits reflected) is tested against
  same-filing evidence: a cover count dated after the split, and the income group, which ASC
  260 requires to be restated through issuance. Exactly one agreeing hypothesis sets the
  basis (`evidence_cover` or `evidence_income`).
- With no evidence the GAAP default applies (SAB Topic 4C: balance-sheet counts reflect splits
  through the filing date; a cover count reflects none after its own date).
- Conflicting evidence gives `ambiguous`: the candidate cannot price a market cap and is
  flagged.
- Only splits with `execution_date` on or before `filed_date` are used, so the decision was
  knowable at filing.

**Formula.** K(d) is the product of `split_to / split_from` over the security's splits
executed on or before d. Then market_cap(t) = adj_close(t) x shares x K(bar basis) / K(fact
basis). Because adj_close(t) x K(bar basis) / K(t) = raw_close(t), this equals raw_close(t)
x shares x K(t) / K(fact basis): only splits up to t matter, and later splits enter only as
the exact inverse of Massive's own adjustment. No look-ahead and no selection effect.
Forward returns use (fwd close / close) x K(basis fwd) / K(basis t); momentum uses
basis-consistent closes.

**Restated comparatives** are never market-cap candidates. When compared (prior votes,
checks) they carry their own filing's basis, so the factor between two vintages applies once.
Anchoring at `count_date` would double-adjust them (TSCO's FY2024 10-K restates 2023-12-30 to
539,878,000).

**Sources and safeguards.**
- `splits` (migration 0009), backfilled from 2023-01-01 in S3, joined on `security_id` with
  `price_ticker` (S8a) and CIK history (S8b) for class tickers and renames.
- Corroboration by EDGAR's `StockholdersEquityNoteStockSplitConversionRatio1` and by restated
  weighted averages; `split_table_gap` warns on a tag with no row.
- The `splits` rows are licensed Massive data: server-side only. Neither they nor anything
  derived from them (basis dates, basis methods, K) appears in an artifact or a published
  file; S0 section J reports counts only (rule 6).
- Massive's adjustment timing is unverified locally: `verify-basis` checks it in CI before
  the factor is wired.
- The knowledge cut-off (`filed_date < asof`, S7a) makes a filing visible from the next
  session.

## The multi-listing policy

- **Issuer and listings.** An issuer is a CIK chain (`security_ciks`, S8b); each tradable
  ticker is one listing. Each listing's market cap = its own price x the issuer's economic
  shares in its own class units, so GOOG and GOOGL each show Alphabet's market cap (the gap
  is the class price spread) and BRK-A would show B-equivalents / 1,500. Where every class
  is priced (S10) the issuer market cap is the sum of price x count per listed class.
- **No double counting (S8c).** The screener keeps every listing, with `listing_group` and the
  info flag `shares_listing_shared_cik`; no listing is hidden. Picks, on-sale and backtest
  cross-sections keep one listing per CIK: the one with the higher trailing 60-session median
  dollar volume as of the date, ties to the shorter ticker. The card names its siblings. Any
  aggregate counts the company once.
- **Class mapping.** Which class a ticker is comes from `dei:TradingSymbol` per class in the
  same or latest filing (S9b), not the shortest-ticker heuristic (`universescan.py:165-172`).
  Unlisted classes (founder Class B) count in economic shares but have no row.
- **Price tickers (S8a).** Massive symbols differ for class tickers (BRK.B against BRK-B);
  `securities.price_ticker` carries the Massive symbol for prices and corporate actions.
- **CIK changes (S8b).** A CIK change is a dated predecessor when verified and a held
  candidate with a daily warning otherwise, never an overwrite.
- **Not class listings (S8d, owner decision).** A renamed or duplicate ticker on one CIK
  (LC/HAPN, AGGI/BSCL) is retired; a non-equity instrument (TWOD) or a commodity, crypto or
  currency trust (SIC 6221) is `not_common`; a bad ticker (`'NONE.'`) is corrected. No row is
  deleted.

## The check replacement

`shares_multiclass_unsummed` compares every vintage of one concept across all time. It
fires on legitimate split restatements (621 groups), old scale errors and tagging mistakes,
it cannot see per-class facts at all, and its "market cap is understated" text is wrong for
every row. S3 deletes it from both twins (`quality.py:141-173`, `:265-278`); the old
grouping survives only as the `share_vintage_conflicts` dump preset.

Its replacements run once per security on the value actually used today, never per
historical vintage, from one function (`quality._shares_checks`). Quality runs at
datapipeline step 5, before the screens step, and never calls `score_frame`; it calls the
same functions `score_frame` does: `stockvaluation.shares_frame` (S3, no price read), which
from S5 reads `share_counts.parquet` through `shares.economic_shares_asof` (built at step 2f,
before quality), and, for the two price-dependent checks, `stockvaluation.share_price_checks`
(S6, two point reads per security). None enters `EXCLUDE_CHECKS`: an unusable value is
already NaN.

| Check | Severity | From | Meaning |
|---|---|---|---|
| `shares_value_quarantined` | warn | S3 | today's count is NaN; the reason code names the rule |
| `shares_stale` | warn | S5 | count older than the age limit and no fresh weighted average |
| `shares_partial_class` | warn | S6 | count persistently under 0.67x the weighted average; W used |
| `shares_unit_mismatch` | warn | S6 | count far below the public-float share count; market cap NaN |
| `missing_market_cap` | warn | S6 | recent bar, NaN market cap, not explained by another warn |
| `price_basis_unresolved`, `split_table_gap`, `shares_split_basis_ambiguous` | warn | S7b | split-basis problems |
| `cik_changed_unverified` | warn | S8b | a CIK change held as a candidate |
| `share_class_ratio_missing`, `ads_ratio_missing` | warn | S10 | conversion unknown; value NaN |
| `shares_value_fixed`, `shares_count_date_future`, `ads_ratio_unverified` (S5); `numerator_parent_substituted`, `numerator_parent_derived`, `numerator_consolidated` (S5b); `shares_from_wa`, `shares_post_period_issuance`, `shares_post_period_reduction` (S6); `shares_listing_shared_cik` (S8c); `shares_material_nci` | info | S5 to S8c | audits; weight 0 (`quality.py:321-322`), ignored by triage |

Also: `shares_outstanding` leaves `_CURRENCY_NONNEG` (S3); the Postgres twin carries a
comment that share checks are Tier B only; `CHECKS_VERSION` moves with each change and the
daily plan reads it. Expected effect: about 1,287 warn rows go at S3, and roughly 50 to 150
new warns arrive over S5 to S10 (S0 projects the exact number).

## Safe removal of the blanket exclusion

**When.** In S3, after S0 (measurement), S1 (alert gate) and S2 (NaN cannot score Cheap).
This timing is an owner decision.

**What the PR does.** Commit 1 adds the splits flag and its backfill input, the vintage
read, `shares_frame` and the interim guard, `shares_value_quarantined`, and bumps
`DATA_GATE_VERSION` and `CHECKS_VERSION`. Commit 2 deletes check 7 in both twins; removes
the string from `EXCLUDE_CHECKS`; drops `shares_outstanding` from `_CURRENCY_NONNEG`;
renames the dump preset (`tierbdump.py:40-58` and `:135`, `tierb-dump.yml:21-23`); bumps
`CHECKS_VERSION`.

**If T2 fires.** S3 ships commit 1 only: the guard runs, and check 7 stays in both twins with
its string in `EXCLUDE_CHECKS`, so nothing is re-admitted. Keeping the string without the
check would exclude nobody, so the two always move together. Commit 2 moves to S6.

**Merge gates (measured, not asserted).**
- **G1, no worse than the rest:** from S0c, among the re-admitted issuers that are not
  quarantined, the share whose live count is more than 1.25x from the same filing's weighted
  average is no higher than among currently eligible stocks plus 1 point. Every re-admitted
  pick-eligible name outside that is listed with its reason. (At S6, G1 tightens to the
  absolute bar: 99% within [0.8, 1.25] of an independent same-filing reference.)
- **G2, goldens:** TSCO, WSM, CP, SHOE, IMAX, DLTR and AAPL resolve unchanged; SJ is
  quarantined; BSCL is accepted once the splits backfill has its row.
- **G3, guard size:** the interim guard quarantines at most 1% of securities. Above 2%,
  stop: that would be the blanket exclusion under another name.
- **G4, no unexplained jumps:** in the shadow picks diff, no newly eligible pick has a share
  count that moved more than 1.5x in the last 7 runs without a quarantine reason.
- **G5, alerts:** the first post-deploy run reports `rebased_on_rules` plus
  `rebaselined_on_rules` equal to the trusted screens evaluated, and no alert lists a ticker
  whose `data_ok` flipped; the next run alerts normally.

**Effects recorded in PLAN, STATUS and JOURNAL.** About 690 issuers re-enter picks, on-sale
and the screener's default view; about 1,287 open issues go and the quality score rises by
about 20 points (annotated as a definition change by `checks_version`); picks churn once;
the backtest re-run carries the mixed-basis caveat.

**Rollback.** Revert commit 2 in a new PR that also moves `CHECKS_VERSION` and
`DATA_GATE_VERSION` forward, never back. Check 7 returns in both twins and its string
returns to `EXCLUDE_CHECKS`; at the next daily run `quality.run` (step 5) re-creates the
issues and the 691 issuers leave picks again. Re-adding the string alone does nothing: with
check 7 deleted, no `shares_multiclass_unsummed` issue exists for it to match. The guard,
the resolver and the new checks stay.
