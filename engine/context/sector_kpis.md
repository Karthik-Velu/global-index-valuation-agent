# Sector KPI playbook (shared)

Guidance for proposing and validating sector-specific KPIs. Grows over time via
appended lessons.

- Propose KPIs that are **sector-differentiating**, not generic income-statement lines
  (revenue and net income are already covered universally).
- Give each: `metric_code` (snake_case), `label`, `definition`, `unit`, `source_hint`.
- Units must be honest: a metric tagged ratio/percent should sit in 0–1 or 0–100. If its
  median is in the thousands it is mis-tagged (it's a raw amount, not a ratio).
- Prefer KPIs derivable from audited filings (10-K/10-Q XBRL) over ones that need
  management-deck scraping; mark the harder ones with a clear `source_hint`.

## Known-good examples by sub-sector
- **Banks:** net_interest_margin, cost_to_income, npl_ratio, cet1_ratio, deposit_growth.
- **Semiconductors:** gross_margin, capex_intensity, inventory_days, book_to_bill.
- **SaaS / Software:** net_revenue_retention, rpo (remaining performance obligations), rule_of_40.
- **Autos / EV:** deliveries, gross_margin_ex_credits, capex, average_selling_price.

## Lessons (appended)
- (2026-06-27) Validators previously demoted 5 ratio metrics (gross_margin,
  asset_turnover, net_debt_to_ebitda, sga_ratio, interest_coverage) that had been
  mis-tagged as XBRL-direct — these must be COMPUTED from components, not pulled as a tag.
