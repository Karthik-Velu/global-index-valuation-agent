// Model engine — the stress-test / projection core behind a report's {"type":"model"} block
// (dashboard/reports/models/<slug>.json, MODEL SPEC v1, docs/REPORTS.md). It turns a spec
// (stub-year actuals, opening balance sheet, debt tranches, a SOFR path and a set of
// drivers) plus the viewer's slider overrides into a five-year P&L, cash flow, debt
// schedule, forward multiples and an exit-multiple value per share; then tornado
// sensitivities, 2-D grids, scenarios and a share-link state codec on top.
//
// Pure: no DOM, no fetch, no deps, never throws (bad input -> {error} / warnings). Every
// number it returns is finite or null. Deterministic: the only iteration (new debt pays
// interest that widens the funding gap it fills) is a fixed-point loop with a fixed cap.
//
// Semantics (levered_growth_v1; money in spec.unit, shares in millions):
//  - Stub year: FY = stub.actuals (H1) + a projected remainder. Revenue growth and the capex
//    path are FULL-YEAR figures (FY over prior.revenue; FY capex), so the projected part is
//    FY minus actuals; cost/opex/SBC ratios apply to the projected revenue only. Flows in
//    the projected part are scaled by (12 - actual_months)/12; the balance sheet starts at
//    opening.date, so cash/debt roll-forwards use the projected part only (ocf_proj, capex_proj).
//  - Interest per tranche on the average of opening and closing balance. Floating =
//    max(0, SOFR + sofr_shift) + spread + spread_shift; fixed = coupon. Bullet maturities
//    roll over at the new-debt rate = new_debt_rate + spread_shift + beta x sofr_shift
//    (spec.rates.new_debt_sofr_beta, default 1; 0 = new debt ignores SOFR moves), blended by
//    time inside the maturity year. straight / cashsweep tranches amortise linearly to zero at
//    maturity (cash out; a cash sweep is modelled as that schedule).
//  - Funding gap = max(0, min_cash - (cash + OCF - capex - amortisation)); equity_funding_share
//    of it is sold at share_price x (1 - issue_discount), the rest borrowed into the
//    "new-debt" pool (half-year interest in the year raised). Surplus cash repays nothing.
//  - OCF ~ net income + D&A + SBC + wc_prepay_pct x Δrevenue (no other working capital).
//    Tax = tax_rate x positive pre-tax profit per period (no loss carry-forward).
//  - D&A: opening depreciable base / useful_life per year until opening net PP&E is used up;
//    each period's capex depreciates straight-line over useful_life from mid-period. The base is
//    opening.dep_base when given (gross PP&E in service: excludes construction in progress and
//    land), else gross PP&E.
//  - Value: exit_ev_ebitda x adj. EBITDA (before SBC) of valuation.exit_year, less net debt and
//    over shares at the last year-end on/before valuation_date (net_debt_at "exit"; or
//    "exit_year_end"), floored at 0, discounted at discount_rate from spec.asof. Multiples
//    "at price" use today's EV = share_price x opening shares + opening debt - opening cash.
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
  const LG_DRIVERS = [
    drv('revenue_growth', 'Revenue', 'shift_pp', 'pp', 0, -40, 40, 1, -10, 5, 1, 'Revenue growth',
      'Shifts every year of the revenue-growth path (FY over FY, fundamental growth) by this many points.'),
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
    drv('sofr_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 500, 25, -100, 200, 0, 'SOFR shift',
      'Parallel shift to the projected SOFR path. Moves floating-rate interest 1:1 and the cost of new debt.'),
    drv('spread_shift', 'Financing & rates', 'shift_bp', 'bp', 0, -300, 800, 25, -100, 300, 0, 'Credit spread shift',
      'Widens (or tightens) the spread on floating debt and on any new or refinanced debt.'),
    drv('new_debt_rate', 'Financing & rates', 'scalar', '%', 9, 2, 25, 0.25, 7, 13, 2, 'New-debt rate',
      'All-in cost of new borrowing and of refinancing maturing debt, at the base SOFR path.'),
    drv('equity_funding_share', 'Dilution', 'scalar', '%', 0, 0, 100, 5, 0, 50, 0, 'Gap funded by equity',
      'Share of any funding gap met by selling new shares instead of borrowing.'),
    drv('issue_discount', 'Dilution', 'scalar', '%', 5, 0, 60, 1, 0, 25, 0, 'Issue discount',
      'Discount to the share price at which new shares are sold. Deeper discount = more shares per dollar.'),
    drv('share_dilution_pct', 'Dilution', 'scalar', '%', 0, 0, 20, 0.5, 0, 4, 1, 'Share-count creep',
      'Annual growth in shares from employee equity (RSUs/options), on top of any equity raised.', { required: false }),
    drv('min_cash', 'Financing & rates', 'scalar', 'US$m', 1000, 0, 1e6, 100, 500, 3000, 0, 'Minimum cash',
      'Cash the company keeps on hand; anything below it is a funding gap that must be raised.'),
    drv('wc_prepay_pct', 'Revenue', 'scalar', '%', 0, 0, 100, 5, 0, 30, 0, 'Customer prepayments',
      'Customer prepayments / deferred-revenue inflow as % of each year\'s revenue increase.'),
    drv('tax_rate', 'Margins', 'scalar', '%', 21, 0, 50, 1, 15, 25, 0, 'Tax rate',
      'Cash tax on positive pre-tax profit only (losses are not carried forward).'),
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
    ebit: R('EBIT', 'US$m', 'P&L', 0), interest: R('Interest expense', 'US$m', 'P&L', 0),
    other_income: R('Other income (actual)', 'US$m', 'P&L', 0), pretax: R('Pre-tax profit', 'US$m', 'P&L', 0),
    tax: R('Tax', 'US$m', 'P&L', 0), net_income: R('Net income', 'US$m', 'P&L', 0),
    shares_avg: R('Avg shares', 'm', 'P&L', 1), eps: R('EPS', 'US$', 'P&L', 2),
    ocf: R('Operating cash flow', 'US$m', 'Cash flow', 0), capex: R('Capex', 'US$m', 'Cash flow', 0),
    fcf: R('Free cash flow', 'US$m', 'Cash flow', 0), funding_gap: R('Funding gap', 'US$m', 'Cash flow', 0),
    new_debt: R('New debt raised', 'US$m', 'Cash flow', 0), new_equity_m: R('Equity raised', 'US$m', 'Cash flow', 0),
    new_shares: R('New shares issued', 'm', 'Cash flow', 1), repayments: R('Scheduled amortisation', 'US$m', 'Cash flow', 0),
    refinanced: R('Maturities refinanced', 'US$m', 'Cash flow', 0),
    sofr: R('SOFR (avg)', '%', 'Debt', 2), avg_cost_of_debt: R('Avg cost of debt', '%', 'Debt', 2),
    debt_end: R('Total debt', 'US$m', 'Debt', 0), cash_end: R('Cash', 'US$m', 'Debt', 0),
    net_debt: R('Net debt', 'US$m', 'Debt', 0), net_debt_ebitda: R('Net debt / EBITDA', 'x', 'Debt', 1),
    interest_cover: R('Interest cover (EBITDA/interest)', 'x', 'Debt', 1),
    net_ppe: R('Net PP&E', 'US$m', 'Balance sheet', 0), book_equity: R('Book equity', 'US$m', 'Balance sheet', 0),
    shares_end: R('Shares (year-end)', 'm', 'Balance sheet', 1),
    ev_sales: R('EV / sales (at price)', 'x', 'Multiples', 1), ev_ebitda: R('EV / EBITDA (at price)', 'x', 'Multiples', 1),
    pe: R('P/E (at price)', 'x', 'Multiples', 1), fcf_yield: R('FCF yield (at price)', '%', 'Multiples', 1),
  };
  const ROW_NAMES = Object.keys(LG_ROWS).concat(['cash_open', 'ocf_proj', 'capex_proj', 'da_existing', 'da_new',
    'interest_actual', 'proj_frac']);
  const VAL_METRICS = ['value_per_share', 'upside_pct', 'exit_ev', 'exit_equity', 'exit_net_debt', 'exit_value_per_share'];

  const TEMPLATES = {
    levered_growth_v1: {
      id: 'levered_growth_v1', groups: GROUPS, drivers: LG_DRIVERS, rows: LG_ROWS,
      row_names: ROW_NAMES, valuation_metrics: VAL_METRICS, new_debt_id: NEW_DEBT_ID,
      // the tornado/grid metrics the UI offers; "<row>" metrics take a year
      metrics: ['value_per_share', 'net_income', 'interest', 'ebitda', 'net_debt_ebitda', 'fcf', 'eps', 'interest_cover'],
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
  const yearsBetween = (a, b) => (b - a) / (365.25 * 864e5);

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
  function normDrivers(spec, tpl, years, errors, warnings) {
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
        for (const k of ['label', 'help', 'unit']) if (typeof s[k] === 'string' && s[k]) d[k] = s[k].slice(0, 400);
        if (typeof s.group === 'string' && GROUPS.includes(s.group)) d.group = s.group;
        for (const k of ['base', 'min', 'max', 'step', 'low', 'high', 'dp']) if (isNum(s[k])) d[k] = s[k];
        if (Array.isArray(s.src)) d.src = s.src.filter(x => typeof x === 'string').slice(0, 20);
        if (s.path !== undefined) d.path_spec = s.path;
      }
      if (d.min > d.max) { warnings.push(`drivers: ${d.id} min > max; swapped`); const t2 = d.min; d.min = d.max; d.max = t2; }
      if (!(d.step > 0)) d.step = t.step;
      if (d.base < d.min || d.base > d.max) { warnings.push(`drivers: ${d.id} base outside [min,max]; clamped`); d.base = clamp(d.base, d.min, d.max); }
      for (const k of ['low', 'high']) if (isNum(d[k])) d[k] = clamp(d[k], d.min, d.max);
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
      const mOpen = monthIdx(op.date);
      if (mOpen === null) errors.push('opening: date must be YYYY-MM-DD');
      for (const k of ['cash', 'shares_m']) if (!isNum(op[k])) errors.push(`opening: ${k} must be a number`);
      if (isNum(op.shares_m) && op.shares_m <= 0) errors.push('opening: shares_m must be > 0');
      let net = num(op.net_ppe, null), gross = num(op.gross_ppe, null);
      const acc = num(op.accum_dep, null);
      if (net === null && gross !== null && acc !== null) net = gross - acc;
      if (gross === null && net !== null && acc !== null) gross = net + acc;
      if (net === null || gross === null) { warnings.push('opening: PP&E incomplete; existing assets not depreciated'); net = net || 0; gross = gross || 0; }

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

      const { list, byId } = normDrivers(spec, tpl, years, errors, warnings);

      // debt stack
      const debt = [], ids = new Set();
      if (spec.debt !== undefined && !Array.isArray(spec.debt)) errors.push('debt: must be a list of tranches');
      for (const t of Array.isArray(spec.debt) ? spec.debt : []) {
        if (!isObj(t) || typeof t.id !== 'string' || !TRANCHE_RE.test(t.id) || t.id === NEW_DEBT_ID || ids.has(t.id)) {
          errors.push(`debt: invalid or duplicate tranche id ${String(isObj(t) ? t.id : t).slice(0, 40)}`); continue;
        }
        ids.add(t.id);
        if (!isNum(t.balance) || t.balance < 0) { errors.push(`debt ${t.id}: balance must be a number >= 0`); continue; }
        const kind = t.kind === 'floating' ? 'floating' : t.kind === 'fixed' ? 'fixed' : null;
        if (!kind) { errors.push(`debt ${t.id}: kind must be fixed or floating`); continue; }
        const mm = monthIdx(t.maturity);
        if (mm === null) { errors.push(`debt ${t.id}: maturity must be YYYY-MM`); continue; }
        const amort = ['bullet', 'straight', 'cashsweep'].includes(t.amort) ? t.amort : 'bullet';
        if (t.amort !== amort) warnings.push(`debt ${t.id}: amort ${String(t.amort).slice(0, 20)} unknown; bullet used`);
        let coupon = num(t.coupon_pct, null), spread = num(t.spread_bp, null);
        if (kind === 'fixed' && coupon === null) warnings.push(`debt ${t.id}: fixed with no coupon; new-debt rate used`);
        if (kind === 'floating' && spread === null) { warnings.push(`debt ${t.id}: floating with no spread; 0 bp used`); spread = 0; }
        debt.push({ id: t.id, name: typeof t.name === 'string' ? t.name.slice(0, 120) : t.id, kind, coupon, spread,
          bal0: t.balance, tm: mOpen === null ? 0 : (mm - mOpen) / 12, amort, maturity: t.maturity,
          secured: !!t.secured, recourse: t.recourse !== false });
      }

      const rp = isObj(spec.rates) ? pathArr(spec.rates.path, years) : null;
      if (!rp && debt.some(t => t.kind === 'floating')) errors.push('rates: path is required with floating debt');
      const beta = isObj(spec.rates) && isNum(spec.rates.new_debt_sofr_beta) ? clamp(spec.rates.new_debt_sofr_beta, 0, 1) : 1;

      // valuation: exit multiple on exit_year EBITDA, struck at valuation_date, discounted to asof
      const v = isObj(spec.valuation) ? spec.valuation : {};
      const exitYear = years.includes(v.exit_year) ? v.exit_year : years[Math.min(2, years.length - 1)];
      if (v.exit_year !== undefined && v.exit_year !== exitYear) warnings.push('valuation: exit_year outside the model years; clamped');
      let vd = dayMs(v.valuation_date);
      if (vd === null) vd = Date.UTC(exitYear - 1, 11, 31);
      let asof = dayMs(spec.asof);
      if (asof === null) { asof = vd; warnings.push('spec: asof missing; value not discounted'); }
      const ndAt = v.net_debt_at === 'exit_year_end' ? 'exit_year_end' : 'exit';

      const checks = (Array.isArray(spec.checks) ? spec.checks : []).filter(c => isObj(c) && typeof c.metric === 'string').slice(0, 40)
        .map(c => ({ label: typeof c.label === 'string' ? c.label.slice(0, 200) : c.metric, metric: c.metric,
          year: Number.isInteger(c.year) ? c.year : null, lo: fin(c.lo), hi: fin(c.hi),
          src: Array.isArray(c.src) ? c.src.filter(x => typeof x === 'string').slice(0, 20) : [] }));

      const scenarios = (Array.isArray(spec.scenarios) ? spec.scenarios : [])
        .filter(s => isObj(s) && typeof s.id === 'string' && ID_RE.test(s.id)).slice(0, 20)
        .map(s => ({ id: s.id, name: typeof s.name === 'string' ? s.name.slice(0, 80) : s.id,
          note: typeof s.note === 'string' ? s.note.slice(0, 600) : '', values: isObj(s.values) ? s.values : {} }));

      if (errors.length) return { ok: false, errors, warnings };
      return {
        ok: true, errors, warnings, tpl, years, stub, frac0, priorRev, drivers: list, byId, debt, beta,
        sofr: rp || years.map(() => 0), hasRates: !!rp, slug: typeof spec.slug === 'string' ? spec.slug.slice(0, 40) : '',
        opening: { cash: op.cash, shares: op.shares_m, gross, net, equity: num(op.equity, null),
          depBase: isNum(op.dep_base) && op.dep_base >= 0 ? op.dep_base : gross },
        val: { exitYear, vd, asof, ndAt }, checks, scenarios,
      };
    } catch (e) {
      return { ok: false, errors: ['spec: ' + String(e && e.message || e).slice(0, 200)], warnings };
    }
  }

  // ---- overrides -------------------------------------------------------------------------
  // Only own, known driver ids with finite numbers survive; values clamp to [min, max].
  // Output keys follow driver order, so equal overrides always serialize identically.
  function cleanOverrides(c, overrides, warnings) {
    const out = {};
    if (!isObj(overrides)) return out;
    if (warnings) for (const k of Object.keys(overrides))
      if (!c.byId.has(k)) warnings.push(`override ${String(k).slice(0, 40)}: unknown driver; ignored`);
    for (const d of c.drivers) {
      if (!own(overrides, d.id)) continue;
      const k = d.id, v = overrides[k];
      if (!isNum(v)) { if (warnings) warnings.push(`override ${k}: not a finite number; ignored`); continue; }
      const cv = clamp(v, d.min, d.max);
      if (cv !== v && warnings) warnings.push(`override ${k}: clamped to ${cv}`);
      out[k] = cv;
    }
    return out;
  }
  const val = (c, ov, id) => (own(ov, id) ? ov[id] : c.byId.get(id).base);

  // ---- projection ------------------------------------------------------------------------
  function run(c, ov) {
    const Y = c.years, n = Y.length, warnings = [];
    const g = id => val(c, ov, id);
    const growth = c.byId.get('revenue_growth').path.map(p => Math.max(-100, p + g('revenue_growth')));
    const corPct = c.byId.get('cost_of_revenue_pct').path.map(p => Math.max(0, p + g('cost_of_revenue_pct')));
    const opexPct = c.byId.get('opex_pct').path.map(p => Math.max(0, p + g('opex_pct')));
    const capexFY = c.byId.get('capex').path.map(p => Math.max(0, p * (1 + g('capex') / 100)));
    const sbcPct = g('sbc_pct') / 100, life = Math.max(0.5, g('useful_life')), tax = g('tax_rate') / 100;
    // rates: the SOFR path is in %, everything else below is a decimal fraction
    const sofrSh = g('sofr_shift') / 100, sprSh = g('spread_shift') / 1e4, minCash = g('min_cash');
    const wc = g('wc_prepay_pct') / 100, dil = g('share_dilution_pct') / 100;
    const price = g('share_price'), issuePx = price * (1 - g('issue_discount') / 100);
    let eShare = g('equity_funding_share') / 100;
    if (eShare > 0 && !(issuePx > 0)) { warnings.push('equity funding needs a share price > 0; gap funded with debt'); eShare = 0; }
    const sofr = c.sofr.map(s => Math.max(0, s + sofrSh));                 // % ; floored at 0
    const newRate = Math.max(0, g('new_debt_rate') / 100 + sprSh + c.beta * g('sofr_shift') / 1e4);
    const rows = {};
    for (const k of ROW_NAMES) rows[k] = new Array(n).fill(0);
    const ibt = {}, rbt = {}, dbt = {};
    for (const t of c.debt.concat([{ id: NEW_DEBT_ID }])) { ibt[t.id] = new Array(n).fill(0); rbt[t.id] = new Array(n).fill(null); dbt[t.id] = new Array(n).fill(0); }

    // depreciation: the existing depreciable base over `life` until opening net PP&E is used up;
    // each period's capex is a vintage depreciated straight-line from mid-period.
    const vint = [];
    let existLeft = Math.max(0, c.opening.net);
    const existRate = Math.max(0, c.opening.depBase) / life;
    const dep = (t0, t1) => {
      let d = 0;
      for (const v of vint) d += v.amt / life * Math.max(0, Math.min(t1, v.start + life) - Math.max(t0, v.start));
      return d;
    };

    // bullet balances stay constant (maturities roll into refinancing at newRate); straight
    // and cash-sweep tranches amortise linearly to zero at maturity (cash out, may open a gap)
    const bal = (t, at) => (t.amort === 'bullet' || t.tm <= 0 ? t.bal0 : t.bal0 * clamp((t.tm - at) / t.tm, 0, 1));
    const baseRate = (t, i) => (t.kind === 'floating' ? Math.max(0, sofr[i] / 100 + (t.spread / 1e4 + sprSh))
      : (t.coupon === null ? newRate : t.coupon / 100));

    let cash = c.opening.cash, shares = c.opening.shares, newDebt = 0, ppe = c.opening.net, eq = c.opening.equity;
    let prevRev = c.priorRev, t0 = 0;
    for (let i = 0; i < n; i++) {
      const isStub = i === 0 && c.stub, f = i === 0 ? c.frac0 : 1, t1 = t0 + f;
      const A = isStub ? c.stub.a : null;
      // P&L, projected part (FY minus actuals in the stub year)
      const revFY = prevRev * (1 + growth[i] / 100);
      let revP = A ? revFY - A.revenue : revFY;
      if (revP < 0) { warnings.push(`${Y[i]}: growth path implies revenue below the actuals; projected part floored at 0`); revP = 0; }
      const corP = revP * corPct[i] / 100, opexP = revP * opexPct[i] / 100, sbcP = revP * sbcPct;
      let capexP = A ? capexFY[i] - A.capex : capexFY[i];
      if (capexP < 0) { warnings.push(`${Y[i]}: capex path below actual capex; projected part floored at 0`); capexP = 0; }
      vint.push({ amt: capexP, start: t0 + f / 2 });
      const daEx = Math.min(existLeft, existRate * f);
      existLeft -= daEx;
      const daNew = dep(t0, t1), daP = daEx + daNew;
      const ebitdaP = revP - corP - opexP, ebitP = ebitdaP - sbcP - daP;

      // existing tranches
      let trInt = 0, repay = 0, refi = 0, debtOpen = 0, debtClose = 0;
      for (const t of c.debt) {
        const o = bal(t, t0), cl = bal(t, t1), avg = (o + cl) / 2;
        let rate;
        if (t.amort === 'bullet' || t.tm <= 0) {
          const before = clamp(t.tm - t0, 0, f);           // time still on the original terms
          rate = (baseRate(t, i) * before + newRate * (f - before)) / f;
          if (t.tm > t0 && t.tm <= t1) refi += t.bal0;
        } else {
          rate = baseRate(t, i);
          repay += o - cl;
        }
        const it = avg * rate * f;
        ibt[t.id][i] = it; rbt[t.id][i] = avg > 0 ? rate * 100 : null; dbt[t.id][i] = cl;
        trInt += it; debtOpen += o; debtClose += cl;
      }

      // funding: fixed point on the new debt raised this period (its half-year interest
      // lowers OCF, which widens the gap it fills); a contraction, so it converges
      let D = 0, s = null;
      const step = Dg => {
        const intNew = newRate * (newDebt + (newDebt + Dg)) / 2 * f;
        const intP = trInt + intNew;
        const preP = ebitP - intP;
        const taxP = tax * Math.max(0, preP);
        const niP = preP - taxP;
        const ocfP = niP + daP + sbcP + wc * (revFY - prevRev) * f;
        const pre = cash + ocfP - capexP - repay;
        const gap = Math.max(0, minCash - pre);
        return { intNew, intP, preP, taxP, niP, ocfP, pre, gap, D: gap * (1 - eShare) };
      };
      for (let k = 0; k < FIX_ITERS; k++) {
        s = step(D);
        if (Math.abs(s.D - D) < FIX_TOL) break;
        D = s.D;
      }
      if (Math.abs(s.D - D) >= FIX_TOL * 1e3) warnings.push(`${Y[i]}: funding loop did not fully converge`);
      const eqRaised = s.gap * eShare, newSh = eqRaised > 0 ? eqRaised / issuePx : 0;
      ibt[NEW_DEBT_ID][i] = s.intNew;
      rbt[NEW_DEBT_ID][i] = newDebt + s.D > 0 ? newRate * 100 : null;

      // full-year rows (actuals + projected part)
      const a = k => (A ? A[k] : 0);
      const rev = revP + a('revenue'), cor = corP + a('cost_of_revenue'), opex = opexP + a('opex_ex_da_sbc');
      const sbc = sbcP + a('sbc'), da = daP + a('da'), interest = s.intP + a('interest');
      const ebitda = rev - cor - opex, ebit = ebitda - sbc - da, other = a('other_income');
      const pretax = ebit - interest + other;
      const preA = A ? A.revenue - A.cost_of_revenue - A.opex_ex_da_sbc - A.sbc - A.da - A.interest + A.other_income : 0;
      const taxA = A ? (A.tax !== null ? A.tax : tax * Math.max(0, preA)) : 0;
      const taxFY = s.taxP + taxA, ni = pretax - taxFY;
      const sharesOpen = shares;
      shares = shares * (1 + dil * f) + newSh;
      const sharesAvg = (sharesOpen + shares) / 2;
      const ocf = s.ocfP + a('ocf'), capex = capexP + a('capex');
      const cashOpen = cash;
      cash = cashOpen + s.ocfP - capexP - repay + s.D + eqRaised;
      newDebt += s.D;
      dbt[NEW_DEBT_ID][i] = newDebt;
      ppe = ppe + capexP - daP;
      if (eq !== null) eq = eq + s.niP + sbcP + eqRaised;
      const debtEnd = debtClose + newDebt, netDebt = debtEnd - cash;
      const avgDebt = (debtOpen + debtClose) / 2 + (newDebt - s.D + newDebt) / 2;

      const put = (k, v) => { rows[k][i] = v; };
      put('revenue', rev); put('revenue_growth', div(revFY - prevRev, prevRev) === null ? null : (revFY / prevRev - 1) * 100);
      put('cost_of_revenue', cor); put('gross_profit', rev - cor); put('gross_margin', div(rev - cor, rev) === null ? null : (rev - cor) / rev * 100);
      put('opex', opex); put('ebitda', ebitda); put('ebitda_margin', div(ebitda, rev) === null ? null : ebitda / rev * 100);
      put('sbc', sbc); put('da', da); put('ebit', ebit); put('interest', interest); put('other_income', other);
      put('interest_actual', a('interest')); put('pretax', pretax); put('tax', taxFY); put('net_income', ni);
      put('shares_avg', sharesAvg); put('eps', div(ni, sharesAvg)); put('shares_end', shares);
      put('ocf', ocf); put('capex', capex); put('fcf', ocf - capex); put('ocf_proj', s.ocfP); put('capex_proj', capexP);
      put('funding_gap', s.gap); put('new_debt', s.D); put('new_equity_m', eqRaised); put('new_shares', newSh);
      put('repayments', repay); put('refinanced', refi); put('cash_open', cashOpen); put('cash_end', cash);
      put('debt_end', debtEnd); put('net_debt', netDebt); put('net_debt_ebitda', ebitda > 0 ? netDebt / ebitda : null);
      put('interest_cover', interest > 0 ? ebitda / interest : null);
      put('sofr', c.hasRates ? sofr[i] : null); put('avg_cost_of_debt', avgDebt > 0 ? s.intP / (avgDebt * f) * 100 : null);
      put('da_existing', daEx); put('da_new', daNew); put('net_ppe', ppe); put('book_equity', eq); put('proj_frac', f);
      prevRev = revFY; t0 = t1;
    }

    // forward multiples at today's price: EV = price x opening shares + opening net debt
    const debt0 = sum(c.debt.map(t => t.bal0)), nd0 = debt0 - c.opening.cash;
    const mcap = price > 0 ? price * c.opening.shares : null, evNow = mcap === null ? null : mcap + nd0;
    const multiples = (pxEq, ev) => ({
      ev_sales: rows.revenue.map(r => (ev === null ? null : div(ev, r))),
      ev_ebitda: rows.ebitda.map(e => (ev === null || !(e > 0) ? null : ev / e)),
      pe: rows.eps.map(e => (pxEq === null || !(e > 0) ? null : pxEq / e)),
      fcf_yield: rows.fcf.map(f => (pxEq === null || !(pxEq > 0) ? null : f / (pxEq * c.opening.shares) * 100)),
    });
    const atPx = multiples(price > 0 ? price : null, evNow);
    for (const k of Object.keys(atPx)) rows[k] = atPx[k];

    // valuation
    const V = c.val, xi = Y.indexOf(V.exitYear);
    let bi = xi;
    if (V.ndAt === 'exit') {                     // balance sheet at the last year-end <= valuation date
      bi = -1;
      for (let i = 0; i < n; i++) if (Date.UTC(Y[i], 11, 31) <= V.vd) bi = i;
    }
    const exitEbitda = rows.ebitda[xi], exitEv = g('exit_ev_ebitda') * exitEbitda;
    const exitNd = bi < 0 ? nd0 : rows.net_debt[bi], exitSh = bi < 0 ? c.opening.shares : rows.shares_end[bi];
    const exitEq = exitEv - exitNd, exitPs = exitSh > 0 ? Math.max(0, exitEq) / exitSh : null;
    const yrs = Math.max(0, yearsBetween(V.asof, V.vd)), pv = Math.pow(1 + g('discount_rate') / 100, yrs);
    const vps = exitPs === null ? null : exitPs / pv;
    if (exitEq <= 0) warnings.push('valuation: exit equity <= 0 (debt exceeds enterprise value); value floored at 0');
    const evVal = vps === null ? null : vps * c.opening.shares + nd0;
    const valuation = {
      exit_year: V.exitYear, valuation_date: new Date(V.vd).toISOString().slice(0, 10), balance_sheet_year: bi < 0 ? null : Y[bi],
      exit_ebitda: exitEbitda, exit_multiple: g('exit_ev_ebitda'), exit_ev: exitEv, exit_net_debt: exitNd,
      exit_equity: exitEq, exit_shares: exitSh, exit_value_per_share: exitPs, years_to_valuation: yrs, discount_factor: 1 / pv,
      value_per_share: vps, share_price: price > 0 ? price : null,
      upside_pct: vps !== null && price > 0 ? (vps / price - 1) * 100 : null,
      market_cap: mcap, ev_now: evNow, net_debt_now: nd0,
      implied_fwd_multiples_at_price: atPx,
      implied_multiples_at_value: multiples(vps, evVal),
    };

    const checks = c.checks.map(k => {
      const v = metricOf({ years: Y, rows, valuation }, k.metric, k.year);
      return { label: k.label, metric: k.metric, year: k.year, value: v, lo: k.lo, hi: k.hi, src: k.src,
        pass: v === null ? null : (k.lo === null || v >= k.lo) && (k.hi === null || v <= k.hi) };
    });

    return { years: Y.slice(), rows: Object.assign(rows, { interest_by_tranche: ibt, rate_by_tranche: rbt, debt_by_tranche: dbt }),
      valuation, checks, warnings, overrides: Object.assign({}, ov) };
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

  // ---- metrics, tornado, grid ------------------------------------------------------------
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

  const b64e = s => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(s)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const b64d = s => {
    const b = s.replace(/-/g, '+').replace(/_/g, '/');
    return typeof Buffer !== 'undefined' ? Buffer.from(b, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))));
  };
  // Compact base64url of the non-default overrides ('' when everything is at base).
  function encodeState(spec, overrides) {
    const c = compile(spec);
    if (!c.ok) return '';
    const ov = cleanOverrides(c, overrides), o = {};
    for (const d of c.drivers) if (own(ov, d.id) && Math.abs(ov[d.id] - d.base) > 1e-12) o[d.id] = +ov[d.id].toPrecision(10);
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
        if (!c.byId.has(k)) { errors.push(`state: unknown driver ${String(k).slice(0, 40)}`); continue; }
        if (!isNum(j.o[k])) { errors.push(`state: ${k} is not a number`); continue; }
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
    return c.drivers.map(d => scrub(Object.assign({}, d, { path: d.path ? d.path.slice() : undefined })));
  }
  function defaults(spec) {
    const out = {};
    for (const d of drivers(spec)) out[d.id] = d.base;
    return out;
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
    validateSpec, drivers, defaults, project, sensitivity, grid, metricValue,
    applyScenario, matchScenario, encodeState, decodeState, formatValue,
    cleanOverrides: (spec, ov) => { const c = compile(spec); return c.ok ? cleanOverrides(c, ov) : {}; },
  };
});
