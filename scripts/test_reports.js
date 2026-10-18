#!/usr/bin/env node
// Key reports tests (Node, zero dependencies):
//  - schema v1 validation of every dashboard/reports/<slug>.json, of reports/index.json
//    against those files, and of the synthetic fixture tests/fixtures/reports/sample.json
//    (Fixture Corp, FXR). A report that isn't written yet is simply absent — nothing is
//    skipped silently once it exists;
//  - the validator itself, on broken copies of the fixture;
//  - dashboard/reports.js: the inline-markup parser, and the renderer driven through a
//    minimal fake DOM whose innerHTML setter throws — so report text can only ever reach
//    the page as text nodes, and only whitelisted attributes / https: links come out;
//  - the stress-test model behind a {"type":"model","src":"<slug>"} block: its file
//    (dashboard/reports/models/<src>.json; the fixture's in tests/fixtures/models/) against
//    MODEL SPEC v1 + the template's driver ids, citations against the PARENT report's sources;
//    the lazy mount wiring (assets loaded once, model fetched, state passed through);
//  - wiring: index.html loads it, .vercelignore does not drop dashboard/reports.
//
//   node scripts/test_reports.js
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const DASH = path.join(ROOT, 'dashboard');
const RDIR = path.join(DASH, 'reports');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'reports', 'sample.json');
const MDIR = path.join(RDIR, 'models');
const FIX_MDIR = path.join(ROOT, 'tests', 'fixtures', 'models');
const R = require(path.join(DASH, 'reports.js'));
const ME = require(path.join(DASH, 'model-engine.js'));

// Checks run one at a time, in order (the DOM tests swap globals, so none may overlap).
let passed = 0, failed = 0;
const queue = [];
const check = (name, fn) => queue.push([name, fn]);
const eq = (a, b, msg) => assert.deepStrictEqual(a, b, msg);
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- schema v1
const SLUG_RE = /^[a-z0-9-]{1,40}$/;
const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;            // kebab
const SRC_ID_RE = /^s\d{1,3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;
const TV_SYMBOL_RE = /^[A-Z]{2,10}:[A-Z0-9.]{1,12}$/;
const CITE_RE = /\[(s\d{1,3}(?:\s*,\s*s\d{1,3})*)\]/g;
const LOOSE_CITE_RE = /\[\s*[sS]\d[^\]]*\]/g;          // anything that looks like a citation
const HTML_TAG_RE = /<\s*\/?\s*[A-Za-z!?]/;              // '<b', '</p', '<!--', '<?' — but '< 5%' is fine
const STANCE = ['Positive', 'Neutral', 'Cautious'];
const RISK = ['Low', 'Medium', 'High', 'Very high'];
const TYPES = ['Initiation', 'Update', 'Deep dive'];
const SCEN = ['Bear', 'Base', 'Bull'];                  // required, one each
const SCEN_OPT = ['Restructuring'];                      // optional tail case (equity ≈ 0), at most one
const TONES = ['info', 'positive', 'risk'];
// Project rule: "growth" always means fundamental growth — never a price move.
const PRICE_GROWTH_RE = /\b(share[- ]price|stock[- ]price|price|momentum)\s+growth\b/i;
// Licensing rule: a published price / market cap / multiple must cite a public source.
const PRICEISH_RE = /\b(price|market cap|market value|52[- ]week|enterprise value|EV\b|EV\s*\/|P\/E|P\/S|P\/B|multiple|short interest|dividend yield|total return)/i;

const TOP_KEYS = {
  v: 1, slug: 1, ticker: 1, exchange: 1, company: 1, title: 1, subtitle: 1, published: 1, data_asof: 1, author: 1,
  sector: 1, report_type: 1, stance: 1, key_stats: 1, highlights: 1, sections: 1, sources: 1, disclosures: 1,
};
const BLOCK_KEYS = {
  p: { req: ['text'], opt: [] },
  bullets: { req: ['items'], opt: [] },
  table: { req: ['caption', 'columns', 'rows'], opt: ['align', 'note', 'src'] },
  bars: { req: ['title', 'unit', 'labels', 'series'], opt: ['src'] },
  callout: { req: ['tone', 'title', 'text'], opt: [] },
  scenarios: { req: ['rows'], opt: [] },
  kv: { req: ['items'], opt: [] },
  chart: { req: ['symbol'], opt: [] },
  model: { req: ['src'], opt: [] },
};

// A source page that gives only a month ('2025-09') is dated by month; never a bare year.
function validMonth(s) {
  const m = /^(\d{4})-(\d{2})$/.exec(s);
  return !!m && +m[2] >= 1 && +m[2] <= 12;
}
function validDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

function validateReport(r, { file } = {}) {
  const errs = [];
  const err = (where, msg) => errs.push(`${where}: ${msg}`);
  const isStr = v => typeof v === 'string' && v.trim().length > 0;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const keysOnly = (o, allowed, where) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) err(where, `unknown key "${k}"`); };
  if (!isObj(r)) return ['report: not an object'];

  keysOnly(r, Object.keys(TOP_KEYS), 'report');
  if (r.v !== 1) err('v', 'must be 1');
  if (!isStr(r.slug) || !SLUG_RE.test(r.slug)) err('slug', 'must match /^[a-z0-9-]{1,40}$/');
  if (file && r.slug !== path.basename(file, '.json')) err('slug', `"${r.slug}" does not match the file name ${path.basename(file)}`);
  if (!isStr(r.ticker) || !TICKER_RE.test(r.ticker)) err('ticker', 'must be an upper-case ticker');
  for (const k of ['exchange', 'company', 'title', 'subtitle', 'author', 'sector']) if (!isStr(r[k])) err(k, 'required non-empty string');
  if (!isStr(r.published) || !validDate(r.published)) err('published', 'must be a real YYYY-MM-DD date');
  if (!isStr(r.data_asof) || !validDate(r.data_asof)) err('data_asof', 'must be a real YYYY-MM-DD date');
  if (validDate(r.published || '') && validDate(r.data_asof || '') && r.data_asof > r.published) err('data_asof', 'is after published');
  if (!TYPES.includes(r.report_type)) err('report_type', `must be one of ${TYPES.join(' | ')}`);

  if (!isObj(r.stance)) err('stance', 'required object');
  else {
    keysOnly(r.stance, ['label', 'risk', 'horizon', 'summary'], 'stance');
    if (!STANCE.includes(r.stance.label)) err('stance.label', `must be one of ${STANCE.join(' | ')}`);
    if (!RISK.includes(r.stance.risk)) err('stance.risk', `must be one of ${RISK.join(' | ')}`);
    if (!isStr(r.stance.horizon)) err('stance.horizon', 'required string');
    if (!isStr(r.stance.summary)) err('stance.summary', 'required string');
  }

  // sources first: everything else cites them.
  const ids = new Set();
  if (!Array.isArray(r.sources) || !r.sources.length) err('sources', 'required non-empty array');
  else r.sources.forEach((s, i) => {
    const w = `sources[${i}]`;
    if (!isObj(s)) { err(w, 'not an object'); return; }
    keysOnly(s, ['id', 'title', 'publisher', 'date', 'url'], w);
    if (!isStr(s.id) || !SRC_ID_RE.test(s.id)) err(w, 'id must look like s1');
    else if (ids.has(s.id)) err(w, `duplicate id ${s.id}`);
    else ids.add(s.id);
    if (!isStr(s.title)) err(w, 'title required');
    if (!isStr(s.publisher)) err(w, 'publisher required');
    if (typeof s.date !== 'string' || (s.date !== '' && !validDate(s.date) && !validMonth(s.date))) err(w, 'date must be YYYY-MM-DD, YYYY-MM or ""');
    let u = null;
    try { u = new URL(s.url); } catch { u = null; }
    if (!u || u.protocol !== 'https:' || !/^https:\/\//.test(s.url)) err(w, `url must be https: (${s.url})`);
  });
  const cited = new Set();
  const srcRef = (v, where, { array }) => {
    const list = array ? v : [v];
    if (array && !Array.isArray(v)) { err(where, 'src must be an array of source ids'); return; }
    if (!array && typeof v !== 'string') { err(where, 'src must be one source id string'); return; }
    for (const id of list) { if (!ids.has(id)) err(where, `src "${id}" is not in sources`); else cited.add(id); }
  };

  // Every string in the report except source URLs: no HTML, well-formed markup, known
  // citations, no price-as-growth wording.
  const walk = (v, where) => {
    if (typeof v === 'string') {
      if (/\.url$/.test(where)) return;
      if (HTML_TAG_RE.test(v)) err(where, 'contains a raw HTML tag (only **bold** and [sN] markers are allowed)');
      if ((v.match(/\*\*/g) || []).length % 2) err(where, 'unbalanced ** (bold markers come in pairs)');
      const good = new Set();
      for (const m of v.matchAll(CITE_RE)) {
        good.add(m.index);
        for (const id of m[1].split(',').map(x => x.trim())) { if (!ids.has(id)) err(where, `citation [${id}] is not in sources`); else cited.add(id); }
      }
      for (const m of v.matchAll(LOOSE_CITE_RE)) if (!good.has(m.index)) err(where, `malformed citation ${m[0]} (use [s3] or [s3,s5])`);
      if (PRICE_GROWTH_RE.test(v)) err(where, `"${v.match(PRICE_GROWTH_RE)[0]}": growth means fundamentals — call price moves "share-price performance"`);
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (isObj(v)) for (const k of Object.keys(v)) walk(v[k], `${where}.${k}`);
  };
  walk(r, 'report');

  if (!Array.isArray(r.key_stats) || r.key_stats.length < 6 || r.key_stats.length > 10) err('key_stats', 'needs 6-10 entries');
  else r.key_stats.forEach((s, i) => {
    const w = `key_stats[${i}]`;
    if (!isObj(s)) { err(w, 'not an object'); return; }
    keysOnly(s, ['label', 'value', 'note', 'src'], w);
    if (!isStr(s.label) || !isStr(s.value)) err(w, 'label and value required');
    if (s.note != null && typeof s.note !== 'string') err(w, 'note must be a string');
    if (s.src != null) srcRef(s.src, w, { array: false });
    else if (PRICEISH_RE.test(s.label || '')) err(w, `"${s.label}" is market data: it must cite a public source (src)`);
  });
  if (!Array.isArray(r.highlights) || r.highlights.length < 3 || r.highlights.length > 6 || !r.highlights.every(isStr)) err('highlights', 'needs 3-6 strings');
  if (!Array.isArray(r.disclosures) || !r.disclosures.length || !r.disclosures.every(isStr)) err('disclosures', 'needs at least one string');

  const secIds = new Set();
  if (!Array.isArray(r.sections) || !r.sections.length) err('sections', 'required non-empty array');
  else r.sections.forEach((sec, i) => {
    const w = `sections[${i}]`;
    if (!isObj(sec)) { err(w, 'not an object'); return; }
    keysOnly(sec, ['id', 'title', 'blocks'], w);
    if (!isStr(sec.id) || !ID_RE.test(sec.id)) err(w, 'id must be kebab-case');
    else if (secIds.has(sec.id)) err(w, `duplicate id ${sec.id}`);
    else secIds.add(sec.id);
    if (sec.id === 'sources') err(w, 'id "sources" is reserved');
    if (!isStr(sec.title)) err(w, 'title required');
    if (!Array.isArray(sec.blocks) || !sec.blocks.length) { err(w, 'blocks: required non-empty array'); return; }
    sec.blocks.forEach((b, j) => validateBlock(b, `${w}.blocks[${j}]`, { err, isStr, isObj, keysOnly, srcRef }));
  });
  return errs;
}

function validateBlock(b, w, { err, isStr, isObj, keysOnly, srcRef }) {
  if (!isObj(b)) { err(w, 'not an object'); return; }
  const spec = BLOCK_KEYS[b.type];
  if (!spec) { err(w, `unknown block type "${b.type}"`); return; }
  keysOnly(b, ['type', ...spec.req, ...spec.opt], w);
  for (const k of spec.req) if (b[k] == null) err(w, `${b.type}: "${k}" required`);
  const strs = (v, k) => { if (!Array.isArray(v) || !v.length || !v.every(isStr)) err(w, `${k} must be a non-empty array of strings`); };
  switch (b.type) {
    case 'p': if (!isStr(b.text)) err(w, 'text required'); break;
    case 'bullets': strs(b.items, 'items'); break;
    case 'callout':
      if (!TONES.includes(b.tone)) err(w, `tone must be one of ${TONES.join(' | ')}`);
      if (!isStr(b.title) || !isStr(b.text)) err(w, 'title and text required');
      break;
    case 'table': {
      if (!isStr(b.caption)) err(w, 'caption required');
      strs(b.columns, 'columns');
      const n = Array.isArray(b.columns) ? b.columns.length : 0;
      if (!Array.isArray(b.rows) || !b.rows.length) err(w, 'rows must be a non-empty array');
      else b.rows.forEach((row, i) => {
        if (!Array.isArray(row) || row.length !== n) { err(w, `rows[${i}] must have ${n} cells`); return; }
        row.forEach((c, j) => { if (!(c === null || typeof c === 'string' || (typeof c === 'number' && isFinite(c)))) err(w, `rows[${i}][${j}] must be string | number | null`); });
      });
      if (b.align != null && (!Array.isArray(b.align) || b.align.length !== n || !b.align.every(a => a === 'l' || a === 'r'))) err(w, `align must be ${n} x "l" | "r"`);
      if (b.note != null && !isStr(b.note)) err(w, 'note must be a string');
      if (b.src != null) srcRef(b.src, w, { array: true });
      else if (PRICEISH_RE.test([b.caption, ...(b.columns || [])].join(' '))) err(w, 'table shows market data: it must cite a public source (src)');
      break;
    }
    case 'bars': {
      if (!isStr(b.title)) err(w, 'title required');
      if (typeof b.unit !== 'string') err(w, 'unit must be a string');
      strs(b.labels, 'labels');
      const n = Array.isArray(b.labels) ? b.labels.length : 0;
      if (!Array.isArray(b.series) || !b.series.length || b.series.length > 6) err(w, 'series: 1-6 entries');
      else b.series.forEach((s, i) => {
        if (!isObj(s)) { err(w, `series[${i}] not an object`); return; }
        keysOnly(s, ['name', 'values'], `${w}.series[${i}]`);
        if (!isStr(s.name)) err(w, `series[${i}].name required`);
        if (!Array.isArray(s.values) || s.values.length !== n) err(w, `series[${i}].values must have ${n} entries`);
        else if (!s.values.every(v => v === null || (typeof v === 'number' && isFinite(v)))) err(w, `series[${i}].values must be numbers or null`);
        else if (s.values.every(v => v === null)) err(w, `series[${i}] has no data`);
      });
      if (b.src != null) srcRef(b.src, w, { array: true });
      else if (PRICEISH_RE.test([b.title, b.unit, ...((b.series || []).map(s => s && s.name))].join(' '))) err(w, 'chart shows market data: it must cite a public source (src)');
      break;
    }
    case 'scenarios':
      if (!Array.isArray(b.rows) || b.rows.length < 3 || b.rows.length > 4) { err(w, 'rows: exactly Bear, Base and Bull (plus an optional Restructuring)'); break; }
      if (SCEN.some(n => b.rows.filter(r => r && r.name === n).length !== 1)) err(w, 'rows: exactly one each of Bear, Base, Bull');
      if (b.rows.some(r => r && !SCEN.includes(r.name) && !SCEN_OPT.includes(r.name))) err(w, 'rows: names must be Bear, Base, Bull or Restructuring');
      if (SCEN_OPT.some(n => b.rows.filter(r => r && r.name === n).length > 1)) err(w, 'rows: at most one Restructuring case');
      b.rows.forEach((r, i) => {
        if (!isObj(r)) { err(w, `rows[${i}] not an object`); return; }
        keysOnly(r, ['name', 'value', 'prob', 'text'], `${w}.rows[${i}]`);
        if (!isStr(r.value) || !isStr(r.text)) err(w, `rows[${i}]: value and text required`);
        if (r.prob != null && !isStr(r.prob)) err(w, `rows[${i}].prob must be a string`);
      });
      break;
    case 'kv':
      if (!Array.isArray(b.items) || !b.items.length) { err(w, 'items: required non-empty array'); break; }
      b.items.forEach((it, i) => {
        if (!isObj(it)) { err(w, `items[${i}] not an object`); return; }
        keysOnly(it, ['label', 'value'], `${w}.items[${i}]`);
        if (!isStr(it.label) || !isStr(it.value)) err(w, `items[${i}]: label and value required`);
        else if (PRICEISH_RE.test(it.label) && !/\[s\d/.test(it.value)) err(w, `items[${i}] "${it.label}" is market data: cite a public source with [sN]`);
      });
      break;
    case 'chart':
      if (!isStr(b.symbol) || !TV_SYMBOL_RE.test(b.symbol)) err(w, 'symbol must look like NASDAQ:CRWV');
      break;
    case 'model':
      if (!isStr(b.src) || !SLUG_RE.test(b.src)) err(w, 'src must be a model slug (reports/models/<src>.json)');
      break;
  }
}
const modelBlocks = r => (Array.isArray(r && r.sections) ? r.sections : []).flatMap(s => (s && Array.isArray(s.blocks) ? s.blocks : []))
  .filter(b => b && b.type === 'model');

// ---------------------------------------------------------------- MODEL SPEC v1
// The model file behind a "model" block. The engine (model-engine.js) is lenient — it fills
// gaps from template defaults and warns — so the publishing bar is stricter here: every
// template driver present with the template's kind, ranges coherent, scenarios on known
// drivers, every citation in the PARENT report's sources, and a share price that cites one.
const MODEL_KEYS = ['v', 'slug', 'template', 'currency', 'unit', 'asof', 'years', 'prior', 'stub', 'opening', 'debt', 'rates',
  'drivers', 'scenarios', 'valuation', 'checks', 'guides', '_comment'];
const DRIVER_KEYS = ['id', 'label', 'group', 'kind', 'unit', 'base', 'min', 'max', 'step', 'path', 'low', 'high', 'help', 'src', 'dp'];
const TRANCHE_KEYS = ['id', 'name', 'balance', 'kind', 'coupon_pct', 'spread_bp', 'maturity', 'amort', 'secured', 'recourse', 'src', 'note'];
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
function validateModel(m, report, { file } = {}) {
  const errs = [];
  const err = (where, msg) => errs.push(`${where}: ${msg}`);
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const isNum = v => typeof v === 'number' && isFinite(v);
  const isStr = v => typeof v === 'string' && v.trim().length > 0;
  if (!isObj(m)) return ['model: not an object'];
  for (const k of Object.keys(m)) if (!MODEL_KEYS.includes(k)) err('model', `unknown key "${k}"`);
  if (m.v !== 1) err('v', 'must be 1');
  if (!isStr(m.slug) || !SLUG_RE.test(m.slug)) err('slug', 'must match /^[a-z0-9-]{1,40}$/');
  if (file && m.slug !== path.basename(file, '.json')) err('slug', `"${m.slug}" does not match the file name ${path.basename(file)}`);
  const tpl = ME.template(m.template);
  if (!tpl) { err('template', `unknown template "${m.template}"`); return errs; }
  if (!isStr(m.asof) || !validDate(m.asof)) err('asof', 'must be a real YYYY-MM-DD date');
  const years = Array.isArray(m.years) ? m.years : [];
  if (!years.length || !years.every((y, i) => Number.isInteger(y) && (!i || y === years[i - 1] + 1))) err('years', 'must be consecutive ascending integer years');
  const ys = years.map(String);

  // citations: src arrays + inline [sN] anywhere resolve against the parent report's sources
  const ids = new Set((report && Array.isArray(report.sources) ? report.sources : []).map(s => s && s.id));
  const walk = (v, where) => {
    if (typeof v === 'string') {
      if (HTML_TAG_RE.test(v)) err(where, 'contains a raw HTML tag');
      if ((v.match(/\*\*/g) || []).length % 2) err(where, 'unbalanced **');
      const good = new Set();
      for (const mm of v.matchAll(CITE_RE)) {
        good.add(mm.index);
        for (const id of mm[1].split(',').map(x => x.trim())) if (!ids.has(id)) err(where, `citation [${id}] is not in the report's sources`);
      }
      for (const mm of v.matchAll(LOOSE_CITE_RE)) if (!good.has(mm.index)) err(where, `malformed citation ${mm[0]}`);
      if (PRICE_GROWTH_RE.test(v)) err(where, 'growth means fundamentals — not a price move');
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (isObj(v)) for (const k of Object.keys(v)) {
      if (k === 'src') {
        if (!Array.isArray(v.src) || !v.src.length) err(`${where}.src`, 'must be a non-empty array of source ids');
        else for (const id of v.src) if (!ids.has(id)) err(`${where}.src`, `"${id}" is not in the report's sources`);
      } else walk(v[k], `${where}.${k}`);
    }
  };
  walk(m, 'model');
  const path0 = (p, where, { pct } = {}) => {
    if (!isObj(p)) { err(where, 'path must be {"<year>": number} covering every model year'); return; }
    for (const y of ys) if (!isNum(p[y])) err(where, `path: ${y} missing or not a number`);
    for (const k of Object.keys(p)) if (!ys.includes(k)) err(where, `path: ${k} is not a model year`);
    if (pct) for (const y of ys) if (isNum(p[y]) && (p[y] < -100 || p[y] > 1000)) err(where, `path: ${y} = ${p[y]} looks wrong`);
  };

  // drivers: exactly the template's, with its kind; ranges coherent
  const tplById = new Map(tpl.drivers.map(d => [d.id, d]));
  const seen = new Set();
  (Array.isArray(m.drivers) ? m.drivers : []).forEach((d, i) => {
    const w = `drivers[${i}]${d && d.id ? ` (${d.id})` : ''}`;
    if (!isObj(d)) { err(w, 'not an object'); return; }
    for (const k of Object.keys(d)) if (!DRIVER_KEYS.includes(k)) err(w, `unknown key "${k}"`);
    const t = tplById.get(d.id);
    if (!t) { err(w, `"${d.id}" is not a ${tpl.id} driver`); return; }
    if (seen.has(d.id)) err(w, 'duplicate id');
    seen.add(d.id);
    if (d.kind !== t.kind) err(w, `kind must be ${t.kind} (the template's semantics)`);
    if (!tpl.groups.includes(d.group)) err(w, `group must be one of ${tpl.groups.join(' | ')}`);
    if (!['pp', 'bp', '%', 'x', 'yrs', 'US$', 'US$m'].includes(d.unit)) err(w, 'unit must be pp | bp | % | x | yrs | US$ | US$m');
    if (!isStr(d.label) || !isStr(d.help)) err(w, 'label and help required');
    for (const k of ['base', 'min', 'max', 'step']) if (!isNum(d[k])) err(w, `${k} must be a number`);
    if (isNum(d.min) && isNum(d.max)) {
      if (d.min >= d.max) err(w, 'min must be < max');
      if (isNum(d.base) && (d.base < d.min || d.base > d.max)) err(w, `base ${d.base} outside [${d.min}, ${d.max}]`);
      for (const k of ['low', 'high']) if (d[k] != null && (!isNum(d[k]) || d[k] < d.min || d[k] > d.max)) err(w, `${k} ${d[k]} outside [${d.min}, ${d.max}]`);
    }
    if (!(d.step > 0)) err(w, 'step must be > 0');
    if (d.id !== 'share_price' && (!isNum(d.low) || !isNum(d.high))) err(w, 'low and high (the tornado stress range) required');
    if (isNum(d.low) && isNum(d.high) && d.low >= d.high) err(w, 'low must be < high');
    if (t.kind === 'shift_pp' || t.kind === 'scale_pct') path0(d.path, w, { pct: t.kind === 'shift_pp' });
    else if (d.path !== undefined) err(w, `a ${t.kind} driver takes no path`);
  });
  for (const t of tpl.drivers) if (t.required && !seen.has(t.id)) err('drivers', `missing ${t.id}`);
  const sp = (Array.isArray(m.drivers) ? m.drivers : []).find(d => d && d.id === 'share_price');
  if (sp && (!Array.isArray(sp.src) || !sp.src.length)) err('drivers (share_price)', 'a published price must cite a public source (src)');
  if (sp && !(sp.base > 0)) err('drivers (share_price)', 'base must be the cited close (> 0)');

  // scenarios
  const sIds = new Set();
  if (!Array.isArray(m.scenarios) || !m.scenarios.length) err('scenarios', 'required non-empty array');
  else m.scenarios.forEach((s, i) => {
    const w = `scenarios[${i}]`;
    if (!isObj(s)) { err(w, 'not an object'); return; }
    for (const k of Object.keys(s)) if (!['id', 'name', 'values', 'note'].includes(k)) err(w, `unknown key "${k}"`);
    if (!isStr(s.id) || !/^[a-z][a-z0-9_]{0,39}$/.test(s.id)) err(w, 'id must be lower-case');
    else if (sIds.has(s.id)) err(w, `duplicate id ${s.id}`);
    else sIds.add(s.id);
    if (!isStr(s.name)) err(w, 'name required');
    if (!isObj(s.values)) { err(w, 'values must be an object'); return; }
    for (const [k, v] of Object.entries(s.values)) {
      const d = (m.drivers || []).find(x => x && x.id === k);
      if (!d) { err(w, `values: "${k}" is not a driver`); continue; }
      if (!isNum(v) || v < d.min || v > d.max) err(w, `values: ${k} = ${v} outside [${d.min}, ${d.max}]`);
    }
  });
  if (!sIds.has('base')) err('scenarios', 'a "base" scenario is required');

  // opening balance sheet, stub, prior
  const op = m.opening;
  if (!isObj(op)) err('opening', 'required object');
  else {
    if (!validDate(op.date || '')) err('opening', 'date must be a real YYYY-MM-DD');
    for (const k of ['cash', 'gross_ppe', 'net_ppe', 'shares_m']) if (!isNum(op[k])) err('opening', `${k} must be a number`);
    if (isNum(op.gross_ppe) && isNum(op.net_ppe) && op.net_ppe > op.gross_ppe) err('opening', 'net_ppe exceeds gross_ppe');
    if (op.dep_base != null && (!isNum(op.dep_base) || op.dep_base < 0 || (isNum(op.gross_ppe) && op.dep_base > op.gross_ppe))) err('opening', 'dep_base (depreciable base) must be a number in [0, gross_ppe]');
  }
  if (!isObj(m.prior) || !isNum(m.prior.revenue) || m.prior.year !== years[0] - 1) err('prior', `{year: ${years[0] - 1}, revenue} required (the growth base)`);
  if (m.stub != null && (!isObj(m.stub) || m.stub.year !== years[0] || !isObj(m.stub.actuals))) err('stub', 'must be {year: <first model year>, actual_months, actuals}');

  // debt
  const tIds = new Set();
  (Array.isArray(m.debt) ? m.debt : []).forEach((t, i) => {
    const w = `debt[${i}]${t && t.id ? ` (${t.id})` : ''}`;
    if (!isObj(t)) { err(w, 'not an object'); return; }
    for (const k of Object.keys(t)) if (!TRANCHE_KEYS.includes(k)) err(w, `unknown key "${k}"`);
    if (!isStr(t.id) || !ID_RE.test(t.id) || t.id === ME.NEW_DEBT_ID) err(w, 'id must be kebab-case (not "new-debt")');
    else if (tIds.has(t.id)) err(w, 'duplicate id');
    else tIds.add(t.id);
    if (!isStr(t.name)) err(w, 'name required');
    if (!isNum(t.balance) || t.balance < 0) err(w, 'balance must be a number >= 0');
    if (t.kind === 'fixed') { if (!isNum(t.coupon_pct) || t.coupon_pct < 0 || t.coupon_pct > 40) err(w, 'fixed: coupon_pct (0–40) required'); }
    else if (t.kind === 'floating') { if (!isNum(t.spread_bp) || t.spread_bp < 0 || t.spread_bp > 3000) err(w, 'floating: spread_bp (0–3000) required'); }
    else err(w, 'kind must be fixed | floating');
    if (!MONTH_RE.test(String(t.maturity))) err(w, 'maturity must be YYYY-MM');
    if (!['bullet', 'straight', 'cashsweep'].includes(t.amort)) err(w, 'amort must be bullet | straight | cashsweep');
    if (typeof t.secured !== 'boolean' || typeof t.recourse !== 'boolean') err(w, 'secured and recourse must be booleans');
    if (!Array.isArray(t.src)) err(w, 'src required (where the balance comes from)');
  });
  if (!isObj(m.rates)) err('rates', 'required object');
  else { path0(m.rates.path, 'rates'); if (!isStr(m.rates.note)) err('rates', 'note required (how the path was derived, dated)'); }

  // valuation, checks, guides
  const v = m.valuation;
  if (!isObj(v) || v.method !== 'exit_multiple' || !years.includes(v.exit_year) || !validDate(v.valuation_date || '')) err('valuation', '{method: "exit_multiple", exit_year: <a model year>, valuation_date} required');
  const metricOk = k => tpl.row_names.includes(k) || tpl.valuation_metrics.includes(k);
  (Array.isArray(m.checks) ? m.checks : []).forEach((c, i) => {
    const w = `checks[${i}]`;
    if (!isObj(c) || !isStr(c.label) || !metricOk(c.metric)) { err(w, 'label + a known metric required'); return; }
    if (tpl.row_names.includes(c.metric) && !years.includes(c.year)) err(w, 'year must be a model year');
    if (c.lo == null && c.hi == null) err(w, 'lo or hi required');
    if (isNum(c.lo) && isNum(c.hi) && c.lo > c.hi) err(w, 'lo > hi');
  });
  (Array.isArray(m.guides) ? m.guides : []).forEach((g, i) => {
    const w = `guides[${i}]`;
    if (!isObj(g) || !isStr(g.label) || !tpl.row_names.includes(g.metric)) { err(w, 'label + a known row metric required'); return; }
    if (!/^\d{4}(-Q[1-4])?$/.test(String(g.period)) || !years.includes(+String(g.period).slice(0, 4))) err(w, 'period must be YYYY or YYYY-Qn inside the model years');
    if (!isNum(g.lo) || !isNum(g.hi) || g.lo > g.hi) err(w, 'lo <= hi required');
  });

  // and the engine must accept it without falling back to template defaults
  const vs = ME.validateSpec(m);
  for (const e of vs.errors) err('engine', e);
  for (const x of vs.warnings) err('engine warning', x);
  if (vs.ok) { const r = ME.project(m, {}); if (r.error) err('engine', r.error); }
  return errs;
}

function validateIndex(idx, reports) {
  const errs = [];
  const err = (w, m) => errs.push(`${w}: ${m}`);
  if (!idx || typeof idx !== 'object' || idx.v !== 1 || !Array.isArray(idx.reports)) return ['index.json: must be {"v":1,"reports":[...]}'];
  for (const k of Object.keys(idx)) if (!['v', 'reports'].includes(k)) err('index', `unknown key "${k}"`);
  const seen = new Set();
  idx.reports.forEach((e, i) => {
    const w = `index.reports[${i}]`;
    if (!e || typeof e !== 'object') { err(w, 'not an object'); return; }
    for (const k of Object.keys(e)) if (!['slug', 'ticker', 'company', 'title', 'published', 'stance', 'summary', 'report_type', 'sector'].includes(k)) err(w, `unknown key "${k}"`);
    if (!SLUG_RE.test(String(e.slug))) { err(w, 'bad slug'); return; }
    if (seen.has(e.slug)) err(w, `duplicate slug ${e.slug}`);
    seen.add(e.slug);
    const r = reports.get(e.slug);
    if (!r) { err(w, `no dashboard/reports/${e.slug}.json`); return; }
    for (const k of ['ticker', 'company', 'title', 'published', 'report_type', 'sector']) if (e[k] !== r[k]) err(w, `${k} "${e[k]}" disagrees with ${e.slug}.json ("${r[k]}")`);
    if (!e.stance || e.stance.label !== (r.stance || {}).label || e.stance.risk !== (r.stance || {}).risk) err(w, 'stance label/risk disagree with the report');
    if (e.stance) for (const k of Object.keys(e.stance)) if (!['label', 'risk'].includes(k)) err(w, `stance: unknown key "${k}"`);
    if (typeof e.summary !== 'string' || !e.summary.trim()) err(w, 'summary required');
    else if (HTML_TAG_RE.test(e.summary)) err(w, 'summary contains a raw HTML tag');
    if (i && String(idx.reports[i - 1].published) < String(e.published)) err(w, 'index must be newest first');
  });
  for (const slug of reports.keys()) if (!seen.has(slug)) err('index', `${slug}.json is published but not listed in index.json`);
  return errs;
}

// ---------------------------------------------------------------- the published files
const reportFiles = fs.existsSync(RDIR) ? fs.readdirSync(RDIR).filter(f => f.endsWith('.json') && f !== 'index.json').sort() : [];
const REPORTS = new Map();
for (const f of reportFiles) {
  check(`dashboard/reports/${f}: schema v1`, () => {
    const r = readJSON(path.join(RDIR, f));
    const errs = validateReport(r, { file: f });
    assert.strictEqual(errs.length, 0, errs.join('\n'));
    REPORTS.set(r.slug, r);
  });
}
if (!reportFiles.includes('crwv.json')) console.log('skip  dashboard/reports/crwv.json not written yet (validated whenever present)');
check('dashboard/reports/index.json: present, matches the report files', () => {
  assert.ok(fs.existsSync(path.join(RDIR, 'index.json')), 'dashboard/reports/index.json missing');
  // Unparseable report files already failed above; the index is checked against the rest.
  const valid = new Map([...REPORTS]);
  for (const f of reportFiles) { const s = path.basename(f, '.json'); if (!valid.has(s)) { try { valid.set(s, readJSON(path.join(RDIR, f))); } catch { /* reported */ } } }
  const errs = validateIndex(readJSON(path.join(RDIR, 'index.json')), valid);
  assert.strictEqual(errs.length, 0, errs.join('\n'));
});

// Every model block of every published report has its model file, valid against the report.
for (const f of reportFiles) {
  let r = null;
  try { r = readJSON(path.join(RDIR, f)); } catch { continue; }
  for (const b of modelBlocks(r)) {
    check(`dashboard/reports/models/${b.src}.json (model block of ${f}): MODEL SPEC v1`, () => {
      const mf = path.join(MDIR, `${b.src}.json`);
      assert.ok(fs.existsSync(mf), `${f} has a model block but dashboard/reports/models/${b.src}.json is missing`);
      const errs = validateModel(readJSON(mf), r, { file: mf });
      assert.strictEqual(errs.length, 0, errs.join('\n'));
    });
  }
}

const FIX = readJSON(FIXTURE);
const FIX_MODEL = readJSON(path.join(FIX_MDIR, 'fxr.json'));
check('fixture model fxr.json against the fixture report: MODEL SPEC v1', () => {
  eq(modelBlocks(FIX).map(b => b.src), ['fxr'], 'the fixture report carries the fixture model');
  const errs = validateModel(FIX_MODEL, FIX, { file: 'fxr.json' });
  assert.strictEqual(errs.length, 0, errs.join('\n'));
});
const brokenModels = [
  ['unknown driver id', m => { m.drivers.push({ ...m.drivers[0], id: 'fx_rate' }); }, /"fx_rate" is not a levered_growth_v1 driver/],
  ['missing template driver', m => { m.drivers = m.drivers.filter(d => d.id !== 'sofr_shift'); }, /missing sofr_shift/],
  ['driver kind changed', m => { m.drivers.find(d => d.id === 'sofr_shift').kind = 'scalar'; }, /kind must be shift_bp/],
  ['base outside the range', m => { m.drivers.find(d => d.id === 'tax_rate').base = 80; }, /base 80 outside/],
  ['stress low outside the range', m => { m.drivers.find(d => d.id === 'sofr_shift').low = -900; }, /low -900 outside/],
  ['low above high', m => { const d = m.drivers.find(d => d.id === 'capex'); d.low = 20; d.high = 10; }, /low must be < high/],
  ['path missing a year', m => { delete m.drivers.find(d => d.id === 'revenue_growth').path['2029']; }, /path: 2029 missing/],
  ['scenario on an unknown driver', m => { m.scenarios[1].values.oil_price = 90; }, /"oil_price" is not a driver/],
  ['scenario value out of range', m => { m.scenarios[1].values.sofr_shift = 5000; }, /sofr_shift = 5000 outside/],
  ['no base scenario', m => { m.scenarios = m.scenarios.filter(s => s.id !== 'base'); }, /a "base" scenario is required/],
  ['citation not in the report', m => { m.debt[0].src = ['s9']; }, /"s9" is not in the report's sources/],
  ['inline citation not in the report', m => { m.drivers[0].help += ' [s42]'; }, /citation \[s42\]/],
  ['share price without a source', m => { delete m.drivers.find(d => d.id === 'share_price').src; }, /must cite a public source/],
  ['years not ascending', m => { m.years = [2026, 2028, 2027, 2029, 2030]; }, /consecutive ascending/],
  ['fixed tranche without a coupon', m => { m.debt[1].coupon_pct = null; }, /coupon_pct/],
  ['tranche maturity format', m => { m.debt[0].maturity = '2031'; }, /maturity must be YYYY-MM/],
  ['reserved tranche id', m => { m.debt[0].id = 'new-debt'; }, /not "new-debt"/],
  ['raw HTML in help', m => { m.drivers[0].help = '<img src=x onerror=alert(1)>'; }, /raw HTML/],
  ['slug vs file name', m => { m.slug = 'other'; }, /does not match the file name/],
  ['check on an unknown metric', m => { m.checks[0].metric = 'magic'; }, /known metric/],
  ['guide period outside the model', m => { m.guides[0].period = '2040-Q1'; }, /period must be/],
];
for (const [name, mutate, re] of brokenModels) {
  check(`model validator rejects: ${name}`, () => {
    const m = clone(FIX_MODEL);
    mutate(m);
    const errs = validateModel(m, FIX, { file: 'fxr.json' });
    assert.ok(errs.some(e => re.test(e)), `expected ${re} in:\n${errs.join('\n') || '(no errors)'}`);
  });
}
check('validator: a model block needs a slug src', () => {
  const r = clone(FIX);
  r.sections.find(s => s.id === 'stress-test').blocks[1].src = '../x';
  assert.ok(validateReport(r, { file: 'fxr.json' }).some(e => /src must be a model slug/.test(e)));
});
check('fixture sample.json (Fixture Corp, FXR): schema v1', () => {
  const errs = validateReport(FIX, { file: 'fxr.json' });
  assert.strictEqual(errs.length, 0, errs.join('\n'));
  eq([FIX.company, FIX.ticker], ['Fixture Corp', 'FXR'], 'fixture must stay synthetic');
  for (const s of FIX.sources) assert.match(s.url, /^https:\/\/www\.example\.com\//, 'fixture sources must be example.com');
});

// ---------------------------------------------------------------- the validator itself
const broken = [
  ['citation to a missing source', r => { r.highlights[0] += ' [s9]'; }, /citation \[s9\] is not in sources/],
  ['malformed citation', r => { r.sections[0].blocks[0].text += ' [s1 ]x [S2]'; }, /malformed citation/],
  ['http source url', r => { r.sources[0].url = 'http://www.example.com/x'; }, /url must be https/],
  ['javascript: source url', r => { r.sources[0].url = 'javascript:alert(1)'; }, /url must be https/],
  ['raw HTML in text', r => { r.sections[0].blocks[0].text = 'Hi <img src=x onerror=alert(1)>'; }, /raw HTML tag/],
  ['raw HTML in a table cell', r => { r.sections[1].blocks[0].rows[0][0] = '<b>Revenue</b>'; }, /raw HTML tag/],
  ['unbalanced bold', r => { r.highlights[1] = '**oops'; }, /unbalanced \*\*/],
  ['bad stance label', r => { r.stance.label = 'Buy'; }, /stance\.label/],
  ['bad risk', r => { r.stance.risk = 'Extreme'; }, /stance\.risk/],
  ['bad report type', r => { r.report_type = 'Flash'; }, /report_type/],
  ['unknown block type', r => { r.sections[0].blocks.push({ type: 'html', text: 'x' }); }, /unknown block type "html"/],
  ['unknown top-level key', r => { r.rating = 'Buy'; }, /unknown key "rating"/],
  ['table row width', r => { r.sections[1].blocks[0].rows[0].push(1); }, /must have 4 cells/],
  ['bars length mismatch', r => { r.sections[1].blocks[1].series[0].values.pop(); }, /values must have 3 entries/],
  ['src id missing', r => { r.sections[1].blocks[0].src = ['s7']; }, /src "s7" is not in sources/],
  ['price stat without a source', r => { delete r.key_stats[0].src; }, /market data: it must cite/],
  ['market-cap table without a source', r => { delete r.sections[2].blocks[1].src; }, /market data: it must cite/],
  ['price move called growth', r => { r.highlights[2] = 'Share-price growth of 40% this year.'; }, /growth means fundamentals/],
  ['too few key stats', r => { r.key_stats = r.key_stats.slice(0, 3); }, /6-10 entries/],
  ['scenario names', r => { r.sections[2].blocks[2].rows[0].name = 'Blue sky'; }, /Bear, Base, Bull/],
  ['chart symbol', r => { r.sections.find(s => s.id === 'share-price').blocks[0].symbol = 'CRWV"><script>'; }, /symbol must look like/],
  ['slug vs file name', r => { r.slug = 'other'; }, /does not match the file name/],
  ['data_asof after published', r => { r.data_asof = '2026-12-01'; }, /after published/],
  ['source dated by a bare year', r => { r.sources[0].date = '2026'; }, /date must be YYYY-MM-DD, YYYY-MM/],
  ['source dated by a month 13', r => { r.sources[0].date = '2026-13'; }, /date must be YYYY-MM-DD, YYYY-MM/],
  ['two restructuring cases', r => { const rows = r.sections[2].blocks[2].rows; rows.push({ ...rows[0], name: 'Restructuring' }); rows.push({ ...rows[1], name: 'Restructuring' }); }, /rows: exactly Bear, Base and Bull/],
  ['restructuring duplicated in place of a case', r => { const rows = r.sections[2].blocks[2].rows; rows.push({ ...rows[0], name: 'Restructuring' }); rows[1] = { ...rows[1], name: 'Restructuring' }; }, /at most one Restructuring/],
];
for (const [name, mutate, re] of broken) {
  check(`validator rejects: ${name}`, () => {
    const r = clone(FIX);
    mutate(r);
    const errs = validateReport(r, { file: 'fxr.json' });
    assert.ok(errs.some(e => re.test(e)), `expected ${re} in:\n${errs.join('\n') || '(no errors)'}`);
  });
}
check('validator: index entry must agree with its report and be listed', () => {
  const reps = new Map([['fxr', FIX]]);
  const entry = { slug: 'fxr', ticker: 'FXR', company: FIX.company, title: FIX.title, published: FIX.published,
    stance: { label: FIX.stance.label, risk: FIX.stance.risk }, summary: 'x', report_type: FIX.report_type, sector: FIX.sector };
  eq(validateIndex({ v: 1, reports: [entry] }, reps), []);
  assert.ok(validateIndex({ v: 1, reports: [{ ...entry, title: 'Different' }] }, reps).some(e => /title/.test(e)));
  assert.ok(validateIndex({ v: 1, reports: [{ ...entry, slug: 'gone' }] }, reps).some(e => /no dashboard\/reports\/gone\.json/.test(e)));
  assert.ok(validateIndex({ v: 1, reports: [] }, reps).some(e => /not listed in index\.json/.test(e)));
  eq(validateIndex({ v: 1, reports: [] }, new Map()), []);
});

// ---------------------------------------------------------------- inline markup parser
const P = R._internal.parseInline;
check('parseInline: text, bold, citations', () => {
  eq(P('plain'), [{ t: 'text', v: 'plain' }]);
  eq(P('a **b** c'), [{ t: 'text', v: 'a ' }, { t: 'b', parts: [{ t: 'text', v: 'b' }] }, { t: 'text', v: ' c' }]);
  eq(P('x [s1] y [s2, s10]'), [{ t: 'text', v: 'x ' }, { t: 'cite', ids: ['s1'] }, { t: 'text', v: ' y ' }, { t: 'cite', ids: ['s2', 's10'] }]);
  eq(P('**b [s3]**'), [{ t: 'b', parts: [{ t: 'text', v: 'b ' }, { t: 'cite', ids: ['s3'] }] }]);
  eq(P(''), []);
  eq(P(null), []);
  eq(P(42), [{ t: 'text', v: '42' }]);
});
check('parseInline: unmatched ** and non-citations stay literal', () => {
  eq(P('a ** b'), [{ t: 'text', v: 'a ** b' }]);
  eq(P('**x** and **y'), [{ t: 'b', parts: [{ t: 'text', v: 'x' }] }, { t: 'text', v: ' and **y' }]);
  eq(P('[1] [S1] [s] [s1;s2] [x1]'), [{ t: 'text', v: '[1] [S1] [s] [s1;s2] [x1]' }]);
  eq(P('****'), []);
  eq(P('<script>alert(1)</script>'), [{ t: 'text', v: '<script>alert(1)</script>' }], 'markup-looking text is plain text');
});
check('helpers: plainText, safeUrl, fmtDate, fmtCell, barsScale', () => {
  const I = R._internal;
  eq(I.plainText('Revenue **up** 40% [s1].'), 'Revenue up 40%.');
  eq(I.safeUrl('https://www.sec.gov/x?a=1'), 'https://www.sec.gov/x?a=1');
  for (const u of ['http://x.com', 'javascript:alert(1)', 'data:text/html,hi', '//x.com', 'ftp://x', '', null]) eq(I.safeUrl(u), null, String(u));
  eq(I.fmtDate('2026-10-17'), '17 Oct 2026');
  eq(I.fmtDate('2026-01-02'), '2 Jan 2026');
  eq(I.fmtDate('soon'), 'soon');
  eq(I.fmtDate('2025-09'), 'Sep 2025', 'a month-only source date');
  eq(I.fmtDate('2025-13'), '2025-13');
  eq(I.fmtCell(null), '—');
  eq(I.fmtCell(-1234.5), '−1,234.5');
  eq(I.fmtCell(NaN), '—');
  eq(I.fmtCell('n/m'), 'n/m');
  const s = I.barsScale([-863, 3104.5, null]);
  assert.ok(s.lo <= -863 && s.hi >= 3104.5 && s.ticks.includes(0), JSON.stringify(s));
  const p = I.barsScale([5, 12]);
  eq(p.lo, 0, 'positive data: the axis starts at zero');
  const n = I.barsScale([-5, -12]);
  eq(n.hi, 0, 'negative data: the axis ends at zero');
  eq(I.barsScale([null, null]).ticks.includes(0), true);
  for (const sl of ['crwv', 'a-b-1']) assert.ok(I.SLUG_RE.test(sl), sl);
  for (const sl of ['CRWV', '../x', 'a/b', 'a.json', '', 'x'.repeat(41), 'a b']) assert.ok(!I.SLUG_RE.test(sl), sl);
});

// ---------------------------------------------------------------- fake DOM renderer tests
// Just enough DOM for reports.js. innerHTML ASSIGNMENT throws: reports.js must build every
// node with createElement / createTextNode.
const ALLOWED_ATTRS = new Set(['class', 'href', 'target', 'rel', 'id', 'title', 'aria-label', 'aria-labelledby', 'role', 'tabindex',
  'scope', 'type', 'style', 'data-rpt-src', 'data-rpt-sec', 'data-rpt-print', 'data-rpt-slug', 'data-rpt-view',
  'viewBox', 'preserveAspectRatio', 'x', 'y', 'x1', 'x2', 'y1', 'y2', 'width', 'height', 'fill', 'rx', 'text-anchor']);
function fakeDocument() {
  class Node {
    constructor(doc) { this.ownerDocument = doc; this.childNodes = []; this.parentNode = null; }
    appendChild(n) {
      assert.ok(n instanceof Node, 'appendChild of a non-node');
      if (n.parentNode) n.parentNode.removeChild(n);
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    removeChild(n) { const i = this.childNodes.indexOf(n); assert.ok(i >= 0, 'removeChild of a non-child'); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
    get firstChild() { return this.childNodes[0] || null; }
    get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
    set textContent(v) { this.childNodes = []; if (v != null && v !== '') this.appendChild(new Text(this.ownerDocument, String(v))); }
  }
  class Text extends Node {
    constructor(doc, t) { super(doc); this.nodeType = 3; this.data = t; }
    get textContent() { return this.data; }
    set textContent(v) { this.data = String(v); }
    appendChild() { throw new Error('text nodes have no children'); }
  }
  class Element extends Node {
    constructor(doc, tag, ns) {
      super(doc); this.nodeType = 1; this.localName = tag; this.tagName = tag.toUpperCase(); this.namespaceURI = ns || 'http://www.w3.org/1999/xhtml';
      this.attrs = new Map(); this.listeners = [];
      const self = this;
      this.classList = {
        add: c => { const s = new Set((self.getAttribute('class') || '').split(/\s+/).filter(Boolean)); s.add(c); self.setAttribute('class', [...s].join(' ')); },
        remove: c => { self.setAttribute('class', (self.getAttribute('class') || '').split(/\s+/).filter(x => x && x !== c).join(' ')); },
        contains: c => (self.getAttribute('class') || '').split(/\s+/).includes(c),
      };
    }
    setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
    getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
    hasAttribute(k) { return this.attrs.has(k); }
    removeAttribute(k) { this.attrs.delete(k); }
    addEventListener(type, fn) { this.listeners.push([type, fn]); }
    get children() { return this.childNodes.filter(c => c.nodeType === 1); }
    get childElementCount() { return this.children.length; }
    set innerHTML(v) { throw new Error(`innerHTML assigned on <${this.localName}>`); }
    get innerHTML() { return this.childNodes.map(serialize).join(''); }
    set outerHTML(v) { throw new Error('outerHTML assigned'); }
    insertAdjacentHTML() { throw new Error('insertAdjacentHTML called'); }
  }
  const escT = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escA = s => escT(s).replace(/"/g, '&quot;');
  function serialize(n) {
    if (n.nodeType === 3) return escT(n.data);
    const a = [...n.attrs].map(([k, v]) => ` ${k}="${escA(v)}"`).join('');
    return `<${n.localName}${a}>${n.childNodes.map(serialize).join('')}</${n.localName}>`;
  }
  const doc = {
    title: 'Global Index Valuation Agent',
    createElement: tag => new Element(doc, String(tag)),
    createElementNS: (ns, tag) => new Element(doc, String(tag), ns),
    createTextNode: t => new Text(doc, String(t)),
    getElementById: id => all(doc.body).find(e => e.getAttribute('id') === id) || null,
    write() { throw new Error('document.write called'); },
  };
  doc.documentElement = new Element(doc, 'html');
  doc.body = new Element(doc, 'body');
  doc.documentElement.appendChild(doc.body);
  function all(root) { const out = []; (function rec(n) { for (const c of n.childNodes) if (c.nodeType === 1) { out.push(c); rec(c); } })(root); return out; }
  return { doc, all, serialize, Element };
}

function withDOM(fn) {
  const F = fakeDocument();
  const saved = { document: global.document, fetch: global.fetch, Charts: global.Charts };
  global.document = F.doc;
  const restore = () => { global.document = saved.document; global.fetch = saved.fetch; if (saved.Charts === undefined) delete global.Charts; else global.Charts = saved.Charts; };
  try {
    const out = fn(F);
    if (out && typeof out.then === 'function') return out.finally(restore);
    restore();
    return out;
  } catch (e) { restore(); throw e; }
}
function assertSafeTree(F, root) {
  for (const el of [root, ...F.all(root)]) {
    assert.ok(!['script', 'iframe', 'img', 'object', 'embed', 'style', 'link', 'meta', 'form', 'input', 'foreignObject'].includes(el.localName), `unexpected <${el.localName}>`);
    for (const [k, v] of el.attrs) {
      assert.ok(ALLOWED_ATTRS.has(k), `unexpected attribute ${k}="${v}" on <${el.localName}>`);
      assert.ok(!/^on/i.test(k), `event-handler attribute ${k}`);
      if (k === 'href') assert.ok(/^https:\/\//.test(v) || /^#\/reports(\/[a-z0-9-]+(\/model)?)?$/.test(v), `unsafe href ${v}`);
      if (k === 'style') assert.match(v, el.localName === 'svg' ? /^--rpt-bars-minw:\d{3,4}px$/ : /^background:#[0-9a-f]{6}$/, `unexpected style ${v}`);
      if (k === 'target') assert.strictEqual(el.getAttribute('rel'), 'noopener noreferrer', 'target=_blank without rel');
    }
  }
}

check('render: fixture builds a complete report through createElement/textContent only', () => withDOM(F => {
  const { el } = R._internal.build(FIX);
  F.doc.body.appendChild(el);
  assertSafeTree(F, el);
  const html = F.serialize(el);
  const text = el.textContent;
  // cover + sidebar
  assert.match(text, /Fixture Corp/); assert.match(text, /Nasdaq: FXR/);
  assert.match(text, /Stance: Neutral/); assert.match(text, /Risk: High/); assert.match(text, /Horizon: 12 months/);
  assert.match(text, /Initiation · Information Technology · 15 Oct 2026/);
  assert.match(text, /Data as of 1 Oct 2026/);
  assert.strictEqual(F.all(el).filter(e => e.getAttribute('class') === 'rpt-stat').length, FIX.key_stats.length);
  // investment summary, numbered sections, sources last
  assert.match(text, /Investment summary/);
  const heads = F.all(el).filter(e => e.localName === 'h2' && e.parentNode.getAttribute('class') && /rpt-sec/.test(e.parentNode.getAttribute('class'))).map(e => e.textContent);
  eq(heads, ['1Investment thesis', '2Financials (EDGAR)', '3Valuation', '4Stress test & projections', '5Key risks', '6Share-price performance', '7Sources']);
  // the model block is a slot until the page is attached (renderReport mounts it)
  const slot = F.all(el).find(e => e.getAttribute('class') === 'rpt-model-slot');
  assert.ok(slot && /Loading the stress-test model/.test(slot.textContent), 'model slot rendered');
  // bold + citations
  const strongs = F.all(el).filter(e => e.localName === 'strong').map(e => e.textContent);
  assert.ok(strongs.includes('Fundamental growth is the story:'), strongs.join('|'));
  const cites = F.all(el).filter(e => e.getAttribute('data-rpt-src'));
  assert.ok(cites.length > 10, 'citations rendered');
  for (const a of cites) {
    const id = a.getAttribute('data-rpt-src');
    assert.ok(F.doc.getElementById(`src-${id}`), `citation ${id} has a source anchor`);
    eq(a.getAttribute('href'), '#/reports/fxr', 'citations keep the router hash (scroll via click handler)');
  }
  const sup = F.all(el).find(e => e.localName === 'sup' && /,/.test(e.textContent));
  eq(sup && sup.textContent, '1,3', 'multi-citation [s1,s3] -> superscript 1,3');
  // tables: right-aligned numerics, a dash for null, minus sign for negatives
  const tds = F.all(el).filter(e => e.localName === 'td');
  assert.ok(tds.some(td => td.textContent === '3,104.5' && td.getAttribute('class') === 'r'));
  assert.ok(tds.some(td => td.textContent === '—'));
  assert.ok(tds.some(td => td.textContent === '−594'));
  assert.ok(F.all(el).some(e => e.getAttribute('role') === 'region' && /rpt-tablewrap/.test(e.getAttribute('class'))), 'tables scroll in their own box');
  // bars: inline SVG with an accessible title, a zero line, negative bars below it, n/a gap
  const svg = F.all(el).find(e => e.localName === 'svg');
  assert.ok(svg && svg.namespaceURI === 'http://www.w3.org/2000/svg');
  eq(svg.getAttribute('role'), 'img');
  const title = svg.childNodes.find(c => c.localName === 'title');
  eq(title.textContent, 'Revenue and net income (US$ m)');
  const zero = F.all(svg).find(e => e.getAttribute('class') === 'rpt-zero');
  const y0 = +zero.getAttribute('y1');
  const rects = F.all(svg).filter(e => e.localName === 'rect');
  eq(rects.length, 5, '3 revenue + 2 net income bars (one null)');
  const neg = rects.filter(r => /Net income/.test(r.textContent));
  for (const r of neg) assert.ok(Math.abs(+r.getAttribute('y') - y0) < 0.2, 'negative bars hang from the zero line');
  const pos = rects.filter(r => /Revenue/.test(r.textContent));
  for (const r of pos) assert.ok(Math.abs(+r.getAttribute('y') + +r.getAttribute('height') - y0) < 0.2, 'positive bars stand on the zero line');
  assert.ok(F.all(svg).some(e => e.getAttribute('class') === 'rpt-na' && e.textContent === 'n/a'), 'a null is a gap, not zero');
  assert.ok(F.all(svg).some(e => e.getAttribute('class') === 'rpt-val' && e.textContent === '−863'));
  // scenarios ordered Bear, Base, Bull whatever the JSON order
  eq(F.all(el).filter(e => e.getAttribute('class') === 'rpt-scen-name').map(e => e.textContent), ['Bear case', 'Base case', 'Bull case']);
  // callouts, kv, sources with https links in a new tab
  eq(F.all(el).filter(e => e.localName === 'aside' && /rpt-callout/.test(e.getAttribute('class'))).map(e => e.getAttribute('class')),
    ['rpt-callout positive', 'rpt-callout risk', 'rpt-callout info']);
  assert.ok(text.includes('A synthetic note < 5% of anything'), 'a literal < stays text');
  const links = F.all(el).filter(e => e.localName === 'a' && e.getAttribute('target') === '_blank');
  eq(links.map(a => a.getAttribute('href')), FIX.sources.map(s => s.url));
  // the print button + the print-only note standing in for the live chart
  assert.ok(F.all(el).some(e => e.hasAttribute('data-rpt-print') && e.textContent === 'Download PDF'));
  assert.ok(F.all(el).some(e => /rpt-print-only/.test(e.getAttribute('class') || '') && /NASDAQ:FXR/.test(e.textContent)));
  assert.ok(!/<script/i.test(html));
}));

check('render: hostile text renders as inert text; non-https links are not links', () => withDOM(F => {
  const r = clone(FIX);
  const evil = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  r.company = evil; r.title = evil; r.subtitle = evil; r.ticker = '"><b>';
  r.highlights = [`**${evil}** [s1]`, 'javascript:alert(3)', '[s1"]'];
  r.key_stats[0] = { label: evil, value: evil, note: evil, src: 's1' };
  r.sections[0].title = evil;
  r.sections[0].id = '"><svg onload=alert(1)>';
  r.sections[0].blocks = [{ type: 'p', text: evil }, { type: 'bullets', items: [evil] }, { type: 'kv', items: [{ label: evil, value: evil }] },
    { type: 'table', caption: evil, columns: [evil, 'x'], rows: [[evil, evil]], align: ['"><x', 'r'], note: evil },
    { type: 'bars', title: evil, unit: evil, labels: [evil], series: [{ name: evil, values: [1] }] },
    { type: 'callout', tone: 'x" onclick="y', title: evil, text: evil }, { type: 'html', html: evil }, { type: 'chart', symbol: evil }];
  r.sources = [{ id: 's1', title: evil, publisher: evil, date: '', url: 'javascript:alert(1)' },
    { id: 's2', title: 'x', publisher: 'y', date: '', url: 'http://insecure.example.com' }];
  const { el } = R._internal.build(r);
  F.doc.body.appendChild(el);
  assertSafeTree(F, el);
  assert.ok(el.textContent.includes('<script>alert(2)</script>'), 'the text survives verbatim, as text');
  assert.ok(!F.all(el).some(e => e.getAttribute('href') && /javascript:|http:/.test(e.getAttribute('href'))));
}));

check('renderReport: bad slugs never fetch; 404 and junk give "Report not found"; a real one renders + unmounts', () => withDOM(async F => {
  const calls = [];
  global.fetch = (url) => {
    calls.push(url);
    if (url === 'reports/fxr.json') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(clone(FIX)) });
    if (url === 'reports/junk.json') return Promise.resolve({ ok: true, status: 200, json: () => Promise.reject(new Error('not json')) });
    if (url === 'reports/other.json') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ...clone(FIX), slug: 'fxr' }) });
    if (url === 'reports/down.json') return Promise.reject(new Error('offline'));
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
  };
  const el = F.doc.createElement('div');
  F.doc.body.appendChild(el);
  for (const bad of ['../secrets', 'CRWV', 'a/b', '', 'x'.repeat(41), '<img>']) {
    await R.renderReport(el, bad);
    assert.match(el.textContent, /Report not found/, bad);
  }
  eq(calls, [], 'no fetch for a malformed slug');
  for (const s of ['nope', 'junk', 'other']) { await R.renderReport(el, s); assert.match(el.textContent, /Report not found/, s); }
  await R.renderReport(el, 'down');
  assert.match(el.textContent, /couldn’t load/);
  let mounted = null, disposed = 0;
  global.Charts = { mount: (slot, spec) => { mounted = spec; return () => { disposed++; }; } };
  await R.renderReport(el, 'fxr');
  assert.match(el.textContent, /Fixture Corp/);
  eq(mounted, { kind: 'symbol', symbol: 'NASDAQ:FXR', height: 380 }, 'the chart block uses charts.js (TradingView, kind symbol)');
  // Back from a stock drawer / a data refresh re-runs the router for the same report: the
  // page (and the reader's scroll position, the live chart) must stay — no refetch, no rebuild.
  const art = el.firstChild, nCalls = calls.length;
  let scrolled = 0;
  const savedWin = global.window;
  global.window = { scrollTo: () => { scrolled++; } };
  try { await R.renderReport(el, 'fxr'); } finally { if (savedWin === undefined) delete global.window; else global.window = savedWin; }
  assert.strictEqual(el.firstChild, art, 'same report: the article is kept');
  eq(calls.length, nCalls, 'same report: no second fetch');
  eq([scrolled, disposed], [0, 0], 'same report: no scroll to top, chart not disposed');
  assert.ok(F.doc.documentElement.classList.contains('rpt-on'), 'print mode on while a report is shown');
  assert.match(F.doc.title, /^Fixture Corp \(FXR\) — Key report/);
  R.unmount();
  eq(disposed, 1, 'leaving the view disposes the chart');
  assert.ok(!F.doc.documentElement.classList.contains('rpt-on'));
  eq(F.doc.title, 'Global Index Valuation Agent', 'title restored');
  // A slow fetch for a report that was left behind is dropped.
  let release;
  global.fetch = () => new Promise(res => { release = () => res({ ok: true, status: 200, json: () => Promise.resolve(clone(FIX)) }); });
  const p = R.renderReport(el, 'fxr');
  R.unmount();
  el.textContent = 'left';
  await new Promise(res => setImmediate(res));    // the fetch starts on a microtask
  release();
  await p;
  eq(el.textContent, 'left', 'a stale render must not overwrite the page');
}));

check('renderList: cards newest first, empty state, failed index; findByTicker', () => withDOM(async F => {
  const entry = (slug, published, extra = {}) => ({ slug, ticker: slug.toUpperCase(), company: `${slug} Inc`, title: `${slug} title`, published,
    stance: { label: 'Cautious', risk: 'Very high' }, summary: `**Bold** summary [s1] for ${slug}.`, report_type: 'Update', sector: 'Energy', ...extra });
  let index = { v: 1, reports: [entry('aaa', '2026-01-01'), entry('bbb', '2026-09-01'), { slug: '../x', ticker: 'X' }] };
  let ok = true;
  global.fetch = url => {
    assert.strictEqual(url, 'reports/index.json');
    return ok ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(clone(index)) }) : Promise.reject(new Error('offline'));
  };
  const el = F.doc.createElement('div');
  F.doc.body.appendChild(el);
  await R.renderList(el);
  assertSafeTree(F, el);
  const cards = F.all(el).filter(e => e.getAttribute('class') === 'rpt-card');
  eq(cards.map(c => c.getAttribute('href')), ['#/reports/bbb', '#/reports/aaa'], 'newest first; malformed slugs dropped');
  assert.match(cards[0].textContent, /Bold summary for bbb\./, 'summary shown without markup');
  assert.match(cards[0].textContent, /Cautious/); assert.match(cards[0].textContent, /Risk: Very high/);
  eq((await R.findByTicker('bbb')).slug, 'bbb', 'findByTicker is case-insensitive');
  eq(await R.findByTicker('ZZZ'), null);
  index = { v: 1, reports: [] };
  await R.renderList(el);
  assert.match(el.textContent, /No key reports are published yet/);
  ok = false;
  await R.renderList(el);
  assert.match(el.textContent, /couldn’t load/);
  eq(await R.findByTicker('bbb'), null, 'a failed index resolves null (never rejects)');
}));

// ---------------------------------------------------------------- wiring
check('index.html: nav tab, view container, stylesheet and script', () => {
  const html = fs.readFileSync(path.join(DASH, 'index.html'), 'utf8');
  assert.match(html, /<a href="#\/reports" data-view="reports" class="view-tab">Key reports<\/a>/);
  assert.match(html, /<div id="view-reports" hidden><\/div>/);
  assert.match(html, /<link rel="stylesheet" href="reports\.css" \/>/);
  assert.match(html, /<script src="reports\.js"><\/script>/);
  assert.ok(html.indexOf('src="charts.js"') < html.indexOf('src="reports.js"'), 'reports.js after charts.js');
  // the model's files load on demand (reports.js), not with the page
  for (const f of ['model.js', 'model-engine.js', 'model.css']) {
    assert.ok(!html.includes(f), `${f} must not load with the page`);
    assert.ok(fs.existsSync(path.join(DASH, f)), `dashboard/${f} missing`);
  }
});
// gitignore semantics, as Vercel applies them: a pattern with no slash except a trailing one
// matches a file or directory of that name at ANY depth ('data/' drops dashboard/reports/data);
// a leading or inner slash anchors it to the root. '*' never crosses a '/'.
function ignoreMatcher(pattern) {
  const dirOnly = pattern.endsWith('/');
  let p = pattern.replace(/\/$/, '');
  const anchored = p.includes('/');
  p = p.replace(/^\//, '');
  const body = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
  const re = new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}$`);
  // a path is ignored when it, or any directory above it, matches
  return file => {
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/');
      if ((i < parts.length || !dirOnly) && re.test(sub)) return true;
    }
    return false;
  };
}
check('.vercelignore does not drop dashboard/reports (the JSON is served statically)', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  const served = ['dashboard/reports.js', 'dashboard/reports.css', 'dashboard/reports/index.json',
    'dashboard/model.js', 'dashboard/model.css', 'dashboard/model-engine.js', 'dashboard/reports/models/crwv.json',
    ...reportFiles.map(f => `dashboard/reports/${f}`), 'dashboard/reports/data/crwv_financials.json'];
  for (const l of lines) {
    if (l.startsWith('!')) continue;
    const hit = served.filter(ignoreMatcher(l));
    assert.ok(!hit.length, `.vercelignore line "${l}" would drop ${hit.join(', ')}`);
  }
  // the matcher itself: a slash-less directory pattern matches at any depth, an anchored one does not
  assert.ok(ignoreMatcher('data/')('dashboard/reports/data/x.json'));
  assert.ok(!ignoreMatcher('/data/')('dashboard/reports/data/x.json'));
  assert.ok(ignoreMatcher('/data/')('data/tierb/x.parquet'));
  assert.ok(ignoreMatcher('*.log')('a/b/c.log') && !ignoreMatcher('/engine/')('dashboard/engine.js'));
});
check('scenarios: an optional Restructuring case renders first, in a four-card grid', () => withDOM(F => {
  const r = clone(FIX);
  const blk = r.sections[2].blocks[2];
  blk.rows.push({ name: 'Restructuring', value: '≈ US$0', prob: '15%', text: 'Equity wiped out [s1].' });
  eq(validateReport(r, { file: 'fxr.json' }), []);
  const { el } = R._internal.build(r);
  eq(F.all(el).filter(e => e.getAttribute('class') === 'rpt-scen-name').map(e => e.textContent), ['Restructuring case', 'Bear case', 'Base case', 'Bull case']);
  assert.ok(F.all(el).some(e => e.getAttribute('class') === 'rpt-scen n4'));
}));
check('bars: value labels never overprint (3 series x 8 groups, adjacent negatives)', () => withDOM(F => {
  const r = clone(FIX);
  const labels = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'];
  r.sections[1].blocks = [{ type: 'bars', title: 'Cash', unit: 'US$ m', labels,
    series: [{ name: 'OCF', values: [-140, 506, 1800, 2700, 1200, 980, 3300, 2010] },
      { name: 'Capex', values: [-1407, -3498, -2453, -1910, -2800, -4100, -5200, -6100] },
      { name: 'FCF', values: [-1346, -3311, -2704, 790, -1600, -3120, -1900, -4090] }] }];
  const { el } = R._internal.build(r);
  F.doc.body.appendChild(el);
  const svg = F.all(el).find(e => e.localName === 'svg');
  const W = +svg.getAttribute('viewBox').split(' ')[2];
  eq(+svg.getAttribute('width'), W, 'the SVG carries its own width (never scaled past 1:1)');
  const boxes = F.all(svg).filter(e => e.getAttribute('class') === 'rpt-val').map(t => {
    const x = +t.getAttribute('x'), y = +t.getAttribute('y'), w = t.textContent.length * 6.2;
    return { x0: x - w / 2, x1: x + w / 2, y0: y - 9, y1: y + 2, t: t.textContent };
  });
  assert.ok(boxes.length >= 16, `most labels still shown (${boxes.length})`);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(!(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1), `labels ${a.t} and ${b.t} overlap`);
  }
  eq(F.all(svg).filter(e => e.localName === 'rect').length, 24, 'every bar is still drawn');
}));
check('browser load defines only window.Reports', () => {
  const vm = require('vm');
  const ctx = {};
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(DASH, 'reports.js'), 'utf8'), ctx, { filename: 'reports.js' });
  eq(Object.keys(ctx).filter(k => k !== 'self'), ['Reports']);
  eq(Object.keys(ctx.Reports).sort(), ['_internal', 'findByTicker', 'renderList', 'renderReport', 'richText', 'unmount']);
});
check('browser load: model.js defines only window.ReportModel, model-engine.js only window.ModelEngine', () => {
  const vm = require('vm');
  for (const [f, name] of [['model.js', 'ReportModel'], ['model-engine.js', 'ModelEngine']]) {
    const ctx = {};
    ctx.self = ctx;
    vm.createContext(ctx);
    vm.runInContext(fs.readFileSync(path.join(DASH, f), 'utf8'), ctx, { filename: f });
    eq(Object.keys(ctx).filter(k => k !== 'self'), [name], f);
  }
});
check('model.js: never assigns innerHTML / outerHTML / insertAdjacentHTML, never evals', () => {
  const src = fs.readFileSync(path.join(DASH, 'model.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  for (const re of [/\.innerHTML\s*=/, /\.outerHTML\s*=/, /insertAdjacentHTML/, /\beval\s*\(/, /new Function/, /document\.write/]) assert.ok(!re.test(src), `model.js matches ${re}`);
});
check('model.js helpers: formatting, axis values, plain-English driver lines, quarterly guide', () => {
  const MI = require(path.join(DASH, 'model.js'))._internal;
  eq(MI.fmt(1234.5, 'US$m', 0), 'US$1,235m');
  eq(MI.fmt(-0.04, '%', 1, true), '0.0%', 'no −0');
  eq(MI.fmt(-12.3, 'bp', 0), '−12 bp');
  eq(MI.fmt(25, 'bp', 0, true), '+25 bp');
  eq(MI.fmt(null, 'x', 1), '—');
  eq(MI.money(12850), 'US$12.9bn');
  eq(MI.money(1234), 'US$1.23bn');
  eq(MI.money(-450), '−US$450m');
  eq(MI.tone(5, -1), 'neg'); eq(MI.tone(5, 1), 'pos'); eq(MI.tone(0, 1), 'flat');
  const d = { min: -300, max: 500, step: 25, low: -100, high: 200 };
  eq(MI.axisValues(d, 30, 7), [-100, -50, 0, 30, 50, 100, 150, 200]);
  eq(MI.driverNoun('SOFR shift'), 'SOFR'); eq(MI.driverNoun('Capex'), 'capex');
  eq(MI.moveText({ kind: 'shift_bp', unit: 'bp', label: 'SOFR shift', dp: 0 }, 0, 100), 'A 100 bp rise in SOFR');
  eq(MI.moveText({ kind: 'scale_pct', unit: '%', label: 'Capex', dp: 0 }, 0, -25), '25% less capex');
  const sens = ME.sensitivity(FIX_MODEL, {}, { metric: 'net_income', year: 2027 });
  const lines = MI.keyDriverLines(sens, ME.drivers(FIX_MODEL), 'FY2027E net income', 'US$m');
  assert.ok(lines.length === 5, `5 lines (${lines.length})`);
  assert.ok(lines.every(l => /(cuts|lifts) FY2027E net income by US\$[\d,.]+(m|bn) \(to /.test(l.text)), lines.map(l => l.text).join('\n'));
  const res = ME.project(FIX_MODEL, {});
  const q3 = MI.guideValue(res, FIX_MODEL, { metric: 'interest', period: '2026-Q3' });
  assert.ok(Math.abs(q3 - (res.rows.interest[0] - FIX_MODEL.stub.actuals.interest) / 2) < 1e-9, 'Q3 inside the stub = projected remainder / 2 quarters');
  eq(MI.guideValue(res, FIX_MODEL, { metric: 'interest', period: '2026-Q1' }), null, 'a reported quarter has no model value');
  assert.ok(Math.abs(MI.guideValue(res, FIX_MODEL, { metric: 'interest', period: '2027-Q2' }) - res.rows.interest[1] / 4) < 1e-9);
});
check('renderReport: a model block lazy-mounts ReportModel with the model, the report, the route state; model page view', () => withDOM(async F => {
  const calls = [];
  global.fetch = url => {
    calls.push(url);
    const body = url === 'reports/fxr.json' ? clone(FIX) : url === 'reports/models/fxr.json' ? clone(FIX_MODEL) : null;
    return Promise.resolve(body ? { ok: true, status: 200, json: () => Promise.resolve(body) } : { ok: false, status: 404, json: () => Promise.reject(new Error('404')) });
  };
  const el = F.doc.createElement('div');
  F.doc.body.appendChild(el);
  // No browser (no window/head) and no preloaded modules: the slot says so, nothing throws.
  await R.renderReport(el, 'fxr');
  await new Promise(res => setImmediate(res));
  assert.match(F.all(el).find(e => e.getAttribute('class') === 'rpt-model-slot').textContent, /couldn’t load/);
  R.unmount();
  // Preloaded engine + UI: mounted once per block, with the parsed model and the report.
  const mounted = [];
  let disposed = 0;
  global.ModelEngine = ME;
  global.ReportModel = { mount: (slot, o) => { mounted.push(o); const d = () => { disposed++; }; d.getState = () => o.state; d.setState = s => { o.state = s; }; return d; } };
  try {
    await R.renderReport(el, 'fxr', { m: 'eyJ2IjoxfQ' });
    await new Promise(res => setImmediate(res));
    eq(mounted.length, 1);
    eq(mounted[0].model.slug, 'fxr'); eq(mounted[0].report.slug, 'fxr'); eq(mounted[0].state, 'eyJ2IjoxfQ');
    eq(mounted[0].links, { self: '#/reports/fxr', full: '#/reports/fxr/model', report: '#/reports/fxr' });
    assert.ok(typeof mounted[0].rich.inline === 'function' && typeof mounted[0].onState === 'function');
    // the report's citations resolve in the model's text
    const sup = mounted[0].rich.cite(['s3']);
    eq(sup.textContent, '3');
    assert.ok(calls.includes('reports/models/fxr.json'));
    // same report again with a new ?m: applied in place, no refetch
    const n = calls.length;
    await R.renderReport(el, 'fxr', { m: 'eyJ2IjoyfQ' });
    eq(calls.length, n); eq(mounted.length, 1); eq(mounted[0].state, 'eyJ2IjoyfQ');
    // a junk ?m never reaches the model
    R.unmount();
    eq(disposed, 1, 'leaving disposes the model');
    await R.renderReport(el, 'fxr', { m: '"><script>' });
    await new Promise(res => setImmediate(res));
    eq(mounted[1].state, '');
    // #/reports/fxr/model: strip + the model alone + sources, safe tree
    await R.renderReport(el, 'fxr', { view: 'model' });
    await new Promise(res => setImmediate(res));
    assertSafeTree(F, el);
    const art = el.firstChild;
    eq(art.getAttribute('data-rpt-view'), 'model');
    assert.match(art.textContent, /Stress test & projections/);
    assert.match(art.textContent, /Back to the report/);
    eq(F.all(art).filter(e => /rpt-sec\b/.test(e.getAttribute('class') || '') && e.getAttribute('id') !== 'rpt-sec-sources').length, 0, 'no report sections');
    eq(mounted[2].standalone, true); eq(mounted[2].links.self, '#/reports/fxr/model');
    assert.ok(F.doc.getElementById('src-s3'), 'sources listed for the model citations');
    R.unmount();
  } finally { delete global.ModelEngine; delete global.ReportModel; }
}));

(async () => {
  for (const [name, fn] of queue) {
    try { await fn(); passed++; }
    catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e && e.message).split('\n').join('\n     ')}`); }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
