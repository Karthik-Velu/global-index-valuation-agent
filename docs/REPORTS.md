# Key reports — how to add one

Live: <https://global-index-valuation-agent.vercel.app/#/reports> · Decision: ADR-038.

1. **Financial tables (deterministic, EDGAR):**
   `python -m engine.reports financials <TICKER> --security-id <id> --name "<Company>" [--tierb <store>] --out dashboard/reports/data/<slug>_financials.json`.
   Copy table figures from this file. Do not retype them from press releases.
2. **Report:** write `dashboard/reports/<slug>.json` using the v1 schema (the header comment
   in `dashboard/reports.js`, enforced by `scripts/test_reports.js`). Add an entry to
   `dashboard/reports/index.json`, newest first.
3. **Rules:**
   - Every non-EDGAR fact carries a `[sN]` citation to an https source with a date.
   - Published prices, market caps and multiples come from cited public sources. Never use
     Massive/Tier B prices (they are licensed).
   - "Growth" means fundamental growth only.
   - The disclosures say the report is AI-assisted and is not personalised advice.
4. **Check:** run `node scripts/test_reports.js`, then the smoke test
   (`NODE_PATH="$(npm root -g)" node scripts/smoke_dashboard.js --work <dir outside repo>`).
   Print-preview the page to check the A4 PDF.

## Stress test & projections (the `model` block)

A report can embed an interactive model: `{"type": "model", "src": "<slug>"}` in any section.
`reports.js` lazy-loads `model-engine.js` (the maths), `model.js` + `model.css` (the UI) on
first use and fetches `dashboard/reports/models/<slug>.json` (MODEL SPEC v1, template
`levered_growth_v1`; semantics in the header of `dashboard/model-engine.js`).

- **What the reader gets:** scenario chips, Reset, Copy link; headline KPIs for FY+1 or FY+2
  (year toggle) with their change vs the base scenario: value per share, the probability-weighted
  value (scenarios with a `prob`), net income vs consensus EPS, interest, total debt / EBITDA and
  interest cover with covenant badges, the uncommitted funding need and the funded-EV EV/EBITDA;
  a compact sticky strip on a phone; a "Key P&L drivers" callout written from the tornado; sliders
  + numeric inputs per driver (the SOFR path is a picker); tabs for the P&L projection (+ model vs
  consensus), Interest & debt (every rate path with the per-year new-debt rate, a "+100bp" readout,
  interest by tranche, how the funding gap is met, leverage and coverage against the covenants,
  first breach by scenario, a maturity ladder that includes the model's own borrowing, the debt
  stack), Sensitivity (tornado + two-way grid for any metric and year), Breakevens (what the share
  price implies for each driver; where each covenant breaks), Valuation & multiples (scenario
  weights, funded-EV forward multiples at price and at value, the exit bridge with the
  cost-of-capital re-rating and convertible dilution) and Calibration (checks vs guidance and
  consensus; a miss shows). The tornado, grid and breakevens recompute once the sliders rest.
  Print shows a static snapshot instead.
- **Routes:** `#/reports/<slug>/model` shows the report header + the model full-width. The
  model's state rides in `?m=<base64url>` on either route (decoded and clamped by
  `ModelEngine.decodeState`, never evaluated).
- **Citations:** every `src` and inline `[sN]` in the model file points at the PARENT report's
  `sources`. Add new sources to the report first.
- **Optional `guides`:** company guidance the model is compared with, e.g.
  `{"label": "Q3 2026 interest expense guide", "metric": "interest", "period": "2026-Q3",
  "lo": 360, "hi": 390, "src": ["s12"]}`. A quarter inside the stub year is compared with the
  projected remainder of that year spread evenly over its quarters; an interest guide is also
  drawn as a bracket on the stub-year interest bar.
- **Depreciation inputs (`opening`):** `cip` (construction in progress, a vintage entering
  service `cip_in_service` years after the opening date), `dep_nbv` (book value of assets in
  service) and `dep_rate` (their annual D&A at the base useful life; a different life re-spreads
  the same book value, never more). Fallback: `dep_base` (gross in service) / base life, and net
  PP&E less CIP. The `in_service_lag` driver delays depreciation of new capex.
- **Debt extensions (`debt[]`):** `fee_bp` (non-cash issue-cost / discount amortisation: in P&L
  interest, added back in OCF), `amort: "schedule"` + `schedule {"<year>": principal}`,
  `amort_start`, `issued` (+ `issue_cash`, `issue_equity`) for financing after the balance-sheet
  date, `conv_price` + `cap_price` for net-share dilution above a capped call at the exit price.
- **Rates (`rates`):** `alt_paths [{id, name, path, src, note}]` (the `rate_path` choice driver
  picks one; share links carry the id), `new_debt_ref_year` (the new-debt rate is set at the base
  path's level in that year and moves with the selected path), `shift_from` (YYYY-MM: SOFR and
  spread shifts start there; earlier months are realised). `spread_shift` moves only new and
  refinanced debt — contractual margins never move.
- **Funding, covenants, consensus, valuation:** `funding.committed [{id, name, amount, kind,
  spread_bp|coupon_pct, fee_bp, available_until, maturity, secured, src}]` is drawn before any new
  debt, `funding.new_debt_secured_pct` sets the secured share of new debt; `covenants [{id, label,
  metric, max|min, kind: covenant|threshold, src}]` returns per-year breaches (and warnings);
  `consensus {label, src, rows}` feeds the comparison table; `valuation.rate_link {debt_weight,
  growth_pct}` re-rates the exit multiple by (WACC0 − g)/(WACC − g); `scenarios[].prob` (summing
  to 100) gives the weighted value; a shift/scale driver's `stub_weight` (0–1) holds the guided
  stub year. Revenue follows in-service capacity at `capex_revenue_link` %.
- **Engine API** (`ModelEngine`): `project`, `sensitivity`, `grid`, `solve` (breakeven driver
  value for a metric target), `weighted`, `applyScenario` / `matchScenario`, `encodeState` /
  `decodeState`, `ratePaths`, `drivers`; suite `node scripts/test_model.js` (in CI).
- **Publishing bar** (`scripts/test_reports.js`): every template driver present with the
  template's kind, `base`/`low`/`high` inside `[min, max]`, `low < high`, paths covering every
  model year, a `base` scenario, scenario values on known drivers and in range (a choice driver:
  a known path id), probabilities summing to 100, well-formed tranches (schedules summing to the
  balance), committed facilities, covenants that cite their terms, a cited `share_price`, and no
  engine errors or compile warnings.
