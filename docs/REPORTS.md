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
