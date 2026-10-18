// Model engine — the stress-test / projection core behind a report's {"type":"model"} block
// (dashboard/reports/models/<slug>.json, MODEL SPEC v1, docs/REPORTS.md). It turns a spec
// (stub-year actuals, opening balance sheet, debt tranches, committed facilities, SOFR paths
// and a set of drivers) plus the viewer's slider overrides into a five-year P&L, cash flow,
// debt schedule, covenant tests, forward multiples and an exit-multiple value per share; then
// tornado sensitivities, 2-D grids, breakeven solves, scenarios (and their probability-
// weighted value) and a share-link state codec on top.
//
// Pure: no DOM, no fetch, no deps, never throws (bad input -> {error} / warnings). Every
// number it returns is finite or null. Deterministic: the only iteration (new debt pays
// interest that widens the funding gap it fills) is a fixed-point loop with a fixed cap;
// breakevens are a fixed scan + bisection.
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
//  - Interest per tranche on its time-weighted balance (monthly; equals the average of opening
//    and closing balance while a tranche amortises linearly). Floating = max(0, SOFR +
//    sofr_shift) + spread; fixed = coupon; plus fee_bp of non-cash issue-cost / discount
//    amortisation (P&L only; added back in operating cash flow). Contractual margins never
//    move with spread_shift. Tranches can start later (issued, with issue_cash), amortise
//    straight-line (from amort_start), on an explicit per-year `schedule`, or be bullets;
//    a bullet that matures rolls over into the new-debt rate.
//  - New-debt rate (per year) = new_debt_rate + spread_shift + beta x SOFR move, where the SOFR
//    move is sofr_shift alone, or — when rates.new_debt_ref_year is set — the selected path's
//    gap to the base path's reference-year value plus sofr_shift. rates.shift_from (YYYY-MM)
//    starts both shifts at that month (earlier months are realised). rate_path picks
//    rates.path (0) or one of rates.alt_paths.
//  - Funding gap = max(0, min_cash - (cash + OCF - capex - amortisation + issue cash));
//    equity_funding_share of it is sold at share_price x (1 - issue_discount); the rest is
//    drawn from funding.committed facilities while their windows are open (their own terms),
//    then borrowed into the "new-debt" pool at the new-debt rate (half-year interest in the
//    year raised). Surplus cash repays nothing.
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

  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
  const isNum = x => typeof x === 'number' && isFinite(x);
  const num = (x, d) => (isNum(x) ? x : d);
  const fin = x => (isNum(x) ? x : null);
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const sum = a => a.reduce((s, x) => s + x, 0);
  const div = (a, b) => (isNum(a) && isNum(b) && b !== 0 ? a / b : null);
  const ID_RE = /^[a-z][a-z0-9_]{0,39}$/;          // driver ids (no leading _ : no __proto__)
  const TRANCHE_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;  // kebab tranche ids

  // ---- template: levered_growth_v1 -------------------------------------------------------
  // A capital-intensive grower funded by a debt stack (CoreWeave is the first user). The spec
  // supplies values for these drivers; the template supplies semantics and fallbacks for any
  // field the spec leaves out. low/high = the plausible stress range the tornado uses.
  const GROUPS = ['Revenue', 'Margins', 'Capex & depreciation', 'Financing & rates', 'Dilution', 'Valuation', 'Market'];
  const drv = (id, group, kind, unit, base, min, max, step, low, high, dp, label, help, extra) =>
    Object.assign({ id, group, kind, unit, base, min, max, step, low, high, dp, label, help, required: true }, extra || {});
  const OPT = { required: false };
  const LG_DRIVERS = [
    drv('revenue_growth', 'Revenue', 'shift_pp', 'pp', 0, -40, 40, 1, -10, 5, 1, 'Revenue growth',
      'Shifts every year of the revenue-growth path (FY over FY, fundamental growth) by this many points.'),
    drv('capex_revenue_link', 'Revenue', 'scalar', '%', 0, 0, 100, 10, 0, 100, 0, 'Revenue follows capex',
      'How far revenue tracks the in-service build-out when capex moves off its path: 100% = one-for-one with in-service PP&E, 0% = revenue ignores capex.', OPT),
    drv('cost_of_revenue_pct', 'Margins', 'shift_pp', 'pp', 0, -20, 20, 0.5, -3, 5, 1, 'Cost of revenue',
      'Cost of revenue as % of revenue, excluding D&A. A positive shift squeezes gross margin.'),
    drv('opex_pct', 'Margins', 'shift_pp', 'pp', 0, -15, 15, 0.5, -2, 3, 1, 'Operating costs',
      'Technology & infrastructure, sales & marketing and G&A excluding D&A and SBC, as % of revenue.'),
    drv('sbc_pct', 'Margins', 'scalar', '%', 5, 0, 40, 0.5, 3, 8, 1, 'Stock-based comp',
      'Stock-based compensation as % of revenue: below adjusted EBITDA, a real cost to shareholders.'),
    drv('capex', 'Capex & depreciation', 'scale_pct', '%', 0, -60, 60, 5, -25, 20, 0, 'Capex',
      'Scales the full-year capex path. More capex buys future revenue but must be funded now.'),
    drv('useful_life', 'Capex & depreciation', 'scalar', 'yrs', 6, 2, 10, 0.5, 4, 7, 1, 'Depreciation life',
      'Straight-line life of GPUs and data-centre gear. Shorter = more D&A, lower EBIT; EBITDA unchanged.'),
    drv('in_service_lag', 'Capex & depreciation', 'scalar', 'yrs', 0, 0, 3, 0.05, 0, 1, 2, 'In-service lag',
      'Time from spending capex to the asset entering service and starting to depreciate.', OPT),
    drv('rate_path', 'Financing & rates', 'choice', 'path', 0, 0, 0, 1, null, null, 0, 'Rate path',
      'Which projected SOFR path the model runs on.', OPT),
    drv('sofr_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 500, 25, -100, 200, 0, 'SOFR shift',
      'Parallel shift to the projected SOFR path. Moves floating-rate interest 1:1 and the cost of new debt.'),
    drv('spread_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 800, 25, -100, 300, 0, 'Credit spread shift',
      'Widens (or tightens) the spread on new and refinanced debt. Contractual margins on existing loans do not move.'),
    drv('new_debt_rate', 'Financing & rates', 'scalar', '%', 9, 2, 25, 0.25, 7, 13, 2, 'New-debt rate',
      'All-in cost of new borrowing and of refinancing maturing debt, at the base SOFR path.'),
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
    drv('wc_prepay_pct', 'Revenue', 'scalar', '%', 0, 0, 100, 5, 0, 30, 0, 'Customer prepayments',
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
    sofr: R('SOFR (avg)', '%', 'Debt', 2), new_debt_rate: R('New-debt rate', '%', 'Debt', 2),
    avg_cost_of_debt: R('Avg cost of debt', '%', 'Debt', 2),
    debt_end: R('Total debt', 'US$m', 'Debt', 0), secured_debt: R('Secured debt', 'US$m', 'Debt', 0), cash_end: R('Cash', 'US$m', 'Debt', 0),
    net_debt: R('Net debt', 'US$m', 'Debt', 0), net_debt_ebitda: R('Net debt / EBITDA', 'x', 'Debt', 1),
    gross_debt_ebitda: R('Total debt / EBITDA', 'x', 'Debt', 1), secured_debt_ebitda: R('Secured debt / EBITDA', 'x', 'Debt', 1),
    interest_cover: R('Interest cover (EBITDA/interest)', 'x', 'Debt', 1),
    ebit_cover: R('EBIT / interest', 'x', 'Debt', 2), ebitda_capex_cover: R('(EBITDA − capex) / interest', 'x', 'Debt', 1),
    net_ppe: R('Net PP&E', 'US$m', 'Balance sheet', 0), book_equity: R('Book equity', 'US$m', 'Balance sheet', 0),
    shares_end: R('Shares (year-end)', 'm', 'Balance sheet', 1),
    ev_sales: R('EV / sales (at price)', 'x', 'Multiples', 1), ev_ebitda: R('EV / EBITDA (at price)', 'x', 'Multiples', 1),
    ev_ebit: R('EV / EBIT (at price)', 'x', 'Multiples', 1), ev_ebitda_static: R('Today\'s EV / EBITDA', 'x', 'Multiples', 1),
    pe: R('P/E (at price)', 'x', 'Multiples', 1), fcf_yield: R('FCF yield (at price)', '%', 'Multiples', 1),
  };
  const ROW_NAMES = Object.keys(LG_ROWS).concat(['cash_open', 'ocf_proj', 'capex_proj', 'da_existing', 'da_new',
    'interest_actual', 'interest_new', 'proj_frac', 'capacity_mult', 'ev_at_price']);
  const VAL_METRICS = ['value_per_share', 'upside_pct', 'exit_ev', 'exit_equity', 'exit_net_debt', 'exit_value_per_share', 'exit_multiple_eff'];
  const COV_METRICS = ['net_debt_ebitda', 'gross_debt_ebitda', 'secured_debt_ebitda', 'interest_cover', 'ebit_cover', 'ebitda_capex_cover', 'cash_end'];

  const TEMPLATES = {
    levered_growth_v1: {
      id: 'levered_growth_v1', groups: GROUPS, drivers: LG_DRIVERS, rows: LG_ROWS,
      row_names: ROW_NAMES, valuation_metrics: VAL_METRICS, covenant_metrics: COV_METRICS, new_debt_id: NEW_DEBT_ID,
      // the tornado/grid metrics the UI offers; "<row>" metrics take a year
      metrics: ['value_per_share', 'net_income', 'interest', 'ebitda', 'net_debt_ebitda', 'gross_debt_ebitda', 'fcf', 'eps',
        'interest_cover', 'funding_cum', 'uncommitted_cum'],
    },
  };
  for (const t of Object.values(TEMPLATES)) { t.drivers.forEach(Object.freeze); Object.values(t.rows).forEach(Object.freeze); Object.freeze(t); }

  // ---- spec normalization ----------------------------------------------------------------
  const monthIdx = s => {                          // "YYYY-MM" or "YYYY-MM-DD" -> y*12+m
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(typeof s === 'string' ? s : '');
    if (!m || +m[2] < 1 || +m[2] > 12) return null;
    return (+m[1]) * 12 + (+m[2]);
  };
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

  // Template drivers merged with the spec's values. Returns {list, byId, errors, warnings}.
  function normDrivers(spec, tpl, years, choices, errors, warnings) {
    const specById = new Map();
    for (const d of Array.isArray(spec.drivers) ? spec.drivers : []) {
      if (!isObj(d) || typeof d.id !== 'string' || !ID_RE.test(d.id)) { warnings.push('drivers: skipped an entry without a valid id'); continue; }
      if (specById.has(d.id)) { warnings.push(`drivers: duplicate id ${d.id} (first kept)`); continue; }
      specById.set(d.id, d);
    }
    const known = new Set(tpl.drivers.map(d => d.id));
    for (const id of specById.keys()) if (!known.has(id)) warnings.push(`drivers: ${id} has no meaning in ${tpl.id}; ignored`);
    const list = [], byId = new Map();
    for (const t of tpl.drivers) {
      const s = specById.get(t.id);
      if (!s && t.required) warnings.push(`drivers: ${t.id} missing from spec; template default used`);
      const d = Object.assign({}, t);
      if (s) {
        for (const k of ['label', 'help', 'unit']) if (typeof s[k] === 'string' && s[k]) d[k] = s[k].slice(0, 600);
        if (typeof s.group === 'string' && GROUPS.includes(s.group)) d.group = s.group;
        if (t.kind !== 'choice') for (const k of ['base', 'min', 'max', 'step', 'low', 'high', 'dp']) if (isNum(s[k])) d[k] = s[k];
        if (Array.isArray(s.src)) d.src = s.src.filter(x => typeof x === 'string').slice(0, 20);
        if (s.path !== undefined) d.path_spec = s.path;
        if (isNum(s.stub_weight)) d.stub_weight = clamp(s.stub_weight, 0, 1);
      }
      if (t.kind === 'choice') {                       // an index into `choices` (0 = the base path)
        Object.assign(d, { base: 0, min: 0, max: Math.max(0, choices.length - 1), step: 1, low: null, high: null, dp: 0 });
        d.choices = choices.map(x => ({ id: x.id, name: x.name }));
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
            { tax: fin(a.tax), other_income: num(a.other_income, 0) }) };
          if (mOpen !== null && mOpen !== s.year * 12 + am) warnings.push('stub: opening.date is not the end of the actual months');
        }
      } else if (mOpen !== null && mOpen !== (years[0] - 1) * 12 + 12) warnings.push('opening: date is not the prior year-end');

      // revenue base: FY revenue of the year before the first model year
      let priorRev = isObj(spec.prior) && isNum(spec.prior.revenue) ? spec.prior.revenue : null;
      if (priorRev === null) {
        if (stub && stub.months > 0) { priorRev = stub.a.revenue * 12 / stub.months; warnings.push('prior: revenue missing; annualised stub revenue used as the growth base'); }
        else errors.push('prior: revenue (FY before the first model year) is required');
      }

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

      const { list, byId } = normDrivers(spec, tpl, years, choices, errors, warnings);

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
          secured: !!t.secured, recourse: t.recourse !== false });
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
          until: (until - mOpen) / 12, tm: (mm - mOpen) / 12, secured: !!x.secured });
      }
      const securedPct = clamp(num(FU.new_debt_secured_pct, 0), 0, 100) / 100;

      if (!rp && (debt.some(t => t.kind === 'floating') || committed.some(x => x.kind === 'floating'))) errors.push('rates: path is required with floating debt');
      const beta = isNum(RT.new_debt_sofr_beta) ? clamp(RT.new_debt_sofr_beta, 0, 1) : 1;
      const refI = Number.isInteger(RT.new_debt_ref_year) ? years.indexOf(RT.new_debt_ref_year) : -1;
      if (RT.new_debt_ref_year !== undefined && refI < 0) warnings.push('rates: new_debt_ref_year is not a model year; new-debt rate not linked to the path');
      const shiftFrom = RT.shift_from !== undefined ? monthIdx(RT.shift_from) : null;
      if (RT.shift_from !== undefined && shiftFrom === null) warnings.push('rates: shift_from must be YYYY-MM; shifts apply from the opening date');

      // valuation: exit multiple on exit_year EBITDA, struck at valuation_date, discounted to asof
      const v = isObj(spec.valuation) ? spec.valuation : {};
      const exitYear = years.includes(v.exit_year) ? v.exit_year : years[Math.min(2, years.length - 1)];
      if (v.exit_year !== undefined && v.exit_year !== exitYear) warnings.push('valuation: exit_year outside the model years; clamped');
      let vd = dayMs(v.valuation_date);
      if (vd === null) vd = Date.UTC(exitYear - 1, 11, 31);
      let asof = dayMs(spec.asof);
      if (asof === null) { asof = vd; warnings.push('spec: asof missing; value not discounted'); }
      const ndAt = v.net_debt_at === 'exit_year_end' ? 'exit_year_end' : 'exit';
      const rl = isObj(v.rate_link) && isNum(v.rate_link.debt_weight) && isNum(v.rate_link.growth_pct)
        ? { w: clamp(v.rate_link.debt_weight, 0, 1), g: clamp(v.rate_link.growth_pct, -5, 15) } : null;

      const checks = (Array.isArray(spec.checks) ? spec.checks : []).filter(c => isObj(c) && typeof c.metric === 'string').slice(0, 40)
        .map(c => ({ label: typeof c.label === 'string' ? c.label.slice(0, 200) : c.metric, metric: c.metric,
          year: Number.isInteger(c.year) ? c.year : null, lo: fin(c.lo), hi: fin(c.hi),
          src: Array.isArray(c.src) ? c.src.filter(x => typeof x === 'string').slice(0, 20) : [] }));

      const covenants = (Array.isArray(spec.covenants) ? spec.covenants : [])
        .filter(k => isObj(k) && COV_METRICS.includes(k.metric) && (isNum(k.max) || isNum(k.min))).slice(0, 12)
        .map((k, i) => ({ id: typeof k.id === 'string' && ID_RE.test(k.id) ? k.id : `cov${i}`, label: typeof k.label === 'string' ? k.label.slice(0, 160) : k.metric,
          metric: k.metric, max: fin(k.max), min: fin(k.min), kind: k.kind === 'threshold' ? 'threshold' : 'covenant',
          src: Array.isArray(k.src) ? k.src.filter(x => typeof x === 'string').slice(0, 20) : [] }));

      const scenarios = (Array.isArray(spec.scenarios) ? spec.scenarios : [])
        .filter(s => isObj(s) && typeof s.id === 'string' && ID_RE.test(s.id)).slice(0, 20)
        .map(s => ({ id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 80) : s.id,
          note: typeof s.note === 'string' ? s.note.slice(0, 900) : '', values: isObj(s.values) ? s.values : {},
          prob: isNum(s.prob) && s.prob >= 0 ? Math.min(s.prob, 100) : null }));

      if (errors.length) return { ok: false, errors, warnings };
      return {
        ok: true, errors, warnings, tpl, years, stub, frac0, priorRev, drivers: list, byId, debt, committed, securedPct, beta,
        sofr: rp || years.map(() => 0), hasRates: !!rp, choices, refI, shiftFrom, mOpen, dOpen,
        slug: typeof spec.slug === 'string' ? spec.slug.slice(0, 40) : '',
        opening: { cash: op.cash, shares: op.shares_m, gross, net, cip, equity: num(op.equity, null),
          depBase: isNum(op.dep_base) && op.dep_base >= 0 ? op.dep_base : Math.max(0, gross - cip),
          depRate: isNum(op.dep_rate) && op.dep_rate >= 0 ? op.dep_rate : null,
          depNbv: isNum(op.dep_nbv) && op.dep_nbv >= 0 ? op.dep_nbv : Math.max(0, net - cip),
          cipIn: Math.max(0, num(op.cip_in_service, 0)) },
        val: { exitYear, vd, asof, ndAt, link: rl }, checks, covenants, scenarios,
      };
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
  // Per-year decimal new-debt rate (and the share of each period's months the shifts touch).
  function newRates(c, P, ov) {
    const g = id => val(c, ov, id);
    const path = c.choices[Math.round(g('rate_path'))] && c.choices[Math.round(g('rate_path'))].arr || c.sofr;
    const shPct = g('sofr_shift') / 100, sprSh = g('spread_shift') / 1e4;
    const w = P.map(p => (c.shiftFrom === null ? 1 : Array.from({ length: p.M }, (_, k) => (p.m0 + k >= c.shiftFrom ? 1 : 0)).reduce((a, b) => a + b, 0) / Math.max(1, p.M)));
    const ref = c.refI >= 0 && c.hasRates ? c.sofr[c.refI] : null;
    const rates = P.map((p, i) => Math.max(0, g('new_debt_rate') / 100 + w[i] * sprSh
      + c.beta * (ref === null ? w[i] * shPct : (path[i] + w[i] * shPct) - ref) / 100));
    return { rates, w, path, shPct, sprSh };
  }

  function run(c, ov) {
    const Y = c.years, n = Y.length, warnings = [], P = periods(c);
    const g = id => val(c, ov, id);
    const sw = id => c.byId.get(id).stub_weight;
    const wt = (id, i) => (i === 0 && c.stub ? sw(id) : 1);
    const growth = c.byId.get('revenue_growth').path.map((p, i) => Math.max(-100, p + g('revenue_growth') * wt('revenue_growth', i)));
    const corPct = c.byId.get('cost_of_revenue_pct').path.map((p, i) => Math.max(0, p + g('cost_of_revenue_pct') * wt('cost_of_revenue_pct', i)));
    const opexPct = c.byId.get('opex_pct').path.map((p, i) => Math.max(0, p + g('opex_pct') * wt('opex_pct', i)));
    const capPath = c.byId.get('capex').path;
    const capexFY = capPath.map((p, i) => Math.max(0, p * (1 + g('capex') / 100 * wt('capex', i))));
    const sbcPct = g('sbc_pct') / 100, life = Math.max(0.5, g('useful_life')), tax = g('tax_rate') / 100, minTax = Math.max(0, g('min_tax'));
    const life0 = Math.max(0.5, c.byId.get('useful_life').base), lag = Math.max(0, g('in_service_lag'));
    const link = g('capex_revenue_link') / 100, sbcSh = g('sbc_share_pct') / 100;
    const minCash = g('min_cash'), wc = g('wc_prepay_pct') / 100, dil = g('share_dilution_pct') / 100;
    const price = g('share_price'), issuePx = price * (1 - g('issue_discount') / 100);
    let eShare = g('equity_funding_share') / 100;
    if (eShare > 0 && !(issuePx > 0)) { warnings.push('equity funding needs a share price > 0; gap funded with debt'); eShare = 0; }
    const NR = newRates(c, P, ov), newRate = NR.rates;
    // monthly SOFR (%), floored at 0: the selected path + the shift from shift_from on
    const sofrM = (i, k) => Math.max(0, NR.path[i] + (c.shiftFrom === null || P[i].m0 + k >= c.shiftFrom ? NR.shPct : 0));
    const sofrAvg = P.map(p => (p.M ? sum(Array.from({ length: p.M }, (_, k) => sofrM(p.i, k))) / p.M : NR.path[p.i]));
    const rows = {};
    for (const k of ROW_NAMES) rows[k] = new Array(n).fill(0);
    const ibt = {}, rbt = {}, dbt = {};
    for (const t of c.debt.concat(c.committed, [{ id: NEW_DEBT_ID }])) { ibt[t.id] = new Array(n).fill(0); rbt[t.id] = new Array(n).fill(null); dbt[t.id] = new Array(n).fill(0); }

    // capex in each period's projected part (current and the path), its in-service date
    const capP = capexFY.map((x, i) => Math.max(0, i === 0 && c.stub ? x - c.stub.a.capex : x));
    const capPb = capPath.map((x, i) => Math.max(0, i === 0 && c.stub ? Math.max(0, x) - c.stub.a.capex : Math.max(0, x)));
    capexFY.forEach((x, i) => { if (i === 0 && c.stub && x < c.stub.a.capex) warnings.push(`${Y[i]}: capex path below actual capex; projected part floored at 0`); });
    const start = P.map(p => p.t0 + p.f / 2 + lag);
    // in-service gross PP&E, month-averaged per period -> the revenue capacity multiplier
    const gIn = Math.max(0, c.opening.gross - c.opening.cip), tCip = c.opening.cipIn;
    const inSvc = (cap, tau) => gIn + (tau >= tCip ? c.opening.cip : 0) + cap.reduce((s, a, j) => s + (tau >= start[j] ? a : 0), 0);
    const avgSvc = (cap, p) => sum(Array.from({ length: p.M }, (_, k) => inSvc(cap, p.t0 + (k + 0.5) / 12))) / Math.max(1, p.M);
    const mult = P.map(p => {
      if (!(link > 0)) return 1;
      const b = avgSvc(capPb, p);
      return b > 0 ? Math.max(0, 1 + link * (avgSvc(capP, p) / b - 1)) : 1;
    });

    // depreciation: in-service book value re-spread over the remaining life (prospective
    // change of estimate) until used up; construction in progress and each period's capex
    // are vintages depreciated straight-line from their in-service date.
    const vint = [{ amt: c.opening.cip, start: tCip }];
    let existLeft = c.opening.depNbv;
    const existRate = (c.opening.depRate !== null ? c.opening.depRate : c.opening.depBase / life0) * life0 / life;
    const dep = (t0, t1) => {
      let d = 0;
      for (const v of vint) d += v.amt / life * Math.max(0, Math.min(t1, v.start + life) - Math.max(t0, v.start));
      return d;
    };

    // tranche balance at time `at` (years from the opening date)
    const repaid = (t, at) => {
      let r = 0;
      for (const [y, amt] of t.sched) {
        const s = Math.max(t.ti, (y * 12 - c.mOpen) / 12), e = ((y + 1) * 12 - c.mOpen) / 12;
        r += e <= s ? (at >= s ? amt : 0) : amt * clamp((at - s) / (e - s), 0, 1);
      }
      return r;
    };
    const bal = (t, at) => {
      if (at < t.ti - 1e-12) return 0;
      const ta = Math.max(t.ti, t.ta);
      if (t.amort === 'bullet' || t.tm <= ta) return t.bal0;
      if (at >= t.tm - 1e-12) return 0;
      if (t.amort === 'schedule') return Math.max(0, t.bal0 - repaid(t, at));
      return at <= ta ? t.bal0 : t.bal0 * clamp((t.tm - at) / (t.tm - ta), 0, 1);
    };
    const bulletLike = t => t.amort === 'bullet' || t.tm <= Math.max(t.ti, t.ta);

    const debt0 = sum(c.debt.filter(t => t.ti <= 0).map(t => t.bal0)), nd0 = debt0 - c.opening.cash;
    let cash = c.opening.cash, shares = c.opening.shares, newDebt = 0, ppe = c.opening.net, eq = c.opening.equity;
    const cLeft = c.committed.map(x => x.amount), cBal = c.committed.map(() => 0);
    let prevPath = c.priorRev, prevRev = c.priorRev, fundCum = 0, uncCum = 0;
    for (let i = 0; i < n; i++) {
      const p = P[i], isStub = i === 0 && c.stub, f = p.f, t0 = p.t0, t1 = p.t1;
      const A = isStub ? c.stub.a : null;
      // P&L, projected part (FY minus actuals in the stub year), scaled by the capacity multiplier
      const pathFY = prevPath * (1 + growth[i] / 100);
      let revP0 = A ? pathFY - A.revenue : pathFY;
      if (revP0 < 0) { warnings.push(`${Y[i]}: growth path implies revenue below the actuals; projected part floored at 0`); revP0 = 0; }
      const revP = revP0 * mult[i], revFY = revP + (A ? A.revenue : 0);
      const corP = revP * corPct[i] / 100, opexP = revP * opexPct[i] / 100, sbcP = revP * sbcPct;
      const capexP = capP[i];
      vint.push({ amt: capexP, start: start[i] });
      const daEx = Math.min(existLeft, existRate * f);
      existLeft -= daEx;
      const daNew = dep(t0, t1), daP = daEx + daNew;
      const ebitdaP = revP - corP - opexP, ebitP = ebitdaP - sbcP - daP;

      // existing tranches: monthly balances and rates (a matured bullet pays the new-debt rate)
      let trCash = 0, trFee = 0, repay = 0, refi = 0, issued = 0, issueCash = 0, issueEq = 0, debtOpen = 0, debtClose = 0, secClose = 0;
      for (const t of c.debt) {
        const inPeriod = t.ti > 0 && t.ti >= t0 - 1e-12 && t.ti < t1 - 1e-12;
        const o = inPeriod ? 0 : bal(t, t0), cl = bal(t, t1);
        let ic = 0, ifee = 0, bt = 0;
        for (let k = 0; k < p.M; k++) {
          const tk = t0 + (k + 0.5) / 12, b = bal(t, tk);
          if (!(b > 0)) continue;
          bt += b / 12;
          if (tk >= t.tm) ic += b * newRate[i] / 12;
          else {
            ic += b * (t.kind === 'floating' ? Math.max(0, sofrM(i, k) / 100 + t.spread / 1e4) : (t.coupon === null ? newRate[i] : t.coupon / 100)) / 12;
            ifee += b * t.fee / 1e4 / 12;
          }
        }
        if (inPeriod) { issued += t.bal0; issueCash += t.issueCash; issueEq += t.issueEq; }
        if (bulletLike(t)) { if (t.tm > t0 && t.tm <= t1) refi += t.bal0; } else repay += o + (inPeriod ? t.bal0 : 0) - cl;
        ibt[t.id][i] = ic + ifee; rbt[t.id][i] = bt > 0 ? (ic + ifee) / bt * 100 : null; dbt[t.id][i] = cl;
        trCash += ic; trFee += ifee; debtOpen += o; debtClose += cl; if (t.secured) secClose += cl;
      }

      // funding: fixed point on the debt raised this period (its half-year interest lowers
      // OCF, which widens the gap it fills); committed facilities first, then new debt
      const crate = c.committed.map(x => {
        const r = x.kind === 'fixed' && x.coupon !== null ? x.coupon / 100 : Math.max(0, sofrAvg[i] / 100 + x.spread / 1e4);
        const before = clamp(x.tm - t0, 0, f);             // time still on the facility's terms
        return { cash: (r * before + newRate[i] * (f - before)) / f, fee: x.fee / 1e4 * before / f };
      });
      const open = c.committed.map(x => x.until > t0 + 1e-9);
      let D = 0, s = null;
      const step = Dg => {
        let left = Dg, intC = 0, feeC = 0;
        const draws = c.committed.map((x, k) => {
          const d = open[k] ? Math.min(cLeft[k], left) : 0;
          left -= d;
          intC += crate[k].cash * (cBal[k] + d / 2) * f; feeC += crate[k].fee * (cBal[k] + d / 2) * f;
          return d;
        });
        const Du = Math.max(0, left);
        const intNew = newRate[i] * (newDebt + (newDebt + Du)) / 2 * f;
        const nonCash = trFee + feeC;
        const intP = trCash + intC + intNew + nonCash;
        const preP = ebitP - intP;
        const taxP = Math.max(tax * Math.max(0, preP), minTax * f);
        const niP = preP - taxP;
        const ocfP = niP + daP + sbcP + nonCash + wc * (revFY - prevRev) * f;
        const pre = cash + ocfP - capexP - repay + issueCash;
        const gap = Math.max(0, minCash - pre);
        return { intNew, intC, nonCash, intP, preP, taxP, niP, ocfP, pre, gap, draws, Du, D: gap * (1 - eShare) };
      };
      for (let k = 0; k < FIX_ITERS; k++) {
        s = step(D);
        if (Math.abs(s.D - D) < FIX_TOL) break;
        D = s.D;
      }
      if (Math.abs(s.D - D) >= FIX_TOL * 1e3) warnings.push(`${Y[i]}: funding loop did not fully converge`);
      const eqRaised = s.gap * eShare, newSh = eqRaised > 0 ? eqRaised / issuePx : 0;
      const sbcShares = price > 0 ? sbcP * sbcSh / price : 0;
      let cDraw = 0, cSec = 0;
      c.committed.forEach((x, k) => {
        const d = s.draws[k];
        ibt[x.id][i] = (crate[k].cash + crate[k].fee) * (cBal[k] + d / 2) * f;
        cLeft[k] -= d; cBal[k] += d; cDraw += d;
        rbt[x.id][i] = cBal[k] > 0 ? (crate[k].cash + crate[k].fee) * 100 : null; dbt[x.id][i] = cBal[k];
        if (x.secured) cSec += cBal[k];
      });
      ibt[NEW_DEBT_ID][i] = s.intNew;
      rbt[NEW_DEBT_ID][i] = newDebt + s.Du > 0 ? newRate[i] * 100 : null;

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
      shares = shares * (1 + dil * f) + newSh + sbcShares;
      const sharesAvg = (sharesOpen + shares) / 2;
      const ocf = s.ocfP + a('ocf'), capex = capexP + a('capex');
      const cashOpen = cash;
      cash = cashOpen + s.ocfP - capexP - repay + issueCash + s.D + eqRaised;
      newDebt += s.Du;
      dbt[NEW_DEBT_ID][i] = newDebt;
      ppe = ppe + capexP - daP;
      if (eq !== null) eq = eq + s.niP + sbcP + eqRaised + issueEq;
      const cTot = sum(cBal);
      const debtEnd = debtClose + cTot + newDebt, netDebt = debtEnd - cash, secured = secClose + cSec + newDebt * c.securedPct;
      const avgDebt = (debtOpen + debtClose) / 2 + (cTot - cDraw + cTot) / 2 + (newDebt - s.Du + newDebt) / 2;
      fundCum += s.gap; uncCum += s.Du + eqRaised;

      const put = (k, v) => { rows[k][i] = v; };
      put('revenue', rev); put('revenue_growth', div(rev - prevRev, prevRev) === null ? null : (rev / prevRev - 1) * 100);
      put('cost_of_revenue', cor); put('gross_profit', rev - cor); put('gross_margin', div(rev - cor, rev) === null ? null : (rev - cor) / rev * 100);
      put('opex', opex); put('ebitda', ebitda); put('ebitda_margin', div(ebitda, rev) === null ? null : ebitda / rev * 100);
      put('sbc', sbc); put('da', da); put('adj_op_income', ebitda - da); put('ebit', ebit); put('interest', interest); put('other_income', other);
      put('interest_noncash', s.nonCash); put('interest_new', s.intNew);
      put('interest_actual', a('interest')); put('pretax', pretax); put('tax', taxFY); put('net_income', ni);
      put('shares_avg', sharesAvg); put('eps', div(ni, sharesAvg)); put('shares_end', shares);
      put('ocf', ocf); put('capex', capex); put('fcf', ocf - capex); put('ocf_proj', s.ocfP); put('capex_proj', capexP);
      put('funding_gap', s.gap); put('new_debt', s.D); put('committed_draws', cDraw); put('uncommitted_debt', s.Du);
      put('new_equity_m', eqRaised); put('new_shares', newSh); put('sbc_shares', sbcShares);
      put('funding_cum', fundCum); put('uncommitted_cum', uncCum); put('committed_left', sum(cLeft.map((x, k) => (c.committed[k].until > t1 ? x : 0))));
      put('repayments', repay); put('refinanced', refi); put('issued', issued); put('cash_open', cashOpen); put('cash_end', cash);
      put('debt_end', debtEnd); put('secured_debt', secured); put('net_debt', netDebt);
      put('net_debt_ebitda', ebitda > 0 ? netDebt / ebitda : null); put('gross_debt_ebitda', ebitda > 0 ? debtEnd / ebitda : null);
      put('secured_debt_ebitda', ebitda > 0 ? secured / ebitda : null);
      put('interest_cover', interest > 0 ? ebitda / interest : null); put('ebit_cover', interest > 0 ? ebit / interest : null);
      put('ebitda_capex_cover', interest > 0 ? (ebitda - capex) / interest : null);
      put('sofr', c.hasRates ? sofrAvg[i] : null); put('new_debt_rate', newRate[i] * 100);
      put('avg_cost_of_debt', avgDebt > 0 ? s.intP / (avgDebt * f) * 100 : null);
      put('da_existing', daEx); put('da_new', daNew); put('net_ppe', ppe); put('book_equity', eq); put('proj_frac', f); put('capacity_mult', mult[i]);
      prevPath = pathFY; prevRev = rev;
    }

    // valuation: exit multiple x the cost-of-capital adjustment x exit-year EBITDA
    const V = c.val, xi = Y.indexOf(V.exitYear);
    let bi = xi;
    if (V.ndAt === 'exit') {                     // balance sheet at the last year-end <= valuation date
      bi = -1;
      for (let i = 0; i < n; i++) if (Date.UTC(Y[i], 11, 31) <= V.vd) bi = i;
    }
    let adj = 1, wacc = null, wacc0 = null;
    if (V.link) {
      const ov0 = {};                            // the spec's defaults: base path, no shifts
      const rd0 = newRates(c, P, ov0).rates[xi] * 100, rd = newRate[xi] * 100;
      wacc0 = V.link.w * rd0 + (1 - V.link.w) * c.byId.get('discount_rate').base;
      wacc = V.link.w * rd + (1 - V.link.w) * g('discount_rate');
      adj = Math.max(0.5, wacc0 - V.link.g) / Math.max(0.5, wacc - V.link.g);
    }
    const exitEbitda = rows.ebitda[xi], mEff = g('exit_ev_ebitda') * adj, exitEv = mEff * exitEbitda;
    const exitNd = bi < 0 ? nd0 : rows.net_debt[bi], exitSh = bi < 0 ? c.opening.shares : rows.shares_end[bi];
    const exitEq = exitEv - exitNd;
    // convertibles still outstanding at the valuation date: net shares above the capped-call cap
    const tv = c.dOpen === null ? null : yearsBetween(c.dOpen, V.vd);
    const convs = c.debt.filter(t => t.conv && tv !== null && t.ti <= tv && t.tm > tv);
    const dilAt = px => convs.reduce((s2, t) => s2 + (px > t.conv.cap ? t.bal0 / t.conv.px * (px - t.conv.cap) / px : 0), 0);
    let exitPs = exitSh > 0 ? Math.max(0, exitEq) / exitSh : null, convSh = 0;
    if (exitPs !== null && exitPs > 0 && convs.length && dilAt(exitPs) > 0) {
      let lo = 0, hi = exitPs;                   // px x (shares + dilution(px)) = equity, increasing in px
      for (let k = 0; k < 80; k++) { const mid = (lo + hi) / 2; if (mid * (exitSh + dilAt(mid)) > exitEq) hi = mid; else lo = mid; }
      exitPs = (lo + hi) / 2; convSh = dilAt(exitPs);
    }
    const yrs = Math.max(0, yearsBetween(V.asof, V.vd)), pv = Math.pow(1 + g('discount_rate') / 100, yrs);
    const vps = exitPs === null ? null : exitPs / pv;
    if (exitEq <= 0) warnings.push('valuation: exit equity <= 0 (debt exceeds enterprise value); value floored at 0');

    // forward multiples: EV of year t from the balance sheet at the end of t - 1
    const mcap = price > 0 ? price * c.opening.shares : null, evNow = mcap === null ? null : mcap + nd0;
    const shPrev = i => (i ? rows.shares_end[i - 1] : c.opening.shares), ndPrev = i => (i ? rows.net_debt[i - 1] : nd0);
    const multiples = px => {
      const ev = Y.map((_, i) => (px === null ? null : px * shPrev(i) + ndPrev(i)));
      return {
        ev, ev_sales: rows.revenue.map((r, i) => (ev[i] === null ? null : div(ev[i], r))),
        ev_ebitda: rows.ebitda.map((e, i) => (ev[i] === null || !(e > 0) ? null : ev[i] / e)),
        ev_ebit: rows.ebit.map((e, i) => (ev[i] === null || !(e > 0) ? null : ev[i] / e)),
        pe: rows.eps.map(e => (px === null || !(e > 0) ? null : px / e)),
        fcf_yield: rows.fcf.map((fc, i) => (px === null || !(px > 0) ? null : fc / (px * shPrev(i)) * 100)),
      };
    };
    const atPx = multiples(price > 0 ? price : null);
    for (const k of ['ev_sales', 'ev_ebitda', 'ev_ebit', 'pe', 'fcf_yield']) rows[k] = atPx[k];
    rows.ev_at_price = atPx.ev;
    rows.ev_ebitda_static = rows.ebitda.map(e => (evNow === null || !(e > 0) ? null : evNow / e));
    const atVal = multiples(exitPs !== null && exitPs > 0 ? exitPs : null);
    const valuation = {
      exit_year: V.exitYear, valuation_date: new Date(V.vd).toISOString().slice(0, 10), balance_sheet_year: bi < 0 ? null : Y[bi],
      exit_ebitda: exitEbitda, exit_multiple: g('exit_ev_ebitda'), rate_adjustment: adj, exit_multiple_eff: mEff,
      wacc_base: wacc0, wacc: wacc, new_debt_rate_exit: newRate[xi] * 100,
      exit_ev: exitEv, exit_net_debt: exitNd, exit_equity: exitEq, exit_shares: exitSh, conv_shares: convSh,
      exit_value_per_share: exitPs, years_to_valuation: yrs, discount_factor: 1 / pv,
      value_per_share: vps, share_price: price > 0 ? price : null,
      upside_pct: vps !== null && price > 0 ? (vps / price - 1) * 100 : null,
      market_cap: mcap, ev_now: evNow, net_debt_now: nd0,
      implied_fwd_multiples_at_price: atPx, implied_multiples_at_value: atVal,
    };

    const checks = c.checks.map(k => {
      const v = metricOf({ years: Y, rows, valuation }, k.metric, k.year);
      return { label: k.label, metric: k.metric, year: k.year, value: v, lo: k.lo, hi: k.hi, src: k.src,
        pass: v === null ? null : (k.lo === null || v >= k.lo) && (k.hi === null || v <= k.hi) };
    });
    const covenants = c.covenants.map(k => {
      const values = rows[k.metric].slice();
      // a leverage ratio with EBITDA <= 0 (null) and debt outstanding is a breach
      const breach = values.map((x, i) => (x === null ? (k.max !== null && rows.debt_end[i] > 0 ? true : null)
        : (k.max !== null && x > k.max) || (k.min !== null && x < k.min)));
      const fb = breach.findIndex(b => b === true);
      if (fb >= 0) warnings.push(`${k.kind === 'threshold' ? 'threshold' : 'covenant'} ${k.label}: crossed in FY${Y[fb]}`);
      return { id: k.id, label: k.label, metric: k.metric, kind: k.kind, max: k.max, min: k.min, src: k.src, values, breach, first_breach: fb >= 0 ? Y[fb] : null };
    });

    return { years: Y.slice(), rows: Object.assign(rows, { interest_by_tranche: ibt, rate_by_tranche: rbt, debt_by_tranche: dbt }),
      valuation, checks, covenants, warnings, overrides: Object.assign({}, ov) };
  }

  // Deep pass: anything non-finite becomes null (the "finite or null" contract).
  function scrub(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (Array.isArray(x)) return x.map(scrub);
    if (isObj(x)) { const o = {}; for (const k of Object.keys(x)) o[k] = scrub(x[k]); return o; }
    return x;
  }

  function project(spec, overrides) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; '), errors: c.errors, warnings: c.warnings };
    try {
      const w = c.warnings.slice();
      const ov = cleanOverrides(c, overrides, w);
      const r = run(c, ov);
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
    const at = /^([a-z_]+)@(\d{4})$/.exec(m);
    if (at) return { metric: at[1], year: +at[2] };
    return { metric: m, year: Number.isInteger(year) ? year : null };
  }
  function metricOf(res, metric, year) {
    if (!res || res.error) return null;
    if (VAL_METRICS.includes(metric)) return fin(res.valuation[metric]);
    if (!ROW_NAMES.includes(metric)) return null;
    const i = res.years.indexOf(year);
    return i < 0 ? null : fin(res.rows[metric][i]);
  }
  function metricValue(res, metric, year) {
    const p = parseMetric(metric, year);
    return p ? metricOf(res, p.metric, p.year) : null;
  }
  // a row metric with no year defaults to the exit year
  function resolveMetric(c, metric, year) {
    const p = parseMetric(metric, year);
    if (!p || !(VAL_METRICS.includes(p.metric) || ROW_NAMES.includes(p.metric))) return null;
    if (!VAL_METRICS.includes(p.metric) && !c.years.includes(p.year)) p.year = c.val.exitYear;
    return p;
  }

  // Tornado: each driver with a low/high, metric at low and at high holding the rest at the
  // current overrides; sorted by |swing| (nulls last), ties by driver order.
  function sensitivity(spec, overrides, opts) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      opts = isObj(opts) ? opts : {};
      const p = resolveMetric(c, opts.metric || 'value_per_share', opts.year);
      if (!p) return { error: 'sensitivity: unknown metric' };
      const ov = cleanOverrides(c, overrides);
      const at = o => metricOf(scrub(run(c, o)), p.metric, p.year);
      const base = at(ov);
      const bars = [];
      c.drivers.forEach((d, idx) => {
        if (!isNum(d.low) || !isNum(d.high)) return;
        const lo = at(Object.assign({}, ov, { [d.id]: d.low })), hi = at(Object.assign({}, ov, { [d.id]: d.high }));
        const swing = lo === null || hi === null ? null : Math.abs(hi - lo);
        bars.push({ id: d.id, label: d.label, group: d.group, unit: d.unit, low: d.low, high: d.high,
          current: val(c, ov, d.id), v_low: lo, v_high: hi, swing, _i: idx });
      });
      bars.sort((a, b) => (a.swing === null) - (b.swing === null) || (b.swing || 0) - (a.swing || 0) || a._i - b._i);
      for (const b of bars) delete b._i;
      return { metric: p.metric, year: VAL_METRICS.includes(p.metric) ? null : p.year, base, bars };
    } catch (e) {
      return { error: 'sensitivity: ' + String(e && e.message || e).slice(0, 200) };
    }
  }

  // 2-D table: z[yi][xi] = metric with xDriver = xValues[xi], yDriver = yValues[yi].
  function grid(spec, overrides, xDriver, xValues, yDriver, yValues, metric) {
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
      const ov = cleanOverrides(c, overrides);
      const z = ys.map(yv => xs.map(xv => {
        const o = Object.assign({}, ov, { [yDriver]: yv });
        o[xDriver] = xv;                                // x wins when both axes are one driver
        return metricOf(scrub(run(c, o)), p.metric, p.year);
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
      const ov = cleanOverrides(c, overrides), cur = val(c, ov, d.id);
      const lo = clamp(num(opts.lo, d.min), d.min, d.max), hi = clamp(num(opts.hi, d.max), d.min, d.max);
      const n = clamp(Math.round(num(opts.steps, 16)), 4, 60);
      const at = x => { const v = metricOf(scrub(run(c, Object.assign({}, ov, { [d.id]: x }))), p.metric, p.year); return v === null ? null : v - target; };
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

  // ---- scenarios + state codec -----------------------------------------------------------
  // Scenario values on top of `baseOverrides` (default: none, i.e. every other driver at base).
  function applyScenario(spec, id, baseOverrides) {
    const c = compile(spec);
    if (!c.ok) return null;
    const s = c.scenarios.find(x => x.id === id);
    if (!s) return null;
    return Object.assign(cleanOverrides(c, baseOverrides), cleanOverrides(c, s.values));
  }
  // id of the scenario the overrides equal (drivers not named = base), else null
  function matchScenario(spec, overrides) {
    const c = compile(spec);
    if (!c.ok) return null;
    const ov = cleanOverrides(c, overrides);
    for (const s of c.scenarios) {
      const sv = cleanOverrides(c, s.values);
      if (c.drivers.every(d => Math.abs(val(c, ov, d.id) - val(c, sv, d.id)) < 1e-9)) return s.id;
    }
    return null;
  }
  // Probability-weighted value per share over the scenarios that carry a `prob`. The viewer's
  // own edits (current minus the anchor scenario they started from; default base) are laid on
  // top of every scenario, so a hand-moved driver carries into the weighted view.
  function weighted(spec, overrides, anchorId) {
    const c = compile(spec);
    if (!c.ok) return { error: c.errors.join('; ') };
    try {
      const ov = cleanOverrides(c, overrides);
      const an = c.scenarios.find(x => x.id === anchorId) || c.scenarios.find(x => x.id === 'base');
      const av = an ? cleanOverrides(c, an.values) : {};
      const rows = [];
      for (const s of c.scenarios.filter(x => x.prob !== null && x.prob > 0)) {
        const sv = cleanOverrides(c, s.values), o = {};
        for (const d of c.drivers) {
          const delta = val(c, ov, d.id) - val(c, av, d.id);
          o[d.id] = d.kind === 'choice' ? (Math.abs(delta) > 1e-9 ? val(c, ov, d.id) : val(c, sv, d.id)) : clamp(val(c, sv, d.id) + delta, d.min, d.max);
        }
        const r = scrub(run(c, o));
        rows.push({ id: s.id, name: s.name, prob: s.prob, value: fin(r.valuation.value_per_share) });
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
  // driver travels as its choice id, so a link survives a reordering of the paths.
  function encodeState(spec, overrides) {
    const c = compile(spec);
    if (!c.ok) return '';
    const ov = cleanOverrides(c, overrides), o = {};
    for (const d of c.drivers) if (own(ov, d.id) && Math.abs(ov[d.id] - d.base) > 1e-12)
      o[d.id] = d.kind === 'choice' ? d.choices[ov[d.id]].id : +ov[d.id].toPrecision(10);
    if (!Object.keys(o).length) return '';
    return b64e(JSON.stringify({ v: VERSION, m: c.slug, o }));
  }
  // Validates everything: charset, length, JSON shape, slug, known ids, finite numbers;
  // values clamp to range. Bad entries are dropped and reported, never applied.
  function decodeState(spec, s) {
    const c = compile(spec);
    if (!c.ok) return { ok: false, overrides: {}, errors: ['spec: invalid'] };
    if (s === '' || s === null || s === undefined) return { ok: true, overrides: {}, errors: [] };
    try {
      if (typeof s !== 'string' || s.length > MAX_STATE_LEN || !/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('bad');
      const j = JSON.parse(b64d(s));
      if (!isObj(j) || j.v !== VERSION || !isObj(j.o)) throw new Error('bad');
      if (j.m !== c.slug) return { ok: false, overrides: {}, errors: ['state: link is for a different model'] };
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
      return { ok: true, overrides, errors: errors.concat(w) };
    } catch (e) {
      return { ok: false, overrides: {}, errors: ['state: not a valid model link'] };
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
  // "12,345" / "4.5%" / "+25 bp" / "7.0x" / "US$61.39"; null -> "—"
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
    applyScenario, matchScenario, weighted, encodeState, decodeState, formatValue,
    cleanOverrides: (spec, ov) => { const c = compile(spec); return c.ok ? cleanOverrides(c, ov) : {}; },
  };
});
