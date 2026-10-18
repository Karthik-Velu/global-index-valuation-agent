#!/usr/bin/env node
// Model engine tests (Node, zero dependencies) for dashboard/model-engine.js against the
// synthetic Fixture Corp spec (tests/fixtures/models/fxr.json): accounting identities,
// hand-computed interest, rate pass-through, monotonicity, the stub year, funding-gap
// dilution, tornado / grid / scenarios, the share-link codec under hostile input,
// never-throw on malformed specs, determinism, speed and the browser (UMD) load path.
//
//   node scripts/test_model.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const ENGINE_PATH = path.join(ROOT, 'dashboard', 'model-engine.js');
const M = require(ENGINE_PATH);
const FIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'models', 'fxr.json'), 'utf8'));
const spec = () => JSON.parse(JSON.stringify(FIX));

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const near = (a, b, msg, tol) => assert(typeof a === 'number' && Math.abs(a - b) <= (tol || 1e-6) * Math.max(1, Math.abs(b)),
  `${msg || ''}: ${a} != ${b}`);
const run = ov => { const r = M.project(FIX, ov || {}); assert(!r.error, r.error); return r; };
const BASE = run();
const Y = BASE.years, N = Y.length;
const at = (r, k, y) => r.rows[k][Y.indexOf(y)];
const TRANCHES = FIX.debt.map(t => t.id);

// every number in a result is finite or null
function allFinite(x, where) {
  if (typeof x === 'number') assert(isFinite(x), `non-finite at ${where}`);
  else if (Array.isArray(x)) x.forEach((v, i) => allFinite(v, `${where}[${i}]`));
  else if (x && typeof x === 'object') for (const k of Object.keys(x)) allFinite(x[k], `${where}.${k}`);
}

// ---- spec + template ----
check('fixture validates cleanly', () => {
  const v = M.validateSpec(FIX);
  eq(v.errors, []); eq(v.warnings, []); assert(v.ok);
  eq(BASE.warnings, []);
});
check('template metadata: required driver ids, groups, kinds, units, rows', () => {
  const t = M.template('levered_growth_v1');
  const req = ['revenue_growth', 'cost_of_revenue_pct', 'opex_pct', 'sbc_pct', 'capex', 'useful_life', 'sofr_shift', 'spread_shift',
    'new_debt_rate', 'equity_funding_share', 'issue_discount', 'min_cash', 'wc_prepay_pct', 'tax_rate', 'exit_ev_ebitda',
    'discount_rate', 'share_price'];
  eq(t.drivers.filter(d => d.required).map(d => d.id).sort(), req.slice().sort());
  for (const d of t.drivers) {
    assert(t.groups.includes(d.group), `${d.id}: group`);
    assert(['shift_pp', 'shift_bp', 'scale_pct', 'scalar'].includes(d.kind), `${d.id}: kind`);
    assert(['pp', 'bp', '%', 'x', 'yrs', 'US$', 'US$m'].includes(d.unit), `${d.id}: unit`);
    assert(d.min <= d.base && d.base <= d.max && d.step > 0 && d.label && d.help, `${d.id}: range/label/help`);
  }
  for (const k of Object.keys(t.rows)) assert(Array.isArray(BASE.rows[k]) && BASE.rows[k].length === N, `row ${k}`);
  assert(Object.isFrozen(t) && Object.isFrozen(t.drivers[0]));
  eq(M.template('nope'), null); eq(M.template('__proto__'), null);
});
check('drivers(): spec values merged over the template; paths aligned to years', () => {
  const d = M.drivers(FIX), byId = Object.fromEntries(d.map(x => [x.id, x]));
  eq(byId.revenue_growth.path, [50, 40, 25, 15, 10]);
  eq(byId.capex.path, [900, 800, 600, 500, 500]);
  eq(byId.exit_ev_ebitda.base, 10);
  eq(M.defaults(FIX).share_price, 20);
});
check('missing / unknown drivers: template default + warning, never an error', () => {
  const s = spec();
  s.drivers = s.drivers.filter(d => d.id !== 'tax_rate').concat([{ id: 'mystery', base: 1 }]);
  const r = M.project(s, {});
  assert(!r.error);
  assert(r.warnings.some(w => w.includes('tax_rate missing')), JSON.stringify(r.warnings));
  assert(r.warnings.some(w => w.includes('mystery has no meaning')));
  near(r.rows.tax[1], 0.21 * r.rows.pretax[1], 'template 21% tax');
});

// ---- accounting identities ----
check('P&L identities every year', () => {
  const R = BASE.rows;
  for (let i = 0; i < N; i++) {
    near(R.gross_profit[i], R.revenue[i] - R.cost_of_revenue[i], `gp ${Y[i]}`);
    near(R.ebitda[i], R.revenue[i] - R.cost_of_revenue[i] - R.opex[i], `ebitda ${Y[i]}`);
    near(R.ebit[i], R.ebitda[i] - R.sbc[i] - R.da[i], `ebit ${Y[i]}`);
    near(R.pretax[i], R.ebit[i] - R.interest[i] + R.other_income[i], `pretax ${Y[i]}`);
    near(R.net_income[i], R.pretax[i] - R.tax[i], `ni ${Y[i]}`);
    near(R.eps[i], R.net_income[i] / R.shares_avg[i], `eps ${Y[i]}`);
    near(R.fcf[i], R.ocf[i] - R.capex[i], `fcf ${Y[i]}`);
    near(R.net_debt[i], R.debt_end[i] - R.cash_end[i], `net debt ${Y[i]}`);
    near(R.interest_cover[i], R.ebitda[i] / R.interest[i], `cover ${Y[i]}`);
    near(R.net_debt_ebitda[i], R.net_debt[i] / R.ebitda[i], `nd/ebitda ${Y[i]}`);
    if (i > 0) near(R.revenue[i], R.revenue[i - 1] * (1 + FIX.drivers[0].path[Y[i]] / 100), `growth ${Y[i]}`);
  }
});
check('cash roll-forward: cash_end = open + ocf - capex + new debt + equity - repayments', () => {
  const R = BASE.rows;
  for (let i = 0; i < N; i++) {
    near(R.cash_open[i], i ? R.cash_end[i - 1] : FIX.opening.cash, `open ${Y[i]}`);
    near(R.cash_end[i], R.cash_open[i] + R.ocf_proj[i] - R.capex_proj[i] + R.new_debt[i] + R.new_equity_m[i] - R.repayments[i], `cash ${Y[i]}`);
    if (i) { near(R.ocf_proj[i], R.ocf[i], 'full-year ocf'); near(R.capex_proj[i], R.capex[i], 'full-year capex'); }
    assert(R.cash_end[i] >= FIX.drivers.find(d => d.id === 'min_cash').base - 1e-6, `min cash ${Y[i]}`);
  }
});
check('debt roll-forward per tranche (amortisation, maturity refinanced, new-debt pool)', () => {
  const R = BASE.rows, D = R.debt_by_tranche;
  eq(Object.keys(D).sort(), TRANCHES.concat([M.NEW_DEBT_ID]).sort());
  for (let i = 0; i < N; i++) {
    const prev = id => (i ? D[id][i - 1] : (FIX.debt.find(t => t.id === id) || { balance: 0 }).balance);
    eq(D['term-loan'][i], 1000, 'bullet holds');
    eq(D['notes-2028'][i], 500, 'maturing bullet is refinanced, balance holds');
    near(D.ddtl[i], prev('ddtl') - [100, 200, 200, 100, 0][i], `ddtl amortises straight to 2029-06 (${Y[i]})`);
    near(D[M.NEW_DEBT_ID][i], prev(M.NEW_DEBT_ID) + R.new_debt[i], `new debt pool ${Y[i]}`);
    near(R.repayments[i], prev('ddtl') - D.ddtl[i], `repayments ${Y[i]}`);
    near(R.debt_end[i], Object.values(D).reduce((s, a) => s + a[i], 0), `Σ tranches ${Y[i]}`);
  }
  eq(R.refinanced, [0, 0, 500, 0, 0]);
});
check('shares roll: end = open x (1 + creep x period) + new shares; avg = mid', () => {
  const R = BASE.rows;
  let open = FIX.opening.shares_m;
  for (let i = 0; i < N; i++) {
    near(R.shares_end[i], open * (1 + 0.01 * R.proj_frac[i]) + R.new_shares[i], `shares ${Y[i]}`);
    near(R.shares_avg[i], (open + R.shares_end[i]) / 2, `avg ${Y[i]}`);
    open = R.shares_end[i];
  }
});
check('PP&E and book equity roll', () => {
  const R = BASE.rows;
  let ppe = FIX.opening.net_ppe;
  for (let i = 0; i < N; i++) {
    const daProj = R.da[i] - (i ? 0 : FIX.stub.actuals.da);
    ppe += R.capex_proj[i] - daProj;
    near(R.net_ppe[i], ppe, `ppe ${Y[i]}`);
    near(R.da_existing[i] + R.da_new[i], daProj, `da split ${Y[i]}`);
  }
});

// ---- interest ----
check('interest = stub actual + Σ tranche interest, every year', () => {
  const R = BASE.rows;
  for (let i = 0; i < N; i++)
    near(R.interest[i], R.interest_actual[i] + Object.values(R.interest_by_tranche).reduce((s, a) => s + a[i], 0), `${Y[i]}`);
  eq(R.interest_actual, [70, 0, 0, 0, 0]);
});
check('interest hand-computed: floating term loan + fixed notes', () => {
  const I = BASE.rows.interest_by_tranche, Rt = BASE.rows.rate_by_tranche;
  near(I['term-loan'][0], 1000 * (0.04 + 0.03) * 0.5, 'TL H2-2026: 1000 x (4.0% + 300bp) x 1/2');
  near(I['term-loan'][1], 1000 * 0.065, 'TL 2027: SOFR 3.5% + 3%');
  near(I['notes-2028'][0], 500 * 0.08 * 0.5, 'notes H2-2026');
  near(I['notes-2028'][1], 500 * 0.08, 'notes 2027 fixed 8%');
  near(I['notes-2028'][2], 500 * (0.08 * 0.5 + 0.10 * 0.5), 'notes 2028: matures mid-year, refinanced at 10%');
  near(I['notes-2028'][3], 500 * 0.10, 'notes 2029 at the refinancing rate');
  near(I.ddtl[0], (600 + 500) / 2 * 0.08 * 0.5, 'ddtl H2-2026 on average balance');
  near(I.ddtl[3], (100 + 0) / 2 * 0.07, 'ddtl 2029 final half-year of amortisation');
  near(Rt['term-loan'][1], 6.5, 'rate_by_tranche %');
  const nd = BASE.rows.new_debt;
  near(I[M.NEW_DEBT_ID][0], 0.10 * nd[0] / 2 * 0.5, 'new debt: half-year convention in the stub');
  near(I[M.NEW_DEBT_ID][1], 0.10 * (nd[0] + nd[0] + nd[1]) / 2, 'new debt 2027 on average pool');
});
check('floating tranches move 1:1 with sofr_shift and spread_shift; fixed do not until refinanced', () => {
  const up = run({ sofr_shift: 100 }).rows.interest_by_tranche, sp = run({ spread_shift: 100 }).rows.interest_by_tranche;
  const b = BASE.rows.interest_by_tranche;
  for (const S of [up, sp]) {
    near(S['term-loan'][1] - b['term-loan'][1], 1000 * 0.01, 'TL +1% x 1000');
    near(S['term-loan'][0] - b['term-loan'][0], 1000 * 0.01 * 0.5, 'TL stub half-year');
    near(S.ddtl[1] - b.ddtl[1], (500 + 300) / 2 * 0.01, 'ddtl +1% on avg balance');
    near(S['notes-2028'][0], b['notes-2028'][0], 'fixed unchanged (stub)');
    near(S['notes-2028'][1], b['notes-2028'][1], 'fixed unchanged (2027)');
    near(S['notes-2028'][3] - b['notes-2028'][3], 500 * 0.01, 'refinanced notes now reprice');
  }
  const R = run({ sofr_shift: 100 }).rows;
  near(R.sofr[1], 4.5, 'sofr row shows the shifted path');
});
check('new / refinanced debt: new_debt_rate + spread_shift + sofr_shift (beta 1; beta 0 opts out)', () => {
  eq(BASE.rows.rate_by_tranche[M.NEW_DEBT_ID][1], 10);
  near(run({ spread_shift: 100 }).rows.rate_by_tranche[M.NEW_DEBT_ID][1], 11, 'spread');
  near(run({ sofr_shift: 100 }).rows.rate_by_tranche[M.NEW_DEBT_ID][1], 11, 'sofr pass-through');
  near(run({ sofr_shift: 100, spread_shift: 50, new_debt_rate: 12 }).rows.rate_by_tranche['notes-2028'][3], 13.5, 'refi rate');
  const s = spec(); s.rates.new_debt_sofr_beta = 0;
  const r = M.project(s, { sofr_shift: 100 });
  near(r.rows.rate_by_tranche[M.NEW_DEBT_ID][1], 10, 'beta 0: new debt ignores SOFR');
  near(r.rows.rate_by_tranche['term-loan'][1], 7.5, 'floating still moves');
});
check('SOFR floor: a big negative shift floors SOFR at 0', () => {
  const R = run({ sofr_shift: -300 }).rows;
  eq(R.sofr[3], 0);
  near(R.interest_by_tranche['term-loan'][3], 1000 * 0.03, 'TL = spread only');
});

// ---- monotonicity ----
check('higher sofr_shift: higher interest, lower NI, lower value/share', () => {
  let prev = null;
  for (const bp of [-100, 0, 100, 200, 400]) {
    const r = run({ sofr_shift: bp });
    if (prev) {
      for (let i = 0; i < N; i++) assert(r.rows.interest[i] > prev.rows.interest[i], `interest ${Y[i]} @${bp}`);
      for (let i = 0; i < N; i++) assert(r.rows.net_income[i] < prev.rows.net_income[i], `ni ${Y[i]} @${bp}`);
      assert(r.valuation.value_per_share < prev.valuation.value_per_share, `vps @${bp}`);
    }
    prev = r;
  }
});
check('higher exit multiple: higher value; higher cost of equity: lower value', () => {
  const v = m => run({ exit_ev_ebitda: m }).valuation.value_per_share;
  assert(v(6) < v(8) && v(8) < v(10) && v(10) < v(14));
  const d = r => run({ discount_rate: r }).valuation.value_per_share;
  assert(d(10) > d(15) && d(15) > d(25));
});
check('shorter useful_life: higher D&A, lower EBIT, unchanged EBITDA', () => {
  // year by year until the short life has used up the opening PP&E (2026-28), and in total
  const s = run({ useful_life: 4 }).rows, l = run({ useful_life: 8 }).rows;
  const tot = a => a.reduce((x, y) => x + y, 0);
  for (let i = 0; i < N; i++) {
    if (i < 3) { assert(s.da[i] > l.da[i], `da ${Y[i]}`); assert(s.ebit[i] < l.ebit[i], `ebit ${Y[i]}`); }
    near(s.ebitda[i], l.ebitda[i], `ebitda ${Y[i]}`);
  }
  assert(tot(s.da) > tot(l.da) && tot(s.ebit) < tot(l.ebit), 'cumulative');
});
check('opening.dep_base: existing assets depreciate on it (not gross PP&E); default = gross', () => {
  const s = spec();
  s.opening.dep_base = 1800;                          // e.g. gross less construction in progress
  const r = M.project(s, {});
  assert(!r.error, r.error);
  eq(r.warnings, []);
  const life = FIX.drivers.find(d => d.id === 'useful_life').base;
  near(r.rows.da_existing[0], 1800 / life * 0.5, 'H2 2026 existing D&A');
  near(r.rows.da_existing[1], 1800 / life, '2027 existing D&A');
  near(BASE.rows.da_existing[1], FIX.opening.gross_ppe / life, 'no dep_base: gross PP&E');
  for (let i = 0; i < N; i++) near(r.rows.da_new[i], BASE.rows.da_new[i], `new-capex D&A unchanged ${Y[i]}`);
});
check('revenue growth / margins / capex move the P&L the right way', () => {
  const lo = run({ revenue_growth: -10 }), hi = run({ revenue_growth: 10 });
  for (let i = 0; i < N; i++) assert(hi.rows.revenue[i] > lo.rows.revenue[i]);
  assert(hi.valuation.value_per_share > lo.valuation.value_per_share);
  const m = run({ cost_of_revenue_pct: 5 });
  for (let i = 0; i < N; i++) assert(m.rows.gross_profit[i] < BASE.rows.gross_profit[i]);
  const c = run({ capex: 30 });
  for (let i = 0; i < N; i++) near(c.rows.capex[i], [900, 800, 600, 500, 500][i] * 1.3, `capex scale ${Y[i]}`);
  assert(c.rows.funding_gap.reduce((a, b) => a + b) > BASE.rows.funding_gap.reduce((a, b) => a + b), 'more capex, bigger gap');
});
check('customer prepayments: OCF rises by pct x Δrevenue', () => {
  const a = run({ wc_prepay_pct: 0 }).rows, b = run({ wc_prepay_pct: 20 }).rows;
  near(b.ocf[1] - a.ocf[1] - (b.net_income[1] - a.net_income[1]), 0.2 * (a.revenue[1] - a.revenue[0]), 'prepay 2027');
});

// ---- stub year ----
check('stub: FY2026 = H1 actuals + projected H2', () => {
  const R = BASE.rows, A = FIX.stub.actuals;
  near(R.revenue[0], 1000 * 1.5, 'FY revenue = prior x (1 + growth)');
  const h2 = R.revenue[0] - A.revenue;
  near(h2, 800, 'H2 revenue');
  near(R.cost_of_revenue[0], A.cost_of_revenue + 0.30 * h2, 'cor');
  near(R.opex[0], A.opex_ex_da_sbc + 0.20 * h2, 'opex');
  near(R.sbc[0], A.sbc + 0.05 * h2, 'sbc');
  near(R.da[0], A.da + 3000 / 6 * 0.5 + 500 / 6 * 0.25, 'da: H1 actual + existing half-year + H2 capex from mid-period');
  near(R.capex[0], 900, 'FY capex path'); near(R.capex_proj[0], 500, 'H2 capex');
  near(R.ocf[0], A.ocf + R.ocf_proj[0], 'ocf');
  eq(R.proj_frac, [0.5, 1, 1, 1, 1]);
  near(R.revenue_growth[0], 50, 'growth row');
});
check('no stub: a full first year from the prior year-end', () => {
  const s = spec();
  delete s.stub;
  s.opening.date = '2025-12-31';
  for (const t of s.debt) if (t.id === 'ddtl') t.maturity = '2028-12';
  const r = M.project(s, {});
  assert(!r.error, r.error); eq(r.warnings, []);
  eq(r.rows.proj_frac, [1, 1, 1, 1, 1]);
  near(r.rows.revenue[0], 1500, 'revenue'); near(r.rows.interest_by_tranche['term-loan'][0], 1000 * 0.07, 'TL full year');
  near(r.rows.da[0], 3000 / 6 + 900 / 6 / 2, 'da');
  eq(r.rows.interest_actual, [0, 0, 0, 0, 0]);
});
check('stub without prior revenue: annualised fallback with a warning', () => {
  const s = spec(); delete s.prior;
  const r = M.project(s, {});
  assert(!r.error);
  near(r.rows.revenue[0], 1400 * 1.5, 'annualised H1 x growth');
  assert(r.warnings.some(w => w.includes('annualised')));
});

// ---- funding gap + dilution ----
check('funding gap split by equity_funding_share; equity at price x (1 - discount)', () => {
  const R = BASE.rows;
  assert(R.funding_gap[0] > 0, 'fixture has a stub-year gap');
  for (let i = 0; i < N; i++) {
    near(R.new_equity_m[i], 0.25 * R.funding_gap[i], `equity share ${Y[i]}`);
    near(R.new_debt[i], 0.75 * R.funding_gap[i], `debt share ${Y[i]}`, 1e-6);
    near(R.new_shares[i], R.new_equity_m[i] / (20 * 0.9), `shares at issue price ${Y[i]}`);
    if (R.funding_gap[i] > 0) near(R.cash_end[i], 200, `cash lands on min_cash ${Y[i]}`);
  }
  const allDebt = run({ equity_funding_share: 0 }).rows, allEq = run({ equity_funding_share: 100 }).rows;
  eq(allDebt.new_shares.every(x => x === 0), true);
  eq(allEq.new_debt.every(x => x === 0), true);
  near(allEq.new_shares[0], allEq.funding_gap[0] / 18, 'all-equity shares');
  assert(run({ issue_discount: 40 }).rows.new_shares[0] > R.new_shares[0], 'deeper discount, more shares');
  assert(run({ min_cash: 1000 }).rows.funding_gap[0] > R.funding_gap[0], 'higher min cash, bigger gap');
});
check('funding fixed point: gap covers its own new-debt interest', () => {
  const R = BASE.rows;
  const intNew = R.interest_by_tranche[M.NEW_DEBT_ID][0];
  near(intNew, 0.10 * R.new_debt[0] / 2 * 0.5, 'consistent at the fixed point', 1e-8);
});

// ---- valuation ----
check('valuation: exit EV on exit-year EBITDA, balance sheet at valuation date, discounted to asof', () => {
  const V = BASE.valuation, R = BASE.rows;
  eq(V.exit_year, 2028); eq(V.balance_sheet_year, 2027); eq(V.valuation_date, '2027-12-31');
  near(V.exit_ev, 10 * at(BASE, 'ebitda', 2028), 'ev');
  near(V.exit_net_debt, at(BASE, 'net_debt', 2027), 'nd at YE27');
  near(V.exit_shares, at(BASE, 'shares_end', 2027), 'shares at YE27');
  const yrs = (Date.UTC(2027, 11, 31) - Date.UTC(2026, 9, 18)) / (365.25 * 864e5);
  near(V.value_per_share, (V.exit_ev - V.exit_net_debt) / V.exit_shares / Math.pow(1.15, yrs), 'vps');
  near(V.upside_pct, (V.value_per_share / 20 - 1) * 100, 'upside');
  const ev0 = 20 * 100 + (1000 + 500 + 600 - 300);
  near(V.ev_now, ev0, 'EV now');
  near(R.ev_ebitda[1], ev0 / R.ebitda[1], 'ev/ebitda at price'); near(R.pe[2], 20 / R.eps[2], 'pe at price');
  near(V.implied_multiples_at_value.ev_ebitda[2], (V.value_per_share * 100 + 1800) / R.ebitda[2], 'multiple at value');
  const s = spec(); s.valuation.net_debt_at = 'exit_year_end';
  near(M.project(s, {}).valuation.exit_net_debt, at(BASE, 'net_debt', 2028), 'exit_year_end option');
});
check('valuation floors at 0 when debt exceeds EV', () => {
  const r = run({ exit_ev_ebitda: 2, revenue_growth: -40 });
  eq(r.valuation.value_per_share, 0);
  assert(r.warnings.some(w => w.includes('exit equity')));
});
check('checks: pass / miss against calibration targets', () => {
  eq(BASE.checks.map(c => [c.metric, c.year, c.pass]), [['revenue', 2026, true], ['capex', 2027, false]]);
  near(BASE.checks[0].value, 1500);
});

// ---- tornado + grid ----
check('tornado: sorted by swing, every driver low/high honoured and recomputable', () => {
  const t = M.sensitivity(FIX, {}, { metric: 'value_per_share' });
  assert(!t.error, t.error);
  const ds = M.drivers(FIX).filter(d => typeof d.low === 'number' && typeof d.high === 'number');
  eq(t.bars.length, ds.length);
  near(t.base, BASE.valuation.value_per_share, 'base');
  for (let i = 1; i < t.bars.length; i++) assert(t.bars[i - 1].swing >= t.bars[i].swing, 'sorted');
  for (const b of t.bars) {
    const d = ds.find(x => x.id === b.id);
    eq([b.low, b.high], [d.low, d.high], b.id);
    near(b.v_low, run({ [b.id]: d.low }).valuation.value_per_share, `${b.id} low`);
    near(b.v_high, run({ [b.id]: d.high }).valuation.value_per_share, `${b.id} high`);
    near(b.swing, Math.abs(b.v_high - b.v_low), `${b.id} swing`);
  }
  for (const m of ['net_income', 'interest', 'ebitda', 'net_debt_ebitda', 'fcf']) {
    const r = M.sensitivity(FIX, { sofr_shift: 50 }, { metric: m, year: 2027 });
    assert(!r.error && r.year === 2027 && r.bars.length, m);
    near(r.base, at(run({ sofr_shift: 50 }), m, 2027), `${m} base`);
  }
  eq(M.sensitivity(FIX, {}, { metric: 'interest@2028' }).year, 2028);
  const ir = M.sensitivity(FIX, {}, { metric: 'interest', year: 2027 });
  near(ir.bars.find(b => b.id === 'sofr_shift').v_high, at(run({ sofr_shift: 200 }), 'interest', 2027), 'interest tornado');
  eq(ir.bars.find(b => b.id === 'exit_ev_ebitda').swing, 0, 'valuation drivers do not move interest');
  assert(M.sensitivity(FIX, {}, { metric: 'nope' }).error);
});
check('grid: shape, axis clamping and values', () => {
  const xs = [-100, 0, 100, 200], ys = [6, 8, 10];
  const g = M.grid(FIX, {}, 'sofr_shift', xs, 'exit_ev_ebitda', ys, 'value_per_share');
  assert(!g.error, g.error);
  eq(g.z.length, 3); assert(g.z.every(r => r.length === 4));
  eq(g.x.values, xs); eq(g.y.values, ys);
  near(g.z[2][3], run({ sofr_shift: 200, exit_ev_ebitda: 10 }).valuation.value_per_share, 'cell');
  const c = M.grid(FIX, {}, 'sofr_shift', [9999, NaN, 'x'], 'useful_life', [1], { metric: 'ebit', year: 2027 });
  eq(c.x.values, [500]); eq(c.y.values, [2]); eq(c.year, 2027);
  assert(M.grid(FIX, {}, 'nope', [1], 'useful_life', [4], 'value_per_share').error);
  assert(M.grid(FIX, {}, 'sofr_shift', [], 'useful_life', [4], 'value_per_share').error);
});

// ---- scenarios ----
check('applyScenario / matchScenario', () => {
  const bear = M.applyScenario(FIX, 'bear');
  eq(bear, { revenue_growth: -10, cost_of_revenue_pct: 3, sofr_shift: 100, spread_shift: 200, exit_ev_ebitda: 7 });
  const rb = run(bear);
  assert(rb.valuation.value_per_share < BASE.valuation.value_per_share);
  eq(M.applyScenario(FIX, 'base'), {});
  eq(M.applyScenario(FIX, 'bull', { useful_life: 5 }), { useful_life: 5, revenue_growth: 8, opex_pct: -1.5, exit_ev_ebitda: 12 });
  eq(M.applyScenario(FIX, 'nope'), null); eq(M.applyScenario(FIX, '__proto__'), null);
  eq(M.matchScenario(FIX, bear), 'bear'); eq(M.matchScenario(FIX, {}), 'base');
  eq(M.matchScenario(FIX, { sofr_shift: 25 }), null);
  const s = spec(); s.scenarios[1].values = { sofr_shift: 9999, nope: 1, tax_rate: 'x' };
  eq(M.applyScenario(s, 'bear'), { sofr_shift: 500 }, 'scenario values clamp, junk dropped');
});

// ---- state codec ----
check('encode/decode round trip; defaults encode to empty', () => {
  eq(M.encodeState(FIX, {}), '');
  eq(M.encodeState(FIX, { sofr_shift: 0, exit_ev_ebitda: 10 }), '', 'values at base are not encoded');
  const ov = { sofr_shift: 150, useful_life: 4.5, exit_ev_ebitda: 7.5 };
  const s = M.encodeState(FIX, ov);
  assert(/^[A-Za-z0-9_-]+$/.test(s) && s.length < 200, s);
  const d = M.decodeState(FIX, s);
  assert(d.ok); eq(d.errors, []); eq(d.overrides, ov);
  eq(M.decodeState(FIX, '').overrides, {});
});
check('decodeState rejects / clamps hostile input and never pollutes prototypes', () => {
  const enc = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  for (const bad of [null, 42, {}, [], 'not base64 !!', '%%%', 'x'.repeat(5000), enc([1, 2]), enc({ v: 2, m: 'fxr', o: {} }),
    enc({ v: 1, m: 'fxr', o: [] }), enc('str'), Buffer.from('{"v":1,').toString('base64url')]) {
    const r = M.decodeState(FIX, bad);
    if (bad === null) { assert(r.ok); continue; }
    eq(r.ok, false, `accepted ${String(bad).slice(0, 30)}`); eq(r.overrides, {});
  }
  eq(M.decodeState(FIX, enc({ v: 1, m: 'crwv', o: { sofr_shift: 100 } })).ok, false, 'other model\'s link');
  const raw = '{"v":1,"m":"fxr","o":{"__proto__":{"polluted":1},"constructor":5,"toString":1,"sofr_shift":9999,' +
    '"useful_life":"4","tax_rate":null,"nope":1,"exit_ev_ebitda":-5,"capex":1e308}}';
  const r = M.decodeState(FIX, Buffer.from(raw).toString('base64url'));
  assert(r.ok);
  eq(r.overrides, { sofr_shift: 500, exit_ev_ebitda: 2, capex: 60 }, 'known numeric ids only, clamped');
  eq(Object.getPrototypeOf(r.overrides), Object.prototype);
  eq(({}).polluted, undefined); eq(Object.prototype.polluted, undefined);
  assert(r.errors.some(e => e.includes('unknown driver __proto__')) && r.errors.some(e => e.includes('useful_life is not a number')));
  const many = {}; for (let i = 0; i < 500; i++) many['k' + i] = i;
  assert(M.decodeState(FIX, enc({ v: 1, m: 'fxr', o: many })).errors.length <= 64, 'key cap');
  const o2 = JSON.parse('{"__proto__":{"x":1},"sofr_shift":50}');
  eq(M.encodeState(FIX, o2), M.encodeState(FIX, { sofr_shift: 50 }), 'encode ignores junk keys');
  eq(M.project(FIX, o2).overrides, { sofr_shift: 50 });
  eq(({}).x, undefined);
});
check('project: overrides are sanitised (unknown, NaN, Infinity, strings, out of range)', () => {
  const r = M.project(FIX, { sofr_shift: NaN, useful_life: Infinity, tax_rate: '30', exit_ev_ebitda: 1e9, nope: 3 });
  assert(!r.error);
  eq(r.overrides, { exit_ev_ebitda: 30 });
  assert(r.warnings.length >= 4);
  for (const ov of [null, undefined, 5, 'x', [1, 2]]) assert(!M.project(FIX, ov).error);
});

// ---- robustness ----
check('never throws on malformed specs; returns {error}', () => {
  const bads = [null, undefined, 0, 'x', [], {}, { v: 1 }, { v: 1, template: 'levered_growth_v1' },
    Object.assign(spec(), { years: 'abc' }), Object.assign(spec(), { years: [2026, 2028] }), Object.assign(spec(), { opening: null }),
    Object.assign(spec(), { debt: [{ id: '__proto__', balance: 1 }] }), Object.assign(spec(), { debt: 'x' }),
    Object.assign(spec(), { drivers: [null, 1, 'x', { id: 'revenue_growth', path: 'x' }] }), Object.assign(spec(), { template: '__proto__' }),
    Object.assign(spec(), { rates: null }), Object.assign(spec(), { stub: { year: 2026, actual_months: 99 } })];
  for (const b of bads) {
    let r, t, g;
    assert.doesNotThrow(() => { r = M.project(b, {}); t = M.sensitivity(b, {}, {}); g = M.grid(b, {}, 'sofr_shift', [0], 'useful_life', [6]); });
    assert(r && typeof r.error === 'string' && r.error, `no error for ${JSON.stringify(b && b.years)}`);
    assert(t.error && g.error);
    eq(M.validateSpec(b).ok, false);
    assert.doesNotThrow(() => { M.drivers(b); M.encodeState(b, {}); M.decodeState(b, 'abc'); M.applyScenario(b, 'base'); M.matchScenario(b, {}); });
  }
});
check('fuzz: mutated specs never throw and stay finite-or-null', () => {
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const junk = [null, -1, 0, 1e12, -1e12, NaN, 'x', [], {}, true, '2026-13', 1e-300];
  const paths = [];
  (function walk(o, p) {
    for (const k of Object.keys(o)) { paths.push(p.concat([k])); if (o[k] && typeof o[k] === 'object') walk(o[k], p.concat([k])); }
  })(FIX, []);
  for (let n = 0; n < 400; n++) {
    const s = spec();
    for (let m = 0; m < 3; m++) {
      const p = paths[Math.floor(rnd() * paths.length)];
      let o = s;
      for (const k of p.slice(0, -1)) o = o && typeof o === 'object' ? o[k] : undefined;
      if (o && typeof o === 'object') o[p[p.length - 1]] = junk[Math.floor(rnd() * junk.length)];
    }
    let r;
    assert.doesNotThrow(() => { r = M.project(s, { sofr_shift: 100 }); }, `mutation ${n}`);
    if (!r.error) allFinite(r, `mutation ${n}`);
  }
});
check('all outputs finite-or-null on extreme slider settings', () => {
  const t = M.template('levered_growth_v1');
  for (const pick of ['min', 'max']) {
    const ov = {};
    for (const d of M.drivers(FIX)) ov[d.id] = d[pick];
    const r = M.project(FIX, ov);
    assert(!r.error); allFinite(r, pick);
  }
  assert(t);
});
check('determinism: identical inputs, identical output', () => {
  const a = JSON.stringify(M.project(FIX, { sofr_shift: 75, capex: 10 }));
  const b = JSON.stringify(M.project(spec(), { capex: 10, sofr_shift: 75 }));
  eq(a, b);
  eq(JSON.stringify(M.sensitivity(FIX, {}, {})), JSON.stringify(M.sensitivity(FIX, {}, {})));
  eq(JSON.stringify(FIX), JSON.stringify(spec()), 'engine does not mutate the spec');
});
check('performance: full tornado (~18 drivers) < 50 ms', () => {
  M.sensitivity(FIX, {}, {});
  const times = [];
  for (let i = 0; i < 7; i++) { const t0 = process.hrtime.bigint(); M.sensitivity(FIX, { sofr_shift: 50 }, {}); times.push(Number(process.hrtime.bigint() - t0) / 1e6); }
  times.sort((a, b) => a - b);
  assert(times[3] < 50, `median ${times[3].toFixed(1)} ms`);
  console.log(`  tornado median ${times[3].toFixed(2)} ms`);
});
check('formatValue', () => {
  eq(M.formatValue(1234.5, 'US$m', 0), '1,235m'); eq(M.formatValue(4.25, '%', 1), '4.3%');
  eq(M.formatValue(25, 'bp', 0, true), '+25 bp'); eq(M.formatValue(7, 'x', 1), '7.0x');
  eq(M.formatValue(61.39, 'US$', 2), 'US$61.39'); eq(M.formatValue(null, '%'), '—'); eq(M.formatValue(NaN, 'x'), '—');
});

// ---- browser (UMD) load path ----
check('browser: window.ModelEngine and no other global', () => {
  const src = fs.readFileSync(ENGINE_PATH, 'utf8');
  const win = { btoa: s => Buffer.from(s, 'binary').toString('base64'), atob: s => Buffer.from(s, 'base64').toString('binary') };
  win.self = win;
  const ctx = vm.createContext(Object.assign(win, { unescape, escape, encodeURIComponent, decodeURIComponent }));
  const before = new Set(Object.keys(ctx));
  vm.runInContext(src, ctx);
  eq(Object.keys(ctx).filter(k => !before.has(k)), ['ModelEngine']);
  const E = ctx.ModelEngine;
  const r = E.project(FIX, { sofr_shift: 100 });
  near(r.valuation.value_per_share, run({ sofr_shift: 100 }).valuation.value_per_share, 'same answer in the browser');
  const s = E.encodeState(FIX, { sofr_shift: 100 });
  eq(s, M.encodeState(FIX, { sofr_shift: 100 }), 'btoa path == Buffer path');
  eq(JSON.stringify(E.decodeState(FIX, s).overrides), '{"sofr_shift":100}');
});

setImmediate(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
