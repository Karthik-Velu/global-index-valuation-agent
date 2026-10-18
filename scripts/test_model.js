#!/usr/bin/env node
// Model engine tests (Node, zero dependencies) for dashboard/model-engine.js against the
// synthetic Fixture Corp spec (tests/fixtures/models/fxr.json): accounting identities,
// hand-computed interest, rate pass-through (contractual margins never move with spreads),
// rate paths, committed facilities, schedules / issuance / fees, monotonicity, the stub
// year, depreciation (CIP, lag, re-spread book value), revenue following capex, funding-gap
// dilution, the cost-of-capital re-rating, convertible dilution, covenants, funded-EV
// multiples, tornado / grid / breakevens / scenarios and their weighted value, the
// share-link codec under hostile input, never-throw on malformed specs, determinism, speed
// and the browser (UMD) load path. The published CoreWeave model's calibration is pinned
// at the end (checks, presets, the interest stress).
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
    assert(['shift_pp', 'shift_bp', 'scale_pct', 'scalar', 'choice'].includes(d.kind), `${d.id}: kind`);
    assert(['pp', 'bp', '%', 'x', 'yrs', 'US$', 'US$m', 'path'].includes(d.unit), `${d.id}: unit`);
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
  // time-weighted balance: 100 -> 0 over Jan-Jun 2029, nothing after (avg 25 over the year)
  near(I.ddtl[3], 100 / 2 * 0.5 * 0.07, 'ddtl 2029 final half-year of amortisation');
  near(Rt['term-loan'][1], 6.5, 'rate_by_tranche %');
  const nd = BASE.rows.new_debt;
  near(I[M.NEW_DEBT_ID][0], 0.10 * nd[0] / 2 * 0.5, 'new debt: half-year convention in the stub');
  near(I[M.NEW_DEBT_ID][1], 0.10 * (nd[0] + nd[0] + nd[1]) / 2, 'new debt 2027 on average pool');
});
check('floating tranches move 1:1 with sofr_shift; spread_shift moves only new and refinanced debt', () => {
  const up = run({ sofr_shift: 100 }).rows.interest_by_tranche, sp = run({ spread_shift: 100 }).rows.interest_by_tranche;
  const b = BASE.rows.interest_by_tranche;
  near(up['term-loan'][1] - b['term-loan'][1], 1000 * 0.01, 'TL +1% x 1000');
  near(up['term-loan'][0] - b['term-loan'][0], 1000 * 0.01 * 0.5, 'TL stub half-year');
  near(up.ddtl[1] - b.ddtl[1], (500 + 300) / 2 * 0.01, 'ddtl +1% on avg balance');
  near(sp['term-loan'][1], b['term-loan'][1], 'contractual margin: spread shift does not touch it');
  near(sp.ddtl[1], b.ddtl[1], 'contractual margin (ddtl)');
  for (const S of [up, sp]) {
    near(S['notes-2028'][0], b['notes-2028'][0], 'fixed unchanged (stub)');
    near(S['notes-2028'][1], b['notes-2028'][1], 'fixed unchanged (2027)');
    near(S['notes-2028'][3] - b['notes-2028'][3], 500 * 0.01, 'refinanced notes now reprice');
    assert(S[M.NEW_DEBT_ID][1] > b[M.NEW_DEBT_ID][1], 'new debt reprices');
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
check('opening.dep_base: existing assets depreciate on it (not gross PP&E); default = gross less CIP', () => {
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
  // funded EV: price x shares + net debt at the end of the year before (opening for the stub)
  near(R.ev_ebitda[0], ev0 / R.ebitda[0], 'first year: today\'s EV');
  near(R.ev_ebitda[1], (20 * R.shares_end[0] + R.net_debt[0]) / R.ebitda[1], 'ev/ebitda at price, funded');
  near(R.ev_ebitda_static[1], ev0 / R.ebitda[1], 'static EV row kept, labelled');
  near(R.pe[2], 20 / R.eps[2], 'pe at price');
  near(V.implied_multiples_at_value.ev_ebitda[2], V.exit_multiple_eff, 'at value, the exit year reproduces the exit multiple');
  near(V.implied_multiples_at_value.ev_ebitda[1], (V.exit_value_per_share * R.shares_end[0] + R.net_debt[0]) / R.ebitda[1], 'at value, FY27');
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

// ---- debt mechanics: schedules, issuance, fees, committed facilities ----
check('schedule amortisation: per-year principal, spread inside each year; the balance follows', () => {
  const s = spec(); const t = s.debt.find(x => x.id === 'ddtl');
  t.amort = 'schedule'; t.schedule = { 2026: 300, 2027: 200, 2028: 100 };
  const r = M.project(s, {}); assert(!r.error, r.error); eq(r.warnings, []);
  const D = r.rows.debt_by_tranche.ddtl;
  eq(D.map(x => Math.round(x)), [300, 100, 0, 0, 0]);
  eq(r.rows.repayments.map(x => Math.round(x)), [300, 200, 100, 0, 0]);
  near(r.rows.interest_by_tranche.ddtl[0], (600 + 300) / 2 * 0.08 * 0.5, 'H2-26 on the time-weighted balance');
});
check('issued tranches: zero before the date, issue cash in that period, fee_bp is non-cash', () => {
  const s = spec();
  s.debt.push({ id: 'conv', name: 'Convert', balance: 400, kind: 'fixed', coupon_pct: 2, fee_bp: 50, maturity: '2031-06', amort: 'bullet',
    issued: '2026-10-01', issue_cash: 350, issue_equity: -30, secured: false, recourse: true, src: ['s1'] });
  const r = M.project(s, {}), b = BASE.rows; assert(!r.error, r.error); eq(r.warnings, []);
  near(r.rows.issued[0], 400, 'principal issued in H2-26'); eq(r.rows.issued.slice(1), [0, 0, 0, 0]);
  near(r.rows.interest_by_tranche.conv[0], 400 * 0.025 * 3 / 12, 'Oct-Dec only, coupon + fee');
  near(r.rows.interest_by_tranche.conv[1], 400 * 0.025, 'full year');
  near(r.rows.interest_noncash[1] - b.interest_noncash[1], 400 * 0.005, 'fee is the non-cash part');
  near(r.rows.debt_end[1] - r.rows.debt_by_tranche.conv[1], r.rows.debt_end[1] - 400, 'balance 400');
  // OCF adds the fee back: ΔOCF = ΔNI + Δnon-cash interest
  const dNi = r.rows.net_income[2] - b.net_income[2], dOcf = r.rows.ocf[2] - b.ocf[2];
  near(dOcf - dNi, 400 * 0.005, 'fee added back in operating cash flow');
  near(r.rows.book_equity[0] - b.book_equity[0], -30 + (r.rows.net_income[0] - b.net_income[0]) + (r.rows.new_equity_m[0] - b.new_equity_m[0]),
    'issue_equity hits book equity');
  near(r.valuation.net_debt_now, BASE.valuation.net_debt_now, 'not in today\'s net debt');
});
check('committed facilities: drawn first at their own terms while open, then new debt', () => {
  const s = spec();
  s.funding = { new_debt_secured_pct: 50, committed: [
    { id: 'rcf', name: 'RCF', amount: 150, kind: 'floating', spread_bp: 200, fee_bp: 25, available_until: '2027-06', maturity: '2030-06', secured: true, src: ['s1'] }] };
  const r = M.project(s, {}); assert(!r.error, r.error); eq(r.warnings, []);
  const R = r.rows;
  near(R.committed_draws[0], Math.min(150, R.new_debt[0]), 'H2-26 draws the facility first');
  near(R.uncommitted_debt[0], R.new_debt[0] - R.committed_draws[0], 'the rest is new debt');
  const used = R.committed_draws[0];
  near(R.interest_by_tranche.rcf[0], (0.04 + 0.02 + 0.0025) * used / 2 * 0.5, 'half-year convention at SOFR + spread + fee');
  near(R.debt_by_tranche.rcf[1], used + R.committed_draws[1], 'drawn balance carries');
  if (used >= 150 - 1e-9) eq(R.committed_draws.slice(1).every(x => x === 0), true, 'exhausted');
  eq(R.committed_draws[2], 0, 'window closed after Jun 2027');
  near(R.uncommitted_cum[4], R.funding_cum[4] - R.committed_draws.reduce((a, b) => a + b, 0), 'uncommitted = all funding - committed draws');
  const sec = R.secured_debt[1];
  near(sec, R.debt_by_tranche['term-loan'][1] + R.debt_by_tranche.ddtl[1] + R.debt_by_tranche.rcf[1] + 0.5 * R.debt_by_tranche[M.NEW_DEBT_ID][1], 'secured debt');
  // a spread shift leaves the facility's contractual margin alone
  near(M.project(s, { spread_shift: 200 }).rows.rate_by_tranche.rcf[0], R.rate_by_tranche.rcf[0], 'contractual');
});

// ---- rates: paths, the new-debt link, shift timing ----
function rateSpec() {
  const s = spec();
  s.rates.alt_paths = [{ id: 'low', name: 'Low path', path: { 2026: 4.0, 2027: 2.5, 2028: 2.25, 2029: 2.0, 2030: 2.0 }, note: 'test', src: ['s2'] }];
  s.rates.new_debt_ref_year = 2027;
  s.rates.shift_from = '2026-10';
  return s;
}
check('rate_path: a choice driver (index or id); floating debt and new debt follow the selected path', () => {
  const s = rateSpec(), d = M.drivers(s).find(x => x.id === 'rate_path');
  eq([d.kind, d.min, d.max, d.base], ['choice', 0, 1, 0]);
  eq(d.choices.map(x => x.id), ['base', 'low']);
  eq(M.ratePaths(s).map(x => x.path[1]), [3.5, 2.5]);
  const b = M.project(s, {}), lo = M.project(s, { rate_path: 'low' }), lo1 = M.project(s, { rate_path: 1 });
  eq(JSON.stringify(lo.rows), JSON.stringify(lo1.rows), 'id == index');
  near(lo.rows.sofr[1], 2.5, 'sofr row'); near(lo.rows.interest_by_tranche['term-loan'][1], 1000 * (0.025 + 0.03), 'floating on the path');
  near(b.rows.new_debt_rate[1], 10, 'reference year: new_debt_rate as set');
  near(b.rows.new_debt_rate[2], 10 - 0.25, 'base path 2028 is 25bp below 2027');
  near(lo.rows.new_debt_rate[1], 10 - 1.0, 'low path: 100bp below the base reference');
  near(M.project(s, { rate_path: 7 }).overrides.rate_path, 1, 'clamped to the last path');
  assert(M.project(s, { rate_path: 'nope' }).warnings.some(w => w.includes('unknown choice')));
});
check('shift_from: realised months keep the path; shifts start at the month given', () => {
  const s = rateSpec(), b = M.project(s, {}), up = M.project(s, { sofr_shift: 120, spread_shift: 60 });
  // H2-26 = Jul..Dec; shifts apply Oct..Dec = half the months
  near(up.rows.sofr[0] - b.rows.sofr[0], 1.2 * 0.5, 'avg SOFR moves by half the shift');
  near(up.rows.interest_by_tranche['term-loan'][0] - b.rows.interest_by_tranche['term-loan'][0], 1000 * 0.012 * 3 / 12, 'Oct-Dec only');
  near(up.rows.new_debt_rate[0] - b.rows.new_debt_rate[0], (1.2 + 0.6) * 0.5, 'new-debt rate: weighted by months');
  near(up.rows.new_debt_rate[1] - b.rows.new_debt_rate[1], 1.8, 'full shift from 2027');
});
check('without new_debt_ref_year the new-debt rate is flat (back-compatible)', () => {
  eq(BASE.rows.new_debt_rate, [10, 10, 10, 10, 10]);
});

// ---- depreciation and revenue capacity ----
check('CIP and in-service lag: CIP is a vintage; new capex depreciates from mid-period + lag', () => {
  const s = spec(); s.opening.cip = 300;
  const r = M.project(s, { in_service_lag: 0.5 }); assert(!r.error, r.error); eq(r.warnings, []);
  const life = 6, R = r.rows;
  // existing book value = net - cip = 1700 at the base rate (gross - cip) / life = 450
  near(R.da_existing[0], (3000 - 300) / life * 0.5, 'existing H2-26');
  near(R.da_new[0], 300 / life * 0.5, 'CIP from the opening date; H2 capex not yet in service');
  near(R.da_new[1], 300 / life + 500 / life * 0.75, 'H2-26 capex in service from Apr 2027');
});
check('useful life re-spreads book value and never depreciates more than exists', () => {
  const s = spec(); s.opening.dep_nbv = 1500; s.opening.dep_rate = 300;
  const r3 = M.project(s, { useful_life: 3 }).rows, r6 = M.project(s, {}).rows;
  near(r6.da_existing[1], 300, 'base life: dep_rate'); near(r3.da_existing[1], 600, 'half the life, twice the rate');
  near(r3.da_existing.reduce((a, b) => a + b, 0), 1500, 'capped at the book value');
  assert(r6.da_existing.reduce((a, b) => a + b, 0) <= 1500 + 1e-9);
});
check('capex_revenue_link: revenue follows in-service capacity; 0 = ignores capex', () => {
  const b = run({ capex_revenue_link: 100 }), lo = run({ capex_revenue_link: 100, capex: -30 }), off = run({ capex: -30 });
  eq(b.rows.capacity_mult.every(x => Math.abs(x - 1) < 1e-12), true, 'base capex: multiplier 1');
  for (let i = 1; i < N; i++) assert(lo.rows.revenue[i] < b.rows.revenue[i], `less capex, less revenue ${Y[i]}`);
  eq(off.rows.revenue, BASE.rows.revenue, 'link off: revenue unchanged');
  assert(lo.rows.capacity_mult[4] < lo.rows.capacity_mult[1], 'the effect builds as vintages enter service');
});
check('stub_weight 0 keeps the stub year on its path', () => {
  const s = spec(); s.drivers.find(d => d.id === 'revenue_growth').stub_weight = 0;
  const r = M.project(s, { revenue_growth: -10 });
  near(r.rows.revenue[0], BASE.rows.revenue[0], 'FY2026 unchanged');
  near(r.rows.revenue[1], BASE.rows.revenue[0] * 1.30, 'FY2027 from the unchanged base, at 40 - 10');
});
check('min_tax floor and SBC paid in shares', () => {
  const r = run({ min_tax: 20, sbc_share_pct: 100 }).rows;
  for (let i = 0; i < N; i++) assert(r.tax[i] >= 20 * r.proj_frac[i] - 1e-9, `tax floor ${Y[i]}`);
  near(r.sbc_shares[1], r.sbc[1] / 20, 'SBC / share price');
  near(r.shares_end[1], r.shares_end[0] * 1.01 + r.new_shares[1] + r.sbc_shares[1], 'shares roll with SBC shares');
});

// ---- valuation extensions ----
check('rate_link: the multiple re-rates with the cost of debt and equity; 1 at the defaults', () => {
  const s = spec(); s.valuation.rate_link = { debt_weight: 0.5, growth_pct: 4 };
  const b = M.project(s, {}).valuation;
  near(b.rate_adjustment, 1, 'defaults'); near(b.exit_multiple_eff, 10, 'effective = set');
  const up = M.project(s, { sofr_shift: 100 }).valuation;
  // WACC0 = .5 x 10 + .5 x 15 = 12.5; +100bp on debt -> 13.0; (12.5 - 4) / (13 - 4)
  near(up.rate_adjustment, 8.5 / 9, 'debt +100bp'); near(up.exit_multiple_eff, 10 * 8.5 / 9, 'effective multiple');
  near(M.project(s, { discount_rate: 17 }).valuation.rate_adjustment, 8.5 / 9.5, 'cost of equity +2pp');
  assert(up.value_per_share < b.value_per_share);
});
check('convertibles: net shares above the cap at the exit price; none below it', () => {
  const s = spec();
  s.debt.push({ id: 'cv', name: 'Convert', balance: 300, kind: 'fixed', coupon_pct: 1, maturity: '2031-06', amort: 'bullet',
    conv_price: 10, cap_price: 15, secured: false, recourse: true, src: ['s1'] });
  const r = M.project(s, { exit_ev_ebitda: 14 }).valuation; assert(r.exit_value_per_share > 15, String(r.exit_value_per_share));
  const P = r.exit_value_per_share;
  near(P * (r.exit_shares + r.conv_shares), r.exit_equity, 'equity = price x (shares + net conversion shares)', 1e-6);
  near(r.conv_shares, 300 / 10 * (P - 15) / P, 'net shares above the cap');
  s.debt[s.debt.length - 1].cap_price = 1000;
  const lo = M.project(s, { exit_ev_ebitda: 14 }).valuation;
  assert(lo.exit_value_per_share < 1000, String(lo.exit_value_per_share)); eq(lo.conv_shares, 0, 'below the cap: no dilution');
});
check('covenants: per-year values, breaches and the first breach year; warnings', () => {
  const s = spec();
  s.covenants = [{ id: 'lev', label: 'Leverage', metric: 'gross_debt_ebitda', max: 3, kind: 'covenant', src: ['s1'] },
    { id: 'cov', label: 'Cover', metric: 'interest_cover', min: 50, kind: 'threshold' }];
  const r = M.project(s, {}); assert(!r.error, r.error);
  const [lev, cv] = r.covenants;
  eq(lev.values, r.rows.gross_debt_ebitda);
  eq(lev.breach, lev.values.map(v => v > 3));
  eq(lev.first_breach, lev.breach.indexOf(true) >= 0 ? Y[lev.breach.indexOf(true)] : null);
  eq(cv.breach.every(Boolean), true); eq(cv.first_breach, 2026);
  assert(r.warnings.some(w => w.includes('threshold Cover: crossed in FY2026')));
});

// ---- breakevens + weighted value ----
check('solve: driver value where the metric hits a target (bisection), null when it never does', () => {
  const V0 = BASE.valuation.value_per_share;
  const r = M.solve(FIX, {}, 'exit_ev_ebitda', 'value_per_share', 20);
  assert(!r.error && r.found, JSON.stringify(r));
  near(run({ exit_ev_ebitda: r.value }).valuation.value_per_share, 20, 'solves', 1e-3);
  near(r.at_current, V0, 'value at the current setting');
  const g = M.solve(FIX, {}, 'revenue_growth', 'gross_debt_ebitda@2027', 4);
  if (g.found) near(at(run({ revenue_growth: g.value }), 'gross_debt_ebitda', 2027), 4, 'row metric', 1e-3);
  eq(M.solve(FIX, {}, 'exit_ev_ebitda', 'value_per_share', 1e9).found, false);
  assert(M.solve(FIX, {}, 'nope', 'value_per_share', 1).error && M.solve(FIX, {}, 'rate_path', 'value_per_share', 1).error);
});
check('weighted: probability-weighted value; the viewer\'s edits carry into every scenario', () => {
  const s = spec(); s.scenarios[0].prob = 50; s.scenarios[1].prob = 30; s.scenarios[2].prob = 20;
  const w = M.weighted(s, {}, 'base');
  const v = id => M.project(s, M.applyScenario(s, id)).valuation.value_per_share;
  near(w.value, 0.5 * v('base') + 0.3 * v('bear') + 0.2 * v('bull'), 'weights');
  eq(w.rows.map(r => r.id), ['base', 'bear', 'bull']);
  const w2 = M.weighted(s, { discount_rate: 20 }, 'base');
  near(w2.rows[1].value, M.project(s, Object.assign(M.applyScenario(s, 'bear'), { discount_rate: 20 })).valuation.value_per_share, 'delta on top');
  near(M.weighted(s, M.applyScenario(s, 'bear'), 'bear').value, w.value, 'anchored on the chip: no double count');
  eq(M.weighted(FIX, {}, 'base').value, null, 'no probabilities: no weighted value');
});
check('choice drivers travel as ids in the share link', () => {
  const s = rateSpec(), e = M.encodeState(s, { rate_path: 1 });
  eq(JSON.parse(Buffer.from(e, 'base64url').toString()).o, { rate_path: 'low' });
  eq(M.decodeState(s, e).overrides, { rate_path: 1 });
  const bad = Buffer.from(JSON.stringify({ v: 1, m: 'fxr', o: { rate_path: 'nope', sofr_shift: 'x' } })).toString('base64url');
  eq(M.decodeState(s, bad).overrides, {});
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

// ---- the published CoreWeave model (dashboard/reports/models/crwv.json) ----
const CRWV_PATH = path.join(ROOT, 'dashboard', 'reports', 'models', 'crwv.json');
if (fs.existsSync(CRWV_PATH)) {
  const C = JSON.parse(fs.readFileSync(CRWV_PATH, 'utf8'));
  const cr = ov => { const r = M.project(C, ov || {}); assert(!r.error, r.error); return r; };
  check('crwv: base passes the FY2026 guidance checks; the FY2028 consensus gap shows as a miss', () => {
    const r = cr(), byKey = Object.fromEntries(r.checks.map(c => [`${c.metric}@${c.year}`, c.pass]));
    for (const k of ['revenue@2026', 'capex@2026', 'adj_op_income@2026', 'interest@2026', 'ebitda@2026', 'revenue@2027', 'eps@2027'])
      eq(byKey[k], true, k);
    eq(byKey['net_income@2028'], false, 'FY28 net income below published estimates is visible');
    const q3 = (r.rows.interest[0] - C.stub.actuals.interest) / 2;
    assert(q3 >= 860 && q3 <= 940, `Q3 interest guide ${q3}`);
  });
  check('crwv: presets reproduce the report (bear ~US$5, bull above base, restructuring 0); FY2026 held at guidance', () => {
    const v = id => cr(M.applyScenario(C, id));
    const bear = v('bear'), bull = v('bull'), res = v('restructuring'), base = cr();
    assert(bear.valuation.value_per_share > 2 && bear.valuation.value_per_share < 10, String(bear.valuation.value_per_share));
    assert(bull.valuation.value_per_share > 1.8 * base.valuation.value_per_share);
    eq(res.valuation.value_per_share, 0);
    for (const r of [bear, bull]) { near(r.rows.revenue[0], base.rows.revenue[0], 'FY26 revenue'); near(r.rows.capex[0], base.rows.capex[0], 'FY26 capex'); }
    const w = M.weighted(C, {}, 'base');
    assert(w.value > 55 && w.value < 75, `weighted ${w.value}`);
  });
  check('crwv: the interest stress reaches value; SOFR moves new-debt cost; spreads do not touch existing margins', () => {
    const base = cr(), up = cr({ sofr_shift: 100 }), sp = cr({ spread_shift: 100 });
    assert(up.rows.interest[2] - base.rows.interest[2] > 600, 'FY28 interest +100bp');
    assert(base.valuation.value_per_share - up.valuation.value_per_share > 5, 'value responds to rates');
    for (const t of C.debt) near(sp.rows.interest_by_tranche[t.id][1], base.rows.interest_by_tranche[t.id][1], `${t.id} contractual`);
    const fed = cr({ rate_path: 'fed_sep' });
    near(fed.rows.interest[0], base.rows.interest[0], 'FY26 (realised) unchanged on the Fed path', 1e-2);
    assert(fed.rows.new_debt_rate[4] < base.rows.new_debt_rate[4] - 0.9, 'new debt follows the path gap by 2030');
  });
}

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
