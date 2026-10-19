// Stress test & projections — the interactive face of a report's {"type":"model"} block
// (MODEL SPEC v1, dashboard/reports/models/<slug>.json; maths in model-engine.js, docs in
// docs/REPORTS.md). Loaded on demand by reports.js, which hands it the parsed model, the
// parent report (whose sources the model's [sN] citations point at) and the route's state.
//
//   ReportModel.mount(el, {model, report, rich, state, onState, links, standalone}) -> dispose
//     rich      Reports.richText(report): {inline(text), cite(ids)} — **bold** + [sN] links
//     state     the route's ?m= (ModelEngine.decodeState validates + clamps it; never eval'd)
//     onState   called with ModelEngine.encodeState(...) after every change ('' = at base)
//     links     {self, full, report}: this view's route, the full-width route, the report
//   dispose() unmounts; dispose.setState(str) applies a new ?m in place; dispose.getState().
//
// Layout: scenario chips + Reset + Copy link, a headline KPI strip for FY+1 or FY+2 (each
// with its delta vs the base scenario; covenant badges; the probability-weighted value), a
// compact sticky strip on a phone, a "Key P&L drivers" callout written from the tornado, the
// driver panel (sliders + numeric inputs, grouped; the SOFR path is a picker) and the tabs:
// P&L projection (+ consensus; with a revenue_model the revenue build: MW, price per MW,
// billing, backlog coverage, customers, the bridge from the last reported year, owned vs
// leased; the EBITDA -> free-cash-flow bridge; reported profit at two depreciation lives),
// Risks & upsides (spec.events: a card per business event with its mechanism, an editable
// probability, an On/Off switch, its impact and what to watch; the outcome distribution over
// all of them), Interest & debt (fixed vs floating after hedges, rate exposure, every rate
// path, interest by tranche, funding sources and the yearly borrowing need, leverage and
// coverage against the covenants, the maturity ladder with the model's own borrowing),
// Sensitivity (tornado incl. events + 2-way grid, any metric and year), Breakevens (what the
// price implies; where the covenants break), Valuation & multiples (funded-EV forward
// multiples, the exit bridge), Quarterly watch list (spec.watchlist), Calibration. Inputs
// recompute the projection on the next animation frame; the tornado, grid, breakevens and
// the event cards wait until the slider rests (~0.25 s); the outcome distribution (up to
// 4,096 exact states or 2,000 draws) runs only with its tab open, cached per input. Print
// swaps the controls for a static snapshot (KPIs + events + distribution + P&L + tornado)
// of the scenario on screen.
//
// Safety: as reports.js — createElement / textContent only (innerHTML is never assigned);
// spec text reaches the page as text nodes, citations through rich.cite. Charts are inline
// SVG built the same way. UMD: window.ReportModel; module.exports under Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReportModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The dashboard palette, ordered so neighbouring series stay apart under colour-vision
  // deficiency (checked with the dataviz validator); a sixth+ tranche folds into "Other".
  const SERIES = ['#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf'];
  const C_ACTUAL = '#64748b', C_OTHER = '#94a3b8', C_LOW = '#60a5fa', C_HIGH = '#fbbf24', C_LIMIT = '#f87171';
  // business events in the tornado: a risk switched on / an upside switched on (palette pair 2 / 5)
  const C_RISK = '#f472b6', C_UP = '#2dd4bf';
  // fixed vs floating: existing fixed (incl. swapped), existing floating, new fixed, new floating
  const C_FIX = '#60a5fa', C_FLT = '#fbbf24', C_NFIX = '#a78bfa', C_NFLT = '#f472b6';
  const MINUS = '−';
  // [key, label, shown when]; the Risks & upsides tab needs spec.events, the watch list spec.watchlist
  const TAB_DEFS = [['pl', 'P&L projection'], ['risk', 'Risks & upsides', 'events'], ['debt', 'Interest & debt'], ['sens', 'Sensitivity'],
    ['be', 'Breakevens'], ['val', 'Valuation & multiples'], ['watch', 'Quarterly watch list', 'watch'], ['cal', 'Calibration']];
  const SLOW_TABS = new Set(['sens', 'be', 'risk', 'debt']);   // recomputed once the sliders rest (the P&L tab's lower half too)
  const SLOW_MS = 250;
  const PL_ROWS = ['revenue', 'revenue_growth', 'gross_profit', 'gross_margin', 'ebitda', 'ebitda_margin', 'da', 'ebit', 'interest',
    'pretax', 'tax', 'net_income', 'eps', 'capex', 'ocf', 'fcf'];
  const STRONG_ROWS = new Set(['revenue', 'ebitda', 'net_income', 'fcf']);
  // rows shown only when they are not zero (here or in the base case)
  const OPTIONAL_ROWS = new Set(['undelivered_credits', 'mw_deferred', 'idle_shell_mw', 'idle_rent', 'unsold_mw', 'funding_shortfall', 'shortfall_interest', 'backstop_revenue']);
  // The revenue build (capacity_v1): what a reader can observe each quarter, then what it makes.
  const BUILD_ROWS = ['active_mw_end', 'mw_added', 'active_mw_avg', 'billing_mw_avg', 'utilization_avg', 'unsold_mw', 'list_price_per_billing_mw', 'revenue_per_billing_mw', 'revenue_per_mw',
    'renewal_price_change', 'renewal_effect', 'backstop_revenue', 'backstop_left', 'revenue', 'contracted_revenue', 'uncontracted_revenue', 'backlog_coverage', 'undelivered_credits',
    'uncontracted_run_rate', 'bookings_needed', 'top_customer_share', 'top_contracted_share', 'backlog_remaining', 'top_backlog_share', 'mw_deferred'];
  // Owned vs leased and the unit costs behind the margins.
  const COST_ROWS = ['cor_per_mw_eff', 'rent', 'rent_per_mw', 'idle_shell_mw', 'idle_rent', 'power_cost', 'owned_mw', 'capex_per_mw_eff', 'capex_capacity', 'capex_self_build', 'capex_maintenance'];
  // +1: higher is better for the shareholder, -1: lower is better, 0: neither (a neutral change marker).
  const GOOD = { revenue: 1, revenue_growth: 1, gross_profit: 1, gross_margin: 1, ebitda: 1, ebitda_margin: 1, da: -1, ebit: 1,
    interest: -1, pretax: 1, tax: -1, net_income: 1, eps: 1, capex: 0, ocf: 1, fcf: 1, value_per_share: 1, upside_pct: 1, weighted: 1,
    net_debt_ebitda: -1, gross_debt_ebitda: -1, secured_debt_ebitda: -1, interest_cover: 1, ebit_cover: 1, ebitda_capex_cover: 1,
    funding: 0, funding_cum: 0, uncommitted_cum: 0, ev_ebitda: -1, ev_sales: -1, pe: -1, fcf_yield: 1,
    interest_to_ebitda: -1, floating_interest: 0, floating_share_of_interest: 0, floating_share_of_debt: 0, rate_exposure_100bp: -1, liquidity: 1,
    backlog_coverage: 0, cash_interest: -1, cash_tax: -1, wc_prepay: 1, other_cash: 0, adj_op_income: 1,
    active_mw_end: 1, mw_added: 1, active_mw_avg: 1, billing_mw_avg: 1, utilization_avg: 1, revenue_per_billing_mw: 1, revenue_per_mw: 1,
    renewal_effect: 1, backstop_revenue: 0, backstop_left: 0, contracted_revenue: 0, uncontracted_revenue: 0, top_customer_share: -1,
    unsold_mw: -1, list_price_per_billing_mw: 1, renewal_price_change: 1, undelivered_credits: -1, uncontracted_run_rate: 0, bookings_needed: 0,
    top_contracted_share: -1, backlog_remaining: 0, top_backlog_share: -1, mw_deferred: -1, idle_shell_mw: -1, idle_rent: -1, fcf_pre_growth: 1, active_mw_vs_plan: 1,
    funding_shortfall: -1, shortfall_interest: -1,
    cor_per_mw_eff: -1, rent: -1, rent_per_mw: -1, power_cost: -1, owned_mw: 0, capex_per_mw_eff: -1, capex_capacity: 0, capex_self_build: 0, capex_maintenance: 0 };
  // Grid defaults per metric (x across, y down): value against the two biggest value drivers;
  // interest against the rate (SOFR) and the credit (new-debt cost) halves of the owner's question.
  // With a revenue_model the revenue drivers are the capacity ones (CAP_SWAP).
  const GRID_DEFAULTS = { value_per_share: ['revenue_growth', 'exit_ev_ebitda'], interest: ['sofr_shift', 'new_debt_rate'],
    net_income: ['sofr_shift', 'revenue_growth'], eps: ['sofr_shift', 'revenue_growth'], interest_cover: ['sofr_shift', 'new_debt_rate'],
    net_debt_ebitda: ['capex', 'revenue_growth'], gross_debt_ebitda: ['capex', 'revenue_growth'], uncommitted_cum: ['capex', 'equity_funding_share'],
    revenue: ['revenue_growth', 'capex'], interest_to_ebitda: ['sofr_shift', 'new_debt_rate'], floating_share_of_interest: ['new_debt_floating_share', 'hedge_ratio_new'],
    liquidity: ['capex', 'equity_funding_share'] };
  const CAP_SWAP = { revenue_growth: 'revenue_per_mw_shift', capex: 'capex_per_mw', cost_of_revenue_pct: 'cor_per_mw' };
  // The metrics the tornado, grid and breakevens offer; `row` ones take a year.
  const METRICS = [
    { key: 'value_per_share', label: 'Value per share', unit: 'US$', dp: 2, good: 1, what: 'value per share' },
    { key: 'revenue', row: true, label: 'revenue', unit: 'US$m', dp: 0, good: 1 },
    { key: 'net_income', row: true, label: 'net income', unit: 'US$m', dp: 0, good: 1 },
    { key: 'eps', row: true, label: 'EPS', unit: 'US$', dp: 2, good: 1 },
    { key: 'ebitda', row: true, label: 'adj. EBITDA', unit: 'US$m', dp: 0, good: 1 },
    { key: 'interest', row: true, label: 'interest expense', unit: 'US$m', dp: 0, good: -1 },
    { key: 'interest_to_ebitda', row: true, label: 'interest as % of adj. EBITDA', unit: '%', dp: 1, good: -1 },
    { key: 'floating_share_of_interest', row: true, label: 'floating share of interest', unit: '%', dp: 1, good: 0 },
    { key: 'interest_cover', row: true, label: 'interest cover (x)', unit: 'x', dp: 2, good: 1 },
    { key: 'gross_debt_ebitda', row: true, label: 'total debt / EBITDA', unit: 'x', dp: 2, good: -1 },
    { key: 'net_debt_ebitda', row: true, label: 'net debt / EBITDA', unit: 'x', dp: 2, good: -1 },
    { key: 'fcf', row: true, label: 'free cash flow', unit: 'US$m', dp: 0, good: 1 },
    { key: 'liquidity', row: true, label: 'liquidity (cash + undrawn committed)', unit: 'US$m', dp: 0, good: 1 },
    { key: 'funding_cum', row: true, label: 'funding raised (cumulative)', unit: 'US$m', dp: 0, good: 0 },
    { key: 'uncommitted_cum', row: true, label: 'uncommitted funding need (cumulative)', unit: 'US$m', dp: 0, good: 0 },
  ];
  // What a moved capacity / unit-cost / financing driver does, shown under its slider:
  // [row, name, unit] read for the KPI year against the base case.
  const EFFECT_ROWS = {
    delivery_delay_months: [['active_mw_end', 'year-end MW', 'MW'], ['revenue', 'revenue', 'US$m']],
    extra_capacity_mw: [['active_mw_end', 'year-end MW', 'MW'], ['revenue', 'revenue', 'US$m']],
    utilization: [['utilization_avg', 'billing', '%'], ['revenue', 'revenue', 'US$m']],
    revenue_per_mw_shift: [['revenue_per_billing_mw', 'price per MW', 'US$m2'], ['revenue', 'revenue', 'US$m']],
    renewal_price_reset: [['renewal_effect', 'renewals', 'US$m'], ['revenue', 'revenue', 'US$m']],
    cor_per_mw: [['cor_per_mw_eff', 'cost per MW', 'US$m2'], ['gross_margin', 'gross margin', '%']],
    power_cost_shift: [['power_cost', 'power', 'US$m'], ['gross_margin', 'gross margin', '%']],
    capex_per_mw: [['capex', 'capex', 'US$m']],
    self_build_share: [['rent', 'rent', 'US$m'], ['capex_self_build', 'shell capex', 'US$m']],
    new_debt_floating_share: [['floating_share_of_interest', 'floating interest', '%']],
    hedge_ratio_new: [['floating_share_of_interest', 'floating interest', '%']],
    useful_life: [['da', 'D&A', 'US$m'], ['net_income', 'net income', 'US$m']],
  };
  // driver groups with a live revenue / margin line on top (capacity_v1)
  const GROUP_LINE = { 'Capacity & delivery': 'revenue', 'Pricing & mix': 'revenue', 'Unit costs': 'costs' };
  // Stub-year actuals behind a row (for a quarterly guide inside the stub year).
  const ACTUAL_KEY = { revenue: 'revenue', cost_of_revenue: 'cost_of_revenue', interest: 'interest', capex: 'capex', ocf: 'ocf', da: 'da', sbc: 'sbc' };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const sum = a => a.reduce((s, x) => s + (isNum(x) ? x : 0), 0);
  const str = v => (v == null ? '' : String(v));
  const doc = () => document;
  let UID = 0;

  // ---------------- formatting (pure) ----------------
  // fmt(1234.5, 'US$m', 0) -> 'US$1,235m'; fmt(-0.4, '%', 1, true) -> '−0.4%'; null -> '—'.
  // A value that rounds to zero carries no sign (never '−0'). One cached formatter per number of
  // decimals: toLocaleString with options builds a new one on every call (~50x slower).
  const NF = [];
  const nf = d => NF[d] || (NF[d] = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
  function fmt(v, unit, dp, signed) {
    if (!isNum(v)) return '—';
    const d = Number.isInteger(dp) ? Math.max(0, Math.min(6, dp)) : 1;
    const n = nf(d).format(Math.abs(v));
    const zero = Math.abs(v) < 0.5 * Math.pow(10, -d);
    const s = zero ? '' : v < 0 ? MINUS : signed ? '+' : '';
    switch (unit) {
      case 'US$m': return `${s}US$${n}m`;
      case 'US$bn': return `${s}US$${n}bn`;
      case 'US$': return `${s}US$${n}`;
      case '%': return `${s}${n}%`;
      case 'pp': return `${s}${n} pp`;
      case 'bp': return `${s}${n} bp`;
      case 'x': return `${s}${n}x`;
      case 'yrs': return `${s}${n} yrs`;
      case 'm': return `${s}${n}m`;
      case 'months': return `${s}${n} mo`;
      case 'MW': return `${s}${n} MW`;
      default: return s + n;
    }
  }
  // A probability (0–1) as a whole percentage: '35%'; below 1% one decimal ('0.4%').
  function pctP(p) {
    if (!isNum(p)) return '—';
    const v = p * 100;
    return v > 0 && v < 1 ? `${v.toFixed(1)}%` : `${Math.round(v)}%`;
  }
  // P(X < x) from a histogram {edges, probs} (linear within the straddling bin): an estimate
  // whenever x falls inside a bin that holds probability.
  function pBelow(hist, x) {
    if (!hist || !Array.isArray(hist.edges) || hist.edges.length < 2 || !isNum(x)) return null;
    const e = hist.edges, p = hist.probs;
    if (x <= e[0]) return 0;
    if (x > e[e.length - 1]) return 1;
    let s = 0;
    for (let k = 0; k < p.length; k++) {
      if (e[k + 1] <= x) s += p[k];
      else { if (x > e[k]) s += p[k] * (x - e[k]) / ((e[k + 1] - e[k]) || 1); break; }
    }
    return Math.min(1, Math.max(0, s));
  }
  // Average active MW of a calendar year from a revenue_model's month-end path (linear between
  // the anchors, flat outside them; a month counts the mean of its opening and closing MW, as
  // the engine does). For the bridge from the last reported year, which the projection does
  // not cover. null without a usable path.
  function yearAvgMW(rm, year) {
    if (!rm || typeof rm !== 'object' || !rm.active_mw_path || typeof rm.active_mw_path !== 'object') return null;
    const mi = k => { const m = /^(\d{4})(?:-(\d{2}))?/.exec(str(k)); return m ? +m[1] * 12 + (m[2] ? +m[2] : 12) : null; };
    const pts = Object.entries(rm.active_mw_path).map(([k, v]) => [/^\d{4}$/.test(k) ? +k * 12 + 12 : /^\d{4}-\d{2}$/.test(k) ? mi(k) : null, v])
      .filter(([m, v]) => m !== null && isNum(v));
    if (rm.opening && isNum(rm.opening.active_mw) && mi(rm.opening.date) !== null) pts.push([mi(rm.opening.date), rm.opening.active_mw]);
    if (!pts.length) return null;
    pts.sort((a, b) => a[0] - b[0]);
    const A = m => {
      if (m <= pts[0][0]) return pts[0][1];
      for (let i = 1; i < pts.length; i++) if (m <= pts[i][0]) return pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * (m - pts[i - 1][0]) / ((pts[i][0] - pts[i - 1][0]) || 1);
      return pts[pts.length - 1][1];
    };
    let s = 0;
    for (let m = year * 12 + 1; m <= year * 12 + 12; m++) s += (A(m - 1) + A(m)) / 2;
    return s / 12;
  }
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const monthText = s => { const m = /^(\d{4})-(\d{2})/.exec(str(s)); return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]} ${m[1]}` : str(s); };
  // Money in the headline tiles: US$m below a billion, US$bn above.
  function money(v, signed) {
    if (!isNum(v)) return '—';
    const a = Math.abs(v);
    return a >= 1000 ? fmt(v / 1000, 'US$bn', a >= 100000 ? 0 : a >= 10000 ? 1 : 2, signed) : fmt(v, 'US$m', 0, signed);
  }
  // Axis ticks: short, no trailing zeros ('US$250m', 'US$1bn', 'US$1.5bn').
  function tickMoney(v) {
    if (!isNum(v)) return '';
    const a = Math.abs(v), s = v < 0 ? MINUS : '';
    return a >= 1000 ? `${s}US$${+(a / 1000).toFixed(2)}bn` : `${s}US$${+a.toFixed(1)}m`;
  }
  // A change in a row's unit: a % row moves in percentage points.
  const deltaUnit = u => (u === '%' ? 'pp' : u);
  // Tone of a change: 'pos' (good for the shareholder), 'neg', 'chg' (a change that is neither,
  // e.g. capex) or 'flat' (no change).
  function tone(delta, good, eps) {
    if (!isNum(delta) || Math.abs(delta) <= (eps || 1e-9)) return 'flat';
    if (!good) return 'chg';
    return delta * good > 0 ? 'pos' : 'neg';
  }
  const arrow = t => (t === 'pos' ? '▲' : t === 'neg' ? '▼' : t === 'chg' ? '◆' : '•');

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  // Axis covering [lo, hi] (and zero when `zero`), in nice ticks.
  function scale(values, zero, target) {
    const nums = values.filter(isNum);
    let lo = nums.length ? Math.min(...nums) : 0, hi = nums.length ? Math.max(...nums) : 1;
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (lo === hi) { hi = lo + 1; if (!zero) lo -= 1; }
    const step = niceStep(hi - lo, target || 4);
    lo = Math.floor(lo / step + 1e-9) * step || 0;
    hi = Math.ceil(hi / step - 1e-9) * step || 0;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12) || 0);
    return { lo, hi, step, ticks };
  }
  // Grid axis: n points from lo to hi on the driver's step, plus the current value; sorted, unique.
  function axisValues(d, cur, n) {
    const lo = isNum(d.low) ? d.low : d.min, hi = isNum(d.high) ? d.high : d.max;
    const k = Math.max(2, n || 7), out = [];
    const snap = v => +(Math.round(v / d.step) * d.step).toPrecision(10);
    for (let i = 0; i < k; i++) out.push(snap(lo + (hi - lo) * i / (k - 1)));
    if (isNum(cur)) out.push(+cur.toPrecision(10));
    return [...new Set(out.map(v => Math.min(d.max, Math.max(d.min, v))))].sort((a, b) => a - b);
  }
  // A name inside a sentence: only the first letter drops to lower case, never an acronym's
  // ("Boom: AI capex …" -> "boom: AI capex …", "From Nov 2026" -> "from Nov 2026", "GPU life" kept).
  const inSentence = t => { const s = str(t); return /^[A-Z][A-Z0-9]/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1); };
  // A driver's name inside a sentence: "SOFR shift" -> "SOFR", "Capex" -> "capex".
  function driverNoun(label) {
    return inSentence(str(label).replace(/\s+shift$/i, ''));
  }
  // "A 200 bp rise in SOFR", "20% more capex", "Depreciation life at 4.0 yrs (now 6.0 yrs)".
  function moveText(d, from, to) {
    const diff = to - from, noun = driverNoun(d.label);
    if (d.kind === 'shift_bp' || d.kind === 'shift_pp') return `A ${fmt(Math.abs(diff), d.unit, d.dp)} ${diff > 0 ? 'rise' : 'fall'} in ${noun}`;
    if (d.kind === 'scale_pct') return `${fmt(Math.abs(diff), '%', 0)} ${diff > 0 ? 'more' : 'less'} ${noun}`;
    return `${str(d.label)} at ${fmt(to, d.unit, d.dp)} (now ${fmt(from, d.unit, d.dp)})`;
  }
  // Top-5 plain-English lines from a tornado (the side that moves the metric most). A business
  // event bar reads as switching it: on when it is off, off when it is on.
  function keyDriverLines(sens, drivers, what, unit, probOf) {
    if (!sens || sens.error || !isNum(sens.base)) return [];
    const byId = new Map(drivers.map(d => [d.id, d]));
    const amtOf = x => (unit === 'US$m' ? money(x) : fmt(x, unit, unit === 'x' ? 1 : 2));
    return sens.bars.filter(b => isNum(b.swing) && b.swing > 1e-9).slice(0, 5).map(b => {
      if (b.type === 'event') {
        const on = b.current === 1, v = on ? b.v_low : b.v_high, delta = v - sens.base;
        if (!isNum(v)) return null;
        const pr = probOf ? probOf(b.id) : b.prob;
        const lead = on ? `Without “${str(b.label)}” (switched on now)` : `“${str(b.label)}” (${b.kind === 'upside' ? 'upside' : b.kind === 'strategic' ? 'strategic choice' : 'risk'}, ${pctP(pr)} likely), if it happens,`;
        return { id: b.id, delta, event: true, text: `${lead} ${delta < 0 ? 'cuts' : 'lifts'} ${what} by ${amtOf(Math.abs(delta))} (to ${amtOf(v)}).` };
      }
      const d = byId.get(b.id);
      const dl = isNum(b.v_low) ? b.v_low - sens.base : 0, dh = isNum(b.v_high) ? b.v_high - sens.base : 0;
      const useHigh = Math.abs(dh) >= Math.abs(dl);
      const to = useHigh ? b.high : b.low, v = useHigh ? b.v_high : b.v_low, delta = v - sens.base;
      if (!d || Math.abs(to - b.current) < 1e-12) return null;
      return { id: b.id, delta, text: `${moveText(d, b.current, to)} ${delta < 0 ? 'cuts' : 'lifts'} ${what} by ${amtOf(Math.abs(delta))} (to ${amtOf(v)}).` };
    }).filter(Boolean);
  }
  // An event's impacts in words, from the template's impact vocabulary: ["MW come online later
  // (months): +3 mo", "Capex added (US$m): FY27 +US$7.5bn · FY28 −US$4.0bn", ...].
  function impactLines(ev, vocab, customers) {
    const out = [], I = ev && ev.impacts && typeof ev.impacts === 'object' ? ev.impacts : {};
    const cname = id => { const c = (customers || []).find(x => x.id === id); return c ? str(c.name) : str(id); };
    const val = (x, unit) => (unit === 'US$m' ? money(x, true) : fmt(x, unit, unit === 'pp' || unit === 'yrs' ? 1 : 0, true));
    for (const k of Object.keys(I)) {
      const T0 = vocab && vocab[k] ? vocab[k] : { label: k, unit: '', type: 'num' }, x = I[k];
      // the value carries its unit, so the label drops its "(US$m)" / "(months)"
      const T = Object.assign({}, T0, { label: str(T0.label).replace(/\s*\((US\$m|months|MW|yrs)\)$/, '') });
      if (k === 'customer_cut') {
        for (const c of [].concat(x)) if (c && typeof c === 'object') out.push(`${cname(c.customer)} cancels ${pctP(c.pct)} of its contracted revenue${c.from ? ` from ${monthText(c.from)}` : ''}`
          + (isNum(c.relet_pct) ? `; the capacity idles ${fmt(c.idle_months, '', 0)} months, then re-lets ${fmt(c.relet_pct, '%', 0, true)}` : '; the capacity stays idle'));
      } else if (k === 'capacity_released') {
        for (const c of [].concat(x)) if (c && typeof c === 'object') out.push(`${fmt(c.mw, 'MW', 0)} come off contract and are not renewed, ${monthText(c.from)} to ${monthText(c.to)}`
          + (isNum(c.relet_pct) ? `; idle ${fmt(c.idle_months, '', 0)} months, then re-let ${fmt(c.relet_pct, '%', 0, true)}` : '; not re-let'));
      } else if (k === 'delay_share' || k === 'capex_ahead') {
        out.push(k === 'delay_share' ? `The delay touches ${pctP(x)} of the new MW` : `${pctP(x)} of the delayed GPU capex is spent on the original schedule`);
      } else if (T.type === 'year_map' && x && typeof x === 'object') {
        const parts = Object.keys(x).sort().map(y => `FY${String(y).slice(-2)} ${k === 'new_debt_cap' ? money(x[y]) : val(x[y], T.unit)}`);
        if (parts.length) out.push(`${T.label}: ${parts.join(' · ')}`);
      } else if (isNum(x)) out.push(`${T.label}: ${val(x, T.unit)}`);
    }
    return out;
  }
  // A quarterly / annual guide vs the model: 'YYYY-Qn' inside the stub year = the projected
  // remainder spread evenly over its quarters; a later year = FY / 4; 'YYYY' = FY.
  function guideValue(res, spec, g) {
    if (!res || res.error || !g || typeof g.metric !== 'string' || !Array.isArray(res.rows[g.metric])) return null;
    const m = /^(\d{4})(?:-Q([1-4]))?$/.exec(str(g.period));
    if (!m) return null;
    const y = +m[1], i = res.years.indexOf(y);
    if (i < 0) return null;
    const fy = res.rows[g.metric][i];
    if (!isNum(fy)) return null;
    if (!m[2]) return fy;
    const stub = spec && spec.stub;
    if (stub && stub.year === y && Number.isInteger(stub.actual_months)) {
      const q = +m[2], doneQ = stub.actual_months / 3, leftQ = 4 - doneQ;
      const key = ACTUAL_KEY[g.metric], act = stub.actuals && key ? stub.actuals[key] : null;
      if (q <= doneQ || !(leftQ > 0) || !isNum(act)) return null;
      return (fy - act) / leftQ;
    }
    return fy / 4;
  }

  // ---------------- DOM builders (createElement / textContent only) ----------------
  function put(el, attrs, kids) {
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat(3)) {
      if (k == null || k === false) continue;
      el.appendChild(typeof k === 'object' ? k : doc().createTextNode(String(k)));
    }
    return el;
  }
  const h = (tag, attrs, ...kids) => put(doc().createElement(tag), attrs, kids);
  const sv = (tag, attrs, ...kids) => put(doc().createElementNS(SVG_NS, tag), attrs, kids);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  const f1 = v => (+v).toFixed(1);
  // Without Reports.richText: citations stay readable text.
  const plainRich = { inline: t => [doc().createTextNode(str(t))], cite: ids => doc().createTextNode(` [${[].concat(ids).join(', ')}]`) };

  // ---------------- charts (inline SVG) ----------------
  // Lines over years: zero-based y axis, 2px lines, end-of-line labels nudged apart.
  function lineChart({ id, title, desc, labels, series, unit, dp }) {
    const sc = scale(series.flatMap(s => s.values), true, 4);
    const tickTxt = sc.ticks.map(t => fmt(t, unit, sc.step < 1 ? 1 : 0));
    // the y-axis gutter fits its longest tick label ("6,000 MW" clips at 46px)
    const W = Math.max(540, 160 + labels.length * 90), H = 240, padL = Math.max(46, Math.ceil(12 + 5.8 * Math.max(0, ...tickTxt.map(t => t.length)))), padR = 160, padT = 14, padB = 28;
    const pw = W - padL - padR, ph = H - padT - padB;
    const x = i => padL + (labels.length === 1 ? pw / 2 : i * pw / (labels.length - 1));
    const y = v => padT + (sc.hi - v) / (sc.hi - sc.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    sc.ticks.forEach((t, k) => {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, tickTxt[k]));
    });
    labels.forEach((l, i) => svg.appendChild(sv('text', { x: f1(x(i)), y: H - 9, 'text-anchor': 'middle', class: 'mdl-xl' }, l)));
    const ends = [];
    for (const s of series) {
      const pts = s.values.map((v, i) => (isNum(v) ? [x(i), y(v), v, i] : null)).filter(Boolean);
      if (!pts.length) continue;
      svg.appendChild(sv('polyline', { points: pts.map(p => `${f1(p[0])},${f1(p[1])}`).join(' '), fill: 'none', stroke: s.color,
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dash ? '5 4' : null, opacity: s.faint ? 0.75 : null }));
      for (const p of pts) {
        svg.appendChild(sv('circle', { cx: f1(p[0]), cy: f1(p[1]), r: s.dash ? 3 : 4, fill: s.dash ? 'var(--rpt-panel)' : s.color, stroke: s.dash ? s.color : 'var(--rpt-panel)', 'stroke-width': 2 },
          sv('title', null, `${labels[p[3]]} · ${s.name}: ${fmt(p[2], unit, dp)}`)));
      }
      const last = pts[pts.length - 1];
      ends.push({ y: last[1], x: last[0], text: `${s.short || s.name} ${fmt(last[2], unit, dp)}` });
    }
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    for (const e of ends) svg.appendChild(sv('text', { x: f1(e.x + 8), y: f1(e.y + 3.5), class: 'mdl-end' }, e.text));
    return svg;
  }

  // Stacked columns (non-negative parts), 2px surface gap between segments; `marks` are
  // reference ranges drawn as a bracket beside a column ({i, lo, hi, label}); `sub` is a
  // second, smaller line under each column's label (e.g. "62% contracted").
  function stackedBars({ id, title, desc, labels, series, unit, marks, sub }) {
    const W = Math.max(480, 130 + labels.length * 84), padL = 66, padR = 16, padT = 22, padB = sub ? 42 : 28, H = 222 + padB;
    const totals = labels.map((_, j) => series.reduce((s, x) => s + (isNum(x.values[j]) ? Math.max(0, x.values[j]) : 0), 0));
    const sc = scale(totals.concat((marks || []).flatMap(m => [m.lo, m.hi])), true, 4);
    const pw = W - padL - padR, ph = H - padT - padB, gw = pw / Math.max(1, labels.length), bw = Math.min(24, gw * 0.5);
    const y = v => padT + (sc.hi - v) / (sc.hi - sc.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    for (const t of sc.ticks) {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, tickMoney(t)));
    }
    // a column with a guide bracket puts its total above the bracket, so the two never collide
    const markTop = new Map();
    for (const m of marks || []) if (isNum(m.lo) && isNum(m.hi)) markTop.set(m.i, Math.min(markTop.has(m.i) ? markTop.get(m.i) : Infinity, y(Math.max(m.lo, m.hi))));
    labels.forEach((l, j) => {
      const cx = padL + gw * (j + 0.5), x0 = cx - bw / 2;
      let acc = 0;
      for (const s of series) {
        const v = isNum(s.values[j]) ? Math.max(0, s.values[j]) : 0;
        if (v <= 0) continue;
        const top = y(acc + v), bot = y(acc), hgt = Math.max(0.6, bot - top - (acc > 0 ? 2 : 0));
        svg.appendChild(sv('rect', { x: f1(x0), y: f1(top), width: f1(bw), height: f1(hgt), fill: s.color },
          sv('title', null, `${l} · ${s.name}: ${fmt(v, unit, 0)}`)));
        acc += v;
      }
      if (acc > 0) svg.appendChild(sv('text', { x: f1(cx), y: f1(Math.min(y(acc), markTop.has(j) ? markTop.get(j) - 4 : Infinity) - 5), 'text-anchor': 'middle', class: 'mdl-val' }, money(acc)));
      svg.appendChild(sv('text', { x: f1(cx), y: H - (sub ? 23 : 9), 'text-anchor': 'middle', class: 'mdl-xl' }, l));
      if (sub && sub[j]) svg.appendChild(sv('text', { x: f1(cx), y: H - 9, 'text-anchor': 'middle', class: 'mdl-tick' }, sub[j]));
    });
    for (const m of marks || []) {
      if (!isNum(m.lo) || !isNum(m.hi)) continue;
      const bx = padL + gw * (m.i + 0.5) + bw / 2 + 6, y1 = y(Math.max(m.lo, m.hi)), y2 = y(Math.min(m.lo, m.hi));
      svg.appendChild(sv('path', { d: `M${f1(bx + 5)} ${f1(y1)}H${f1(bx)}V${f1(Math.max(y2, y1 + 2))}H${f1(bx + 5)}`, class: 'mdl-mark' },
        sv('title', null, `${m.label}: ${fmt(m.lo, unit, 0)}–${fmt(m.hi, unit, 0)}`)));
      svg.appendChild(sv('text', { x: f1(bx + 9), y: f1(Math.max(y2, y1 + 2) + 3.5), class: 'mdl-markt' }, 'Guide'));
    }
    return svg;
  }

  // Tornado: one row per driver, bars from the current value to the metric at the driver's
  // low (blue) and high (amber) end; a business event is one bar from the current value to the
  // metric with the event switched (pink = a risk, teal = an upside; outlined when it is on
  // now and the bar shows it switched off). Sorted by swing (the engine's order).
  function tornado({ id, sens, drivers, unit, dp, title, max, probOf }) {
    // drivers that leave the metric unchanged are listed under the chart instead
    const bars = sens.bars.filter(b => isNum(b.v_low) && isNum(b.v_high) && b.swing > 1e-9).slice(0, max || 12);
    // padL fits a 26-character name at 11.5px; 76px each side fits a bold 'US$24,781m' end label
    const W = 720, rowH = 30, padL = 196, padT = 22, padB = 10, H = padT + padB + Math.max(1, bars.length) * rowH;
    const plotL = padL + 76, plotR = W - 76;                    // room for the end-value labels
    const byId = new Map(drivers.map(d => [d.id, d]));
    const vals = bars.flatMap(b => [b.v_low, b.v_high]).concat([sens.base]);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || Math.abs(sens.base) || 1;
    const x = v => plotL + (v - (lo - span * 0.02)) / (span * 1.04) * (plotR - plotL);
    const evDesc = b => `${b.kind === 'upside' ? 'Upside' : 'Risk'} “${b.label}”: ${fmt(b.v_low, unit, dp)} off, ${fmt(b.v_high, unit, dp)} on`;
    const desc = bars.map(b => (b.type === 'event' ? evDesc(b) : `${b.label}: ${fmt(b.v_low, unit, dp)} at ${fmt(b.low, b.unit)} to ${fmt(b.v_high, unit, dp)} at ${fmt(b.high, b.unit)}`)).join('; ');
    const svg = sv('svg', { class: 'mdl-svg mdl-tornado', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc || 'No driver moves this metric.'));
    const bx = x(sens.base);
    svg.appendChild(sv('text', { x: f1(bx), y: 12, 'text-anchor': 'middle', class: 'mdl-tick' }, `Now ${fmt(sens.base, unit, dp)}`));
    bars.forEach((b, i) => {
      const d = byId.get(b.id) || b, cy = padT + i * rowH + rowH / 2;
      const full = b.type === 'event' && b.short_label ? str(b.short_label) : str(b.label);
      const name = full.length > 26 ? full.slice(0, 25) + '…' : full;
      if (b.type === 'event') {
        // one bar: the metric with the event switched from its current state
        const on = b.current === 1, v = on ? b.v_low : b.v_high, c = b.kind === 'upside' ? C_UP : C_RISK;
        svg.appendChild(sv('text', { x: padL - 8, y: f1(cy - 2), 'text-anchor': 'end', class: 'mdl-tl mdl-tl-ev' }, name, sv('title', null, str(b.label))));
        svg.appendChild(sv('text', { x: padL - 8, y: f1(cy + 10), 'text-anchor': 'end', class: 'mdl-tick' },
          `${b.kind === 'upside' ? 'upside' : b.kind === 'strategic' ? 'strategic' : 'risk'} · ${on ? 'on → off' : 'off → on'} · ${pctP(probOf ? probOf(b.id) : b.prob)}`));
        const x1 = Math.min(bx, x(v)), w = Math.abs(x(v) - bx);
        svg.appendChild(sv('rect', { x: f1(x1), y: f1(cy - 7), width: f1(Math.max(0.8, w)), height: 14, rx: 3, fill: on ? 'none' : c, stroke: c, 'stroke-width': on ? 2 : null,
          'stroke-dasharray': on ? '4 3' : null, class: 'mdl-evbar' }, sv('title', null, `${str(b.label)} ${on ? 'switched off' : 'switched on'}: ${fmt(v, unit, dp)}`)));
        svg.appendChild(sv('text', { x: f1(v < sens.base ? x1 - 4 : x1 + w + 4), y: f1(cy + 3.5), 'text-anchor': v < sens.base ? 'end' : null, class: 'mdl-val' }, fmt(v, unit, dp)));
        return;
      }
      svg.appendChild(sv('text', { x: padL - 8, y: f1(cy - 2), 'text-anchor': 'end', class: 'mdl-tl' }, name));
      svg.appendChild(sv('text', { x: padL - 8, y: f1(cy + 10), 'text-anchor': 'end', class: 'mdl-tick' },
        `${fmt(b.low, b.unit, d.dp)} → ${fmt(b.high, b.unit, d.dp)}`));
      for (const [v, c, side, at] of [[b.v_low, C_LOW, 'low', b.low], [b.v_high, C_HIGH, 'high', b.high]]) {
        const x1 = Math.min(bx, x(v)), w = Math.abs(x(v) - bx);
        svg.appendChild(sv('rect', { x: f1(x1), y: f1(cy - 7), width: f1(Math.max(0.8, w)), height: 14, rx: 3, fill: c },
          sv('title', null, `${b.label} at its ${side} end (${fmt(at, b.unit, d.dp)}): ${fmt(v, unit, dp)}`)));
      }
      const left = Math.min(b.v_low, b.v_high), right = Math.max(b.v_low, b.v_high);
      if (Math.abs(right - left) > 1e-9) {
        svg.appendChild(sv('text', { x: f1(Math.min(x(left), bx) - 4), y: f1(cy + 3.5), 'text-anchor': 'end', class: 'mdl-val' }, fmt(left, unit, dp)));
        svg.appendChild(sv('text', { x: f1(Math.max(x(right), bx) + 4), y: f1(cy + 3.5), class: 'mdl-val' }, fmt(right, unit, dp)));
      }
    });
    svg.appendChild(sv('line', { x1: f1(bx), x2: f1(bx), y1: padT - 4, y2: H - padB + 4, class: 'mdl-zero' }));
    return svg;
  }

  // Waterfall: a starting total, signed steps (green adds, red subtracts) and the resulting total;
  // dashed connectors carry the running total from one column to the next. steps: [{label, sub?,
  // value, total?: true}] — a total starts a new column from zero.
  function waterfall({ id, title, desc, steps }) {
    const n = Math.max(1, steps.length), W = Math.max(520, 90 + n * 92), H = 276, padL = 66, padR = 14, padT = 22, padB = 44;
    let run = 0;
    const segs = steps.map(s => {
      const v = isNum(s.value) ? s.value : 0;
      if (s.total) { run = v; return { a: 0, b: v }; }
      const a = run;
      run += v;
      return { a, b: run };
    });
    const sc = scale(segs.flatMap(s => [s.a, s.b]), true, 4);
    const pw = W - padL - padR, ph = H - padT - padB, gw = pw / n, bw = Math.min(44, gw * 0.56);
    const y = v => padT + (sc.hi - v) / (sc.hi - sc.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg mdl-wf', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    for (const t of sc.ticks) {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, tickMoney(t)));
    }
    steps.forEach((s, i) => {
      const { a, b } = segs[i], cx = padL + gw * (i + 0.5), x0 = cx - bw / 2;
      const top = y(Math.max(a, b)), hgt = Math.max(1, Math.abs(y(a) - y(b)));
      const fill = s.total ? (b < 0 ? C_LIMIT : C_LOW) : b >= a ? '#34d399' : C_LIMIT;
      svg.appendChild(sv('rect', { x: f1(x0), y: f1(top), width: f1(bw), height: f1(hgt), rx: 2, fill, opacity: s.total ? null : 0.9, class: s.total ? 'mdl-wf-total' : 'mdl-wf-step' },
        sv('title', null, `${str(s.label)}: ${s.total ? money(s.value) : money(s.value, true)}`)));
      const up = s.total ? b >= 0 : b >= a;
      svg.appendChild(sv('text', { x: f1(cx), y: f1(up ? top - 5 : top + hgt + 12), 'text-anchor': 'middle', class: 'mdl-val' }, s.total ? money(s.value) : money(s.value, true)));
      if (i < steps.length - 1 && !steps[i + 1].total) {
        svg.appendChild(sv('line', { x1: f1(x0 + bw), x2: f1(x0 + gw), y1: f1(y(b)), y2: f1(y(b)), class: 'mdl-wf-link' }));
      }
      svg.appendChild(sv('text', { x: f1(cx), y: H - 25, 'text-anchor': 'middle', class: 'mdl-xl' }, str(s.label)));
      if (s.sub) svg.appendChild(sv('text', { x: f1(cx), y: H - 11, 'text-anchor': 'middle', class: 'mdl-tick' }, str(s.sub)));
    });
    return svg;
  }

  // Histogram of a probability distribution ({edges, probs} from ModelEngine.distribution):
  // columns left of `split` (the share price, or zero) in red, right of it in blue; `marks`
  // are labelled vertical lines ({v, label, strong}).
  function histogram({ id, title, desc, hist, unit, dp, split, marks }) {
    const W = 680, H = 248, padL = 44, padR = 28, padT = 46, padB = 26;
    const e = hist && Array.isArray(hist.edges) ? hist.edges : [], p = hist && Array.isArray(hist.probs) ? hist.probs : [];
    const mk = (marks || []).filter(m => isNum(m.v));
    let lo = Math.min(...e.concat(mk.map(m => m.v))), hi = Math.max(...e.concat(mk.map(m => m.v)));
    if (!isNum(lo) || !isNum(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-9) { const pad = Math.max(1, Math.abs(lo) * 0.1); lo -= pad; hi += pad; }
    const xs = scale([lo, hi], false, 5), span = xs.hi - xs.lo || 1;
    const pw = W - padL - padR, ph = H - padT - padB;
    const x = v => padL + (v - xs.lo) / span * pw;
    const ys = scale(p.map(v => v * 100), true, 3);
    const y = v => padT + (ys.hi - v) / (ys.hi - ys.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg mdl-hist', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    for (const t of ys.ticks) {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, `${+t.toFixed(1)}%`));
    }
    for (const t of xs.ticks) svg.appendChild(sv('text', { x: f1(x(t)), y: H - 8, 'text-anchor': 'middle', class: 'mdl-tick' }, unit === 'US$m' ? tickMoney(t) : fmt(t, unit, xs.step < 1 ? 1 : 0)));
    p.forEach((q, k) => {
      if (!(q > 0)) return;
      const a = e[k], b = isNum(e[k + 1]) ? e[k + 1] : a, mid = (a + b) / 2;
      const x0 = x(a), w = Math.max(6, x(b) - x(a) - 1.5), xx = b - a < 1e-9 ? x0 - w / 2 : x0 + 0.75;
      svg.appendChild(sv('rect', { x: f1(xx), y: f1(y(q * 100)), width: f1(w), height: f1(Math.max(0.8, y(0) - y(q * 100))), rx: 1.5,
        fill: isNum(split) && mid < split ? C_LIMIT : C_LOW, class: 'mdl-hbar' },
      sv('title', null, `${fmt(a, unit, dp)} to ${fmt(b, unit, dp)}: ${pctP(q)}`)));
    });
    // mark labels go on the first of three rows where they clear the previous label
    const rowEnd = [-1e9, -1e9, -1e9];
    mk.slice().sort((a, b) => a.v - b.v).forEach(m => {
      const xm = x(m.v), w = str(m.label).length * 5.8 + 8;
      const anchor = xm < padL + w / 2 ? 'start' : xm > W - padR - w / 2 ? 'end' : 'middle';
      const x0 = anchor === 'start' ? xm : anchor === 'end' ? xm - w : xm - w / 2;
      let row = rowEnd.findIndex(e => x0 > e + 4);
      if (row < 0) row = rowEnd.indexOf(Math.min(...rowEnd));
      rowEnd[row] = x0 + w;
      const ty = 12 + row * 12;
      svg.appendChild(sv('line', { x1: f1(xm), x2: f1(xm), y1: ty + 3, y2: f1(y(0)), class: m.strong ? 'mdl-hmark strong' : 'mdl-hmark' }));
      svg.appendChild(sv('text', { x: f1(xm), y: ty, 'text-anchor': anchor === 'middle' ? 'middle' : anchor, class: m.strong ? 'mdl-markt' : 'mdl-tick' }, m.label));
    });
    return svg;
  }

  // A watch-list sparkline: the model path by year against the threshold (dashed); years past
  // the threshold are drawn as filled dots.
  function sparkline({ values, threshold, crossed, title, positive }) {
    const W = 180, H = 46, pad = 6;
    const nums = values.filter(isNum).concat(isNum(threshold) ? [threshold] : []);
    if (!nums.length) return null;
    let lo = Math.min(...nums), hi = Math.max(...nums);
    if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
    const x = i => pad + (values.length === 1 ? (W - 2 * pad) / 2 : i * (W - 2 * pad) / (values.length - 1));
    const y = v => pad + (hi - v) / (hi - lo) * (H - 2 * pad);
    const svg = sv('svg', { class: 'mdl-spark', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': title });
    if (isNum(threshold)) svg.appendChild(sv('line', { x1: pad, x2: W - pad, y1: f1(y(threshold)), y2: f1(y(threshold)), class: 'mdl-spark-th' }));
    const pts = values.map((v, i) => (isNum(v) ? [x(i), y(v), i] : null)).filter(Boolean);
    if (pts.length > 1) svg.appendChild(sv('polyline', { points: pts.map(q => `${f1(q[0])},${f1(q[1])}`).join(' '), fill: 'none', stroke: C_LOW, 'stroke-width': 2, 'stroke-linejoin': 'round' }));
    const cc = positive ? '#34d399' : C_HIGH;
    for (const q of pts) svg.appendChild(sv('circle', { cx: f1(q[0]), cy: f1(q[1]), r: 3, fill: crossed && crossed[q[2]] ? cc : 'var(--rpt-panel)', stroke: crossed && crossed[q[2]] ? cc : C_LOW, 'stroke-width': 1.5 }));
    return svg;
  }

  const legend = items => h('div', { class: 'mdl-legend' }, items.map(([name, color, dash]) =>
    h('span', null, h('i', { class: dash ? 'dash' : null, style: dash ? `border-color:${color}` : `background:${color}` }), name)));
  // Legend above, the chart scrolling sideways in its own box on a narrow screen.
  const chartBox = (svg, ...extra) => {
    const t = svg.firstChild && svg.firstChild.textContent;
    return h('div', { class: 'mdl-chart' }, extra, h('div', { class: 'mdl-scroll', role: 'region', tabindex: '0', 'aria-label': t || 'Chart' }, svg));
  };

  // ---------------- the module ----------------
  function mount(el, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const E = o.engine || (typeof ModelEngine !== 'undefined' ? ModelEngine : null);
    const spec = o.model;
    const rich = o.rich && typeof o.rich.inline === 'function' ? o.rich : plainRich;
    // a long merged source list as several short citation groups, so it can wrap on a phone
    const citeWrap = ids => { const out = []; for (let i = 0; i < ids.length; i += 6) out.push(i ? ' ' : null, rich.cite(ids.slice(i, i + 6))); return out; };
    const links = o.links && typeof o.links === 'object' ? o.links : {};
    const noop = () => {};
    noop.setState = noop; noop.getState = () => '';
    clear(el);
    const fail = msg => { el.appendChild(h('div', { class: 'rpt-chart-na' }, msg)); return noop; };
    if (!E || !spec || typeof spec !== 'object') return fail('The stress-test model couldn’t load right now.');
    const v = E.validateSpec(spec);
    if (!v.ok) return fail('This model couldn’t be run: ' + v.errors.slice(0, 3).join('; '));

    const uid = `mdl${++UID}`;
    const D = E.drivers(spec), byId = new Map(D.map(d => [d.id, d]));
    const tpl = E.template(spec.template) || {};
    const RM = tpl.rows || {};
    const years = spec.years.slice();
    const stubbed = !!(spec.stub && spec.stub.year === years[0]);
    const KY = years[stubbed && years.length > 1 ? 1 : 0];              // first full projected year
    const XY = (spec.valuation && years.includes(spec.valuation.exit_year)) ? spec.valuation.exit_year : years[Math.min(2, years.length - 1)];
    const KYS = years.filter(y => y >= KY).slice(0, 2);                  // the KPI strip's year toggle
    const yl = y => `FY${String(y).slice(-2)}E`;
    const ylong = y => `FY${y}E`;
    const scen = Array.isArray(spec.scenarios) ? spec.scenarios.filter(s => s && typeof s.id === 'string') : [];
    // MODEL v2: revenue built from capacity (null for a growth-path spec), the business-event
    // catalogue, interest-rate swaps, the quarterly watch list
    const REV = E.revenueModel ? E.revenueModel(spec) : null, capMode = !!REV;
    const EVC = E.events ? E.events(spec) : { events: [], groups: [] };
    const EVS = EVC.events, evById = new Map(EVS.map(e => [e.id, e]));
    const HEDGES = E.hedges ? E.hedges(spec) : [];
    const VOCAB = tpl.event_impacts || {};
    const baseState = E.scenarioState ? E.scenarioState(spec, 'base') : null;
    const baseOv = (baseState && baseState.overrides) || E.applyScenario(spec, 'base') || {};
    const BASE = E.project(spec, baseOv);
    const BR = BASE.error ? {} : BASE.rows;                               // base-case rows (empty if the base cannot run)
    const BASE_W = E.weighted ? E.weighted(spec, baseOv, 'base') : null;
    const TABS = TAB_DEFS.filter(t => !t[2] || (t[2] === 'events' ? EVS.length > 0 : Array.isArray(BASE.watchlist) && BASE.watchlist.length > 0));
    // the scenarios each event belongs to (Bear = which business risks)
    const evScen = new Map(EVS.map(e => [e.id, scen.filter(s => Array.isArray(s.events) && s.events.includes(e.id)).map(s => str(s.name))]));
    // driver group as shown: owned vs leased (self_build_share) sits with the unit costs it trades off
    const grp = d => (capMode && d.id === 'self_build_share' ? 'Unit costs' : d.group);
    const tranches = (Array.isArray(spec.debt) ? spec.debt : []).filter(t => t && typeof t.id === 'string');
    const facilities = (spec.funding && Array.isArray(spec.funding.committed) ? spec.funding.committed : []).filter(x => x && typeof x.id === 'string');
    const guides = (Array.isArray(spec.guides) ? spec.guides : []).filter(g => g && typeof g === 'object').slice(0, 20);
    const cons = spec.consensus && typeof spec.consensus === 'object' && spec.consensus.rows && typeof spec.consensus.rows === 'object' ? spec.consensus : null;
    const consAt = (k, y) => (cons && cons.rows[k] && isNum(cons.rows[k][String(y)]) ? cons.rows[k][String(y)] : null);
    const PATHS = E.ratePaths ? E.ratePaths(spec) : [];
    const scenRuns = new Map();
    const pathD = byId.get('rate_path'), hasPaths = !!(pathD && pathD.max > 0 && PATHS.length > 1);
    const PATH_COLORS = [C_LOW, '#a78bfa', '#2dd4bf', '#f472b6', '#94a3b8'];
    const metricYears = years.filter(y => !(stubbed && y === years[0]));
    // a metric definition at a year: {key, metric, year, label, unit, dp, good, what}
    function mdef(key, year) {
      const m = METRICS.find(x => x.key === key) || METRICS[0];
      if (!m.row) return Object.assign({ metric: m.key, year: null }, m);
      const y = metricYears.includes(year) ? year : KY;
      return Object.assign({}, m, { metric: m.key, year: y, label: `${ylong(y)} ${m.label}`, what: `${ylong(y)} ${m.label.replace(/ \(x\)$/, '')}` });
    }
    // grid axes for a metric: the template defaults, with capacity drivers in place of the growth path
    function gridDefault(key) {
      const pick = id => (byId.has(id) ? id : byId.has(CAP_SWAP[id]) ? CAP_SWAP[id] : null);
      const dft = (GRID_DEFAULTS[key] || GRID_DEFAULTS.value_per_share).map(pick);
      const ids = D.filter(d => d.kind !== 'choice').map(d => d.id);
      const xg = dft[0] || ids[0], yg = dft[1] && dft[1] !== xg ? dft[1] : ids.find(id => id !== xg) || ids[0];
      return [xg, yg];
    }
    const G0 = gridDefault('value_per_share');
    // ev: the business events switched on ({id: 1}); probs: probabilities edited by the viewer
    // ({id: 0–1}); evMode: how the Risks & upsides tab reads them — 'base' (none on), 'custom'
    // (the switches as set) or 'weighted' (none on in the projection; each event counts at its
    // probability in the outcome distribution).
    const st = { ov: {}, ev: {}, probs: {}, evMode: 'base', lastCustom: {}, res: null, w: null, raf: 0, tab: 'pl', stale: new Set(TABS.map(t => t[0])), ky: KY, anchor: 'base',
      sens: { key: 'value_per_share', year: KY }, grid: { key: 'value_per_share', year: KY, x: G0[0], y: G0[1] },
      enc: '', slowT: 0, distT: 0, distTick: 0, distProg: 0, beSeq: 0, alive: true, refs: new Map(), dist: { key: null, val: null, job: null, last: null }, impKey: null, plSlowKey: null };

    // ---- state ----
    const evOn = () => Object.keys(st.ev).filter(id => st.ev[id] && evById.has(id));
    const probOf = id => (Object.prototype.hasOwnProperty.call(st.probs, id) ? st.probs[id] : evById.has(id) ? evById.get(id).prob : null);
    function decode(s) {
      const r = E.decodeState(spec, s || '');
      st.ov = r.ok ? r.overrides : {};
      st.ev = r.ok && r.events ? Object.assign({}, r.events) : {};
      st.probs = r.ok && r.probs ? Object.assign({}, r.probs) : {};
      const vw = r.ok && r.view ? r.view : {};
      st.evMode = evOn().length ? 'custom' : vw.mode === 'weighted' || st.evMode === 'weighted' ? 'weighted' : 'base';
      if (isNum(vw.year) && KYS.includes(vw.year)) st.ky = vw.year;
      st.anchor = E.matchScenario(spec, st.ov, st.ev) || 'base';
      if (s && (!r.ok || r.errors.length)) status(r.ok ? 'Some settings in this link were out of range or unknown and were adjusted.' : 'That model link could not be read; showing the base case.');
    }
    function setOv(next) { st.ov = E.cleanOverrides(spec, next); schedule(); }
    function setDriver(id, value) { const n = Object.assign({}, st.ov); n[id] = value; setOv(n); }
    // switch one event on / off; switching one on switches its mutually exclusive siblings off
    function setEvent(id, on) {
      const e = evById.get(id);
      if (!e) return;
      const n = {};
      for (const k of evOn()) if (k !== id && !(on && e.group && evById.get(k).group === e.group)) n[k] = 1;
      if (on) n[id] = 1;
      st.ev = n;
      st.evMode = 'custom';
      st.lastCustom = Object.assign({}, n);
      schedule();
    }
    function setMode(mode) {
      if (mode === st.evMode) return;
      if (st.evMode === 'custom') st.lastCustom = Object.assign({}, st.ev);
      st.evMode = mode;
      st.ev = mode === 'custom' ? Object.assign({}, st.lastCustom) : {};
      schedule();
    }
    function setProb(id, p) {
      const e = evById.get(id);
      if (!e || !isNum(p)) return;
      const q = Math.min(1, Math.max(0, p));
      if (Math.abs(q - e.prob) < 1e-9) delete st.probs[id]; else st.probs[id] = q;
      writeState();
      clearTimeout(st.distT);
      st.distT = setTimeout(() => { if (st.alive) { startDist(); if (st.tab === 'risk' && RK && !distNow()) renderDist(); } }, SLOW_MS + 150);
    }
    const cur = id => (Object.prototype.hasOwnProperty.call(st.ov, id) ? st.ov[id] : byId.has(id) ? byId.get(id).base : null);
    function schedule() {
      if (st.raf) return;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
      st.raf = raf(() => { st.raf = 0; if (st.alive) update(); });
    }
    function scheduleSlow() {
      clearTimeout(st.slowT);
      st.slowT = setTimeout(slow, SLOW_MS);
    }

    // ---- skeleton ----
    const statusEl = h('p', { class: 'mdl-status', role: 'status', 'aria-live': 'polite' });
    let statusT = 0;
    function status(msg) {
      statusEl.textContent = msg;
      clearTimeout(statusT);
      if (msg) statusT = setTimeout(() => { statusEl.textContent = ''; }, 6000);
    }
    const chips = h('div', { class: 'mdl-chips', role: 'group', 'aria-label': 'Scenarios' });
    const scenNote = h('p', { class: 'mdl-scen-note' });
    const chipEls = new Map();
    for (const s of scen) {
      const b = h('button', { type: 'button', class: `mdl-chip ${/^(bear|bull|base|restructuring)$/.test(s.id) ? s.id : ''}${s.representative ? ' rep' : ''}`, 'aria-pressed': 'false', 'data-mdl-scen': s.id,
        title: s.representative ? 'A representative outcome of the distribution' : 'A what-if' }, str(s.name || s.id));
      b.addEventListener('click', () => {
        // a preset is its drivers AND the business events it assumes
        const ss = E.scenarioState ? E.scenarioState(spec, s.id) : null;
        st.anchor = s.id;
        st.ev = ss && ss.events ? Object.assign({}, ss.events) : {};
        st.evMode = evOn().length ? 'custom' : 'base';
        if (st.evMode === 'custom') st.lastCustom = Object.assign({}, st.ev);
        setOv((ss && ss.overrides) || E.applyScenario(spec, s.id) || {});
        status(`${str(s.name)} scenario applied.`);
      });
      chipEls.set(s.id, b); chips.appendChild(b);
    }
    const customChip = h('span', { class: 'mdl-chip custom', hidden: true }, 'Custom');
    chips.appendChild(customChip);
    const resetBtn = h('button', { type: 'button', class: 'rpt-btn mdl-ctl', 'data-mdl-reset': '' }, 'Reset');
    resetBtn.addEventListener('click', () => {
      st.anchor = 'base'; st.ev = Object.assign({}, baseState && baseState.events); st.probs = {}; st.lastCustom = {};
      st.evMode = evOn().length ? 'custom' : 'base';
      setOv(baseOv); status('Back to the base case.');
    });
    const copyBtn = h('button', { type: 'button', class: 'rpt-btn mdl-ctl', 'data-mdl-copy': '' }, 'Copy link');
    const copyBox = h('input', { class: 'mdl-copybox', type: 'text', readonly: true, 'aria-label': 'Link to this scenario', hidden: true });
    copyBtn.addEventListener('click', copyLink);
    const fullLink = links.full && !o.standalone ? h('a', { class: 'mdl-full', href: links.full }, 'Open full-width ↗') : null;

    // the KPI strip's year toggle (FY+1 / FY+2)
    const kyBox = h('div', { class: 'mdl-kyr', role: 'group', 'aria-label': 'Year shown in the headline figures' });
    const kyBtns = new Map();
    if (KYS.length > 1) for (const y of KYS) {
      const b = h('button', { type: 'button', class: 'mdl-kybtn', 'aria-pressed': y === st.ky ? 'true' : 'false', 'data-mdl-ky': String(y) }, ylong(y));
      b.addEventListener('click', () => {
        st.ky = y;
        for (const [yy, bb] of kyBtns) bb.setAttribute('aria-pressed', yy === y ? 'true' : 'false');
        renderKpis(); renderMini(); syncDrivers(); writeState();
        // the bridges, the event cards and the distribution read this year too
        for (const [k] of TABS) st.stale.add(k);
        st.plSlowKey = null;
        if (!SLOW_TABS.has(st.tab)) renderPanel(st.tab);
        scheduleSlow();
      });
      kyBtns.set(y, b); kyBox.appendChild(b);
    }
    const kpis = h('div', { class: 'mdl-kpis', role: 'list', 'aria-label': 'Headline outputs' });
    const mini = h('div', { class: 'mdl-mini', 'aria-hidden': 'true' });      // phone: sticky echo of four KPIs
    const keyd = h('aside', { class: 'rpt-callout info mdl-keyd', role: 'note' });
    const drvPanel = h('div', { class: 'mdl-drivers', role: 'group', 'aria-label': 'Model drivers' });
    const tablist = h('div', { class: 'mdl-tabs', role: 'tablist', 'aria-label': 'Model views' });
    const panels = new Map(), tabBtns = new Map();
    for (const [k, label] of TABS) {
      const b = h('button', { type: 'button', role: 'tab', id: `${uid}-tab-${k}`, 'aria-controls': `${uid}-p-${k}`, 'aria-selected': k === st.tab ? 'true' : 'false',
        tabindex: k === st.tab ? '0' : '-1', class: 'mdl-tab', 'data-mdl-tab': k }, label);
      b.addEventListener('click', () => selectTab(k));
      b.addEventListener('keydown', e => {
        const i = TABS.findIndex(t => t[0] === k);
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = TABS.length - 1;
        if (j === null) return;
        e.preventDefault(); selectTab(TABS[j][0]); tabBtns.get(TABS[j][0]).focus();
      });
      tabBtns.set(k, b); tablist.appendChild(b);
      panels.set(k, h('div', { role: 'tabpanel', id: `${uid}-p-${k}`, 'aria-labelledby': `${uid}-tab-${k}`, class: 'mdl-panel', hidden: k !== st.tab, 'data-mdl-panel': k }));
    }
    function selectTab(k) {
      st.tab = k;
      for (const [t, b] of tabBtns) { b.setAttribute('aria-selected', t === k ? 'true' : 'false'); b.setAttribute('tabindex', t === k ? '0' : '-1'); }
      for (const [t, p] of panels) p.hidden = t !== k;
      if (st.stale.has(k)) renderPanel(k);
    }

    const printBox = h('div', { class: 'mdl-print', 'aria-hidden': 'true' });
    const asof = str(spec.asof);
    const root = h('section', { class: 'mdl', 'aria-label': 'Stress test and projections', 'data-mdl-slug': str(spec.slug) },
      h('div', { class: 'mdl-live' },
        h('header', { class: 'mdl-head' },
          h('div', null,
            h('h3', { class: 'mdl-title' }, 'Stress test & projections'),
            h('p', { class: 'mdl-sub' }, `Interactive ${years[0]}–${years[years.length - 1]} model · ${str(spec.currency || 'USD')} millions unless stated · drivers as of ${asof}`)),
          fullLink),
        h('div', { class: 'mdl-bar mdl-ctl' }, chips, h('div', { class: 'mdl-actions' }, resetBtn, copyBtn)),
        copyBox, scenNote, statusEl, KYS.length > 1 ? kyBox : null, kpis, mini, keyd,
        h('div', { class: 'mdl-body' },
          h('aside', { class: 'mdl-side mdl-ctl' }, h('h4', { class: 'mdl-h4' }, 'Drivers'),
            h('p', { class: 'mdl-hint' }, 'Move a slider or type a value; the tick marks the base case, the shaded band the stress range used by the tornado.',
              capMode ? ' Revenue is built from capacity — the MW a reader can track each quarter × the price per MW × the share billing — not from a growth rate.' : null,
              EVS.length ? [' Business risks and upsides are switched on in ', tabLink('risk', 'Risks & upsides'), '.'] : null),
            drvPanel),
          h('div', { class: 'mdl-main' }, tablist, [...panels.values()])),
        h('p', { class: 'mdl-disc' }, 'Illustrative model, not investment advice. It is a simplified projection of the company’s accounts: '
          + 'outputs are only as good as the drivers, which are our estimates and the cited public sources.')),
      printBox);
    el.appendChild(root);

    // ---- drivers ----
    const narrow = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    // with a revenue_model the business groups lead; "Revenue" then holds only customer prepayments
    const gOrder = (tpl.groups || []).slice();
    if (capMode && gOrder.includes('Revenue') && gOrder.includes('Unit costs')) { gOrder.splice(gOrder.indexOf('Revenue'), 1); gOrder.splice(gOrder.indexOf('Unit costs') + 1, 0, 'Revenue'); }
    const groups = gOrder.filter(g => D.some(d => grp(d) === g && shown(d)));
    const pct = (d, x) => ((x - d.min) / ((d.max - d.min) || 1) * 100).toFixed(2) + '%';
    function shown(d) { return d.kind !== 'choice' || hasPaths; }
    const groupLines = new Map();
    groups.forEach((g, gi) => {
      // On a phone only the first two groups start open — plus "Financing & rates", the
      // owner's headline stress (interest), so it is never hidden behind the other sliders.
      const box = h('details', { class: 'mdl-group', open: !narrow || gi < 2 || g === 'Financing & rates' ? true : null, 'data-mdl-group': g },
        h('summary', null, h('span', null, g), h('span', { class: 'mdl-gcount', 'data-mdl-gcount': g })));
      // capacity groups: what the sliders add up to, live ("→ FY27E revenue US$X")
      if (capMode && GROUP_LINE[g]) {
        const line = h('p', { class: 'mdl-revline', 'data-mdl-revline': g });
        groupLines.set(g, line);
        box.appendChild(line);
      }
      for (const d of D.filter(x => grp(x) === g && shown(x))) box.appendChild(d.kind === 'choice' ? choiceRow(d) : driverRow(d));
      drvPanel.appendChild(box);
    });
    function helpParts(d, rid) {
      const helpId = `${rid}-help`;
      const helpBtn = h('button', { type: 'button', class: 'mdl-help', 'aria-expanded': 'false', 'aria-controls': helpId, 'aria-label': `About ${d.label}` }, '?');
      const helpBox = h('div', { class: 'mdl-helpbox', id: helpId, hidden: true },
        h('p', null, rich.inline(d.help), d.src && d.src.length ? rich.cite(d.src) : null),
        d.kind === 'choice' ? null : h('p', { class: 'mdl-dim' }, `Range ${fmt(d.min, d.unit, d.dp)} to ${fmt(d.max, d.unit, d.dp)} · base ${fmt(d.base, d.unit, d.dp)}`
          + (isNum(d.low) && isNum(d.high) ? ` · stress range ${fmt(d.low, d.unit, d.dp)} to ${fmt(d.high, d.unit, d.dp)}` : '')),
        pathLine(d));
      helpBtn.addEventListener('click', () => {
        const open = helpBox.hidden;
        helpBox.hidden = !open; helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      return { helpBtn, helpBox };
    }
    function driverRow(d) {
      const rid = `${uid}-d-${d.id}`;
      const range = h('input', { type: 'range', id: rid, min: d.min, max: d.max, step: d.step, value: d.base, class: 'mdl-range', 'data-mdl-driver': d.id,
        'aria-label': `${d.label} (${d.unit})` });
      const numIn = h('input', { type: 'number', min: d.min, max: d.max, step: d.step, value: d.base, class: 'mdl-num', inputmode: 'decimal',
        'aria-label': `${d.label}, value in ${d.unit}`, 'data-mdl-num': d.id });
      const delta = h('span', { class: 'mdl-dd' });
      const effect = h('span', { class: 'mdl-eff' });
      const reset = h('button', { type: 'button', class: 'mdl-rs', 'aria-label': `Reset ${d.label} to base`, title: 'Back to base', hidden: true }, '↺');
      const { helpBtn, helpBox } = helpParts(d, rid);
      const track = h('div', { class: 'mdl-track' },
        isNum(d.low) && isNum(d.high) ? h('span', { class: 'mdl-band', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'mdl-base', 'aria-hidden': 'true', title: `Base ${fmt(d.base, d.unit, d.dp)}` }),
        range);
      track.style.setProperty('--b', pct(d, d.base));
      if (isNum(d.low) && isNum(d.high)) { track.style.setProperty('--l', pct(d, Math.min(d.low, d.high))); track.style.setProperty('--h', pct(d, Math.max(d.low, d.high))); }
      range.addEventListener('input', () => setDriver(d.id, +range.value));
      const fromNum = () => {
        const t = String(numIn.value).trim();
        if (t === '' || !isFinite(+t)) return;
        setDriver(d.id, +t);
      };
      numIn.addEventListener('input', fromNum);
      numIn.addEventListener('change', () => { fromNum(); numIn.value = String(cur(d.id)); });
      reset.addEventListener('click', () => { const n = Object.assign({}, st.ov); delete n[d.id]; setOv(n); range.focus(); });
      st.refs.set(d.id, { range, numIn, delta, effect, reset });
      return h('div', { class: 'mdl-drv', 'data-mdl-row': d.id },
        h('div', { class: 'mdl-drv-top' },
          h('label', { for: rid, class: 'mdl-lab' }, d.label), helpBtn,
          h('span', { class: 'mdl-in' }, numIn, h('span', { class: 'mdl-unit' }, d.unit)), reset),
        track, h('div', { class: 'mdl-drv-foot' }, delta, effect), helpBox);
    }
    // a choice driver (the SOFR path): a picker, not a slider
    function pathSelect(d, id, label, refocus) {
      const sel = h('select', { class: `ctrl mdl-sel${d.id === 'rate_path' ? ' mdl-pathsel' : ''}`, id, 'data-mdl-driver': d.id, 'aria-label': label });
      (d.choices || []).forEach((c, i) => sel.appendChild(h('option', { value: String(i) }, str(c.name))));
      sel.value = String(cur(d.id));
      sel.addEventListener('change', () => {
        setDriver(d.id, +sel.value);
        // a select inside a tab panel is rebuilt with it: give the keyboard back to the new one
        if (refocus) setTimeout(() => { const n = root.querySelector ? root.querySelector(`select[aria-label="${label}"]`) : null; if (n && n !== sel) { try { n.focus({ preventScroll: true }); } catch { n.focus(); } } }, SLOW_MS + 60);
      });
      return sel;
    }
    function choiceRow(d) {
      const rid = `${uid}-d-${d.id}`;
      const sel = pathSelect(d, rid, d.label);
      const delta = h('span', { class: 'mdl-dd' }), effect = h('span', { class: 'mdl-eff' });
      const reset = h('button', { type: 'button', class: 'mdl-rs', 'aria-label': `Reset ${d.label} to base`, title: 'Back to base', hidden: true }, '↺');
      reset.addEventListener('click', () => { const n = Object.assign({}, st.ov); delete n[d.id]; setOv(n); sel.focus(); });
      const { helpBtn, helpBox } = helpParts(d, rid);
      st.refs.set(d.id, { sel, delta, effect, reset });
      return h('div', { class: 'mdl-drv', 'data-mdl-row': d.id },
        h('div', { class: 'mdl-drv-top' }, h('label', { for: rid, class: 'mdl-lab' }, d.label), helpBtn, reset),
        sel, h('div', { class: 'mdl-drv-foot' }, delta, effect), helpBox);
    }
    function pathLine(d) {
      let p = null, unit = d.unit;
      if ((d.id === 'sofr_shift' || d.id === 'rate_path') && spec.rates && spec.rates.path) { p = years.map(y => spec.rates.path[String(y)]); unit = '%'; }
      else if (Array.isArray(d.path)) { p = d.path; unit = d.kind === 'scale_pct' ? 'US$m' : '%'; }
      if (!p) return null;
      return h('p', { class: 'mdl-dim' }, `Base path: ${years.map((y, i) => `${yl(y)} ${unit === 'US$m' ? money(p[i]) : fmt(p[i], unit, unit === '%' ? 2 : 1)}`).join(' · ')}`,
        d.kind === 'shift_pp' || d.kind === 'scale_pct' ? (d.stub_weight === 0 && stubbed ? ` (${ylong(years[0])} held at its path)` : '') : null,
        (d.id === 'sofr_shift' || d.id === 'rate_path') && spec.rates && Array.isArray(spec.rates.src) ? rich.cite(spec.rates.src) : null);
    }
    // what a moved driver does, under its slider ("FY27E 40.0% → 45.0%"); nothing at base
    function effectText(d) {
      const i = years.indexOf(st.ky), x = cur(d.id);
      if (!st.res || st.res.error || Math.abs(x - d.base) < 1e-12) return '';
      const R = st.res.rows;
      if (d.id === 'sofr_shift' || d.id === 'rate_path') {
        const b = BASE.error ? null : BASE.rows.sofr[i];
        return isNum(b) ? `SOFR ${yl(st.ky)} ${fmt(b, '%', 2)} → ${fmt(R.sofr[i], '%', 2)} · new debt ${fmt(R.new_debt_rate[i], '%', 2)}` : '';
      }
      if (Array.isArray(d.path) && isNum(d.path[i])) {
        if (d.kind === 'scale_pct') return `${yl(st.ky)} ${money(d.path[i])} → ${money(d.path[i] * (1 + x / 100))}`;
        return `${yl(st.ky)} ${fmt(d.path[i], '%', 1)} → ${fmt(d.path[i] + x, '%', 1)}`;
      }
      if (d.id === 'new_debt_rate' || d.id === 'spread_shift') return `new debt ${yl(st.ky)} ${fmt(R.new_debt_rate[i], '%', 2)}`;
      // capacity, unit-cost, financing-mix and life drivers: the rows they move, base → now
      if (EFFECT_ROWS[d.id]) {
        const parts = EFFECT_ROWS[d.id].filter(([k]) => Array.isArray(R[k]) && isNum(R[k][i])).map(([k, name, u]) => {
          const b = at(BASE, k, st.ky), v = R[k][i];
          const f = x => (u === 'US$m' ? money(x) : u === 'US$m2' ? fmt(x, 'US$m', 2) : fmt(x, u, u === '%' ? 1 : 0));
          return isNum(b) && Math.abs(b - v) > 1e-9 ? `${name} ${f(b)} → ${f(v)}` : `${name} ${f(v)}`;
        });
        return parts.length ? `${yl(st.ky)} ${parts.join(' · ')}` : '';
      }
      return '';
    }
    // the live line on top of a capacity group: revenue (capacity, pricing) or unit economics
    function groupLineText(g) {
      const res = st.res;
      if (!res || res.error) return '';
      const y = st.ky, y2 = years[years.indexOf(y) + 1];
      const chg = (row, f, unit) => {
        const v = at(res, row, y), b = at(BASE, row, y);
        if (!isNum(v)) return '';
        const d = isNum(b) ? v - b : null;
        const rel = unit === '%' ? (isNum(d) && Math.abs(d) > 0.05 ? ` (${fmt(d, 'pp', 1, true)})` : '') : (isNum(d) && isNum(b) && b !== 0 && Math.abs(d / b) > 5e-4 ? ` (${fmt(d / Math.abs(b) * 100, '%', 1, true)} vs base)` : '');
        return f(v) + rel;
      };
      if (GROUP_LINE[g] === 'revenue') {
        return `→ ${ylong(y)} revenue ${chg('revenue', money)}${y2 ? ` · ${yl(y2)} ${money(at(res, 'revenue', y2))}` : ''} · ${fmt(at(res, 'active_mw_end', y), 'MW', 0)} by year-end`;
      }
      return `→ ${ylong(y)} gross margin ${chg('gross_margin', v => fmt(v, '%', 1), '%')} · capex ${chg('capex', money)}`;
    }
    function syncDrivers() {
      const counts = new Map();
      for (const d of D) {
        const r = st.refs.get(d.id);
        if (!r) continue;
        const x = cur(d.id), changed = Math.abs(x - d.base) > 1e-12;
        if (r.range) {
          if (String(r.range.value) !== String(x)) r.range.value = String(x);
          r.range.setAttribute('aria-valuetext', fmt(x, d.unit, d.dp));
          if (doc().activeElement !== r.numIn && String(r.numIn.value) !== String(x)) r.numIn.value = String(x);
          r.delta.textContent = changed ? `${fmt(x - d.base, d.unit, d.dp, true)} vs base` : 'at base';
        } else {
          if (String(r.sel.value) !== String(x)) r.sel.value = String(x);
          r.delta.textContent = changed ? 'changed from base' : 'at base';
        }
        r.delta.className = `mdl-dd${changed ? ' on' : ''}`;
        r.effect.textContent = effectText(d);
        r.reset.hidden = !changed;
        if (changed) counts.set(grp(d), (counts.get(grp(d)) || 0) + 1);
      }
      for (const [g, line] of groupLines) line.textContent = groupLineText(g);
      for (const c of drvPanel.querySelectorAll ? drvPanel.querySelectorAll('[data-mdl-gcount]') : []) {
        const n = counts.get(c.getAttribute('data-mdl-gcount')) || 0;
        c.textContent = n ? `${n} changed` : '';
      }
      for (const s of root.querySelectorAll ? root.querySelectorAll('select.mdl-pathsel') : []) if (s.value !== String(cur('rate_path'))) s.value = String(cur('rate_path'));
    }

    // ---- headline KPIs ----
    const at = (res, row, y) => (res && !res.error && Array.isArray(res.rows[row]) ? res.rows[row][res.years.indexOf(y)] : null);
    const covOf = (res, metric) => (res && !res.error && Array.isArray(res.covenants) ? res.covenants.find(c => c.metric === metric) : null);
    const limitText = c => (isNum(c.max) ? `cap ${fmt(c.max, 'x', 1)}` : `floor ${fmt(c.min, 'x', 1)}`);
    // the covenant / threshold on a KPI: badge text when crossed in year y, and a line for the sub-label
    function covState(res, metric, y) {
      const c = covOf(res, metric);
      if (!c) return null;
      const i = res.years.indexOf(y), crossed = c.breach[i] === true;
      return { c, crossed, badge: crossed ? (c.kind === 'covenant' ? `Breach ${yl(y)}` : `Below floor ${yl(y)}`) : null,
        line: `${limitText(c)}${c.first_breach ? ` · first crossed ${yl(c.first_breach)}` : ' · never crossed'}` };
    }
    // "Bear (funding-constrained)" / "Bear: leveraged GPU leasing at the top of the cycle" -> "Bear"
    const shortName = s => str(s.name).replace(/\s*\(.*\)$/, '').replace(/\s*:.*$/, '');
    const byValue = rows => rows.slice().sort((a, b) => (isNum(a.value) ? a.value : 0) - (isNum(b.value) ? b.value : 0));
    function kpiList(res, y) {
      const V = res.valuation, B = BASE.error ? null : BASE.valuation, W = st.w && !st.w.error ? st.w : null;
      // leverage on the covenant's own basis: the last quarter's EBITDA x 4 when the cap is tested so
      const lqa = !!covOf(res, 'gross_debt_ebitda_lqa'), levK = lqa ? 'gross_debt_ebitda_lqa' : 'gross_debt_ebitda';
      const lev = covState(res, levK, y), cvr = covState(res, 'interest_cover', y);
      const commit = facilities.reduce((s, x) => s + (isNum(x.amount) ? x.amount : 0), 0);
      const out = [
        { key: 'value_per_share', label: 'Value per share (these settings)', value: fmt(V.value_per_share, 'US$', 2), raw: V.value_per_share, base: B && B.value_per_share, unit: 'US$', dp: 2,
          sub: `vs ${fmt(V.share_price, 'US$', 2)} price · ${fmt(V.upside_pct, '%', 0, true)} ${isNum(V.upside_pct) && V.upside_pct < 0 ? 'downside' : 'upside'} · base case ${fmt(B && B.value_per_share, 'US$', 2)}`, good: 1 },
      ];
      if (W && isNum(W.value)) out.push({ key: 'weighted', label: `Scenario-weighted value (presets ${byValue(W.rows).map(r => fmt(r.prob, '', 0)).join('/')})`, value: fmt(W.value, 'US$', 2), raw: W.value, base: BASE_W && BASE_W.value, unit: 'US$', dp: 2, good: 1,
        sub: byValue(W.rows).map(r => `${shortName(r)} ${fmt(r.prob, '', 0)}% ${fmt(r.value, 'US$', 0)}`).join(' · ') });
      else if (EVS.length) {
        // one probability system: the outcome distribution (regimes, events, drawn drivers); the
        // presets are points in it, weighted by the outcomes nearest to each
        const dd = distShown(), fresh = !!distNow(), m = dd && !dd.error ? dd.metrics.value_per_share : null, pr = dd && !dd.error ? dd.presets || [] : [];
        out.push({ key: 'weighted', label: 'Expected value (outcome distribution)', value: m ? fmt(m.mean, 'US$', 2) : '…', raw: m ? m.mean : null, base: null, unit: 'US$', dp: 2, good: 1, stale: !!m && !fresh,
          sub: m ? `${fresh ? '' : 'updating · '}P10 ${fmt(m.p10, 'US$', 0)} · P50 ${fmt(m.p50, 'US$', 0)} · P90 ${fmt(m.p90, 'US$', 0)}${pr.length ? ` · outcomes nearest each preset: ${byValue(pr).map(r => `${shortName(r)} ${pctP(r.mass)}`).join(' · ')}` : ''}`
            : `computing the distribution… ${Math.round(st.distProg * 100)}%`, noDelta: true });
      }
      out.push(
        { key: 'net_income', label: `${ylong(y)} net income`, value: money(at(res, 'net_income', y)), raw: at(res, 'net_income', y), base: at(BASE, 'net_income', y), unit: 'US$m', good: 1,
          sub: `EPS ${fmt(at(res, 'eps', y), 'US$', 2)}${isNum(consAt('eps', y)) ? ` · consensus ${fmt(consAt('eps', y), 'US$', 2)}` : ''}` },
        { key: 'interest', label: `${ylong(y)} interest expense`, value: money(at(res, 'interest', y)), raw: at(res, 'interest', y), base: at(BASE, 'interest', y), unit: 'US$m', good: -1,
          sub: `avg cost of debt ${fmt(at(res, 'avg_cost_of_debt', y), '%', 1)} · new debt ${fmt(at(res, 'new_debt_rate', y), '%', 1)}` },
        // "highly profitable — by which number?": interest against the adj. EBITDA it is paid from
        { key: 'interest_to_ebitda', label: `${ylong(y)} interest as % of adj. EBITDA`, value: fmt(at(res, 'interest_to_ebitda', y), '%', 0), raw: at(res, 'interest_to_ebitda', y), base: at(BASE, 'interest_to_ebitda', y), unit: '%', dp: 1, good: -1,
          sub: `EBITDA covers interest ${fmt(at(res, 'interest_cover', y), 'x', 1)} · EBIT ÷ interest ${fmt(at(res, 'ebit_cover', y), 'x', 2)}${cvr ? ` · cover ${limitText(cvr.c)}` : ''}`, badge: cvr && cvr.badge },
        // the owner's question: how much of the interest bill floats with SOFR (after swaps)
        { key: 'floating_interest', label: `Floating share of ${ylong(y)} interest`, value: fmt(at(res, 'floating_share_of_interest', y), '%', 0), raw: at(res, 'floating_share_of_interest', y), base: at(BASE, 'floating_share_of_interest', y), unit: '%', dp: 1, good: 0,
          sub: `after swaps · ${fmt(at(res, 'floating_share_of_debt', y), '%', 0)} of year-end debt floats · +100bp SOFR = ${money(at(res, 'rate_exposure_100bp', y), true)}` },
        { key: 'gross_debt_ebitda', label: `${ylong(y)} total debt / EBITDA${lqa ? ' (Q4 × 4)' : ''}`, value: fmt(at(res, levK, y), 'x', 1), raw: at(res, levK, y), base: at(BASE, levK, y), unit: 'x', dp: 1, good: -1,
          sub: `${lev ? lev.line + ' · ' : ''}${lqa ? `full year ${fmt(at(res, 'gross_debt_ebitda', y), 'x', 1)} · ` : ''}net ${fmt(at(res, 'net_debt_ebitda', y), 'x', 1)}`, badge: lev && lev.badge },
        { key: 'funding', label: `Uncommitted funding need to ${ylong(y)}`, value: money(at(res, 'uncommitted_cum', y)), raw: at(res, 'uncommitted_cum', y), base: at(BASE, 'uncommitted_cum', y), unit: 'US$m', good: 0,
          sub: `of ${money(at(res, 'funding_cum', y))} raised${commit > 0 ? ` · ${money(commit)} of committed facilities drawn first` : ''}` },
        { key: 'ev_ebitda', label: `${ylong(y)} EV/EBITDA (funded EV)`, value: fmt(at(res, 'ev_ebitda', y), 'x', 1), raw: at(res, 'ev_ebitda', y), base: at(BASE, 'ev_ebitda', y), unit: 'x', dp: 1, good: -1,
          sub: `at ${fmt(V.share_price, 'US$', 2)} incl. the debt that funds it · P/E ${fmt(at(res, 'pe', y), 'x', 1)} · on today’s EV ${fmt(at(res, 'ev_ebitda_static', y), 'x', 1)}` });
      if (capMode && Array.isArray(res.rows.backlog_coverage)) {
        // how much of the year's modelled revenue is already signed (RPO converting on schedule)
        const cv = at(res, 'backlog_coverage', y), warn = REV.backlog && isNum(REV.backlog.coverage_warn) ? REV.backlog.coverage_warn * 100 : null;
        const badge = isNum(cv) && cv > 100.5 ? 'Below backlog' : isNum(cv) && isNum(warn) && cv < warn ? 'Low cover' : null;
        out.push({ key: 'backlog_coverage', label: `Revenue covered by backlog (${ylong(y)})`, value: fmt(isNum(cv) ? Math.min(cv, 999) : null, '%', 0), raw: cv, base: at(BASE, 'backlog_coverage', y), unit: '%', dp: 1, good: 0,
          sub: `contracted ${money(at(res, 'contracted_revenue', y))} of ${money(at(res, 'revenue', y))} modelled${badge === 'Below backlog' ? ' · modelled revenue is below the signed backlog' : ''}`, badge });
      }
      return out;
    }
    function kpiTile(k) {
      const d = isNum(k.raw) && isNum(k.base) ? k.raw - k.base : null;
      const t = tone(d, k.good, k.unit === 'US$m' ? 0.5 : k.unit === 'US$' ? 0.005 : 0.05);
      const px = cur('share_price');
      const dTxt = k.noDelta ? (isNum(k.raw) && px > 0 ? `${fmt((k.raw / px - 1) * 100, '%', 0, true)} vs the ${fmt(px, 'US$', 2)} price` : '…')
        : d === null ? 'vs base n/a' : t === 'flat' ? 'at base' : `${k.unit === 'US$m' ? money(d, true) : fmt(d, deltaUnit(k.unit), k.dp, true)} vs base`;
      return h('div', { class: `mdl-kpi ${t}${k.badge ? ' breach' : ''}${k.stale ? ' mdl-stale' : ''}`, role: 'listitem', 'data-mdl-kpi': k.key, 'aria-busy': k.stale ? 'true' : null },
        h('div', { class: 'mdl-kpi-l' }, k.label, k.badge ? h('span', { class: 'mdl-badge' }, k.badge) : null),
        h('div', { class: 'mdl-kpi-v' }, k.value),
        h('div', { class: 'mdl-kpi-s' }, k.sub),
        h('div', { class: `mdl-kpi-d ${t}` }, h('span', { 'aria-hidden': 'true' }, arrow(t)), ' ', dTxt));
    }
    function renderKpis() {
      if (!st.res || st.res.error) return;
      clear(kpis);
      for (const k of kpiList(st.res, st.ky)) kpis.appendChild(kpiTile(k));
    }
    function renderMini() {
      if (!st.res || st.res.error) return;
      clear(mini);
      const y = st.ky, res = st.res;
      for (const [l, v] of [['Value', fmt(res.valuation.value_per_share, 'US$', 0)], [`${yl(y)} NI`, money(at(res, 'net_income', y))],
        [`${yl(y)} interest`, money(at(res, 'interest', y))], [`of EBITDA`, fmt(at(res, 'interest_to_ebitda', y), '%', 0)]]) {
        mini.appendChild(h('span', null, h('b', null, v), ` ${l}`));
      }
    }

    // ---- P&L table ----
    // A table of model rows by year: the value, and (withDelta) its change vs the base case in
    // small type. rows: [key | {key, label, values, strong, unit, dp, good, sub}] — `values`
    // overrides the row (e.g. a customer's revenue), `sub` marks an indented "of which" row.
    function rowTable(res, rows, { withDelta, aria, caption, corner, base } = {}) {
      const B = base || BASE;
      const head = h('tr', null, h('th', { scope: 'col', class: 'l' }, corner || 'US$m unless stated'),
        years.map((y, i) => h('th', { scope: 'col', class: 'r' }, ylong(y), i === 0 && stubbed ? h('span', { class: 'mdl-th-note' }, `${spec.stub.actual_months}m actual + rest`) : null)));
      const zero = a => !Array.isArray(a) || a.every(x => !isNum(x) || Math.abs(x) < 0.5);
      const body = rows.map(r => (typeof r === 'string' ? { key: r } : r)).filter(r => Array.isArray(r.values) || Array.isArray(res.rows[r.key]))
        .filter(r => !(OPTIONAL_ROWS.has(r.key) && zero(res.rows[r.key]) && zero(B && !B.error ? B.rows[r.key] : null))).map(r => {
        const k = r.key, m = Object.assign({ label: k, unit: '', dp: 0 }, RM[k], r.unit ? { unit: r.unit } : null, isNum(r.dp) ? { dp: r.dp } : null);
        // the unit after the label: "Margin (%)", or inside a closing parenthesis: "Utilisation (billing ÷ active MW, %)"
        const u = m.unit === '%' ? '%' : m.unit === 'x' ? 'x' : m.unit === 'MW' && !/MW/.test(m.label) ? 'MW' : '';
        const label = r.label || (k === 'eps' ? 'EPS, diluted (US$)' : !u ? m.label : /\)$/.test(m.label) ? `${m.label.slice(0, -1)}, ${u})` : `${m.label} (${u})`);
        const vals = Array.isArray(r.values) ? r.values : res.rows[k];
        const bVals = Array.isArray(r.base) ? r.base : B && !B.error && Array.isArray(B.rows[k]) && !Array.isArray(r.values) ? B.rows[k] : null;
        const good = isNum(r.good) ? r.good : GOOD[k];
        return h('tr', { class: [r.strong || (r.strong !== false && STRONG_ROWS.has(k)) ? 'mdl-strong' : null, r.sub ? 'mdl-sub-row' : null].filter(Boolean).join(' ') || null, 'data-mdl-rowkey': k },
          h('th', { scope: 'row', class: 'l' }, label, r.note ? h('span', { class: 'mdl-th-note' }, r.note) : null),
          years.map((y, i) => {
            const val = vals[i], b = bVals ? bVals[i] : null;
            const dd = withDelta && isNum(val) && isNum(b) ? val - b : null;
            const unit = m.unit === 'US$m' || m.unit === 'US$' || m.unit === 'MW' ? '' : m.unit;
            const t = tone(dd, good, m.unit === '%' ? 0.05 : m.unit === 'US$' ? 0.005 : 0.5);
            return h('td', { class: 'r' }, fmt(val, unit, m.dp),
              dd !== null && t !== 'flat' ? h('span', { class: `mdl-cd ${t}` }, fmt(dd, deltaUnit(unit), m.dp, true)) : null);
          }));
      });
      return h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': aria || 'P&L projection' },
        h('table', { class: 'rpt-table mdl-table' }, caption ? h('caption', { class: 'mdl-cap' }, caption) : null, h('thead', null, head), h('tbody', null, body)));
    }
    const plTable = (res, withDelta) => rowTable(res, PL_ROWS, { withDelta });
    // model against the cited consensus, row by row (a cell: model, then consensus and the gap)
    function consTable(res) {
      const keys = ['revenue', 'ebitda', 'net_income', 'eps', 'net_debt'].filter(k => cons.rows[k] && Array.isArray(res.rows[k]));
      const ys = years.filter(y => keys.some(k => isNum(consAt(k, y))));
      if (!keys.length || !ys.length) return null;
      const lab = { revenue: 'Revenue', ebitda: 'Adj. EBITDA', net_income: 'Net income', eps: 'EPS (US$)', net_debt: 'Net debt (year-end)' };
      const body = keys.map(k => h('tr', null, h('th', { scope: 'row', class: 'l' }, lab[k]), ys.map(y => {
        const mv = at(res, k, y), cv = consAt(k, y), dp = k === 'eps' ? 2 : 0;
        const gap = isNum(mv) && isNum(cv) && cv !== 0 ? (mv - cv) / Math.abs(cv) * 100 : null;
        return h('td', { class: 'r' }, fmt(mv, '', dp), isNum(cv) ? h('span', { class: 'mdl-th-note' }, `cons. ${fmt(cv, '', dp)}${isNum(gap) ? ` (${fmt(gap, '%', 0, true)})` : ''}`) : null);
      })));
      return h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Model vs consensus' },
        h('table', { class: 'rpt-table mdl-table' }, h('caption', { class: 'mdl-cap' }, 'Model vs consensus (US$m unless stated)'),
          h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Model, then consensus'), ys.map(y => h('th', { scope: 'col', class: 'r' }, ylong(y))))),
          h('tbody', null, body)));
    }
    // The P&L tab in two parts: the table on every frame; the revenue build, unit economics, cash
    // bridge and depreciation readout (hundreds of nodes and two extra model runs) once the
    // sliders rest, dimmed while they are stale.
    let PL = null;
    function renderPL(p, res) {
      p.appendChild(h('p', { class: 'mdl-note' }, `Projection under the current drivers${evOn().length ? ' and business events' : ''}. Small figures under a cell are the change vs the base case `
        + `(green = better for shareholders, ◆ = a change that is neither). ${stubbed ? `${ylong(years[0])} = ${spec.stub.actual_months} months reported + the model’s remainder of the year.` : ''}`));
      p.appendChild(plTable(res, true));
      if (cons) {
        const t = consTable(res);
        if (t) {
          p.appendChild(t);
          p.appendChild(h('p', { class: 'mdl-src' }, str(cons.label), Array.isArray(cons.src) ? rich.cite(cons.src) : null));
        }
      }
    }
    function fillPLSlow() {
      if (!PL || !st.res || st.res.error) return;
      const p = PL.slow, res = st.res;
      clear(p);
      try {
        if (capMode) renderBuild(p, res);
        if (capMode) renderUnitEcon(p, res);
        renderCashBridge(p, res);
        renderLife(p);
        p.appendChild(h('p', { class: 'mdl-note' }, 'Adj. EBITDA = revenue − cost of revenue − operating costs, before stock-based comp and D&A. '
          + 'Operating cash flow ≈ net income + D&A + SBC + non-cash interest + customer prepayments (no other working capital). '
          + 'Tax: the rate on positive pre-tax profit, with a floor for the tax booked in loss years.'));
      } catch (e) { clear(p); p.appendChild(h('p', { class: 'mdl-note' }, 'This part couldn’t be drawn for these settings.')); }
      p.classList.remove('mdl-stale'); p.removeAttribute('aria-busy');
      st.plSlowKey = plKey();
    }
    const plKey = () => JSON.stringify([st.ov, evOn(), st.ky]);
    // what one MW energised in the exit year earns against its capex and the debt that funds it
    function renderUnitEcon(p, res) {
      const u = res.unit_economics;
      if (!u) return;
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'unit' }, `Unit economics: one MW energised in ${ylong(u.year)} — does the rent pay the bank?`));
      const pct = x => fmt(isNum(x) ? x * 100 : null, '%', 1);
      const rows = [
        ['Revenue per MW-year', `${fmt(u.revenue_per_mw, 'US$m', 2)} (US$${fmt(u.price, '', 2)}m list price x ${fmt(u.utilization, '%', 0)} billing)`],
        ['Cash cost per MW-year (rent, power, site, operating costs)', fmt(u.cost_per_mw + u.opex_per_mw, 'US$m', 2)],
        ['Adj. EBITDA per MW-year', fmt(u.ebitda_per_mw, 'US$m', 2)],
        ['Capex per MW (GPUs, networking, fit-out)', fmt(u.capex_per_mw, 'US$m', 1)],
        [`First contract (${fmt(u.contract_years, '', 0)} years, billing from month ${fmt(u.billing_lag_months + 1, '', 0)}): adj. EBITDA`, fmt(u.contract_ebitda, 'US$m', 1)],
        [`… less maintenance capex and the interest on debt that funds the capex (${fmt(u.new_debt_rate, '%', 1)}, repaid over the contract)`, `${fmt(-u.contract_maintenance, 'US$m', 1)} · ${fmt(-u.contract_interest, 'US$m', 1)}`],
        ['= Cash left after repaying the capex and its debt', fmt(u.contract_cash_after_debt, 'US$m', 1)],
        [`Renewals until the ${fmt(u.economic_life, '', 1)}-year economic life (${fmt(u.renewal_years, '', 1)} years at ${fmt(u.renewal_price_change, '%', 0, true)})`, fmt(u.renewal_ebitda, 'US$m', 1)],
        ['Payback on capex (years, before interest)', u.payback_years === null ? 'not within the economic life' : fmt(u.payback_years, '', 1)],
        ['Project IRR over the economic life · first contract only', `${pct(u.irr_project)} · ${pct(u.irr_contract)}`],
        ['against the new-debt rate · the cost of capital (WACC)', `${fmt(u.new_debt_rate, '%', 1)} · ${fmt(u.wacc, '%', 1)}`]];
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Unit economics per MW' },
        h('table', { class: 'rpt-table mdl-table mdl-unit' }, h('caption', { class: 'mdl-cap' }, `Per MW, on ${ylong(u.year)}'s economics (US$m)`),
          h('tbody', null, rows.map(([a, b], i) => h('tr', { class: i === 6 || i === 9 ? 'mdl-strong' : null }, h('th', { scope: 'row', class: 'l' }, a), h('td', { class: 'r' }, b)))))));
      const verdict = isNum(u.irr_project) && isNum(u.new_debt_rate) ? (u.irr_project * 100 < u.new_debt_rate
        ? `On these inputs a new MW returns ${pct(u.irr_project)} a year over its life, below the ${fmt(u.new_debt_rate, '%', 1)} its debt costs: the first contract roughly repays the capex, and the equity return rests on renewals, residual value and the multiple the market pays for growth.`
        : `On these inputs a new MW returns ${pct(u.irr_project)} a year over its life, above the ${fmt(u.new_debt_rate, '%', 1)} its debt costs.`) : '';
      p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'unit' }, h('strong', null, 'Does the rent pay the bank? '), verdict,
        ' Unlevered and before tax; costs from the day the shell is received, revenue after the fit-out lag; renewals at the last year’s renewal price change.'));
    }

    // ---- P&L: the revenue build (capacity_v1) ----
    const RMS = spec.revenue_model && typeof spec.revenue_model === 'object' ? spec.revenue_model : {};
    const custName = id => { const c = REV && REV.customers.find(x => x.id === id); return c ? str(c.name) : str(id); };
    // FY(prior) reported revenue -> FY(y)E: more MW at the prior year's revenue per average MW,
    // the change in revenue per MW (mix, prices, billing ramp), renewal resets, backstop
    // purchases, then the business events switched on. null without the inputs.
    function revBridge(res, y) {
      const pr = spec.prior;
      if (!capMode || !pr || !isNum(pr.revenue) || !Number.isInteger(pr.year)) return null;
      const mw0 = yearAvgMW(RMS, pr.year);
      if (!isNum(mw0) || mw0 <= 0) return null;
      const N = evOn().length ? E.project(spec, st.ov, { exposure: false }) : res;
      if (!N || N.error) return null;
      const revN = at(N, 'revenue', y), mwN = at(N, 'active_mw_avg', y), ren = at(N, 'renewal_effect', y) || 0, bs = at(N, 'backstop_revenue', y) || 0, rev = at(res, 'revenue', y);
      if (![revN, mwN, rev].every(isNum) || mwN <= 0) return null;
      const rpm0 = pr.revenue / mw0, rpmN = (revN - ren - bs) / mwN;
      const steps = [{ label: `FY${pr.year}A`, sub: 'reported', value: pr.revenue, total: true },
        { label: 'Capacity added', sub: `${fmt(mwN - mw0, '', 0, true)} MW avg`, value: (mwN - mw0) * rpm0 },
        { label: 'Price & billing', sub: `${fmt(rpmN - rpm0, '', 2, true)}m per MW`, value: mwN * (rpmN - rpm0) },
        { label: 'Renewal resets', sub: 'repricing', value: ren }];
      if (Math.abs(bs) > 0.5) steps.push({ label: 'Backstop', sub: 'unsold capacity', value: bs });
      if (EVS.length) steps.push({ label: 'Events', sub: `${evOn().length} switched on`, value: rev - revN });
      steps.push({ label: ylong(y), sub: 'model', value: rev, total: true });
      return { steps, mw0, rpm0, year0: pr.year };
    }
    function renderBuild(p, res) {
      const R = res.rows, y = st.ky, lab = years.map(yl);
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'build' }, 'Revenue build: capacity × price × billing'));
      p.appendChild(h('p', { class: 'mdl-note' }, 'Revenue is built from what can be observed and predicted: the power (MW) energised each quarter, how much of it is billing, '
        + 'and the revenue each billing MW earns (GPU generation and contract prices), less the price change when contracts renew. ',
      RMS.note ? rich.inline(RMS.note) : null, Array.isArray(RMS.src) ? rich.cite(RMS.src) : null));
      // bridge from the last reported year
      const br = revBridge(res, y);
      if (br) {
        p.appendChild(chartBox(waterfall({ id: `${uid}-rbr`, title: `Revenue bridge FY${br.year0}A → ${ylong(y)} (US$m)`, steps: br.steps,
          desc: br.steps.map(s => `${s.label}: ${s.total ? money(s.value) : money(s.value, true)}`).join('; ') })));
        p.appendChild(h('p', { class: 'mdl-note' }, `Capacity added = the rise in average active MW at FY${br.year0}’s ${fmt(br.rpm0, 'US$m', 2)} of revenue per average MW `
          + `(${fmt(br.mw0, 'MW', 0)} in FY${br.year0}, read off the MW path); price & billing = the change in revenue per MW (GPU mix, contract prices, the billing ramp after energisation).`
          + (EVS.length ? ' Events = the business risks and upsides switched on.' : '')));
      }
      // active MW
      const mwS = [{ name: 'Active MW (year-end)', short: 'Year-end', color: C_LOW, values: R.active_mw_end },
        { name: 'Average active MW', short: 'Average', color: '#a78bfa', values: R.active_mw_avg, dash: true },
        { name: 'Average billing MW', short: 'Billing', color: '#2dd4bf', values: R.billing_mw_avg }];
      // contracted power = power under lease from developers (supply), not customer contracts
      const O = REV.opening || {};
      if (isNum(O.contracted_mw_latest)) mwS.push({ name: `Contracted (leased) power at ${monthText(O.contracted_latest_date)}${isNum(O.contracted_mw) ? ` (${fmt(O.contracted_mw, 'MW', 0)} at ${monthText(O.date)})` : ''}`, short: 'Leased', color: C_OTHER, values: years.map(() => O.contracted_mw_latest), dash: true });
      else if (isNum(O.contracted_mw)) mwS.push({ name: `Contracted (leased) power at ${monthText(O.date)}`, short: 'Leased', color: C_OTHER, values: years.map(() => O.contracted_mw), dash: true });
      p.appendChild(chartBox(lineChart({ id: `${uid}-mw`, title: 'Active and billing power (MW)', labels: lab, series: mwS, unit: 'MW', dp: 0,
        desc: mwS.map(s => `${s.name}: ${s.values.map((x, i) => `${lab[i]} ${fmt(x, 'MW', 0)}`).join(', ')}`).join('; ') }), legend(mwS.map(s => [s.name, s.color, s.dash]))));
      // contracted vs not yet contracted
      const con = years.map((_, i) => (isNum(R.contracted_revenue[i]) && isNum(R.revenue[i]) ? Math.min(R.contracted_revenue[i], R.revenue[i]) : null));
      const unc = years.map((_, i) => (isNum(R.uncontracted_revenue[i]) ? Math.max(0, R.uncontracted_revenue[i]) : null));
      const cs = [{ name: 'Contracted (backlog converting)', color: C_LOW, values: con }, { name: 'Not yet contracted', color: C_HIGH, values: unc }];
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Backlog: how much of each year is already signed'));
      const B = REV.backlog;
      if (B) {
        const bk = B.buckets.map(b => `${fmt(b.share * 100, '%', 0)} in months ${b.months[0]}–${b.months[1]}`).join(', ');
        p.appendChild(h('p', { class: 'mdl-note' }, `Remaining performance obligations of ${money(B.rpo)} at ${str(B.as_of)} convert on the disclosed schedule (${bk}). `
          + 'Contracted capacity bills first and at its contract price once delivered (take-or-pay), so price, utilisation and sell-through stresses touch only the capacity not under contract. '
          + 'Contracted revenue follows the schedule: if delivery slips, a customer cancels or the build is not funded, modelled revenue drops below what customers have signed '
          + '(coverage above 100%), i.e. backlog the company cannot yet deliver.', rich.cite(B.src)));
      }
      const short = years.filter((_, i) => isNum(R.contracted_revenue[i]) && isNum(R.revenue[i]) && R.revenue[i] < R.contracted_revenue[i] - 0.5);
      p.appendChild(chartBox(stackedBars({ id: `${uid}-bk`, title: 'Revenue: contracted vs not yet contracted (US$m)', labels: lab, series: cs, unit: 'US$m',
        sub: years.map((_, i) => (isNum(R.backlog_coverage[i]) ? `${fmt(Math.min(R.backlog_coverage[i], 999), '%', 0)} covered` : '')),
        desc: years.map((_, i) => `${lab[i]}: contracted ${fmt(R.contracted_revenue[i], 'US$m', 0)}, not yet contracted ${fmt(R.uncontracted_revenue[i], 'US$m', 0)}, coverage ${fmt(R.backlog_coverage[i], '%', 0)}`).join('; ') }),
      legend(cs.map(s => [s.name, s.color]))));
      if (short.length) p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'backlog' }, h('strong', null, 'Modelled revenue below the signed backlog'),
        ` in ${short.map(yl).join(', ')}: ${short.map(yy => money(R.contracted_revenue[years.indexOf(yy)] - R.revenue[years.indexOf(yy)])).join(', ')} of contracted revenue the modelled capacity does not deliver in time.`));
      // what the base needs from new contracts
      if (Array.isArray(R.bookings_needed)) p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'bookings' }, h('strong', null, 'New contracts the plan needs: '),
        `${years.map((yy, i) => `${yl(yy)} ${money(R.bookings_needed[i])}`).join(' · ')} of new contract value (renewals included), five years of the rise in the not-yet-contracted run-rate `
        + `(December: ${years.map((yy, i) => `${yl(yy)} ${money(R.uncontracted_run_rate[i])}`).join(' · ')}). `,
        byId.has('sell_through') ? ['Sell less of it with ', driverLink('sell_through'), '.'] : null));
      // customers
      const cust = REV.customers.filter(c => Array.isArray(R.revenue_by_customer && R.revenue_by_customer[c.id]));
      if (cust.length) {
        const total = c => sum(R.revenue_by_customer[c.id]);
        const named = cust.filter(c => !c.aggregate && total(c) > 0.5).sort((a, b) => total(b) - total(a));
        const keep = named.slice(0, 4), unc = cust.find(c => c.computed), rest = cust.filter(c => !keep.includes(c) && c !== unc && total(c) > 0.5);
        const ser = keep.map((c, j) => ({ name: str(c.name), color: SERIES[j], values: R.revenue_by_customer[c.id] }));
        if (rest.length) ser.push({ name: rest.length === 1 ? str(rest[0].name) : `Other contracted (${rest.length})`, color: C_OTHER, values: years.map((_, i) => rest.reduce((s, c) => s + (R.revenue_by_customer[c.id][i] || 0), 0)) });
        if (unc && total(unc) > 0.5) ser.push({ name: str(unc.name), color: C_HIGH, values: R.revenue_by_customer[unc.id] });
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Customers: concentration'));
        p.appendChild(h('p', { class: 'mdl-note' }, 'Each customer’s revenue is its contracted schedule (its share of each year’s backlog conversion), delivered first where its capacity is already live; '
          + 'a delivery delay falls on the contracts that are new, a cancellation on that customer only. Capacity not under contract (new deals, and contracts that expire and re-sign) is one pool.',
        cust.filter(c => c.note).length ? [' ', ...cust.filter(c => c.note && !c.computed).slice(0, 8).map(c => h('span', { class: 'mdl-dim' }, ` ${str(c.name)}: `, rich.inline(c.note)))] : null));
        p.appendChild(chartBox(stackedBars({ id: `${uid}-cust`, title: 'Revenue by customer (US$m)', labels: lab, series: ser, unit: 'US$m',
          sub: years.map((_, i) => (isNum(R.top_customer_share[i]) ? `top ${fmt(R.top_customer_share[i], '%', 0)}` : '')),
          desc: years.map((_, i) => `${lab[i]}: ${ser.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }), legend(ser.map(s => [s.name, s.color]))));
        // look-through: a customer that buys for another (Microsoft serving OpenAI) adds to that one's dependence
        const lt = R.lookthrough_share && typeof R.lookthrough_share === 'object' ? Object.keys(R.lookthrough_share) : [];
        const via = t => REV.customers.filter(c => c.look_through && isNum(c.look_through[t])).map(c => `${fmt(c.look_through[t] * 100, '%', 0)} of ${str(c.name)}`);
        p.appendChild(h('p', { class: 'mdl-note' }, `Largest customer’s share of revenue: ${years.map((yy, i) => `${yl(yy)} ${fmt(R.top_customer_share[i], '%', 0)}`).join(' · ')}; `
          + `of contracted revenue: ${years.map((yy, i) => `${yl(yy)} ${fmt(R.top_contracted_share[i], '%', 0)}`).join(' · ')}; of the backlog signed to date (year-end): ${years.map((yy, i) => `${yl(yy)} ${fmt(R.top_backlog_share[i], '%', 0)}`).join(' · ')}.`,
          lt.map(t => ` ${custName(t)} including what it buys through others (${via(t).join(', ')}): ${years.map((yy, i) => `${yl(yy)} ${fmt(R.lookthrough_share[t][i], '%', 0)}`).join(' · ')}.`),
          cust.filter(c => c.src && c.src.length).length ? citeWrap([...new Set(cust.flatMap(c => c.src || []))]) : null));
      }
      // the buyer of last resort
      if (REV.backstop) {
        const S = REV.backstop, note = RMS.backstop && RMS.backstop.note;
        p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'backstop' }, h('strong', null, str(S.name || 'Backstop')),
          `: buys capacity left unsold, up to ${money(S.cap)} in total until ${monthText(S.until)}`
          + `${isNum(S.coverage) && S.coverage < 1 ? ` (${fmt(S.coverage * 100, '%', 0)} of what is unsold)` : ''}; ${S.basis === 'all' ? 'any unsold capacity counts' : 'only capacity left unsold by the stresses counts (utilisation or sell-through below plan, renewals that walk, capacity idle after a cut, before it is re-let)'}. `
          + `In this run it buys ${years.map((yy, i) => `${yl(yy)} ${money(R.backstop_revenue[i])}`).join(' · ')}; ${money(at(res, 'backstop_left', years[years.length - 1]))} left at the end. `,
          note ? rich.inline(note) : null, rich.cite(S.src)));
      }
      p.appendChild(rowTable(res, BUILD_ROWS.concat(Object.keys(R.lookthrough_share || {}).map(t => ({ key: `lt:${t}`, label: `${custName(t)} incl. look-through (%)`, values: R.lookthrough_share[t],
        base: BR.lookthrough_share ? BR.lookthrough_share[t] : null, unit: '%', dp: 1, good: -1, strong: false }))), { withDelta: true, aria: 'Revenue build', caption: 'Revenue build by year', corner: 'MW, US$m unless stated' }));
      // sites behind the MW path
      if (REV.sites && REV.sites.length) {
        const tot = sum(REV.sites.map(x => (isNum(x.mw) ? x.mw : 0)));
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Sites' },
          h('table', { class: 'rpt-table mdl-table' }, h('caption', { class: 'mdl-cap' }, `Sites behind the MW path (${fmt(tot, 'MW', 0)} listed)`),
            h('thead', null, h('tr', null, ['Site', 'MW', 'Expected online', 'Developer'].map((c, i) => h('th', { scope: 'col', class: i === 1 ? 'r' : 'l' }, c)))),
            h('tbody', null, REV.sites.map(x => h('tr', null, h('th', { scope: 'row', class: 'l' }, str(x.name), Array.isArray(x.src) ? rich.cite(x.src) : null, x.status ? h('span', { class: 'mdl-th-note' }, str(x.status)) : null),
              h('td', { class: 'r' }, fmt(x.mw, '', 0)), h('td', { class: 'l' }, monthText(x.expected_online)), h('td', { class: 'l' }, str(x.developer))))))));
      }
      // owned vs leased: rent, power and the self-build trade-off
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Unit costs: owned vs leased data centres'));
      const sb = REV.self_build, sbs = byId.has('self_build_share') ? cur('self_build_share') : null;
      const LS = REV.leases;
      p.appendChild(h('p', { class: 'mdl-note' }, `The model splits cost of revenue per average active MW into ${fmt((REV.rent_share || 0) * 100, '%', 0)} data-centre rent and ${fmt((REV.power_share || 0) * 100, '%', 0)} power (the model’s assumption for the level, from the cost note’s sources), the rest site operations. `
        + 'The company owns what is inside the buildings (GPUs, networking, cooling) — the fast-depreciating part — and mostly rents the buildings and their power. '
        + (LS && isNum(LS.leased_mw) ? `Rent is charged on the ${fmt(LS.leased_mw, 'MW', 0)} of signed leases as they are delivered, whether or not GPUs fill them${LS.sublet_recovery > 0 ? ` (${fmt(LS.sublet_recovery * 100, '%', 0)} of an empty shell's rent recovered by subletting)` : ''}. ` : '')
        + (sb ? `Self-built sites pay no rent but need about ${fmt(sb.capex_per_mw, 'US$m', 1)} of shell and power capex per MW${sb.lead_months ? `, ${fmt(sb.lead_months, '', 0)} months before they go live` : ''}, depreciated over ${fmt(sb.life, '', 0)} years`
          + `${sb.beyond_leases ? ' (the share applies to MW beyond the signed leases)' : ''}${isNum(sbs) ? `; ${fmt(sbs, '%', 0)} self-built in this run` : ''}. ` : ''),
      RMS.cost_of_revenue && RMS.cost_of_revenue.note ? rich.inline(RMS.cost_of_revenue.note) : null, sb && sb.src && sb.src.length ? rich.cite(sb.src) : null));
      if (LS) {
        const lc = LS.lease_cost;
        p.appendChild(h('div', { class: 'mdl-kpis mdl-strip', role: 'list', 'aria-label': 'Lease commitments' },
          [['nc', 'Leases signed, not yet commenced', money(LS.not_commenced), `undiscounted, at ${monthText(LS.as_of)}${LS.terms ? `, ${LS.terms}` : ''}`],
            ['cl', 'Leases on the balance sheet', money(LS.commenced_liability), isNum(LS.undiscounted_commenced) ? `operating lease liabilities; ${money(LS.undiscounted_commenced)} of payments` : 'operating lease liabilities'],
            ['tot', 'Signed lease payments in all', money((LS.not_commenced || 0) + (LS.undiscounted_commenced || 0)), 'undiscounted, fixed: they do not shrink with the build'],
            ['lc', 'Operating lease cost', lc ? money(lc.amount) : '—', lc ? `${str(lc.period)} · model rent per leased MW ${fmt(at(res, 'rent_per_mw', st.ky), 'US$m', 2)} a year (${yl(st.ky)})` : '']]
            .map(([k, l, v, sub]) => h('div', { class: 'mdl-kpi', role: 'listitem', 'data-mdl-lease': k }, h('div', { class: 'mdl-kpi-l' }, l), h('div', { class: 'mdl-kpi-v' }, v), h('div', { class: 'mdl-kpi-s' }, sub)))));
        if (LS.note) p.appendChild(h('p', { class: 'mdl-src' }, rich.inline(LS.note), rich.cite(LS.src)));
      }
      p.appendChild(rowTable(res, COST_ROWS, { withDelta: true, aria: 'Unit costs', caption: 'Unit costs, rent and capex by year', corner: 'US$m, MW unless stated' }));
    }

    // ---- P&L: EBITDA -> free cash flow ("highly profitable — by which number?") ----
    function cashBridge(res, y) {
      const g = k => at(res, k, y);
      const e = g('ebitda'), ci = g('cash_interest'), tx = g('cash_tax'), cx = g('capex'), wc = g('wc_prepay') || 0, f = g('fcf');
      if (![e, ci, tx, cx, f].every(isNum)) return null;
      return { e, ci, tx, cx, wc, other: f - (e - ci - tx - cx + wc), f };
    }
    function renderCashBridge(p, res) {
      const y = st.ky, b = cashBridge(res, y);
      if (!b) return;
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'fcf' }, 'From adj. EBITDA to free cash flow'));
      p.appendChild(h('p', { class: 'mdl-note' }, '“Highly profitable — by which number?” Adj. EBITDA leaves out the interest on the debt and the capex that buys the GPUs; free cash flow does not. '
        + `In ${ylong(y)} interest takes ${fmt(at(res, 'interest_to_ebitda', y), '%', 0)} of adj. EBITDA and capex ${fmt(b.e > 0 ? b.cx / b.e * 100 : null, '%', 0)}.`));
      const steps = [{ label: 'Adj. EBITDA', value: b.e, total: true }, { label: 'Cash interest', value: -b.ci }, { label: 'Tax paid', value: -b.tx },
        { label: 'Capex', value: -b.cx }, { label: 'Prepayments', sub: 'from customers', value: b.wc }];
      if (Math.abs(b.other) > 0.5) steps.push({ label: 'Other', sub: stubbed && y === years[0] ? `${spec.stub.actual_months}m reported` : 'items', value: b.other });
      steps.push({ label: 'Free cash flow', value: b.f, total: true });
      p.appendChild(chartBox(waterfall({ id: `${uid}-fcf`, title: `${ylong(y)}: adj. EBITDA to free cash flow (US$m)`, steps,
        desc: steps.map(s => `${s.label}: ${s.total ? money(s.value) : money(s.value, true)}`).join('; ') })));
      const R = res.rows, neg = a => (Array.isArray(a) ? a.map(x => (isNum(x) ? -x : x)) : null);
      const oth = years.map(yy => { const c = cashBridge(res, yy); return c ? c.other : null; });
      const othB = years.map(yy => { const c = BASE.error ? null : cashBridge(BASE, yy); return c ? c.other : null; });
      p.appendChild(rowTable(res, [{ key: 'ebitda' }, { key: 'cash_interest', label: '− Cash interest', values: neg(R.cash_interest), base: neg(BR.cash_interest), good: 1, strong: false },
        { key: 'cash_tax', label: '− Tax paid', values: neg(R.cash_tax), base: neg(BR.cash_tax), good: 1 }, { key: 'capex', label: '− Capex', values: neg(R.capex), base: neg(BR.capex), good: 0 },
        { key: 'wc_prepay', label: `+ Customer prepayments${stubbed && spec.stub.actuals && isNum(spec.stub.actuals.prepayments) ? ` (incl. ${money(spec.stub.actuals.prepayments)} of deferred revenue in the reported months)` : ''}` },
        { key: 'other_cash', label: stubbed ? `± Other working capital and items (${ylong(years[0])}: the ${spec.stub.actual_months} reported months)` : '± Other items', values: oth, base: othB, good: 0 },
        { key: 'fcf', label: '= Free cash flow' }, { key: 'fcf_pre_growth', label: 'Cash flow before growth capex (OCF − maintenance capex)', strong: false },
        { key: 'interest_to_ebitda', label: 'Interest as % of adj. EBITDA (%)', strong: false },
        { key: 'gross_borrowing', label: 'Gross new borrowing (incl. refinancing)', good: 0 }], { withDelta: true, aria: 'EBITDA to free cash flow', caption: 'EBITDA to free cash flow by year' }));
    }

    // ---- P&L: reported profit at two depreciation lives (the "3-year GPU" argument) ----
    function renderLife(p) {
      const dL = byId.get('useful_life');
      if (!dL || !E.lifeReadout) return;
      const L0 = cur('useful_life'), L1 = Math.abs(L0 - 3) < 1e-9 ? dL.base : 3;
      if (Math.abs(L0 - L1) < 1e-9) return;
      const lr = E.lifeReadout(spec, st.ov, { lives: [L0, L1], events: st.ev });
      if (!lr || lr.error) return;
      const lifeEv = EVS.find(e => e.impacts && isNum(e.impacts.useful_life_delta));
      const econ = Array.isArray(lr.value_per_share_economic), same = Math.abs(lr.value_per_share[0] - lr.value_per_share[1]) < 0.005;
      const burry = scen.find(x => x.id === 'burry_case');
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'life' }, `Depreciation: reported profit at a ${fmt(L0, '', 1)}-year vs a ${fmt(L1, '', 1)}-year GPU life`));
      p.appendChild(h('p', { class: 'mdl-note' }, `The company depreciates its GPUs over ${fmt(dL.base, '', 0)} years. The bear argument (Michael Burry’s among others) is that a GPU earns top rates for only 2–3 years, `
        + 'because NVIDIA ships a much better chip every ~2 years. As accounting alone (the table): the same cash and EBITDA, only D&A, operating profit, net income and EPS move, '
        + `so value per share is ${same ? 'unchanged' : 'almost unchanged'} (${fmt(lr.value_per_share[0], 'US$', 2)} at ${fmt(L0, '', 1)} years, ${fmt(lr.value_per_share[1], 'US$', 2)} at ${fmt(L1, '', 1)}). `
        + (econ ? `As economics, the GPUs also earn rent for only ${fmt(L1, '', 1)} years, so the fleet does not renew after its first contract and the exit multiple re-rates with its run-off value: `
          + `${fmt(lr.value_per_share_economic[0], 'US$', 2)} at ${fmt(L0, '', 1)} years against ${fmt(lr.value_per_share_economic[1], 'US$', 2)} at ${fmt(L1, '', 1)}.` : ''),
      lifeEv ? [' The same idea as a business event: ', evLink(lifeEv.id), '.'] : null));
      const rows = [];
      for (const [k, name, dp] of [['da', 'D&A', 0], ['adj_op_income', 'Adj. operating income', 0], ['net_income', 'Net income', 0], ['eps', 'EPS (US$)', 2]]) {
        const a = lr.rows[k][0], b = lr.rows[k][1];
        rows.push({ key: `${k}0`, label: `${name} · ${fmt(L0, '', 1)}-yr life`, values: a, unit: k === 'eps' ? 'US$' : 'US$m', dp, strong: k === 'net_income', good: GOOD[k] });
        rows.push({ key: `${k}1`, label: `${name} · ${fmt(L1, '', 1)}-yr life`, values: b, unit: k === 'eps' ? 'US$' : 'US$m', dp, sub: true, strong: false, good: GOOD[k] });
      }
      p.appendChild(rowTable({ rows: {} }, rows, { aria: 'Profit at two depreciation lives', caption: 'Reported profit by depreciation life', corner: 'US$m unless stated' }));
      if (Math.abs(L0 - 3) > 1e-9 && dL.min <= 3) {
        const btn = h('button', { type: 'button', class: 'rpt-btn mdl-ctl', 'data-mdl-life': '3' }, burry ? `Apply the ${str(burry.name)} preset` : 'Run the whole model at a 3-year life');
        btn.addEventListener('click', () => {
          if (burry && chipEls.has(burry.id)) chipEls.get(burry.id).click(); else { setDriver('useful_life', 3); status('Depreciation life set to 3 years.'); }
          // the button is rebuilt with the panel: keep the keyboard on the slider it moved
          const r = st.refs.get('useful_life');
          if (r && r.range) { try { r.range.focus({ preventScroll: true }); } catch { r.range.focus(); } }
        });
        p.appendChild(h('p', { class: 'mdl-note' }, btn));
      }
    }

    // ---- Interest & debt ----
    function trancheSeries(res) {
      const ids = tranches.map(t => t.id).filter(id => res.rows.interest_by_tranche[id]);
      const ranked = ids.slice().sort((a, b) => (tranches.find(t => t.id === b).balance || 0) - (tranches.find(t => t.id === a).balance || 0));
      const keep = new Set(ranked.slice(0, SERIES.length - 2));
      const name = id => str((tranches.find(t => t.id === id) || {}).name || id);
      const out = [];
      if (stubbed) out.push({ id: '_actual', name: `${spec.stub.actual_months}-month actual (all debt)`, color: C_ACTUAL, values: res.rows.interest_actual });
      let ci = 0;
      for (const id of ids) if (keep.has(id)) out.push({ id, name: name(id), color: SERIES[ci++], values: res.rows.interest_by_tranche[id] });
      const other = ids.filter(id => !keep.has(id));
      if (other.length) out.push({ id: '_other', name: `Other tranches (${other.length})`, color: C_OTHER, values: years.map((_, i) => other.reduce((s, id) => s + (res.rows.interest_by_tranche[id][i] || 0), 0)) });
      const fac = facilities.map(x => res.rows.interest_by_tranche[x.id]).filter(Boolean);
      if (fac.length && fac.some(a => a.some(x => x > 0.5))) out.push({ id: '_committed', name: 'Committed facility draws', color: SERIES[SERIES.length - 2], values: years.map((_, i) => fac.reduce((s, a) => s + (a[i] || 0), 0)) });
      const nd = res.rows.interest_by_tranche[E.NEW_DEBT_ID];
      if (nd && nd.some(x => x > 0.5)) out.push({ id: E.NEW_DEBT_ID, name: 'New & refinancing debt', color: SERIES[SERIES.length - 1], values: nd });
      return out;
    }
    // principal falling due per year: the opening stack and the model's own borrowing, by instrument type
    function ladder(res) {
      const openY = +str(spec.opening && spec.opening.date).slice(0, 4) || years[0];
      const mIdx = s => { const x = /^(\d{4})-(\d{2})/.exec(str(s)); return x ? +x[1] * 12 + +x[2] : null; };
      const om = mIdx(spec.opening && spec.opening.date);
      const lastY = openY + 12, ly = [];
      for (let y = openY; y <= lastY; y++) ly.push(y);
      const G = [['DDTL loans', SERIES[0]], ['Senior notes', SERIES[1]], ['Convertibles', SERIES[2]], ['OEM & other', C_OTHER],
        ['Revolver & committed draws', SERIES[3]], ['New debt raised by the model (5-yr tenor assumed)', SERIES[4]]];
      const vals = G.map(() => ly.map(() => 0));
      const add = (g, y, v) => { const i = ly.indexOf(y); if (i >= 0 && isNum(v)) vals[g][i] += v; else if (y > lastY && isNum(v)) vals[g][ly.length - 1] += v; };
      const groupOf = id => (/^ddtl/.test(id) ? 0 : /^notes/.test(id) ? 1 : /^conv/.test(id) ? 2 : /^revolver/.test(id) ? 4 : 3);
      for (const t of tranches) {
        const g = groupOf(t.id), my = +str(t.maturity).slice(0, 4), mm = mIdx(t.maturity);
        if (t.amort === 'schedule' && t.schedule && typeof t.schedule === 'object') {
          for (const [y, v] of Object.entries(t.schedule)) add(g, Math.max(openY, +y), v);
        } else if ((t.amort === 'straight' || t.amort === 'cashsweep') && om !== null && mm !== null) {
          const s0 = Math.max(om, mIdx(t.issued) || om, mIdx(t.amort_start) || om);
          if (mm > s0) ly.forEach((y, i) => { vals[g][i] += t.balance * Math.max(0, Math.min((y + 1) * 12, mm) - Math.max(y * 12, s0)) / (mm - s0); });
          else add(g, my, t.balance);
        } else add(g, my, t.balance);
      }
      for (const x of facilities) {
        const b = res.rows.debt_by_tranche[x.id];
        if (b) add(4, +str(x.maturity).slice(0, 4), b[b.length - 1]);
      }
      years.forEach((y, i) => add(5, y + 5, res.rows.uncommitted_debt ? res.rows.uncommitted_debt[i] : 0));
      return { labels: ly.map(String), series: G.map(([name, color], g) => ({ id: `g${g}`, name, color, values: vals[g] })).filter(s => s.values.some(x => x > 0.5)) };
    }
    // The debt stack today (every tranche in the spec, incl. debt issued after the balance-sheet
    // date; undrawn facilities excluded), from the engine: fixed coupons + swapped-to-fixed vs
    // floating, and the annual run-rate interest on it at the first year's SOFR.
    function stackToday(res) {
      const s0 = at(res, 'sofr', years[0]);
      const m = E.debtMix ? E.debtMix(spec, { sofr: isNum(s0) ? s0 : undefined }) : null;
      if (!m || m.error) return { fixed: null, coupon: null, swapped: null, flt: null, shareDebt: null, shareInt: null, iFix: null, iFlt: null, sofr: s0 };
      return { fixed: m.fixed, coupon: m.coupon, swapped: m.swapped, flt: m.floating, total: m.total, shareDebt: m.floating_share, shareInt: m.interest_floating_share,
        iFix: m.interest_fixed, iFlt: m.interest_floating, sofr: m.sofr };
    }
    // Interest & debt, first: how much of the debt and the interest bill is fixed vs floating
    // (after swaps), by year, and what a SOFR move does to it.
    function renderFixFloat(p, res, up, up2) {
      const R = res.rows, T = stackToday(res), lab = years.map(yl), ki = years.indexOf(KY);
      const und = facilities.reduce((s, x) => s + (isNum(x.amount) ? x.amount : 0), 0);
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'ff' }, 'Fixed vs floating'));
      const fixSh = isNum(T.shareDebt) ? 100 - T.shareDebt : null;
      p.appendChild(h('p', { class: 'mdl-ffhead', 'data-mdl-ff': 'headline' }, h('strong', null,
        `Today: ${fmt(fixSh, '%', 0)} of debt fixed / ${fmt(T.shareDebt, '%', 0)} floating (after hedges) — ${fmt(T.shareInt, '%', 0)} of interest reprices with SOFR`),
      ` · in ${ylong(KY)}, with the new borrowing, ${fmt(R.floating_share_of_interest[ki], '%', 0)} of interest floats.`));
      const tile = (key, label, value, sub) => h('div', { class: 'mdl-kpi', role: 'listitem', 'data-mdl-ff': key }, h('div', { class: 'mdl-kpi-l' }, label), h('div', { class: 'mdl-kpi-v' }, value), h('div', { class: 'mdl-kpi-s' }, sub));
      p.appendChild(h('div', { class: 'mdl-kpis mdl-ff mdl-strip', role: 'list', 'aria-label': 'Fixed vs floating today' },
        tile('fixed', 'Fixed rate today', `${money(T.fixed)} · ${fmt(fixSh, '%', 0)}`, `${money(T.coupon)} fixed coupons + ${money(T.swapped)} swapped to fixed`),
        tile('floating', 'Floating today', `${money(T.flt)} · ${fmt(T.shareDebt, '%', 0)}`, `SOFR + margin, resets with rates${und > 0 ? ` · plus ${money(und)} of undrawn committed facilities` : ''}`),
        tile('interest', 'Interest that floats', fmt(T.shareInt, '%', 0), `of ${money(T.iFix + T.iFlt)} a year on today’s stack at SOFR ${fmt(T.sofr, '%', 2)}`),
        tile('ky', `${ylong(KY)}: +100bp SOFR`, money(R.rate_exposure_100bp[ki], true), `extra interest · ${fmt(R.floating_share_of_interest[ki], '%', 0)} of the year’s interest floats`)));
      const nf = byId.has('new_debt_floating_share') ? cur('new_debt_floating_share') : null, hr = byId.has('hedge_ratio_new') ? cur('hedge_ratio_new') : null;
      p.appendChild(h('p', { class: 'mdl-note' }, `Today = every tranche in the debt stack (incl. debt issued after the ${str(spec.opening && spec.opening.date)} balance sheet), with interest-rate swaps counted as fixed. `
        + (isNum(nf) ? `New borrowing: ${fmt(nf, '%', 0)} raised floating (SOFR-priced, asset-backed delayed-draw loans) and ${fmt(hr, '%', 0)} of that swapped to fixed when raised; the rest as fixed-coupon notes that lock the year’s new-debt rate (drivers under Financing & rates).`
          : 'New and refinanced borrowing reprices each year at that year’s new-debt rate, so all of it moves with SOFR.')));
      const dS = [{ name: 'Fixed (incl. swapped)', color: C_FIX, values: R.debt_fixed }, { name: 'Floating (unhedged)', color: C_FLT, values: R.debt_floating },
        { name: 'New & refinanced: fixed', color: C_NFIX, values: R.debt_new_fixed }, { name: 'New & refinanced: floating', color: C_NFLT, values: R.debt_new_floating }];
      p.appendChild(chartBox(stackedBars({ id: `${uid}-dmix`, title: 'Year-end debt by rate type (US$m)', labels: lab, series: dS, unit: 'US$m',
        sub: R.floating_share_of_debt.map(x => (isNum(x) ? `${fmt(x, '%', 0)} floats` : '')),
        desc: years.map((_, i) => `${lab[i]}: ${dS.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }), legend(dS.map(s => [s.name, s.color]))));
      const iS = (stubbed ? [{ name: `${spec.stub.actual_months}-month actual (all debt)`, color: C_ACTUAL, values: R.interest_actual }] : []).concat([
        { name: 'On fixed (incl. swapped)', color: C_FIX, values: R.interest_fixed }, { name: 'On floating', color: C_FLT, values: R.interest_floating },
        { name: 'On new & refinanced: fixed', color: C_NFIX, values: R.interest_new_fixed }, { name: 'On new & refinanced: floating', color: C_NFLT, values: R.interest_new_floating }]);
      p.appendChild(chartBox(stackedBars({ id: `${uid}-imix`, title: 'Interest expense by rate type (US$m)', labels: lab, series: iS, unit: 'US$m',
        sub: R.floating_share_of_interest.map(x => (isNum(x) ? `${fmt(x, '%', 0)} floats` : '')),
        desc: years.map((_, i) => `${lab[i]}: ${iS.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }), legend(iS.map(s => [s.name, s.color]))));
      // rate exposure, year by year (exact re-runs of the model)
      const ov = (k, r) => (r && !r.error && Array.isArray(r.rows[k]) ? r.rows[k] : years.map(() => null));
      const dif = (k, r) => (r && !r.error && Array.isArray(r.rows[k]) ? r.rows[k].map((x, i) => (isNum(x) && isNum(R[k][i]) ? x - R[k][i] : null)) : years.map(() => null));
      const fl2 = k => ov(k, up2), vRow = r => years.map((_, i) => (i === years.length - 1 && r && !r.error ? r.valuation.value_per_share : null));
      p.appendChild(rowTable(res, [{ key: 'debt_fixed', label: 'Debt at a fixed rate, incl. swapped (year-end)' }, { key: 'debt_floating', label: 'Debt floating with SOFR, unhedged (year-end)' },
        { key: 'debt_new_fixed', label: 'New & refinanced debt: fixed (year-end)', sub: true }, { key: 'debt_new_floating', label: 'New & refinanced debt: floating (year-end)', sub: true },
        { key: 'interest_fixed', label: 'Interest on fixed-rate debt' }, { key: 'interest_floating', label: 'Interest on floating debt' },
        { key: 'interest_new_fixed', label: 'Interest on new & refinanced debt: fixed', sub: true }, { key: 'interest_new_floating', label: 'Interest on new & refinanced debt: floating', sub: true },
        { key: 'floating_share_of_debt', strong: true }, { key: 'floating_share_of_interest', strong: true },
        { key: 'rate_exposure_100bp', label: '+100bp SOFR: extra interest', strong: true }, { key: 'rate_exposure_reset', label: 'of which floating debt resetting', sub: true },
        { key: 'rate_exposure_issuance', label: 'of which new fixed debt issued at higher rates', sub: true },
        { key: 're200', label: '+200bp SOFR: extra interest', values: dif('interest', up2), unit: 'US$m', dp: 0, good: -1, strong: true },
        { key: 're200r', label: 'of which floating debt resetting', values: years.map((_, i) => (up2 && !up2.error ? fl2('interest_floating')[i] + fl2('interest_new_floating')[i] - R.interest_floating[i] - R.interest_new_floating[i] : null)), unit: 'US$m', dp: 0, sub: true, good: -1 },
        { key: 'ni100', label: 'Net income at +100bp SOFR', values: ov('net_income', up), unit: 'US$m', dp: 0, good: 1 },
        { key: 'ni200', label: 'Net income at +200bp SOFR', values: ov('net_income', up2), unit: 'US$m', dp: 0, good: 1, sub: true },
        { key: 'eps100', label: 'EPS at +100bp / +200bp SOFR (US$)', values: years.map((_, i) => (isNum(ov('eps', up)[i]) ? ov('eps', up)[i] : null)), unit: 'US$', dp: 2, good: 1 },
        { key: 'eps200', label: 'EPS at +200bp SOFR (US$)', values: ov('eps', up2), unit: 'US$', dp: 2, good: 1, sub: true },
        { key: 'interest_cover', label: 'Interest cover (EBITDA ÷ interest, x)' }, { key: 'ic100', label: 'at +100bp SOFR (x)', values: ov('interest_cover', up), unit: 'x', dp: 1, sub: true, good: 1 },
        { key: 'ic200', label: 'at +200bp SOFR (x)', values: ov('interest_cover', up2), unit: 'x', dp: 1, sub: true, good: 1 },
        { key: 'interest_to_ebitda', label: 'Interest as % of adj. EBITDA (%)', dp: 1 }, { key: 'ie100', label: 'at +100bp SOFR (%)', values: ov('interest_to_ebitda', up), unit: '%', dp: 1, sub: true, good: -1 },
        { key: 'ie200', label: 'at +200bp SOFR (%)', values: ov('interest_to_ebitda', up2), unit: '%', dp: 1, sub: true, good: -1 }],
      { withDelta: true, aria: 'Rate exposure by year', caption: 'Fixed vs floating and rate exposure by year', corner: 'After swaps; US$m unless stated' }));
      if (!up.error && !up2.error) {
        const v0 = res.valuation, sh = byId.get('rate_shock_start'), si = sh ? Math.round(cur('rate_shock_start')) : 0;
        p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'ratevalue' }, h('strong', null, 'Value per share at +100 / +200bp SOFR: '),
          `${fmt(up.valuation.value_per_share, 'US$', 2)} / ${fmt(up2.valuation.value_per_share, 'US$', 2)} against ${fmt(v0.value_per_share, 'US$', 2)} (exit at end-${v0.balance_sheet_year}); `
          + `exiting at end-${years[years.length - 1]} instead, which sees the interest to then: ${fmt(up.valuation.value_last_year_exit, 'US$', 2)} / ${fmt(up2.valuation.value_last_year_exit, 'US$', 2)} against ${fmt(v0.value_last_year_exit, 'US$', 2)}. `
          + (sh ? `The shock starts ${inSentence((sh.choices[si] || {}).name)}; with` : 'With')
          + ' an immediate, permanent shift the fixed / floating mix changes when the extra interest lands more than its total; with a later shock, the debt fixed by then is protected.',
        sh ? [' ', driverLink('rate_shock_start')] : null));
      }
      // the swaps themselves
      if (HEDGES.length) {
        const nameOf = id => str((tranches.find(t => t.id === id) || facilities.find(x => x.id === id) || {}).name || id);
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Interest-rate hedges' },
          h('table', { class: 'rpt-table mdl-table' }, h('caption', { class: 'mdl-cap' }, 'Interest-rate hedges'),
            h('thead', null, h('tr', null, ['Hedge', 'On', 'Amount', 'Pays', 'Period'].map((c, i) => h('th', { scope: 'col', class: i === 2 ? 'r' : 'l' }, c)))),
            h('tbody', null, HEDGES.map(x => h('tr', null, h('th', { scope: 'row', class: 'l' }, str(x.name || x.id), x.src && x.src.length ? rich.cite(x.src) : null),
              h('td', { class: 'l' }, nameOf(x.tranche)),
              h('td', { class: 'r' }, isNum(x.ratio) ? `${fmt(x.ratio * 100, '%', 0)} of the balance` : money(x.notional)),
              h('td', { class: 'l' }, x.type === 'cross_currency' ? 'cross-currency (no rate effect)' : isNum(x.fixed_rate) ? `${fmt(x.fixed_rate, '%', 2)}${x.estimated ? ' (est.)' : ''} + the loan’s margin` : 'SOFR path at the start + margin',
                x.note ? h('span', { class: 'mdl-th-note' }, rich.inline(x.note)) : null),
              h('td', { class: 'l' }, `${x.start ? monthText(x.start) : 'now'} → ${x.maturity ? monthText(x.maturity) : 'loan maturity'}`)))))));
      } else p.appendChild(h('p', { class: 'mdl-note' }, 'No interest-rate swaps are in the model: floating debt resets with SOFR in full.'));
    }
    function renderDebt(p, res) {
      const R = res.rows, sofrSh = cur('sofr_shift'), pi = Math.round(cur('rate_path') || 0);
      const baseName = str(spec.rates && spec.rates.base_name || 'SOFR');
      // +100 / +200 bp on SOFR: exact re-runs (they also drive the readout below)
      const sd = byId.get('sofr_shift');
      const upRun = bp => (sd ? E.project(spec, Object.assign({}, st.ov, { sofr_shift: Math.min(sd.max, sofrSh + bp) }), { events: st.ev, exposure: false }) : { error: 'no sofr_shift' });
      const up = upRun(100), up2 = upRun(200);
      renderFixFloat(p, res, up, up2);
      p.appendChild(h('div', { class: 'mdl-row' }, h('h4', { class: 'mdl-h4' }, 'Predicted rate paths'),
        hasPaths ? h('label', { class: 'mdl-sel-l' }, 'Path ', pathSelect(pathD, `${uid}-pathsel`, 'SOFR path (Interest & debt tab)', true)) : null));
      const series = PATHS.map((pa, j) => ({ name: `${pa.name}${j === pi ? ' (selected)' : ''}`, short: str(pa.name).replace(/\s*[(,].*$/, '').slice(0, 16), color: PATH_COLORS[j % PATH_COLORS.length],
        values: pa.path, dash: j !== pi, faint: j !== pi }));
      if (Math.abs(sofrSh) > 1e-9) series.push({ name: `${baseName} with the ${fmt(sofrSh, 'bp', 0, true)} shift`, short: `${baseName} now`, color: PATH_COLORS[pi % PATH_COLORS.length], values: R.sofr });
      series.push({ name: 'New-debt rate (marginal cost of new and refinanced debt)', short: 'New debt', color: C_HIGH, values: R.new_debt_rate });
      series.push({ name: 'All-in average cost of debt', short: 'Avg debt', color: '#cbd5e1', values: R.avg_cost_of_debt, dash: true });
      p.appendChild(h('p', { class: 'mdl-note' }, `Annual average ${baseName} on each path, the cost of new and refinanced debt (it follows the selected path and the SOFR and spread sliders) `
        + 'and the all-in average cost of debt (interest ÷ average debt). Floating tranches pay SOFR plus their contractual margin; fixed notes keep their coupon until they mature.'));
      p.appendChild(chartBox(lineChart({ id: `${uid}-rates`, title: 'Predicted rate paths, new-debt rate and average cost of debt (%)', labels: years.map(yl), series, unit: '%', dp: 2,
        desc: series.map(s => `${s.name}: ${s.values.map((x, i) => `${yl(years[i])} ${fmt(x, '%', 2)}`).join(', ')}`).join('; ') }),
      legend(series.map(s => [s.name, s.color, s.dash]))));
      // the readout: what +100bp on SOFR does, and how much of the debt reprices
      if (!up.error) {
        const xi = years.indexOf(XY), d1 = at(up, 'interest', KY) - at(res, 'interest', KY), d2 = at(up, 'interest', XY) - at(res, 'interest', XY);
        const dv = up.valuation.value_per_share - res.valuation.value_per_share;
        const sh = byId.get('rate_shock_start'), si = sh ? Math.round(cur('rate_shock_start')) : 0;
        const from = sh && sh.choices[si] ? ` (${inSentence(sh.choices[si].name)})` : spec.rates && spec.rates.shift_from ? ` from ${monthText(spec.rates.shift_from)}` : '';
        p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'sofr' }, h('strong', null, `+100bp on ${baseName}${from}`),
          ` adds ${money(d1)} to ${ylong(KY)} and ${money(d2)} to ${ylong(XY)} interest; by end-${XY}, ${fmt(R.floating_share_of_debt[xi], '%', 0)} of the debt floats after swaps (incl. new floating borrowing) `
          + `and ${fmt(R.floating_share_of_interest[xi], '%', 0)} of that year’s interest. `
          + `Through the cost of capital it moves value per share by ${fmt(dv, 'US$', 2, true)} (exit multiple ${fmt(res.valuation.exit_multiple_eff, 'x', 1)} → ${fmt(up.valuation.exit_multiple_eff, 'x', 1)}).`));
      }
      if (spec.rates && (spec.rates.note || spec.rates.src)) {
        p.appendChild(h('p', { class: 'mdl-src' }, 'Rate paths: ', rich.inline(spec.rates.note || ''), Array.isArray(spec.rates.src) ? rich.cite(spec.rates.src) : null));
      }

      // interest by tranche + the company's guide as a bracket on the stub year
      const ts = trancheSeries(res);
      const marks = [], gl = [];
      for (const g of guides.filter(x => x.metric === 'interest')) {
        const mv = guideValue(res, spec, g);
        const m = /^(\d{4})-Q([1-4])$/.exec(str(g.period));
        if (m && stubbed && +m[1] === years[0] && isNum(g.lo) && isNum(g.hi)) {
          const left = 4 - spec.stub.actual_months / 3, act = spec.stub.actuals.interest;
          marks.push({ i: 0, lo: act + g.lo * left, hi: act + g.hi * left, label: `${ylong(years[0])} implied by the ${str(g.label)}` });
        }
        gl.push(h('li', null, h('strong', null, str(g.label)), `: ${fmt(g.lo, 'US$m', 0)}–${fmt(g.hi, 'US$m', 0)} `, Array.isArray(g.src) ? rich.cite(g.src) : null,
          ` · model ${fmt(mv, 'US$m', 0)} `, passPill(isNum(mv) ? (mv >= g.lo && mv <= g.hi) : null)));
      }
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Interest expense by tranche'));
      p.appendChild(chartBox(stackedBars({ id: `${uid}-int`, title: 'Interest expense by tranche (US$m)', labels: years.map(yl), series: ts, unit: 'US$m', marks,
        desc: years.map((y, i) => `${yl(y)}: ${ts.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }),
      legend(ts.map(s => [s.name, s.color]).concat(marks.length ? [['Company guide (implied full year)', 'var(--rpt-strong)', true]] : []))));
      if (gl.length) p.appendChild(h('ul', { class: 'rpt-bul mdl-guides' }, gl));
      p.appendChild(h('p', { class: 'mdl-note' }, `Of which non-cash (issue costs and discount amortised through interest): ${years.map((y, i) => `${yl(y)} ${money(R.interest_noncash[i])}`).join(' · ')}.`));

      // how the funding gap is met
      const fs = [{ name: 'Committed facilities', color: SERIES[3], values: R.committed_draws }, { name: 'New (uncommitted) debt', color: SERIES[4], values: R.uncommitted_debt },
        { name: 'Equity sold', color: SERIES[1], values: R.new_equity_m }].filter(s => s.values.some(x => x > 0.5));
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Funding the gap'));
      const commit = facilities.reduce((s, x) => s + (isNum(x.amount) ? x.amount : 0), 0);
      p.appendChild(h('p', { class: 'mdl-note' }, `Each year’s gap (capex, scheduled repayments and the cash floor not covered by operating cash flow and debt issued after the balance-sheet date) is met by `
        + `${facilities.length ? `drawing the ${money(commit)} of committed, undrawn facilities while their windows are open, then ` : ''}new debt at the new-debt rate and the equity share. `
        + `Uncommitted need (cumulative): ${years.map((y, i) => `${yl(y)} ${money(R.uncommitted_cum[i])}`).join(' · ')}.`));
      if (fs.length) p.appendChild(chartBox(stackedBars({ id: `${uid}-fund`, title: 'How the funding gap is met (US$m)', labels: years.map(yl), series: fs, unit: 'US$m',
        desc: years.map((y, i) => `${yl(y)}: ${fs.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }), legend(fs.map(s => [s.name, s.color]))));
      // "borrow big, build big, collect rent, pay the bank": the yearly borrowing the plan needs
      const gb = R.gross_borrowing.filter(isNum), avgB = gb.length ? sum(gb) / gb.length : null;
      const capEv = EVS.find(e => e.impacts && e.impacts.new_debt_cap);
      const shortY = years.filter((_, i) => isNum(R.funding_shortfall[i]) && R.funding_shortfall[i] > 0.5);
      p.appendChild(h('p', { class: 'mdl-readout', 'data-mdl-readout': 'borrowing' }, h('strong', null, `Borrowing need: ${money(avgB)} a year`),
        ` on average ${yl(years[0])}–${yl(years[years.length - 1])} (new money and refinancing, incl. committed facility draws). `
        + 'The plan works only while lenders keep lending.',
        shortY.length ? ` In this run ${shortY.map(yy => `${money(R.funding_shortfall[years.indexOf(yy)])} in ${yl(yy)}`).join(', ')} cannot be raised: cash falls below the minimum.` : null,
        capEv ? [' What if they stop? ', evLink(capEv.id), '.'] : null));
      p.appendChild(rowTable(res, ['gross_borrowing', { key: 'refinanced', sub: true }, { key: 'new_debt', label: 'New debt raised (new money)', sub: true },
        { key: 'committed_draws', sub: true }, { key: 'uncommitted_debt', sub: true }, 'new_equity_m', 'funding_shortfall', 'uncommitted_cum'].filter(r => {
        const k = typeof r === 'string' ? r : r.key;
        return k !== 'funding_shortfall' || shortY.length || (BR.funding_shortfall || []).some(x => x > 0.5);
      }), { withDelta: true, aria: 'Borrowing by year', caption: 'Borrowing by year', corner: 'US$m' }));
      if (facilities.length) {
        p.appendChild(h('ul', { class: 'rpt-bul mdl-guides' }, facilities.map(x => h('li', null, h('strong', null, str(x.name)), `: ${money(x.amount)} undrawn, `,
          x.kind === 'fixed' ? `fixed ${fmt(x.coupon_pct, '%', 2)}` : `SOFR + ${fmt(x.spread_bp, '', 0)} bp`, `, available to ${str(x.available_until)}${x.amortises ? ', amortising to maturity after that' : ''}; outstanding at end-${XY}: ${money(R.debt_by_tranche[x.id] ? R.debt_by_tranche[x.id][years.indexOf(XY)] : 0)}`,
          x.note ? [' — ', rich.inline(x.note)] : null, Array.isArray(x.src) ? rich.cite(x.src) : null))));
        if (spec.funding && spec.funding.note) p.appendChild(h('p', { class: 'mdl-src' }, rich.inline(spec.funding.note), Array.isArray(spec.funding.src) ? rich.cite(spec.funding.src) : null));
      }

      // leverage and coverage against the covenants and thresholds
      const covs = Array.isArray(res.covenants) ? res.covenants : [];
      const levS = [['gross_debt_ebitda', 'Total debt / EBITDA', SERIES[0]], ['secured_debt_ebitda', 'Secured debt / EBITDA', SERIES[2]], ['net_debt_ebitda', 'Net debt / EBITDA', SERIES[3]]]
        .map(([k, name, color]) => ({ name, short: name.split(' / ')[0], color, values: R[k] }));
      for (const c of covs.filter(x => /debt_ebitda$/.test(x.metric) && isNum(x.max))) levS.push({ name: `${c.label}`, short: c.metric === 'secured_debt_ebitda' ? 'Secured cap' : c.kind === 'covenant' ? 'Cap' : 'Limit', color: C_LIMIT, values: years.map(() => c.max), dash: true });
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Leverage & coverage by year'));
      p.appendChild(h('p', { class: 'mdl-note' }, 'Debt over each year’s adj. EBITDA, against the caps the notes reportedly carry (dashed). A year above a cap is a breach: '
        + 'the company could not add debt under the notes’ general basket. Years with EBITDA at or below zero show no ratio.'));
      p.appendChild(chartBox(lineChart({ id: `${uid}-lev`, title: 'Leverage by year (x EBITDA)', labels: years.map(yl), series: levS, unit: 'x', dp: 1,
        desc: levS.map(s => `${s.name}: ${s.values.map((x, i) => `${yl(years[i])} ${fmt(x, 'x', 1)}`).join(', ')}`).join('; ') }), legend(levS.map(s => [s.name, s.color, s.dash]))));
      const cvS = [{ name: 'Interest cover (EBITDA / interest)', short: 'EBITDA cover', color: SERIES[0], values: R.interest_cover },
        { name: 'EBIT / interest', short: 'EBIT cover', color: SERIES[3], values: R.ebit_cover }];
      for (const c of covs.filter(x => x.metric === 'interest_cover' && isNum(x.min))) cvS.push({ name: str(c.label), short: 'Floor', color: C_LIMIT, values: years.map(() => c.min), dash: true });
      const capCov = R.ebitda_capex_cover.filter(isNum);
      p.appendChild(h('p', { class: 'mdl-note' }, `EBITDA after capex covers interest (≥ 1x) in ${capCov.filter(x => x >= 1).length} of ${capCov.length} years; `
        + '(EBITDA − capex) ÷ interest is in the table below, off the chart to keep its scale readable.'));
      p.appendChild(chartBox(lineChart({ id: `${uid}-cov`, title: 'Interest coverage by year (x)', labels: years.map(yl), series: cvS, unit: 'x', dp: 1,
        desc: cvS.map(s => `${s.name}: ${s.values.map((x, i) => `${yl(years[i])} ${fmt(x, 'x', 1)}`).join(', ')}`).join('; ') }), legend(cvS.map(s => [s.name, s.color, s.dash]))));
      const covRows = [['gross_debt_ebitda', 'Total debt / EBITDA'], ['secured_debt_ebitda', 'Secured debt / EBITDA'], ['net_debt_ebitda', 'Net debt / EBITDA'],
        ['interest_cover', 'EBITDA / interest'], ['ebitda_capex_cover', '(EBITDA − capex) / interest'], ['ebit_cover', 'EBIT / interest']];
      const covBody = covRows.map(([k, label]) => {
        const c = covs.find(x => x.metric === k);
        return h('tr', null, h('th', { scope: 'row', class: 'l' }, label, c ? h('span', { class: 'mdl-th-note' }, `${limitText(c)} (${c.kind})`) : null, c && c.src && c.src.length ? rich.cite(c.src) : null),
          years.map((y, i) => h('td', { class: `r${c && c.breach[i] === true ? ' mdl-breach' : ''}` }, fmt(R[k][i], 'x', k === 'ebit_cover' ? 2 : 1), c && c.breach[i] === true ? h('span', { class: 'mdl-cd neg' }, c.kind === 'covenant' ? 'breach' : 'below') : null)));
      });
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Leverage and coverage by year' },
        h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Ratio'), years.map(y => h('th', { scope: 'col', class: 'r' }, ylong(y))))),
          h('tbody', null, covBody))));
      if (covs.length && scen.length) {
        // presets do not depend on the sliders: run each once per mount
        const rows = scen.map(s => {
          if (!scenRuns.has(s.id)) scenRuns.set(s.id, E.project(spec, E.applyScenario(spec, s.id) || {}));
          const r = scenRuns.get(s.id);
          return h('tr', null, h('th', { scope: 'row', class: 'l' }, str(s.name)),
            covs.map(c => { const rc = r.error ? null : r.covenants.find(x => x.id === c.id); return h('td', { class: 'r' }, rc ? (rc.first_breach ? yl(rc.first_breach) : 'never') : '—'); }));
        });
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'First year crossed, by scenario' },
          h('table', { class: 'rpt-table mdl-table' }, h('caption', { class: 'mdl-cap' }, 'First year each limit is crossed, by scenario preset'),
            h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Scenario'), covs.map(c => h('th', { scope: 'col', class: 'r' }, str(c.label).replace(/\s*\(.*\)$/, ''))))),
            h('tbody', null, rows))));
      }

      // maturity ladder: the opening stack by instrument type, plus the model's own borrowing
      const lad = ladder(res);
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Debt maturity ladder'));
      p.appendChild(h('p', { class: 'mdl-note' }, `Principal falling due each year: the ${str(spec.opening && spec.opening.date)} stack and later issues (amortising loans on their schedules), `
        + 'committed facility draws at the facility’s maturity, and the model’s new borrowing assumed to mature five years after it is raised: the refinancing wall the projections lean on.'));
      p.appendChild(chartBox(stackedBars({ id: `${uid}-mat`, title: 'Debt maturity ladder (US$m of principal)', labels: lad.labels, series: lad.series, unit: 'US$m',
        desc: lad.labels.map((y, i) => `${y}: ${lad.series.filter(s => s.values[i] > 0.5).map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ') || 'none'}`).join('; ') }),
      legend(lad.series.map(s => [s.name, s.color]))));

      // debt table
      const color = (() => { const m = new Map(); for (const s of ts) m.set(s.id, s.color); return id => m.get(id) || C_OTHER; })();
      const rateNow = id => (R.rate_by_tranche[id] ? R.rate_by_tranche[id].find(isNum) : null);
      const swapsOn = id => HEDGES.filter(x => x.tranche === id && x.type !== 'cross_currency');
      const terms = t => (t.kind === 'floating' ? `Floating, SOFR + ${fmt(t.spread_bp, '', 0)} bp` : `Fixed ${fmt(t.coupon_pct, '%', 3)}`) + (isNum(t.fee_bp) && t.fee_bp > 0 ? ` (+${fmt(t.fee_bp, '', 0)} bp fees)` : '')
        + swapsOn(t.id).map(x => `; ${isNum(x.ratio) ? fmt(x.ratio * 100, '%', 0) : money(x.notional)} swapped to ${isNum(x.fixed_rate) ? fmt(x.fixed_rate, '%', 2) : 'fixed'}`).join('');
      const rows = tranches.map(t => h('tr', null,
        h('th', { scope: 'row', class: 'l' }, h('i', { class: 'mdl-sw', style: `background:${color(t.id)}`, 'aria-hidden': 'true' }), str(t.name || t.id),
          Array.isArray(t.src) ? rich.cite(t.src) : null, t.note ? h('span', { class: 'mdl-th-note' }, rich.inline(t.note)) : null),
        h('td', { class: 'r' }, fmt(t.balance, '', 0), t.issued ? h('span', { class: 'mdl-th-note' }, `from ${str(t.issued)}`) : null),
        h('td', { class: 'l' }, terms(t)),
        h('td', { class: 'r' }, fmt(rateNow(t.id), '%', 2)),
        h('td', { class: 'r' }, str(t.maturity)),
        h('td', { class: 'l' }, [t.amort, t.secured ? 'secured' : 'unsecured', t.recourse === false ? 'non-recourse' : null].filter(Boolean).join(', '))));
      const ndEnd = R.debt_by_tranche[E.NEW_DEBT_ID];
      const xi = years.indexOf(XY);
      if (ndEnd && ndEnd[xi] > 0.5) rows.push(h('tr', null, h('th', { scope: 'row', class: 'l' }, h('i', { class: 'mdl-sw', style: `background:${color(E.NEW_DEBT_ID)}`, 'aria-hidden': 'true' }), 'New debt raised by the model'),
        h('td', { class: 'r' }, `${fmt(ndEnd[xi], '', 0)} by ${yl(XY)}`), h('td', { class: 'l' }, 'New-debt rate'), h('td', { class: 'r' }, fmt(R.rate_by_tranche[E.NEW_DEBT_ID][xi], '%', 2)),
        h('td', { class: 'r' }, '—'), h('td', { class: 'l' }, 'funds the cash gap')));
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Debt stack'));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Debt stack' },
        h('table', { class: 'rpt-table mdl-table' },
          h('thead', null, h('tr', null, ['Tranche', 'Balance (US$m)', 'Terms', 'All-in rate (first year)', 'Maturity', 'Structure'].map((c, i) =>
            h('th', { scope: 'col', class: [0, 2, 5].includes(i) ? 'l' : 'r' }, c)))),
          h('tbody', null, rows))));
      if (spec.opening && Array.isArray(spec.opening.src)) p.appendChild(h('p', { class: 'mdl-src' }, `Balances at ${str(spec.opening.date)}`, rich.cite(spec.opening.src)));
    }

    // ---- Sensitivity ----
    function metricSel(value, onChange, label) {
      const s = h('select', { class: 'ctrl mdl-sel', 'aria-label': label });
      for (const m of METRICS) s.appendChild(h('option', { value: m.key, selected: m.key === value ? true : null }, m.row ? m.label.charAt(0).toUpperCase() + m.label.slice(1) : m.label));
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    function yearSel(value, onChange, label, disabled) {
      const s = h('select', { class: 'ctrl mdl-sel', 'aria-label': label, disabled: disabled ? true : null });
      for (const y of metricYears) s.appendChild(h('option', { value: String(y) }, ylong(y)));
      s.value = String(value);
      s.addEventListener('change', () => onChange(+s.value));
      return s;
    }
    function driverSel(value, onChange, label) {
      const s = h('select', { class: 'ctrl mdl-sel', 'aria-label': label });
      for (const d of D.filter(x => x.kind !== 'choice')) s.appendChild(h('option', { value: d.id, selected: d.id === value ? true : null }, `${d.label} (${d.unit})`));
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    // a select that rebuilt its panel gets keyboard focus back (it was removed from the page)
    function rerender(k, label) {
      renderPanel(k);
      const p = panels.get(k), s = p && p.querySelector ? p.querySelector(`select[aria-label="${label}"]`) : null;
      if (s) { try { s.focus({ preventScroll: true }); } catch { s.focus(); } }
    }
    function renderSens(p) {
      const m = mdef(st.sens.key, st.sens.year);
      const t0 = E.sensitivity(spec, st.ov, { metric: m.metric, year: m.year, events: st.ev, probs: st.probs });
      p.appendChild(h('div', { class: 'mdl-row' }, h('h4', { class: 'mdl-h4' }, 'Tornado: what moves the answer most'),
        h('span', { class: 'mdl-gridctl' },
          h('label', { class: 'mdl-sel-l' }, 'Metric ', metricSel(m.key, k => { st.sens.key = k; rerender('sens', 'Tornado metric'); }, 'Tornado metric')),
          h('label', { class: 'mdl-sel-l' }, 'Year ', yearSel(m.year || st.sens.year, y => { st.sens.year = y; rerender('sens', 'Tornado year'); }, 'Tornado year', !m.row)))));
      p.appendChild(h('p', { class: 'mdl-note' }, `Each bar re-runs the model with one driver at the low or high end of its stress range, everything else as set now. `
        + (EVS.length ? 'A business event is one bar: the metric with that event switched on (or off, if it is on now; dashed outline), its group’s other events off. ' : '')
        + `Sorted by swing. Rates and credit reach value through the cost-of-capital re-rating of the exit multiple, and the P&L through interest.`));
      if (t0.error) p.appendChild(h('p', { class: 'mdl-note' }, 'The tornado couldn’t be computed for these settings.'));
      else {
        p.appendChild(chartBox(tornado({ id: `${uid}-tor`, sens: t0, drivers: D, unit: m.unit, dp: m.dp, title: `Tornado: ${m.label} (${m.unit})`, max: EVS.length ? 16 : 12, probOf }),
          legend(torLegend())));
        const flat = t0.bars.filter(b => !(b.swing > 1e-9)).map(b => b.label);
        if (flat.length) p.appendChild(h('p', { class: 'mdl-note' }, `No effect on this metric: ${flat.join(', ')}.`));
      }

      // 2-way grid
      const gm = mdef(st.grid.key, st.grid.year);
      const gx = byId.get(st.grid.x) ? st.grid.x : D[0].id, gy = byId.get(st.grid.y) ? st.grid.y : D[1].id;
      const xs = axisValues(byId.get(gx), cur(gx), 7), ys = axisValues(byId.get(gy), cur(gy), 7);
      const g = E.grid(spec, st.ov, gx, xs, gy, ys, gm.year ? `${gm.metric}@${gm.year}` : gm.metric, { events: st.ev });
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Two-way sensitivity'));
      p.appendChild(h('div', { class: 'mdl-gridctl' },
        h('label', { class: 'mdl-sel-l' }, 'Metric ', metricSel(gm.key, k => {
          const dft = gridDefault(k);
          st.grid = { key: k, year: st.grid.year, x: dft[0], y: dft[1] }; rerender('sens', 'Grid metric');
        }, 'Grid metric')),
        h('label', { class: 'mdl-sel-l' }, 'Year ', yearSel(gm.year || st.grid.year, y => { st.grid.year = y; rerender('sens', 'Grid year'); }, 'Grid year', !gm.row)),
        h('label', { class: 'mdl-sel-l' }, 'Across ', driverSel(gx, id => { st.grid.x = id; rerender('sens', 'Grid columns driver'); }, 'Grid columns driver')),
        h('label', { class: 'mdl-sel-l' }, 'Down ', driverSel(gy, id => { st.grid.y = id; rerender('sens', 'Grid rows driver'); }, 'Grid rows driver'))));
      if (g.error) { p.appendChild(h('p', { class: 'mdl-note' }, 'The grid couldn’t be computed for these drivers.')); return; }
      const now = E.metricValue(st.res, gm.metric, gm.year);
      const all = g.z.flat().filter(isNum);
      const maxDev = Math.max(1e-9, ...all.map(z => Math.abs(z - (isNum(now) ? now : 0))));
      const dx = byId.get(gx), dy = byId.get(gy);
      const near = (vals, c) => vals.reduce((bi, v, i) => (Math.abs(v - c) < Math.abs(vals[bi] - c) ? i : bi), 0);
      const cx = near(g.x.values, cur(gx)), cy = near(g.y.values, cur(gy));
      const head = h('tr', null, h('th', { scope: 'col', class: 'l mdl-corner' }, `${dy.label} ↓ / ${dx.label} →`),
        g.x.values.map(xv => h('th', { scope: 'col', class: 'r' }, fmt(xv, dx.unit, dx.dp))));
      const body = g.y.values.map((yv, yi) => h('tr', null, h('th', { scope: 'row', class: 'r' }, fmt(yv, dy.unit, dy.dp)),
        g.z[yi].map((z, xi) => {
          const td = h('td', { class: `r mdl-heat${xi === cx && yi === cy ? ' now' : ''}`, title: `${dx.label} ${fmt(g.x.values[xi], dx.unit, dx.dp)}, ${dy.label} ${fmt(yv, dy.unit, dy.dp)}: ${fmt(z, gm.unit, gm.dp)}` },
            gm.unit === 'US$m' ? fmt(z, '', 0) : fmt(z, gm.unit === 'US$' ? '' : gm.unit, gm.dp));
          if (isNum(z) && isNum(now) && gm.good) {
            const t = (z - now) / maxDev * gm.good, a = Math.min(0.55, Math.abs(t) * 0.55);
            if (a > 0.02) td.style.setProperty('background', t > 0 ? `rgba(52,211,153,${a.toFixed(3)})` : `rgba(248,113,113,${a.toFixed(3)})`);
          }
          return td;
        })));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Two-way sensitivity grid' },
        h('table', { class: 'rpt-table mdl-table mdl-grid2' }, h('caption', { class: 'mdl-cap' }, `${gm.label} (${gm.unit})`), h('thead', null, head), h('tbody', null, body))));
      p.appendChild(h('p', { class: 'mdl-note' }, `Outlined cell = the current setting (${fmt(now, gm.unit, gm.dp)}). ${gm.good ? 'Green is better for shareholders than now, red worse; deeper = further away.' : 'Uncoloured: more or less of this is neither good nor bad in itself.'}`));
    }

    // ---- Breakevens: what the price implies; where the limits break ----
    const PRICED = ['exit_ev_ebitda', 'revenue_growth', 'revenue_per_mw_shift', 'delivery_delay_months', 'utilization', 'renewal_price_reset', 'cost_of_revenue_pct', 'cor_per_mw',
      'new_debt_rate', 'sofr_shift', 'capex', 'capex_per_mw', 'discount_rate'].filter(id => byId.has(id));
    const BREAK = ['revenue_growth', 'delivery_delay_months', 'revenue_per_mw_shift', 'cost_of_revenue_pct', 'cor_per_mw', 'capex', 'capex_per_mw', 'new_debt_rate', 'sofr_shift'].filter(id => byId.has(id));
    const beYears = [KY, XY].filter((y, i, a) => years.includes(y) && a.indexOf(y) === i);
    // runs the solves a few at a time (~25 ms slices) so the page stays responsive
    function queueSolves(jobs) {
      const seq = ++st.beSeq;
      const next = () => {
        if (!st.alive || seq !== st.beSeq) return;
        const t0 = Date.now();
        while (jobs.length && Date.now() - t0 < 25) jobs.shift()();
        if (jobs.length) setTimeout(next, 0);
      };
      next();
    }
    function renderBE(p) {
      const price = cur('share_price'), jobs = [];
      const fmtD = (d, x) => fmt(x, d.unit, Math.max(1, d.dp || 0));
      p.appendChild(h('h4', { class: 'mdl-h4' }, `Priced in at ${fmt(price, 'US$', 2)}`));
      p.appendChild(h('p', { class: 'mdl-note' }, `The level of each driver, moved alone with everything else as set now, at which the model’s value per share equals the share price: `
        + 'what you would have to believe for today’s price to be fair. A driver whose whole range never brings value down (or up) to the price shows “none in range”.'));
      const tb = h('tbody');
      for (const id of PRICED) {
        const d = byId.get(id), cell = h('td', { class: 'r', 'data-mdl-be': id }, '…'), move = h('td', { class: 'l' }, '');
        tb.appendChild(h('tr', null, h('th', { scope: 'row', class: 'l' }, d.label), h('td', { class: 'r' }, fmtD(d, cur(id))), cell, move));
        jobs.push(() => {
          const r = E.solve(spec, st.ov, id, 'value_per_share', price, { steps: 12, tol: d.step / 10, events: st.ev });
          cell.textContent = r.error ? '—' : r.found ? fmtD(d, r.value) : 'none in range';
          if (r.found) move.textContent = `${fmt(r.value - cur(id), deltaUnit(d.unit), Math.max(1, d.dp || 0), true)} from now`;
        });
      }
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'What the share price implies' },
        h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, ['Driver', 'You assume', 'Price implies', 'Move'].map((c, i) => h('th', { scope: 'col', class: i % 3 === 0 ? 'l' : 'r' }, c)))), tb)));

      const covs = (st.res && Array.isArray(st.res.covenants) ? st.res.covenants : []).filter(c => /debt_ebitda$|interest_cover$/.test(c.metric));
      if (covs.length && BREAK.length) {
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Breaking points'));
        p.appendChild(h('p', { class: 'mdl-note' }, 'The level of each driver, moved alone, at which a covenant or threshold is crossed in the year shown. '
          + '“crossed now” = already beyond the limit at the current settings; “none in range” = this driver alone cannot get it there.'));
        const short = { revenue_growth: 'Revenue growth', cost_of_revenue_pct: 'Cost of revenue', capex: 'Capex', new_debt_rate: 'New-debt cost', sofr_shift: 'SOFR shift',
          delivery_delay_months: 'Delivery delay', revenue_per_mw_shift: 'Price per MW', cor_per_mw: 'Cost per MW', capex_per_mw: 'Capex per MW' };
        const head = h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Limit, year'), BREAK.map(id => h('th', { scope: 'col', class: 'r', title: byId.get(id).label }, short[id] || byId.get(id).label)));
        const body = h('tbody');
        for (const c of covs) for (const y of beYears) {
          const i = years.indexOf(y), limit = isNum(c.max) ? c.max : c.min, nowV = c.values[i];
          const crossed = c.breach[i] === true;
          body.appendChild(h('tr', null, h('th', { scope: 'row', class: 'l' }, `${str(c.label).replace(/\s*\(.*\)$/, '')}: ${fmt(limit, 'x', 1)}, ${ylong(y)}`,
            h('span', { class: 'mdl-th-note' }, `now ${fmt(nowV, 'x', 2)}${crossed ? ' · crossed now' : ''}`)),
          BREAK.map(id => {
            const d = byId.get(id), td = h('td', { class: 'r' }, crossed ? 'crossed now' : '…');
            if (!crossed) jobs.push(() => {
              const r = E.solve(spec, st.ov, id, `${c.metric}@${y}`, limit, { steps: 12, tol: d.step / 10, events: st.ev });
              td.textContent = r.error ? '—' : r.found ? fmtD(d, r.value) : 'none in range';
            });
            return td;
          })));
        }
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Breaking points' },
          h('table', { class: 'rpt-table mdl-table' }, h('thead', null, head), body)));
      }
      queueSolves(jobs);
    }

    // ---- Valuation & multiples ----
    let VP = null;
    function fillPresets(box) {
      const d = distNow(), sh = d || distShown();
      clear(box);
      if (sh && !sh.error && sh.presets && sh.presets.length) {
        const V = sh.metrics.value_per_share;
        box.appendChild(presetList(sh.presets, 'Representative presets'));
        if (V) box.appendChild(h('p', { class: `mdl-note${d ? '' : ' mdl-stale'}` }, `Distribution mean ${fmt(V.mean, 'US$', 2)}; P10 / P50 / P90 ${fmt(V.p10, 'US$', 0)} / ${fmt(V.p50, 'US$', 0)} / ${fmt(V.p90, 'US$', 0)}${d ? '' : ' (updating for these settings)'}.`));
      } else box.appendChild(h('p', { class: 'mdl-note', 'data-mdl-dist-wait': '' }, `Computing the outcome distribution: ${Math.round(st.distProg * 100)}% of the draws…`));
      if (!d) startDist();
    }
    function renderVal(p, res) {
      VP = null;
      const V = res.valuation, W = st.w && !st.w.error ? st.w : null;
      if (W && W.rows.length) {
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Scenario values and weights'));
        p.appendChild(h('ol', { class: 'mdl-bridge', 'aria-label': 'Probability-weighted value' },
          byValue(W.rows).map(r => h('li', { class: 'mdl-step' }, h('span', { class: 'mdl-step-l' }, `${str(r.name)} · ${fmt(r.prob, '', 0)}%`), h('span', { class: 'mdl-step-v' }, fmt(r.value, 'US$', 2)),
            Array.isArray(r.events) && r.events.length ? h('span', { class: 'mdl-step-n' }, `with ${r.events.map(id => str((evById.get(id) || {}).label || id)).join(' · ')}`) : null)),
          h('li', { class: 'mdl-step' }, h('span', { class: 'mdl-step-l' }, 'Probability-weighted'), h('span', { class: 'mdl-step-v' }, fmt(W.value, 'US$', 2)),
            h('span', { class: 'mdl-step-n' }, `vs ${fmt(V.share_price, 'US$', 2)}: ${fmt(isNum(W.value) && V.share_price ? (W.value / V.share_price - 1) * 100 : null, '%', 0, true)}`))));
        p.appendChild(h('p', { class: 'mdl-note' }, `Each preset at its weight, with your edits${st.anchor && st.anchor !== 'base' ? ` (relative to ${str((scen.find(s => s.id === st.anchor) || {}).name)})` : ''} laid on top of every one of them.`));
      } else if (EVS.length && scen.some(s => s.representative)) {
        // no preset weights: the presets are points of the outcome distribution
        const box = h('div', { 'data-mdl-presets': '' });
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'The presets in the outcome distribution'));
        p.appendChild(h('p', { class: 'mdl-note' }, 'The presets carry no weights of their own: each is one outcome, placed in the distribution of the ',
          tabLink('risk', 'Risks & upsides'), ' tab (regimes, events and the uncertain drivers at the sliders’ settings).'));
        p.appendChild(box);
        VP = { presets: box };
        fillPresets(box);
      }
      const AP = V.implied_fwd_multiples_at_price, AV = V.implied_multiples_at_value;
      const mt = [['ev_sales', 'EV / sales', 'x', 1], ['ev_ebitda', 'EV / adj. EBITDA', 'x', 1], ['ev_ebit', 'EV / EBIT', 'x', 1], ['pe', 'P/E', 'x', 1], ['fcf_yield', 'FCF yield', '%', 1]];
      const row = (label, note, vals, unit, dp, cls) => h('tr', { class: cls || null }, h('th', { scope: 'row', class: 'l' }, label, note ? h('span', { class: 'mdl-th-note' }, note) : null),
        years.map((_, i) => h('td', { class: 'r' }, unit === 'US$m' ? money(vals[i]) : fmt(vals[i], unit, dp))));
      const rows = [row('Enterprise value', `at ${fmt(V.share_price, 'US$', 2)}: price × shares + net debt at the start of the year`, AP.ev, 'US$m', 0)];
      for (const [k, label, unit, dp] of mt) rows.push(row(label, `at ${fmt(V.share_price, 'US$', 2)} price`, AP[k], unit, dp));
      rows.push(row('EV / adj. EBITDA', `at the ${fmt(V.exit_value_per_share, 'US$', 2)} value at ${str(V.valuation_date)}`, AV.ev_ebitda, 'x', 1, 'mdl-sub-row'));
      rows.push(row('P/E', `at the ${fmt(V.exit_value_per_share, 'US$', 2)} value at ${str(V.valuation_date)}`, AV.pe, 'x', 1, 'mdl-sub-row'));
      rows.push(row('Today’s EV / future EBITDA', 'ignores the debt needed to reach that EBITDA', res.rows.ev_ebitda_static, 'x', 1, 'mdl-sub-row'));
      if (cons && cons.rows.ev_ebitda) rows.push(row('Consensus EV / EBITDA', str(cons.label).split(',')[0] + ', each year’s own year-end net debt', years.map(y => consAt('ev_ebitda', y)), 'x', 2, 'mdl-sub-row'));
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Forward multiples (funded EV)'));
      p.appendChild(h('p', { class: 'mdl-note' }, `A year’s EV counts the shares and net debt at the start of that year, so the borrowing that builds the year’s EBITDA is in the price paid for it (today’s EV at the price: market cap ${money(V.market_cap)} + net debt ${money(V.net_debt_now)} = ${money(V.ev_now)}). `
        + `“At value” uses the model’s value per share at the exit date, so ${ylong(V.exit_year)} reproduces the effective exit multiple. n/m (—) where the denominator is zero or negative.`));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Forward multiples' },
        h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Multiple'), years.map(y => h('th', { scope: 'col', class: 'r' }, ylong(y))))),
          h('tbody', null, rows))));
      const sp = byId.get('share_price');
      if (sp && Array.isArray(sp.src) && sp.src.length) p.appendChild(h('p', { class: 'mdl-src' }, 'Share price', rich.cite(sp.src), cons ? [' · consensus: ', str(cons.label), rich.cite(cons.src || [])] : null));

      const step = (label, value, note) => h('li', { class: 'mdl-step' }, h('span', { class: 'mdl-step-l' }, label), h('span', { class: 'mdl-step-v' }, value), note ? h('span', { class: 'mdl-step-n' }, note) : null);
      const bsY = V.balance_sheet_year, rerated = isNum(V.rate_adjustment) && Math.abs(V.rate_adjustment - 1) > 1e-9;
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Exit valuation bridge'));
      const RR = V.ebitda_basis === 'run_rate', RO = V.runoff, lifeOn = isNum(V.life_adjustment) && Math.abs(V.life_adjustment - 1) > 1e-9;
      p.appendChild(h('ol', { class: 'mdl-bridge', 'aria-label': 'Exit valuation bridge' },
        RR ? step(`${ylong(V.exit_year)} adj. EBITDA, run-rate of the fleet in place at end ${bsY}`, money(V.exit_ebitda),
          `${fmt(V.fleet_mw, '', 0)} MW active at ${ylong(V.exit_year)} economics: the fleet the net debt below paid for (the ${ylong(V.exit_year)} forward figure, ${money(V.exit_ebitda_forward)}, adds the MW built during ${V.exit_year})`)
          : step(`${ylong(V.exit_year)} adj. EBITDA`, money(V.exit_ebitda)),
        step('× exit EV/EBITDA (at base financing costs)', fmt(V.exit_multiple, 'x', 1)),
        isNum(V.wacc) ? step('× cost-of-capital re-rating', fmt(V.rate_adjustment, '', 3),
          `WACC ${fmt(V.wacc_base, '%', 1)} → ${fmt(V.wacc, '%', 1)} (new debt ${fmt(V.new_debt_rate_exit, '%', 1)}); effective ${fmt(V.exit_multiple_eff, 'x', 2)}${rerated ? '' : ' (unchanged)'}`) : null,
        RO && (lifeOn || spec.valuation && spec.valuation.life_link) ? step('× economic-life adjustment', fmt(V.life_adjustment, '', 3),
          `run-off value of the fleet ${fmt(RO.ev_ebitda, 'x', 2)} its EBITDA (contracts to term, renewals at ${fmt(RO.renewal_price_change, '%', 0, true)} with ${fmt(RO.renewal_churn, '%', 0)} not re-signing, to a ${fmt(RO.economic_life, '', 1)}-year economic life), against the same at the base inputs${lifeOn ? '' : ' (unchanged)'}`) : null,
        step('= enterprise value', money(V.exit_ev)),
        step(`− net debt${bsY ? ` (end ${bsY})` : ''}`, money(V.exit_net_debt)),
        step('= equity value', money(V.exit_equity), isNum(V.exit_equity) && V.exit_equity <= 0 ? 'debt exceeds EV: value floored at 0' : null),
        step(`÷ shares${bsY ? ` (end ${bsY})` : ''}`, fmt(V.exit_shares + (V.conv_shares || 0), 'm', 0), V.conv_shares > 0.05 ? `incl. ${fmt(V.conv_shares, 'm', 1)} net convertible shares above the caps` : null),
        step(`= value at ${str(V.valuation_date)}`, fmt(V.exit_value_per_share, 'US$', 2)),
        step(`× discount (${fmt(cur('discount_rate'), '%', 1)} for ${fmt(V.years_to_valuation, '', 1)} yrs)`, fmt(V.discount_factor, '', 3)),
        step('= value per share today', fmt(V.value_per_share, 'US$', 2), `vs ${fmt(V.share_price, 'US$', 2)}: ${fmt(V.upside_pct, '%', 0, true)}`)));
      // the same value on other bases: what the answer depends on
      const XC = [
        [RR ? `${ylong(V.exit_year)} forward EBITDA basis` : 'Run-rate fleet basis', V.value_forward_basis,
          RR ? `the same multiple on ${ylong(V.exit_year)} EBITDA (${money(V.exit_ebitda_forward)}), incl. the MW added during ${V.exit_year} whose debt is not yet in the end-${bsY} net debt` : 'the same multiple on the fleet in place at the balance-sheet date'],
        V.last_year_exit ? [`Exit at end-${V.last_year_exit.year}`, V.value_last_year_exit,
          `${fmt(V.last_year_exit.multiple_eff, 'x', 1)} (re-rated at that year’s financing cost) × ${money(V.last_year_exit.ebitda)} less ${money(V.last_year_exit.net_debt)} net debt, discounted from then: sees the interest and the fixed / floating mix to ${V.last_year_exit.year}`] : null,
        RO ? ['Run-off value of the fleet', V.value_runoff, `no growth and no terminal value: the ${fmt(V.fleet_mw, '', 0)} MW earn to contract end and renew until a ${fmt(RO.economic_life, '', 1)}-year economic life, then stop`] : null,
      ].filter(x => x && isNum(x[1]));
      if (XC.length) {
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Cross-checks: the same company on other bases'));
        p.appendChild(h('ol', { class: 'mdl-bridge', 'aria-label': 'Valuation cross-checks', 'data-mdl-xcheck': '' },
          XC.map(([l, v, n]) => step(l, fmt(v, 'US$', 2), `${n} · ${fmt(V.share_price ? (v / V.share_price - 1) * 100 : null, '%', 0, true)} vs the price`))));
      }
      if (spec.valuation && spec.valuation.note) p.appendChild(h('p', { class: 'mdl-src' }, rich.inline(spec.valuation.note)));
    }

    // ---- Calibration ----
    function passPill(pass) {
      return h('span', { class: `mdl-pass ${pass === true ? 'ok' : pass === false ? 'miss' : 'na'}` }, pass === true ? '✓ within' : pass === false ? '✗ outside' : 'n/a');
    }
    function renderCal(p, res) {
      const unitOf = mk => (RM[mk] ? RM[mk].unit : mk === 'value_per_share' ? 'US$' : '');
      const dpOf = u => (u === '%' || u === 'x' ? 1 : u === 'US$' ? 2 : 0);
      const rng = (c, u) => (c.lo !== null && c.hi !== null ? `${fmt(c.lo, u, dpOf(u))} – ${fmt(c.hi, u, dpOf(u))}` : c.lo !== null ? `≥ ${fmt(c.lo, u, dpOf(u))}` : c.hi !== null ? `≤ ${fmt(c.hi, u, dpOf(u))}` : '—');
      const rows = res.checks.map(c => {
        const u = unitOf(c.metric);
        return h('tr', null, h('th', { scope: 'row', class: 'l' }, str(c.label), c.src && c.src.length ? rich.cite(c.src) : null),
          h('td', { class: 'r' }, fmt(c.value, u, dpOf(u))), h('td', { class: 'r' }, rng(c, u)), h('td', { class: 'l' }, passPill(c.pass)));
      });
      for (const g of guides) {
        const mv = guideValue(res, spec, g), u = unitOf(g.metric);
        const c = { lo: isNum(g.lo) ? g.lo : null, hi: isNum(g.hi) ? g.hi : null };
        const pass = isNum(mv) ? (c.lo === null || mv >= c.lo) && (c.hi === null || mv <= c.hi) : null;
        rows.push(h('tr', null, h('th', { scope: 'row', class: 'l' }, `${str(g.label)} (${str(g.period)})`, Array.isArray(g.src) ? rich.cite(g.src) : null),
          h('td', { class: 'r' }, fmt(mv, u, 0)), h('td', { class: 'r' }, rng(c, u)), h('td', { class: 'l' }, passPill(pass))));
      }
      const nOk = rows.length ? res.checks.filter(c => c.pass === true).length : 0;
      p.appendChild(h('p', { class: 'mdl-note' }, `How the model, under the current drivers, compares with the company’s guidance, consensus and other cited targets `
        + `(${nOk} of ${res.checks.length} checks within range). A miss is a prompt to revisit a driver, or a deliberate difference of view, not proof the model is wrong.`));
      if (rows.length) {
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Calibration checks' },
          h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, ['Check', 'Model', 'Target', 'Result'].map((c, i) => h('th', { scope: 'col', class: i % 3 === 0 ? 'l' : 'r' }, c)))),
            h('tbody', null, rows))));
      } else p.appendChild(h('p', { class: 'mdl-note' }, 'This model has no calibration targets.'));
      if (res.warnings && res.warnings.length) {
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Model notes'));
        p.appendChild(h('ul', { class: 'rpt-bul mdl-warn' }, res.warnings.slice(0, 12).map(w => h('li', null, str(w)))));
      }
    }

    // ---- links between the views (a tab, an event card, a driver's slider) ----
    function tabLink(k, label) {
      const b = h('button', { type: 'button', class: 'mdl-link', 'data-mdl-goto': k }, label);
      b.addEventListener('click', () => { if (!tabBtns.has(k)) return; selectTab(k); tabBtns.get(k).focus(); });
      return b;
    }
    function evLink(id) {
      const e = evById.get(id);
      if (!e) return null;
      const b = h('button', { type: 'button', class: 'mdl-link', 'data-mdl-goto-ev': id }, `“${str(e.label)}”`);
      b.addEventListener('click', () => gotoEvent(id));
      return b;
    }
    function gotoEvent(id) {
      if (!tabBtns.has('risk')) return;
      selectTab('risk');
      const c = RK && RK.cards.get(id);
      if (!c) return;
      if (c.el.scrollIntoView) c.el.scrollIntoView({ block: 'center' });
      try { c.sw.focus({ preventScroll: true }); } catch { c.sw.focus(); }
    }
    function driverLink(id) {
      const d = byId.get(id);
      if (!d) return null;
      const b = h('button', { type: 'button', class: 'mdl-link', 'data-mdl-goto-drv': id }, str(d.label));
      b.addEventListener('click', () => {
        const r = st.refs.get(id), ctl = r && (r.range || r.sel);
        if (!ctl) return;
        for (const box of drvPanel.querySelectorAll ? drvPanel.querySelectorAll('details.mdl-group') : []) if (box.contains(ctl)) box.open = true;
        if (ctl.scrollIntoView) ctl.scrollIntoView({ block: 'center' });
        try { ctl.focus({ preventScroll: true }); } catch { ctl.focus(); }
      });
      return b;
    }
    const torLegend = () => [['Driver at its low end', C_LOW], ['Driver at its high end', C_HIGH]].concat(EVS.length ? [['Risk switched on', C_RISK], ['Upside switched on', C_UP]] : []);

    // ---- Risks & upsides ----
    // Built once per mount, so a switch or a probability input keeps its focus while the numbers
    // refresh: each card's impact (eventImpact at the current drivers and switches), then the
    // outcome distribution (cached per drivers + probabilities + year; computed off the slider path).
    let RK = null;
    const MODES = [['base', 'Base (no events)', 'No business events in the projection: the drivers alone. Switch an event on to see it in every tab.'],
      ['weighted', 'Probability-weighted', 'The projection runs without events; every event counts at its probability in the outcome distribution below, whose mean is the probability-weighted value.'],
      ['custom', 'Custom (switches)', 'The events switched on act on the drivers from their start month, in every tab: P&L, interest and debt, valuation.']];
    // The outcome distribution (regimes x events x drawn drivers) for the drivers and
    // probabilities as set: one result per key, computed in ~20 ms slices off the slider path, read
    // by the headline tile, this tab, the valuation tab and the print snapshot.
    const distKey = () => JSON.stringify([st.ov, st.probs]);
    const distNow = () => (st.dist.key === distKey() && st.dist.val ? st.dist.val : null);
    // the last finished result, shown greyed while the current one computes
    const distShown = () => distNow() || st.dist.last || null;
    function startDist() {
      if (!EVS.length || !st.alive) return;
      const key = distKey();
      if (st.dist.key === key && (st.dist.val || st.dist.job)) {
        if (st.dist.job && !st.distTick) st.distTick = setTimeout(stepDist, 0);
        return;
      }
      st.dist = { key, val: null, job: E.distributionJob(spec, st.ov, { probs: st.probs, bins: 30 }), last: st.dist.val || st.dist.last || null };
      st.distProg = 0;
      clearTimeout(st.distTick);
      st.distTick = setTimeout(stepDist, 0);
    }
    function stepDist() {
      st.distTick = 0;
      const cur0 = st.dist;
      if (!st.alive || !cur0.job || cur0.key !== distKey()) return;
      const done = cur0.job.step(20);
      st.distProg = cur0.job.progress();
      if (done) { cur0.val = cur0.job.result(); cur0.job = null; onDist(); return; }
      paintDistWait();
      st.distTick = setTimeout(stepDist, 0);
    }
    // synchronous (print): finishes the job for the current key, or runs one
    function finishDist() {
      if (!EVS.length) return null;
      if (!distNow()) {
        startDist();
        clearTimeout(st.distTick); st.distTick = 0;
        const cur0 = st.dist;
        if (cur0.job) { cur0.job.step(Infinity); cur0.val = cur0.job.result(); cur0.job = null; }
      }
      return distNow();
    }
    // progress on the headline tile and this tab's placeholder, without a re-render
    function paintDistWait() {
      const t = `computing the distribution… ${Math.round(st.distProg * 100)}%`;
      const q = sel => (root.querySelector ? root.querySelector(sel) : null);
      const k = q('[data-mdl-kpi="weighted"] .mdl-kpi-s');
      if (k && !distNow()) k.textContent = t;
      const w = q('[data-mdl-dist-wait]');
      if (w) w.textContent = `Computing the outcome distribution: ${Math.round(st.distProg * 100)}% of the draws…`;
    }
    function onDist() {
      if (!st.alive || !st.res || st.res.error) return;
      renderKpis();
      if (st.tab === 'risk' && RK) { drawDist(distNow()); syncRisk(); }
      if (VP && VP.presets) fillPresets(VP.presets);
    }
    function eventCard(e) {
      const pid = `${uid}-ev-${e.id}`, base = Math.round(e.prob * 1000) / 10;
      const swT = h('span', { class: 'mdl-switch-t' }, 'Off');
      const sw = h('button', { type: 'button', class: 'mdl-switch', role: 'switch', 'aria-checked': 'false', 'aria-label': str(e.label), 'data-mdl-ev': e.id },
        h('span', { class: 'mdl-switch-k', 'aria-hidden': 'true' }), swT);
      sw.addEventListener('click', () => {
        if (st.evMode === 'weighted') return;
        const on = !st.ev[e.id];
        setEvent(e.id, on);
        syncRisk();
        status(`“${str(e.label)}” switched ${on ? 'on' : 'off'}.`);
      });
      const pRange = h('input', { type: 'range', min: 0, max: 100, step: 0.5, value: base, class: 'mdl-range', id: pid, 'data-mdl-probr': e.id, 'aria-label': `Probability of “${str(e.label)}” (%)` });
      const pNum = h('input', { type: 'number', min: 0, max: 100, step: 0.5, value: base, class: 'mdl-num', inputmode: 'decimal', 'data-mdl-prob': e.id, 'aria-label': `Probability of “${str(e.label)}”, in %` });
      const pReset = h('button', { type: 'button', class: 'mdl-rs', 'aria-label': `Reset the probability of “${str(e.label)}”`, title: 'Back to our estimate', hidden: true }, '↺');
      pRange.addEventListener('input', () => { setProb(e.id, +pRange.value / 100); syncRisk(); });
      pNum.addEventListener('input', () => { const t = String(pNum.value).trim(); if (t !== '' && isFinite(+t)) { setProb(e.id, +t / 100); syncRisk(); } });
      pNum.addEventListener('change', () => { pNum.value = String(Math.round(probOf(e.id) * 1000) / 10); });
      pReset.addEventListener('click', () => { setProb(e.id, e.prob); syncRisk(); pRange.focus(); });
      const imp = h('dl', { class: 'mdl-evimp' }), expl = h('p', { class: 'mdl-dim mdl-evexp' });
      const grpMates = e.group ? EVS.filter(x => x.group === e.group && x.id !== e.id) : [];
      const inScen = evScen.get(e.id) || [];
      const what = impactLines(e, VOCAB, REV ? REV.customers : []);
      const kindCls = e.kind === 'upside' ? 'upside' : e.kind === 'strategic' ? 'strategic' : 'risk';
      const kindTxt = e.kind === 'upside' ? 'Upside' : e.kind === 'strategic' ? 'Strategic choice' : 'Risk';
      const whatL = what.length ? h('ul', { class: 'mdl-ev-what', 'aria-label': 'What the model changes' }, what.map(t => h('li', null, t))) : null;
      // on a phone the mechanism and the model's changes fold away under the impact
      const mech = h('p', { class: 'mdl-ev-mech' }, rich.inline(e.mechanism));
      const el = h('article', { class: `mdl-ev ${kindCls}`, 'data-mdl-evcard': e.id, 'aria-labelledby': `${pid}-t` },
        h('div', { class: 'mdl-ev-top' }, h('h5', { class: 'mdl-ev-t', id: `${pid}-t` }, str(e.label)), sw),
        h('p', { class: 'mdl-ev-meta' }, `${kindTxt}${e.from ? ` · from ${monthText(e.from)}` : ''}${e.until ? ` to ${monthText(e.until)}` : ''}`,
          grpMates.length ? ` · instead of ${grpMates.map(x => `“${str(x.label)}”`).join(', ')}` : '', inScen.length ? ` · in the ${inScen.join(', ')} scenario${inScen.length > 1 ? 's' : ''}` : ''),
        narrow ? null : mech,
        h('div', { class: 'mdl-ev-box' }, h('div', { class: 'mdl-ev-h' }, 'If it happens'), imp, expl, narrow ? null : whatL),
        narrow ? h('details', { class: 'mdl-ev-more' }, h('summary', null, 'How it works and what the model changes'), mech, whatL) : null,
        h('div', { class: 'mdl-ev-prob' },
          h('div', { class: 'mdl-drv-top' }, h('label', { for: pid, class: 'mdl-lab' }, 'Probability'), h('span', { class: 'mdl-in' }, pNum, h('span', { class: 'mdl-unit' }, '%')), pReset),
          h('div', { class: 'mdl-track mdl-ptrack' }, h('span', { class: 'mdl-base', 'aria-hidden': 'true', title: `Our estimate ${pctP(e.prob)}`, style: `left:${base}%` }), pRange),
          e.prob_note ? h('details', { class: 'mdl-ev-why' }, h('summary', null, `Why ${pctP(e.prob)}`), h('p', null, rich.inline(e.prob_note))) : null),
        e.indicators.length ? h('div', { class: 'mdl-ev-watch' }, h('div', { class: 'mdl-ev-h' }, 'What to watch'),
          h('ul', { class: 'rpt-bul' }, e.indicators.map(t => h('li', null, rich.inline(t))))) : null,
        e.src.length ? h('p', { class: 'mdl-src' }, 'Sources', rich.cite(e.src)) : null);
      return { el, sw, swT, pRange, pNum, pReset, imp, expl, dv: null };
    }
    // a strip of per-year changes: 'FY27E −US$120m · FY28E …', each in its own tone
    function yearStrip(d, good, from) {
      const ix = years.map((y, i) => i).filter(i => i >= from);
      if (!d || ix.every(i => !isNum(d[i]) || Math.abs(d[i]) < 0.5)) return h('dd', { class: 'mdl-cd flat' }, 'no change');
      return h('dd', { class: 'mdl-evyrs' }, ix.map((i, j) => {
        const t = tone(d[i], good, 0.5);
        return [j ? h('span', { class: 'mdl-dim', 'aria-hidden': 'true' }, ' · ') : null, h('span', { class: `mdl-cd ${t}` }, `${yl(years[i])} ${t === 'flat' ? '0' : money(d[i], true)}`)];
      }));
    }
    function buildRisk(p) {
      const cards = new Map(), modeBtns = new Map();
      const modeBar = h('div', { class: 'mdl-mode', role: 'radiogroup', 'aria-label': 'How the events are counted' });
      const pick = (m, label) => { setMode(m); syncRisk(); status(`${label}.`); };
      MODES.forEach(([m, label], j) => {
        const b = h('button', { type: 'button', class: 'mdl-modebtn', role: 'radio', 'aria-checked': 'false', 'data-mdl-mode': m }, label);
        b.addEventListener('click', () => pick(m, label));
        b.addEventListener('keydown', ev => {
          const k = ev.key, dj = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
          if (!dj) return;
          ev.preventDefault();
          const [m2, l2] = MODES[(j + dj + MODES.length) % MODES.length];
          pick(m2, l2);
          modeBtns.get(m2).focus();
        });
        modeBtns.set(m, b); modeBar.appendChild(b);
      });
      const modeNote = h('p', { class: 'mdl-note mdl-mode-note' });
      // the summary line is a live region read out when it changes; the switch-off tags sit outside it
      const summary = h('div', { class: 'mdl-readout mdl-evsum', 'data-mdl-readout': 'events' }, h('span', { 'data-mdl-evsum': '', role: 'status' }), h('span', { class: 'mdl-evtags' }));
      const colR = h('section', { class: 'mdl-evcol', 'aria-label': 'Risks' }, h('h4', { class: 'mdl-h4' }, `Risks (${EVS.filter(e => e.kind !== 'upside' && e.kind !== 'strategic').length})`));
      const nStrat = EVS.filter(e => e.kind === 'strategic').length, upLabel = nStrat ? 'Upsides and strategic choices' : 'Upsides';
      const colU = h('section', { class: 'mdl-evcol', 'aria-label': upLabel }, h('h4', { class: 'mdl-h4' }, `${upLabel} (${EVS.filter(e => e.kind === 'upside' || e.kind === 'strategic').length})`));
      for (const e of EVS) { const c = eventCard(e); cards.set(e.id, c); (e.kind === 'upside' || e.kind === 'strategic' ? colU : colR).appendChild(c.el); }
      const dist = h('div', { class: 'mdl-dist', 'data-mdl-dist': '' });
      p.appendChild(h('p', { class: 'mdl-note' }, 'Business events that would move revenue, costs or funding, each built from how the business works: its mechanism, '
        + 'what the model changes when it happens, a probability (our estimate, editable) and the indicators to watch. Events in one group exclude each other.'));
      p.appendChild(modeBar);
      p.appendChild(modeNote);
      p.appendChild(summary);
      const distH = h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'dist', tabindex: '-1' }, 'Outcome distribution');
      const jump = h('button', { type: 'button', class: 'mdl-link', 'data-mdl-jump': 'dist' }, `Jump to the outcome distribution, below the ${EVS.length} cards`);
      jump.addEventListener('click', () => { if (distH.scrollIntoView) distH.scrollIntoView({ block: 'start' }); try { distH.focus({ preventScroll: true }); } catch { distH.focus(); } });
      p.appendChild(h('p', { class: 'mdl-note mdl-jump' }, jump));
      p.appendChild(h('div', { class: 'mdl-evcols' }, colR, colU));
      p.appendChild(distH);
      p.appendChild(dist);
      RK = { cards, modeBtns, modeNote, summary, sumText: summary.firstChild, tags: summary.lastChild, sumKey: null, dist };
    }
    // the cheap parts: switch states, probabilities, the mode bar, the summary line
    function syncRisk() {
      if (!RK) return;
      for (const [m, b] of RK.modeBtns) { b.setAttribute('aria-checked', m === st.evMode ? 'true' : 'false'); b.tabIndex = m === st.evMode ? 0 : -1; }
      RK.modeNote.textContent = (MODES.find(x => x[0] === st.evMode) || MODES[0])[2];
      const weightedMode = st.evMode === 'weighted';
      for (const [id, c] of RK.cards) {
        const on = !!st.ev[id], pr = probOf(id), pv = Math.round(pr * 1000) / 10;
        c.sw.setAttribute('aria-checked', on ? 'true' : 'false');
        c.sw.disabled = weightedMode;
        c.sw.title = weightedMode ? `Counted at ${pctP(pr)} in the distribution` : on ? 'Switch off' : 'Switch on';
        c.swT.textContent = on ? 'On' : weightedMode ? pctP(pr) : 'Off';
        c.el.classList.toggle('on', on);
        if (String(c.pRange.value) !== String(pv)) c.pRange.value = String(pv);
        c.pRange.setAttribute('aria-valuetext', pctP(pr));
        if (doc().activeElement !== c.pNum && String(c.pNum.value) !== String(pv)) c.pNum.value = String(pv);
        c.pReset.hidden = !Object.prototype.hasOwnProperty.call(st.probs, id);
        c.expl.textContent = isNum(c.dv) && Math.abs(c.dv) >= 0.005 ? `Weighted by its ${pctP(pr)} probability: ${fmt(pr * c.dv, 'US$', 2, true)} per share.` : '';
      }
      const on = evOn().map(id => evById.get(id));
      const v = st.res && !st.res.error ? st.res.valuation.value_per_share : null;
      const dd = weightedMode ? distNow() : null, m = dd && !dd.error ? dd.metrics.value_per_share : null;
      // rebuilt (and so announced) only when what it says changes
      const sk = JSON.stringify([st.evMode, on.map(e => e.id), fmt(v, 'US$', 2), fmt(RK.v0, 'US$', 2), m ? fmt(m.mean, 'US$', 2) : null]);
      if (sk === RK.sumKey) return;
      RK.sumKey = sk;
      clear(RK.sumText); clear(RK.tags);
      if (weightedMode) {
        RK.sumText.appendChild(h('span', null, h('strong', null, `Distribution mean: ${m ? fmt(m.mean, 'US$', 2) : '…'}`),
          ` (every event at its probability, in the distribution below) against ${fmt(v, 'US$', 2)} with no events and the ${fmt(cur('share_price'), 'US$', 2)} share price.`));
      } else if (on.length) {
        RK.sumText.appendChild(h('span', null, h('strong', null, `${on.length} event${on.length > 1 ? 's' : ''} on: value per share ${fmt(v, 'US$', 2)}`),
          ` (no events: ${fmt(RK.v0, 'US$', 2)}). `));
        for (const e of on) {
          const b = h('button', { type: 'button', class: 'mdl-evtag', 'aria-label': `Switch off “${str(e.label)}”`, 'data-mdl-evoff': e.id }, str(e.label), h('span', { 'aria-hidden': 'true' }, ' ×'));
          b.addEventListener('click', () => {
            setEvent(e.id, false); syncRisk(); status(`“${str(e.label)}” switched off.`);
            // the tag is gone: focus moves to that event's switch
            const c = RK.cards.get(e.id);
            if (c) { if (c.el.scrollIntoView) c.el.scrollIntoView({ block: 'center' }); try { c.sw.focus({ preventScroll: true }); } catch { c.sw.focus(); } }
          });
          RK.tags.appendChild(b);
        }
      } else RK.sumText.appendChild(h('span', null, h('strong', null, 'No events switched on'), ` — value per share ${fmt(v, 'US$', 2)} on the drivers alone.`));
    }
    // the slow parts: every card's impact, then the distribution
    function refreshRisk() {
      const last = years[years.length - 1];
      const key = JSON.stringify([st.ov, evOn()]);
      if (st.impKey !== key) {
        st.impKey = key; RK.sumKey = null;
        RK.v0 = evOn().length ? (r => (r.error ? null : r.valuation.value_per_share))(E.project(spec, st.ov, { exposure: false })) : (st.res && !st.res.error ? st.res.valuation.value_per_share : null);
        for (const [id, c] of RK.cards) {
          const r = E.eventImpact(spec, st.ov, id, { events: st.ev });
          clear(c.imp);
          c.dv = r.error ? null : r.value_per_share.delta;
          if (r.error) { c.imp.appendChild(h('dd', null, 'Impact unavailable for these settings.')); continue; }
          const rowD = (k, j) => (r.rows[k] && isNum(r.rows[k].delta[j]) ? r.rows[k].delta[j] : null);
          const R0 = k => (r.rows[k] ? r.rows[k] : null), from = stubbed ? 1 : 0;
          const one = (label, d, unit, good, dp) => {
            const t = tone(d, good, unit === 'US$' ? 0.005 : 0.5);
            c.imp.appendChild(h('div', { class: 'mdl-evimp-i' }, h('dt', null, label),
              h('dd', { class: `mdl-cd ${t}` }, d === null ? '—' : t === 'flat' ? 'no change' : unit === 'US$m' ? money(d, true) : fmt(d, unit, isNum(dp) ? dp : 2, true))));
          };
          one('Value per share', r.value_per_share.delta, 'US$', 1);
          c.imp.appendChild(h('div', { class: 'mdl-evimp-i mdl-evimp-yrs' }, h('dt', null, 'Revenue'), yearStrip(R0('revenue') && R0('revenue').delta, 1, from)));
          c.imp.appendChild(h('div', { class: 'mdl-evimp-i mdl-evimp-yrs' }, h('dt', null, 'Net income'), yearStrip(R0('net_income') && R0('net_income').delta, 1, from)));
          const fn = rowD('uncommitted_cum', years.length - 1);
          if (isNum(fn) && Math.abs(fn) > 0.5) one(`Uncommitted debt raised to ${ylong(last)}`, fn, 'US$m', 0);
          const mx = k => { const a = R0(k); return a ? Math.max(0, ...a.on.map(x => (isNum(x) ? x : 0))) - Math.max(0, ...a.off.map(x => (isNum(x) ? x : 0))) : null; };
          const dDef = mx('mw_deferred'), dSf = R0('funding_shortfall') ? R0('funding_shortfall').delta.reduce((q, x) => q + (isNum(x) ? x : 0), 0) : null;
          if (isNum(dDef) && Math.abs(dDef) >= 1) one('Builds deferred for funding (peak)', dDef, 'MW', -1, 0);
          if (isNum(dSf) && Math.abs(dSf) > 0.5) one('Unfunded need, penalty-rate debt', dSf, 'US$m', -1);
          const lq = R0('liquidity'), lmin = a => Math.min(...a.filter(isNum));
          if (lq && lq.on.some(isNum) && lq.off.some(isNum)) { const dl = lmin(lq.on) - lmin(lq.off); if (Math.abs(dl) > 0.5) one('Lowest year-end liquidity', dl, 'US$m', 1); }
        }
      }
      syncRisk();
      renderDist();
    }
    function renderDist() {
      const d = distNow();
      if (d) { drawDist(d); return; }
      clear(RK.dist);
      RK.dist.appendChild(h('p', { class: 'mdl-note', 'data-mdl-dist-wait': '' }, `Computing the outcome distribution: ${Math.round(st.distProg * 100)}% of the draws…`));
      startDist();
    }
    const statTile = (key, label, value, sub, cls) => h('div', { class: `mdl-kpi${cls ? ` ${cls}` : ''}`, role: 'listitem', 'data-mdl-dstat': key },
      h('div', { class: 'mdl-kpi-l' }, label), h('div', { class: 'mdl-kpi-v' }, value), sub ? h('div', { class: 'mdl-kpi-s' }, sub) : null);
    // how the distribution was built, in one paragraph
    function distMethod(d) {
      const unc = (d.uncertainty || []).map(id => inSentence((byId.get(id) || {}).label || id));
      const reg = d.regimes && d.regimes.length ? d.regimes : [];
      return (d.method === 'exact'
        ? `Exact: all ${d.states.toLocaleString('en-US')} combinations of the ${EVS.length} events (at most one per group), each weighted by its probability. `
        : `Monte Carlo: ${fmt(d.draws, '', 0)} draws (fixed seed, so the same every time) of ${reg.length ? `a regime (${reg.map(r => `${inSentence(r.name)} ${pctP(r.p)}`).join(', ')}), ` : ''}`
          + `the ${EVS.length} events at their probabilities${unc.length ? ` and ${unc.join(', ')} (each from a triangular spread over its stress range, centred on the slider)` : ''}. `)
        + (reg.length ? 'Events are correlated through the regime: each keeps its catalogue probability on average but is likelier in the regime it belongs to. ' : '')
        + 'The On/Off switches do not matter here.';
    }
    // the representative presets as points of the distribution: value, percentile and the share of
    // outcomes nearer to each than to any other preset
    function presetList(pr, label) {
      return h('ol', { class: 'mdl-bridge mdl-presets', 'aria-label': label },
        byValue(pr).map(r => h('li', { class: 'mdl-step', 'data-mdl-preset': r.id }, h('span', { class: 'mdl-step-l' }, str(r.name)), h('span', { class: 'mdl-step-v' }, fmt(r.value, 'US$', 2)),
          h('span', { class: 'mdl-step-n' }, `P${fmt(r.percentile, '', 0)} of the distribution · ${pctP(r.mass)} of outcomes are nearest to it`))));
    }
    function drawDist(d) {
      clear(RK.dist);
      if (!d || d.error) { RK.dist.appendChild(h('p', { class: 'mdl-note' }, 'The outcome distribution couldn’t be computed for these settings.')); return; }
      const V = d.metrics.value_per_share, N = d.metrics[`net_income@${st.ky}`], price = cur('share_price'), last = years[years.length - 1];
      RK.dist.appendChild(h('p', { class: 'mdl-note' }, distMethod(d)));
      if (V) {
        const pb = pBelow(V.hist, price), cy = d.covenant_from_year;
        RK.dist.appendChild(h('div', { class: 'mdl-kpis mdl-dstats mdl-strip', role: 'list', 'aria-label': 'Value per share across the outcomes' },
          statTile('mean', 'Distribution mean', fmt(V.mean, 'US$', 2), `vs ${fmt(price, 'US$', 2)} price: ${fmt(isNum(V.mean) && price ? (V.mean / price - 1) * 100 : null, '%', 0, true)}`),
          statTile('pct', 'P10 / P50 / P90', `${fmt(V.p10, 'US$', 0)} / ${fmt(V.p50, 'US$', 0)} / ${fmt(V.p90, 'US$', 0)}`, 'value per share'),
          statTile('below', 'P(value below the price)', `${isNum(pb) && pb > 0 && pb < 1 ? '≈ ' : ''}${pctP(pb)}`, `below ${fmt(price, 'US$', 2)}`, isNum(pb) && pb > 0.5 ? 'neg' : null),
          statTile('cov', `P(above a leverage cap${cy ? `, ${yl(cy)}+` : ''})`, pctP(d.p_covenant_breach), 'incurrence caps on run-rate EBITDA, any year', d.p_covenant_breach > 0.25 ? 'neg' : null),
          statTile('liq', 'P(liquidity below zero)', pctP(d.p_liquidity_negative), 'cash + undrawn committed, any year', d.p_liquidity_negative > 0.1 ? 'neg' : null),
          statTile('fund', 'P(more uncommitted debt)', pctP(d.p_funding_need_above), `uncommitted debt raised to ${yl(last)} above the no-event ${money(d.funding_threshold)}`)));
        RK.dist.appendChild(chartBox(histogram({ id: `${uid}-hv`, title: 'Value per share across the outcomes (probability, %)', hist: V.hist, unit: 'US$', dp: 2, split: price,
          marks: [{ v: price, label: `Price ${fmt(price, 'US$', 2)}`, strong: true }, { v: V.p10, label: `P10 ${fmt(V.p10, 'US$', 0)}` }, { v: V.p50, label: `P50 ${fmt(V.p50, 'US$', 0)}` }, { v: V.p90, label: `P90 ${fmt(V.p90, 'US$', 0)}` }],
          desc: `Mean ${fmt(V.mean, 'US$', 2)}, P10 ${fmt(V.p10, 'US$', 2)}, P50 ${fmt(V.p50, 'US$', 2)}, P90 ${fmt(V.p90, 'US$', 2)}; probability below the ${fmt(price, 'US$', 2)} price ${pctP(pb)}.` }),
        legend([['Below the share price', C_LIMIT], ['At or above it', C_LOW]])));
        if (d.regimes && d.regimes.length) RK.dist.appendChild(h('p', { class: 'mdl-note', 'data-mdl-regimes': '' }, 'Mean value by regime: ',
          d.regimes.map((r, j) => `${j ? ' · ' : ''}${str(r.name)} (${pctP(r.p)}) ${fmt(r.mean, 'US$', 0)}`).join(''), '.', d.note ? [' ', rich.inline(d.note)] : null));
        if (d.presets && d.presets.length) {
          RK.dist.appendChild(h('h5', { class: 'mdl-h5' }, 'The presets as points of the distribution'));
          RK.dist.appendChild(presetList(d.presets, 'Representative presets'));
        }
      }
      if (N) {
        const pl = pBelow(N.hist, 0);
        RK.dist.appendChild(h('h5', { class: 'mdl-h5' }, `${ylong(st.ky)} net income across the outcomes`));
        RK.dist.appendChild(h('div', { class: 'mdl-kpis mdl-dstats mdl-strip', role: 'list', 'aria-label': `${ylong(st.ky)} net income across the outcomes` },
          statTile('ni_mean', 'Distribution mean', money(N.mean), `no events: ${money(N.base)}`),
          statTile('ni_pct', 'P10 / P50 / P90', `${money(N.p10)} / ${money(N.p50)} / ${money(N.p90)}`, 'net income'),
          statTile('ni_loss', 'P(a loss)', `${isNum(pl) && pl > 0 && pl < 1 ? '≈ ' : ''}${pctP(pl)}`, 'net income below zero', isNum(pl) && pl > 0.5 ? 'neg' : null)));
        RK.dist.appendChild(chartBox(histogram({ id: `${uid}-hn`, title: `${ylong(st.ky)} net income across the outcomes (probability, %)`, hist: N.hist, unit: 'US$m', dp: 0, split: 0,
          marks: [{ v: 0, label: 'Break-even', strong: true }, { v: N.p10, label: `P10 ${money(N.p10)}` }, { v: N.p50, label: `P50 ${money(N.p50)}` }, { v: N.p90, label: `P90 ${money(N.p90)}` }],
          desc: `Mean ${money(N.mean)}, P10 ${money(N.p10)}, P50 ${money(N.p50)}, P90 ${money(N.p90)}; probability of a loss ${pctP(pl)}.` }),
        legend([['A loss', C_LIMIT], ['A profit', C_LOW]])));
      }
      if (d.warnings && d.warnings.length) RK.dist.appendChild(h('ul', { class: 'rpt-bul mdl-warn' }, d.warnings.slice(0, 6).map(w => h('li', null, str(w)))));
    }
    function renderRisk(p) {
      if (!RK) { clear(p); buildRisk(p); }
      refreshRisk();
    }

    // ---- Quarterly watch list: the reported number, the model's path, the line that changes the view ----
    function watchFmt(v, unit, dp) {
      const q = isNum(dp) ? dp : null;
      return unit === 'US$m' ? money(v) : unit === '%' ? fmt(v, '%', q === null ? 0 : q) : unit === 'x' ? fmt(v, 'x', q === null ? 1 : q) : fmt(v, unit, q === null ? 1 : q);
    }
    // the next reported quarters: the model's quarter against the company's guide where there is one
    function nextPrint(p, res) {
      const Q = Array.isArray(res.quarters) ? res.quarters.slice(0, 2) : [];
      if (!Q.length) return;
      const gFor = (metric, q) => guides.find(g => g.metric === metric && str(g.period) === q.quarter);
      const qName = q => q.quarter.replace(/^(\d{4})-Q(\d)$/, 'Q$2 $1');
      const rows = [['revenue', 'Revenue', 'US$m'], ['cost_of_revenue', 'Cost of revenue', 'US$m'], ['ebitda', 'Adj. EBITDA', 'US$m'], ['interest', 'Interest expense', 'US$m'],
        ['billing_mw_avg', 'Billing MW (average)', 'MW'], ['active_mw_end', 'Active MW at quarter end', 'MW'], ['revenue_per_billing_mw', 'Revenue per billing MW (annualised)', 'US$m']];
      const cell = (v, u) => (u === 'MW' ? fmt(v, '', 0) : u === 'US$m' && isNum(v) && Math.abs(v) < 50 ? fmt(v, 'US$m', 2) : money(v));
      const body = rows.map(([k, label, u]) => {
        const tds = Q.map(q => {
          const g = gFor(k, q), mv = k === 'interest' ? (g ? guideValue(res, spec, g) : null) : q[k];
          const pass = g && isNum(mv) ? (!isNum(g.lo) || mv >= g.lo) && (!isNum(g.hi) || mv <= g.hi) : null;
          return [h('td', { class: 'r' }, cell(mv, u)), h('td', { class: 'r' }, g ? [`${money(g.lo)}–${money(g.hi)} `, passPill(pass), rich.cite(g.src || [])] : '—')];
        });
        return tds.flat().every(td => td.textContent === '—') ? null : h('tr', null, h('th', { scope: 'row', class: 'l' }, label), tds);
      }).filter(Boolean);
      p.appendChild(h('h4', { class: 'mdl-h4', 'data-mdl-sec': 'nextprint' }, `Next prints: ${Q.map(qName).join(' and ')}`));
      p.appendChild(h('p', { class: 'mdl-note' }, 'The model’s quarters under the current settings against the company’s guidance, for checking the next results line by line. '
        + 'Quarterly interest is the second half’s average; adj. EBITDA uses the year’s operating-cost ratio.'));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Next reported quarters' },
        h('table', { class: 'rpt-table mdl-table', 'data-mdl-nextprint': '' },
          h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'US$m unless stated'), Q.map(q => [h('th', { scope: 'col', class: 'r' }, `${qName(q)} model`), h('th', { scope: 'col', class: 'r' }, 'Guide')]))),
          h('tbody', null, body))));
    }
    // the sources of a note not already cited inline in it ("… Q2 2026 [s3,s2]." then [s2, s3, …] repeated them)
    function moreSrc(text, ids) {
      const inText = new Set((str(text).match(/\[[^\]]*\]/g) || []).flatMap(g => g.match(/s\d+/g) || []));
      const rest = (Array.isArray(ids) ? ids : []).filter(id => !inText.has(str(id)));
      return rest.length ? rich.cite(rest) : null;
    }
    function renderWatch(p, res) {
      const W = Array.isArray(res.watchlist) ? res.watchlist : [];
      p.appendChild(h('p', { class: 'mdl-note' }, 'What to check each quarter: the latest reported value, the path this model assumes under the current settings, '
        + 'and the level that would change the view. Each item informs a driver or a business event of the model.'));
      const grid = h('div', { class: 'mdl-watch' });
      for (const w of W) {
        const unit = str(w.unit), vals = Array.isArray(w.values) ? w.values : [], crossed = Array.isArray(w.crossed) ? w.crossed : [], dp = w.dp;
        const L = w.latest || {}, below = w.direction === 'below', pos = w.signal === 'positive', modelled = w.modelled !== false;
        const nowPast = isNum(L.value) && isNum(w.threshold) && (below ? L.value < w.threshold : L.value > w.threshold);
        const pill = nowPast ? (pos ? ['Milestone reached', 'ok'] : ['Past the line', 'miss']) : !modelled ? ['Tracked, not modelled', 'na']
          : w.first_cross ? [`Model: crosses ${yl(w.first_cross)}`, pos ? 'ok' : 'warn'] : ['Model: not crossed', 'na'];
        const inf = (Array.isArray(w.informs) ? w.informs : []).map(id => (evById.has(id) ? evLink(id) : driverLink(id))).filter(Boolean);
        const spark = modelled ? sparkline({ values: vals, threshold: w.threshold, crossed, positive: pos, title: `${str(w.label)}: model path against the ${watchFmt(w.threshold, unit, dp)} line` }) : null;
        grid.appendChild(h('article', { class: 'mdl-wcard', 'data-mdl-watch': w.id },
          h('div', { class: 'mdl-ev-top' }, h('h5', { class: 'mdl-ev-t' }, str(w.label)), h('span', { class: `mdl-pass ${pill[1]}` }, pill[0])),
          h('dl', { class: 'mdl-wdl' },
            h('div', null, h('dt', null, 'Latest reported'), h('dd', null, h('strong', null, watchFmt(L.value, unit, dp)), ` (${str(L.period)})`, L.note ? [' — ', rich.inline(L.note)] : null, moreSrc(L.note, L.src))),
            h('div', null, h('dt', null, 'Changes the view'), h('dd', null, `${below ? 'Below' : 'Above'} ${watchFmt(w.threshold, unit, dp)} — ${pos ? 'a positive signal' : 'a warning'}`)),
            h('div', null, h('dt', null, 'This model'), h('dd', null, modelled
              ? [years.map((y, i) => `${yl(y)} ${watchFmt(vals[i], unit, dp)}`).join(' · '), w.first_cross ? ` (crosses in ${yl(w.first_cross)})` : ' (never crosses)']
              : 'not a model output: compare the reported figure with the line, and move the events it informs')),
            // the comma rides inside the link, after its text: a wrapped line never starts with one, and it
            // cannot float at the right edge of a two-line button's box
            inf.length ? h('div', null, h('dt', null, 'Informs'), h('dd', { class: 'mdl-inf' }, inf.map((b, j) => {
              const t = b.textContent;
              clear(b);
              b.appendChild(h('span', { class: 'mdl-inf-t' }, t));
              if (j < inf.length - 1) b.appendChild(h('span', { class: 'mdl-inf-sep', 'aria-hidden': 'true' }, ','));
              return [j ? ' ' : '', b];
            }))) : null),
          spark ? h('div', { class: 'mdl-wspark' }, spark) : null,
          w.note ? h('p', { class: 'mdl-note' }, rich.inline(w.note), moreSrc(w.note, w.src)) : null));
      }
      p.appendChild(grid);
      nextPrint(p, res);
    }

    function renderPanel(k, full) {
      const p = panels.get(k);
      if (!p || !st.res || st.res.error) return;
      if (k === 'pl') {
        // persistent halves: the table now, the rest when the sliders rest (or the tab is opened)
        if (!PL) { clear(p); PL = { fast: h('div', { class: 'mdl-plfast' }), slow: h('div', { class: 'mdl-plslow' }) }; p.appendChild(PL.fast); p.appendChild(PL.slow); }
        clear(PL.fast);
        try { renderPL(PL.fast, st.res); } catch (e) { clear(PL.fast); PL.fast.appendChild(h('p', { class: 'mdl-note' }, 'This view couldn’t be drawn for these settings.')); }
        if (full !== false || !PL.slow.firstChild) fillPLSlow();
        else if (st.plSlowKey !== plKey()) { PL.slow.classList.add('mdl-stale'); PL.slow.setAttribute('aria-busy', 'true'); }
        st.stale.delete(k);
        return;
      }
      if (k === 'risk') {
        // persistent: refreshed in place, never cleared while it lives
        try { renderRisk(p); } catch (e) { RK = null; clear(p); p.appendChild(h('p', { class: 'mdl-note' }, 'This view couldn’t be drawn for these settings.')); }
        st.stale.delete(k);
        return;
      }
      clear(p);
      try {
        if (k === 'pl') renderPL(p, st.res);
        else if (k === 'debt') renderDebt(p, st.res);
        else if (k === 'sens') renderSens(p);
        else if (k === 'be') renderBE(p);
        else if (k === 'val') renderVal(p, st.res);
        else if (k === 'watch') renderWatch(p, st.res);
        else if (k === 'cal') renderCal(p, st.res);
      } catch (e) { clear(p); p.appendChild(h('p', { class: 'mdl-note' }, 'This view couldn’t be drawn for these settings.')); }
      st.stale.delete(k);
    }

    // ---- Key P&L drivers callout ----
    function renderKeyDrivers() {
      clear(keyd);
      const m = mdef('net_income', st.ky);
      const s = E.sensitivity(spec, st.ov, { metric: m.metric, year: m.year, events: st.ev, probs: st.probs });
      const lines = keyDriverLines(s, D, m.what, m.unit, probOf);
      keyd.appendChild(h('div', { class: 'rpt-callout-t' }, `Key P&L drivers — ${m.what}`));
      if (!lines.length) { keyd.appendChild(h('p', null, 'No single driver moves this line at the current settings.')); return; }
      keyd.appendChild(h('ul', { class: 'rpt-bul' }, lines.map(l => h('li', { class: l.event ? 'mdl-kd-ev' : null }, l.text))));
      keyd.appendChild(h('p', { class: 'mdl-note' }, `From the tornado at the current settings: each driver moved alone to the end of its stress range that matters most`
        + `${EVS.length ? ', each business event switched' : ''}.`));
    }

    // ---- print snapshot ----
    function scenarioName() {
      const id = E.matchScenario(spec, st.ov, st.ev);
      const s = id && scen.find(x => x.id === id);
      return s ? str(s.name) : 'Custom';
    }
    function renderPrint() {
      if (!st.res || st.res.error) return;
      clear(printBox);
      const changed = D.filter(d => Math.abs(cur(d.id) - d.base) > 1e-12).map(d => (d.kind === 'choice' ? `${d.label} ${str((d.choices[cur(d.id)] || {}).name)}`
        : `${d.label} ${fmt(cur(d.id), d.unit, d.dp, /^shift|^scale/.test(d.kind))}`));
      const today = new Date().toISOString().slice(0, 10);
      printBox.appendChild(h('h3', { class: 'mdl-title' }, 'Stress test & projections'));
      printBox.appendChild(h('p', { class: 'mdl-note' }, `Scenario as of print (${today}): ${scenarioName()}. `
        + (changed.length ? `Drivers changed from base: ${changed.join('; ')}.` : 'All drivers at base.')));
      if (EVS.length) {
        const on = evOn().map(id => evById.get(id));
        printBox.appendChild(h('p', { class: 'mdl-note', 'data-mdl-print': 'events' }, on.length
          ? `Business events switched on: ${on.map(e => `${str(e.label)} (${e.kind === 'upside' ? 'upside' : 'risk'}, ${pctP(probOf(e.id))} likely)`).join('; ')}.`
          : `No business events switched on (${EVS.length} in the catalogue).`,
        Object.keys(st.probs).length ? ` Probabilities edited: ${Object.keys(st.probs).map(id => `${str((evById.get(id) || {}).label)} ${pctP(st.probs[id])}`).join('; ')}.` : ''));
        // the distribution summary: the cached one for these inputs (finished for print if missing)
        const dd = distNow(), V = dd && !dd.error ? dd.metrics.value_per_share : null;
        const N = dd && !dd.error ? dd.metrics[`net_income@${st.ky}`] : null, price = cur('share_price');
        if (V) printBox.appendChild(h('p', { class: 'mdl-note', 'data-mdl-print': 'dist' }, `Outcome distribution over the ${EVS.length} events${dd.regimes && dd.regimes.length ? `, ${dd.regimes.length} regimes` : ''}${dd.uncertainty && dd.uncertainty.length ? ` and ${dd.uncertainty.length} uncertain drivers` : ''} (${dd.method === 'exact' ? `exact, ${dd.states.toLocaleString('en-US')} states` : `Monte Carlo, ${dd.draws} draws`}): `
          + `mean value ${fmt(V.mean, 'US$', 2)}; P10 / P50 / P90 ${fmt(V.p10, 'US$', 2)} / ${fmt(V.p50, 'US$', 2)} / ${fmt(V.p90, 'US$', 2)}; `
          + `P(value below the ${fmt(price, 'US$', 2)} price) ≈ ${pctP(pBelow(V.hist, price))}; P(above a leverage cap${dd.covenant_from_year ? `, ${yl(dd.covenant_from_year)}+` : ''}) ${pctP(dd.p_covenant_breach)}; P(liquidity below zero) ${pctP(dd.p_liquidity_negative)}`
          + `${N ? `; ${ylong(st.ky)} net income P10 / P50 / P90 ${money(N.p10)} / ${money(N.p50)} / ${money(N.p90)}` : ''}`
          + `${dd.presets && dd.presets.length ? `; presets ${byValue(dd.presets).map(r => `${shortName(r)} ${fmt(r.value, 'US$', 0)} (P${fmt(r.percentile, '', 0)})`).join(', ')}` : ''}.`));
      }
      printBox.appendChild(h('div', { class: 'mdl-kpis' }, kpiList(st.res, st.ky).map(kpiTile)));
      printBox.appendChild(plTable(st.res, false));
      const m = mdef('value_per_share'), t0 = E.sensitivity(spec, st.ov, { metric: m.metric, events: st.ev, probs: st.probs });
      if (!t0.error) printBox.appendChild(h('div', { class: 'mdl-chart' }, h('div', { class: 'mdl-cap' }, `Tornado: ${m.label} (${m.unit})`),
        tornado({ id: `${uid}-ptor`, sens: t0, drivers: D, unit: m.unit, dp: m.dp, title: `Tornado: ${m.label}`, max: EVS.length ? 16 : 12, probOf }),
        legend(torLegend())));
      printBox.appendChild(h('p', { class: 'mdl-disc' }, 'Illustrative model, not investment advice; outputs are only as good as the drivers.'));
    }
    // built only when printing: beforeprint, or the print media query where that event is missing
    const onBeforePrint = () => {
      try { finishDist(); } catch { /* printed without it */ }
      renderPrint();
    };
    const printMq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('print') : null;
    const onPrintMq = ev => { if (ev && ev.matches) onBeforePrint(); };
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeprint', onBeforePrint);
    if (printMq) { if (printMq.addEventListener) printMq.addEventListener('change', onPrintMq); else if (printMq.addListener) printMq.addListener(onPrintMq); }

    // ---- copy link ----
    function shareUrl() {
      const base = str(links.self) || '';
      const hash = base + (st.enc ? `?m=${st.enc}` : '');
      if (typeof location === 'undefined') return hash;
      return location.href.split('#')[0] + hash;
    }
    function copyLink() {
      const url = shareUrl();
      const shownBox = () => { copyBox.hidden = false; copyBox.value = url; try { copyBox.focus(); copyBox.select(); } catch { /* old browsers */ } status('Copy the link from the box.'); };
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => { copyBox.hidden = true; status('Link to this scenario copied.'); }, shownBox);
        } else shownBox();
      } catch { shownBox(); }
    }

    // ---- update: the projection, KPIs and the visible fast tab on every frame; the tornado,
    // grid and breakevens (tens of model runs each) once the sliders rest ----
    // the share link: drivers, the events switched on and edited probabilities
    function writeState() {
      st.enc = E.encodeState(spec, st.ov, { events: st.ev, probs: st.probs, view: { mode: st.evMode, year: st.ky !== KY ? st.ky : undefined } });
      if (fullLink) fullLink.setAttribute('href', str(links.full) + (st.enc ? `?m=${st.enc}` : ''));
      if (typeof o.onState === 'function') { try { o.onState(st.enc); } catch { /* caller's problem */ } }
    }
    function update() {
      const res = E.project(spec, st.ov, { events: st.ev });
      st.res = res;
      if (res.error) { clear(kpis); kpis.appendChild(h('p', { class: 'mdl-note' }, 'The model couldn’t be run with these settings.')); return; }
      st.w = E.weighted ? E.weighted(spec, st.ov, st.anchor, { events: st.ev }) : null;
      syncDrivers();
      const id = E.matchScenario(spec, st.ov, st.ev);
      for (const [sid, b] of chipEls) { const on = sid === id; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('on', on); }
      customChip.hidden = !!id;
      const sc = id && scen.find(x => x.id === id);
      // a preset names the business events behind it (the bear = which risks)
      const evTxt = evOn().length ? ` Business events: ${evOn().map(e => str(evById.get(e).label)).join(' · ')}.` : '';
      clear(scenNote);
      if (sc && sc.note) scenNote.appendChild(h('span', null, `${str(sc.name)}: `, rich.inline(sc.note), evTxt));
      else scenNote.textContent = sc ? evTxt.trim() : `Custom: ${evOn().length ? 'drivers and events' : 'drivers'} edited by hand.${evTxt}`;
      renderKpis(); renderMini();
      for (const [k] of TABS) st.stale.add(k);
      writeState();
      if (!SLOW_TABS.has(st.tab)) renderPanel(st.tab, false);
      scheduleSlow();
    }
    function slow() {
      clearTimeout(st.slowT); st.slowT = 0;
      if (!st.alive || !st.res || st.res.error) return;
      renderKeyDrivers();
      if (SLOW_TABS.has(st.tab)) renderPanel(st.tab);
      else if (st.tab === 'pl' && PL && st.plSlowKey !== plKey()) fillPLSlow();
      clearTimeout(st.distT);
      st.distT = setTimeout(startDist, 350);
    }

    decode(o.state);
    update();
    slow();
    // a phone opens only the first two driver groups; a shared link also opens the ones it moved
    if (narrow && drvPanel.querySelectorAll) for (const box of drvPanel.querySelectorAll('details.mdl-group')) {
      const c = box.querySelector ? box.querySelector('[data-mdl-gcount]') : null;
      if (c && c.textContent) box.open = true;
    }

    const dispose = () => {
      st.alive = false;
      clearTimeout(statusT); clearTimeout(st.slowT); clearTimeout(st.distT);
      clearTimeout(st.distTick);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('beforeprint', onBeforePrint);
      if (printMq) { if (printMq.removeEventListener) printMq.removeEventListener('change', onPrintMq); else if (printMq.removeListener) printMq.removeListener(onPrintMq); }
      if (root.parentNode) root.parentNode.removeChild(root);
    };
    dispose.setState = s => { decode(s); schedule(); };
    dispose.getState = () => st.enc;
    return dispose;
  }

  return {
    mount,
    // Pure helpers, exposed for tests.
    _internal: { fmt, money, tickMoney, tone, scale, axisValues, driverNoun, moveText, keyDriverLines, guideValue, pctP, pBelow, yearAvgMW, impactLines },
  };
});
