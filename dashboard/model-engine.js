// Model engine — the stress-test / projection core behind a report's {"type":"model"} block
// (dashboard/reports/models/<slug>.json, MODEL SPEC v1, docs/REPORTS.md). It turns a spec
// (stub-year actuals, opening balance sheet, debt tranches, committed facilities, SOFR paths
// and a set of drivers) plus the viewer's slider overrides into a five-year P&L, cash flow,
// debt schedule, covenant tests, forward multiples and an exit-multiple value per share; then
// tornado sensitivities, 2-D grids, breakevens, scenarios (and their probability-weighted
// value), business risk / upside events with their probability distribution, and a
// share-link state codec on top.
//
// Pure: no DOM, no fetch, no deps, never throws (bad input -> {error} / warnings). Every
// number it returns is finite or null. Deterministic: the only iteration (new debt pays
// interest that widens the funding gap it fills) is a fixed-point loop with a fixed cap;
// breakevens are a fixed scan + bisection; the Monte Carlo draws come from a seeded PRNG.
//
// Semantics (levered_growth_v1; money in spec.unit, shares in millions):
//  - Stub year: FY = stub.actuals (H1) + a projected remainder. Revenue growth and the capex
//    path are FULL-YEAR figures (FY over prior.revenue; FY capex), so the projected part is
//    FY minus actuals; cost/opex/SBC ratios apply to the projected revenue only. Flows in
//    the projected part are scaled by (12 - actual_months)/12; the balance sheet starts at
//    opening.date, so cash/debt roll-forwards use the projected part only (ocf_proj, capex_proj).
//    A shift/scale driver's `stub_weight` (0–1, default 1) is the share of its slider move
//    applied to the stub year (0 = the guided year stays at its path).
//  - Revenue = the growth path x a capacity multiplier: 1 + capex_revenue_link x (in-service
//    PP&E under the current capex / under the path capex - 1), month-averaged per period. At
//    link 0 (the template default) revenue ignores capex.
//  - Revenue model capacity_v1 (spec.revenue_model; replaces revenue_growth, capex_revenue_link,
//    the capex path and cost_of_revenue_pct, which are then not drivers). Monthly, from the
//    month after opening.date: active MW = the year-end / monthly path (linear between anchors,
//    realised up to the opening month, never falling after it), shifted right by
//    delivery_delay_months (and delay events; summed, capped at ±max_delay_months) from
//    adjust_from, plus extra_capacity_mw phased in and mw_delta events. Billing MW = average
//    active MW billing_lag_months earlier x utilisation; revenue = billing MW x revenue per
//    billing MW-year / 12, less renewals: each year renewing_share of billing MW re-signs at
//    renewal_price_reset (renewal_churn of it does not re-sign), and that price / volume change
//    persists. Customer shares split it; a customer_cut takes a share of one customer's
//    revenue. A backstop (a counterparty that buys unsold capacity up to a cap, until a date)
//    pays coverage x the value of capacity left unsold by the stress (utilisation below its
//    path, extra churn, customer cuts), or of all unsold capacity (basis "all"). Cost of
//    revenue = average active MW x cor_per_mw (rent_share of it is rent, power_share power:
//    power_cost_shift scales the exposed power part) + cor_other_pct x revenue; self-built MW
//    pay no rent. Capex = MW energised lead_months later x capex_per_mw (+ shell capex per
//    self-built MW, depreciated over self_build.life) + maintenance_capex_pct x revenue.
//    Slider moves start at adjust_from; capex_per_mw and cor_per_mw scale their paths by
//    value / base. Backlog: RPO converts by bucket from its as-of month; contracted revenue
//    (from the spec's base, invariant to stresses) vs modelled revenue gives coverage and the
//    warnings (modelled < contracted, coverage below coverage_warn).
//  - Events (spec.events; on/off per run): dated business risks / upsides whose impacts act on
//    the drivers from their `from` month (capacity impacts need a revenue_model). Events in one
//    `group` are mutually exclusive. distribution() weights every joint state (exact up to
//    4,096 states, else 2,000 seeded Monte Carlo draws).
//  - Interest per tranche on its time-weighted balance (monthly; equals the average of opening
//    and closing balance while a tranche amortises linearly). Floating = max(0, SOFR +
//    sofr_shift) + spread; fixed = coupon; plus fee_bp of non-cash issue-cost / discount
//    amortisation (P&L only; added back in operating cash flow). Contractual margins never
//    move with spread_shift. Tranches can start later (issued, with issue_cash), amortise
//    straight-line (from amort_start), on an explicit per-year `schedule`, or be bullets;
//    a bullet that matures rolls over into the new-debt rate.
//  - Hedges (spec.hedges): pay-fixed swaps on a floating tranche or committed facility — a
//    notional (or a ratio of the balance) pays fixed_rate (or the SOFR path at its start,
//    "path") + the loan's spread between start and maturity. Fixed / floating outputs: debt and
//    interest split into fixed (incl. swapped), floating (unhedged), and new / refinanced debt.
//  - New-debt rate (per year) = new_debt_rate + spread_shift + beta x SOFR move, where the SOFR
//    move is sofr_shift alone, or — when rates.new_debt_ref_year is set — the selected path's
//    gap to the base path's reference-year value plus sofr_shift. rates.shift_from (YYYY-MM)
//    starts both shifts at that month (earlier months are realised). rate_path picks
//    rates.path (0) or one of rates.alt_paths. Without new_debt_floating_share /
//    hedge_ratio_new in the spec, the whole new-debt pool (and every refinanced bullet) reprices
//    each year at that year's rate; with them, each year's borrowing is a vintage: the fixed
//    share (and the swapped floating share) locks its year's rate, the rest keeps its margin
//    and resets with SOFR. funding.new_debt_amort_years amortises the floating (asset-backed)
//    share straight-line from the year after it is raised.
//  - Funding gap = max(0, min_cash - (cash + OCF - capex - amortisation + issue cash));
//    equity_funding_share of it is sold at share_price x (1 - issue_discount); the rest is
//    drawn from funding.committed facilities while their windows are open (their own terms),
//    then borrowed into the "new-debt" pool at the new-debt rate (half-year interest in the
//    year raised), up to a new_debt_cap event's limit (the rest is a funding shortfall and
//    cash falls below min_cash). Surplus cash repays nothing.
//  - OCF ~ net income + D&A + SBC + non-cash interest + wc_prepay_pct x Δrevenue (no other
//    working capital). Tax = max(tax_rate x positive pre-tax profit, min_tax) per period (no
//    loss carry-forward). sbc_share_pct of SBC becomes new shares at share_price.
//  - D&A: in-service assets at the opening date (opening.dep_nbv, at opening.dep_rate a year at
//    the base useful life; a different life re-spreads the same book value) until their book
//    value is used up; construction in progress (opening.cip) enters service opening.
//    cip_in_service years in; each period's capex enters service in_service_lag years after
//    mid-period; both depreciate straight-line over useful_life. Fallbacks: dep_rate =
//    dep_base / base life (dep_base default gross PP&E), dep_nbv = net PP&E - cip.
//  - Value: exit_ev_ebitda x a cost-of-capital adjustment x adj. EBITDA (before SBC) of
//    valuation.exit_year, less net debt and over shares at the last year-end on/before
//    valuation_date (net_debt_at "exit"; or "exit_year_end"), floored at 0, discounted at
//    discount_rate from spec.asof. With valuation.rate_link {debt_weight, growth_pct} the
//    multiple re-rates by (WACC0 - g) / (WACC - g), WACC = w x new-debt rate (exit year) +
//    (1 - w) x cost of equity, WACC0 at the spec's defaults. Convertibles with conv_price and
//    cap_price add net shares above the capped-call cap (solved at the exit price).
//  - Multiples: EV of year t = price x shares + net debt at the end of year t - 1 (the start
//    of the year; the opening balance sheet for the first year), so the debt that buys the
//    year's EBITDA is in its EV. "At value" uses the exit-date value per share, so the exit
//    year reproduces the effective exit multiple. ev_ebitda_static keeps today's EV.
//
// UMD: assigns window.ModelEngine in the browser and module.exports under Node. It
// declares no other global (dashboard/*.js share one scope, see scripts/test_screens.js).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ModelEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = 1;
  const NEW_DEBT_ID = 'new-debt';          // reserved tranche id: the pool that funds gaps
  const MAX_STATE_LEN = 4096;              // share-link payload cap (chars)
  const MAX_GRID = 60;                     // grid axis cap (cells per side)
  const FIX_ITERS = 60, FIX_TOL = 1e-9;    // funding fixed point: contraction factor ~ rate*T/2
  const YR_MS = 365.25 * 864e5;
  const MAX_EVENTS = 40;                   // event catalogue cap
  const EXACT_MAX = 4096;                  // distribution: exact enumeration up to this many joint states
  const MC_DRAWS = 2000, MC_SEED = 20261018;
  const GRID_PAD = 36;                     // months of capacity path kept before / after the model

  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const isNum = x => typeof x === 'number' && isFinite(x);
  const num = (x, d) => (isNum(x) ? x : d);
  const fin = x => (isNum(x) ? x : null);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const div = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);
  const str = (x, n) => (typeof x === 'string' ? x.slice(0, n) : '');
  const srcList = x => (Array.isArray(x) ? x.filter(s => typeof s === 'string').slice(0, 20) : []);
  const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;          // driver / event / customer ids (no leading _ : no __proto__)
  const TRANCHE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;  // kebab tranche ids

  // ---- template: levered_growth_v1 -------------------------------------------------------
  // A capital-intensive grower funded by a debt stack (CoreWeave is the first user). The spec
  // supplies values for these drivers; the template supplies semantics and fallbacks for any
  // field the spec leaves out. low/high = the plausible stress range the tornado uses.
  // mode "growth" = only without a revenue_model; "capacity" = only with one (capacity_v1);
  // optin = only when the spec lists it; cap_required = required with a revenue_model.
  const GROUPS = ['Capacity & delivery', 'Pricing & mix', 'Revenue', 'Unit costs', 'Margins', 'Working capital', 'Capex & depreciation',
    'Financing & rates', 'Dilution', 'Valuation', 'Market'];
  const drv = (id, group, kind, unit, base, min, max, step, low, high, dp, label, help, extra) =>
    Object.assign({ id, group, kind, unit, base, min, max, step, low, high, dp, label, help, required: true }, extra || {});
  const OPT = { required: false };
  const GROWTH = { mode: 'growth' }, GROWTH_OPT = { required: false, mode: 'growth' };
  const CAP = { required: false, mode: 'capacity', cap_required: true }, CAP_OPT = { required: false, mode: 'capacity', optin: true };
  const CAP_DEF = { required: false, mode: 'capacity' };     // capacity_v1, template default when the spec omits it
  const OPTIN = { required: false, optin: true };
  const LG_DRIVERS = [
    drv('revenue_growth', 'Revenue', 'shift_pp', 'pp', 0, -40, 40, 1, -10, 5, 1, 'Revenue growth',
      'Shifts every year of the revenue-growth path (FY over FY, fundamental growth) by this many points.', GROWTH),
    drv('capex_revenue_link', 'Revenue', 'scalar', '%', 0, 0, 100, 10, 0, 100, 0, 'Revenue follows capex',
      'How far revenue tracks the in-service build-out when capex moves off its path: 100% = one-for-one with in-service PP&E, 0% = revenue ignores capex.', GROWTH_OPT),
    drv('delivery_delay_months', 'Capacity & delivery', 'scalar', 'months', 0, -6, 24, 1, -2, 9, 0, 'Delivery delay',
      'Months by which every MW due after the adjust-from month comes online later (negative = early). Revenue, cost of revenue and capex follow the MW.', CAP),
    drv('extra_capacity_mw', 'Capacity & delivery', 'scalar', 'MW', 0, -3000, 6000, 50, -500, 1000, 0, 'Capacity beyond plan',
      'Extra MW contracted and energised on top of the base path, phased in (negative = fewer MW, e.g. a capex cut).', CAP),
    drv('utilization', 'Capacity & delivery', 'scalar', 'pp', 0, -30, 10, 1, -5, 2, 0, 'Utilisation',
      'Points added to the share of energised MW that is billing (renewal gaps, slower ramp-up). Acts only on capacity not under contract: take-or-pay MW bill once delivered.', CAP),
    drv('sell_through', 'Capacity & delivery', 'scalar', '%', 100, 0, 100, 5, 75, 100, 0, 'Uncontracted capacity sold',
      'Share of the capacity not yet under contract (new MW and renewals) that is sold by the time it goes live. Unsold MW keep their rent and power but bill nothing; most of their GPU capex is not spent.', CAP_DEF),
    drv('revenue_per_mw_shift', 'Pricing & mix', 'scalar', '%', 0, -50, 50, 1, -10, 10, 0, 'Price per MW',
      'Scales revenue per billing MW-year on capacity priced after the adjust-from month (new and renewing contracts); capacity already under contract keeps its price.', CAP),
    drv('renewal_price_reset', 'Pricing & mix', 'scalar', 'pp', 0, -60, 40, 5, -30, 10, 0, 'Renewal pricing',
      'Points added to the price change on contracts that expire and renew. Touches only the capacity renewing each year.', CAP),
    drv('cost_of_revenue_pct', 'Margins', 'shift_pp', 'pp', 0, -20, 20, 0.5, -3, 5, 1, 'Cost of revenue',
      'Cost of revenue as % of revenue, excluding D&A. A positive shift squeezes gross margin.', GROWTH),
    drv('cor_per_mw', 'Unit costs', 'scalar', 'US$m', 3, 0.1, 20, 0.05, 2.7, 3.6, 2, 'Cost of revenue per MW',
      'Power, data-centre rent and site operations per average active MW-year at the base year\'s level; scales every year\'s path.', CAP),
    drv('power_cost_shift', 'Unit costs', 'scalar', '%', 0, -50, 200, 5, -10, 40, 0, 'Power price',
      'Scales the power share of cost of revenue: the part not passed through to customers.', CAP_OPT),
    drv('opex_pct', 'Margins', 'shift_pp', 'pp', 0, -15, 15, 0.5, -2, 3, 1, 'Operating costs',
      'Technology & infrastructure, sales & marketing and G&A excluding D&A and SBC, as % of revenue.'),
    drv('sbc_pct', 'Margins', 'scalar', '%', 5, 0, 40, 0.5, 3, 8, 1, 'Stock-based comp',
      'Stock-based compensation as % of revenue: below adjusted EBITDA, a real cost to shareholders.'),
    drv('capex', 'Capex & depreciation', 'scale_pct', '%', 0, -60, 60, 5, -25, 20, 0, 'Capex',
      'Scales the full-year capex path. More capex buys future revenue but must be funded now.', GROWTH),
    drv('capex_per_mw', 'Unit costs', 'scalar', 'US$m', 35, 1, 100, 0.5, 30, 42, 1, 'Capex per MW',
      'Capex per MW energised (GPUs, networking, fit-out) at the base year\'s level; scales every year\'s path.', CAP),
    drv('self_build_share', 'Capex & depreciation', 'scalar', '%', 0, 0, 100, 5, 0, 30, 0, 'Self-built share of new MW',
      'Share of MW energised from the self-build start in owned sites: no rent, but shell and power capex depreciated over a long life.', CAP_OPT),
    drv('useful_life', 'Capex & depreciation', 'scalar', 'yrs', 6, 2, 10, 0.5, 4, 7, 1, 'Depreciation life',
      'Straight-line accounting life of GPUs and data-centre gear. Shorter = more D&A, lower EBIT; EBITDA unchanged. With a revenue_model it applies from the adjust-from month.'),
    drv('economic_life', 'Capex & depreciation', 'scalar', 'yrs', 6, 2, 10, 0.5, 4, 8, 1, 'Economic life',
      'Years a GPU earns rent before it must be replaced: capacity past it does not renew. Sets the run-off value of the fleet in place and, with valuation.life_link, re-rates the exit multiple.', CAP_OPT),
    drv('in_service_lag', 'Capex & depreciation', 'scalar', 'yrs', 0, 0, 3, 0.05, 0, 1, 2, 'In-service lag',
      'Time from spending capex to the asset entering service and starting to depreciate.', OPT),
    drv('rate_path', 'Financing & rates', 'choice', 'path', 0, 0, 0, 1, null, null, 0, 'Rate path',
      'Which projected SOFR path the model runs on.', OPT),
    drv('rate_shock_start', 'Financing & rates', 'choice', 'path', 0, 0, 0, 1, null, null, 0, 'Rate shock starts',
      'When the SOFR and spread shifts start (rates.shift_options): now, or later, after more debt is fixed.', { required: false, optin: true, choice_set: 'shift' }),
    drv('sofr_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 500, 25, -100, 200, 0, 'SOFR shift',
      'Parallel shift to the projected SOFR path. Moves floating-rate interest 1:1 and the cost of new debt.'),
    drv('spread_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 800, 25, -100, 300, 0, 'Credit spread shift',
      'Widens (or tightens) the spread on new and refinanced debt. Contractual margins on existing loans do not move.'),
    drv('new_debt_rate', 'Financing & rates', 'scalar', '%', 9, 2, 25, 0.25, 7, 13, 2, 'New-debt rate',
      'All-in cost of new borrowing and of refinancing maturing debt, at the base SOFR path.'),
    drv('new_debt_floating_share', 'Financing & rates', 'scalar', '%', 50, 0, 100, 5, 30, 85, 0, 'New debt raised floating',
      'Share of new borrowing raised as SOFR-priced loans (delayed-draw GPU financing) rather than fixed-coupon notes. Fixed debt locks its year\'s rate; floating keeps its margin and resets with SOFR.', OPTIN),
    drv('hedge_ratio_new', 'Financing & rates', 'scalar', '%', 60, 0, 100, 5, 25, 95, 0, 'New floating debt swapped',
      'Share of new floating borrowing swapped to a fixed rate when it is raised.', OPTIN),
    drv('equity_funding_share', 'Dilution', 'scalar', '%', 0, 0, 100, 5, 0, 50, 0, 'Gap funded by equity',
      'Share of any funding gap met by selling new shares instead of borrowing.'),
    drv('issue_discount', 'Dilution', 'scalar', '%', 5, 0, 60, 1, 0, 25, 0, 'Issue discount',
      'Discount to the share price at which new shares are sold. Deeper discount = more shares per dollar.'),
    drv('share_dilution_pct', 'Dilution', 'scalar', '%', 0, 0, 20, 0.5, 0, 4, 1, 'Share-count creep',
      'Annual growth in shares from employee equity (RSUs/options), on top of any equity raised.', OPT),
    drv('sbc_share_pct', 'Dilution', 'scalar', '%', 0, 0, 100, 10, null, null, 0, 'SBC paid in shares',
      'Share of stock-based comp that becomes new shares at the share price.', OPT),
    drv('min_cash', 'Financing & rates', 'scalar', 'US$m', 1000, 0, 1e6, 100, 500, 3000, 0, 'Minimum cash',
      'Cash the company keeps on hand; anything below it is a funding gap that must be raised.'),
    drv('wc_prepay_pct', 'Working capital', 'scalar', '%', 0, 0, 100, 5, 0, 30, 0, 'Customer prepayments',
      'Customer prepayments / deferred-revenue inflow as % of each year\'s revenue increase.'),
    drv('tax_rate', 'Margins', 'scalar', '%', 21, 0, 50, 1, 15, 25, 0, 'Tax rate',
      'Cash tax on positive pre-tax profit only (losses are not carried forward).'),
    drv('min_tax', 'Margins', 'scalar', 'US$m', 0, 0, 1e5, 10, null, null, 0, 'Tax in loss years',
      'Tax charge booked each year even when pre-tax profit is negative (state and foreign tax, deferred tax).', OPT),
    drv('exit_ev_ebitda', 'Valuation', 'scalar', 'x', 8, 1, 40, 0.5, 6, 11, 1, 'Exit EV/EBITDA',
      'Multiple of adjusted EBITDA the market pays for the business at the exit date.'),
    drv('discount_rate', 'Valuation', 'scalar', '%', 12, 3, 40, 0.5, 10, 16, 1, 'Cost of equity',
      'Annual return a shareholder demands; discounts the exit value back to today.'),
    drv('share_price', 'Market', 'scalar', 'US$', 0, 0, 1e5, 0.01, null, null, 2, 'Share price',
      'Current share price (a cited public close). Sets forward multiples and the price of new equity.'),
  ];

  // Row metadata for the UI: label, unit and section; dp = default decimals.
  const R = (label, unit, section, dp) => ({ label, unit, section, dp });
  const LG_ROWS = {
    revenue: R('Revenue', 'US$m', 'P&L', 0), revenue_growth: R('Revenue growth', '%', 'P&L', 1),
    cost_of_revenue: R('Cost of revenue', 'US$m', 'P&L', 0), gross_profit: R('Gross profit', 'US$m', 'P&L', 0),
    gross_margin: R('Gross margin', '%', 'P&L', 1), opex: R('Operating costs (ex D&A, SBC)', 'US$m', 'P&L', 0),
    ebitda: R('Adj. EBITDA', 'US$m', 'P&L', 0), ebitda_margin: R('Adj. EBITDA margin', '%', 'P&L', 1),
    sbc: R('Stock-based comp', 'US$m', 'P&L', 0), da: R('Depreciation & amortisation', 'US$m', 'P&L', 0),
    adj_op_income: R('Adj. operating income (EBITDA − D&A)', 'US$m', 'P&L', 0),
    ebit: R('EBIT', 'US$m', 'P&L', 0), interest: R('Interest expense', 'US$m', 'P&L', 0),
    interest_noncash: R('of which non-cash (fees, discount)', 'US$m', 'P&L', 0),
    other_income: R('Other income (actual)', 'US$m', 'P&L', 0), pretax: R('Pre-tax profit', 'US$m', 'P&L', 0),
    tax: R('Tax', 'US$m', 'P&L', 0), net_income: R('Net income', 'US$m', 'P&L', 0),
    shares_avg: R('Avg shares', 'm', 'P&L', 1), eps: R('EPS', 'US$', 'P&L', 2),
    ocf: R('Operating cash flow', 'US$m', 'Cash flow', 0), capex: R('Capex', 'US$m', 'Cash flow', 0),
    fcf: R('Free cash flow', 'US$m', 'Cash flow', 0), funding_gap: R('Funding gap', 'US$m', 'Cash flow', 0),
    new_debt: R('New debt raised', 'US$m', 'Cash flow', 0), committed_draws: R('of which committed facilities', 'US$m', 'Cash flow', 0),
    uncommitted_debt: R('of which new (uncommitted) debt', 'US$m', 'Cash flow', 0),
    new_equity_m: R('Equity raised', 'US$m', 'Cash flow', 0), new_shares: R('New shares issued', 'm', 'Cash flow', 1),
    sbc_shares: R('Shares issued for SBC', 'm', 'Cash flow', 1),
    repayments: R('Scheduled amortisation', 'US$m', 'Cash flow', 0), refinanced: R('Maturities refinanced', 'US$m', 'Cash flow', 0),
    issued: R('Debt issued after the balance-sheet date', 'US$m', 'Cash flow', 0),
    funding_cum: R('Funding raised (cumulative)', 'US$m', 'Cash flow', 0),
    uncommitted_cum: R('Uncommitted funding need (cumulative)', 'US$m', 'Cash flow', 0),
    committed_left: R('Committed facilities still undrawn', 'US$m', 'Cash flow', 0),
    gross_borrowing: R('Gross new borrowing (incl. refinancing)', 'US$m', 'Cash flow', 0),
    funding_shortfall: R('Funding not raised (debt markets shut)', 'US$m', 'Cash flow', 0),
    sofr: R('SOFR (avg)', '%', 'Debt', 2), new_debt_rate: R('New-debt rate', '%', 'Debt', 2),
    avg_cost_of_debt: R('Avg cost of debt', '%', 'Debt', 2),
    debt_end: R('Total debt', 'US$m', 'Debt', 0), secured_debt: R('Secured debt', 'US$m', 'Debt', 0), cash_end: R('Cash', 'US$m', 'Debt', 0),
    liquidity: R('Liquidity (cash + undrawn committed)', 'US$m', 'Debt', 0),
    net_debt: R('Net debt', 'US$m', 'Debt', 0), net_debt_ebitda: R('Net debt / EBITDA', 'x', 'Debt', 1),
    gross_debt_ebitda: R('Total debt / EBITDA', 'x', 'Debt', 1), secured_debt_ebitda: R('Secured debt / EBITDA', 'x', 'Debt', 1),
    interest_cover: R('Interest cover (EBITDA/interest)', 'x', 'Debt', 1),
    ebit_cover: R('EBIT / interest', 'x', 'Debt', 2), ebitda_capex_cover: R('(EBITDA − capex) / interest', 'x', 'Debt', 1),
    interest_to_ebitda: R('Interest as % of adj. EBITDA', '%', 'Debt', 0),
    // incurrence tests on the exit run-rate: debt over the last quarter's adj. EBITDA x 4
    ebitda_exit_rate: R('Adj. EBITDA, Q4 annualised', 'US$m', 'Debt', 0),
    gross_debt_ebitda_lqa: R('Total debt / Q4 EBITDA x 4', 'x', 'Debt', 1), secured_debt_ebitda_lqa: R('Secured debt / Q4 EBITDA x 4', 'x', 'Debt', 1),
    shortfall_interest: R('Cost of unfunded gap (penalty rate)', 'US$m', 'Debt', 0),
    // fixed vs floating (after swaps); "new" = new and refinanced borrowing
    debt_fixed: R('Fixed-rate debt (incl. swapped)', 'US$m', 'Interest mix', 0),
    debt_floating: R('Floating-rate debt (unhedged)', 'US$m', 'Interest mix', 0),
    debt_new_fixed: R('New & refinanced debt: fixed', 'US$m', 'Interest mix', 0),
    debt_new_floating: R('New & refinanced debt: floating', 'US$m', 'Interest mix', 0),
    hedged_notional: R('Interest-rate swaps outstanding', 'US$m', 'Interest mix', 0),
    floating_share_of_debt: R('Floating share of debt', '%', 'Interest mix', 1),
    interest_fixed: R('Interest on fixed-rate debt', 'US$m', 'Interest mix', 0),
    interest_floating: R('Interest on floating-rate debt', 'US$m', 'Interest mix', 0),
    interest_new: R('Interest on new & refinanced debt', 'US$m', 'Interest mix', 0),
    interest_new_fixed: R('of which fixed', 'US$m', 'Interest mix', 0), interest_new_floating: R('of which floating', 'US$m', 'Interest mix', 0),
    floating_share_of_interest: R('Floating share of interest', '%', 'Interest mix', 1),
    rate_exposure_100bp: R('+100bp SOFR: extra interest', 'US$m', 'Interest mix', 0),
    rate_exposure_reset: R('of which floating debt resetting', 'US$m', 'Interest mix', 0),
    rate_exposure_issuance: R('of which fixed debt issued at higher rates', 'US$m', 'Interest mix', 0),
    // EBITDA -> free cash flow
    cash_interest: R('Cash interest', 'US$m', 'Cash bridge', 0), cash_tax: R('Tax paid', 'US$m', 'Cash bridge', 0),
    wc_prepay: R('Customer prepayments', 'US$m', 'Cash bridge', 0), other_cash: R('Other working capital and items (reported months)', 'US$m', 'Cash bridge', 0),
    fcf_pre_growth: R('Cash flow before growth capex (OCF − maintenance capex)', 'US$m', 'Cash bridge', 0),
    // capacity_v1
    active_mw_end: R('Active power (year-end)', 'MW', 'Capacity', 0), active_mw_avg: R('Active power (average)', 'MW', 'Capacity', 0),
    mw_added: R('MW energised in the year', 'MW', 'Capacity', 0), billing_mw_avg: R('Billing MW (average)', 'MW', 'Capacity', 0),
    utilization_avg: R('Utilisation (billing ÷ lagged active MW)', '%', 'Capacity', 1),
    revenue_per_billing_mw: R('Revenue per billing MW-year (net of renewals)', 'US$m', 'Capacity', 2),
    list_price_per_billing_mw: R('List price per billing MW-year (before renewal resets)', 'US$m', 'Capacity', 2),
    renewal_price_change: R('Price change on renewals (vs the expiring contract)', '%', 'Capacity', 0),
    unsold_mw: R('Uncontracted MW left unsold (average)', 'MW', 'Capacity', 0),
    active_mw_vs_plan: R('Active power vs the base plan (year-end)', '%', 'Capacity', 0),
    mw_deferred: R('MW not built for lack of funding (year-end)', 'MW', 'Capacity', 0),
    revenue_per_mw: R('Revenue per average active MW-year', 'US$m', 'Capacity', 2),
    renewal_effect: R('Renewals: revenue gained (+) / lost (−)', 'US$m', 'Capacity', 0),
    backstop_revenue: R('Backstop purchases of unsold capacity', 'US$m', 'Capacity', 0),
    backstop_left: R('Backstop still available (year-end)', 'US$m', 'Capacity', 0),
    contracted_revenue: R('Contracted revenue (backlog conversion)', 'US$m', 'Backlog & customers', 0),
    uncontracted_revenue: R('Revenue not yet contracted', 'US$m', 'Backlog & customers', 0),
    backlog_coverage: R('Contracted ÷ modelled revenue', '%', 'Backlog & customers', 0),
    top_customer_share: R('Largest customer\'s share of revenue', '%', 'Backlog & customers', 1),
    top_contracted_share: R('Largest customer\'s share of contracted revenue', '%', 'Backlog & customers', 1),
    backlog_remaining: R('Backlog signed to date, still to convert (year-end)', 'US$m', 'Backlog & customers', 0),
    top_backlog_share: R('Largest customer\'s share of that backlog', '%', 'Backlog & customers', 1),
    uncontracted_run_rate: R('Not-yet-contracted revenue, December run-rate', 'US$m', 'Backlog & customers', 0),
    bookings_needed: R('New contract value the plan needs (signed by go-live)', 'US$m', 'Backlog & customers', 0),
    undelivered_credits: R('Credits on contracted capacity not delivered', 'US$m', 'Backlog & customers', 0),
    capex_capacity: R('Capex for new MW', 'US$m', 'Unit costs', 0), capex_maintenance: R('Maintenance capex', 'US$m', 'Unit costs', 0),
    capex_self_build: R('Self-build shell & power capex', 'US$m', 'Unit costs', 0),
    capex_per_mw_eff: R('Capex per MW energised', 'US$m', 'Unit costs', 1),
    cor_per_mw_eff: R('Cost of revenue per average active MW-year', 'US$m', 'Unit costs', 2),
    rent: R('Data-centre rent (in cost of revenue)', 'US$m', 'Unit costs', 0), power_cost: R('Power (in cost of revenue)', 'US$m', 'Unit costs', 0),
    rent_per_mw: R('Rent per leased MW-year', 'US$m', 'Unit costs', 2), owned_mw: R('Self-built MW (year-end)', 'MW', 'Unit costs', 0),
    idle_shell_mw: R('Leased MW without GPUs (average)', 'MW', 'Unit costs', 0), idle_rent: R('Rent on leased MW without GPUs', 'US$m', 'Unit costs', 0),
    net_ppe: R('Net PP&E', 'US$m', 'Balance sheet', 0), book_equity: R('Book equity', 'US$m', 'Balance sheet', 0),
    shares_end: R('Shares (year-end)', 'm', 'Balance sheet', 1),
    ev_sales: R('EV / sales (at price)', 'x', 'Multiples', 1), ev_ebitda: R('EV / EBITDA (at price)', 'x', 'Multiples', 1),
    ev_ebit: R('EV / EBIT (at price)', 'x', 'Multiples', 1), ev_ebitda_static: R('Today\'s EV / EBITDA', 'x', 'Multiples', 1),
    pe: R('P/E (at price)', 'x', 'Multiples', 1), fcf_yield: R('FCF yield (at price)', '%', 'Multiples', 1),
  };
  const CAP_ROWS = ['active_mw_end', 'active_mw_avg', 'mw_added', 'billing_mw_avg', 'utilization_avg', 'revenue_per_billing_mw', 'revenue_per_mw',
    'list_price_per_billing_mw', 'renewal_price_change', 'unsold_mw', 'active_mw_vs_plan', 'mw_deferred',
    'renewal_effect', 'backstop_revenue', 'backstop_left', 'contracted_revenue', 'uncontracted_revenue', 'backlog_coverage', 'top_customer_share',
    'top_contracted_share', 'backlog_remaining', 'top_backlog_share', 'uncontracted_run_rate', 'bookings_needed', 'undelivered_credits',
    'capex_capacity', 'capex_maintenance', 'capex_self_build', 'capex_per_mw_eff', 'cor_per_mw_eff', 'rent', 'power_cost', 'rent_per_mw', 'owned_mw',
    'idle_shell_mw', 'idle_rent'];
  const ROW_NAMES = Object.keys(LG_ROWS).concat(['cash_open', 'ocf_proj', 'capex_proj', 'da_existing', 'da_new',
    'interest_actual', 'proj_frac', 'capacity_mult', 'ev_at_price', 'new_debt_repaid', 'revenue_q4', 'cost_of_revenue_q4', 'revenue_proj']);
  const ROW_SET = new Set(ROW_NAMES), CAP_SET = new Set(CAP_ROWS);
  const CAP_EDITED = new Set(['revenue_per_mw', 'cor_per_mw_eff', 'rent', 'power_cost', 'rent_per_mw', 'contracted_revenue', 'uncontracted_revenue', 'backlog_coverage',
    'top_customer_share', 'top_contracted_share', 'revenue_per_billing_mw']);
  const RI = {};                                   // row name -> index (the projection writes rows by index)
  ROW_NAMES.forEach((k, j) => { RI[k] = j; });
  const CAP_IDX = CAP_ROWS.map(k => RI[k]);
  const rowPool = c => ROW_NAMES.map(() => new Array(c.years.length).fill(-0));
  const MULT_ROWS = new Set(['ev_sales', 'ev_ebitda', 'ev_ebit', 'ev_ebitda_static', 'pe', 'fcf_yield', 'ev_at_price']);
  const VAL_METRICS = ['value_per_share', 'upside_pct', 'exit_ev', 'exit_equity', 'exit_net_debt', 'exit_value_per_share', 'exit_multiple_eff',
    'value_forward_basis', 'value_last_year_exit', 'value_runoff'];
  const COV_METRICS = ['net_debt_ebitda', 'gross_debt_ebitda', 'secured_debt_ebitda', 'interest_cover', 'ebit_cover', 'ebitda_capex_cover', 'cash_end',
    'interest_to_ebitda', 'liquidity', 'gross_debt_ebitda_lqa', 'secured_debt_ebitda_lqa'];

  // Event impact vocabulary. cap = needs a capacity_v1 revenue_model. year_map = {"<year>": v}.
  const IM = (type, unit, min, max, cap, label) => ({ type, unit, min, max, cap: !!cap, label });
  const IMPACTS = {
    delay_months: IM('num', 'months', -12, 24, 1, 'MW come online later (months)'),
    mw_delta: IM('year_map', 'MW', -1e5, 1e5, 1, 'Change to year-end active MW'),
    revenue_per_mw_pct: IM('num', '%', -90, 300, 1, 'Price per MW on new and renewing capacity'),
    revenue_per_mw_fleet_pct: IM('num', '%', -90, 300, 1, 'Price per MW on the whole fleet (incl. contracted)'),
    delay_share: IM('num', 'share', 0, 1, 1, 'Share of the MW the delay touches'),
    capex_ahead: IM('num', 'share', 0, 1, 1, 'Share of the delayed GPU capex spent on the original schedule'),
    customer_cut: IM('cut', 'share', 0, 1, 1, 'Share of one customer\'s contracted revenue cancelled'),
    capacity_released: IM('release', 'MW', 0, 1e5, 1, 'Capacity coming off contract and not renewed'),
    renewal_price_reset_pp: IM('num', 'pp', -100, 100, 1, 'Renewal price change'),
    renewal_churn_pp: IM('num', 'pp', -100, 100, 1, 'Renewing capacity not re-signed'),
    utilization_pp: IM('num', 'pp', -100, 100, 1, 'Utilisation'),
    cor_per_mw_pct: IM('num', '%', -90, 300, 1, 'Cost of revenue per MW'),
    power_cost_pct: IM('num', '%', -90, 500, 1, 'Power price (exposed part)'),
    capex_delta: IM('year_map', 'US$m', -1e7, 1e7, 0, 'Capex added (US$m)'),
    spread_bp: IM('num', 'bp', -500, 3000, 0, 'Spread on new and refinanced debt'),
    new_debt_rate_pp: IM('num', 'pp', -20, 40, 0, 'New-debt rate'),
    new_debt_cap: IM('year_map', 'US$m', 0, 1e7, 0, 'Most new (uncommitted) debt that can be raised'),
    equity_share_pp: IM('num', 'pp', -100, 100, 0, 'Share of the funding gap met with equity'),
    issue_discount_pp: IM('num', 'pp', -100, 100, 0, 'Equity issue discount'),
    useful_life_delta: IM('num', 'yrs', -9, 9, 0, 'Depreciation life (from the event\'s start)'),
    stock_acquisition: IM('year_map', 'US$m', 0, 1e6, 0, 'Assets bought with new shares (US$m)'),
  };
  for (const v of Object.values(IMPACTS)) Object.freeze(v);

  const TEMPLATES = {
    levered_growth_v1: {
      id: 'levered_growth_v1', groups: GROUPS, drivers: LG_DRIVERS, rows: LG_ROWS,
      row_names: ROW_NAMES, valuation_metrics: VAL_METRICS, covenant_metrics: COV_METRICS, new_debt_id: NEW_DEBT_ID,
      // the tornado/grid metrics the UI offers; "<row>" metrics take a year
      metrics: ['value_per_share', 'net_income', 'interest', 'ebitda', 'net_debt_ebitda', 'gross_debt_ebitda', 'fcf', 'eps',
        'interest_cover', 'funding_cum', 'uncommitted_cum', 'revenue', 'interest_to_ebitda', 'floating_share_of_interest', 'liquidity'],
      revenue_models: ['capacity_v1'], capacity_rows: CAP_ROWS, event_impacts: IMPACTS,
    },
  };
  for (const t of Object.values(TEMPLATES)) {
    t.drivers.forEach(Object.freeze); Object.values(t.rows).forEach(Object.freeze);
    Object.freeze(t.capacity_rows); Object.freeze(t.event_impacts); Object.freeze(t);
  }

  // ---- spec normalization ----------------------------------------------------------------
  const monthIdx = s => {                          // "YYYY-MM" or "YYYY-MM-DD" -> y*12+m
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(typeof s === 'string' ? s : '');
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return (+m[1]) * 12 + (+m[2]);
  };
  const monthStr = m => `${Math.floor((m - 1) / 12)}-${String((m - 1) % 12 + 1).padStart(2, '0')}`;
  const yearOf = m => Math.floor((m - 1) / 12);
  const dayMs = s => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof s === 'string' ? s : '');
    if (!m) return null;
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    return isFinite(t) ? t : null;
  };
  const yearsBetween = (a, b) => (b - a) / YR_MS;
  // A start date, in model years from the opening date: "YYYY-MM-DD" exact, "YYYY-MM" = the
  // first of that month. null when absent or unreadable.
  function startTime(s, mOpen, open) {
    if (typeof s !== 'string') return null;
    const d = dayMs(s);
    if (d !== null && open !== null) return yearsBetween(open, d);
    const m = monthIdx(s);
    return m === null || mOpen === null ? null : (m - 1 - mOpen) / 12;
  }

  // per-year path {"2026": v, ...} -> array aligned with years; gaps carry the nearest
  // earlier value (or the first later one). null when the path has no usable value.
  function pathArr(p, years) {
    if (!isObj(p)) return null;
    const out = years.map(y => (own(p, String(y)) && isNum(p[String(y)]) ? p[String(y)] : null));
    if (out.every(v => v === null)) return null;
    let last = out.find(v => v !== null);
    for (let i = 0; i < out.length; i++) { if (out[i] === null) out[i] = last; else last = out[i]; }
    return out;
  }
  // {"<year>": v} -> array aligned with years, null where absent (no carry)
  function yearMap(p, years, lo, hi) {
    if (!isObj(p)) return null;
    const out = years.map(y => (own(p, String(y)) && isNum(p[String(y)]) ? clamp(p[String(y)], lo, hi) : null));
    return out.some(v => v !== null) ? out : null;
  }

  // Template drivers merged with the spec's values. Returns {list, byId}. `mode` is "growth"
  // (no revenue_model) or "capacity"; drivers of the other mode are dropped (with a warning
  // when the spec lists them), opt-in drivers appear only when the spec lists them.
  // Length caps on spec text (scripts/test_reports.js checks the published specs against them).
  const CAPS = { label: 160, help: 1200, unit: 20, mechanism: 1200, prob_note: 900, indicator: 300, watch_note: 600, latest_note: 600, scenario_note: 900, short_label: 26 };
  function normDrivers(spec, tpl, years, choices, mode, errors, warnings, shiftChoices) {
    const specById = new Map();
    for (const d of Array.isArray(spec.drivers) ? spec.drivers : []) {
      if (!isObj(d) || typeof d.id !== 'string' || !ID_RE.test(d.id)) { warnings.push('drivers: skipped an entry without a valid id'); continue; }
      if (specById.has(d.id)) { warnings.push(`drivers: duplicate id ${d.id} (first kept)`); continue; }
      specById.set(d.id, d);
    }
    const tplById = new Map(tpl.drivers.map(d => [d.id, d]));
    for (const id of specById.keys()) {
      const t = tplById.get(id);
      if (!t) warnings.push(`drivers: ${id} has no meaning in ${tpl.id}; ignored`);
      else if (t.mode && t.mode !== mode)
        warnings.push(mode === 'capacity' ? `drivers: ${id} has no meaning with a capacity_v1 revenue_model; ignored` : `drivers: ${id} needs a revenue_model; ignored`);
    }
    const list = [], byId = new Map();
    for (const t of tpl.drivers) {
      if (t.mode && t.mode !== mode) continue;
      const s = specById.get(t.id);
      if (!s && t.optin) continue;
      const set = t.choice_set === 'shift' ? shiftChoices : choices;
      if (t.kind === 'choice' && t.choice_set === 'shift' && set.length < 2) { warnings.push(`drivers: ${t.id} needs rates.shift_options (two or more); ignored`); continue; }
      const req = mode === 'capacity' ? (t.required && t.mode !== 'growth') || !!t.cap_required : t.required;
      if (!s && req) warnings.push(`drivers: ${t.id} missing from spec; template default used`);
      const d = Object.assign({}, t);
      if (s) {
        for (const k of ['label', 'help', 'unit']) if (typeof s[k] === 'string' && s[k]) d[k] = s[k].slice(0, CAPS[k]);
        if (typeof s.group === 'string' && GROUPS.includes(s.group)) d.group = s.group;
        if (t.kind !== 'choice') for (const k of ['base', 'min', 'max', 'step', 'low', 'high', 'dp']) if (isNum(s[k])) d[k] = s[k];
        if (Array.isArray(s.src)) d.src = s.src.filter(x => typeof x === 'string').slice(0, 20);
        if (s.path !== undefined) d.path_spec = s.path;
        if (isNum(s.stub_weight)) d.stub_weight = clamp(s.stub_weight, 0, 1);
      }
      if (t.kind === 'choice') {                       // an index into its choices (0 = the base path / start)
        Object.assign(d, { base: 0, min: 0, max: Math.max(0, set.length - 1), step: 1, low: null, high: null, dp: 0 });
        d.choices = set.map(x => ({ id: x.id, name: x.name }));
      }
      if (d.min > d.max) { warnings.push(`drivers: ${d.id} min > max; swapped`); const t2 = d.min; d.min = d.max; d.max = t2; }
      if (!(d.step > 0)) d.step = t.step;
      if (d.base < d.min || d.base > d.max) { warnings.push(`drivers: ${d.id} base outside [min,max]; clamped`); d.base = clamp(d.base, d.min, d.max); }
      for (const k of ['low', 'high']) if (isNum(d[k])) d[k] = clamp(d[k], d.min, d.max);
      if (!isNum(d.stub_weight)) d.stub_weight = 1;
      // base per-year path for shift/scale drivers (SOFR's comes from spec.rates.path)
      if (d.kind === 'shift_pp' || d.kind === 'scale_pct') {
        const p = pathArr(d.path_spec, years);
        if (!p) errors.push(`drivers: ${d.id} needs a per-year "path" covering ${years[0]}–${years[years.length - 1]}`);
        d.path = p;
      }
      delete d.path_spec;
      list.push(d); byId.set(d.id, d);
    }
    return { list, byId };
  }

  // ---- revenue model: capacity_v1 --------------------------------------------------------
  // Monthly grid: absolute month indices g0..g1 (GRID_PAD months either side of the model).
  // Returns the normalized model or null (errors pushed).
  function compileRM(Rm, years, mOpen, errors, warnings) {
    const W = s => warnings.push('revenue_model: ' + s), Er = s => errors.push('revenue_model: ' + s);
    if (!isObj(Rm)) { Er('must be an object'); return null; }
    if (Rm.kind !== 'capacity_v1') { Er(`unknown kind ${String(Rm.kind).slice(0, 30)} (capacity_v1)`); return null; }
    if (mOpen === null) return null;
    const n = years.length, mFirst = mOpen + 1, mLast = years[n - 1] * 12 + 12;
    const g0 = mOpen - GRID_PAD, g1 = mLast + GRID_PAD, L = g1 - g0 + 1;
    const yIdx = m => clamp(yearOf(m) - years[0], 0, n - 1);
    const frac = (p, key, lo, hi, def, need) => {
      const a = pathArr(p, years);
      if (!a) { if (need) Er(`${key}: a per-year path covering ${years[0]}–${years[n - 1]} is required`); return years.map(() => def); }
      if (a.some(v => v < lo || v > hi)) { W(`${key}: values outside [${lo}, ${hi}] clamped`); return a.map(v => clamp(v, lo, hi)); }
      return a;
    };
    const op = isObj(Rm.opening) ? Rm.opening : {};
    // active MW anchors: the opening point, "YYYY-MM" month-ends and "YYYY" year-ends
    const anchors = new Map();
    if (isNum(op.active_mw) && op.active_mw >= 0) anchors.set(mOpen, op.active_mw);
    else Er('opening.active_mw (MW active at the opening date) is required');
    for (const k of Object.keys(isObj(Rm.active_mw_path) ? Rm.active_mw_path : {})) {
      const v = Rm.active_mw_path[k];
      const m = /^\d{4}$/.test(k) ? +k * 12 + 12 : /^\d{4}-\d{2}$/.test(k) ? monthIdx(k) : null;
      if (m === null || !isNum(v) || v < 0 || m < g0 || m > mLast) { W(`active_mw_path: ${String(k).slice(0, 12)} is not a month or year inside the model with MW >= 0; ignored`); continue; }
      if (m === mOpen && anchors.has(m)) continue;     // the opening point wins
      anchors.set(m, v);
    }
    for (const y of years) if (!anchors.has(y * 12 + 12) && y * 12 + 12 > mOpen) Er(`active_mw_path: "${y}" (year-end active MW) is required`);
    const pts = Array.from(anchors.entries()).sort((a, b) => a[0] - b[0]);
    const A = new Float64Array(L);
    if (pts.length) {
      let j = 0;
      const last = pts[pts.length - 1];
      for (let m = g0; m <= g1; m++) {
        while (j + 1 < pts.length && pts[j + 1][0] <= m) j++;
        let v;
        if (m <= pts[0][0]) v = pts[0][1];
        else if (m >= last[0]) v = last[1];
        else { const [ma, va] = pts[j], [mb, vb] = pts[j + 1]; v = va + (vb - va) * (m - ma) / (mb - ma); }
        A[m - g0] = v;
      }
      // past the last anchor: keep adding at the last year's average monthly pace
      const slope = Math.max(0, (A[last[0] - g0] - A[Math.max(0, last[0] - 12 - g0)]) / 12);
      for (let m = last[0] + 1; m <= g1; m++) A[m - g0] = last[1] + slope * (m - last[0]);
    }
    // revenue per billing MW-year: "YYYY" and quarterly "YYYYQn" / "YYYY-Qn" keys
    const rpmY = pathArr(Rm.revenue_per_mw, years);
    if (!rpmY) Er(`revenue_per_mw: a per-year path (US$m per billing MW-year) covering ${years[0]}–${years[n - 1]} is required`);
    const rpmM = new Float64Array(mLast - mFirst + 1);
    for (let m = mFirst; m <= mLast; m++) {
      const y = yearOf(m), q = Math.floor(((m - 1) % 12) / 3) + 1, P = isObj(Rm.revenue_per_mw) ? Rm.revenue_per_mw : {};
      const qv = [`${y}Q${q}`, `${y}-Q${q}`].map(k => (own(P, k) && isNum(P[k]) ? P[k] : null)).find(v => v !== null);
      rpmM[m - mFirst] = Math.max(0, qv !== undefined ? qv : rpmY ? rpmY[yIdx(m)] : 0);
    }
    const CX = isObj(Rm.capex) ? Rm.capex : {}, CR = isObj(Rm.cost_of_revenue) ? Rm.cost_of_revenue : {};
    const cpm = pathArr(CX.capex_per_mw, years), cor = pathArr(CR.cor_per_mw, years);
    if (!cpm) Er(`capex.capex_per_mw: a per-year path (US$m per MW energised) covering ${years[0]}–${years[n - 1]} is required`);
    if (!cor) Er(`cost_of_revenue.cor_per_mw: a per-year path (US$m per average active MW-year) covering ${years[0]}–${years[n - 1]} is required`);
    const share = (x, key, def) => { if (x === undefined) return def; if (!isNum(x) || x < 0 || x > 1) { W(`${key} must be 0–1; ${def} used`); return def; } return x; };
    const rentShare = share(CR.rent_share, 'cost_of_revenue.rent_share', 0), powerShare = share(CR.power_share, 'cost_of_revenue.power_share', 0);
    if (rentShare + powerShare > 1 + 1e-9) W('cost_of_revenue: rent_share + power_share exceed 1');
    const mm = (x, key, lo, hi, def) => { if (x === undefined) return def; if (!isNum(x) || x < lo || x > hi) { W(`${key} must be ${lo}–${hi}; ${def} used`); return def; } return x; };
    let adjFrom = Rm.adjust_from !== undefined ? monthIdx(Rm.adjust_from) : mFirst;
    if (adjFrom === null) { W('adjust_from must be YYYY-MM; the first projected month used'); adjFrom = mFirst; }
    adjFrom = Math.max(mFirst, adjFrom);

    // customers: each one's share of the year's contracted revenue (backlog conversion; normalized
    // to 1 per year) and of the total backlog; "uncontracted" (new deals and renewals) is computed
    const customers = [], cids = new Set(['uncontracted']);
    for (const x of Array.isArray(Rm.customers) ? Rm.customers.slice(0, 24) : []) {
      if (isObj(x) && x.id === 'uncontracted') { W('customers: "uncontracted" is computed by the engine (capacity not under contract); entry ignored'); continue; }
      if (!isObj(x) || typeof x.id !== 'string' || !ID_RE.test(x.id) || cids.has(x.id)) { W('customers: skipped an entry with a missing, invalid or duplicate id'); continue; }
      const sh = pathArr(x.contracted_share !== undefined ? x.contracted_share : x.share_path, years);
      if (!sh) { W(`customers ${x.id}: contracted_share (share of contracted revenue by year) required; skipped`); continue; }
      cids.add(x.id);
      customers.push({ id: x.id, name: str(x.name, 120) || x.id, aggregate: x.aggregate === true, sh: sh.map(v => clamp(v, 0, 1)),
        backlog_share: isNum(x.backlog_share) ? clamp(x.backlog_share, 0, 1) : null, lt: isObj(x.look_through) ? x.look_through : null, src: srcList(x.src) });
    }
    for (let i = 0; i < n && customers.length; i++) {
      const t = sum(customers.map(x => x.sh[i]));
      if (!(t > 0)) { W(`customers: shares are all zero in ${years[i]}`); continue; }
      if (Math.abs(t - 1) > 0.01) W(`customers: shares sum to ${t.toFixed(3)} in ${years[i]}; scaled to 1`);
      for (const x of customers) x.sh[i] /= t;
    }
    if (customers.length) {
      const bsT = sum(customers.map(x => x.backlog_share || 0));
      if (customers.some(x => x.backlog_share !== null) && Math.abs(bsT - 1) > 0.02) W(`customers: backlog shares sum to ${bsT.toFixed(3)}, not 1`);
      customers.push({ id: 'uncontracted', name: 'Not yet contracted (new deals and renewals)', aggregate: true, computed: true, sh: years.map(() => 0),
        backlog_share: 0, lt: null, src: [] });
    }
    for (const x of customers) {                         // look-through: {customer id: share of x's revenue that serves it}
      const lt = [];
      if (x.lt) for (const k of Object.keys(x.lt)) {
        if (!cids.has(k) || k === x.id || !isNum(x.lt[k])) { W(`customers ${x.id}: look_through ${String(k).slice(0, 40)} is not another customer id with a share; ignored`); continue; }
        lt.push([customers.findIndex(y => y.id === k), clamp(x.lt[k], 0, 1)]);
      }
      x.lt = lt;
    }

    // backlog (RPO) and its conversion schedule
    let backlog = null;
    if (Rm.backlog !== undefined) {
      const B = isObj(Rm.backlog) ? Rm.backlog : {}, asOf = monthIdx(B.as_of);
      const buckets = (Array.isArray(B.conversion) ? B.conversion.slice(0, 12) : []).filter(b => isObj(b) && Array.isArray(b.months) && b.months.length === 2
        && Number.isInteger(b.months[0]) && Number.isInteger(b.months[1]) && b.months[0] >= 1 && b.months[1] >= b.months[0] && b.months[1] <= 240 && isNum(b.share) && b.share >= 0)
        .map(b => ({ a: b.months[0], b: b.months[1], share: b.share }));
      if (!isNum(B.rpo) || B.rpo < 0 || asOf === null || !buckets.length) W('backlog: needs rpo, as_of (YYYY-MM-DD) and conversion [{months: [a, b], share}]; ignored');
      else {
        const tot = sum(buckets.map(b => b.share));
        if (Math.abs(tot - 1) > 0.01) W(`backlog: conversion shares sum to ${tot.toFixed(3)}, not 1`);
        const pp = isObj(B.post_period_commitments) ? B.post_period_commitments : {};
        const post = (yearMap(pp.by_year, years, -1e9, 1e9) || years.map(() => null)).map(v => v || 0);
        backlog = { rpo: B.rpo, asOf, asOfStr: str(B.as_of, 10), buckets, committedShare: isNum(B.committed_share) ? clamp(B.committed_share, 0, 1) : null,
          post, postTotal: isNum(pp.amount) && pp.amount >= sum(post) ? pp.amount : sum(post), covWarn: isNum(B.coverage_warn) ? clamp(B.coverage_warn, 0, 1) : 0.6,
          credit: isNum(B.undelivered_credit) ? clamp(B.undelivered_credit, 0, 1) : 0, src: srcList(B.src) };
      }
    }
    // backstop: a counterparty that buys unsold capacity up to a cap, until a date
    let backstop = null;
    if (Rm.backstop !== undefined) {
      const S = isObj(Rm.backstop) ? Rm.backstop : {}, until = monthIdx(S.until);
      if (!isNum(S.cap) || S.cap < 0 || until === null) W('backstop: needs cap (US$m) and until (YYYY-MM); ignored');
      else {
        const covers = Array.isArray(S.covers) ? S.covers.filter(x => ['utilization', 'churn', 'cuts'].includes(x)) : ['utilization', 'churn', 'cuts'];
        backstop = { cap: S.cap, until, untilStr: str(S.until, 7), coverage: isNum(S.coverage) ? clamp(S.coverage, 0, 1) : 1, all: S.basis === 'all',
          util: covers.includes('utilization'), churn: covers.includes('churn'), cuts: covers.includes('cuts'),
          ci: typeof S.customer === 'string' ? customers.findIndex(x => x.id === S.customer) : -1, name: str(S.name, 120) || 'Backstop', src: srcList(S.src) };
        if (typeof S.customer === 'string' && backstop.ci < 0) W(`backstop: customer ${S.customer.slice(0, 40)} is not in customers`);
      }
    }
    // self-built sites: no rent; shell & power capex per MW (booked lead_months before the MW go
    // live) over a long life. identified = owned sites already in the MW path; the share applies
    // to MW beyond the signed leases (leases.leased_mw + identified) when leases are given.
    let sb = null;
    if (Rm.self_build !== undefined) {
      const S = isObj(Rm.self_build) ? Rm.self_build : {}, from = monthIdx(S.from);
      if (from === null || !isNum(S.capex_per_mw) || S.capex_per_mw < 0) W('self_build: needs from (YYYY-MM) and capex_per_mw (US$m of shell & power per MW); ignored');
      else {
        const ident = (Array.isArray(S.identified) ? S.identified.slice(0, 20) : []).map(x => (isObj(x) && isNum(x.mw) && x.mw >= 0 && monthIdx(x.online) !== null
          ? { mw: x.mw, m: monthIdx(x.online), name: str(x.name, 120) } : null)).filter(Boolean);
        sb = { from: Math.max(mFirst, from), capex: S.capex_per_mw, life: clamp(num(S.life, 25), 5, 60), opex: Math.max(0, num(S.opex_per_mw, 0)),
          open: Math.max(0, num(S.opening_mw, 0)), ident, identMW: sum(ident.map(x => x.mw)), lead: mm(S.lead_months, 'self_build.lead_months', 0, 36, 0), src: srcList(S.src) };
      }
    }
    // signed leases: the leased-MW schedule pays rent whether or not the GPUs arrive (sublet
    // recovery offsets the idle part)
    const LS = isObj(Rm.leases) ? Rm.leases : null;
    const leaseCap = LS && isNum(LS.leased_mw) && LS.leased_mw > 0 ? LS.leased_mw : null;
    const sublet = LS ? mm(LS.sublet_recovery, 'leases.sublet_recovery', 0, 1, 0) : 0;
    // extra capacity (driver): phased in from `from` (0) to the year-end fractions given
    const XC = isObj(Rm.extra_capacity) ? Rm.extra_capacity : {};
    let xFrom = XC.from !== undefined ? monthIdx(XC.from) : adjFrom;
    if (xFrom === null) { W('extra_capacity.from must be YYYY-MM; adjust_from used'); xFrom = adjFrom; }
    xFrom = Math.max(mFirst, xFrom);
    let phase = yearMap(XC.phase, years, 0, 5);
    if (!phase) { const y0 = yearOf(xFrom); phase = years.map(y => (y === y0 ? 0.5 : y > y0 ? 1 : null)); }
    const sites = (Array.isArray(Rm.sites) ? Rm.sites.slice(0, 80) : []).filter(x => isObj(x) && typeof x.id === 'string')
      .map(x => ({ id: x.id.slice(0, 40), name: str(x.name, 120), mw: fin(x.mw), expected_online: str(x.expected_online, 7), developer: str(x.developer, 120),
        status: str(x.status, 60), src: srcList(x.src) }));

    return {
      n, mOpen, mFirst, mLast, g0, g1, L, A, yIdx, adjFrom, leaseCap, sublet,
      lag: mm(Rm.billing_lag_months, 'billing_lag_months', 0, 12, 0), lead: mm(CX.lead_months, 'capex.lead_months', -12, 12, 0),
      maxDelay: mm(Rm.max_delay_months, 'max_delay_months', 0, 36, 12),
      delayAhead: mm(Rm.delay_capex_ahead, 'delay_capex_ahead', 0, 1, 0), unsoldCapex: mm(CX.unsold_capex_share, 'capex.unsold_capex_share', 0, 1, 0),
      term: mm(Rm.contract_years, 'contract_years', 1, 15, 5),
      util: frac(Rm.utilization, 'utilization', 0, 1, 1, true), rpmM, rpmY: rpmY || years.map(() => 0),
      renew: frac(Rm.renewing_share, 'renewing_share', 0, 1, 0), reset: frac(Rm.renewal_price_reset, 'renewal_price_reset', -1, 1, 0),
      churn: frac(Rm.renewal_churn, 'renewal_churn', 0, 1, 0),
      cpm: (cpm || years.map(() => 0)).map(v => Math.max(0, v)), cor: (cor || years.map(() => 0)).map(v => Math.max(0, v)),
      maint: mm(CX.maintenance_capex_pct, 'capex.maintenance_capex_pct', 0, 0.5, 0),
      rentShare, powerShare, powerExposed: share(CR.power_exposed, 'cost_of_revenue.power_exposed', 1), corOther: mm(CR.cor_other_pct, 'cost_of_revenue.cor_other_pct', 0, 1, 0),
      customers, backlog, backstop, sb, xFrom, phase, sites,
      opening: { date: str(op.date, 10), active_mw: fin(op.active_mw), contracted_mw: fin(op.contracted_mw),
        contracted_mw_latest: fin(op.contracted_mw_latest), contracted_latest_date: str(op.contracted_latest_date, 10) },
      leases: LS ? { not_commenced: fin(LS.not_commenced), as_of: str(LS.as_of, 10), terms: str(LS.terms, 60), leased_mw: leaseCap, sublet_recovery: sublet,
        commenced_liability: fin(LS.commenced_liability), undiscounted_commenced: fin(LS.undiscounted_commenced),
        lease_cost: isObj(LS.lease_cost) ? { amount: fin(LS.lease_cost.amount), period: str(LS.lease_cost.period, 30) } : null,
        note: str(LS.note, 900), src: srcList(LS.src) } : null,
      contractM: null, contractY: null, Kmw: null, custC: null, Areq: null,
    };
  }

  // ---- events ----------------------------------------------------------------------------
  function normImpacts(I, id, years, rm, mFirst, warnings) {
    const out = {}, W = s => warnings.push(`event ${id}: ${s}`);
    if (!isObj(I)) { W('impacts must be an object'); return out; }
    for (const k of Object.keys(I)) {
      const T = own(IMPACTS, k) ? IMPACTS[k] : null, v = I[k];
      if (!T) { W(`impact ${String(k).slice(0, 40)} unknown; ignored`); continue; }
      if (T.cap && !rm) { W(`impact ${k} needs a revenue_model; ignored`); continue; }
      if (T.type === 'num') {
        if (!isNum(v)) { W(`impact ${k} must be a number; ignored`); continue; }
        if (v < T.min || v > T.max) W(`impact ${k} clamped to [${T.min}, ${T.max}]`);
        out[k] = clamp(v, T.min, T.max);
      } else if (T.type === 'year_map') {
        const a = yearMap(v, years, T.min, T.max);
        if (!a) { W(`impact ${k} must be {"<model year>": number}; ignored`); continue; }
        out[k] = a;
      } else if (T.type === 'release') {                 // capacity_released: {mw, from, to, idle_months, relet_pct}
        const rel = [];
        for (const x of (Array.isArray(v) ? v : [v]).slice(0, 8)) {
          const f = isObj(x) && x.from !== undefined ? monthIdx(x.from) : null, t = isObj(x) && x.to !== undefined ? monthIdx(x.to) : null;
          if (!isObj(x) || !isNum(x.mw) || x.mw < 0 || (x.from !== undefined && f === null) || (x.to !== undefined && t === null)) { W('capacity_released needs mw (>= 0) and from / to as YYYY-MM; ignored'); continue; }
          rel.push({ mw: Math.min(x.mw, T.max), from: f === null ? null : Math.max(mFirst, f), to: t, idle: clamp(Math.round(num(x.idle_months, 6)), 0, 60),
            relet: isNum(x.relet_pct) ? clamp(x.relet_pct, -100, 100) / 100 : null });
        }
        if (rel.length) out[k] = rel;
      } else {                                          // customer_cut: one or a list of {customer, pct, from, idle_months, relet_pct}
        const cuts = [];
        for (const x of (Array.isArray(v) ? v : [v]).slice(0, 8)) {
          const ci = isObj(x) && typeof x.customer === 'string' ? rm.customers.findIndex(c => c.id === x.customer && !c.computed) : -1;
          if (ci < 0 || !isNum(x.pct)) { W('customer_cut needs a customer id from revenue_model.customers and pct (0–1); ignored'); continue; }
          const f = x.from !== undefined ? monthIdx(x.from) : null;
          cuts.push({ ci, pct: clamp(x.pct, 0, 1), from: f === null ? null : Math.max(mFirst, f), idle: clamp(Math.round(num(x.idle_months, 6)), 0, 60),
            relet: isNum(x.relet_pct) ? clamp(x.relet_pct, -100, 100) / 100 : null });
        }
        if (cuts.length) out[k] = cuts;
      }
    }
    return out;
  }
  function compileEvents(spec, years, rm, mFirst, warnings) {
    const out = [], seen = new Set();
    for (const e of Array.isArray(spec.events) ? spec.events.slice(0, MAX_EVENTS) : []) {
      if (!isObj(e) || typeof e.id !== 'string' || !ID_RE.test(e.id) || seen.has(e.id)) {
        warnings.push(`events: skipped an entry with a missing, invalid or duplicate id (${String(isObj(e) ? e.id : e).slice(0, 40)})`); continue;
      }
      seen.add(e.id);
      if (e.kind !== 'risk' && e.kind !== 'upside' && e.kind !== 'strategic') warnings.push(`event ${e.id}: kind must be risk, upside or strategic; risk used`);
      if (!isNum(e.prob) || e.prob < 0 || e.prob > 1) warnings.push(`event ${e.id}: prob must be 0–1; ${isNum(e.prob) ? 'clamped' : '0 used'}`);
      let from = e.from !== undefined ? monthIdx(e.from) : mFirst;
      if (from === null) { warnings.push(`event ${e.id}: from must be YYYY-MM; the first projected month used`); from = mFirst; }
      from = Math.max(mFirst, from);
      // until (YYYY-MM, optional): the month the rate, price, cost and funding impacts stop (a delay,
      // MW, a cut, a release, a life change or an acquisition is permanent)
      let until = e.until !== undefined ? monthIdx(e.until) : null;
      if (e.until !== undefined && (until === null || until <= from)) { warnings.push(`event ${e.id}: until must be a YYYY-MM after from; ignored`); until = null; }
      const imp = normImpacts(e.impacts, e.id, years, rm, mFirst, warnings);
      for (const k of imp.customer_cut || []) if (k.from === null) k.from = from;
      for (const k of imp.capacity_released || []) { if (k.from === null) k.from = from; if (k.to === null || k.to < k.from) k.to = k.from; }
      if ((imp.delay_share !== undefined || imp.capex_ahead !== undefined) && !imp.delay_months) warnings.push(`event ${e.id}: delay_share / capex_ahead apply only with delay_months`);
      out.push({ id: e.id, idx: out.length, op: !!rm && Object.keys(imp).some(k => IMPACTS[k].cap || k === 'capex_delta'),
        kind: e.kind === 'upside' || e.kind === 'strategic' ? e.kind : 'risk', label: str(e.label, CAPS.label) || e.id, short_label: str(e.short_label, CAPS.short_label),
        mechanism: str(e.mechanism, CAPS.mechanism), until, until_str: until === null ? null : monthStr(until),
        prob: isNum(e.prob) ? clamp(e.prob, 0, 1) : 0, prob_note: str(e.prob_note, CAPS.prob_note), from, from_str: monthStr(from),
        group: typeof e.group === 'string' && ID_RE.test(e.group) ? e.group : null, imp,
        indicators: (Array.isArray(e.indicators) ? e.indicators : []).filter(x => typeof x === 'string').slice(0, 12).map(x => x.slice(0, CAPS.indicator)),
        src: srcList(e.src) });
    }
    const groups = new Map();
    out.forEach((e, j) => { if (e.group) { if (!groups.has(e.group)) groups.set(e.group, []); groups.get(e.group).push(j); } });
    for (const [gid, mem] of groups) {
      const t = sum(mem.map(j => out[j].prob));
      if (t > 1 + 1e-9) warnings.push(`events: group ${gid} probabilities sum to ${t.toFixed(2)} (> 1); scaled in the distribution`);
    }
    return { list: out, byId: new Map(out.map(e => [e.id, e])), groups };
  }
  // Event states -> the list of events on (catalogue order; one per group, the first wins).
  // Accepts {id: 1 | 0 | true | false} or a list of ids.
  function cleanEvents(c, st, warnings) {
    if (!c.events.length || st === null || st === undefined) return [];
    const on = new Set();
    if (Array.isArray(st)) { for (const id of st.slice(0, 64)) if (typeof id === 'string') on.add(id); }
    else if (isObj(st)) {
      for (const k of Object.keys(st).slice(0, 64)) {
        const v = st[k];
        if (v === 1 || v === true) on.add(k);
        else if (!(v === 0 || v === false) && warnings) warnings.push(`event ${String(k).slice(0, 40)}: state must be 0 or 1; ignored`);
      }
    }
    if (warnings) for (const id of on) if (!c.evById.has(id)) warnings.push(`event ${String(id).slice(0, 40)}: unknown; ignored`);
    const out = [], groups = new Set();
    for (const e of c.events) {
      if (!on.has(e.id)) continue;
      if (e.group) {
        if (groups.has(e.group)) { if (warnings) warnings.push(`event ${e.id}: group ${e.group} already has an event on; ignored`); continue; }
        groups.add(e.group);
      }
      out.push(e);
    }
    return out;
  }
  const evMap = evs => { const o = {}; for (const e of evs) o[e.id] = 1; return o; };

  // ---- compile ---------------------------------------------------------------------------
  // Validate + normalize a spec. Never throws; {ok:false, errors} when it can't be modelled.
  function compile(spec) {
    const errors = [], warnings = [];
    try {
      if (!isObj(spec)) return { ok: false, errors: ['spec: not an object'], warnings };
      if (spec.v !== VERSION) errors.push(`spec: v must be ${VERSION}`);
      const tpl = own(TEMPLATES, spec.template) ? TEMPLATES[spec.template] : null;
      if (!tpl) return { ok: false, errors: errors.concat([`spec: unknown template ${String(spec.template).slice(0, 40)}`]), warnings };
      const years = Array.isArray(spec.years) ? spec.years.filter(y => Number.isInteger(y) && y > 1900 && y < 2200) : [];
      if (!years.length || years.length !== spec.years.length || years.some((y, i) => i && y !== years[i - 1] + 1) || years.length > 15)
        return { ok: false, errors: errors.concat(['spec: years must be 1–15 consecutive integer years']), warnings };
      const op = isObj(spec.opening) ? spec.opening : null;
      if (!op) return { ok: false, errors: errors.concat(['spec: opening balance sheet missing']), warnings };
      const mOpen = monthIdx(op.date), dOpen = dayMs(op.date);
      if (mOpen === null) errors.push('opening: date must be YYYY-MM-DD');
      for (const k of ['cash', 'shares_m']) if (!isNum(op[k])) errors.push(`opening: ${k} must be a number`);
      if (isNum(op.shares_m) && op.shares_m <= 0) errors.push('opening: shares_m must be > 0');
      let net = num(op.net_ppe, null), gross = num(op.gross_ppe, null);
      const acc = num(op.accum_dep, null);
      if (net === null && gross !== null && acc !== null) net = gross - acc;
      if (gross === null && net !== null && acc !== null) gross = net + acc;
      if (net === null || gross === null) { warnings.push('opening: PP&E incomplete; existing assets not depreciated'); net = net || 0; gross = gross || 0; }
      const cip = isNum(op.cip) && op.cip >= 0 ? Math.min(op.cip, Math.max(0, net)) : 0;

      // stub year: H1 (actual_months) reported; the engine projects the rest of that year
      let stub = null, frac0 = 1;
      if (isObj(spec.stub)) {
        const s = spec.stub, am = s.actual_months;
        if (s.year !== years[0]) errors.push('stub: year must be the first model year');
        if (!Number.isInteger(am) || am < 0 || am > 11) errors.push('stub: actual_months must be an integer 0–11');
        const a = isObj(s.actuals) ? s.actuals : {};
        const keys = ['revenue', 'cost_of_revenue', 'opex_ex_da_sbc', 'sbc', 'da', 'interest', 'capex', 'ocf'];
        for (const k of keys) if (!isNum(a[k])) errors.push(`stub.actuals: ${k} must be a number`);
        if (Number.isInteger(am) && am >= 0 && am <= 11) {
          frac0 = (12 - am) / 12;
          stub = { year: s.year, months: am, a: Object.assign({}, ...keys.map(k => ({ [k]: num(a[k], 0) })),
            { tax: fin(a.tax), other_income: num(a.other_income, 0), prepayments: fin(a.prepayments) }) };
          if (mOpen !== null && mOpen !== s.year * 12 + am) warnings.push('stub: opening.date is not the end of the actual months');
        }
      } else if (mOpen !== null && mOpen !== (years[0] - 1) * 12 + 12) warnings.push('opening: date is not the prior year-end');

      // revenue base: FY revenue of the year before the first model year
      let priorRev = isObj(spec.prior) && isNum(spec.prior.revenue) ? spec.prior.revenue : null;
      if (priorRev === null) {
        if (stub && stub.months > 0) { priorRev = stub.a.revenue * 12 / stub.months; warnings.push('prior: revenue missing; annualised stub revenue used as the growth base'); }
        else errors.push('prior: revenue (FY before the first model year) is required');
      }

      // revenue model (capacity_v1) replaces the growth path
      const rm = spec.revenue_model !== undefined ? compileRM(spec.revenue_model, years, mOpen, errors, warnings) : null;
      const mode = spec.revenue_model !== undefined ? 'capacity' : 'growth';

      // rates: the base path, alternatives (the rate_path driver's choices), new-debt link
      const RT = isObj(spec.rates) ? spec.rates : {};
      const rp = pathArr(RT.path, years);
      const alts = [];
      for (const p of Array.isArray(RT.alt_paths) ? RT.alt_paths.slice(0, 8) : []) {
        if (!isObj(p) || typeof p.id !== 'string' || !ID_RE.test(p.id) || alts.some(x => x.id === p.id)) { warnings.push('rates: skipped an alt path without a valid id'); continue; }
        const arr = pathArr(p.path, years);
        if (!arr) { warnings.push(`rates: alt path ${p.id} has no usable path`); continue; }
        alts.push({ id: p.id, name: typeof p.name === 'string' ? p.name.slice(0, 80) : p.id, arr });
      }
      const choices = [{ id: typeof RT.base_id === 'string' && ID_RE.test(RT.base_id) ? RT.base_id : 'base',
        name: typeof RT.base_label === 'string' ? RT.base_label.slice(0, 80) : 'Base path', arr: rp }].concat(rp ? alts : []);

      const shiftFrom = RT.shift_from !== undefined ? monthIdx(RT.shift_from) : null;
      if (RT.shift_from !== undefined && shiftFrom === null) warnings.push('rates: shift_from must be YYYY-MM; shifts apply from the opening date');
      // when a rate shock starts: shift_from (choice 0) or a later rates.shift_options entry
      const shiftChoices = [{ id: typeof RT.shift_id === 'string' && ID_RE.test(RT.shift_id) ? RT.shift_id : 'now', name: str(RT.shift_label, 80) || 'From the shift month', from: shiftFrom }];
      for (const x of Array.isArray(RT.shift_options) ? RT.shift_options.slice(0, 4) : []) {
        const f = isObj(x) ? monthIdx(x.from) : null;
        if (!isObj(x) || typeof x.id !== 'string' || !ID_RE.test(x.id) || f === null || shiftChoices.some(y => y.id === x.id)) { warnings.push('rates: skipped a shift option without a valid id and from (YYYY-MM)'); continue; }
        shiftChoices.push({ id: x.id, name: str(x.name, 80) || x.id, from: f });
      }
      const { list, byId } = normDrivers(spec, tpl, years, choices, mode, errors, warnings, shiftChoices);
      if (byId.has('self_build_share') && !(rm && rm.sb)) warnings.push('drivers: self_build_share needs revenue_model.self_build; no effect');

      // debt stack
      const debt = [], ids = new Set([NEW_DEBT_ID]);
      if (spec.debt !== undefined && !Array.isArray(spec.debt)) errors.push('debt: must be a list of tranches');
      for (const t of Array.isArray(spec.debt) ? spec.debt : []) {
        if (!isObj(t) || typeof t.id !== 'string' || !TRANCHE_RE.test(t.id) || ids.has(t.id)) {
          errors.push(`debt: invalid or duplicate tranche id ${String(isObj(t) ? t.id : t).slice(0, 40)}`); continue;
        }
        ids.add(t.id);
        if (!isNum(t.balance) || t.balance < 0) { errors.push(`debt ${t.id}: balance must be a number >= 0`); continue; }
        const kind = t.kind === 'floating' ? 'floating' : t.kind === 'fixed' ? 'fixed' : null;
        if (!kind) { errors.push(`debt ${t.id}: kind must be fixed or floating`); continue; }
        const mm = monthIdx(t.maturity);
        if (mm === null) { errors.push(`debt ${t.id}: maturity must be YYYY-MM`); continue; }
        const sched = isObj(t.schedule) ? Object.keys(t.schedule).filter(k => /^\d{4}$/.test(k) && isNum(t.schedule[k]) && t.schedule[k] >= 0)
          .map(k => [+k, t.schedule[k]]).sort((a, b) => a[0] - b[0]) : null;
        const amort = ['bullet', 'straight', 'cashsweep', 'schedule'].includes(t.amort) ? t.amort : 'bullet';
        if (t.amort !== amort) warnings.push(`debt ${t.id}: amort ${String(t.amort).slice(0, 20)} unknown; bullet used`);
        if (amort === 'schedule' && !(sched && sched.length)) { errors.push(`debt ${t.id}: amort "schedule" needs a schedule {"<year>": principal}`); continue; }
        let coupon = num(t.coupon_pct, null), spread = num(t.spread_bp, null);
        if (kind === 'fixed' && coupon === null) warnings.push(`debt ${t.id}: fixed with no coupon; new-debt rate used`);
        if (kind === 'floating' && spread === null) { warnings.push(`debt ${t.id}: floating with no spread; 0 bp used`); spread = 0; }
        const ti = t.issued !== undefined ? startTime(t.issued, mOpen, dOpen) : 0;
        if (ti === null) warnings.push(`debt ${t.id}: issued date unreadable; outstanding from the opening date`);
        const ta = t.amort_start !== undefined ? startTime(t.amort_start, mOpen, dOpen) : 0;
        debt.push({ id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 120) : t.id, kind, coupon, spread,
          fee: clamp(num(t.fee_bp, 0), 0, 2000), bal0: t.balance, tm: mOpen === null ? 0 : (mm - mOpen) / 12, amort, maturity: t.maturity,
          ti: Math.max(0, num(ti, 0)), ta: Math.max(0, num(ta, 0)), sched: amort === 'schedule' ? sched : null,
          issueCash: num(t.issue_cash, t.balance), issueEq: num(t.issue_equity, 0),
          conv: isNum(t.conv_price) && t.conv_price > 0 && isNum(t.cap_price) && t.cap_price >= t.conv_price ? { px: t.conv_price, cap: t.cap_price } : null,
          secured: !!t.secured, recourse: t.recourse !== false, hedges: [] });
      }

      // committed, undrawn facilities: drawn before any new (uncommitted) debt while open
      const FU = isObj(spec.funding) ? spec.funding : {};
      const committed = [];
      for (const x of Array.isArray(FU.committed) ? FU.committed.slice(0, 20) : []) {
        if (!isObj(x) || typeof x.id !== 'string' || !TRANCHE_RE.test(x.id) || ids.has(x.id)) { warnings.push(`funding: skipped a committed facility (bad or duplicate id ${String(isObj(x) ? x.id : x).slice(0, 40)})`); continue; }
        const kind = x.kind === 'fixed' ? 'fixed' : 'floating';
        const until = monthIdx(x.available_until), mm = monthIdx(x.maturity);
        if (!isNum(x.amount) || x.amount < 0 || until === null || mm === null || mOpen === null) { warnings.push(`funding: ${x.id} needs amount, available_until and maturity; skipped`); continue; }
        ids.add(x.id);
        committed.push({ id: x.id, name: typeof x.name === 'string' ? x.name.slice(0, 120) : x.id, kind, amount: x.amount,
          spread: num(x.spread_bp, 0), coupon: num(x.coupon_pct, null), fee: clamp(num(x.fee_bp, 0), 0, 2000),
          until: (until - mOpen) / 12, tm: (mm - mOpen) / 12, secured: !!x.secured, amortises: x.amortises === true, hedges: [] });
      }
      const securedPct = clamp(num(FU.new_debt_secured_pct, 0), 0, 100) / 100;
      // a gap that cannot be borrowed: "record" it (cash below the minimum) or "defer_build" (capacity
      // models: the MW it would pay for are built a year later); either way the unfunded part costs
      // the new-debt rate + shortfall_penalty_pp until it is refilled
      const whenShort = FU.when_short === 'defer_build' ? 'defer_build' : 'record';
      if (FU.when_short !== undefined && FU.when_short !== whenShort && FU.when_short !== 'record') warnings.push('funding: when_short must be "record" or "defer_build"; record used');
      const shortPenalty = clamp(num(FU.shortfall_penalty_pp, 0), 0, 50) / 100;
      const newAmort = clamp(num(FU.new_debt_amort_years, 0), 0, 30);

      // interest-rate hedges: pay-fixed swaps on floating tranches / facilities
      const hedges = [], hids = new Set();
      for (const h of Array.isArray(spec.hedges) ? spec.hedges.slice(0, 40) : []) {
        const W = s => warnings.push(`hedges ${String(isObj(h) ? h.id : h).slice(0, 40)}: ${s}`);
        if (!isObj(h) || typeof h.id !== 'string' || !TRANCHE_RE.test(h.id) || hids.has(h.id)) { W('missing, invalid or duplicate id; skipped'); continue; }
        hids.add(h.id);
        const type = h.type === 'cross_currency' ? 'cross_currency' : 'swap';
        const t = debt.find(x => x.id === h.tranche), fa = committed.find(x => x.id === h.tranche);
        if (!t && !fa) { W(`tranche ${String(h.tranche).slice(0, 40)} is not a debt tranche or committed facility; skipped`); continue; }
        const ratio = isNum(h.ratio) ? clamp(h.ratio, 0, 1) : null, notional = isNum(h.notional) && h.notional >= 0 ? h.notional : null;
        const rate = h.fixed_rate === 'path' ? 'path' : isNum(h.fixed_rate) ? clamp(h.fixed_rate, -5, 30) : null;
        const s = h.start !== undefined ? monthIdx(h.start) : null, e = h.maturity !== undefined ? monthIdx(h.maturity) : null;
        if ((h.start !== undefined && s === null) || (h.maturity !== undefined && e === null)) W('start / maturity must be YYYY-MM; open-ended used');
        const x = { id: h.id, type, tranche: h.tranche, facility: !!fa, ratio, notional, rate, start: s === null ? -Infinity : s, end: e === null ? Infinity : e,
          amortises: h.amortises_with_tranche === true, estimated: h.rate_estimated === true, name: str(h.name, 120) || h.id, note: str(h.note, 900), src: srcList(h.src) };
        if (type === 'swap') {
          if ((t || fa).kind !== 'floating') { W(`${h.tranche} is fixed-rate; a swap has nothing to convert; ignored`); continue; }
          if (rate === null) { W('fixed_rate (% or "path") required; skipped'); continue; }
          if (ratio === null && (notional === null || fa)) { W(fa ? 'a hedge on a committed facility takes a ratio; skipped' : 'needs a notional or a ratio; skipped'); continue; }
          (t || fa).hedges.push(x);
        }
        hedges.push(x);
      }

      if (!rp && (debt.some(t => t.kind === 'floating') || committed.some(x => x.kind === 'floating'))) errors.push('rates: path is required with floating debt');
      const beta = isNum(RT.new_debt_sofr_beta) ? clamp(RT.new_debt_sofr_beta, 0, 1) : 1;
      const refI = Number.isInteger(RT.new_debt_ref_year) ? years.indexOf(RT.new_debt_ref_year) : -1;
      if (RT.new_debt_ref_year !== undefined && refI < 0) warnings.push('rates: new_debt_ref_year is not a model year; new-debt rate not linked to the path');

      // valuation: exit multiple on exit_year EBITDA, struck at valuation_date, discounted to asof
      const v = isObj(spec.valuation) ? spec.valuation : {};
      const exitYear = years.includes(v.exit_year) ? v.exit_year : years[Math.min(2, years.length - 1)];
      if (v.exit_year !== undefined && v.exit_year !== exitYear) warnings.push('valuation: exit_year outside the model years; clamped');
      let vd = dayMs(v.valuation_date);
      if (vd === null) vd = Date.UTC(exitYear - 1, 11, 31);
      let asof = dayMs(spec.asof);
      if (asof === null) { asof = vd; warnings.push('spec: asof missing; value not discounted'); }
      const ndAt = v.net_debt_at === 'exit_year_end' ? 'exit_year_end' : 'exit', vdStr = new Date(vd).toISOString().slice(0, 10);
      const rl = isObj(v.rate_link) && isNum(v.rate_link.debt_weight) && isNum(v.rate_link.growth_pct)
        ? { w: clamp(v.rate_link.debt_weight, 0, 1), g: clamp(v.rate_link.growth_pct, -5, 15) } : null;
      // ebitda_basis: "forward" (the exit year's EBITDA) or "run_rate" (capacity models: the exit
      // year's per-MW economics on the fleet in place at the balance-sheet date, so capacity built
      // after it, and its capex, are both left out); life_link re-rates the multiple with the
      // run-off value of the fleet (economic life, renewal prices) against the spec's defaults
      const basis = v.ebitda_basis === 'run_rate' ? 'run_rate' : 'forward';
      if (v.ebitda_basis !== undefined && v.ebitda_basis !== basis && v.ebitda_basis !== 'forward') warnings.push('valuation: ebitda_basis must be "forward" or "run_rate"; forward used');

      const checks = (Array.isArray(spec.checks) ? spec.checks : []).filter(c => isObj(c) && typeof c.metric === 'string').slice(0, 40)
        .map(c => ({ label: typeof c.label === 'string' ? c.label.slice(0, 200) : c.metric, metric: c.metric,
          year: Number.isInteger(c.year) ? c.year : null, lo: fin(c.lo), hi: fin(c.hi),
          src: Array.isArray(c.src) ? c.src.filter(x => typeof x === 'string').slice(0, 20) : [] }));

      const covenants = (Array.isArray(spec.covenants) ? spec.covenants : [])
        .filter(k => isObj(k) && COV_METRICS.includes(k.metric) && (isNum(k.max) || isNum(k.min))).slice(0, 12)
        .map((k, i) => ({ id: typeof k.id === 'string' && ID_RE.test(k.id) ? k.id : `cov${i}`, label: typeof k.label === 'string' ? k.label.slice(0, 160) : k.metric,
          metric: k.metric, max: fin(k.max), min: fin(k.min), kind: k.kind === 'threshold' ? 'threshold' : 'covenant',
          src: Array.isArray(k.src) ? k.src.filter(x => typeof x === 'string').slice(0, 20) : [] }));

      const mFirst = mOpen === null ? 1 : mOpen + 1;
      const EV = compileEvents(spec, years, rm, mFirst, warnings);

      const scenarios = (Array.isArray(spec.scenarios) ? spec.scenarios : [])
        .filter(s => isObj(s) && typeof s.id === 'string' && ID_RE.test(s.id)).slice(0, 20)
        .map(s => {
          const evIn = Array.isArray(s.events) ? s.events : isObj(s.events) ? s.events : [];
          const w = [];
          const evs = cleanEvents({ events: EV.list, evById: EV.byId }, evIn, w);
          for (const x of w) warnings.push(`scenario ${s.id}: ${x}`);
          return { id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 80) : s.id,
            note: typeof s.note === 'string' ? s.note.slice(0, CAPS.scenario_note) : '', values: isObj(s.values) ? s.values : {},
            prob: isNum(s.prob) && s.prob >= 0 ? Math.min(s.prob, 100) : null, representative: s.representative === true, events: evs.map(e => e.id) };
        });

      // quarterly watch list: a row (or a customer's share) against the threshold that changes the view
      const known = new Set(list.map(d => d.id).concat(EV.list.map(e => e.id)));
      const watch = (Array.isArray(spec.watchlist) ? spec.watchlist : []).filter(w => isObj(w) && typeof w.id === 'string' && ID_RE.test(w.id)).slice(0, 12)
        .map(w => {
          const m = typeof w.metric === 'string' ? w.metric : '';
          const cm = /^(customer_share|lookthrough_share):([a-z][a-z0-9_]{0,39})$/.exec(m);
          const okM = ROW_NAMES.includes(m) || (cm && rm && rm.customers.some(x => x.id === cm[2]));
          if (!okM && m !== 'none') warnings.push(`watchlist ${w.id}: metric ${m.slice(0, 60)} is not a model row, customer_share:<customer> or "none" (not modelled)`);
          const informs = (Array.isArray(w.informs) ? w.informs : []).filter(x => typeof x === 'string').slice(0, 12);
          for (const x of informs) if (!known.has(x)) warnings.push(`watchlist ${w.id}: informs ${x.slice(0, 40)}, which is not a driver or event of this model`);
          const L = isObj(w.latest) ? w.latest : null;
          return { id: w.id, label: str(w.label, 160) || w.id, metric: okM ? m : null, modelled: !!okM, map: cm ? cm[1] : null, key: cm ? cm[2] : null,
            unit: str(w.unit, 10), threshold: fin(w.threshold), direction: w.direction === 'below' ? 'below' : 'above', signal: w.signal === 'positive' ? 'positive' : 'risk',
            latest: L ? { value: fin(L.value), period: str(L.period, 30), note: str(L.note, CAPS.latest_note), src: srcList(L.src) } : null,
            dp: Number.isInteger(w.dp) ? clamp(w.dp, 0, 3) : null, informs, note: str(w.note, CAPS.watch_note), src: srcList(w.src) };
        });

      if (errors.length) return { ok: false, errors, warnings };
      const c = {
        ok: true, errors, warnings, tpl, years, stub, frac0, priorRev, drivers: list, byId, debt, committed, securedPct, newAmort, beta, whenShort, shortPenalty,
        sofr: rp || years.map(() => 0), hasRates: !!rp, choices, refI, shiftFrom, shiftChoices, mOpen, dOpen, mode, rm, hedges,
        vintage: byId.has('new_debt_floating_share') || byId.has('hedge_ratio_new'),
        events: EV.list, evById: EV.byId, evGroups: EV.groups,
        slug: typeof spec.slug === 'string' ? spec.slug.slice(0, 40) : '',
        opening: { cash: op.cash, shares: op.shares_m, gross, net, cip, equity: num(op.equity, null),
          depBase: isNum(op.dep_base) && op.dep_base >= 0 ? op.dep_base : Math.max(0, gross - cip),
          depRate: isNum(op.dep_rate) && op.dep_rate >= 0 ? op.dep_rate : null,
          depNbv: isNum(op.dep_nbv) && op.dep_nbv >= 0 ? op.dep_nbv : Math.max(0, net - cip),
          cipIn: Math.max(0, num(op.cip_in_service, 0)), cipInCapex: op.cip_in_capex === true },
        val: { exitYear, vd, vdStr, asof, ndAt, link: rl, basis, lifeLink: v.life_link === true, ratio0: null }, checks, covenants, scenarios, watch,
      };
      c.P = periods(c);
      c.val.bi = ndAt === 'exit' ? years.reduce((b, y, i) => (Date.UTC(y, 11, 31) <= vd ? i : b), -1) : years.indexOf(exitYear);
      c.wShiftBy = shiftChoices.map(x => c.P.map(p => wFromP(p, x.from)));
      c.wShift = c.wShiftBy[0];
      c._wf = new Map();
      c.E0 = impacts(c, []);
      debtCache(c);
      if (rm) contractSchedule(c);
      if (c.val.lifeLink) {
        const r0 = run(c, {}, [], RO(true, false, null, null, true));
        c.val.ratio0 = r0.valuation.runoff ? r0.valuation.runoff.ev_ebitda : null;
        if (!isNum(c.val.ratio0)) warnings.push('valuation: life_link needs a revenue_model and a balance-sheet year; not applied');
      }
      return c;
    } catch (e) {
      return { ok: false, errors: ['spec: ' + String(e && e.message || e).slice(0, 200)], warnings };
    }
  }

  // ---- overrides -------------------------------------------------------------------------
  // Only own, known driver ids with finite numbers survive; values clamp to [min, max]. A
  // choice driver also takes a choice id ("fed_sep") and keeps a whole index.
  // Output keys follow driver order, so equal overrides always serialize identically.
  function cleanOverrides(c, overrides, warnings) {
    const out = {};
    if (!isObj(overrides)) return out;
    if (warnings) for (const k of Object.keys(overrides))
      if (!c.byId.has(k)) warnings.push(`override ${String(k).slice(0, 40)}: unknown driver; ignored`);
    for (const d of c.drivers) {
      if (!own(overrides, d.id)) continue;
      const k = d.id;
      let v = overrides[k];
      if (d.kind === 'choice' && typeof v === 'string') {
        const j = d.choices.findIndex(x => x.id === v);
        if (j < 0) { if (warnings) warnings.push(`override ${k}: unknown choice ${v.slice(0, 40)}; ignored`); continue; }
        v = j;
      }
      if (!isNum(v)) { if (warnings) warnings.push(`override ${k}: not a finite number; ignored`); continue; }
      let cv = clamp(v, d.min, d.max);
      if (d.kind === 'choice') cv = Math.round(cv);
      if (cv !== v && warnings) warnings.push(`override ${k}: clamped to ${cv}`);
      out[k] = cv;
    }
    return out;
  }
  const val = (c, ov, id) => (own(ov, id) ? ov[id] : c.byId.get(id).base);

  // ---- projection ------------------------------------------------------------------------
  // Periods: the stub remainder (or a full first year), then calendar years. m0 = the first
  // month's absolute index (y*12+m); M = months in the period.
  function periods(c) {
    let t0 = 0, m0 = c.mOpen === null ? 0 : c.mOpen + 1;
    return c.years.map((y, i) => {
      const f = i === 0 ? c.frac0 : 1, M = Math.round(f * 12);
      const p = { i, y, t0, t1: t0 + f, f, m0, M };
      t0 += f; m0 += M;
      return p;
    });
  }
  // share of a period's months on/after month F (null F = all of them)
  const wFromP = (p, F) => (F === null ? 1 : p.M ? clamp(p.m0 + p.M - Math.max(F, p.m0), 0, p.M) / p.M : 0);
  function wFrom(c, F) {
    if (!c._wf.has(F)) c._wf.set(F, c.P.map(p => wFromP(p, F)));
    return c._wf.get(F);
  }
  // The events' impacts, aggregated: dated lists for the monthly capacity model, per-period
  // arrays (month-weighted from each event's `from` to its `until`) for financing.
  const LIST_IMPACTS = [['revenue_per_mw_pct', 'rpm'], ['revenue_per_mw_fleet_pct', 'fleet'], ['utilization_pp', 'util'], ['renewal_price_reset_pp', 'reset'],
    ['renewal_churn_pp', 'churn'], ['cor_per_mw_pct', 'cor'], ['power_cost_pct', 'power']];
  const PERIOD_IMPACTS = ['capex', 'spread', 'rate', 'eq', 'disc', 'stock'];
  // one event's contribution, per period / dated (cached on the compiled event)
  function evAgg(c, e) {
    if (e.agg) return e.agg;
    const n = c.years.length, I = e.imp, F = e.from, U = e.until === null ? Infinity : e.until, y0 = yearOf(F);
    const wF = wFrom(c, F), wU = e.until === null ? null : wFrom(c, e.until), w = wF.map((x, i) => x - (wU ? wU[i] : 0));
    const A = { lists: LIST_IMPACTS.filter(([k]) => I[k]).map(([k, list]) => [list, [F, I[k], U]]), per: [], cap: null };
    const per = {}; for (const k of PERIOD_IMPACTS) per[k] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      if (I.capex_delta && I.capex_delta[i] !== null && c.years[i] >= y0) per.capex[i] = I.capex_delta[i];
      if (I.stock_acquisition && I.stock_acquisition[i] !== null && c.years[i] >= y0) per.stock[i] = I.stock_acquisition[i];
      if (I.spread_bp) per.spread[i] = w[i] * I.spread_bp;
      if (I.new_debt_rate_pp) per.rate[i] = w[i] * I.new_debt_rate_pp;
      if (I.equity_share_pp) per.eq[i] = w[i] * I.equity_share_pp;
      if (I.issue_discount_pp) per.disc[i] = w[i] * I.issue_discount_pp;
    }
    A.per = PERIOD_IMPACTS.filter(k => per[k].some(x => x !== 0)).map(k => [k, per[k]]);
    if (I.new_debt_cap) A.cap = c.years.map((y, i) => (I.new_debt_cap[i] !== null && y >= y0 ? I.new_debt_cap[i] : Infinity));
    e.agg = A;
    return A;
  }
  function impacts(c, evs) {
    const n = c.years.length;
    const E = { delays: [], mw: [], rpm: [], fleet: [], util: [], reset: [], churn: [], cor: [], power: [], cuts: [], rel: [], life: [],
      capex: new Array(n).fill(0), spread: new Array(n).fill(0), rate: new Array(n).fill(0), cap: new Array(n).fill(Infinity),
      eq: new Array(n).fill(0), disc: new Array(n).fill(0), stock: new Array(n).fill(0) };
    for (const e of evs) {
      const I = e.imp, A = evAgg(c, e);
      if (I.delay_months) E.delays.push([e.from, I.delay_months, I.delay_share === undefined ? 1 : I.delay_share, I.capex_ahead === undefined ? null : I.capex_ahead]);
      if (I.mw_delta) E.mw.push([e.from, I.mw_delta]);
      for (const [list, x] of A.lists) E[list].push(x);
      if (I.customer_cut) for (const k of I.customer_cut) E.cuts.push(k);
      if (I.capacity_released) for (const k of I.capacity_released) E.rel.push(k);
      for (const [k, arr] of A.per) { const t = E[k]; for (let i = 0; i < n; i++) t[i] += arr[i]; }
      if (A.cap) for (let i = 0; i < n; i++) E.cap[i] = Math.min(E.cap[i], A.cap[i]);
      if (I.useful_life_delta) E.life.push([e.from, I.useful_life_delta]);
    }
    return E;
  }
  // Per-year decimal new-debt rate (and the share of each period's months the shifts touch).
  const shiftIdx = (c, ov) => (c.byId.has('rate_shock_start') ? clamp(Math.round(val(c, ov, 'rate_shock_start')), 0, c.shiftChoices.length - 1) : 0);
  function newRates(c, P, ov, E) {
    const g = id => val(c, ov, id);
    const path = c.choices[Math.round(g('rate_path'))] && c.choices[Math.round(g('rate_path'))].arr || c.sofr;
    const shPct = g('sofr_shift') / 100, sprSh = g('spread_shift') / 1e4;
    const w = c.wShiftBy[shiftIdx(c, ov)];
    const ref = c.refI >= 0 && c.hasRates ? c.sofr[c.refI] : null;
    const rates = P.map((p, i) => Math.max(0, g('new_debt_rate') / 100 + w[i] * sprSh + (E ? E.spread[i] / 1e4 + E.rate[i] / 100 : 0)
      + c.beta * (ref === null ? w[i] * shPct : (path[i] + w[i] * shPct) - ref) / 100));
    return { rates, w, path, shPct, sprSh };
  }

  // tranche balance at time `at` (years from the opening date)
  function repaidAt(c, t, at) {
    let r = 0;
    for (const [y, amt] of t.sched) {
      const s = Math.max(t.ti, (y * 12 - c.mOpen) / 12), e = ((y + 1) * 12 - c.mOpen) / 12;
      r += e <= s ? (at >= s ? amt : 0) : amt * clamp((at - s) / (e - s), 0, 1);
    }
    return r;
  }
  function balAt(c, t, at) {
    if (at < t.ti - 1e-12) return 0;
    const ta = Math.max(t.ti, t.ta);
    if (t.amort === 'bullet' || t.tm <= ta) return t.bal0;
    if (at >= t.tm - 1e-12) return 0;
    if (t.amort === 'schedule') return Math.max(0, t.bal0 - repaidAt(c, t, at));
    return at <= ta ? t.bal0 : t.bal0 * clamp((t.tm - at) / (t.tm - ta), 0, 1);
  }
  const bulletLike = t => t.amort === 'bullet' || t.tm <= Math.max(t.ti, t.ta);
  const hedgeAmt = (h, t, b) => (h.ratio !== null ? h.ratio * b : h.amortises ? h.notional * b / Math.max(1e-9, t.bal0) : Math.min(h.notional, b));
  // Existing tranches do not depend on drivers or events: per period, the monthly balances
  // summed by how they pay (fixed; floating unhedged before / after the shift month; per
  // swap; after maturity), plus the roll-forward pieces and the year-end split.
  function debtCache(c) {
    for (const t of c.debt) {
      t.iMat = c.P.findIndex(p => t.tm <= p.t1 + 1e-12);
      t.per = c.P.map(p => {
        const inPeriod = t.ti > 0 && t.ti >= p.t0 - 1e-12 && t.ti < p.t1 - 1e-12;
        const o = inPeriod ? 0 : balAt(c, t, p.t0), cl = balAt(c, t, p.t1);
        const q = { inPeriod, o, cl, bt: 0, sFix: 0, sAB: c.shiftChoices.map(() => [0, 0]), sMat: 0, sH: t.hedges.map(() => 0), hEnd: 0, repay: 0, refi: 0 };
        for (let k = 0; k < p.M; k++) {
          const tk = p.t0 + (k + 0.5) / 12, b = balAt(c, t, tk);
          if (!(b > 0)) continue;
          q.bt += b / 12;
          if (tk >= t.tm) { q.sMat += b; continue; }
          if (t.kind === 'fixed') { q.sFix += b; continue; }
          const mk = p.m0 + k;
          let hl = 0;
          t.hedges.forEach((h, j) => { if (mk < h.start || mk >= h.end) return; const x = Math.min(b - hl, hedgeAmt(h, t, b)); if (x > 0) { q.sH[j] += x; hl += x; } });
          c.shiftChoices.forEach((x, j) => { if (x.from === null || mk >= x.from) q.sAB[j][1] += b - hl; else q.sAB[j][0] += b - hl; });
        }
        if (t.kind === 'floating' && p.t1 < t.tm - 1e-12 && cl > 0) {
          const mk = p.m0 + p.M - 1;
          for (const h of t.hedges) if (mk >= h.start && mk < h.end) q.hEnd = Math.min(cl, q.hEnd + hedgeAmt(h, t, cl));
        }
        if (bulletLike(t)) { if (t.tm > p.t0 && t.tm <= p.t1) q.refi = t.bal0; } else q.repay = o + (inPeriod ? t.bal0 : 0) - cl;
        return q;
      });
    }
  }

  // ---- capacity_v1: the operating model, monthly ----------------------------------------
  // Returns per-period projected revenue, cost of revenue, capex (short and long life), the
  // last quarter's revenue and cost (exit run-rates) and the capacity rows. Optional: monthRev
  // collects the first period's monthly revenue; fcut (per period) = MW whose build is deferred
  // for lack of funding (by the year-end, recovered over the next year; never floored at the
  // contracts); full adds the backlog rows; trace collects the base billing capacity by month.
  //
  // Billing is split. Contracted MW-equivalents (Rm.Kmw, the backlog schedule over the base
  // price) bill first, at their contract price, once delivered: utilisation, sell-through and
  // price stresses never touch them; a delivery shortfall falls on the customers whose capacity
  // is new. The rest (new capacity and renewals) bills at the scenario price x utilisation x
  // sell-through, less renewal resets and released capacity.
  function operating(c, ov, E, monthRev, fcut, full, trace) {
    const Rm = c.rm, P = c.P, n = c.years.length, g0 = Rm.g0, L = Rm.L, aF = Rm.adjFrom, mF = Rm.mFirst;
    const g = id => (c.byId.has(id) ? val(c, ov, id) : null);
    const lin = (arr, x) => {
      const p = clamp(x - g0, 0, L - 1), k = Math.floor(p), fr = p - k;
      return fr > 0 && k + 1 < L ? arr[k] + (arr[k + 1] - arr[k]) * fr : arr[k];
    };
    const flags = { delayCapped: false, floored: false };
    // 1. delays (the driver from adjust_from, then the events): [from, months, share of the MW they
    //    touch, share of their GPU capex spent on the original schedule]; summed and capped
    let A = Rm.A, Ac = Rm.A;                       // the MW path and the path the GPU capex follows
    const dl = [];
    const d0 = num(g('delivery_delay_months'), 0);
    if (d0) dl.push([aF, d0, 1, Rm.delayAhead]);
    for (const x of E.delays) dl.push([x[0], x[1], x[2], x[3] === null ? Rm.delayAhead : x[3]]);
    if (dl.length) {
      dl.sort((a, b) => a[0] - b[0]);
      let tot = 0;
      for (const [F, dd, phi, ah] of dl) {
        const d = clamp(tot + dd, -Rm.maxDelay, Rm.maxDelay) - tot;
        if (Math.abs(d - dd) > 1e-9) flags.delayCapped = true;
        tot += d;
        if (!d) continue;
        const B = A.slice(), BC = Ac.slice(), a = d > 0 ? ah : 0;
        for (let m = F; m <= Rm.g1; m++) {
          const x = d > 0 ? Math.max(F - 1, m - d) : m - d, k = m - g0;
          B[k] = (1 - phi) * A[k] + phi * lin(A, x);
          BC[k] = (1 - phi) * Ac[k] + phi * ((1 - a) * lin(Ac, x) + a * Ac[k]);
        }
        A = B; Ac = BC;
      }
    }
    // 2. MW on top: extra capacity (driver) and mw_delta events, ramped from `from`. A cut never
    //    takes the path below the MW the signed contracts need (Rm.Areq); funding deferrals can.
    const pos = new Float64Array(L), neg = new Float64Array(L), fc = new Float64Array(L);
    const ramp = (F, vals, scale) => {
      const pts = [[F - 1, 0]];
      c.years.forEach((y, i) => { const m = y * 12 + 12; if (vals[i] !== null && m >= F) pts.push([m, vals[i] * scale]); });
      if (pts.length < 2) return;
      let j = 0;
      for (let m = F; m <= Rm.g1; m++) {
        while (j + 1 < pts.length && pts[j + 1][0] <= m) j++;
        const v = j + 1 < pts.length ? pts[j][1] + (pts[j + 1][1] - pts[j][1]) * (m - pts[j][0]) / (pts[j + 1][0] - pts[j][0]) : pts[j][1];
        if (v > 0) pos[m - g0] += v; else neg[m - g0] += v;
      }
    };
    const xMW = num(g('extra_capacity_mw'), 0);
    if (xMW) ramp(Rm.xFrom, Rm.phase, xMW);
    for (const [F, vals] of E.mw) ramp(F, vals, 1);
    if (fcut) fcut.forEach((x, i) => {
      if (!(x > 0)) return;
      const y = c.years[i];
      for (let m = Math.max(P[i].m0, y * 12 + 1); m <= Math.min(Rm.g1, y * 12 + 24); m++) {
        const t = m <= y * 12 + 12 ? (m - y * 12) / 12 : (y * 12 + 24 - m) / 12;
        fc[m - g0] += x * clamp(t, 0, 1);
      }
    });
    // 3. effective active MW: realised to the opening month, never falling after it
    const Ae = new Float64Array(L), Aec = new Float64Array(L);
    for (let m = g0; m <= Rm.g1; m++) {
      const k = m - g0;
      if (m <= Rm.mOpen) { Ae[k] = Rm.A[k]; Aec[k] = Rm.A[k]; continue; }
      let ng = neg[k];
      if (ng < 0 && Rm.Areq) { const lo = -Math.max(0, A[k] - Rm.Areq[k]); if (ng < lo - 1e-9) { ng = lo; flags.floored = true; } }
      Ae[k] = Math.max(Ae[k - 1], A[k] + pos[k] + ng - fc[k], 0);
      Aec[k] = Math.max(Aec[k - 1], Ac[k] + pos[k] + ng - fc[k], 0);
    }
    const avg = new Float64Array(L), avgA = new Float64Array(L);
    for (let k = 1; k < L; k++) { avg[k] = (Ae[k - 1] + Ae[k]) / 2; avgA[k] = (A[k - 1] + A[k]) / 2; }
    avg[0] = Ae[0]; avgA[0] = A[0];
    // owned MW (month-end): the share of new MW that is self-built (beyond the signed leases when
    // they are given); identified owned sites are already in the path
    const sb = Rm.sb, gSb = sb ? num(g('self_build_share'), 0) / 100 : 0, own = new Float64Array(L);
    if (sb) {
      const cap0 = Rm.leaseCap !== null ? Rm.leaseCap + sb.identMW : null;
      let o = sb.open;
      for (let k = 0; k < L; k++) {
        const m = g0 + k;
        if (k && m > Rm.mOpen && m >= sb.from && gSb > 0) {
          o += gSb * (cap0 === null ? Math.max(0, Ae[k] - Ae[k - 1]) : Math.max(0, Math.max(Ae[k], cap0) - Math.max(Ae[k - 1], cap0)));
        }
        own[k] = o;
      }
    }
    const identAt = m => { let x = 0; if (sb) for (const s of sb.ident) if (m >= s.m) x += s.mw; return x; };
    const sbLead = sb ? Math.round(sb.lead) : 0;

    const gU = num(g('utilization'), 0) / 100, gR = num(g('revenue_per_mw_shift'), 0) / 100, gRs = num(g('renewal_price_reset'), 0) / 100;
    const gSell = c.byId.has('sell_through') ? clamp(val(c, ov, 'sell_through') / 100, 0, 1) : 1;
    const dC = c.byId.get('capex_per_mw'), dR = c.byId.get('cor_per_mw');
    const gCpm = dC && dC.base > 0 ? g('capex_per_mw') / dC.base : 1, gCor = dR && dR.base > 0 ? g('cor_per_mw') / dR.base : 1;
    const gPow = num(g('power_cost_shift'), 0) / 100;
    const nc = Rm.customers.length, BS = Rm.backstop, uI = Rm.customers.findIndex(x => x.computed);
    const cutsBy = Rm.customers.map(() => []);
    for (const k of E.cuts) cutsBy[k.ci].push(k);
    const cutAt = (ci, m) => { let x = 0; for (const k of cutsBy[ci]) if (m >= k.from) x = 1 - (1 - x) * (1 - k.pct); return x; };
    const on = (x, m) => m >= x[0] && m < x[2];
    const prodAt = (list, m) => { let x = 1; for (let j = 0; j < list.length; j++) if (on(list[j], m)) x *= 1 + list[j][1] / 100; return x; };
    const addAt = (list, m) => { let x = 0; for (let j = 0; j < list.length; j++) if (on(list[j], m)) x += list[j][1] / 100; return x; };
    const relAt = (r, m) => (m < r.from ? 0 : r.mw * clamp((m - r.from + 1) / (r.to - r.from + 1), 0, 1));
    const lagI = Number.isInteger(Rm.lag), leadI = Number.isInteger(Rm.lead);
    const Kmw = Rm.Kmw, custC = Rm.custC, cRef = Rm.custRef, cr = Rm.backlog ? Rm.backlog.credit : 0;

    const O = { revP: new Array(n).fill(0), corP: new Array(n).fill(0), capexP: new Array(n).fill(0), capexLongP: new Array(n).fill(0),
      revQ4: new Array(n).fill(0), corQ4: new Array(n).fill(0), revC: Rm.customers.map(() => new Array(n).fill(0)), rows: {}, flags, Ae, q: [] };
    const RW = {};
    for (const k of CAP_ROWS) RW[k] = new Array(n).fill(-0);
    let drag = 0, churnInc = 0, churnAll = 0, bsLeft = BS ? BS.cap : 0, uRRprev = null;
    const shA = new Float64Array(nc);
    for (let i = 0; i < n; i++) {
      const p = P[i], y = c.years[i];
      let bill = 0, lagd = 0, lp = 0, renew = 0, bsum = 0, rent = 0, rentMW = 0, idleR = 0, idleS = 0, power = 0, capCap = 0, maint = 0, capSb = 0, nPlaced = 0, cor = 0;
      let rflow = 0, rsum = 0, unsold = 0, credits = 0, uLast = 0;
      for (let k = 0; k < p.M; k++) {
        const m = p.m0 + k, mi = m - mF, after = m >= aF, gk = m - g0;
        const Lm = lagI ? avg[m - Rm.lag - g0] : lin(avg, m - Rm.lag);
        const u0 = Rm.util[i], u = clamp(u0 + (after ? gU : 0) + (E.util.length ? addAt(E.util, m) : 0), 0, 1);
        const sell = after ? gSell : 1, fl = E.fleet.length ? prodAt(E.fleet, m) : 1;
        const rp0 = Rm.rpmM[mi], rpK = rp0 * fl;
        const rpU = Math.max(0, rp0 * (after ? 1 + gR : 1) * (E.rpm.length ? prodAt(E.rpm, m) : 1) * fl);
        if (trace) { trace.bcap0[mi] = Lm * u0; trace.rp0[mi] = rp0; }
        // contracted first (take-or-pay, once delivered), then the capacity free for new deals and renewals
        const Kc = Kmw ? Kmw[mi] : 0, Bk = Math.min(Kc, Lm * u0);
        const free0 = Math.max(0, Lm * u0 - Bk), free = Math.max(0, Lm * u - Bk), sold = free * sell;
        // renewals: this month's share re-signs at the reset price (churn of it leaves); persists
        const r = clamp(Rm.reset[i] + (after ? gRs : 0) + (E.reset.length ? addAt(E.reset, m) : 0), -1, 1);
        const ch = E.churn.length ? clamp(Rm.churn[i] + addAt(E.churn, m), 0, 1) : Rm.churn[i];
        const flow = Rm.renew[i] / 12 * (Bk + sold);
        drag += flow * (ch - (1 - ch) * r);
        churnInc += flow * Math.max(0, ch - Rm.churn[i]) * (1 + r); churnAll += flow * ch * (1 + r);   // MW-eq at the renewal price
        rflow += flow; rsum += flow * r;
        // capacity coming off contract and not renewed: idle for idle_months, then re-let (or not)
        let relIdle = 0, relGap = 0;
        for (const x of E.rel) {
          const now = relAt(x, m), old = relAt(x, m - x.idle);
          if (x.relet === null) relIdle += now;
          else { relIdle += now - old; relGap += old * -x.relet; }
        }
        const Bu = Math.max(0, sold - drag - relIdle - relGap);
        let revU = Bu * rpU / 12;
        // contracted revenue by customer: a shortfall (capacity late) falls on contracts that are new
        let revK = 0, cutIdle = 0, relet = 0;
        if (custC) {
          const short = Kc > 0 ? Math.max(0, Kc - Bk) / Kc : 0;
          let sInc = 0, sAll = 0;
          for (let ci = 0; ci < nc; ci++) { const v = custC[ci][mi]; shA[ci] = Math.max(0, v - cRef[ci]); sInc += shA[ci]; sAll += v; }
          const shortD = short * sAll;
          for (let ci = 0; ci < nc; ci++) {
            const v = custC[ci][mi];
            if (!(v > 0)) continue;
            const sh = shortD > 0 ? Math.min(v, sInc > 0 ? shortD * shA[ci] / sInc : shortD * v / sAll) : 0;
            const del = v - sh, cut = cutsBy[ci].length ? cutAt(ci, m) : 0;
            const kept = (del * (1 - cut) - cr * sh) * fl;
            credits += cr * sh * fl;
            O.revC[ci][i] += kept; revK += kept;
            if (cut > 0) {                                // freed capacity: idle, then re-let into the uncontracted pool
              const tot = sum(cutsBy[ci].filter(x => m >= x.from).map(x => x.pct)) || 1;
              for (const x of cutsBy[ci]) {
                if (m < x.from) continue;
                const fr = del * cut * fl * x.pct / tot;
                if (x.relet !== null && m >= x.from + x.idle) relet += fr * (rpU / (rpK || 1)) * (1 + x.relet) * sell;
                else cutIdle += fr;
              }
            }
          }
        } else revK = Bk * rpK / 12;
        revU += relet;
        if (uI >= 0) O.revC[uI][i] += revU;
        // the buyer of last resort: capacity a stress leaves unsold (or all unsold capacity)
        let bs = 0;
        if (BS && m <= BS.until && bsLeft > 0) {
          let el = 0;
          if (BS.cuts) el += cutIdle;
          if (BS.util) el += (BS.all ? Math.max(0, Lm - Bk - sold) : Math.max(0, free0 - free) + free * (1 - sell)) * rpU / 12;
          if (BS.churn) el += ((BS.all ? churnAll : churnInc) + relIdle) * rpU / 12;
          bs = Math.min(bsLeft, BS.coverage * Math.max(0, el));     // an upside (more sold) is never a negative purchase
          bsLeft -= bs;
          if (BS.ci >= 0) O.revC[BS.ci][i] += bs;
        }
        const rev = revK + revU + bs;
        if (monthRev && i === 0) monthRev.push(rev);
        unsold += Math.max(0, free0 - free) + free * (1 - sell);
        // costs on active MW (no lag: power and site costs start with the shell); rent on the leased
        // MW, incl. signed shells left without GPUs (less any sublet); owned MW pay no rent
        const aAvg = avg[gk], ownAvg = (own[gk - 1] + own[gk]) / 2 + identAt(m);
        const leased = Math.max(0, aAvg - ownAvg);
        const floor = Rm.leaseCap === null ? 0 : Math.min(Math.max(0, avgA[gk] - identAt(m)), Rm.leaseCap);
        const idle = Math.max(0, floor - leased) * (1 - Rm.sublet);
        const cpm = Rm.cor[i] * (after ? gCor : 1) * (E.cor.length ? prodAt(E.cor, m) : 1);
        const ps = (after ? gPow : 0) + (E.power.length ? addAt(E.power, m) : 0);
        const rentM = (leased + idle) * cpm * Rm.rentShare / 12;
        const powM = aAvg * cpm * Rm.powerShare * (1 + ps * Rm.powerExposed) / 12;
        const corM = aAvg * cpm * (1 - Rm.rentShare - Rm.powerShare) / 12 + rentM + powM + ownAvg * (sb ? sb.opex : 0) / 12 + Rm.corOther * rev;
        cor += corM;
        // capex: MW energised lead_months later (negative lead: placed in service after), on the capex
        // path; GPUs for capacity left unsold are mostly not bought
        const mL = m + Rm.lead, nL = Math.max(0, leadI ? Aec[mL - g0] - Aec[mL - 1 - g0] : lin(Aec, mL) - lin(Aec, mL - 1));
        const fShare = Lm * u0 > 0 ? free0 / (Lm * u0) : 0;
        const cx = Rm.cpm[i] * (after ? gCpm : 1) * (1 - (1 - sell) * fShare * (1 - Rm.unsoldCapex));
        capCap += nL * cx; maint += Rm.maint * rev; nPlaced += nL;
        if (sb) { const ms = m + Rm.lead + sbLead - g0; if (ms > 0 && ms < L) capSb += Math.max(0, own[ms] - own[ms - 1]) * sb.capex; }
        if (k >= p.M - 3) { O.revQ4[i] += rev; O.corQ4[i] += corM; }
        // calendar quarters (for the next prints): revenue, cost, billing MW, quarter-end MW
        const qn = Math.floor(((m - 1) % 12) / 3) + 1, ql = `${y}-Q${qn}`;
        let Q = O.q.length ? O.q[O.q.length - 1] : null;
        if (!Q || Q.quarter !== ql) { Q = { quarter: ql, i, months: 0, revenue: 0, cost_of_revenue: 0, billing: 0, active_mw_end: 0 }; O.q.push(Q); }
        Q.months++; Q.revenue += rev; Q.cost_of_revenue += corM; Q.billing += Bk + sold; Q.active_mw_end = Ae[gk];
        bill += Bk + sold; lagd += Lm; lp += Bk * rpK + sold * rpU; renew -= drag * rpU / 12; bsum += bs;
        rent += rentM; rentMW += leased + idle; idleR += idle * cpm * Rm.rentShare / 12; idleS += Math.max(0, floor - leased); power += powM;
        uLast = revU * 12;
        if (uRRprev === null && k === 0) uRRprev = revU * 12;
        O.revP[i] += rev;
      }
      O.corP[i] = cor;
      O.capexP[i] = Math.max(0, capCap + maint + E.capex[i]); O.capexLongP[i] = capSb;
      // full-year capacity rows (the stub year's actual months use the base path)
      let aSum = 0, bSum = bill;
      for (let m = y * 12 + 1; m <= y * 12 + 12; m++) {
        aSum += avg[m - g0];
        if (m < p.m0) bSum += lin(avg, m - Rm.lag) * Rm.util[i];
      }
      const aAvgY = aSum / 12, eK = y * 12 + 12 - g0;
      const put = (k, v) => { RW[k][i] = v; };
      put('active_mw_end', Ae[eK]); put('active_mw_avg', aAvgY); put('mw_added', Ae[eK] - Ae[y * 12 - g0]);
      put('billing_mw_avg', bSum / 12); put('utilization_avg', lagd > 0 ? bill / lagd * 100 : null);
      put('revenue_per_billing_mw', bill > 0 ? O.revP[i] / (bill / 12) : null); put('list_price_per_billing_mw', bill > 0 ? lp / bill : null);
      put('renewal_price_change', rflow > 0 ? rsum / rflow * 100 : (Rm.reset[i] + (p.m0 >= aF ? gRs : 0)) * 100);
      put('unsold_mw', p.M ? unsold / p.M : 0); put('active_mw_vs_plan', Rm.A[eK] > 0 ? Ae[eK] / Rm.A[eK] * 100 : null);
      put('mw_deferred', fc[eK]);
      put('renewal_effect', renew); put('backstop_revenue', bsum);
      put('backstop_left', BS ? bsLeft : null);
      put('capex_capacity', capCap); put('capex_maintenance', maint); put('capex_self_build', capSb);
      put('capex_per_mw_eff', nPlaced > 0 ? (capCap + capSb) / nPlaced : null);
      put('rent', rent); put('power_cost', power); put('owned_mw', own[eK] + identAt(y * 12 + 12));
      put('rent_per_mw', rentMW > 0 ? rent / (rentMW / 12) : null);
      put('idle_shell_mw', p.M ? idleS / p.M : 0); put('idle_rent', idleR);
      put('uncontracted_run_rate', uLast);
      put('bookings_needed', Math.max(0, uLast - (uRRprev === null ? 0 : uRRprev)) * Rm.term);
      put('undelivered_credits', credits);
      uRRprev = uLast;
    }
    if (full && Rm.custRaw) backlogRows(c, RW, cutsBy);
    O.rows = RW;
    return O;
  }
  // The backlog signed to date that is still to convert at each year-end (cancellations, i.e.
  // customer cuts, come off it; delays do not; contracts signed later are not in it) and the
  // largest customer's share of it.
  function backlogRows(c, RW, cutsBy) {
    const Rm = c.rm, mF = Rm.mFirst, nM = Rm.contractM.length, nc = Rm.customers.length;
    const cutAt = (ci, m) => { let x = 0; for (const k of cutsBy[ci]) if (m >= k.from) x = 1 - (1 - x) * (1 - k.pct); return x; };
    c.years.forEach((y, i) => {
      const me = y * 12 + 12;
      let tot = 0, top = 0;
      const rem = new Float64Array(nc);
      for (let mi = Math.max(0, me + 1 - mF); mi < nM; mi++) {
        const m = mF + mi;
        for (let ci = 0; ci < nc; ci++) { const v = Rm.custRaw[ci][mi] * (1 - (cutsBy[ci].length ? cutAt(ci, m) : 0)); rem[ci] += v; tot += v; }
      }
      Rm.customers.forEach((x, ci) => { if (!x.aggregate && tot > 0) top = Math.max(top, rem[ci] / tot * 100); });
      RW.backlog_remaining[i] = tot; RW.top_backlog_share[i] = tot > 0 ? top : null;
    });
  }
  // Contracted revenue (backlog conversion) by month and year, from the spec's base case: each
  // bucket's share of the RPO spread evenly over its months after the as-of month (beyond the
  // model too); with committed_share, the first period's months are capped at that share of base
  // revenue and the excess moves to the bucket's later months; post-period commitments spread
  // over their years (the rest over the two years after the model). Then, from the base billing
  // capacity, the contracted MW-equivalents the base delivers (Kmw), the MW the contracts need
  // (Areq, never falling) and each customer's contracted schedule (its share of each year; after
  // the model its backlog_share less what the model already counts).
  function contractSchedule(c) {
    const Rm = c.rm, B = Rm.backlog;
    if (!B) return;
    const monthRev = [], nM = Rm.g1 - Rm.mFirst + 1, nIn = Rm.mLast - Rm.mFirst + 1;
    const trace = { bcap0: new Float64Array(nIn), rp0: new Float64Array(nIn) };
    operating(c, {}, c.E0, monthRev, null, false, trace);
    const P0 = c.P[0], first = m => m >= P0.m0 && m < P0.m0 + P0.M;
    const per = new Float64Array(nM);
    B.buckets.forEach((b, bi) => {
      const a = B.asOf + b.a, z = B.asOf + b.b, each = B.rpo * b.share / (z - a + 1);
      let excess = 0, later = 0;
      for (let m = a; m <= z; m++) {
        let v = each;
        if (bi === 0 && B.committedShare !== null && first(m)) { v = Math.min(each, B.committedShare * monthRev[m - P0.m0]); excess += each - v; }
        else if (bi === 0 && B.committedShare !== null && m > P0.m0) later++;
        if (m >= Rm.mFirst && m <= Rm.g1) per[m - Rm.mFirst] += v;
      }
      if (excess > 0 && later > 0) for (let m = a; m <= z; m++) if (!first(m) && m > P0.m0 && m >= Rm.mFirst && m <= Rm.g1) per[m - Rm.mFirst] += excess / later;
    });
    c.P.forEach((p, i) => { if (B.post[i]) for (let k = 0; k < p.M; k++) per[p.m0 + k - Rm.mFirst] += B.post[i] / p.M; });
    const postLeft = B.postTotal - sum(B.post);
    if (postLeft > 0) for (let k = 1; k <= 24 && nIn + k - 1 < nM; k++) per[nIn + k - 1] += postLeft / 24;
    // a month never bills more contracted revenue than the base capacity can deliver: the excess
    // moves to the following months (the even spread within a bucket front-loads a ramping fleet)
    let carry = 0;
    for (let mi = 0; mi < nM; mi++) {
      const v = per[mi] + carry, capM = mi < nIn ? trace.bcap0[mi] * trace.rp0[mi] / 12 : Infinity;
      per[mi] = Math.min(v, capM); carry = v - per[mi];
    }
    if (carry > 1e-6) per[nM - 1] += carry;
    Rm.contractM = per;
    Rm.contractY = c.P.map((p, i) => {
      let s = i === 0 && c.stub ? c.stub.a.revenue : 0;
      for (let k = 0; k < p.M; k++) s += per[p.m0 + k - Rm.mFirst];
      return s;
    });
    // contracted MW-equivalents: raw, and what the base billing capacity delivers
    const rpLast = trace.rp0[nIn - 1] || 1;
    Rm.KmwRaw = new Float64Array(nM); Rm.Kmw = new Float64Array(nIn);
    for (let mi = 0; mi < nM; mi++) {
      const rp = mi < nIn ? trace.rp0[mi] : rpLast;
      Rm.KmwRaw[mi] = rp > 0 ? per[mi] * 12 / rp : 0;
      if (mi < nIn) Rm.Kmw[mi] = Math.min(Rm.KmwRaw[mi], trace.bcap0[mi]);
    }
    // the active MW the contracts need (billing lag, base utilisation), never falling
    Rm.Areq = new Float64Array(Rm.L);
    let need = 0;
    for (let k = 0; k < Rm.L; k++) {
      const m = Rm.g0 + k, mb = m + Math.round(Rm.lag), mi = mb - Rm.mFirst;
      if (m <= Rm.mOpen) { Rm.Areq[k] = Rm.A[k]; continue; }
      const u0 = Rm.util[Rm.yIdx(Math.min(mb, Rm.mLast))];
      if (mi >= 0 && mi < nIn && u0 > 0) need = Math.max(need, Rm.Kmw[mi] / u0);
      Rm.Areq[k] = need;
    }
    // customers' contracted schedules: in the model, their share of each year; after it, what is
    // left of their backlog share
    const cs = Rm.customers, nc = cs.length, T = B.rpo + B.postTotal;
    Rm.custRaw = cs.map(() => new Float64Array(nM)); Rm.custC = cs.map(() => new Float64Array(nIn));
    const inH = new Float64Array(nc);
    for (let mi = 0; mi < nIn; mi++) {
      const i = Rm.yIdx(Rm.mFirst + mi), dlv = Rm.KmwRaw[mi] > 0 ? Rm.Kmw[mi] / Rm.KmwRaw[mi] : 0;
      cs.forEach((x, ci) => { const v = per[mi] * x.sh[i]; Rm.custRaw[ci][mi] = v; Rm.custC[ci][mi] = v * dlv; inH[ci] += v; });
    }
    const resid = cs.map((x, ci) => (x.computed ? 0 : Math.max(0, (x.backlog_share !== null ? x.backlog_share : 0) * T - inH[ci])));
    const rT = sum(resid), tail = sum(Array.from(per.slice(nIn)));
    const tShare = cs.map((x, ci) => (rT > 0 ? resid[ci] / rT : x.computed ? 0 : x.sh[c.years.length - 1]));
    for (let mi = nIn; mi < nM; mi++) cs.forEach((x, ci) => { Rm.custRaw[ci][mi] = per[mi] * tShare[ci]; });
    if (rT > 0 && Math.abs(rT - tail) > 0.05 * Math.max(tail, 1)) c.warnings.push(`revenue_model: customers' backlog shares leave ${Math.round(rT).toLocaleString('en-US')} for after ${c.years[c.years.length - 1]}, the schedule ${Math.round(tail).toLocaleString('en-US')}`);
    const ref = Math.max(Rm.mFirst, Rm.adjFrom - 1) - Rm.mFirst;
    Rm.custRef = cs.map((x, ci) => Rm.custC[ci][Math.min(ref, nIn - 1)]);
  }

  // run options, always this shape: {lean, multiples, opCache, pool, noLink}
  const RO = (lean, multiples, opCache, pool, noLink) => ({ lean: !!lean, multiples: !!multiples, opCache: opCache || null, pool: pool || null, noLink: !!noLink });
  const FULL = RO(false), LEAN = RO(true), LEAN_M = RO(true, true);
  const MAX_FUND_PASSES = 4;
  // One projection. With funding.when_short "defer_build" (capacity models), a funding gap that
  // cannot be borrowed defers the MW (and their capex) it would have paid for by a year, and the
  // projection is re-run until the gap is closed or MAX_FUND_PASSES is reached; whatever is left
  // costs the penalty rate.
  function run(c, ov, evs, opts) {
    evs = evs || []; opts = opts || FULL;
    const E = evs.length ? impacts(c, evs) : c.E0;
    const cap = c.mode === 'capacity';
    let OP = null;
    if (cap) {
      const key = opts.opCache ? evs.filter(e => e.op).map(e => e.id).join('|') : null;
      OP = key !== null && opts.opCache.has(key) ? opts.opCache.get(key) : operating(c, ov, E, null, null, !opts.lean);
      if (key !== null) opts.opCache.set(key, OP);
    }
    let r = runFin(c, ov, evs, opts, E, OP);
    const short = () => r.ra[RI.funding_shortfall];
    if (cap && c.whenShort === 'defer_build' && short().some(x => x > 0.5)) {
      const n = c.years.length, cut = new Array(n).fill(0), rev0 = r.ra[RI.revenue].slice();
      const dC = c.byId.get('capex_per_mw'), gC = dC && dC.base > 0 ? val(c, ov, 'capex_per_mw') / dC.base : 1;
      for (let k = 0; k < MAX_FUND_PASSES && short().some(x => x > 0.5); k++) {
        const s = short();
        for (let i = 0; i < n; i++) if (s[i] > 0.5) cut[i] += s[i] / Math.max(1, c.rm.cpm[i] * gC);
        const O2 = operating(c, ov, E, null, cut, !opts.lean);
        r = runFin(c, ov, evs, opts, E, O2);
      }
      r.ra[RI.mw_deferred] = r.ra[RI.mw_deferred].slice();
      r.fund_revenue_lost = rev0.map((x, i) => x - r.ra[RI.revenue][i]);
      if (!opts.lean) {
        const yy = c.years.filter((_, i) => cut[i] > 0.5);
        if (yy.length) r.warnings.push(`funding: the gap that could not be borrowed defers ${yy.map(y => `${Math.round(cut[c.years.indexOf(y)]).toLocaleString('en-US')} MW in ${y}`).join(', ')} (built a year later)`);
      }
    }
    return opts.lean ? r : finishRun(c, r);
  }
  // Depreciation vintage: book value amt from `start` (years from the opening date), straight-line
  // over the life in force then; at each later change of the life the remaining life is rescaled by
  // new / old (a prospective change of estimate). Returns its segments [from, to, rate per year].
  function vintageSegs(amt, start, R0, L0, changes, lifeAt) {
    const segs = [];
    let t = start, nbv = amt, R = R0, Lc = L0;
    if (!(amt > 0) || !(R > 0)) return segs;
    const Ls = lifeAt(start);                    // a life already changed when the asset starts
    if (Math.abs(Ls - Lc) > 1e-12) { R = R * Ls / Lc; Lc = Ls; }
    for (const [T] of changes) {
      if (T <= t + 1e-12) continue;
      const dur = Math.min(T - t, R), rate = nbv / R;
      if (dur > 0) { segs.push([t, t + dur, rate]); nbv -= rate * dur; R -= dur; }
      t = T;
      if (!(R > 1e-9) || !(nbv > 1e-9)) return segs;
      const Ln = lifeAt(T);
      R = R * Ln / Lc; Lc = Ln;
    }
    if (R > 0 && nbv > 0) segs.push([t, t + R, nbv / R]);
    return segs;
  }
  const segDep = (segs, t0, t1) => { let d = 0; for (const [a, b, r] of segs) d += r * Math.max(0, Math.min(t1, b) - Math.max(t0, a)); return d; };

  function runFin(c, ov, evs, opts, E, OP) {
    const Y = c.years, n = Y.length, warnings = [], P = c.P;
    const g = id => val(c, ov, id);
    const has = id => c.byId.has(id);
    const sw = id => c.byId.get(id).stub_weight;
    const wt = (id, i) => (i === 0 && c.stub ? sw(id) : 1);
    const cap = c.mode === 'capacity';
    const growth = cap ? null : c.byId.get('revenue_growth').path.map((p, i) => Math.max(-100, p + g('revenue_growth') * wt('revenue_growth', i)));
    const corPct = cap ? null : c.byId.get('cost_of_revenue_pct').path.map((p, i) => Math.max(0, p + g('cost_of_revenue_pct') * wt('cost_of_revenue_pct', i)));
    const opexPct = c.byId.get('opex_pct').path.map((p, i) => Math.max(0, p + g('opex_pct') * wt('opex_pct', i)));
    const capPath = cap ? null : c.byId.get('capex').path;
    const capexFY = cap ? null : capPath.map((p, i) => Math.max(0, p * (1 + g('capex') / 100 * wt('capex', i)) + E.capex[i]));
    const sbcPct = g('sbc_pct') / 100, tax = g('tax_rate') / 100, minTax = Math.max(0, g('min_tax'));
    const life0 = Math.max(0.5, c.byId.get('useful_life').base), lag = Math.max(0, g('in_service_lag'));
    // the depreciation life in force over time: the driver (from adjust_from with a revenue model,
    // else from the opening date) and the events' useful_life_delta (from their start)
    const lifeCh = [];
    if (Math.abs(g('useful_life') - life0) > 1e-12) lifeCh.push([cap ? Math.max(0, (c.rm.adjFrom - 1 - c.mOpen) / 12) : 0, g('useful_life') - life0]);
    for (const [F, d] of E.life) lifeCh.push([Math.max(0, (F - 1 - c.mOpen) / 12), d]);
    lifeCh.sort((a, b) => a[0] - b[0]);
    const lifeAt = t => { let L = life0; for (const [T, d] of lifeCh) if (t >= T - 1e-12) L += d; return Math.max(0.5, L); };
    const link = cap ? 0 : g('capex_revenue_link') / 100, sbcSh = g('sbc_share_pct') / 100;
    const minCash = g('min_cash'), wc = g('wc_prepay_pct') / 100, dil = g('share_dilution_pct') / 100;
    const price = g('share_price');
    const disc0 = g('issue_discount');
    let eShare0 = g('equity_funding_share') / 100;
    if (eShare0 > 0 && !(price * (1 - disc0 / 100) > 0)) { warnings.push('equity funding needs a share price > 0; gap funded with debt'); eShare0 = 0; }
    const fs = c.vintage ? (has('new_debt_floating_share') ? g('new_debt_floating_share') / 100 : 1) : 1;
    const hr = c.vintage && has('hedge_ratio_new') ? g('hedge_ratio_new') / 100 : 0;
    const lock = c.vintage ? (1 - fs) + fs * hr : 0;         // share of new borrowing at a locked rate
    const NR = newRates(c, P, ov, E), newRate = NR.rates;
    const si = shiftIdx(c, ov), shiftFrom = c.shiftChoices[si].from, wSh = c.wShiftBy[si];
    // SOFR (%) floored at 0: the selected path, + the shift from the shift month on; per period the
    // months before the shift month (A) and from it (B), and their average
    const sofrA = P.map(p => Math.max(0, NR.path[p.i])), sofrB = P.map(p => Math.max(0, NR.path[p.i] + NR.shPct));
    const sofrAvg = P.map((p, i) => (p.M ? (sofrA[i] * (1 - wSh[i]) * p.M + sofrB[i] * wSh[i] * p.M) / p.M : NR.path[p.i]));
    const sofrAt = m => {                       // a swap struck at month m locks the then-prevailing path rate
      if (!(m > c.mOpen)) return sofrA[0];
      const i = P.findIndex(p => m < p.m0 + p.M);
      const k = i < 0 ? n - 1 : i;
      return shiftFrom === null || m >= shiftFrom ? sofrB[k] : sofrA[k];
    };
    const hRate = h => (h.rate === 'path' ? sofrAt(h.start) : h.rate);
    const Z = new Array(n).fill(-0), ZN = new Array(n).fill(null);   // -0: double elements from the start
    // rows by index; a lean caller may lend a pool of row arrays (every non-capacity row except the
    // multiples and the rate exposure is rewritten each period, and lean callers read neither)
    const capRow = k => (cap ? (CAP_EDITED.has(k) ? OP.rows[k].slice() : OP.rows[k]) : ZN.slice());
    let RA;
    if (opts.pool) { RA = opts.pool.slice(); for (const j of CAP_IDX) RA[j] = capRow(ROW_NAMES[j]); }
    else RA = ROW_NAMES.map(k => (CAP_SET.has(k) ? capRow(k) : Z.slice()));
    const ibt = {}, rbt = {}, dbt = {};
    for (const t of c.debt) { ibt[t.id] = Z.slice(); rbt[t.id] = ZN.slice(); dbt[t.id] = Z.slice(); }
    for (const t of c.committed) { ibt[t.id] = Z.slice(); rbt[t.id] = ZN.slice(); dbt[t.id] = Z.slice(); }
    ibt[NEW_DEBT_ID] = Z.slice(); rbt[NEW_DEBT_ID] = ZN.slice(); dbt[NEW_DEBT_ID] = Z.slice();

    // capex in each period's projected part (current and the path), its in-service date
    const capP = cap ? OP.capexP.slice() : capexFY.map((x, i) => Math.max(0, i === 0 && c.stub ? x - c.stub.a.capex : x));
    if (!cap) capexFY.forEach((x, i) => { if (i === 0 && c.stub && x < c.stub.a.capex) warnings.push(`${Y[i]}: capex path below actual capex; projected part floored at 0`); });
    const start = P.map(p => p.t0 + p.f / 2 + lag);
    // in-service gross PP&E, month-averaged per period -> the revenue capacity multiplier
    const gIn = Math.max(0, c.opening.gross - c.opening.cip), tCip = c.opening.cipIn;
    const inSvc = (cp, tau) => gIn + (tau >= tCip ? c.opening.cip : 0) + cp.reduce((s, a, j) => s + (tau >= start[j] ? a : 0), 0);
    const avgSvc = (cp, p) => sum(Array.from({ length: p.M }, (_, k) => inSvc(cp, p.t0 + (k + 0.5) / 12))) / Math.max(1, p.M);
    const capPb = link > 0 ? capPath.map((x, i) => Math.max(0, i === 0 && c.stub ? Math.max(0, x) - c.stub.a.capex : Math.max(0, x))) : null;
    const mult = P.map(p => {
      if (!(link > 0)) return 1;
      const b = avgSvc(capPb, p);
      return b > 0 ? Math.max(0, 1 + link * (avgSvc(capP, p) / b - 1)) : 1;
    });

    // depreciation: in-service book value at its rate (the base life) and each vintage (construction
    // in progress, each period's capex from its in-service date) straight-line, re-spread when the
    // life changes; self-built shells and assets bought with shares over their own long life
    const vSegs = [];
    const exist0 = c.opening.depRate !== null ? c.opening.depRate : c.opening.depBase / life0;
    const existSegs = exist0 > 0 ? vintageSegs(c.opening.depNbv, 0, c.opening.depNbv / exist0, life0, lifeCh, lifeAt) : [];
    if (!c.opening.cipInCapex) vSegs.push(vintageSegs(c.opening.cip, tCip, lifeAt(tCip), lifeAt(tCip), lifeCh, lifeAt));
    const longLife = cap && c.rm.sb ? c.rm.sb.life : 25;

    let debt0 = 0;
    for (const t of c.debt) if (t.ti <= 0) debt0 += t.bal0;
    const nd0 = debt0 - c.opening.cash;
    let cash = c.opening.cash, shares = c.opening.shares, newDebt = 0, ppe = c.opening.net - (c.opening.cipInCapex ? c.opening.cip : 0), eq = c.opening.equity;
    const cLeft = c.committed.map(x => x.amount), cBal = c.committed.map(() => 0);
    const nv = [];                               // new-debt vintages {i, notes, am (amortising), rL, sL}
    const amortF = (v, at) => (c.newAmort > 0 ? clamp(1 - (at - P[v.i].t1) / c.newAmort, 0, 1) : 1);
    const avgAmort = (v, a, b) => {              // mean of the straight-line factor over [a, b]
      const s0 = P[v.i].t1, e = s0 + c.newAmort;
      if (b <= s0) return 1;
      if (a >= e) return 0;
      const pts = [a, clamp(s0, a, b), clamp(e, a, b), b];
      let area = 0;
      for (let k = 1; k < 4; k++) area += (amortF(v, pts[k - 1]) + amortF(v, pts[k])) / 2 * (pts[k] - pts[k - 1]);
      return b > a ? area / (b - a) : amortF(v, a);
    };
    const pen = c.shortPenalty;                  // decimal: extra rate on a gap that could not be raised
    let prevPath = c.priorRev, prevRev = c.priorRev, fundCum = 0, uncCum = 0, deficit = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i], isStub = i === 0 && c.stub, f = p.f, t0 = p.t0, t1 = p.t1;
      const A = isStub ? c.stub.a : null;
      // P&L, projected part (FY minus actuals in the stub year)
      let pathFY = null, revP;
      if (cap) revP = OP.revP[i];
      else {
        pathFY = prevPath * (1 + growth[i] / 100);
        let revP0 = A ? pathFY - A.revenue : pathFY;
        if (revP0 < 0) { warnings.push(`${Y[i]}: growth path implies revenue below the actuals; projected part floored at 0`); revP0 = 0; }
        revP = revP0 * mult[i];
      }
      const revFY = revP + (A ? A.revenue : 0);
      const corP = cap ? OP.corP[i] : revP * corPct[i] / 100, opexP = revP * opexPct[i] / 100, sbcP = revP * sbcPct;
      const capexP = capP[i], capexL = cap ? OP.capexLongP[i] : 0, stockA = E.stock[i];
      vSegs.push(vintageSegs(capexP, start[i], lifeAt(start[i]), lifeAt(start[i]), lifeCh, lifeAt));
      if (capexL > 0) vSegs.push(vintageSegs(capexL, start[i], longLife, longLife, [], () => longLife));
      if (stockA > 0) vSegs.push(vintageSegs(stockA, t0 + f / 2, longLife, longLife, [], () => longLife));
      const daEx = segDep(existSegs, t0, t1);
      let daNew = 0;
      for (const sg of vSegs) daNew += segDep(sg, t0, t1);
      const daP = daEx + daNew;
      const ebitdaP = revP - corP - opexP, ebitP = ebitdaP - sbcP - daP;

      // existing tranches: cached balance sums x this run's rates (a matured bullet pays the
      // new-debt rate of its year; with vintages, the locked / floating mix after that)
      let trCash = 0, trFee = 0, repay = 0, refi = 0, issued = 0, issueCash = 0, issueEq = 0, debtOpen = 0, debtClose = 0, secClose = 0;
      let iFix = 0, iFlt = 0, iNF = 0, iNV = 0, dFix = 0, dFlt = 0, dNF = 0, dNV = 0, hedged = 0;
      const refiRate = t => {
        if (!c.vintage) return newRate[i];
        const im = t.iMat < 0 ? 0 : t.iMat;
        if (i <= im) return newRate[i];
        return lock * newRate[im] + (1 - lock) * Math.max(0, newRate[im] + (sofrAvg[i] - sofrAvg[im]) / 100);
      };
      for (const t of c.debt) {
        const q = t.per[i];
        let ic = 0, ifee = 0;
        if (q.bt > 0) {
          if (t.kind === 'fixed') {
            ic = q.sFix * (t.coupon === null ? newRate[i] : t.coupon / 100) / 12; ifee = q.sFix * t.fee / 1e4 / 12;
            iFix += ic + ifee;
          } else {
            const sp = t.spread / 1e4, ra = Math.max(0, sofrA[i] / 100 + sp), rb = Math.max(0, sofrB[i] / 100 + sp);
            const [sA, sB] = q.sAB[si];
            const iu = (sA * ra + sB * rb) / 12;
            let ih = 0, sh = 0;
            t.hedges.forEach((h, j) => { if (q.sH[j] > 0) { ih += q.sH[j] * (hRate(h) / 100 + sp) / 12; sh += q.sH[j]; } });
            const tot = sA + sB + sh;
            ifee = tot * t.fee / 1e4 / 12; ic = iu + ih;
            iFlt += iu + (tot > 0 ? ifee * (sA + sB) / tot : 0); iFix += ih + (tot > 0 ? ifee * sh / tot : 0);
          }
          if (q.sMat > 0) {
            const im = q.sMat * refiRate(t) / 12;
            ic += im;
            if (c.vintage) { iNF += im * lock; iNV += im * (1 - lock); } else iNV += im;
          }
        }
        if (q.inPeriod) { issued += t.bal0; issueCash += t.issueCash; issueEq += t.issueEq; }
        repay += q.repay; refi += q.refi;
        ibt[t.id][i] = ic + ifee; rbt[t.id][i] = q.bt > 0 ? (ic + ifee) / q.bt * 100 : null; dbt[t.id][i] = q.cl;
        trCash += ic; trFee += ifee; debtOpen += q.o; debtClose += q.cl; if (t.secured) secClose += q.cl;
        if (q.cl > 0) {
          if (t1 >= t.tm - 1e-12) { if (c.vintage) { dNF += q.cl * lock; dNV += q.cl * (1 - lock); } else dNV += q.cl; }
          else if (t.kind === 'fixed') dFix += q.cl;
          else { dFix += q.hEnd; dFlt += q.cl - q.hEnd; hedged += q.hEnd; }
        }
      }

      // new-debt vintages raised in earlier periods: interest at their rates, amortisation
      let intPrior = 0, nFix = 0, nFlt = 0, newRepay = 0, poolOpen = 0;
      for (const v of nv) {
        const aO = amortF(v, t0), aC = amortF(v, t1);
        const amAvg = v.am * (c.newAmort > 0 ? avgAmort(v, t0, t1) : 1), notes = v.notes;
        poolOpen += notes + v.am * aO; newRepay += v.am * (aO - aC);
        if (c.vintage) {
          const rF = Math.max(0, v.rL + (sofrAvg[i] - v.sL) / 100);
          const fx = (notes + amAvg * hr) * v.rL * f, fl = amAvg * (1 - hr) * rF * f;
          intPrior += fx + fl; nFix += fx; nFlt += fl;
        } else { const x = (notes + amAvg) * newRate[i] * f; intPrior += x; nFlt += x; }
      }
      repay += newRepay;
      // committed facilities that amortise after their draw window: straight-line to maturity
      const cRep = c.committed.map((x, k) => (x.amortises && t0 >= x.until - 1e-9 && cBal[k] > 0 ? cBal[k] * Math.min(1, f / Math.max(1e-9, x.tm - t0)) : 0));
      for (const x of cRep) repay += x;

      // funding: fixed point on the debt raised this period (its half-year interest lowers
      // OCF, which widens the gap it fills); committed facilities first, then new debt up to
      // any market cap (the rest is a shortfall, which costs the penalty rate until refilled)
      const issuePx = price * (1 - clamp(disc0 + E.disc[i], 0, 100) / 100);
      let eSh = clamp(eShare0 + E.eq[i] / 100, 0, 1);
      if (eSh > 0 && !(issuePx > 0)) eSh = 0;
      const crate = c.committed.map(x => {
        let r = x.kind === 'fixed' && x.coupon !== null ? x.coupon / 100 : Math.max(0, sofrAvg[i] / 100 + x.spread / 1e4), hs = 0, rh = 0;
        if (x.hedges.length) {
          for (const h of x.hedges) {
            let mo = 0;
            for (let k = 0; k < p.M; k++) if (p.m0 + k >= h.start && p.m0 + k < h.end) mo++;
            const a = Math.min(1 - hs, h.ratio * mo / Math.max(1, p.M));
            if (a > 0) { hs += a; rh += a * (hRate(h) / 100 + x.spread / 1e4); }
          }
          r = r * (1 - hs) + rh;
        }
        const before = clamp(x.tm - t0, 0, f);             // time still on the facility's terms
        return { cash: (r * before + newRate[i] * (f - before)) / f, fee: x.fee / 1e4 * before / f, pre: r * before / f, hs, hsr: rh * before / f, before };
      });
      const open = c.committed.map(x => x.until > t0 + 1e-9);
      const capU = E.cap[i], penR = newRate[i] + pen;
      let D = 0, s = null;
      const draws = new Array(c.committed.length).fill(0), S = {};
      const step = Dg => {
        let left = Dg, intC = 0, feeC = 0;
        for (let k = 0; k < draws.length; k++) {
          const d = open[k] ? Math.min(cLeft[k], left) : 0;
          left -= d;
          const avgB = Math.max(0, cBal[k] - cRep[k] / 2 + d / 2) * f;
          intC += crate[k].cash * avgB; feeC += crate[k].fee * avgB;
          draws[k] = d;
        }
        const Du = Math.max(0, Math.min(left, capU)), short = Math.max(0, left - Du);
        const intNew = c.vintage || c.newAmort > 0 ? intPrior + newRate[i] * Du / 2 * f : newRate[i] * (newDebt + (newDebt + Du)) / 2 * f;
        const intSh = pen > 0 ? (deficit + short / 2) * penR * f : 0;
        const nonCash = trFee + feeC;
        const intP = trCash + intC + intNew + nonCash + intSh;
        const preP = ebitP - intP;
        const taxP = Math.max(tax * Math.max(0, preP), minTax * f);
        const niP = preP - taxP;
        const ocfP = niP + daP + sbcP + nonCash + wc * (revFY - prevRev) * f;
        const pre = cash + ocfP - capexP - capexL - repay + issueCash;
        const gap = Math.max(0, minCash - pre);
        S.intNew = intNew; S.intC = intC; S.intSh = intSh; S.nonCash = nonCash; S.intP = intP; S.preP = preP; S.taxP = taxP; S.niP = niP; S.ocfP = ocfP;
        S.pre = pre; S.gap = gap; S.draws = draws; S.Du = Du; S.short = short; S.D = gap * (1 - eSh);
        return S;
      };
      for (let k = 0; k < FIX_ITERS; k++) {
        s = step(D);
        if (Math.abs(s.D - D) < FIX_TOL) break;
        D = s.D;
      }
      if (Math.abs(s.D - D) >= FIX_TOL * 1e3) warnings.push(`${Y[i]}: funding loop did not fully converge`);
      if (s.short > 0 && !opts.lean) warnings.push(`${Y[i]}: ${Math.round(s.short).toLocaleString('en-US')} of the funding gap could not be borrowed (debt markets shut); cash falls below the minimum`);
      const eqRaised = s.gap * eSh, newSh = eqRaised > 0 ? eqRaised / issuePx : 0;
      const sbcShares = price > 0 ? sbcP * sbcSh / price : 0, stockSh = stockA > 0 && price > 0 ? stockA / price : 0;
      let cDraw = 0, cSec = 0;
      c.committed.forEach((x, k) => {
        const d = s.draws[k], cr = crate[k], avgB = Math.max(0, cBal[k] - cRep[k] / 2 + d / 2) * f;
        ibt[x.id][i] = (cr.cash + cr.fee) * avgB;
        // split: before maturity by kind (swapped part fixed), after it new borrowing
        const feeI = cr.fee * avgB, preI = cr.pre * avgB, postI = (cr.cash - cr.pre) * avgB;
        if (x.kind === 'fixed' && x.coupon !== null) iFix += preI + feeI;
        else { const fx = cr.hsr * avgB; iFix += fx + feeI * cr.hs; iFlt += preI - fx + feeI * (1 - cr.hs); }
        if (c.vintage) { iNF += postI * lock; iNV += postI * (1 - lock); } else iNV += postI;
        cLeft[k] -= d; cBal[k] = Math.max(0, cBal[k] + d - cRep[k]); cDraw += d;
        rbt[x.id][i] = cBal[k] > 0 ? (cr.cash + cr.fee) * 100 : null; dbt[x.id][i] = cBal[k];
        if (x.secured) cSec += cBal[k];
        if (cBal[k] > 0) {
          if (t1 >= x.tm - 1e-12) { if (c.vintage) { dNF += cBal[k] * lock; dNV += cBal[k] * (1 - lock); } else dNV += cBal[k]; }
          else if (x.kind === 'fixed' && x.coupon !== null) dFix += cBal[k];
          else {
            let he = 0;
            const mk = p.m0 + p.M - 1;
            for (const h of x.hedges) if (mk >= h.start && mk < h.end) he = Math.min(1, he + h.ratio);
            dFix += cBal[k] * he; dFlt += cBal[k] * (1 - he); hedged += cBal[k] * he;
          }
        }
      });
      ibt[NEW_DEBT_ID][i] = s.intNew;
      // this period's vintage: half-year interest at its own rate, split by how it was raised
      const curI = s.intNew - intPrior;
      if (c.vintage) { nFix += curI * lock; nFlt += curI * (1 - lock); } else if (c.newAmort > 0) nFlt += curI;
      else { nFix = 0; nFlt = s.intNew; }
      iNF += nFix; iNV += nFlt + s.intSh;
      if (s.Du > 0) nv.push({ i, notes: c.vintage ? s.Du * (1 - fs) : 0, am: c.vintage ? s.Du * fs : s.Du, rL: newRate[i], sL: sofrAvg[i] });
      let poolClose = 0, pFix = 0;
      for (const v of nv) { const b = v.notes + v.am * amortF(v, t1); poolClose += b; pFix += v.notes + v.am * amortF(v, t1) * hr; }
      if (!c.vintage) pFix = 0;

      // full-year rows (actuals + projected part)
      const a = k => (A ? A[k] : 0);
      const rev = revFY, cor = corP + a('cost_of_revenue'), opex = opexP + a('opex_ex_da_sbc');
      const sbc = sbcP + a('sbc'), da = daP + a('da'), interest = s.intP + a('interest');
      const ebitda = rev - cor - opex, ebit = ebitda - sbc - da, other = a('other_income');
      const pretax = ebit - interest + other;
      const preA = A ? A.revenue - A.cost_of_revenue - A.opex_ex_da_sbc - A.sbc - A.da - A.interest + A.other_income : 0;
      const taxA = A ? (A.tax !== null ? A.tax : tax * Math.max(0, preA)) : 0;
      const taxFY = s.taxP + taxA, ni = pretax - taxFY;
      const sharesOpen = shares;
      shares = shares * (1 + dil * f) + newSh + sbcShares + stockSh;
      const sharesAvg = (sharesOpen + shares) / 2;
      const ocf = s.ocfP + a('ocf'), capex = capexP + capexL + a('capex');
      const cashOpen = cash;
      cash = cashOpen + s.ocfP - capexP - capexL - repay + issueCash + (s.D - s.short) + eqRaised;
      deficit = Math.max(0, minCash - cash);
      newDebt += s.Du;
      const pool = c.vintage || c.newAmort > 0 ? poolClose : newDebt;
      dbt[NEW_DEBT_ID][i] = pool;
      rbt[NEW_DEBT_ID][i] = pool + s.Du > 0 ? (c.vintage || c.newAmort > 0 ? (poolOpen + pool > 0 ? s.intNew / ((poolOpen + pool) / 2 * f) * 100 : null) : newRate[i] * 100) : null;
      ppe = ppe + capexP + capexL + stockA - daP;
      if (eq !== null) eq = eq + s.niP + sbcP + eqRaised + issueEq + stockA;
      let cTot = 0, cOpen = 0;
      for (let k = 0; k < cBal.length; k++) { cTot += cBal[k]; cOpen += cBal[k] - s.draws[k] + cRep[k]; }
      const debtEnd = debtClose + cTot + pool, netDebt = debtEnd - cash, secured = secClose + cSec + pool * c.securedPct;
      const avgDebt = (debtOpen + debtClose) / 2 + (cOpen + cTot) / 2 + (c.vintage || c.newAmort > 0 ? (poolOpen + pool) / 2 : (newDebt - s.Du + newDebt) / 2);
      fundCum += s.gap; uncCum += s.Du + eqRaised;
      let cLeftOpen = 0;
      for (let k = 0; k < cLeft.length; k++) if (c.committed[k].until > t1) cLeftOpen += cLeft[k];

      const put = (j, v) => { RA[j][i] = v; };
      put(RI.revenue, rev); put(RI.revenue_growth, div(rev - prevRev, prevRev) === null ? null : (rev / prevRev - 1) * 100);
      put(RI.cost_of_revenue, cor); put(RI.gross_profit, rev - cor); put(RI.gross_margin, div(rev - cor, rev) === null ? null : (rev - cor) / rev * 100);
      put(RI.opex, opex); put(RI.ebitda, ebitda); put(RI.ebitda_margin, div(ebitda, rev) === null ? null : ebitda / rev * 100);
      put(RI.sbc, sbc); put(RI.da, da); put(RI.adj_op_income, ebitda - da); put(RI.ebit, ebit); put(RI.interest, interest); put(RI.other_income, other);
      put(RI.interest_noncash, s.nonCash); put(RI.shortfall_interest, s.intSh);
      put(RI.interest_actual, a('interest')); put(RI.pretax, pretax); put(RI.tax, taxFY); put(RI.net_income, ni);
      put(RI.shares_avg, sharesAvg); put(RI.eps, div(ni, sharesAvg)); put(RI.shares_end, shares);
      put(RI.ocf, ocf); put(RI.capex, capex); put(RI.fcf, ocf - capex); put(RI.ocf_proj, s.ocfP); put(RI.capex_proj, capexP + capexL);
      put(RI.revenue_proj, revP);
      put(RI.funding_gap, s.gap); put(RI.new_debt, s.D - s.short); put(RI.committed_draws, cDraw); put(RI.uncommitted_debt, s.Du);
      put(RI.new_equity_m, eqRaised); put(RI.new_shares, newSh + stockSh); put(RI.sbc_shares, sbcShares);
      put(RI.funding_cum, fundCum); put(RI.uncommitted_cum, uncCum); put(RI.committed_left, cLeftOpen);
      put(RI.gross_borrowing, s.D - s.short + refi); put(RI.funding_shortfall, s.short); put(RI.new_debt_repaid, newRepay);
      put(RI.repayments, repay); put(RI.refinanced, refi); put(RI.issued, issued); put(RI.cash_open, cashOpen); put(RI.cash_end, cash);
      put(RI.liquidity, cash + cLeftOpen);
      put(RI.debt_end, debtEnd); put(RI.secured_debt, secured); put(RI.net_debt, netDebt);
      put(RI.net_debt_ebitda, ebitda > 0 ? netDebt / ebitda : null); put(RI.gross_debt_ebitda, ebitda > 0 ? debtEnd / ebitda : null);
      put(RI.secured_debt_ebitda, ebitda > 0 ? secured / ebitda : null);
      // the exit run-rate: the last quarter's adj. EBITDA x 4 (a growth-path spec: the full year)
      const exitRate = cap ? (OP.revQ4[i] - OP.corQ4[i] - OP.revQ4[i] * opexPct[i] / 100) * 4 : ebitda;
      put(RI.revenue_q4, cap ? OP.revQ4[i] : null); put(RI.cost_of_revenue_q4, cap ? OP.corQ4[i] : null);
      put(RI.ebitda_exit_rate, exitRate); put(RI.gross_debt_ebitda_lqa, exitRate > 0 ? debtEnd / exitRate : null); put(RI.secured_debt_ebitda_lqa, exitRate > 0 ? secured / exitRate : null);
      put(RI.interest_cover, interest > 0 ? ebitda / interest : null); put(RI.ebit_cover, interest > 0 ? ebit / interest : null);
      put(RI.ebitda_capex_cover, interest > 0 ? (ebitda - capex) / interest : null);
      put(RI.interest_to_ebitda, ebitda > 0 ? interest / ebitda * 100 : null);
      put(RI.sofr, c.hasRates ? sofrAvg[i] : null); put(RI.new_debt_rate, newRate[i] * 100);
      put(RI.avg_cost_of_debt, avgDebt > 0 ? s.intP / (avgDebt * f) * 100 : null);
      put(RI.da_existing, daEx); put(RI.da_new, daNew); put(RI.net_ppe, ppe); put(RI.book_equity, eq); put(RI.proj_frac, f); put(RI.capacity_mult, mult[i]);
      // fixed vs floating (after swaps); the penalty on an unfunded gap counts as new floating
      put(RI.debt_fixed, dFix); put(RI.debt_floating, dFlt); put(RI.debt_new_fixed, dNF + pFix); put(RI.debt_new_floating, dNV + pool - pFix);
      put(RI.hedged_notional, hedged); put(RI.floating_share_of_debt, debtEnd > 0 ? (dFlt + dNV + pool - pFix) / debtEnd * 100 : null);
      put(RI.interest_fixed, iFix); put(RI.interest_floating, iFlt); put(RI.interest_new, iNF + iNV); put(RI.interest_new_fixed, iNF); put(RI.interest_new_floating, iNV);
      put(RI.floating_share_of_interest, s.intP > 0 ? (iFlt + iNV) / s.intP * 100 : null);
      // EBITDA -> free cash flow (customer prepayments incl. the reported months' deferred revenue)
      const cashInt = s.intP - s.nonCash + a('interest'), wcp = wc * (revFY - prevRev) * f + (A && isNum(A.prepayments) ? A.prepayments : 0);
      put(RI.cash_interest, cashInt); put(RI.cash_tax, taxFY); put(RI.wc_prepay, wcp);
      put(RI.other_cash, ocf - capex - (ebitda - cashInt - taxFY - capex + wcp));
      put(RI.fcf_pre_growth, cap ? ocf - RA[RI.capex_maintenance][i] - (A ? c.rm.maint * A.revenue : 0) : null);
      prevPath = pathFY; prevRev = rev;
    }

    // capacity rows: from the operating model, plus revenue-based ratios and the backlog
    const custRev = {}, custShare = {}, ltShare = {};
    if (cap) {
      const Rm = c.rm, A = c.stub ? c.stub.a : null;
      for (let i = 0; i < n; i++) {
        const rev = RA[RI.revenue][i], am = RA[RI.active_mw_avg][i];
        RA[RI.revenue_per_mw][i] = am > 0 ? rev / am : null;
        RA[RI.cor_per_mw_eff][i] = am > 0 ? RA[RI.cost_of_revenue][i] / am : null;
        if (i === 0 && A) {                      // the actual months: rent at its share of actual cost of revenue
          RA[RI.rent][0] += A.cost_of_revenue * Rm.rentShare; RA[RI.power_cost][0] += A.cost_of_revenue * Rm.powerShare;
          const own0 = Rm.sb ? Rm.sb.open : 0, aMonths = c.stub.months;
          RA[RI.rent_per_mw][0] = am - own0 > 0 ? RA[RI.rent][0] / ((am - own0) * (aMonths + c.P[0].M) / 12) : null;
        }
        if (Rm.contractY) {
          const k = Rm.contractY[i];
          RA[RI.contracted_revenue][i] = k; RA[RI.uncontracted_revenue][i] = uI(Rm) >= 0 ? OP.revC[uI(Rm)][i] : Math.max(0, rev - k);
          RA[RI.backlog_coverage][i] = rev > 0 ? k / rev * 100 : null;
          if (opts.lean) continue;
          if (rev < k * (1 - 0.005)) warnings.push(`FY${Y[i]}: modelled revenue ${Math.round(rev).toLocaleString('en-US')} is below the ${Math.round(k).toLocaleString('en-US')} already contracted (delivery slips, cuts or funding)`);
          else if (rev > 0 && k / rev < Rm.backlog.covWarn) warnings.push(`FY${Y[i]}: only ${Math.round(k / rev * 100)}% of modelled revenue is contracted (new contracts and renewals carry the rest)`);
        } else for (const k of ['contracted_revenue', 'uncontracted_revenue', 'backlog_coverage']) RA[RI[k]][i] = null;
      }
      // customers: contracted revenue by customer (+ the reported months at its share), the
      // uncontracted pool, the backstop; concentration of revenue and of contracted revenue
      const crev = (x, ci) => OP.revC[ci].map((v, i) => v + (i === 0 && A ? A.revenue * x.sh[0] : 0));
      const top = new Array(n).fill(null), topK = new Array(n).fill(null);
      Rm.customers.forEach((x, ci) => {
        const r = crev(x, ci);
        if (!opts.lean) { custRev[x.id] = r; custShare[x.id] = r.map((v, i) => (RA[RI.revenue][i] > 0 ? v / RA[RI.revenue][i] * 100 : null)); }
        if (x.aggregate) return;
        for (let i = 0; i < n; i++) {
          const rv = RA[RI.revenue][i], kv = RA[RI.revenue][i] - OP.revC[uI(Rm)][i];
          if (rv > 0) top[i] = top[i] === null ? r[i] / rv * 100 : Math.max(top[i], r[i] / rv * 100);
          if (kv > 0) topK[i] = topK[i] === null ? r[i] / kv * 100 : Math.max(topK[i], r[i] / kv * 100);
        }
      });
      RA[RI.top_customer_share] = top; RA[RI.top_contracted_share] = topK;
      if (!opts.lean) Rm.customers.forEach(x => {                    // look-through: direct + via other customers
        for (const [ti, w] of x.lt) {
          const tid = Rm.customers[ti].id;
          if (!ltShare[tid]) ltShare[tid] = custRev[tid].slice();
          for (let i = 0; i < n; i++) ltShare[tid][i] += custRev[x.id][i] * w;
        }
      });
      for (const k of Object.keys(ltShare)) ltShare[k] = ltShare[k].map((v, i) => (RA[RI.revenue][i] > 0 ? v / RA[RI.revenue][i] * 100 : null));
      if (!opts.lean) {
        if (OP.flags.delayCapped) warnings.push(`capacity: delays add up to more than ${Rm.maxDelay} months; capped (revenue_model.max_delay_months)`);
        if (OP.flags.floored) warnings.push('capacity: the MW cut is limited to capacity no signed contract needs (cancel contracts with an event)');
      }
    }

    // valuation: exit multiple x the cost-of-capital and economic-life adjustments x the exit
    // EBITDA (the exit year's, or its run-rate on the fleet in place at the balance-sheet date)
    const V = c.val, xi = Y.indexOf(V.exitYear);
    const bi = V.bi;                             // balance sheet at the last year-end <= valuation date (net_debt_at "exit")
    const rowAt = (k, i) => RA[RI[k]][i];
    // run-rate EBITDA of the fleet in place at year-end b, at year x's per-MW economics
    const fleetEbitda = (x, b) => {
      const rev = rowAt('revenue', x), bill = rowAt('billing_mw_avg', x), act = rowAt('active_mw_avg', x), u = rowAt('utilization_avg', x);
      const aEnd = b < 0 ? (cap ? c.rm.opening.active_mw : null) : rowAt('active_mw_end', b);
      if (!cap || !(bill > 0) || !(act > 0) || !isNum(aEnd) || !isNum(u)) return null;
      const revF = rev * aEnd * u / 100 / bill, corF = rowAt('cost_of_revenue', x) * aEnd / act, opexF = rev > 0 ? rowAt('opex', x) * revF / rev : 0;
      return { ebitda: revF - corF - opexF, revenue: revF, mw: aEnd };
    };
    const wacc0 = V.link ? V.link.w * newRates(c, P, {}, null).rates[xi] * 100 + (1 - V.link.w) * c.byId.get('discount_rate').base : null;
    const waccAt = j => (V.link ? V.link.w * newRate[j] * 100 + (1 - V.link.w) * g('discount_rate') : null);
    const rateAdj = j => (V.link ? Math.max(0.5, wacc0 - V.link.g) / Math.max(0.5, waccAt(j) - V.link.g) : 1);
    const adj = rateAdj(xi), wacc = waccAt(xi);
    const ffx = fleetEbitda(xi, bi), fwdE = RA[RI.ebitda][xi];
    const runRate = V.basis === 'run_rate' && ffx !== null;
    const exitEbitda = runRate ? ffx.ebitda : fwdE;
    // run-off: the fleet in place at the valuation date earns to its contract end, renews (at the
    // year's renewal price change) until its economic life, then stops; no growth, no residual
    const econLife = has('economic_life') ? g('economic_life') : lifeAt(Math.max(0, yearsBetween(c.dOpen === null ? V.vd : c.dOpen, V.vd)));
    let runoff = null;
    if (cap && ffx !== null && bi >= 0) {
      const Rm = c.rm, Ae = OP.Ae, vm = Y[bi] * 12 + 12, w = (wacc0 !== null ? wacc0 : g('discount_rate')) / 100;
      const q = Math.pow(1 + w, -1 / 12), Sa = a => (a > 0 ? q * (1 - Math.pow(q, a)) / (1 - q) : 0);
      // renewals at the last year's price change; the share that does not re-sign (churn) earns nothing
      const e = ffx.ebitda / ffx.mw, rv = ffx.revenue / ffx.mw, rr = (rowAt('renewal_price_change', n - 1) || 0) / 100, mt = Rm.maint;
      const lastM = Y[n - 1] * 12 + 12, chL = clamp(Rm.churn[n - 1] + E.churn.reduce((s2, x) => s2 + (lastM >= x[0] && lastM < x[2] ? x[1] / 100 : 0), 0), 0, 1);
      let ev = 0;
      for (let m = Rm.g0 + 1; m <= vm; m++) {
        const dMW = Ae[m - Rm.g0] - Ae[m - 1 - Rm.g0];
        if (!(dMW > 0)) continue;
        // the take-or-pay contract pays to its end whatever the GPU is worth; the economic life only
        // bounds the renewals after it
        const a1 = Math.max(0, m + Math.round(Rm.term * 12) - vm), a2 = Math.max(a1, m + Math.round(econLife * 12) - vm);
        ev += dMW * ((e - mt * rv) / 12 * Sa(a1) + (1 - chL) * (e + rv * rr - mt * rv * (1 + rr)) / 12 * (Sa(a2) - Sa(a1)));
      }
      runoff = { ev, ratio: ffx.ebitda > 0 ? ev / ffx.ebitda : null, econ_life: econLife, renewal_price_change: rr * 100, renewal_churn: chL * 100, wacc: w * 100 };
    }
    const lifeAdj = V.lifeLink && !opts.noLink && runoff && isNum(runoff.ratio) && isNum(c.val.ratio0) && c.val.ratio0 > 0 ? Math.max(0.2, runoff.ratio / c.val.ratio0) : 1;
    const mEff = g('exit_ev_ebitda') * adj * lifeAdj, exitEv = mEff * exitEbitda;
    const exitNd = bi < 0 ? nd0 : RA[RI.net_debt][bi], exitSh = bi < 0 ? c.opening.shares : RA[RI.shares_end][bi];
    // convertibles still outstanding at a valuation date: net shares above the capped-call cap
    const perShare = (eqV, sh, vd) => {
      const tv = c.dOpen === null ? null : yearsBetween(c.dOpen, vd);
      const convs = c.debt.filter(t => t.conv && tv !== null && t.ti <= tv && t.tm > tv);
      const dilAt = px => convs.reduce((s2, t) => s2 + (px > t.conv.cap ? t.bal0 / t.conv.px * (px - t.conv.cap) / px : 0), 0);
      let ps = sh > 0 ? Math.max(0, eqV) / sh : null, convSh = 0;
      if (ps !== null && ps > 0 && convs.length && dilAt(ps) > 0) {
        let lo = 0, hi = ps;                   // px x (shares + dilution(px)) = equity, increasing in px
        for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (mid * (sh + dilAt(mid)) > eqV) hi = mid; else lo = mid; }
        ps = (lo + hi) / 2; convSh = dilAt(ps);
      }
      const yrs = Math.max(0, yearsBetween(V.asof, vd)), pv = Math.pow(1 + g('discount_rate') / 100, yrs);
      return { exitPs: ps, convSh, yrs, pv, vps: ps === null ? null : ps / pv };
    };
    const exitEq = exitEv - exitNd, ps0 = perShare(exitEq, exitSh, V.vd), exitPs = ps0.exitPs, vps = ps0.vps;
    if (exitEq <= 0) warnings.push('valuation: exit equity <= 0 (debt exceeds enterprise value); value floored at 0');
    // cross-checks: the other EBITDA basis; an exit at the last model year-end (sees the interest
    // and the fixed / floating mix to then); the run-off value of the fleet in place
    const altE = runRate ? fwdE : ffx !== null ? ffx.ebitda : null;
    const lastI = n - 1, ffL = fleetEbitda(lastI, lastI), vdL = Date.UTC(Y[lastI], 11, 31);
    const lastEv = ffL !== null ? g('exit_ev_ebitda') * rateAdj(lastI) * lifeAdj * ffL.ebitda : g('exit_ev_ebitda') * rateAdj(lastI) * lifeAdj * RA[RI.ebitda][lastI];
    const xv = {
      value_forward_basis: altE === null ? null : perShare(mEff * (runRate ? altE : fwdE) - exitNd, exitSh, V.vd).vps,
      value_last_year_exit: perShare(lastEv - RA[RI.net_debt][lastI], RA[RI.shares_end][lastI], vdL).vps,
      value_runoff: runoff ? perShare(runoff.ev - exitNd, exitSh, V.vd).vps : null,
    };
    if (runRate) xv.value_forward_basis = perShare(mEff * fwdE - exitNd, exitSh, V.vd).vps;
    const valuation = {
      exit_year: V.exitYear, valuation_date: V.vdStr, balance_sheet_year: bi < 0 ? null : Y[bi], ebitda_basis: runRate ? 'run_rate' : 'forward',
      exit_ebitda: exitEbitda, exit_ebitda_forward: fwdE, exit_ebitda_run_rate: ffx ? ffx.ebitda : null, fleet_mw: ffx ? ffx.mw : null,
      exit_multiple: g('exit_ev_ebitda'), rate_adjustment: adj, life_adjustment: lifeAdj, exit_multiple_eff: mEff,
      wacc_base: wacc0, wacc: wacc, new_debt_rate_exit: newRate[xi] * 100,
      exit_ev: exitEv, exit_net_debt: exitNd, exit_equity: exitEq, exit_shares: exitSh, conv_shares: ps0.convSh,
      exit_value_per_share: exitPs, years_to_valuation: ps0.yrs, discount_factor: 1 / ps0.pv,
      value_per_share: vps, share_price: price > 0 ? price : null,
      upside_pct: vps !== null && price > 0 ? (vps / price - 1) * 100 : null,
      market_cap: null, ev_now: null, net_debt_now: nd0,
      runoff: runoff ? { ev: runoff.ev, ev_ebitda: runoff.ratio, economic_life: runoff.econ_life, renewal_price_change: runoff.renewal_price_change, renewal_churn: runoff.renewal_churn, discount_rate: runoff.wacc } : null,
      last_year_exit: { year: Y[lastI], ev: lastEv, ebitda: ffL ? ffL.ebitda : RA[RI.ebitda][lastI], net_debt: RA[RI.net_debt][lastI], shares: RA[RI.shares_end][lastI], multiple_eff: g('exit_ev_ebitda') * rateAdj(lastI) * lifeAdj },
    };
    Object.assign(valuation, xv);
    const covenants = opts.lean ? [] : c.covenants.map(k => {
      const values = RA[RI[k.metric]].slice();
      // a leverage ratio with EBITDA <= 0 (null) and debt outstanding is a breach
      const breach = values.map((x, i) => (x === null ? (k.max !== null && RA[RI.debt_end][i] > 0 ? true : null)
        : (k.max !== null && x > k.max) || (k.min !== null && x < k.min)));
      const fb = breach.findIndex(b => b === true);
      if (fb >= 0) warnings.push(`${k.kind === 'threshold' ? 'threshold' : 'covenant'} ${k.label}: crossed in FY${Y[fb]}`);
      return { id: k.id, label: k.label, metric: k.metric, kind: k.kind, max: k.max, min: k.min, src: k.src, values, breach, first_breach: fb >= 0 ? Y[fb] : null };
    });
    let minLiq = null, minLiqY = null;
    RA[RI.liquidity].forEach((x, i) => { if (minLiq === null || x < minLiq) { minLiq = x; minLiqY = Y[i]; } });
    const maps = { interest_by_tranche: ibt, rate_by_tranche: rbt, debt_by_tranche: dbt, revenue_by_customer: custRev, customer_share: custShare, lookthrough_share: ltShare };
    const out = { years: Y.slice(), ra: RA, maps, valuation, covenants, liquidity: { min: minLiq, year: minLiqY }, events_on: evs.map(e => e.id), warnings, overrides: Object.assign({}, ov),
      _ov: ov, _lifeAt: lifeAt, _price: price, _q: cap ? OP.q : null };
    if (!opts.lean || opts.multiples) {
      // forward multiples: EV of year t from the balance sheet at the end of t - 1
      const mcap = price > 0 ? price * c.opening.shares : null, evNow = mcap === null ? null : mcap + nd0;
      const shPrev = i => (i ? RA[RI.shares_end][i - 1] : c.opening.shares), ndPrev = i => (i ? RA[RI.net_debt][i - 1] : nd0);
      const multiples = px => {
        const ev = Y.map((_, i) => (px === null ? null : px * shPrev(i) + ndPrev(i)));
        return {
          ev, ev_sales: RA[RI.revenue].map((r, i) => (ev[i] === null ? null : div(ev[i], r))),
          ev_ebitda: RA[RI.ebitda].map((e, i) => (ev[i] === null || !(e > 0) ? null : ev[i] / e)),
          ev_ebit: RA[RI.ebit].map((e, i) => (ev[i] === null || !(e > 0) ? null : ev[i] / e)),
          pe: RA[RI.eps].map(e => (px === null || !(e > 0) ? null : px / e)),
          fcf_yield: RA[RI.fcf].map((fc, i) => (px === null || !(px > 0) ? null : fc / (px * shPrev(i)) * 100)),
        };
      };
      const atPx = multiples(price > 0 ? price : null);
      for (const k of ['ev_sales', 'ev_ebitda', 'ev_ebit', 'pe', 'fcf_yield']) RA[RI[k]] = atPx[k];
      RA[RI.ev_at_price] = atPx.ev;
      RA[RI.ev_ebitda_static] = RA[RI.ebitda].map(e => (evNow === null || !(e > 0) ? null : evNow / e));
      const atVal = multiples(exitPs !== null && exitPs > 0 ? exitPs : null);
      Object.assign(valuation, { market_cap: mcap, ev_now: evNow, implied_fwd_multiples_at_price: atPx, implied_multiples_at_value: atVal });
    }
    return out;
  }
  const uI = Rm => Rm.customers.findIndex(x => x.computed);
  // The full result (project): checks, the watch list, unit economics, named rows.
  function finishRun(c, out) {
    const Y = c.years, RA = out.ra, valuation = out.valuation;
    out.checks = c.checks.map(k => {
      const v = metricOf({ years: Y, ra: RA, valuation }, k.metric, k.year);
      return { label: k.label, metric: k.metric, year: k.year, value: v, lo: k.lo, hi: k.hi, src: k.src,
        pass: v === null ? null : (k.lo === null || v >= k.lo) && (k.hi === null || v <= k.hi) };
    });
    const { customer_share: custShare, lookthrough_share: ltShare } = out.maps;
    out.watchlist = c.watch.map(w => {
      const values = w.metric === null ? Y.map(() => null) : (w.map ? ((w.map === 'customer_share' ? custShare : ltShare)[w.key] || Y.map(() => null)) : RA[RI[w.metric]]).slice();
      const crossed = values.map(x => (x === null || w.threshold === null ? null : w.direction === 'above' ? x > w.threshold : x < w.threshold));
      const fc = crossed.findIndex(b => b === true);
      return { id: w.id, label: w.label, metric: w.metric, modelled: w.modelled, unit: w.unit, dp: w.dp, threshold: w.threshold, direction: w.direction, signal: w.signal,
        latest: w.latest, informs: w.informs, note: w.note, src: w.src, values, crossed, first_cross: fc >= 0 ? Y[fc] : null };
    });
    out.unit_economics = c.mode === 'capacity' ? unitEconomics(c, out) : null;
    // the projected calendar quarters of a capacity model (complete quarters only): adj. EBITDA at
    // the year's operating-cost ratio
    out.quarters = (out._q || []).filter(q => q.months === 3).map(q => {
      const op = RA[RI.revenue_proj][q.i] > 0 ? (RA[RI.opex][q.i] - (q.i === 0 && c.stub ? c.stub.a.opex_ex_da_sbc : 0)) / RA[RI.revenue_proj][q.i] : 0;
      return { quarter: q.quarter, revenue: q.revenue, cost_of_revenue: q.cost_of_revenue, ebitda: q.revenue - q.cost_of_revenue - op * q.revenue,
        billing_mw_avg: q.billing / 3, active_mw_end: q.active_mw_end, revenue_per_billing_mw: q.billing > 0 ? q.revenue / (q.billing / 12) : null };
    });
    // named rows (+ the per-tranche / per-customer maps), in the v1 key order of the result
    const rows = {};
    ROW_NAMES.forEach((k, j) => { rows[k] = RA[j]; });
    return { years: out.years, rows: Object.assign(rows, out.maps), valuation, checks: out.checks, covenants: out.covenants, warnings: out.warnings, overrides: out.overrides,
      liquidity: out.liquidity, events_on: out.events_on, watchlist: out.watchlist, unit_economics: out.unit_economics, quarters: out.quarters };
  }
  // A megawatt energised in the exit year, on that year's economics: what its first contract earns
  // against its capex and the interest on debt that funds it, then what renewals add until its
  // economic life. Payback and IRRs are unlevered, before tax.
  function unitEconomics(c, out) {
    const RA = out.ra, Y = c.years, xi = Y.indexOf(c.val.exitYear), n = Y.length, Rm = c.rm;
    const r = k => RA[RI[k]][xi];
    const price = r('list_price_per_billing_mw'), u = r('utilization_avg') / 100, cost = r('cor_per_mw_eff'), cpx = r('capex_per_mw_eff');
    if (![price, u, cost, cpx].every(isNum)) return null;
    const ov = out._ov, has = id => c.byId.has(id);
    const life = has('economic_life') ? val(c, ov, 'economic_life') : out._lifeAt(P0end(c, xi));
    const R = price * u, opx = r('revenue') > 0 ? r('opex') / r('revenue') : 0, O = opx * R, mt = Rm.maint * R;
    const e = R - cost - O, term = Rm.term, lagY = Rm.lag / 12, rr = (RA[RI.renewal_price_change][n - 1] || 0) / 100;
    const rd = r('new_debt_rate') / 100, eR = R * (1 + rr) - cost - O * (1 + rr), mR = mt * (1 + rr);
    // yearly cash flows: year 1 bills after the fit-out lag
    const flows = [];
    for (let t = 1; t <= Math.ceil(Math.max(term, life)); t++) {
      const inLife = Math.max(0, Math.min(1, life - (t - 1)));
      if (!(inLife > 0)) break;
      const contract = t <= term, billF = t === 1 ? Math.max(0, 1 - lagY) : 1;
      flows.push(inLife * (contract ? (R * billF - cost - O * billF - mt * billF) : (eR - mR)));
    }
    const npv = (rate, cf) => cf.reduce((s, x, t) => s + x / Math.pow(1 + rate, t + 1), -cpx);
    const irr = cf => { let lo = -0.99, hi = 1; if (npv(lo, cf) < 0) return null; for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (npv(mid, cf) > 0) lo = mid; else hi = mid; } return (lo + hi) / 2; };
    let cum = 0, pay = null;
    flows.forEach((x, t) => { if (pay === null && cum + x >= cpx) pay = t + (cpx - cum) / x; cum += x; });
    const contractE = R * (term - lagY) - cost * term - O * (term - lagY), interest = cpx * rd * term / 2;
    return { year: c.val.exitYear, price, utilization: u * 100, revenue_per_mw: R, cost_per_mw: cost, opex_per_mw: O, ebitda_per_mw: e, capex_per_mw: cpx,
      maintenance_per_mw: mt, contract_years: term, economic_life: life, renewal_price_change: rr * 100, billing_lag_months: Rm.lag,
      contract_ebitda: contractE, contract_maintenance: mt * (term - lagY), contract_interest: interest, contract_cash_after_debt: contractE - mt * (term - lagY) - cpx - interest,
      renewal_years: Math.max(0, life - term), renewal_ebitda: Math.max(0, life - term) * (eR - mR),
      payback_years: pay, irr_project: irr(flows), irr_contract: irr(flows.slice(0, Math.ceil(term))),
      new_debt_rate: rd * 100, wacc: out.valuation.wacc };
  }
  const P0end = (c, i) => c.P[i].t1;

  // Deep pass: anything non-finite becomes null (the "finite or null" contract).
  function scrub(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (Array.isArray(x)) return x.map(scrub);
    if (isObj(x)) { const o = {}; for (const k of Object.keys(x)) o[k] = scrub(x[k]); return o; }
    return x;
  }
  // +100bp of SOFR (from shift_from), re-projected: per year Δ interest, of which floating debt
  // resetting (existing + new floating) and fixed debt issued at the higher rate
  function addExposure(c, ov, evs, r) {
    const U = run(c, Object.assign({}, ov, { sofr_shift: val(c, ov, 'sofr_shift') + 100 }), evs, LEAN), R0 = r.rows;
    const up = k => U.ra[RI[k]];
    for (let i = 0; i < r.years.length; i++) {
      R0.rate_exposure_100bp[i] = up('interest')[i] - R0.interest[i];
      R0.rate_exposure_reset[i] = up('interest_floating')[i] + up('interest_new_floating')[i] - R0.interest_floating[i] - R0.interest_new_floating[i];
      R0.rate_exposure_issuance[i] = up('interest_fixed')[i] + up('interest_new_fixed')[i] - R0.interest_fixed[i] - R0.interest_new_fixed[i];
    }
  }

  // opts: {events: {id: 0|1} | [ids], exposure: false skips the +100bp re-projection}
  function project(spec, overrides, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; '), errors: c.errors, warnings: c.warnings };
    try {
      opts = isObj(opts) ? opts : {};
      const w = c.warnings.slice();
      const ov = cleanOverrides(c, overrides, w);
      const evs = cleanEvents(c, opts.events, w);
      const r = run(c, ov, evs, FULL);
      if (opts.exposure !== false) addExposure(c, ov, evs, r);
      else for (const k of ['rate_exposure_100bp', 'rate_exposure_reset', 'rate_exposure_issuance']) r.rows[k] = r.years.map(() => null);
      r.warnings = w.concat(r.warnings);
      return scrub(r);
    } catch (e) {
      return { error: 'model: ' + String(e && e.message || e).slice(0, 200), warnings: c.warnings };
    }
  }

  // ---- metrics, tornado, grid, breakevens ------------------------------------------------
  // metric: "value_per_share" | "<row>" with year | "<row>@<year>" | {metric, year}
  function parseMetric(m, year) {
    if (isObj(m)) { year = m.year; m = m.metric; }
    if (typeof m !== 'string') return null;
    const at = /^([a-z_0-9]+)@(\d{4})$/.exec(m);
    if (at) return { metric: at[1], year: +at[2] };
    return { metric: m, year: Number.isInteger(year) ? year : null };
  }
  // a row of a result: named (project) or indexed (lean runs)
  const rowOf = (res, k) => (res.ra ? res.ra[RI[k]] : res.rows[k]);
  function metricOf(res, metric, year) {
    if (!res || res.error) return null;
    if (VAL_METRICS.includes(metric)) return fin(res.valuation[metric]);
    if (!ROW_SET.has(metric)) return null;
    const i = res.years.indexOf(year);
    return i < 0 ? null : fin(rowOf(res, metric)[i]);
  }
  function metricValue(res, metric, year) {
    const p = parseMetric(metric, year);
    return p ? metricOf(res, p.metric, p.year) : null;
  }
  // a row metric with no year defaults to the exit year
  function resolveMetric(c, metric, year) {
    const p = parseMetric(metric, year);
    if (!p || !(VAL_METRICS.includes(p.metric) || ROW_SET.has(p.metric))) return null;
    if (!VAL_METRICS.includes(p.metric) && !c.years.includes(p.year)) p.year = c.val.exitYear;
    return p;
  }
  // the events with `e` switched on (its group's others off) / off
  const withEv = (c, base, e) => c.events.filter(x => x === e || (base.includes(x) && !(e.group && x.group === e.group)));
  const withoutEv = (base, e) => base.filter(x => x !== e);

  // Tornado: each driver with a low/high, metric at low and at high holding the rest at the
  // current overrides; then each event off vs on (opts.events = the current event states;
  // opts.include_events false leaves them out); sorted by |swing| (nulls last), ties by order.
  function sensitivity(spec, overrides, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      opts = isObj(opts) ? opts : {};
      const p = resolveMetric(c, opts.metric || 'value_per_share', opts.year);
      if (!p) return { error: 'sensitivity: unknown metric' };
      const ov = cleanOverrides(c, overrides), base0 = cleanEvents(c, opts.events);
      const mult = MULT_ROWS.has(p.metric), opCache = new Map(), pool = rowPool(c);
      const at = (o, evs) => metricOf(run(c, o, evs || base0, RO(true, mult, o === ov ? opCache : null, pool)), p.metric, p.year);
      const base = at(ov);
      const bars = [];
      c.drivers.forEach((d, idx) => {
        if (!isNum(d.low) || !isNum(d.high)) return;
        const lo = at(Object.assign({}, ov, { [d.id]: d.low })), hi = at(Object.assign({}, ov, { [d.id]: d.high }));
        const swing = lo === null || hi === null ? null : Math.abs(hi - lo);
        bars.push({ id: d.id, type: 'driver', label: d.label, group: d.group, unit: d.unit, low: d.low, high: d.high,
          current: val(c, ov, d.id), v_low: lo, v_high: hi, swing, _i: idx });
      });
      if (opts.include_events !== false) c.events.forEach((e, j) => {
        const isOn = base0.includes(e);
        const off = isOn ? at(ov, withoutEv(base0, e)) : base, on = isOn ? base : at(ov, withEv(c, base0, e));
        const pr = isObj(opts.probs) && own(opts.probs, e.id) && isNum(opts.probs[e.id]) ? clamp(opts.probs[e.id], 0, 1) : e.prob;
        bars.push({ id: e.id, type: 'event', label: e.label, short_label: e.short_label, kind: e.kind, group: e.kind === 'risk' ? 'Risks' : e.kind === 'strategic' ? 'Strategic' : 'Upsides', event_group: e.group,
          unit: 'event', low: 0, high: 1, current: isOn ? 1 : 0, prob: pr, v_low: off, v_high: on,
          swing: off === null || on === null ? null : Math.abs(on - off), _i: c.drivers.length + j });
      });
      bars.sort((a, b) => (a.swing === null) - (b.swing === null) || (b.swing || 0) - (a.swing || 0) || a._i - b._i);
      for (const b of bars) delete b._i;
      return scrub({ metric: p.metric, year: VAL_METRICS.includes(p.metric) ? null : p.year, base, bars });
    } catch (e) {
      return { error: 'sensitivity: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  // 2-D table: z[yi][xi] = metric with xDriver = xValues[xi], yDriver = yValues[yi].
  function grid(spec, overrides, xDriver, xValues, yDriver, yValues, metric, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      const dx = c.byId.get(xDriver), dy = c.byId.get(yDriver);
      if (!dx || !dy) return { error: 'grid: unknown driver' };
      const p = resolveMetric(c, metric || 'value_per_share');
      if (!p) return { error: 'grid: unknown metric' };
      const vals = (d, a) => (Array.isArray(a) ? a : []).filter(isNum).slice(0, MAX_GRID).map(v => clamp(v, d.min, d.max));
      const xs = vals(dx, xValues), ys = vals(dy, yValues);
      if (!xs.length || !ys.length) return { error: 'grid: no finite axis values' };
      const ov = cleanOverrides(c, overrides), evs = cleanEvents(c, isObj(opts) ? opts.events : null), pool = rowPool(c);
      const z = ys.map(yv => xs.map(xv => {
        const o = Object.assign({}, ov, { [yDriver]: yv });
        o[xDriver] = xv;                                // x wins when both axes are one driver
        return metricOf(run(c, o, evs, RO(true, MULT_ROWS.has(p.metric), null, pool)), p.metric, p.year);
      }));
      return { metric: p.metric, year: VAL_METRICS.includes(p.metric) ? null : p.year,
        x: { id: xDriver, label: dx.label, unit: dx.unit, values: xs }, y: { id: yDriver, label: dy.label, unit: dy.unit, values: ys }, z };
    } catch (e) {
      return { error: 'grid: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  // Breakeven: the value of one driver (others as set) at which `metric` reaches `target`.
  // A fixed scan of the driver's range finds the crossings; the one nearest the current
  // setting is bisected. {value: null, found: false} when the metric never reaches it.
  function solve(spec, overrides, driverId, metric, target, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      const d = c.byId.get(driverId);
      if (!d || d.kind === 'choice') return { error: 'solve: unknown driver' };
      const p = resolveMetric(c, metric);
      if (!p || !isNum(target)) return { error: 'solve: unknown metric or target' };
      opts = isObj(opts) ? opts : {};
      const ov = cleanOverrides(c, overrides), cur = val(c, ov, d.id), evs = cleanEvents(c, opts.events), pool = rowPool(c);
      const lo = clamp(num(opts.lo, d.min), d.min, d.max), hi = clamp(num(opts.hi, d.max), d.min, d.max);
      const n = clamp(Math.round(num(opts.steps, 16)), 4, 60);
      const at = x => { const v = metricOf(run(c, Object.assign({}, ov, { [d.id]: x }), evs, RO(true, MULT_ROWS.has(p.metric), null, pool)), p.metric, p.year); return v === null ? null : v - target; };
      const xs = [];
      for (let k = 0; k <= n; k++) xs.push(lo + (hi - lo) * k / n);
      if (cur > lo && cur < hi) xs.push(cur);
      xs.sort((a, b) => a - b);
      const fx = xs.map(at);
      const out = { driver: d.id, metric: p.metric, year: VAL_METRICS.includes(p.metric) ? null : p.year, target, current: cur,
        at_current: (v => (v === null ? null : v + target))(at(cur)), value: null, found: false };
      let best = null;
      for (let k = 1; k < xs.length; k++) {
        const a = fx[k - 1], b = fx[k];
        if (a === null || b === null) continue;
        if (a === 0 || (a < 0) !== (b < 0)) {
          const dist = Math.min(Math.abs(xs[k - 1] - cur), Math.abs(xs[k] - cur));
          if (!best || dist < best.dist) best = { k, dist };
        }
      }
      if (!best) return out;
      let x0 = xs[best.k - 1], x1 = xs[best.k], f0 = fx[best.k - 1];
      if (f0 === 0) return Object.assign(out, { value: x0, found: true });
      const tol = num(opts.tol, d.step / 1000) > 0 ? num(opts.tol, d.step / 1000) : d.step / 1000;
      for (let k = 0; k < 40 && Math.abs(x1 - x0) > tol; k++) {
        const mid = (x0 + x1) / 2, fm = at(mid);
        if (fm === null) break;
        if ((fm < 0) === (f0 < 0)) { x0 = mid; f0 = fm; } else x1 = mid;
      }
      return Object.assign(out, { value: (x0 + x1) / 2, found: true });
    } catch (e) {
      return { error: 'solve: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  // ---- events: impact of one, and the probability distribution over all -----------------
  const IMPACT_ROWS = ['revenue', 'ebitda', 'net_income', 'fcf', 'interest', 'capex', 'uncommitted_cum', 'net_debt_ebitda', 'interest_to_ebitda', 'active_mw_end',
    'funding_shortfall', 'liquidity', 'mw_deferred'];
  // Δ when one event is on vs off (the other events as in opts.events; its group's others off).
  function eventImpact(spec, overrides, id, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      opts = isObj(opts) ? opts : {};
      const e = typeof id === 'string' ? c.evById.get(id) : null;
      if (!e) return { error: 'eventImpact: unknown event' };
      const ov = cleanOverrides(c, overrides), base = cleanEvents(c, opts.events);
      const rOff = run(c, ov, withoutEv(base, e), LEAN_M), rOn = run(c, ov, withEv(c, base, e), LEAN_M);
      const keys = IMPACT_ROWS.concat((Array.isArray(opts.rows) ? opts.rows : []).filter(k => ROW_SET.has(k) && !IMPACT_ROWS.includes(k)).slice(0, 20));
      const rows = {};
      for (const k of keys) {
        const a = rowOf(rOff, k), b = rowOf(rOn, k);
        rows[k] = { off: a.slice(), on: b.slice(), delta: b.map((v, i) => (v === null || a[i] === null ? null : v - a[i])) };
      }
      const vOff = fin(rOff.valuation.value_per_share), vOn = fin(rOn.valuation.value_per_share);
      return scrub({ id: e.id, label: e.label, kind: e.kind, prob: e.prob, group: e.group, from: e.from_str, until: e.until_str, years: c.years.slice(),
        value_per_share: { off: vOff, on: vOn, delta: vOff === null || vOn === null ? null : vOn - vOff }, rows,
        events_off: withoutEv(base, e).map(x => x.id), events_on: withEv(c, base, e).map(x => x.id) });
    } catch (err) {
      return { error: 'eventImpact: ' + String(err && err.message || err).slice(0, 200) };
    }
  }
  function mulberry32(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  // weighted stats of [{v, w}] (v non-null): mean, P10/P50/P90 (lower weighted quantiles), histogram
  function wstats(xs, bins) {
    const tot = sum(xs.map(x => x.w));
    if (!xs.length || !(tot > 0)) return { mean: null, p10: null, p50: null, p90: null, min: null, max: null, sd: null, hist: { edges: [], probs: [] } };
    const s = xs.slice().sort((a, b) => a.v - b.v);
    const q = p => { let cum = 0; for (const x of s) { cum += x.w; if (cum >= p * tot - 1e-12) return x.v; } return s[s.length - 1].v; };
    const mean = sum(s.map(x => x.v * x.w)) / tot, sd = Math.sqrt(Math.max(0, sum(s.map(x => (x.v - mean) * (x.v - mean) * x.w)) / tot));
    const lo = s[0].v, hi = s[s.length - 1].v, nb = hi > lo ? bins : 1, wd = (hi - lo) / nb;
    const edges = Array.from({ length: nb + 1 }, (_, k) => (k === nb ? hi : lo + wd * k)), probs = new Array(nb).fill(0);
    for (const x of s) probs[nb > 1 ? Math.min(nb - 1, Math.floor((x.v - lo) / wd)) : 0] += x.w / tot;
    return { mean, p10: q(0.1), p50: q(0.5), p90: q(0.9), min: lo, max: hi, sd, hist: { edges, probs } };
  }
  // Common factor and driver uncertainty for the distribution. spec.regimes {states: [{id, name,
  // p, lift: {event: factor}, drivers: {driver: mode}}]}: in a regime an event's probability is its
  // catalogue probability x lift / Σ p x lift (so its marginal stays the catalogue's), capped at 1;
  // a regime's drivers set the mode of that driver's draw. spec.uncertainty {drivers: [ids]}: each
  // draw takes these drivers from a triangular distribution over their stress range (low, mode =
  // the base or the regime's, high).
  function compileDist(c, spec, warnings) {
    if (c._dist) return c._dist;
    const RG = isObj(spec.regimes) && Array.isArray(spec.regimes.states) ? spec.regimes.states.slice(0, 6) : [];
    const regimes = [];
    for (const x of RG) {
      if (!isObj(x) || typeof x.id !== 'string' || !ID_RE.test(x.id) || !isNum(x.p) || x.p < 0 || regimes.some(y => y.id === x.id)) { warnings.push('regimes: skipped a state without a valid id and p'); continue; }
      const lift = {}, dm = {};
      if (isObj(x.lift)) for (const k of Object.keys(x.lift)) { if (c.evById.has(k) && isNum(x.lift[k]) && x.lift[k] >= 0) lift[k] = x.lift[k]; else warnings.push(`regimes ${x.id}: lift ${String(k).slice(0, 40)} is not an event with a factor >= 0; ignored`); }
      if (isObj(x.drivers)) for (const k of Object.keys(x.drivers)) {
        const d = c.byId.get(k);
        if (d && d.kind !== 'choice' && isNum(x.drivers[k])) dm[k] = clamp(x.drivers[k], d.min, d.max); else warnings.push(`regimes ${x.id}: driver ${String(k).slice(0, 40)} unknown; ignored`);
      }
      regimes.push({ id: x.id, name: str(x.name, 80) || x.id, p: x.p, lift, dm });
    }
    const tp = sum(regimes.map(r => r.p));
    if (regimes.length && Math.abs(tp - 1) > 1e-6) { warnings.push(`regimes: probabilities sum to ${tp.toFixed(3)}; scaled to 1`); for (const r of regimes) r.p /= tp || 1; }
    const U = isObj(spec.uncertainty) && Array.isArray(spec.uncertainty.drivers) ? spec.uncertainty.drivers.slice(0, 12) : [];
    const unc = [];
    for (const id of U) {
      const d = typeof id === 'string' ? c.byId.get(id) : null;
      if (!d || d.kind === 'choice' || !isNum(d.low) || !isNum(d.high) || unc.includes(id)) { warnings.push(`uncertainty: ${String(id).slice(0, 40)} is not a driver with a stress range; ignored`); continue; }
      unc.push(id);
    }
    for (const r of regimes) for (const k of Object.keys(r.dm)) if (!unc.includes(k)) unc.push(k);
    c._dist = { regimes, unc, note: isObj(spec.regimes) ? str(spec.regimes.note, 900) : '' };
    return c._dist;
  }
  // draws from triangular(lo, mode, hi) by inversion
  const tri = (u, lo, md, hi) => {
    if (!(hi > lo)) return lo;
    const m = clamp(md, lo, hi), f = (m - lo) / (hi - lo);
    return u < f ? lo + Math.sqrt(u * (hi - lo) * (m - lo)) : hi - Math.sqrt((1 - u) * (hi - lo) * (hi - m));
  };
  // outcomes per (spec, overrides) survive across calls, so a probability edit only evaluates the
  // states it changes
  const OUT_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;
  function outcomeCache(spec, key) {
    if (!OUT_CACHE || !isObj(spec)) return new Map();
    let m = OUT_CACHE.get(spec);
    if (!m) { m = new Map(); OUT_CACHE.set(spec, m); }
    if (!m.has(key)) { if (m.size >= 6) m.delete(m.keys().next().value); m.set(key, new Map()); }
    return m.get(key);
  }
  // Probability distribution over the event catalogue (drivers as set; regimes and driver
  // uncertainty when the spec has them): every joint state of the mutually exclusive groups and
  // independent events, weighted by its probability, when there are at most 4,096 and no driver
  // is drawn; else seeded Monte Carlo draws. opts: {probs: {id: p}, metrics: [...], draws, seed,
  // bins, funding_threshold (US$m of cumulative uncommitted need; default the no-event value),
  // monte_carlo: true forces sampling}. distributionJob runs it in slices (step(ms) -> done).
  function distributionJob(spec, overrides, opts) {
    const c = compile(spec);
    if (!c.ok) { const e = { error: c.errors.join('; ') }; return { step: () => true, progress: () => 1, result: () => e }; }
    const fail = err => { const e = { error: 'distribution: ' + String(err && err.message || err).slice(0, 200) }; return { step: () => true, progress: () => 1, result: () => e }; };
    try {
      opts = isObj(opts) ? opts : {};
      const warnings = [];
      const ov = cleanOverrides(c, overrides);
      const DS = compileDist(c, spec, warnings);
      const PR = isObj(opts.probs) ? opts.probs : {};
      const probs = c.events.map(e => (own(PR, e.id) && isNum(PR[e.id]) ? clamp(PR[e.id], 0, 1) : e.prob));
      const allNI = c.years.filter(y => !(c.stub && y === c.years[0])).map(y => `net_income@${y}`);
      const ms = (Array.isArray(opts.metrics) && opts.metrics.length ? opts.metrics : ['value_per_share'].concat(allNI)).slice(0, 12)
        .map(m => { const p = resolveMetric(c, m); return p ? Object.assign(p, { key: VAL_METRICS.includes(p.metric) ? p.metric : `${p.metric}@${p.year}` }) : null; })
        .filter(Boolean);
      if (!ms.length) return fail('unknown metric');
      const bins = clamp(Math.round(num(opts.bins, 20)), 2, 60);
      const RGs = DS.regimes.length ? DS.regimes : [{ id: 'all', name: 'All', p: 1, lift: {}, dm: {} }];
      // factors: one per group (state 0 = none of its events) and one per independent event; per
      // regime the conditional probabilities of each state
      const cond = (j, r) => {
        const e = c.events[j], l = own(r.lift, e.id) ? r.lift[e.id] : 1;
        const den = sum(RGs.map(x => x.p * (own(x.lift, e.id) ? x.lift[e.id] : 1)));
        return den > 0 ? probs[j] * l / den : probs[j];
      };
      const factors = [], seenG = new Set();
      let capped = false;
      c.events.forEach((e, j) => {
        if (e.group && seenG.has(e.group)) return;
        const mem = e.group ? c.evGroups.get(e.group) : [j];
        if (e.group) seenG.add(e.group);
        const pr = RGs.map(r => {
          let ps = mem.map(k => cond(k, r));
          if (ps.some(x => x > 1)) { capped = true; ps = ps.map(x => Math.min(1, x)); }
          const t = sum(ps);
          if (t > 1 + 1e-9) { ps = ps.map(x => x / t); if (e.group) warnings.push(`group ${e.group}${DS.regimes.length ? ` (regime ${r.id})` : ''}: probabilities scaled to sum to 1`); }
          return [Math.max(0, 1 - sum(ps))].concat(ps);
        });
        factors.push({ mem, pr });
      });
      if (capped) warnings.push('regimes: an event\'s probability in a regime was capped at 1, so its marginal is below the catalogue\'s');
      const nStates = factors.reduce((s, f) => s * f.pr[0].length, 1);
      const drawn = DS.unc.length > 0;
      const exact = nStates <= EXACT_MAX && opts.monte_carlo !== true && !drawn;
      const cov = c.covenants.filter(k => k.kind === 'covenant'), from = c.stub ? 1 : 0;
      const needMult = ms.some(m => MULT_ROWS.has(m.metric)), opCache = new Map(), pool = rowPool(c);
      const base = run(c, ov, [], LEAN);
      const funding = isNum(opts.funding_threshold) ? opts.funding_threshold : fin(rowOf(base, 'uncommitted_cum')[c.years.length - 1]);
      const cache = outcomeCache(spec, JSON.stringify([ov, ms.map(m => m.key), funding]));
      const evalState = (idx, dv, key) => {
        if (cache.has(key)) return cache.get(key);
        const evs = [];
        idx.forEach((s, fi) => { if (s > 0) evs.push(c.events[factors[fi].mem[s - 1]]); });
        evs.sort((a, b) => a.idx - b.idx);
        const o2 = dv ? Object.assign({}, ov, dv) : ov;
        const r = run(c, o2, evs, RO(true, needMult, dv ? null : opCache, pool));
        const n = c.years.length, debtEnd = rowOf(r, 'debt_end');
        const breach = cov.some(k => rowOf(r, k.metric).some((x, i) => i >= from && (x === null ? k.max !== null && debtEnd[i] > 0 : (k.max !== null && x > k.max) || (k.min !== null && x < k.min))));
        const o = { vals: ms.map(m => metricOf(r, m.metric, m.year)), breach, liqNeg: r.liquidity.min !== null && r.liquidity.min < 0,
          need: funding !== null && rowOf(r, 'uncommitted_cum')[n - 1] > funding + 1e-6 };
        cache.set(key, o);
        return o;
      };
      const samples = [], onP = c.events.map(() => 0), regP = RGs.map(() => 0), regV = RGs.map(() => 0);
      let draws = 0, seed = null, k = 0, total = exact ? nStates : 0, evaluated = 0;
      const take = (idx, w, ri, dv, key) => {
        const before = cache.size, o = evalState(idx, dv, key);
        if (cache.size > before) evaluated++;
        samples.push({ o, w, ri });
        idx.forEach((s, fi) => { if (s > 0) onP[factors[fi].mem[s - 1]] += w; });
        regP[ri] += w; if (o.vals[0] !== null) regV[ri] += w * o.vals[0];
      };
      let idxE = factors.map(() => 0), rnd = null, drawU = null;
      if (!exact) {
        draws = clamp(Math.round(num(opts.draws, MC_DRAWS)), 100, 20000); seed = Math.round(num(opts.seed, MC_SEED)); total = draws;
        rnd = mulberry32(seed);
        // one fixed block of uniforms per draw (regime, factors, drivers): an edited probability moves
        // only the draws near its threshold
        const per = 1 + factors.length + DS.unc.length;
        drawU = () => { const u = new Array(per); for (let q = 0; q < per; q++) u[q] = rnd(); return u; };
      }
      const pickR = u => { let cum = 0; for (let r = 0; r < RGs.length; r++) { cum += RGs[r].p; if (u < cum) return r; } return RGs.length - 1; };
      const stepFn = budget => {
        const t0 = Date.now();
        while (k < total) {
          if (exact) {
            // the state's weight mixes the regimes (no regime moves a driver here)
            let w = 0;
            for (let r = 0; r < RGs.length; r++) { let x = RGs[r].p; for (let fi = 0; fi < factors.length; fi++) x *= factors[fi].pr[r][idxE[fi]]; w += x; }
            if (w > 0) {
              // attribute to the regime most likely to produce it (for the per-regime means)
              let best = 0, bw = -1;
              for (let r = 0; r < RGs.length; r++) { let x = RGs[r].p; for (let fi = 0; fi < factors.length; fi++) x *= factors[fi].pr[r][idxE[fi]]; if (x > bw) { bw = x; best = r; } }
              take(idxE.slice(), w, best, null, idxE.join(','));
            }
            for (let fi = 0; fi < factors.length; fi++) { if (++idxE[fi] < factors[fi].pr[0].length) break; idxE[fi] = 0; }
          } else {
            const u = drawU(), ri = pickR(u[0]), R = RGs[ri];
            const idx = factors.map((f, fi) => { let cum = 0; for (let s = 0; s < f.pr[ri].length; s++) { cum += f.pr[ri][s]; if (u[1 + fi] < cum) return s; } return 0; });
            let dv = null;
            if (drawn) {
              dv = {};
              DS.unc.forEach((id, q) => {
                const d = c.byId.get(id), md = own(R.dm, id) ? R.dm[id] : val(c, ov, id);
                dv[id] = isNum(d.low) && isNum(d.high) ? tri(u[1 + factors.length + q], Math.min(d.low, md), md, Math.max(d.high, md)) : md;
              });
            }
            take(idx, 1 / draws, ri, dv, drawn ? `${k}|${ri}|${idx.join(',')}` : idx.join(','));
          }
          k++;
          if (Date.now() - t0 > budget) return k >= total;
        }
        return true;
      };
      let res = null;
      const result = () => {
        if (res) return res;
        if (k < total) stepFn(Infinity);
        const tot = sum(samples.map(x => x.w));
        const metrics = {};
        ms.forEach((m, j) => {
          const xs = samples.filter(x => x.o.vals[j] !== null).map(x => ({ v: x.o.vals[j], w: x.w }));
          metrics[m.key] = Object.assign({ metric: m.metric, year: VAL_METRICS.includes(m.metric) ? null : m.year, base: metricOf(base, m.metric, m.year),
            p_null: tot > 0 ? 1 - sum(xs.map(x => x.w)) / tot : null }, wstats(xs, bins));
        });
        const pr = f => (tot > 0 ? sum(samples.filter(x => f(x.o)).map(x => x.w)) / tot : null);
        // the representative presets: their value, percentile, and the share of outcomes nearer to
        // them than to any other preset
        const vi = ms.findIndex(m => m.metric === 'value_per_share');
        const presets = vi < 0 ? [] : c.scenarios.filter(s => s.representative).map(s => {
          const r = run(c, Object.assign({}, cleanOverrides(c, s.values)), cleanEvents(c, s.events), LEAN);
          return { id: s.id, name: s.name, value: fin(r.valuation.value_per_share) };
        }).filter(p => p.value !== null);
        if (presets.length && vi >= 0) {
          const xs = samples.filter(x => x.o.vals[vi] !== null);
          for (const p of presets) { p.percentile = tot > 0 ? sum(xs.filter(x => x.o.vals[vi] <= p.value + 1e-9).map(x => x.w)) / tot * 100 : null; p.mass = 0; }
          for (const x of xs) {
            let b = 0;
            for (let q = 1; q < presets.length; q++) if (Math.abs(x.o.vals[vi] - presets[q].value) < Math.abs(x.o.vals[vi] - presets[b].value)) b = q;
            presets[b].mass += x.w / (tot || 1);
          }
        }
        res = scrub({ method: exact ? 'exact' : 'monte_carlo', states: nStates, evaluated, draws: exact ? null : draws, seed,
          total_prob: tot, metrics, p_covenant_breach: pr(o => o.breach), covenant_from_year: c.years[from], p_liquidity_negative: pr(o => o.liqNeg),
          funding_threshold: funding, p_funding_need_above: funding === null ? null : pr(o => o.need),
          regimes: DS.regimes.length ? RGs.map((r, ri) => ({ id: r.id, name: r.name, p: r.p, mean: regP[ri] > 0 ? regV[ri] / regP[ri] : null, drivers: Object.assign({}, r.dm) })) : [],
          uncertainty: DS.unc.slice(), presets, note: DS.note,
          events: c.events.map((e, j) => ({ id: e.id, prob: probs[j], p_on: tot > 0 ? onP[j] / tot : null })), warnings });
        return res;
      };
      return { step: b => { try { return stepFn(isNum(b) ? b : Infinity); } catch (err) { res = { error: 'distribution: ' + String(err && err.message || err).slice(0, 200) }; k = total; return true; } },
        progress: () => (total > 0 ? k / total : 1), result: () => { try { return result(); } catch (err) { return { error: 'distribution: ' + String(err && err.message || err).slice(0, 200) }; } } };
    } catch (err) {
      return fail(err);
    }
  }
  function distribution(spec, overrides, opts) {
    const j = distributionJob(spec, overrides, opts);
    j.step(Infinity);
    return j.result();
  }

  // ---- scenarios + state codec -----------------------------------------------------------
  // Scenario values on top of `baseOverrides` (default: none, i.e. every other driver at base).
  function applyScenario(spec, id, baseOverrides) {
    const c = compile(spec);
    if (!c.ok) return null;
    const s = c.scenarios.find(x => x.id === id);
    if (!s) return null;
    return Object.assign(cleanOverrides(c, baseOverrides), cleanOverrides(c, s.values));
  }
  // The scenario as {overrides, events: {id: 1}} — its drivers and the business events it assumes.
  function scenarioState(spec, id, baseOverrides) {
    const c = compile(spec);
    if (!c.ok) return null;
    const s = c.scenarios.find(x => x.id === id);
    if (!s) return null;
    return { overrides: Object.assign(cleanOverrides(c, baseOverrides), cleanOverrides(c, s.values)), events: evMap(cleanEvents(c, s.events)) };
  }
  // id of the scenario the overrides (and event states) equal (drivers not named = base), else null
  function matchScenario(spec, overrides, events) {
    const c = compile(spec);
    if (!c.ok) return null;
    const ov = cleanOverrides(c, overrides), on = cleanEvents(c, events).map(e => e.id).join(',');
    for (const s of c.scenarios) {
      const sv = cleanOverrides(c, s.values);
      if (c.drivers.every(d => Math.abs(val(c, ov, d.id) - val(c, sv, d.id)) < 1e-9) && (!c.events.length || s.events.join(',') === on)) return s.id;
    }
    return null;
  }
  // Probability-weighted value per share over the scenarios that carry a `prob`. The viewer's
  // own edits (current minus the anchor scenario they started from; default base) are laid on
  // top of every scenario, so a hand-moved driver carries into the weighted view; so do the
  // events the viewer switched relative to the anchor (opts.events).
  function weighted(spec, overrides, anchorId, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      const ov = cleanOverrides(c, overrides);
      const an = c.scenarios.find(x => x.id === anchorId) || c.scenarios.find(x => x.id === 'base');
      const av = an ? cleanOverrides(c, an.values) : {};
      const cur = new Set(cleanEvents(c, isObj(opts) ? opts.events : null).map(e => e.id)), anc = new Set(an ? an.events : []);
      const flip = new Set(c.events.map(e => e.id).filter(id => cur.has(id) !== anc.has(id)));
      const rows = [];
      for (const s of c.scenarios.filter(x => x.prob !== null && x.prob > 0)) {
        const sv = cleanOverrides(c, s.values), o = {};
        for (const d of c.drivers) {
          const delta = val(c, ov, d.id) - val(c, av, d.id);
          o[d.id] = d.kind === 'choice' ? (Math.abs(delta) > 1e-9 ? val(c, ov, d.id) : val(c, sv, d.id)) : clamp(val(c, sv, d.id) + delta, d.min, d.max);
        }
        // the scenario's events with the viewer's switches; an event switched on displaces its group
        const st = new Set(s.events);
        for (const id of flip) { if (cur.has(id)) { const e = c.evById.get(id); for (const x of c.events) if (e.group && x.group === e.group) st.delete(x.id); st.add(id); } else st.delete(id); }
        const r = run(c, o, cleanEvents(c, Array.from(st)), LEAN);
        const row = { id: s.id, name: s.name, prob: s.prob, value: fin(r.valuation.value_per_share) };
        if (c.events.length) row.events = r.events_on.slice();
        rows.push(row);
      }
      const tot = sum(rows.map(r => r.prob));
      const ok = rows.length && tot > 0 && rows.every(r => r.value !== null);
      return { value: ok ? sum(rows.map(r => r.prob * r.value)) / tot : null, total_prob: tot, anchor: an ? an.id : null, rows };
    } catch (e) {
      return { error: 'weighted: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  const b64e = s => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = s => {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    return typeof Buffer !== 'undefined' ? Buffer.from(b, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))));
  };
  // Compact base64url of the non-default overrides ('' when everything is at base). A choice
  // driver travels as its choice id, so a link survives a reordering of the paths. state:
  // {events: {id: 1}, probs: {id: p}} adds the events on ("e") and edited probabilities ("p").
  function encodeState(spec, overrides, state) {
    const c = compile(spec);
    if (!c.ok) return '';
    const ov = cleanOverrides(c, overrides), o = {};
    for (const d of c.drivers) if (own(ov, d.id) && Math.abs(ov[d.id] - d.base) > 1e-12)
      o[d.id] = d.kind === 'choice' ? d.choices[ov[d.id]].id : +ov[d.id].toPrecision(10);
    const st = isObj(state) ? state : {};
    const e = cleanEvents(c, st.events).map(x => x.id), pr = {};
    if (isObj(st.probs)) for (const x of c.events) if (own(st.probs, x.id) && isNum(st.probs[x.id]) && Math.abs(clamp(st.probs[x.id], 0, 1) - x.prob) > 1e-9)
      pr[x.id] = +clamp(st.probs[x.id], 0, 1).toPrecision(6);
    // view state (how the Risks tab counts events, the headline year): carried, never modelled
    const vw = {};
    if (isObj(st.view)) {
      if (['base', 'weighted', 'custom'].includes(st.view.mode) && st.view.mode !== 'base') vw.m = st.view.mode;
      if (Number.isInteger(st.view.year) && c.years.includes(st.view.year)) vw.y = st.view.year;
    }
    if (!Object.keys(o).length && !e.length && !Object.keys(pr).length && !Object.keys(vw).length) return '';
    const payload = { v: VERSION, m: c.slug, o };
    if (e.length) payload.e = e;
    if (Object.keys(pr).length) payload.p = pr;
    if (Object.keys(vw).length) payload.w = vw;
    return b64e(JSON.stringify(payload));
  }
  // Validates everything: charset, length, JSON shape, slug, known ids, finite numbers;
  // values clamp to range. Bad entries are dropped and reported, never applied.
  function decodeState(spec, s) {
    const c = compile(spec);
    if (!c.ok) return { ok: false, overrides: {}, events: {}, probs: {}, errors: ['spec: invalid'] };
    if (s === '' || s === null || s === undefined) return { ok: true, overrides: {}, events: {}, probs: {}, errors: [] };
    try {
      if (typeof s !== 'string' || s.length > MAX_STATE_LEN || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad');
      const j = JSON.parse(b64d(s));
      if (!isObj(j) || j.v !== VERSION || !isObj(j.o)) throw new Error('bad');
      if (j.m !== c.slug) return { ok: false, overrides: {}, events: {}, probs: {}, errors: ['state: link is for a different model'] };
      const errors = [], keys = Object.keys(j.o).slice(0, 64);
      const raw = {};
      for (const k of keys) {
        const d = c.byId.get(k);
        if (!d) { errors.push(`state: unknown driver ${String(k).slice(0, 40)}`); continue; }
        if (!isNum(j.o[k]) && !(d.kind === 'choice' && typeof j.o[k] === 'string')) { errors.push(`state: ${k} is not a number`); continue; }
        raw[k] = j.o[k];
      }
      const w = [];
      const overrides = cleanOverrides(c, raw, w);
      const ev = Array.isArray(j.e) ? j.e.slice(0, 64).filter(x => typeof x === 'string') : [];
      if (j.e !== undefined && !Array.isArray(j.e)) errors.push('state: events must be a list');
      const events = evMap(cleanEvents(c, ev, w)), probs = {};
      if (isObj(j.p)) for (const k of Object.keys(j.p).slice(0, 64)) {
        const e = c.evById.get(k);
        if (!e) { errors.push(`state: unknown event ${String(k).slice(0, 40)}`); continue; }
        if (!isNum(j.p[k])) { errors.push(`state: probability of ${k} is not a number`); continue; }
        probs[k] = clamp(j.p[k], 0, 1);
      }
      const view = {};
      if (isObj(j.w)) {
        if (['weighted', 'custom'].includes(j.w.m)) view.mode = j.w.m;
        if (Number.isInteger(j.w.y) && c.years.includes(j.w.y)) view.year = j.w.y;
      }
      return { ok: true, overrides, events, probs, view, errors: errors.concat(w) };
    } catch (e) {
      return { ok: false, overrides: {}, events: {}, probs: {}, errors: ['state: not a valid model link'] };
    }
  }

  // ---- metadata + formatting -------------------------------------------------------------
  function validateSpec(spec) {
    const c = compile(spec);
    return { ok: c.ok, errors: c.errors.slice(), warnings: c.warnings.slice() };
  }
  // Normalized drivers (template merged with spec) for building the sliders.
  function drivers(spec) {
    const c = compile(spec);
    if (!c.ok) return [];
    return c.drivers.map(d => scrub(Object.assign({}, d, { path: d.path ? d.path.slice() : undefined,
      choices: d.choices ? d.choices.map(x => Object.assign({}, x)) : undefined })));
  }
  function defaults(spec) {
    const out = {};
    for (const d of drivers(spec)) out[d.id] = d.base;
    return out;
  }
  // The rate paths the rate_path driver chooses between, as per-year arrays (for charts).
  function ratePaths(spec) {
    const c = compile(spec);
    if (!c.ok) return [];
    return c.choices.filter(x => x.arr).map(x => ({ id: x.id, name: x.name, path: x.arr.slice() }));
  }
  // The event catalogue (normalized) and its mutually exclusive groups.
  function events(spec) {
    const c = compile(spec);
    if (!c.ok) return { events: [], groups: [] };
    const imp = I => {
      const o = {};
      for (const k of Object.keys(I)) {
        if (k === 'customer_cut') o[k] = I[k].map(x => ({ customer: c.rm.customers[x.ci].id, pct: x.pct, from: monthStr(x.from), idle_months: x.idle, relet_pct: x.relet === null ? null : x.relet * 100 }));
        else if (k === 'capacity_released') o[k] = I[k].map(x => ({ mw: x.mw, from: monthStr(x.from), to: monthStr(x.to), idle_months: x.idle, relet_pct: x.relet === null ? null : x.relet * 100 }));
        else if (IMPACTS[k].type === 'year_map') { o[k] = {}; c.years.forEach((y, i) => { if (I[k][i] !== null) o[k][String(y)] = I[k][i]; }); }
        else o[k] = I[k];
      }
      return o;
    };
    return { events: c.events.map(e => ({ id: e.id, kind: e.kind, label: e.label, short_label: e.short_label || null, mechanism: e.mechanism, prob: e.prob, prob_note: e.prob_note,
      from: e.from_str, until: e.until_str, group: e.group, impacts: imp(e.imp), indicators: e.indicators.slice(), src: e.src.slice() })),
    groups: Array.from(c.evGroups.entries()).map(([id, mem]) => ({ id, events: mem.map(j => c.events[j].id), prob_total: sum(mem.map(j => c.events[j].prob)) })) };
  }
  // The normalized revenue model (capacity_v1) for charts: base monthly MW, sites, customers.
  function revenueModel(spec) {
    const c = compile(spec);
    if (!c.ok || !c.rm) return null;
    const Rm = c.rm, months = [];
    for (let m = Rm.mOpen - 12; m <= Rm.mLast; m++) months.push({ month: monthStr(m), mw: Rm.A[m - Rm.g0] });
    return scrub({ kind: 'capacity_v1', opening: Object.assign({}, Rm.opening), adjust_from: monthStr(Rm.adjFrom), billing_lag_months: Rm.lag,
      capex_lead_months: Rm.lead, base_active_mw: months, year_end_mw: c.years.map(y => Rm.A[y * 12 + 12 - Rm.g0]),
      utilization: Rm.util.slice(), revenue_per_mw: Rm.rpmY.slice(), renewing_share: Rm.renew.slice(), renewal_price_reset: Rm.reset.slice(),
      capex_per_mw: Rm.cpm.slice(), cor_per_mw: Rm.cor.slice(), rent_share: Rm.rentShare, power_share: Rm.powerShare,
      contract_years: Rm.term, delay_capex_ahead: Rm.delayAhead, unsold_capex_share: Rm.unsoldCapex,
      customers: Rm.customers.map(x => ({ id: x.id, name: x.name, aggregate: x.aggregate, computed: !!x.computed, backlog_share: x.backlog_share, share: x.sh.slice(),
        look_through: Object.fromEntries(x.lt.map(([ti, w]) => [Rm.customers[ti].id, w])), src: x.src.slice() })),
      contracted: Rm.contractY ? Rm.contractY.slice() : null,
      backlog: Rm.backlog ? { rpo: Rm.backlog.rpo, as_of: Rm.backlog.asOfStr, buckets: Rm.backlog.buckets.map(b => ({ months: [b.a, b.b], share: b.share })),
        coverage_warn: Rm.backlog.covWarn, src: Rm.backlog.src.slice() } : null,
      backstop: Rm.backstop ? { name: Rm.backstop.name, customer: Rm.backstop.ci >= 0 ? Rm.customers[Rm.backstop.ci].id : null, cap: Rm.backstop.cap,
        until: Rm.backstop.untilStr, coverage: Rm.backstop.coverage, basis: Rm.backstop.all ? 'all' : 'stress', src: Rm.backstop.src.slice() } : null,
      self_build: Rm.sb ? { from: monthStr(Rm.sb.from), capex_per_mw: Rm.sb.capex, life: Rm.sb.life, opex_per_mw: Rm.sb.opex, lead_months: Rm.sb.lead,
        identified: Rm.sb.ident.map(x => ({ name: x.name, mw: x.mw, online: monthStr(x.m) })), beyond_leases: Rm.leaseCap !== null, src: Rm.sb.src.slice() } : null,
      leases: Rm.leases, sites: Rm.sites.map(x => Object.assign({}, x)) });
  }
  // The interest-rate hedges as normalized (rates in %, "path" = SOFR path at the start).
  function hedges(spec) {
    const c = compile(spec);
    if (!c.ok) return [];
    return c.hedges.map(h => ({ id: h.id, name: h.name, type: h.type, tranche: h.tranche, facility: h.facility, ratio: h.ratio, notional: h.notional,
      fixed_rate: h.rate, start: isFinite(h.start) ? monthStr(h.start) : null, maturity: isFinite(h.end) ? monthStr(h.end) : null,
      amortises_with_tranche: h.amortises, estimated: h.estimated, note: h.note, src: h.src.slice() }));
  }
  // The debt stack today: every tranche in the spec (incl. debt issued after the balance-sheet
  // date), with the pay-fixed swaps running at `at` (YYYY-MM; default the spec's asof month)
  // counted as fixed; the annual interest on it at the first year's SOFR (or opts.sofr).
  function debtMix(spec, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    opts = isObj(opts) ? opts : {};
    const at = monthIdx(opts.at) !== null ? monthIdx(opts.at) : monthIdx(spec.asof) !== null ? monthIdx(spec.asof) : c.mOpen;
    const sofr = isNum(opts.sofr) ? opts.sofr : Math.max(0, c.sofr[0]);
    const o = { at: monthStr(at), sofr, fixed: 0, coupon: 0, swapped: 0, floating: 0, interest_fixed: 0, interest_floating: 0, by_tranche: [] };
    for (const t of c.debt) {
      const b = t.bal0;
      if (!(b > 0)) continue;
      if (t.kind === 'fixed') {
        o.fixed += b; o.coupon += b; o.interest_fixed += b * (t.coupon === null ? 0 : t.coupon) / 100;
        o.by_tranche.push({ id: t.id, fixed: b, swapped: 0, floating: 0 }); continue;
      }
      const sp = t.spread / 100;
      let left = b, sw = 0;
      for (const h of t.hedges) {
        if (at < h.start || at >= h.end) continue;
        const amt = Math.min(left, hedgeAmt(h, t, b));
        left -= amt; sw += amt;
        o.interest_fixed += amt * ((h.rate === 'path' ? sofr : h.rate) + sp) / 100;
      }
      o.swapped += sw; o.floating += left; o.interest_floating += left * (sofr + sp) / 100;
      o.by_tranche.push({ id: t.id, fixed: 0, swapped: sw, floating: left });
    }
    o.fixed += o.swapped;
    o.total = o.fixed + o.floating;
    o.floating_share = o.total > 0 ? o.floating / o.total * 100 : null;
    o.interest = o.interest_fixed + o.interest_floating;
    o.interest_floating_share = o.interest > 0 ? o.interest_floating / o.interest * 100 : null;
    o.committed_undrawn = sum(c.committed.map(x => x.amount));
    return scrub(o);
  }
  // Reported profit at different depreciation lives (e.g. the six-year policy vs a three-year
  // economic life): per life, D&A, adj. operating income, EBIT, net income and EPS by year.
  function lifeReadout(spec, overrides, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      opts = isObj(opts) ? opts : {};
      const d = c.byId.get('useful_life'), ov = cleanOverrides(c, overrides), evs = cleanEvents(c, opts.events);
      const lives = (Array.isArray(opts.lives) && opts.lives.length ? opts.lives : [val(c, ov, 'useful_life'), 3]).filter(isNum).slice(0, 6).map(x => clamp(x, d.min, d.max));
      const keys = ['da', 'adj_op_income', 'ebit', 'net_income', 'eps', 'net_ppe'], rows = {};
      for (const k of keys) rows[k] = [];
      const vps = [], vpsE = [], ro = [];
      const econ = c.byId.has('economic_life');
      for (const L of lives) {
        const r = run(c, Object.assign({}, ov, { useful_life: L }), evs, LEAN);
        for (const k of keys) rows[k].push(rowOf(r, k).slice());
        vps.push(fin(r.valuation.value_per_share));
        // the economic reading: the GPUs also earn for only L years (no renewals past it)
        const rE = econ ? run(c, Object.assign({}, ov, { useful_life: L, economic_life: clamp(L, c.byId.get('economic_life').min, c.byId.get('economic_life').max) }), evs, LEAN) : r;
        vpsE.push(fin(rE.valuation.value_per_share)); ro.push(fin(rE.valuation.value_runoff));
      }
      return scrub({ years: c.years.slice(), lives, rows, value_per_share: vps, value_per_share_economic: econ ? vpsE : null, value_runoff_economic: econ ? ro : null });
    } catch (e) {
      return { error: 'lifeReadout: ' + String(e && e.message || e).slice(0, 200) };
    }
  }
  // "12,345" / "4.5%" / "+25 bp" / "7.0x" / "US$61.39" / "1,870 MW"; null -> "—"
  function formatValue(v, unit, dp, signed) {
    if (!isNum(v)) return '—';
    const d = Number.isInteger(dp) ? clamp(dp, 0, 6) : 1;
    const sgn = signed && v > 0 ? '+' : '';
    const n = sgn + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    switch (unit) {
      case '%': return n + '%';
      case 'pp': return n + ' pp';
      case 'bp': return n + ' bp';
      case 'x': return n + 'x';
      case 'yrs': return n + ' yrs';
      case 'months': return n + ' mo';
      case 'MW': return n + ' MW';
      case 'US$': return (v < 0 ? '−US$' : 'US$') + n.replace(/^[-+]/, '');
      case 'US$m': return n + 'm';
      case 'm': return n + 'm';
      default: return n;
    }
  }

  return {
    VERSION, TEMPLATES, NEW_DEBT_ID,
    template: name => (own(TEMPLATES, name) ? TEMPLATES[name] : null),
    validateSpec, drivers, defaults, ratePaths, project, sensitivity, grid, solve, metricValue,
    applyScenario, scenarioState, matchScenario, weighted, encodeState, decodeState, formatValue,
    events, eventImpact, distribution, distributionJob, revenueModel, hedges, lifeReadout, debtMix,
    cleanOverrides: (spec, ov) => { const c = compile(spec); return c.ok ? cleanOverrides(c, ov) : {}; },
  };
});
