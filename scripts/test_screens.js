#!/usr/bin/env node
// Screen DSL tests (Node, zero dependencies): the parity vectors shared with
// tests/test_screens.py, the JS-only parser / growth-guard / chip vectors, registry
// sanity checks, the browser (UMD) load path, and a guard against duplicate top-level
// names across dashboard/*.js (classic scripts share one global scope — a duplicate
// `const` kills the later file, a duplicate `function` silently replaces the earlier one).
//
//   node scripts/test_screens.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const DSL_PATH = path.join(ROOT, 'dashboard', 'screen-dsl.js');
const REG_PATH = path.join(ROOT, 'dashboard', 'screen_fields.json');
const D = require(DSL_PATH);
const REG = JSON.parse(fs.readFileSync(REG_PATH, 'utf8'));
const V = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'screen_vectors.json'), 'utf8'));
const FIX = {
  stocks: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'screen_stocks.json'), 'utf8')),
  markets: JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'screen_markets.json'), 'utf8')),
};

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);

// {"$num": "NaN"} -> NaN etc. (JSON can't carry non-finite numbers)
function revive(x) {
  if (Array.isArray(x)) return x.map(revive);
  if (x && typeof x === 'object') {
    const ks = Object.keys(x);
    if (ks.length === 1 && ks[0] === '$num') return Number(x.$num);
    const o = {};
    for (const k of ks) Object.defineProperty(o, k, { value: revive(x[k]), enumerable: true, writable: true, configurable: true });
    return o;
  }
  return x;
}

// ---- shared parity vectors ----
for (const t of V.validate) {
  check(`validate: ${t.name}`, () => {
    const r = D.validate(t.filter, t.scope);
    for (const k of Object.keys(t.expect)) eq(r[k], t.expect[k], `${k}: ${JSON.stringify(r[k])}`);
  });
}
for (const t of V.evaluate) {
  check(`evaluate: ${t.name}`, () => {
    const rows = t.rows ? revive(t.rows) : FIX[t.fixture];
    const scope = t.scope || t.fixture;
    const r = D.evaluate(t.filter, rows);
    eq(r.rows.map(x => D.rowKey(x, scope)), t.expect.keys, `keys: ${JSON.stringify(r.rows.map(x => D.rowKey(x, scope)))}`);
    eq(r.total, t.expect.total, `total: ${r.total}`);
  });
}
check('presets: every preset validates in its own scope', () => {
  const ids = new Set();
  for (const p of REG.presets) {
    assert(!ids.has(p.id), `duplicate preset id ${p.id}`);
    ids.add(p.id);
    assert(REG.scopes.includes(p.scope), `${p.id}: scope`);
    const r = D.validate(p.filter, p.scope);
    assert(r.ok, `${p.id}: ${r.errors.join('; ')}`);
    const used = r.filter.where.map(c => c.field).concat(r.filter.sort ? [r.filter.sort.field] : []);
    assert(!used.includes('opportunity_score'), `${p.id} uses opportunity_score`);
  }
  for (const [scope, names] of [['stocks', ['Quality on sale', 'Steady compounders', 'Deep value intact', 'Cheap + growing', 'High dividend']],
    ['markets', ['Quality on sale', 'Deep value intact', 'Cheap + growing', 'High dividend', 'Cheapest']]]) {
    eq(D.presets(scope).map(p => p.name), names, `${scope} presets`);
  }
});
check('presets: Cheap + growing (stocks) runs on the fixture', () => {
  const p = D.presets('stocks').find(x => x.id === 'stk_cheap_growing');
  const r = D.evaluate(p.filter, FIX.stocks);
  eq(r.rows.map(x => x.ticker), ['FXA']);
});

// ---- JS-only: parser, growth guard, chips ----
const PRICE_SIGNAL = new Set(REG.fields.filter(f => f.price_signal).map(f => f.key));
const GROWTH = new Set(REG.fields.filter(f => f.growth).map(f => f.key));
for (const t of V.parse) {
  check(`parse: ${t.name}`, () => {
    const r = D.ruleParse(t.sentence, t.scope, t.current);
    const e = t.expect;
    if (e.filter_null) { eq(r.filter, null); }
    else {
      assert(r.filter, 'filter is null: ' + JSON.stringify(r.notes));
      const ok = D.validate(r.filter, t.scope);
      assert(ok.ok, 'parser output does not validate: ' + ok.errors.join('; '));
      const used = r.filter.where.map(c => c.field).concat(r.filter.sort ? [r.filter.sort.field] : []);
      if ('where' in e) eq(r.filter.where, e.where, 'where: ' + JSON.stringify(r.filter.where));
      if ('sort' in e) eq(r.filter.sort, e.sort, 'sort: ' + JSON.stringify(r.filter.sort));
      if ('limit' in e) eq(r.filter.limit, e.limit);
      if ('include_flagged' in e) eq(r.filter.include_flagged, e.include_flagged);
      for (const k of e.fields_include || []) assert(used.includes(k), `missing field ${k}: ${JSON.stringify(used)}`);
      for (const k of e.fields_exclude || []) assert(!used.includes(k), `unexpected field ${k}`);
      if (e.no_price_signal) assert(!used.some(k => PRICE_SIGNAL.has(k)), 'price_signal field used: ' + JSON.stringify(used));
      if (e.has_growth) assert(used.some(k => GROWTH.has(k)), 'no growth field: ' + JSON.stringify(used));
      if ('guard_ok' in e) eq(D.growthGuard(t.sentence, r.filter, t.current).ok, e.guard_ok, 'growthGuard');
    }
    if ('unparsed' in e) eq(r.unparsed, e.unparsed, 'unparsed: ' + JSON.stringify(r.unparsed));
    if ('notes' in e) eq(r.notes, e.notes, 'notes: ' + JSON.stringify(r.notes));
    for (const s of e.notes_include || []) assert(r.notes.some(n => n.includes(s)), `no note containing "${s}": ${JSON.stringify(r.notes)}`);
  });
}
for (const t of V.guard) {
  check(`growthGuard: ${t.name}`, () => {
    const r = D.growthGuard(t.sentence, t.filter, t.current);
    eq(r.ok, t.ok, r.reason);
    if (!r.ok) assert(r.reason.length > 0);
  });
}
V.describe.forEach((t, i) => check(`describe #${i}`, () => eq(D.describe(t.filter, t.opts), t.expect)));

check('parser never maps growth words to price signals (sweep)', () => {
  const sentences = ['growth', 'growing', 'fast growing', 'fastest growing', 'high growth', 'strong growth', 'growth stocks',
    'growing companies with momentum', 'compounding', 'expanding businesses', 'grew the most', 'cheap and growing',
    'consistent growers', 'revenue growing', 'growing earnings', 'growth with good returns', 'best growth performers'];
  for (const scope of ['stocks', 'markets']) {
    for (const s of sentences) {
      const r = D.ruleParse(s, scope);
      const used = r.filter.where.map(c => c.field).concat(r.filter.sort ? [r.filter.sort.field] : []);
      assert(!used.some(k => PRICE_SIGNAL.has(k)), `${scope} "${s}" -> ${JSON.stringify(used)}`);
      assert(used.some(k => GROWTH.has(k)), `${scope} "${s}" has no growth field -> ${JSON.stringify(used)}`);
      assert(D.growthGuard(s, r.filter).ok, `${scope} "${s}" fails its own guard`);
    }
  }
});
check('parser survives hostile input', () => {
  for (const s of [null, undefined, 42, {}, '', '((((', '\\', '$$$ ^^^ [[[', 'x'.repeat(5000), '\u0000\u0000', '<script>alert(1)</script>']) {
    const r = D.ruleParse(s, 'stocks');
    assert(D.validate(r.filter).ok, `output for ${JSON.stringify(s)} not valid`);
    assert(r.unparsed.every(u => typeof u === 'string' && u.length <= 80));
  }
  eq(D.ruleParse('cheap', '__proto__').filter, null);
  eq(D.ruleParse('cheap', 'constructor').filter, null);
});
check('diff reports added / removed / changed chips', () => {
  const a = { scope: 'stocks', where: [{ field: 'pe', op: '<', value: 20 }, { field: 'sector', op: 'in', value: ['Technology'] }] };
  const b = { scope: 'stocks', where: [{ field: 'pe', op: '<', value: 12 }, { field: 'on_sale', op: 'is_true' }], sort: { field: 'pe', dir: 'asc' } };
  eq(D.diff(a, b), { added: ['Quality on sale', 'Sorted by P/E ↑'], removed: ['Sector: Technology'], changed: ['P/E < 12'] });
});
check('share-link round trip re-validates', () => {
  const f = { scope: 'markets', where: [{ field: 'region', op: 'in', value: ['asia'] }], sort: { field: 'value_score', dir: 'desc' } };
  const s = D.encodeFilter(f);
  assert(/^[A-Za-z0-9_-]+$/.test(s));
  eq(D.decodeFilter(s, 'markets').filter, D.validate(f).filter);
  eq(D.decodeFilter(s, 'stocks').ok, false);
  eq(D.decodeFilter('not base64 !!', 'markets').ok, false);
  eq(D.decodeFilter(Buffer.from('{"scope":"stocks","where":[{"field":"__proto__"}]}').toString('base64url')).ok, false);
});
check('CSV export is formula-safe', () => {
  const csv = D.toCSV([{ ticker: '=HYPERLINK("x")', name: '+cmd', pe: -5, note: '@SUM(A1)', strategies: ['on_sale'] }],
    ['ticker', 'name', 'pe', 'note', 'strategies']);
  eq(csv, 'ticker,name,pe,note,strategies\r\n"\'=HYPERLINK(""x"")",\'+cmd,-5,\'@SUM(A1),on_sale');
});

// ---- registry sanity ----
check('registry: shape, groups, types, unique keys', () => {
  const keys = new Set();
  for (const f of REG.fields) {
    assert(!keys.has(f.key), `duplicate field ${f.key}`); keys.add(f.key);
    assert(REG.groups.includes(f.group), `${f.key}: group ${f.group}`);
    assert(REG.type_ops[f.list ? 'list' : f.type], `${f.key}: type ${f.type}`);
    assert(f.scopes.length && f.scopes.every(s => REG.scopes.includes(s)), `${f.key}: scopes`);
    assert(f.label && f.short && f.help, `${f.key}: label/short/help`);
    assert(!(f.growth && f.price_signal), `${f.key}: growth AND price_signal`);
    if (f.type === 'enum') {
      const seen = new Map();
      for (const v of f.enum) seen.set(v.toLowerCase(), v);
      for (const v of Object.keys(f.enum_synonyms || {})) {
        assert(f.enum.includes(v), `${f.key}: synonym key ${v} not an enum value`);
        for (const s of f.enum_synonyms[v]) {
          const prev = seen.get(s.toLowerCase());
          assert(!prev || prev === v, `${f.key}: synonym '${s}' maps to both ${prev} and ${v}`);
          seen.set(s.toLowerCase(), v);
        }
      }
    }
  }
});
check('registry: growth / price_signal sets are exactly the agreed ones (ADR-037)', () => {
  eq([...GROWTH].sort(), ['consistency_score', 'earnings_growth', 'fundamentally_strong', 'fwd_growth', 'garp', 'growth_score', 'ni_cagr',
    'ni_pos_ratio', 'ni_up_ratio', 'rev_cagr', 'rev_growth', 'rev_up_ratio', 'steady_compounder']);
  eq([...PRICE_SIGNAL].sort(), ['discount_long', 'opportunity_score', 'price', 'turning_up', 'value_trap']);
  for (const k of ['turning_up', 'value_trap', 'price', 'discount_long']) eq(D.field(k).group, 'Price position');
  for (const k of ['consistency_score', 'rev_cagr', 'ni_cagr', 'rev_up_ratio', 'ni_up_ratio', 'ni_pos_ratio', 'hist_years', 'steady_compounder']) {
    eq(D.field(k).scopes, ['stocks'], `${k} must be stocks-only`);
  }
  const fieldKeys = REG.fields.map(f => f.key);
  for (const k of ['momentum_score', 'ret_1m', 'ret_3m', 'ret_6m', 'ret_12m', 'mean_reversion_score']) assert(!fieldKeys.includes(k), `${k} exposed`);
  assert(/not a growth measure/.test(D.field('opportunity_score').help));
});
check('registry: stock sectors are the sic_map names, not GICS', () => {
  eq(D.field('sector').enum.slice().sort(), ['Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy', 'Financials',
    'Healthcare', 'Industrials', 'Materials', 'Real Estate', 'Technology', 'Unknown', 'Utilities']);
});
check('registry: enum values cover the real public data (dashboard_data.json)', () => {
  const p = path.join(ROOT, 'dashboard', 'dashboard_data.json');
  if (!fs.existsSync(p)) return;
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  const sb = d.scoreboard || [];
  for (const k of ['region', 'development', 'kind', 'country']) {
    const vals = new Set(sb.map(r => r[k]).filter(v => v != null));
    for (const v of vals) assert(D.field(k).enum.includes(v), `scoreboard ${k} '${v}' missing from the registry enum`);
  }
  const marketKeys = REG.fields.filter(f => f.scopes.includes('markets')).map(f => f.key).filter(k => k !== 'data_ok');
  for (const k of marketKeys) assert(sb.length && sb.every(r => k in r), `market field '${k}' not in every scoreboard row`);
  const stocks = Object.values(d.stock_breakdown || {}).flat();
  for (const k of ['sector', 'country']) {
    for (const v of new Set(stocks.map(r => r[k]).filter(v => v != null))) assert(D.field(k).enum.includes(v), `stock ${k} '${v}' missing`);
  }
});
check('fixtures: synthetic tickers only, every stock field present', () => {
  const stockKeys = REG.fields.filter(f => f.scopes.includes('stocks')).map(f => f.key);
  for (const r of FIX.stocks) {
    assert(/^FX[A-Z]$/.test(r.ticker), `non-synthetic ticker ${r.ticker}`);
    for (const k of stockKeys) assert(k in r, `${r.ticker} lacks ${k}`);
  }
  const sectors = new Set(FIX.stocks.map(r => r.sector));
  for (const v of D.field('sector').enum) assert(sectors.has(v), `fixture lacks sector ${v}`);
  for (const r of FIX.markets) assert(/^fx_/.test(r.key) && /^FX[A-Z]{2}$/.test(r.symbol), `non-synthetic market ${r.key}`);
});

// ---- browser path: UMD defines exactly one global ----
check('browser load defines only window.ScreenDSL', () => {
  const src = fs.readFileSync(DSL_PATH, 'utf8');
  let fetched = null;
  const ctx = { fetch: url => { fetched = url; return Promise.resolve({ ok: true, json: () => Promise.resolve(JSON.parse(JSON.stringify(REG))) }); } };
  ctx.self = ctx;
  vm.createContext(ctx);
  const before = new Set(Object.keys(ctx));
  vm.runInContext(src, ctx, { filename: 'screen-dsl.js' });
  const added = Object.keys(ctx).filter(k => !before.has(k));
  eq(added, ['ScreenDSL']);
  eq(ctx.ScreenDSL.isReady(), false);
  eq(ctx.ScreenDSL.validate({ scope: 'stocks' }).ok, false);
  return ctx.ScreenDSL.load().then(api => {
    eq(fetched, 'screen_fields.json');
    assert(api.validate({ scope: 'stocks', where: [{ field: 'pe', op: '<', value: 1 }] }).ok);
  }).catch(e => { failed++; passed--; console.log('FAIL browser load async: ' + e.message); });
});

// ---- dashboard/*.js: no duplicate top-level names across files ----
const ONE_BINDING = { 'screenbox.js': 'ScreenBox', 'screener.js': 'Screener', 'charts.js': 'Charts', 'lists.js': 'Lists' };
function topLevelNames(src) {
  const names = [];
  const re = /^(?:export\s+)?(?:const|let|var|class|function\*?|async\s+function\*?)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(src))) names.push(m[1]);
  // top-level destructuring: const { a, b } = ... / const [a, b] = ...
  const dre = /^(?:const|let|var)\s*[{[]([^}\]]*)[}\]]\s*=/gm;
  while ((m = dre.exec(src))) for (const part of m[1].split(',')) {
    const n = part.split(':').pop().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(n)) names.push(n);
  }
  return names;
}
check('dashboard/*.js: no duplicate top-level declarations across files', () => {
  const dir = path.join(ROOT, 'dashboard');
  const owner = new Map(), dups = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()) {
    const names = topLevelNames(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (f === 'screen-dsl.js' || f === 'reports.js') eq(names, [], `${f} must declare no top-level name (UMD only)`);
    if (ONE_BINDING[f]) eq(names, [ONE_BINDING[f]], `${f} must declare exactly one top-level binding`);
    const seen = new Set();
    for (const n of names) {
      if (seen.has(n)) dups.push(`${n} twice in ${f}`);
      seen.add(n);
      if (owner.has(n) && owner.get(n) !== f) dups.push(`${n} in ${owner.get(n)} and ${f}`);
      else owner.set(n, f);
    }
  }
  eq(dups, []);
});

setImmediate(() => {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
});
