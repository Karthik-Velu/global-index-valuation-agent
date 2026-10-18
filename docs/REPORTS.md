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

- **What the reader gets:** scenario chips, Reset, Copy link; seven headline KPIs with their
  change vs the base scenario; a "Key P&L drivers" callout written from the tornado; sliders +
  numeric inputs per driver; tabs for the P&L projection, Interest & debt (predicted SOFR path,
  all-in cost of debt, interest by tranche, maturity ladder, debt stack), Sensitivity (tornado +
  two-way grid), Valuation & multiples (forward multiples at price vs at model value, exit
  bridge) and Calibration (checks vs guidance). Print shows a static snapshot instead.
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
- **Optional `opening.dep_base`:** the opening PP&E that actually depreciates (gross PP&E less
  construction in progress and land, or a base calibrated to the latest quarter's D&A). Existing
  assets depreciate on it over `useful_life` until opening net PP&E is used up; without it the
  engine uses `gross_ppe`. CoreWeave's is 36,000 against 52,622 gross (US$11.9bn of CIP), which
  lands FY2026 adj. operating income inside guidance.
- **Publishing bar** (`scripts/test_reports.js`): every template driver present with the
  template's kind, `base`/`low`/`high` inside `[min, max]`, `low < high`, paths covering every
  model year, a `base` scenario, scenario values on known drivers and in range, well-formed
  tranches, a cited `share_price`, and no engine errors or warnings.
