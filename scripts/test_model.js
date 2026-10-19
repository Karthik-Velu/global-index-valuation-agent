#!/usr/bin/env node
// Model engine tests (Node, zero dependencies) for dashboard/model-engine.js against the
// synthetic Fixture Corp spec (tests/fixtures/models/fxr.json): accounting identities,
// hand-computed interest, rate pass-through (contractual margins never move with spreads),
// rate paths, committed facilities, schedules / issuance / fees, monotonicity, the stub
// year, depreciation (CIP, lag, re-spread book value), revenue following capex, funding-gap
// dilution, the cost-of-capital re-rating, convertible dilution, covenants, funded-EV
// multiples, tornado / grid / breakevens / scenarios and their weighted value, the
// share-link codec under hostile input, never-throw on malformed specs, determinism, speed
// and the browser (UMD) load path. MODEL v2 against the synthetic Fixture Capacity Corp
// (tests/fixtures/models/fxr_capacity.json): capacity_v1 revenue by hand (MW x price x
// billing, renewals, delays, extra MW), coupled capex and cost of revenue, the backlog and its
// warnings, customers / look-through / the backstop, every event impact, events on/off,
// eventImpact, events in the tornado, the exact and Monte Carlo distributions, fixed vs
// floating identities, hedges, the +100bp exposure, new-debt vintages and amortisation, the
// EBITDA -> FCF bridge, self-build, the watch list, the life readout, scenario event states,
// the v2 share link and speed. The published CoreWeave model's calibration is pinned at the
// end (checks, presets with their event states, the interest stress, the capacity path, fixed
// vs floating, the event catalogue and its distribution, the watch list, the Burry readout).
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
const sumA = a => a.reduce((x, y) => x + y, 0);
const isNumT = x => typeof x === 'number' && Number.isFinite(x);
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
    assert(['pp', 'bp', '%', 'x', 'yrs', 'US$', 'US$m', 'path', 'months', 'MW'].includes(d.unit), `${d.id}: unit`);
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
  check('crwv: presets (drivers + event states) reproduce the report (bear ~US$5, bull above base, restructuring 0); FY2026 held at guidance', () => {
    const v = id => { const s = M.scenarioState(C, id); const r = M.project(C, s.overrides, { events: s.events }); assert(!r.error, r.error); return r; };
    const bear = v('bear'), bull = v('bull'), res = v('restructuring'), base = cr();
    assert(bear.valuation.value_per_share > 5 && bear.valuation.value_per_share < 30, String(bear.valuation.value_per_share));
    assert(bull.valuation.value_per_share > 1.8 * base.valuation.value_per_share);
    eq(res.valuation.value_per_share, 0);
    for (const id of ['bear', 'bull', 'restructuring']) assert(Object.keys(M.scenarioState(C, id).events).length >= 5, `${id} names its business causes`);
    eq(Object.keys(M.scenarioState(C, 'base').events).length, 0, 'base = no events on');
    for (const r of [bear, bull, res]) { near(r.rows.revenue[0], base.rows.revenue[0], 'FY26 revenue'); near(r.rows.capex[0], base.rows.capex[0], 'FY26 capex'); }
    // one probability system: the presets carry no weights; the distribution places them
    eq(M.weighted(C, {}, 'base').value, null, 'no preset weights');
    for (const s of C.scenarios) assert(!('prob' in s), `${s.id}: no preset probability`);
    const d = M.distribution(C, {}, { metrics: ['value_per_share'] });
    eq(d.presets.map(p => p.id), ['base', 'bear', 'bull', 'restructuring']);
    near(sumA(d.presets.map(p => p.mass)), 1, 'preset masses add up', 1e-9);
    const pw = sumA(d.presets.map(p => p.mass * p.value)), mean = d.metrics.value_per_share.mean;
    assert(Math.abs(pw / mean - 1) < 0.1, `preset-weighted ${pw.toFixed(1)} within 10% of the distribution mean ${mean.toFixed(1)}`);
    const pc = Object.fromEntries(d.presets.map(p => [p.id, p.percentile]));
    assert(pc.restructuring < 10 && pc.bear < 20 && pc.base > 50 && pc.base < 90 && pc.bull > 95, JSON.stringify(pc));
  });
  check('crwv: capacity revenue on the guided path; fixed vs floating adds up; the swaps and DDTL 4.0 hedging cut the floating share', () => {
    const r = cr(), R = r.rows;
    eq(R.active_mw_end.map(Math.round), [1870, 3100, 4200, 5100, 6000]);
    for (let i = 0; i < 5; i++) {
      near(R.debt_fixed[i] + R.debt_floating[i] + R.debt_new_fixed[i] + R.debt_new_floating[i], R.debt_end[i], `debt split ${i}`, 1e-9);
      near(R.interest_fixed[i] + R.interest_floating[i] + R.interest_new[i] + (i ? 0 : C.stub.actuals.interest), R.interest[i], `interest split ${i}`, 1e-9);
    }
    assert(R.hedged_notional[0] > 2500, 'DDTL 3.0 / 5.0 swaps');
    assert(R.debt_floating[1] < R.debt_floating[0] * 0.7, 'DDTL 4.0 hedged from mid-2027');
    for (let i = 1; i < 5; i++) assert(R.floating_share_of_interest[i] < R.floating_share_of_interest[i - 1] + 1e-9, 'floating share of interest falls');
    for (let i = 2; i < 5; i++) assert(R.rate_exposure_100bp[i] > R.rate_exposure_100bp[i - 1], '+100bp grows with new debt');
    assert(R.backlog_coverage[1] > 90 && R.backlog_coverage[4] < 50, 'contracted covers 2027, not 2030');
  });
  check('crwv: the event catalogue, its distribution, the watch list and the Burry readout', () => {
    const E = M.events(C);
    assert(E.events.length >= 20 && E.events.some(e => e.kind === 'upside') && E.groups.every(g => g.prob_total <= 1 + 1e-9));
    for (const e of E.events) assert(e.indicators.length && e.src.length && e.mechanism.length > 80, e.id);
    for (const id of ['customer_turns_competitor', 'capital_markets_close', 'openai_rescope', 'inference_demand_durable', 'landlord_acquisition'])
      assert(E.events.some(e => e.id === id), id);
    const d = M.distribution(C, {});
    const v = d.metrics.value_per_share;
    eq(d.method, 'monte_carlo');
    assert(v.p10 < v.p50 && v.p50 < v.p90 && v.mean > 60 && v.mean < 140, JSON.stringify([v.p10, v.p50, v.p90, v.mean]));
    // a gap that cannot be borrowed defers builds (when_short "defer_build") instead of running cash below zero
    assert(d.p_liquidity_negative < 0.05, `P(liquidity < 0) ${d.p_liquidity_negative}`);
    const cm = M.eventImpact(C, {}, 'capital_markets_close');
    assert(Math.max(...cm.rows.mw_deferred.on) > 100 && cm.rows.active_mw_end.delta[1] < -100 && cm.value_per_share.delta < -10, 'closed markets defer MW');
    eq(d.regimes.map(r => r.id), ['boom', 'normal', 'bust']);
    assert(d.regimes[0].mean > d.regimes[1].mean && d.regimes[1].mean > d.regimes[2].mean, 'boom > normal > bust');
    for (const e of d.events) assert(Math.abs(e.p_on - e.prob) < 0.04, `${e.id}: marginal ${e.p_on} vs ${e.prob}`);
    const W = cr().watchlist;
    eq(W.map(w => w.id), ['backlog_concentration', 'openai_lookthrough', 'fcf_burn', 'interest_vs_ebitda', 'backlog_conversion', 'renewal_pricing', 'price_per_billing_mw', 'active_power', 'bookings']);
    for (const w of W) assert(w.latest && w.latest.src.length && (w.modelled ? w.values.some(isNumT) : w.values.every(x => x === null)), w.id);
    eq(W.filter(w => !w.modelled).map(w => w.id), ['backlog_conversion'], 'conversion is the company\'s measure, not a model output');
    const L = M.lifeReadout(C, {}, { lives: [6, 3] });
    assert(L.rows.net_income[1][2] < L.rows.net_income[0][2] - 10000, 'three-year life: much lower reported profit');
    near(L.rows.net_income[1][0], L.rows.net_income[0][0], 'FY2026 reported: the policy change is dated', 1e-6);
    near(L.value_per_share[1], L.value_per_share[0], 'the accounting life alone leaves value (on EBITDA) alone', 1e-6);
    // the economic life does reach value: run-off of the fleet, renewals to its end
    assert(L.value_per_share_economic[1] < L.value_per_share_economic[0] - 15, `economic: ${L.value_per_share_economic}`);
    const bu = M.scenarioState(C, 'burry_case'), rb = M.project(C, bu.overrides, { events: bu.events });
    assert(rb.valuation.life_adjustment < 0.95 && rb.valuation.value_per_share < cr().valuation.value_per_share - 15, 'the Burry case costs value');
  });
  check('crwv: run-rate valuation, the cross-checks, the economic-life link, LQA covenants', () => {
    const r = cr(), V = r.valuation, R = r.rows, xi = r.years.indexOf(V.balance_sheet_year);
    eq([V.ebitda_basis, V.exit_year, V.balance_sheet_year], ['run_rate', 2028, 2027]);
    near(V.exit_ebitda, V.exit_ebitda_run_rate); near(V.fleet_mw, R.active_mw_end[xi], 'the fleet in place at end-2027');
    near(V.life_adjustment, 1, 'base inputs: no life adjustment', 1e-9);
    assert(V.value_forward_basis > V.value_per_share, 'the forward basis adds the MW built in 2028');
    for (const k of ['value_forward_basis', 'value_last_year_exit', 'value_runoff']) assert(isNumT(V[k]) && V[k] >= 0, k);
    assert(V.runoff.ev > 0 && V.runoff.ev_ebitda > 0 && V.runoff.economic_life > 4, JSON.stringify(V.runoff));
    near(V.exit_multiple_eff, V.exit_multiple * V.rate_adjustment * V.life_adjustment, 'effective multiple', 1e-9);
    // run-rate leverage: year-end debt over Q4 EBITDA x 4
    for (let i = 0; i < 5; i++) {
      near(R.gross_debt_ebitda_lqa[i], R.debt_end[i] / R.ebitda_exit_rate[i], `LQA ${r.years[i]}`, 1e-9);
      near(R.secured_debt_ebitda_lqa[i], R.secured_debt[i] / R.ebitda_exit_rate[i], `secured LQA ${r.years[i]}`, 1e-9);
    }
    eq(r.covenants.filter(k => k.kind === 'covenant').map(k => k.metric), ['gross_debt_ebitda_lqa', 'secured_debt_ebitda_lqa']);
    // the shock start: from now (Nov 2026) or from Jan 2028
    const now = cr({ sofr_shift: 150 }), late = cr({ sofr_shift: 150, rate_shock_start: 'from_2028' });
    near(late.rows.interest[1], r.rows.interest[1], 'a 2028 shock leaves FY2027 alone', 1e-6);
    assert(now.rows.interest[1] > r.rows.interest[1] + 100 && late.rows.interest[2] > r.rows.interest[2] + 100 && late.rows.interest[2] < now.rows.interest[2] + 1e-6);
    // the next print: Q3 2026 against the revenue guide
    eq(r.quarters.slice(0, 2).map(q => q.quarter), ['2026-Q3', '2026-Q4']);
    near(r.quarters[0].revenue + r.quarters[1].revenue, R.revenue[0] - C.stub.actuals.revenue, 'H2 = Q3 + Q4', 1e-6);
  });
  check('crwv: spec text fits the engine caps (nothing truncated); debtMix matches the report callout', () => {
    const E = M.events(C);
    for (const e of C.events) {
      const x = E.events.find(y => y.id === e.id);
      eq([x.label, x.mechanism, x.prob_note || ''], [e.label, e.mechanism, e.prob_note || ''], `${e.id}: text kept whole`);
      if (e.short_label) assert(e.short_label.length <= 26, `${e.id} short_label`);
    }
    const D = M.drivers(C);
    for (const d of C.drivers) { const x = D.find(y => y.id === d.id); if (d.help) eq(x.help, d.help, `${d.id} help`); if (d.label) eq(x.label, d.label, `${d.id} label`); }
    const W = cr().watchlist;
    for (const w of C.watchlist) { const x = W.find(y => y.id === w.id); eq([x.label, x.note || '', (x.latest || {}).note || ''], [w.label, w.note || '', (w.latest || {}).note || ''], w.id); }
    const m = M.debtMix(C, {});
    assert(!m.error, m.error);
    near(m.fixed + m.floating, m.total, 'today adds up', 1e-9); near(m.fixed, m.coupon + m.swapped, 'fixed = coupons + swapped', 1e-9);
    near(m.total, sumA(C.debt.map(t => t.balance || 0)), 'every tranche at its opening balance', 1e-9);
    assert(m.floating_share > 20 && m.floating_share < 40 && m.interest_floating_share > m.floating_share, `floating today ${m.floating_share}`);
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

// ---- MODEL v2: capacity_v1 revenue, events, fixed vs floating (tests/fixtures/models/fxr_capacity.json) ----
// Fixture Capacity Corp: MW +10 a month from 100 (Jun 2026) to 160 (Dec), +5 a month to 220 (2027)
// and 280 (2028), then flat; billing lag 0; US$12m per billing MW-year; 10% of billing MW renews in
// 2027-28 at -20%; cost of revenue US$3m per MW-year; capex US$25m per MW + 5% of revenue.
const CAPFIX = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'models', 'fxr_capacity.json'), 'utf8'));
const cspec = () => JSON.parse(JSON.stringify(CAPFIX));
const crun = (ov, opts, s) => { const r = M.project(s || CAPFIX, ov || {}, opts); assert(!r.error, r.error); return r; };
const CB = crun();
const CY = CB.years;
// end-of-month active MW; m = months after Jun 2026 (1 = Jul 2026, 7 = Jan 2027, 18 = Dec 2027)
const mwAt = m => (m <= 0 ? 100 : m <= 6 ? 100 + 10 * m : m <= 30 ? 160 + 5 * (m - 6) : 280);
const yOf = m => 2026 + Math.floor((m + 5) / 12);
// the capacity_v1 revenue formula by hand for this fixture (lag 0, no customer cuts, no backstop)
function hand(o) {
  o = Object.assign({ mw: mwAt, util: { 2026: 1, 2027: 1, 2028: 1, 2029: 0.95, 2030: 0.95 }, renew: { 2027: 0.1, 2028: 0.1 },
    reset: { 2027: -0.2, 2028: -0.2 }, resetShift: 0, churn: {}, from: 7, price: 12 }, o);
  const out = { 2026: 0, 2027: 0, 2028: 0, 2029: 0, 2030: 0 };
  let drag = 0;
  for (let m = 1; m <= 54; m++) {
    const y = yOf(m), B = (o.mw(m - 1) + o.mw(m)) / 2 * o.util[y];
    const r = (o.reset[y] || 0) + (m >= o.from ? o.resetShift : 0), ch = o.churn[y] || 0;
    drag += (o.renew[y] || 0) / 12 * B * (ch - (1 - ch) * r);
    out[y] += Math.max(0, B - drag) * o.price / 12;
  }
  return out;
}
const capEvent = (s, e) => { (s.events = s.events || []).push(Object.assign({ kind: 'risk', label: e.id, mechanism: 'test', prob: 0.5, indicators: [], src: ['s1'] }, e)); return s; };

check('capacity fixture validates cleanly; growth-path drivers give way to capacity drivers', () => {
  const v = M.validateSpec(CAPFIX);
  eq(v.errors, []); eq(v.warnings, []); assert(v.ok);
  eq(CB.warnings, []);
  const ids = M.drivers(CAPFIX).map(d => d.id);
  for (const id of ['delivery_delay_months', 'extra_capacity_mw', 'utilization', 'revenue_per_mw_shift', 'renewal_price_reset', 'cor_per_mw',
    'capex_per_mw', 'power_cost_shift', 'self_build_share', 'new_debt_floating_share', 'hedge_ratio_new']) assert(ids.includes(id), id);
  for (const id of ['revenue_growth', 'capex_revenue_link', 'capex', 'cost_of_revenue_pct']) assert(!ids.includes(id), id);
  const g = M.drivers(FIX).map(d => d.id);
  for (const id of ['delivery_delay_months', 'capex_per_mw', 'new_debt_floating_share', 'hedge_ratio_new', 'self_build_share']) assert(!g.includes(id), `growth spec: ${id}`);
  const t = M.template('levered_growth_v1');
  for (const gr of ['Capacity & delivery', 'Pricing & mix', 'Unit costs']) assert(t.groups.includes(gr), gr);
  assert(Object.isFrozen(t.event_impacts) && t.event_impacts.customer_cut.cap && !t.event_impacts.spread_bp.cap);
});
check('capacity -> revenue by hand: MW x price x billing, renewals at their reset price', () => {
  const R = CB.rows, h = hand();
  near(R.revenue[0], 700 + 780, 'FY2026 = H1 actual + Σ avg MW (105 ... 155 = 780) x 12/12');
  for (let i = 1; i < 5; i++) near(R.revenue[i], h[CY[i]], `revenue ${CY[i]}`);
  eq(R.active_mw_end, [160, 220, 280, 280, 280]); eq(R.mw_added, [60, 60, 60, 0, 0]);
  near(R.active_mw_avg[0], (6 * 100 + 780) / 12, 'FY2026 average MW (H1 at the opening level)');
  near(R.billing_mw_avg[3], 280 * 0.95, '2029 billing MW'); eq(R.utilization_avg.map(x => Math.round(x)), [100, 100, 100, 95, 95]);
  for (let i = 0; i < 5; i++) near(R.list_price_per_billing_mw[i], 12, 'list price');
  near(R.revenue_per_billing_mw[0], 12, 'H2 2026: nothing renews');
  for (let i = 1; i < 5; i++) near(R.revenue_per_billing_mw[i], R.revenue[i] / R.billing_mw_avg[i], 'realised price: net of the renewals');
  near(R.renewal_effect[1], h[2027] - 190 * 12, 'renewals: revenue lost vs no renewals');
  near(R.cost_of_revenue[0], 210 + 780 * 3 / 12, 'cost of revenue = H1 actual + avg MW x 3/12');
  near(R.cost_of_revenue[1], 190 * 12 * 3 / 12, 'FY2027 cost of revenue');
  near(R.rent[1], 0.5 * R.cost_of_revenue[1], 'rent share'); near(R.power_cost[1], 0.25 * R.cost_of_revenue[1], 'power share');
  near(R.capex[0], 400 + 60 * 25 + 0.05 * 780, 'FY2026 capex = H1 actual + new MW x 25 + 5% of revenue');
  near(R.capex[1], 60 * 25 + 0.05 * R.revenue[1], 'FY2027 capex');
  near(R.capex_capacity[1], 1500); near(R.capex_maintenance[1], 0.05 * R.revenue[1]);
  for (let i = 0; i < 5; i++) near(R.revenue_per_mw[i], R.revenue[i] / R.active_mw_avg[i], 'revenue per average MW');
  // customers own their share of the contracted revenue; the computed "uncontracted" pool the rest
  const C = R.revenue_by_customer, S = R.customer_share;
  near(C.alpha[0], 0.6 * R.contracted_revenue[0], 'alpha FY2026'); near(C.rest[2], 0.3 * R.contracted_revenue[2], 'rest FY2028');
  for (let i = 0; i < 5; i++) {
    near(sumA(Object.values(C).map(a => a[i])), R.revenue[i], `customers add up to revenue ${CY[i]}`);
    near(C.uncontracted[i], R.uncontracted_revenue[i], 'the uncontracted pool');
  }
  eq(S.alpha.map(x => Math.round(x)), [58, 29, 18, 8, 5], 'of revenue');
  eq(R.top_contracted_share.map(x => Math.round(x)), [60, 50, 40, 30, 30], 'of contracted revenue');
  eq(R.top_customer_share.map(x => Math.round(x)), [58, 29, 18, 8, 5], 'the aggregate "rest" and the uncontracted pool are not customers');
  eq(R.lookthrough_share.beta.map(x => Math.round(x)), [58, 32, 22, 12, 7], 'beta direct + half of alpha');
});
check('delivery delay: MW shift right from adjust_from, revenue falls, capex follows the MW', () => {
  const d = crun({ delivery_delay_months: 3 }), R = d.rows;
  near(R.revenue[0], CB.rows.revenue[0], 'FY2026 (before adjust_from) unchanged'); near(R.capex[0], CB.rows.capex[0], 'FY2026 capex unchanged');
  eq(R.active_mw_end, [160, 205, 265, 280, 280], 'Dec-27 = Sep-27 of the base path');
  const h = hand({ mw: m => (m <= 6 ? mwAt(m) : mwAt(Math.max(6, m - 3))) });
  for (let i = 1; i < 5; i++) near(R.revenue[i], h[CY[i]], `delayed revenue ${CY[i]}`);
  assert(R.revenue[1] < CB.rows.revenue[1] && R.revenue[2] < CB.rows.revenue[2]);
  eq(R.capex_capacity.map(x => Math.round(x)), [1500, 45 * 25, 60 * 25, 15 * 25, 0], 'capex moves with the MW');
  near(sumA(R.capex_capacity), sumA(CB.rows.capex_capacity), 'same MW, same capacity capex in total');
  const e = crun({}, { events: { slip: 1 } }).rows;
  eq(e.active_mw_end, R.active_mw_end, 'the slip event = the driver from the same month');
  near(e.capex[1], R.capex[1] + 100, 'capex_delta added after the coupling'); near(e.capex[2], R.capex[2] - 100);
  eq(crun({ delivery_delay_months: -2 }).rows.active_mw_end.slice(0, 3), [160, 230, 280], 'early: pulled left');
  eq(crun({ delivery_delay_months: 10 }, { events: { slip: 1 } }).rows.active_mw_end, crun({ delivery_delay_months: 12 }).rows.active_mw_end,
    'delays add up, capped at max_delay_months');
});
check('extra capacity and mw_delta events add MW (phased), and capex for them', () => {
  const R = crun({ extra_capacity_mw: 40 }).rows;
  eq(R.active_mw_end, [160, 240, 320, 320, 320], 'phase 0.5 at end-2027, 1 at end-2028');
  near(sumA(R.capex_capacity) - sumA(CB.rows.capex_capacity), 40 * 25, 'capex for the extra MW');
  assert(R.revenue[2] > CB.rows.revenue[2]);
  eq(crun({}, { events: { big_contract: 1 } }).rows.active_mw_end, [160, 240, 340, 340, 340], 'mw_delta from Jul 2027');
  eq(crun({ extra_capacity_mw: -200 }).rows.active_mw_end, [160, 160, 160, 160, 160], 'fewer MW than planned: never below what is already on');
  eq(crun({ extra_capacity_mw: -40 }).rows.active_mw_end, [160, 200, 240, 240, 240]);
});
check('renewal pricing applies only to the renewing share', () => {
  const R = crun({ renewal_price_reset: -30 }).rows, h = hand({ resetShift: -0.3 });
  near(R.revenue[0], CB.rows.revenue[0], 'FY2026 unchanged');
  for (let i = 1; i < 5; i++) near(R.revenue[i], h[CY[i]], `revenue ${CY[i]}`);
  assert(R.revenue[3] < CB.rows.revenue[3], 'repriced capacity stays repriced after the renewal years');
  const s = cspec(); for (const y of Object.keys(s.revenue_model.renewing_share)) s.revenue_model.renewing_share[y] = 0;
  eq(crun({ renewal_price_reset: -30 }, null, s).rows.revenue, crun({}, null, s).rows.revenue, 'nothing renews: the reset has no effect');
  capEvent(s, { id: 'reset_only', from: '2027-01', impacts: { renewal_price_reset_pp: -30 } });
  const s2 = cspec(); capEvent(s2, { id: 'reset_only', from: '2027-01', impacts: { renewal_price_reset_pp: -30 } });
  eq(crun({}, { events: { reset_only: 1 } }, s2).rows.revenue, R.revenue, 'the event = the driver from the same month');
});
check('backlog: contracted revenue by year, coverage, warnings', () => {
  const R = CB.rows;
  eq(R.contracted_revenue, [700 + 6 * 120, 6 * 120 + 6 * 100, 12 * 100 + 100, 6 * 100 + 6 * 40, 12 * 40], '30/50/20% over months 1-12 / 13-36 / 37-60 + 100 signed later');
  for (let i = 0; i < 5; i++) {
    near(R.backlog_coverage[i], R.contracted_revenue[i] / R.revenue[i] * 100, `coverage ${CY[i]}`);
    near(R.uncontracted_revenue[i], Math.max(0, R.revenue[i] - R.contracted_revenue[i]));
  }
  const lo = crun({ revenue_per_mw_shift: -50, utilization: -20 });
  eq(lo.rows.contracted_revenue, R.contracted_revenue, 'contracted revenue does not move with the stress');
  for (const k of ['alpha', 'beta', 'rest']) eq(lo.rows.revenue_by_customer[k], R.revenue_by_customer[k], `take-or-pay: ${k} bills its contract`);
  assert(lo.rows.uncontracted_revenue[1] < 0.3 * R.uncontracted_revenue[1], 'price and utilisation fall on the uncontracted pool');
  // only capacity that is not there (a slip) takes contracted revenue below the schedule
  const big = cspec(); big.revenue_model.backlog.rpo = 9600;
  const sl = crun({ delivery_delay_months: 12 }, null, big);
  assert(sl.warnings.some(w => /^FY2027: modelled revenue 1,920 is below the 2,280 already contracted/.test(w)), sl.warnings.join('\n'));
  eq(crun({}, null, big).warnings, [], 'on schedule: no warning');
  const s = cspec(); s.revenue_model.backlog.coverage_warn = 0.6;
  const w = crun({}, null, s).warnings.filter(x => /of modelled revenue is contracted/.test(x));
  eq(w.map(x => x.slice(0, 6)), ['FY2027', 'FY2028', 'FY2029', 'FY2030']);
  const s2 = cspec(); s2.revenue_model.backlog.committed_share = 0.5;
  const K = crun({}, null, s2).rows.contracted_revenue;
  near(K[0], 700 + 0.5 * 780, 'stub months capped at half of base revenue');
  near(K[1], 6 * (120 + (720 - 390) / 6) + 6 * 100, 'the excess moves to the rest of the bucket');
  near(sumA(K), sumA(R.contracted_revenue), 'nothing lost');
});
check('customer cut: only that customer\'s revenue falls (the backstop buys part of the freed capacity)', () => {
  const R = crun({}, { events: { alpha_cut: 1 } }).rows, B = CB.rows;
  for (let i = 0; i < 5; i++) {
    near(R.revenue_by_customer.alpha[i], B.revenue_by_customer.alpha[i] * (i >= 2 ? 0.5 : 1), `alpha ${CY[i]}`);
    near(R.revenue_by_customer.beta[i], B.revenue_by_customer.beta[i], `beta ${CY[i]}`);
    near(R.revenue_by_customer.rest[i], B.revenue_by_customer.rest[i], `rest ${CY[i]}`);
  }
  eq(R.backstop_revenue.map(Math.round), [0, 0, 100, 0, 0], 'the backstop pays its cap in 2028'); eq(R.backstop_left.map(Math.round), [100, 100, 0, 0, 0]);
  near(R.revenue_by_customer.gamma[2], 100, 'paid by the backstop counterparty');
  near(R.revenue[2], B.revenue[2] - 0.5 * B.revenue_by_customer.alpha[2] + 100, 'total');
  const s = cspec(); delete s.revenue_model.backstop;
  near(crun({}, { events: { alpha_cut: 1 } }, s).rows.revenue[2], B.revenue[2] - 0.5 * B.revenue_by_customer.alpha[2], 'no backstop');
});
check('event impacts: price, churn, utilisation, unit costs, power', () => {
  const ev = (id, impacts, from, s) => { s = capEvent(s || cspec(), { id, from: from || '2027-01', impacts }); return crun({}, { events: { [id]: 1 } }, s); };
  const p = ev('px', { revenue_per_mw_pct: 10 }).rows;
  near(p.revenue[0], CB.rows.revenue[0]); near(p.revenue[1], CB.rows.revenue[1] + 0.1 * CB.rows.uncontracted_revenue[1], 'new deals x 1.1; contracts at their price');
  assert(p.list_price_per_billing_mw[1] > 12 && p.list_price_per_billing_mw[1] < 13.2, 'list price: contracts at 12, new deals at 13.2');
  const pf = ev('pf', { revenue_per_mw_fleet_pct: 10 }).rows;
  for (let i = 1; i < 5; i++) near(pf.revenue[i], 1.1 * CB.rows.revenue[i], `the whole fleet x 1.1 ${CY[i]}`);
  const nb = cspec(); delete nb.revenue_model.backstop;
  const ch = ev('ch', { renewal_churn_pp: 50 }, '2028-01', nb).rows, hc = hand({ churn: { 2028: 0.5, 2029: 0.5, 2030: 0.5 } });
  for (let i = 2; i < 5; i++) near(ch.revenue[i], hc[CY[i]], `churned renewals ${CY[i]}`);
  const chB = ev('ch', { renewal_churn_pp: 50 }, '2028-01').rows;
  assert(chB.backstop_revenue[2] > 0 && chB.backstop_revenue[2] <= 100 + 1e-9);
  near(chB.revenue[2], ch.revenue[2] + chB.backstop_revenue[2], 'the backstop buys the capacity that walked');
  const u = ev('u', { utilization_pp: -10 }).rows;
  near(u.utilization_avg[1], 90); near(u.backstop_revenue[1], 100, 'unsold capacity: the backstop pays up to its cap');
  near(u.revenue[1], hand({ util: { 2026: 1, 2027: 0.9, 2028: 0.9, 2029: 0.85, 2030: 0.85 } })[2027] + 100);
  near(ev('cor', { cor_per_mw_pct: 10 }).rows.cost_of_revenue[1], 1.1 * 570);
  const pw = ev('pw', { power_cost_pct: 40 }).rows;
  near(pw.cost_of_revenue[1], 570 + 0.25 * 0.4 * 570, 'power share x 40%'); near(pw.power_cost[1], 0.25 * 570 * 1.4);
});
check('event impacts: financing (spread, new-debt rate, market cap, equity), depreciation life', () => {
  const ev = (id, impacts) => crun({}, { events: { [id]: 1 } }, capEvent(cspec(), { id, from: '2027-01', impacts }));
  const sp = ev('sp', { spread_bp: 100 }).rows, B = CB.rows;
  near(sp.new_debt_rate[0], B.new_debt_rate[0]); near(sp.new_debt_rate[1], B.new_debt_rate[1] + 1, '+100bp on new debt');
  for (const t of ['term-loan', 'ddtl', 'notes-2028']) near(sp.rate_by_tranche[t][1], B.rate_by_tranche[t][1], `${t}: contractual`);
  near(ev('rt', { new_debt_rate_pp: 2 }).rows.new_debt_rate[2], B.new_debt_rate[2] + 2);
  const m = crun({}, { events: { markets_shut: 1 } });
  eq(m.rows.uncommitted_debt.slice(1, 3), [0, 0], 'no new uncommitted debt while shut');
  assert(m.rows.funding_shortfall[1] > 0 && m.rows.cash_end[1] < 200 && m.liquidity.min < 0, 'the gap is not funded: liquidity goes negative');
  assert(m.warnings.some(w => /2027: .* could not be borrowed/.test(w)));
  near(m.rows.new_debt_rate[1], B.new_debt_rate[1] + 3 + 2, 'and costs more afterwards (+300bp, +2pp)');
  const q = ev('eq', { equity_share_pp: 40, issue_discount_pp: 20 }).rows;
  near(q.new_equity_m[1], 0.5 * q.funding_gap[1], '10% + 40pp of the gap'); near(q.new_shares[1], q.new_equity_m[1] / (20 * 0.7), 'at a 30% discount');
  eq(ev('life', { useful_life_delta: -3 }).rows.da, crun({ useful_life: 3 }).rows.da, 'useful_life_delta = the life driver');
  const g = M.project(capEvent(spec(), { id: 'gx', impacts: { utilization_pp: -5 } }), {});
  assert(g.warnings.some(w => w.includes('event gx: impact utilization_pp needs a revenue_model')), 'capacity impacts need a revenue model');
});
check('events on/off: object or list, one per group, unknown ids warned; catalogue', () => {
  eq(JSON.stringify(crun({}, { events: ['slip'] }).rows), JSON.stringify(crun({}, { events: { slip: 1, early: 0 } }).rows));
  const g = crun({}, { events: { slip: 1, early: 1 } });
  eq(g.events_on, ['slip']); assert(g.warnings.some(w => w.includes('event early: group delivery already has an event on')));
  const u = crun({}, { events: { nope: 1, slip: 2 } });
  eq(u.events_on, []); assert(u.warnings.some(w => w.includes('event nope: unknown')) && u.warnings.some(w => w.includes('slip: state must be 0 or 1')));
  eq(JSON.stringify(crun({}, { events: {} }).rows), JSON.stringify(CB.rows), 'no events = base');
  const E = M.events(CAPFIX);
  eq(E.events.map(e => e.id), CAPFIX.events.map(e => e.id));
  eq(E.groups.map(x => [x.id, x.events]), [['delivery', ['slip', 'early']], ['market', ['price_war', 'tight_supply']]]);
  eq(E.events.find(e => e.id === 'alpha_cut').impacts.customer_cut, [{ customer: 'alpha', pct: 0.5, from: '2028-01', idle_months: 6, relet_pct: null }]);
  eq(E.events.find(e => e.id === 'big_contract').impacts.mw_delta, { 2027: 20, 2028: 60, 2029: 60, 2030: 60 });
});
check('eventImpact: Δ = on - off, the other events held', () => {
  const e = M.eventImpact(CAPFIX, {}, 'alpha_cut');
  assert(!e.error, e.error);
  const on = crun({}, { events: { alpha_cut: 1 } }), off = CB;
  near(e.value_per_share.delta, on.valuation.value_per_share - off.valuation.value_per_share, 'value');
  for (let i = 0; i < 5; i++) near(e.rows.revenue.delta[i], on.rows.revenue[i] - off.rows.revenue[i], `revenue ${CY[i]}`);
  const h = M.eventImpact(CAPFIX, {}, 'alpha_cut', { events: { slip: 1 } });
  eq([h.events_off, h.events_on], [['slip'], ['slip', 'alpha_cut']]);
  near(h.value_per_share.on, crun({}, { events: { slip: 1, alpha_cut: 1 } }).valuation.value_per_share);
  const x = M.eventImpact(CAPFIX, {}, 'early', { events: { slip: 1 } });
  eq([x.events_off, x.events_on], [['slip'], ['early']], 'switching on a group member switches its sibling off');
  assert(M.eventImpact(CAPFIX, {}, 'nope').error && M.eventImpact(FIX, {}, 'slip').error);
});
check('tornado: events are bars (off vs on), sorted with the drivers', () => {
  const t = M.sensitivity(CAPFIX, {}, {});
  const evb = t.bars.filter(b => b.type === 'event');
  eq(evb.length, CAPFIX.events.length);
  for (let i = 1; i < t.bars.length; i++) assert(t.bars[i - 1].swing >= t.bars[i].swing, 'sorted');
  for (const b of evb) {
    near(b.v_low, CB.valuation.value_per_share, `${b.id} off`);
    near(b.v_high, crun({}, { events: { [b.id]: 1 } }).valuation.value_per_share, `${b.id} on`);
    eq([b.low, b.high, b.current, b.unit], [0, 1, 0, 'event']);
  }
  eq(M.sensitivity(CAPFIX, {}, { include_events: false }).bars.filter(b => b.type === 'event').length, 0);
  const w = M.sensitivity(CAPFIX, {}, { events: { alpha_cut: 1 }, metric: 'revenue', year: 2028 });
  const b = w.bars.find(x => x.id === 'alpha_cut');
  eq(b.current, 1); near(b.v_high, w.base); near(b.v_low, CB.rows.revenue[2]);
  near(w.bars.find(x => x.id === 'slip').v_high, crun({}, { events: { alpha_cut: 1, slip: 1 } }).rows.revenue[2], 'others on top of the current events');
});
check('distribution: exact enumeration, probabilities sum to 1, groups honoured, marginals', () => {
  const d = M.distribution(CAPFIX, {});
  assert(!d.error, d.error);
  eq([d.method, d.states, d.draws], ['exact', 3 * 3 * 128, null]);
  near(d.total_prob, 1, 'Σ state probabilities', 1e-12);
  for (const e of d.events) near(e.p_on, CAPFIX.events.find(x => x.id === e.id).prob, `${e.id} marginal`, 1e-12);
  for (const k of ['value_per_share', 'net_income@2028']) {
    const m = d.metrics[k];
    assert(m.p10 <= m.p50 && m.p50 <= m.p90 && m.min <= m.mean && m.mean <= m.max, `${k} ordered`);
    near(sumA(m.hist.probs), 1, `${k} histogram`); eq(m.hist.edges.length, m.hist.probs.length + 1);
  }
  near(d.metrics.value_per_share.base, CB.valuation.value_per_share, 'base = no events');
  // only slip / early (one group) and alpha_cut can happen: six states, slip + early never together
  const probs = Object.fromEntries(CAPFIX.events.map(e => [e.id, 0])); Object.assign(probs, { slip: 0.3, early: 0.1, alpha_cut: 0.2 });
  const d6 = M.distribution(CAPFIX, {}, { probs, metrics: ['value_per_share', 'revenue@2028'] });
  eq(d6.evaluated, 6);
  let mean = 0, rev = 0;
  for (const [dl, pd] of [[null, 0.6], ['slip', 0.3], ['early', 0.1]]) for (const [a, pa] of [[false, 0.8], [true, 0.2]]) {
    const st = {}; if (dl) st[dl] = 1; if (a) st.alpha_cut = 1;
    const r = crun({}, { events: st }); mean += pd * pa * r.valuation.value_per_share; rev += pd * pa * r.rows.revenue[2];
  }
  near(d6.metrics.value_per_share.mean, mean, 'probability-weighted value'); near(d6.metrics['revenue@2028'].mean, rev, 'weighted revenue');
  for (const x of [d.p_covenant_breach, d.p_liquidity_negative, d.p_funding_need_above]) assert(x >= 0 && x <= 1);
  const shut = Object.fromEntries(CAPFIX.events.map(e => [e.id, e.id === 'markets_shut' ? 1 : 0]));
  eq(M.distribution(CAPFIX, {}, { probs: shut }).p_liquidity_negative, 1, 'markets shut for sure: liquidity goes negative');
  eq(M.distribution(CAPFIX, {}, { funding_threshold: 1e9 }).p_funding_need_above, 0);
  const s = cspec(); s.events.find(e => e.id === 'early').prob = 0.9;
  assert(M.validateSpec(s).warnings.some(w => w.includes('group delivery probabilities sum to 1.20')));
  near(M.distribution(s, {}).events.find(e => e.id === 'early').p_on, 0.9 / 1.2, 'scaled to sum to 1');
  assert(M.distribution(CAPFIX, {}, { metrics: ['nope'] }).error && M.distribution(FIX, {}).metrics.value_per_share.mean !== undefined);
});
check('distribution: seeded Monte Carlo is deterministic and agrees with the exact answer', () => {
  const ex = M.distribution(CAPFIX, {}), a = M.distribution(CAPFIX, {}, { monte_carlo: true, seed: 7 });
  eq(JSON.stringify(a), JSON.stringify(M.distribution(CAPFIX, {}, { monte_carlo: true, seed: 7 })), 'same seed, same answer');
  assert(a.metrics.value_per_share.mean !== M.distribution(CAPFIX, {}, { monte_carlo: true, seed: 8 }).metrics.value_per_share.mean, 'another seed');
  eq([a.method, a.draws, a.seed], ['monte_carlo', 2000, 7]);
  near(a.total_prob, 1, 'draws weigh 1/2000 each', 1e-9);
  const sd = ex.metrics.value_per_share.sd;
  assert(Math.abs(a.metrics.value_per_share.mean - ex.metrics.value_per_share.mean) < 4 * sd / Math.sqrt(2000), 'mean within 4 standard errors');
  for (const e of a.events) assert(Math.abs(e.p_on - e.prob) < 4 * Math.sqrt(e.prob * (1 - e.prob) / 2000) + 1e-9, `${e.id} frequency`);
  const m = a.metrics.value_per_share; assert(m.p10 <= m.p50 && m.p50 <= m.p90);
  const s = cspec();
  for (let k = 0; k < 13; k++) capEvent(s, { id: `x${k}`, prob: 0.1, from: '2027-01', impacts: { capex_delta: { 2027: 10 } } });
  const big = M.distribution(s, {});
  eq([big.method, big.draws, big.seed], ['monte_carlo', 2000, 20261018], 'more than 4,096 joint states: sampled');
});
check('fixed vs floating: debt and interest splits add up, every year, under stress and events', () => {
  const cases = [[{}, {}], [{ sofr_shift: 150, spread_shift: 100 }, {}], [{ new_debt_floating_share: 100, hedge_ratio_new: 0 }, { events: { slip: 1, markets_shut: 1 } }],
    [{ delivery_delay_months: 6, capex_per_mw: 40 }, { events: { price_war: 1, alpha_cut: 1 } }]];
  for (const [ov, o] of cases) for (const R of [crun(ov, o).rows, run({ sofr_shift: ov.sofr_shift || 0 }).rows]) {
    for (let i = 0; i < 5; i++) {
      near(R.debt_fixed[i] + R.debt_floating[i] + R.debt_new_fixed[i] + R.debt_new_floating[i], R.debt_end[i], `debt split ${CY[i]}`);
      near(R.interest_actual[i] + R.interest_fixed[i] + R.interest_floating[i] + R.interest_new[i], R.interest[i], `interest split ${CY[i]}`);
      near(R.interest_new[i], R.interest_new_fixed[i] + R.interest_new_floating[i], 'new = fixed + floating');
      near(R.floating_share_of_debt[i], (R.debt_floating[i] + R.debt_new_floating[i]) / R.debt_end[i] * 100, 'floating share of debt');
      near(R.floating_share_of_interest[i], (R.interest_floating[i] + R.interest_new_floating[i]) / (R.interest[i] - R.interest_actual[i]) * 100, 'of interest');
      assert(R.hedged_notional[i] <= R.debt_fixed[i] + 1e-9);
    }
  }
});
check('hedges move notional from floating to fixed; the swapped part pays the swap rate', () => {
  const s = cspec(); s.hedges = [];
  const n = crun({}, null, s).rows, h = CB.rows;
  for (let i = 0; i < 5; i++) {
    near(h.debt_fixed[i] + h.debt_floating[i], n.debt_fixed[i] + n.debt_floating[i], 'existing debt unchanged');
    near(h.debt_fixed[i] - n.debt_fixed[i], i < 4 ? 400 : 0, `fixed +400 while the swap runs (${CY[i]})`);
    near(n.debt_floating[i] - h.debt_floating[i], i < 4 ? 400 : 0, 'floating -400');
  }
  eq(h.hedged_notional, [400, 400, 400, 400, 0]);
  near(h.interest_by_tranche['term-loan'][0], 600 * 0.07 * 0.5 + 400 * 0.06 * 0.5, 'H2-26: 600 at SOFR 4% + 3%, 400 at 3% + 3%');
  near(h.interest_by_tranche['term-loan'][1], 600 * 0.065 + 400 * 0.06, '2027');
  near(n.interest_by_tranche['term-loan'][1], 1000 * 0.065, 'unhedged');
  const r = cspec(); r.hedges = [{ id: 'half', tranche: 'term-loan', ratio: 0.5, fixed_rate: 'path', start: '2027-07', src: ['s1'] }];
  const p = crun({}, null, r).rows;
  near(p.interest_by_tranche['term-loan'][2], 500 * (0.0325 + 0.03) + 500 * (0.035 + 0.03), 'a "path" swap locks SOFR at its start (2027: 3.5%)');
  near(p.debt_fixed[0], 500, 'not started yet: notes only'); near(p.debt_fixed[1], 500 + 500, 'started Jul 2027');
  const f = cspec(); f.hedges.push({ id: 'rcf-swap', tranche: 'rcf', ratio: 1, fixed_rate: 2, src: ['s3'] });
  const q = crun({}, null, f).rows;
  near(q.debt_fixed[0] - h.debt_fixed[0], q.debt_by_tranche.rcf[0], 'a swapped facility is fixed');
  near(q.rate_by_tranche.rcf[1], 2 + 2 + 0.25, 'at the swap rate + margin + fee');
  const x = cspec(); x.hedges.push({ id: 'ccs', tranche: 'notes-2028', type: 'cross_currency', notional: 500, src: ['s1'] }, { id: 'bad', tranche: 'notes-2028', notional: 100, fixed_rate: 3, src: ['s1'] });
  const xr = M.project(x, {});
  eq(JSON.stringify(xr.rows.interest), JSON.stringify(CB.rows.interest), 'a cross-currency swap is informational; a swap on fixed debt is ignored');
  assert(xr.warnings.some(w => w.includes('hedges bad: notes-2028 is fixed-rate')));
  eq(M.hedges(x).map(e => [e.id, e.type]), [['swap-tl', 'swap'], ['ccs', 'cross_currency']]);
});
check('rate_exposure_100bp = the +100bp re-projection; fixed debt does not move', () => {
  const up = crun({ sofr_shift: 100 }), B = CB.rows;
  for (let i = 0; i < 5; i++) {
    near(B.rate_exposure_100bp[i], up.rows.interest[i] - B.interest[i], `exposure ${CY[i]}`);
    near(B.rate_exposure_reset[i] + B.rate_exposure_issuance[i], B.rate_exposure_100bp[i], 'reset + issuance = total');
  }
  for (const i of [0, 1]) near(up.rows.interest_by_tranche['notes-2028'][i], B.interest_by_tranche['notes-2028'][i], 'fixed notes');
  near(up.rows.interest_by_tranche['term-loan'][1] - B.interest_by_tranche['term-loan'][1], 600 * 0.01, 'only the unswapped 600 resets');
  near(up.rows.interest_fixed[1], B.interest_fixed[1], 'fixed-rate interest (incl. the swap) unchanged');
  near(up.rows.interest_floating[1] - B.interest_floating[1], (600 + (500 + 300) / 2 + up.rows.debt_by_tranche.rcf[0]) * 0.01, 'floating: TL 600 + DDTL avg + RCF');
  assert(B.rate_exposure_issuance[2] > 0, 'new fixed debt locks the higher rate');
  eq(crun({}, { exposure: false }).rows.rate_exposure_100bp, [null, null, null, null, null]);
});
check('new debt: fixed vintages lock their year\'s rate, floating ones keep their margin and reset', () => {
  const s = cspec();
  s.debt.find(t => t.id === 'notes-2028').maturity = '2035-06'; s.funding.committed = []; s.funding.new_debt_amort_years = 0; s.rates.new_debt_ref_year = 2027;
  const pool = (R, j) => { let p = 0; for (let i = 0; i < j; i++) p += R.uncommitted_debt[i]; return p; };
  const lockedExp = (R, j) => { let x = 0; for (let i = 0; i < j; i++) x += R.uncommitted_debt[i] * R.new_debt_rate[i] / 100; return (x + R.uncommitted_debt[j] * R.new_debt_rate[j] / 200) * R.proj_frac[j]; };
  const fx = crun({ new_debt_floating_share: 0, hedge_ratio_new: 0 }, null, s).rows;
  assert(fx.new_debt_rate[0] > fx.new_debt_rate[3], 'the path falls, so the rate does');
  for (let j = 0; j < 5; j++) near(fx.interest_new[j], lockedExp(fx, j), `locked vintages ${CY[j]}`);
  eq(fx.debt_new_floating.every(x => Math.abs(x) < 1e-9), true, 'all fixed');
  const fl = crun({ new_debt_floating_share: 100, hedge_ratio_new: 0 }, null, s).rows;
  for (let j = 0; j < 5; j++) near(fl.interest_new[j], fl.new_debt_rate[j] / 100 * (pool(fl, j) + fl.uncommitted_debt[j] / 2) * fl.proj_frac[j], `floating resets ${CY[j]}`);
  eq(fl.debt_new_fixed.every(x => Math.abs(x) < 1e-9), true, 'all floating');
  const sw = crun({ new_debt_floating_share: 100, hedge_ratio_new: 100 }, null, s).rows;
  for (let j = 0; j < 5; j++) near(sw.interest_new[j], lockedExp(sw, j), `swapped at issue = locked ${CY[j]}`);
  const lg = cspec(); Object.assign(lg, JSON.parse(JSON.stringify(s)));
  lg.drivers = lg.drivers.filter(d => !['new_debt_floating_share', 'hedge_ratio_new'].includes(d.id));
  const L = crun({}, null, lg).rows;
  for (let j = 0; j < 5; j++) near(L.interest_new[j], L.new_debt_rate[j] / 100 * (pool(L, j) + L.uncommitted_debt[j] / 2) * L.proj_frac[j], `v1 pool reprices ${CY[j]}`);
});
check('new_debt_amort_years: the floating share amortises from the year after it is raised', () => {
  const R = CB.rows, D = R.uncommitted_debt;
  near(R.new_debt_repaid[1], D[0] * 0.5 / 4, '2027: a quarter of the stub vintage\'s floating half');
  near(R.new_debt_repaid[2], (D[0] + D[1]) * 0.5 / 4, '2028');
  for (let i = 0; i < 5; i++) near(R.debt_by_tranche[M.NEW_DEBT_ID][i], (i ? R.debt_by_tranche[M.NEW_DEBT_ID][i - 1] : 0) + D[i] - R.new_debt_repaid[i], `pool roll ${CY[i]}`);
  for (let i = 0; i < 5; i++) {
    near(R.cash_end[i], R.cash_open[i] + R.ocf_proj[i] - R.capex_proj[i] + R.new_debt[i] + R.new_equity_m[i] - R.repayments[i], `cash ${CY[i]}`);
    near(R.gross_borrowing[i], R.new_debt[i] + R.refinanced[i], 'gross borrowing');
    near(R.liquidity[i], R.cash_end[i] + R.committed_left[i], 'liquidity');
  }
});
check('EBITDA -> free cash flow bridge; interest as % of adj. EBITDA', () => {
  for (const R of [CB.rows, BASE.rows, crun({ utilization: -10 }, { events: { markets_shut: 1 } }).rows]) for (let i = 0; i < 5; i++) {
    near(R.fcf[i], R.ebitda[i] - R.cash_interest[i] - R.cash_tax[i] - R.capex[i] + R.wc_prepay[i] + R.other_cash[i], `bridge ${CY[i]}`);
    near(R.cash_interest[i], R.interest[i] - R.interest_noncash[i], 'cash interest');
    if (i) near(R.other_cash[i], 0, 'full projected years: nothing unexplained', 1e-9);
    near(R.interest_to_ebitda[i], R.interest[i] / R.ebitda[i] * 100, 'interest / EBITDA');
  }
});
check('self-build share: owned MW pay no rent; shell capex depreciates over the long life', () => {
  const R = crun({ self_build_share: 50 }).rows, B = CB.rows;
  near(R.revenue[0], B.revenue[0]); near(R.capex[0], B.capex[0], 'FY2026: before the self-build start');
  eq(R.owned_mw.map(Math.round), [0, 30, 60, 60, 60]);
  near(R.capex_self_build[1], 30 * 8, 'half the new MW x US$8m of shell'); near(R.capex[1] - B.capex[1], 30 * 8);
  assert(R.rent[1] < B.rent[1] && R.cost_of_revenue[1] < B.cost_of_revenue[1]);
  near(B.rent[2] - R.rent[2], 45 * 3 * 0.5, 'no rent on the 45 MW owned on average in 2028 (30 -> 60)');
  const dDa = R.da[3] - B.da[3];
  near(dDa, (240 + 240) / 25, 'shells over 25 years (2027 and 2028 vintages in service all of 2029)', 1e-6);
  assert(M.project(spec(), {}).warnings.every(w => !w.includes('self_build')), 'growth spec: no noise');
  const s = cspec(); delete s.revenue_model.self_build;
  assert(M.validateSpec(s).warnings.some(w => w.includes('self_build_share needs revenue_model.self_build')));
});
check('billing lag and capex lead months', () => {
  const s = cspec(); s.revenue_model.billing_lag_months = 2;
  near(crun({}, null, s).rows.revenue[0], 700 + (100 + 100 + 105 + 115 + 125 + 135), 'Jul-Dec bill the average MW of May-Oct');
  const l = cspec(); l.revenue_model.capex.lead_months = 2;
  near(crun({}, null, l).rows.capex_capacity[0], (4 * 10 + 2 * 5) * 25, 'H2 capex buys the MW of Sep 2026 - Feb 2027');
  const f = cspec(); f.revenue_model.capex.lead_months = -1;
  near(crun({}, null, f).rows.capex_capacity[0], 50 * 25, 'placed in service a month after energising (Jun-Nov; none in June)');
});
check('backstop: covers the stress only (basis "stress"), up to its cap, until its date', () => {
  eq(CB.rows.backstop_revenue, [0, 0, 0, 0, 0], 'base utilisation below 100% is not a stress');
  const a = cspec(); a.revenue_model.backstop.basis = 'all';
  const ra = crun({}, null, a).rows;
  near(ra.backstop_revenue[3], 6 * 280 * 0.05 * 12 / 12, 'basis "all": the unsold 5% of Jan-Jun 2029 bought'); near(ra.backstop_left[3], 16);
  // an upside (more capacity sold than the base) is never a negative purchase
  const hi = crun({}, { events: { up: 1 } }, capEvent(cspec(), { id: 'up', kind: 'upside', from: '2029-01', impacts: { utilization_pp: 5 } })).rows;
  assert(hi.backstop_revenue.every(x => x >= 0) && hi.unsold_mw.every(x => x >= 0) && hi.revenue[3] > CB.rows.revenue[3], JSON.stringify(hi.backstop_revenue));
  const u = cspec(); u.revenue_model.backstop.until = '2027-12';
  eq(crun({}, { events: { alpha_cut: 1 } }, u).rows.backstop_revenue, [0, 0, 0, 0, 0], 'expired before the cut');
});
check('watch list: the model path against the threshold that changes the view', () => {
  const [c1, c2] = CB.watchlist;
  eq(c1.values.map(Math.round), [58, 29, 18, 8, 5]); eq(c1.crossed, [false, true, true, true, true]); eq(c1.first_cross, 2027);
  eq([c1.modelled, c2.modelled], [true, true]);
  eq([c1.signal, c1.direction, c1.latest.value, c1.informs], ['positive', 'below', 60, ['alpha_cut']]);
  eq(c2.values, CB.rows.interest_to_ebitda); eq(c2.first_cross, null);
  eq(crun({}, { events: { markets_shut: 1 } }).watchlist[1].metric, 'interest_to_ebitda');
});
check('lifeReadout: reported profit at the policy life vs a three-year economic life', () => {
  const L = M.lifeReadout(CAPFIX, {}, { lives: [6, 3] });
  assert(!L.error, L.error);
  eq(L.lives, [6, 3]);
  for (let i = 0; i < 5; i++) { near(L.rows.da[0][i], CB.rows.da[i]); near(L.rows.net_income[1][i], crun({ useful_life: 3 }).rows.net_income[i]); }
  near(L.rows.da[1][0], L.rows.da[0][0], 'FY2026 as reported: a life change applies from adjust_from');
  for (let i = 1; i < 4; i++) assert(L.rows.da[1][i] > L.rows.da[0][i] && L.rows.net_income[1][i] < L.rows.net_income[0][i], `profit lower ${CY[i]}`);
  near(L.value_per_share[1], L.value_per_share[0], 'EBITDA-based value moves only through tax', 1e-2);
  eq(M.lifeReadout(CAPFIX, { useful_life: 5 }).lives, [5, 3], 'default: the current life vs 3 years');
});
check('scenarios carry event states: scenarioState, matchScenario, weighted', () => {
  const st = M.scenarioState(CAPFIX, 'bear');
  eq(st, { overrides: { revenue_per_mw_shift: -5, exit_ev_ebitda: 7 }, events: { slip: 1, price_war: 1, markets_shut: 1 } });
  eq(M.applyScenario(CAPFIX, 'bear'), st.overrides, 'applyScenario: drivers only (v1)');
  eq(M.matchScenario(CAPFIX, st.overrides, st.events), 'bear'); eq(M.matchScenario(CAPFIX, st.overrides), null, 'events differ');
  eq(M.matchScenario(CAPFIX, {}), 'base'); eq(M.scenarioState(CAPFIX, 'nope'), null);
  const s = cspec(); s.scenarios[0].prob = 50; s.scenarios[1].prob = 30; s.scenarios[2].prob = 20;
  const v = id => { const x = M.scenarioState(s, id); return crun(x.overrides, { events: x.events }, s).valuation.value_per_share; };
  const w = M.weighted(s, {}, 'base');
  near(w.value, 0.5 * v('base') + 0.3 * v('bear') + 0.2 * v('bull'));
  eq(w.rows.map(r => r.events), [[], ['slip', 'price_war', 'markets_shut'], ['early', 'tight_supply', 'big_contract']]);
  const t = M.weighted(s, {}, 'base', { events: { alpha_cut: 1, slip: 1 } });
  eq(t.rows.map(r => r.events), [['slip', 'alpha_cut'], ['slip', 'alpha_cut', 'price_war', 'markets_shut'], ['slip', 'alpha_cut', 'tight_supply', 'big_contract']],
    'the viewer\'s switches carry into every scenario (slip displaces early)');
  const sv = cspec(); sv.scenarios[1].events = ['slip', 'early', 'nope'];
  assert(M.validateSpec(sv).warnings.some(x => x.includes('scenario bear: event early: group delivery')) && M.validateSpec(sv).warnings.some(x => x.includes('scenario bear: event nope: unknown')));
});
check('share link carries event states and edited probabilities; hostile entries dropped', () => {
  const e = M.encodeState(CAPFIX, { utilization: -2 }, { events: { slip: 1 }, probs: { alpha_cut: 0.5, slip: 0.3 } });
  eq(JSON.parse(Buffer.from(e, 'base64url').toString()), { v: 1, m: 'fxr-capacity', o: { utilization: -2 }, e: ['slip'], p: { alpha_cut: 0.5 } }, 'unchanged probabilities are not encoded');
  const d = M.decodeState(CAPFIX, e);
  eq([d.ok, d.overrides, d.events, d.probs, d.errors], [true, { utilization: -2 }, { slip: 1 }, { alpha_cut: 0.5 }, []]);
  eq(M.encodeState(CAPFIX, {}, { events: {} }), ''); assert(M.encodeState(CAPFIX, {}, { events: ['early'] }).length > 0, 'events alone make a link');
  const raw = '{"v":1,"m":"fxr-capacity","o":{},"e":["__proto__","nope",5,"slip","early"],"p":{"__proto__":{"x":1},"slip":"x","early":9,"constructor":1}}';
  const h = M.decodeState(CAPFIX, Buffer.from(raw).toString('base64url'));
  assert(h.ok); eq(h.events, { slip: 1 }); eq(h.probs, { early: 1 });
  assert(h.errors.some(x => x.includes('probability of slip')) && h.errors.some(x => x.includes('unknown event constructor')));
  eq(({}).x, undefined); eq(Object.getPrototypeOf(h.probs), Object.prototype);
  eq(M.decodeState(CAPFIX, Buffer.from('{"v":1,"m":"fxr-capacity","o":{},"e":"slip"}').toString('base64url')).errors, ['state: events must be a list']);
});
check('v2 spec checks: growth drivers with a revenue model, capacity drivers without one; never throws', () => {
  const a = cspec(); a.drivers.push(Object.assign({}, FIX.drivers[0]));
  assert(M.validateSpec(a).warnings.some(w => w.includes('revenue_growth has no meaning with a capacity_v1 revenue_model')));
  const b = spec(); b.drivers.push(Object.assign({}, CAPFIX.drivers[0]));
  assert(M.validateSpec(b).warnings.some(w => w.includes('delivery_delay_months needs a revenue_model')));
  const c = cspec(); delete c.revenue_model.active_mw_path['2028'];
  assert(M.project(c, {}).error.includes('active_mw_path: "2028"'));
  const k = cspec(); k.revenue_model.kind = 'growth_v9';
  assert(M.project(k, {}).error.includes('unknown kind'));
  let seed = 99;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const junk = [null, -1, 0, 1e12, -1e12, NaN, 'x', [], {}, true, '2026-13', 1e-300, 'path'];
  const paths = [];
  (function walk(o, p) { for (const key of Object.keys(o)) { paths.push(p.concat([key])); if (o[key] && typeof o[key] === 'object') walk(o[key], p.concat([key])); } })(CAPFIX, []);
  for (let n = 0; n < 250; n++) {
    const s = cspec();
    for (let m = 0; m < 3; m++) {
      const p = paths[Math.floor(rnd() * paths.length)];
      let o = s;
      for (const key of p.slice(0, -1)) o = o && typeof o === 'object' ? o[key] : undefined;
      if (o && typeof o === 'object') o[p[p.length - 1]] = junk[Math.floor(rnd() * junk.length)];
    }
    let r;
    assert.doesNotThrow(() => { r = M.project(s, { delivery_delay_months: 4 }, { events: { slip: 1, alpha_cut: 1 } }); }, `mutation ${n}`);
    if (!r.error) allFinite(r, `mutation ${n}`);
    if (n % 25 === 0) assert.doesNotThrow(() => { M.distribution(s, {}, { monte_carlo: true, draws: 100 }); M.sensitivity(s, {}, {}); M.events(s); M.revenueModel(s); M.eventImpact(s, {}, 'slip'); });
  }
  for (const pick of ['min', 'max']) {
    const ov = {}; for (const d of M.drivers(CAPFIX)) ov[d.id] = d[pick];
    allFinite(crun(ov, { events: { slip: 1, alpha_cut: 1, markets_shut: 1, churn: 1, short_life: 1 } }), pick);
  }
});
check('backward compatible: growth specs have null capacity rows and the v1 pool', () => {
  for (const k of M.template('levered_growth_v1').capacity_rows) eq(BASE.rows[k], [null, null, null, null, null], k);
  eq([BASE.rows.revenue_by_customer, BASE.events_on, BASE.watchlist], [{}, [], []]);
  eq(M.events(FIX), { events: [], groups: [] }); eq(M.revenueModel(FIX), null);
  const R = BASE.rows;
  for (let i = 0; i < N; i++) {
    near(R.interest_new[i], R.interest_by_tranche[M.NEW_DEBT_ID][i] + (i === 2 ? 500 * 0.10 * 0.5 : i > 2 ? R.interest_by_tranche['notes-2028'][i] : 0), 'v1: new = pool + refinanced notes');
    near(R.debt_new_floating[i], R.debt_by_tranche[M.NEW_DEBT_ID][i] + (i >= 2 ? 500 : 0), 'the v1 pool reprices every year: floating');
  }
});
check('revenueModel(): the normalized capacity model for charts', () => {
  const m = M.revenueModel(CAPFIX);
  eq([m.kind, m.adjust_from, m.year_end_mw, m.contracted], ['capacity_v1', '2027-01', [160, 220, 280, 280, 280], CB.rows.contracted_revenue]);
  eq(m.base_active_mw.find(x => x.month === '2026-09').mw, 130);
  eq(m.customers.map(c => [c.id, c.aggregate, c.computed, c.backlog_share]), [['alpha', false, false, 0.42], ['beta', false, false, 0.3], ['gamma', false, false, 0], ['rest', true, false, 0.28], ['uncontracted', true, true, 0]]);
  eq(m.customers[0].look_through, { beta: 0.5 });
  eq([m.backstop.customer, m.backstop.cap, m.backstop.until, m.backstop.basis], ['gamma', 100, '2029-06', 'stress']);
  eq(m.sites.map(s => s.id), ['north', 'south']); eq(m.self_build.life, 25);
});
check('sell-through: uncontracted capacity left unsold bills nothing and buys fewer GPUs; contracts unchanged', () => {
  const R = crun({ sell_through: 50 }).rows, B = CB.rows;
  eq(R.contracted_revenue, B.contracted_revenue); eq(R.revenue_by_customer.alpha, B.revenue_by_customer.alpha);
  near(R.revenue[0], B.revenue[0], 'before adjust_from');
  for (let i = 1; i < 5; i++) assert(R.uncontracted_revenue[i] < 0.6 * B.uncontracted_revenue[i] && R.unsold_mw[i] > 0, `${CY[i]}`);
  assert(R.capex[1] < B.capex[1], 'unsold capacity: most of its GPU capex not spent');
  eq(crun({ sell_through: 100 }).rows.revenue, B.revenue, '100% = base');
});
check('signed leases: rent on the leased MW whether or not GPUs arrive (less sublet); self-build only beyond them', () => {
  const s = cspec(); s.revenue_model.leases.leased_mw = 280; s.revenue_model.leases.sublet_recovery = 0;
  const B = crun({}, null, s).rows, R = crun({ extra_capacity_mw: -40 }, null, s).rows;
  eq(B.idle_shell_mw, [0, 0, 0, 0, 0], 'on plan: no idle shells');
  eq(R.idle_shell_mw.map(Math.round), [0, 10, 30, 40, 40], 'the 40 MW not equipped stay leased');
  near(R.idle_rent[3], 40 * 3 * 0.5, 'idle rent = MW x cost per MW x rent share');
  near(R.rent[3], B.rent[3], 'the rent bill does not fall with the MW');
  s.revenue_model.leases.sublet_recovery = 0.5;
  near(crun({ extra_capacity_mw: -40 }, null, s).rows.idle_rent[3], 30, 'half recovered by subletting');
  const o = cspec(); o.revenue_model.leases.leased_mw = 200;
  eq(crun({ self_build_share: 100 }, null, o).rows.owned_mw.map(Math.round), [0, 20, 80, 80, 80], 'owned: only MW above the 200 leased');
  eq(crun({ self_build_share: 100 }).rows.owned_mw.map(Math.round), [0, 60, 120, 120, 120], 'no lease schedule: every new MW');
});
check('capacity released: idle for idle_months, then re-let at relet_pct (or not at all)', () => {
  const rel = x => capEvent(cspec(), { id: 'rel', from: '2027-07', impacts: { capacity_released: [Object.assign({ mw: 50, from: '2027-07', to: '2027-12', idle_months: 6 }, x)] } });
  const a = crun({}, { events: { rel: 1 } }, rel({ relet_pct: -25 })).rows, n = crun({}, { events: { rel: 1 } }, rel({})).rows, B = CB.rows;
  near(a.revenue[0], B.revenue[0]); assert(a.revenue[1] < B.revenue[1]);
  near(B.revenue[3] - n.revenue[3], 50 * 12, 'never re-let: 50 MW x US$12m lost');
  near(B.revenue[3] - a.revenue[3], 50 * 12 * 0.25, 're-let at -25%: a quarter of it lost');
  eq(M.events(rel({})).events.find(e => e.id === 'rel').impacts.capacity_released, [{ mw: 50, from: '2027-07', to: '2027-12', idle_months: 6, relet_pct: null }]);
});
check('event until: price, rate and funding impacts stop at the month given', () => {
  const s = capEvent(cspec(), { id: 'px', from: '2027-01', until: '2028-01', impacts: { revenue_per_mw_pct: 10 } });
  const R = crun({}, { events: { px: 1 } }, s).rows;
  assert(R.revenue[1] > CB.rows.revenue[1]);
  for (let i = 2; i < 5; i++) near(R.revenue[i], CB.rows.revenue[i], `stopped ${CY[i]}`);
  eq(M.events(s).events.find(e => e.id === 'px').until, '2028-01');
  const bad = capEvent(cspec(), { id: 'px', from: '2027-01', until: '2026-01', impacts: { revenue_per_mw_pct: 10 } });
  assert(M.validateSpec(bad).warnings.some(w => w.includes('event px: until must be a YYYY-MM after from')));
});
check('funding: a gap that cannot be borrowed defers builds ("defer_build"), or costs the penalty rate', () => {
  const s = cspec(); s.funding.when_short = 'defer_build'; s.funding.shortfall_penalty_pp = 5;
  const D = crun({}, { events: { markets_shut: 1 } }, s), N = crun({}, { events: { markets_shut: 1 } });
  assert(N.liquidity.min < 0 && D.liquidity.min > 0, `liquidity ${N.liquidity.min} -> ${D.liquidity.min}`);
  assert(D.rows.mw_deferred[1] > 10 && D.rows.active_mw_end[1] < CB.rows.active_mw_end[1], 'MW deferred in 2027');
  eq(D.rows.active_mw_end.slice(3), [280, 280], 'built a year later');
  assert(sumA(D.rows.funding_shortfall) < 0.05 * sumA(N.rows.funding_shortfall), 'the gap closes');
  assert(D.warnings.some(w => /defers \d+ MW in 2027/.test(w)));
  const p = cspec(); p.funding.shortfall_penalty_pp = 5;
  const Pn = crun({}, { events: { markets_shut: 1 } }, p).rows;
  assert(Pn.shortfall_interest[1] > 0 && Pn.interest[2] > N.rows.interest[2], 'unfunded need pays the penalty rate');
  eq(N.rows.shortfall_interest, [0, 0, 0, 0, 0], 'no penalty set: none');
});
check('run-rate covenants: debt over Q4 EBITDA x 4; quarters add up to the projected year', () => {
  const R = CB.rows;
  for (let i = 0; i < 5; i++) near(R.gross_debt_ebitda_lqa[i], R.debt_end[i] / R.ebitda_exit_rate[i], `LQA ${CY[i]}`, 1e-9);
  near(R.ebitda_exit_rate[1], (R.revenue_q4[1] - R.cost_of_revenue_q4[1] - R.opex[1] / R.revenue[1] * R.revenue_q4[1]) * 4, 'Q4 x 4 at the year\'s opex ratio', 1e-9);
  const Q = CB.quarters;
  eq(Q.map(q => q.quarter).slice(0, 3), ['2026-Q3', '2026-Q4', '2027-Q1']);
  for (let i = 1; i < 5; i++) near(sumA(Q.filter(q => q.quarter.startsWith(String(CY[i]))).map(q => q.revenue)), R.revenue[i], `quarters ${CY[i]}`, 1e-9);
  near(Q[0].revenue + Q[1].revenue, R.revenue[0] - CAPFIX.stub.actuals.revenue, 'H2 2026', 1e-9);
});
check('distribution: regimes keep marginals, drawn drivers, chunked job = one call, outcomes cached across calls', () => {
  const s = cspec();
  s.regimes = { states: [{ id: 'up', name: 'Up', p: 0.5, lift: { alpha_cut: 0.5, price_war: 0.5 }, drivers: { exit_ev_ebitda: 12 } },
    { id: 'down', name: 'Down', p: 0.5, lift: { alpha_cut: 1.5, price_war: 1.5 }, drivers: { exit_ev_ebitda: 8 } }] };
  s.uncertainty = { drivers: ['utilization'] };
  const j = M.distributionJob(s, {});
  let n = 0; while (!j.step(2)) n++;
  const a = j.result(), b = M.distribution(s, {});
  assert(n > 1, 'ran in slices'); eq(a.metrics.value_per_share.mean, b.metrics.value_per_share.mean, 'same answer');
  eq([a.method, a.uncertainty], ['monte_carlo', ['utilization', 'exit_ev_ebitda']]);
  assert(a.regimes[0].mean > a.regimes[1].mean, 'the up regime is worth more');
  for (const e of a.events) assert(Math.abs(e.p_on - e.prob) < 0.04, `${e.id}: marginal kept (${e.p_on} vs ${e.prob})`);
  // exact enumeration, cached: a probability edit re-weights the same states
  const x0 = M.distribution(CAPFIX, { utilization: -1 }), x1 = M.distribution(CAPFIX, { utilization: -1 }, { probs: { alpha_cut: 0.9 } });
  eq([x0.method, x1.evaluated], ['exact', 0]); assert(x1.metrics.value_per_share.mean < x0.metrics.value_per_share.mean);
  const bad = cspec(); bad.regimes = { states: [{ id: 'x', p: 2, lift: { nope: 2 } }] };
  assert(M.distribution(bad, {}).warnings.some(w => w.includes('lift nope')));
});
check('performance: 12-event distribution < 300 ms; tornado with events < 80 ms', () => {
  const s = cspec();
  for (const e of s.events) delete e.group;
  capEvent(s, { id: 'opex_creep', prob: 0.2, from: '2027-01', impacts: { cor_per_mw_pct: 5 } });
  eq(s.events.length, 12);
  const time = f => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  for (let k = 0; k < 4; k++) M.distribution(s, { utilization: -k });          // JIT warm-up (the first runs are several times slower)
  const td = [0, 1, 2].map(k => time(() => { const d = M.distribution(s, { utilization: -k }); assert(d.method === 'exact' && d.states === 4096); })).sort((a, b) => a - b);
  for (let k = 0; k < 3; k++) M.sensitivity(CAPFIX, { utilization: -k }, {});
  const tt = [0, 1, 2, 3, 4].map(k => time(() => M.sensitivity(CAPFIX, { utilization: -k }, {}))).sort((a, b) => a - b);
  assert(td[1] < 300, `distribution median ${td[1].toFixed(0)} ms`);
  assert(tt[2] < 80, `tornado median ${tt[2].toFixed(1)} ms`);
  console.log(`  distribution (4,096 states) median ${td[1].toFixed(0)} ms; tornado with ${CAPFIX.events.length} events median ${tt[2].toFixed(1)} ms`);
});

if (fs.existsSync(CRWV_PATH)) check('performance: the CoreWeave distribution (2,000 draws, 24 events, 3 regimes) and tornado within budget', () => {
  const C = JSON.parse(fs.readFileSync(CRWV_PATH, 'utf8'));
  const time = f => { const t0 = process.hrtime.bigint(); f(); return Number(process.hrtime.bigint() - t0) / 1e6; };
  M.distribution(C, { utilization: -1 });                                       // warm-up
  const td = [2, 3, 4].map(k => time(() => M.distribution(C, { utilization: -k }))).sort((a, b) => a - b);
  const tt = [0, 1, 2].map(k => time(() => M.sensitivity(C, { utilization: -k }, {}))).sort((a, b) => a - b);
  const tp = [0, 1, 2].map(k => time(() => M.project(C, { utilization: -k }))).sort((a, b) => a - b);
  assert(td[1] < 2500, `distribution median ${td[1].toFixed(0)} ms`);
  assert(tt[1] < 600, `tornado median ${tt[1].toFixed(0)} ms`);
  assert(tp[1] < 25, `one projection (a slider frame) ${tp[1].toFixed(1)} ms`);
  console.log(`  crwv: distribution median ${td[1].toFixed(0)} ms; tornado ${tt[1].toFixed(0)} ms; projection ${tp[1].toFixed(1)} ms`);
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
