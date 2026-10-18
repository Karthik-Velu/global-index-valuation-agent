#!/usr/bin/env node
// Playwright smoke test of the dashboard (ADR-037) — LOCAL ONLY, not run in CI.
//
// Drives the real dashboard/ (served by `python -m http.server` on a free port) in
// Chromium with every external dependency replaced:
//   - CDN libraries come from npm-packed copies (supabase-js 2.45.4, lightweight-charts
//     4.2.3 — both checked against the SRI hashes pinned in the page) and a Tailwind build
//     of the dashboard's own classes, all kept in the --work directory (never the repo);
//   - Supabase Auth + PostgREST are an in-memory stub (signed out, a trusted owner, an
//     untrusted account);
//   - /api/screen-builder runs the REAL api/screen-builder.js in this process, with its
//     fetch stubbed (Supabase RPCs + canned model replies) — no keys, no network;
//   - TradingView's embed script is a stand-in that reports what the sandbox lets it reach.
// Fixtures are synthetic (tests/fixtures/screen_stocks.json, smoke_account.json,
// smoke_screen_builder.json: fictitious tickers FXA.., a placeholder example.com user;
// tests/fixtures/reports/sample.json: the Key report for "Fixture Corp", FXR). A real
// dashboard/reports/crwv.json, when present, is rendered too (it is public already).
// The market scoreboard is dashboard/dashboard_data.json, which is public already.
// Screenshots go to <work>/shots — never into the repo.
//
// usage:
//   NODE_PATH="$(npm root -g)" node scripts/smoke_dashboard.js --work <dir outside the repo>
//       [--orig-ref origin/main] [--only <substring>] [--offline]
// --work is created if needed; the first run `npm pack`s the libraries and `npm install`s
// tailwindcss@3.4.17 into it (--offline: use what is there, else run unstyled).
// Exit code 0 only when every step passes.
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const assert = require('assert');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DASH = path.join(REPO, 'dashboard');

// ---------------------------------------------------------------- arguments
const ARGS = (() => {
  const a = { work: null, origRef: 'origin/main', only: null, offline: false };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--work') a.work = v[++i];
    else if (v[i] === '--orig-ref') a.origRef = v[++i];
    else if (v[i] === '--only') a.only = v[++i];
    else if (v[i] === '--offline') a.offline = true;
    else { console.error(`unknown argument ${v[i]}`); process.exit(2); }
  }
  if (!a.work) { console.error('usage: node scripts/smoke_dashboard.js --work <dir outside the repo> [--orig-ref REF] [--only TEXT] [--offline]'); process.exit(2); }
  a.work = path.resolve(a.work);
  if (a.work === REPO || a.work.startsWith(REPO + path.sep)) { console.error('--work must be outside the repository (screenshots and npm packages go there)'); process.exit(2); }
  return a;
})();
const WORK = ARGS.work;
const SHOTS = path.join(WORK, 'shots');
const VENDOR = path.join(WORK, 'vendor');

function loadPlaywright() {
  try { return require('playwright'); } catch { /* try the global install */ }
  const root = execFileSync('npm', ['root', '-g']).toString().trim();
  return require(path.join(root, 'playwright'));
}

// ---------------------------------------------------------------- fixtures
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const DATA = readJSON(path.join(DASH, 'dashboard_data.json'));
const STOCKS = readJSON(path.join(REPO, 'tests/fixtures/screen_stocks.json'));
const ACCOUNT = readJSON(path.join(REPO, 'tests/fixtures/smoke_account.json'));
const MODEL = readJSON(path.join(REPO, 'tests/fixtures/smoke_screen_builder.json')).model_replies;
// Key reports: the fixture is served as reports/fxr.json with a one-entry index (newCtx
// {reports: 'fixture'}); otherwise the real dashboard/reports/ files are served as they are.
const REPORT_FIX = readJSON(path.join(REPO, 'tests/fixtures/reports/sample.json'));
// ...and its stress-test model (synthetic), served as reports/models/fxr.json.
const MODEL_FIX = readJSON(path.join(REPO, 'tests/fixtures/models/fxr.json'));
const REPORT_FIX_INDEX = { v: 1, reports: [{ slug: REPORT_FIX.slug, ticker: REPORT_FIX.ticker, company: REPORT_FIX.company,
  title: REPORT_FIX.title, published: REPORT_FIX.published, stance: { label: REPORT_FIX.stance.label, risk: REPORT_FIX.stance.risk },
  summary: REPORT_FIX.stance.summary, report_type: REPORT_FIX.report_type, sector: REPORT_FIX.sector }] };
const ScreenDSL = require(path.join(DASH, 'screen-dsl.js'));
const SB_URL = (DATA.meta && DATA.meta.supabase && DATA.meta.supabase.url) || '';
if (!SB_URL) { console.error('dashboard_data.json has no meta.supabase.url — sign-in cannot be exercised'); process.exit(2); }
const SB_ORIGIN = new URL(SB_URL).origin;
const SB_REF = new URL(SB_URL).hostname.split('.')[0];
const UID = ACCOUNT.user.id;
const OTHER_UID = '00000000-0000-4000-8000-00000000a002';
const ASOF = ACCOUNT.snapshot_asof;

const CDN = {
  tailwind: 'https://cdn.tailwindcss.com/3.4.17',
  tailwindOrig: 'https://cdn.tailwindcss.com/',
  supabase: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  supabaseOrig: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js',
  lwc: 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js',
  tv: 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
};

// The trusted stock snapshot, columnar as engine/screenjobs.py writes it.
function snapshotPayload() {
  const fields = ScreenDSL.fields('stocks').map(f => f.key);
  const rows = STOCKS.map(r => fields.map(k => (r[k] === undefined ? null : r[k])));
  const hidden = STOCKS.filter(r => r.data_ok === false);
  const excluded = {};
  for (const r of hidden) for (const c of r.data_flags || []) excluded[c] = (excluded[c] || 0) + 1;
  return { v: 1, asof: ASOF, fields, rows, n: rows.length, n_hidden: hidden.length, excluded_counts: excluded,
    coverage: { price_mcap: 1, pe: 1 } };
}

// chart_series: one shared weekday calendar + per-stock closes built so that the chart's
// own 2-year mean equals price / (1 + discount_long) — the screen's long-run average.
function chartSeries() {
  const n = ACCOUNT.calendar.trading_days, t0 = Date.parse(`${ACCOUNT.calendar.start_date}T00:00:00Z`);
  const days = [];
  for (let d = 0; days.length < n; d++) { const wd = new Date(t0 + d * 864e5).getUTCDay(); if (wd && wd !== 6) days.push(d); }
  const out = { 'calendar:us': { key: 'calendar:us', kind: 'calendar', asof: ASOF, start_date: ACCOUNT.calendar.start_date, days, closes: null, fundamentals: null } };
  for (const [i, r] of STOCKS.entries()) {
    if (typeof r.price !== 'number') continue;
    const avg = typeof r.discount_long === 'number' ? r.price / (1 + r.discount_long) : r.price;
    const base = days.map((_, j) => 1 + 0.12 * Math.sin(j / (25 + 3 * i)) + 0.04 * Math.cos(j / 7));
    const k = (avg * n - r.price) / base.slice(0, n - 1).reduce((s, x) => s + x, 0);
    const closes = base.map((b, j) => (j === n - 1 ? r.price : Math.fround(+(b * k).toFixed(2))));
    if (i % 5 === 1) closes[200] = null;   // a missing bar
    out[`stock:${r.ticker}`] = { key: `stock:${r.ticker}`, kind: 'stock', asof: ASOF, start_date: ACCOUNT.calendar.start_date, days: null,
      closes, fundamentals: ACCOUNT.fundamentals[r.ticker] || null };
  }
  return out;
}

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const fakeJwt = (sub, email) => `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u({ sub, email, role: 'authenticated', aud: 'authenticated',
  exp: Math.floor(Date.now() / 1000) + 3600 })}.c21va2U`;
function sessionFor(uid, email) {
  const user = { id: uid, aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-01-01T00:00:00Z',
    is_anonymous: false, app_metadata: { provider: 'email' }, user_metadata: {} };
  return { access_token: fakeJwt(uid, email), refresh_token: 'smoke-refresh', token_type: 'bearer', expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user };
}

// ---------------------------------------------------------------- in-memory Supabase
function makeDB({ trusted }) {
  const clone = x => JSON.parse(JSON.stringify(x));
  return {
    uid: UID, trusted, quota: 5, seq: 0, log: [], api: [],
    user_watchlist: [],
    watchlists: [], watchlist_items: [],
    saved_screens: clone(ACCOUNT.saved_screens).map(s => ({ user_id: UID, ...s })),
    screen_alerts: clone(ACCOUNT.screen_alerts).map(a => ({ user_id: UID, ...a })),
    snapshot: snapshotPayload(),
    series: chartSeries(),
  };
}

function rowFilter(url) {
  const tests = [];
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
    const m = /^(eq|neq|in)\.(.*)$/s.exec(v);
    if (!m) continue;
    if (m[1] === 'in') {
      const vals = m[2].replace(/^\(|\)$/g, '').split(',').map(x => x.replace(/^"|"$/g, ''));
      tests.push(r => vals.includes(String(r[k])));
    } else if (m[1] === 'eq') tests.push(r => String(r[k]) === m[2]);
    else tests.push(r => String(r[k]) !== m[2]);
  }
  return r => tests.every(t => t(r));
}
const pick = (row, sel) => {
  if (!sel || sel === '*') return row;
  const o = {};
  for (const c of sel.split(',')) if (!c.includes('(')) o[c] = row[c];
  return o;
};

// route handler for <SB_ORIGIN>/** — user: null (signed out) or the session's user id.
function supabaseStub(db, { userId }) {
  return async route => {
    const req = route.request(), url = new URL(req.url()), p = url.pathname, method = req.method();
    const accept = req.headers().accept || '';
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
    const send = (obj, status = 200, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers: { ...cors, ...headers }, body: JSON.stringify(obj) });
    const empty = (status = 204, headers = {}) => route.fulfill({ status, headers: { ...cors, ...headers }, body: '' });
    const rows = list => (/vnd\.pgrst\.object/.test(accept)
      ? (list.length === 1 ? send(list[0]) : send({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }, 406))
      : send(list));
    if (method === 'OPTIONS') return route.fulfill({ status: 200, headers: { ...cors, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    let body = null;
    try { body = req.postData() ? JSON.parse(req.postData()) : null; } catch { body = null; }
    db.log.push({ method, path: p, search: url.search, body });
    if (p === '/auth/v1/otp') return send({});
    if (p === '/auth/v1/logout') return empty();
    if (p === '/auth/v1/user') return userId ? send({ id: userId, email: ACCOUNT.user.email, aud: 'authenticated' }) : send({ code: 401, msg: 'invalid JWT' }, 401);
    if (p.startsWith('/auth/')) return send({ error: 'unsupported in smoke stub' }, 400);
    if (!userId) return send({ code: '42501', message: 'permission denied' }, 401);
    const match = rowFilter(url);
    const sel = url.searchParams.get('select') || '*';
    const now = () => new Date(Date.UTC(2026, 9, 14, 0, 0, ++db.seq)).toISOString();
    const uuid = () => `00000000-0000-4000-8000-${String(900000000000 + ++db.seq)}`;

    switch (p) {
      case '/rest/v1/rpc/is_trusted': return send(!!db.trusted);
      case '/rest/v1/user_watchlist':
        if (method === 'GET') return send(db.user_watchlist.map(k => ({ market_key: k })));
        if (method === 'POST') { if (!db.user_watchlist.includes(body.market_key)) db.user_watchlist.push(body.market_key); return empty(201); }
        if (method === 'DELETE') { db.user_watchlist = db.user_watchlist.filter(k => !match({ market_key: k })); return empty(); }
        break;
      case '/rest/v1/screener_snapshots':
        return rows(db.trusted ? [{ asof: db.snapshot.asof, payload: db.snapshot }] : []);
      case '/rest/v1/chart_series':
        return rows(db.trusted ? Object.values(db.series).filter(match).map(r => pick(r, sel)) : []);
      case '/rest/v1/saved_screens': {
        if (method === 'GET') return rows(db.saved_screens.filter(match).sort((a, b) => b.updated_at.localeCompare(a.updated_at)).map(r => pick(r, sel)));
        if (method === 'POST') {
          if (body.user_id !== userId || (body.scope === 'stocks' && !db.trusted)) return send({ code: '42501', message: 'new row violates row-level security policy for table "saved_screens"' }, 403);
          const r = { id: uuid(), last_evaluated_asof: null, created_at: now(), updated_at: now(), ...body };
          db.saved_screens.push(r);
          return rows([pick(r, sel)]);
        }
        if (method === 'PATCH') { const hit = db.saved_screens.filter(match); hit.forEach(r => Object.assign(r, body, { updated_at: now() })); return rows(hit.map(r => pick(r, sel))); }
        if (method === 'DELETE') { db.saved_screens = db.saved_screens.filter(r => !match(r)); return empty(); }
        break;
      }
      case '/rest/v1/watchlists': {
        if (method === 'GET') {
          let list = db.watchlists.filter(match).sort((a, b) => a.created_at.localeCompare(b.created_at));
          const lim = Number(url.searchParams.get('limit')); if (lim) list = list.slice(0, lim);
          return rows(list.map(w => (sel.includes('watchlist_items')
            ? { id: w.id, name: w.name, created_at: w.created_at,
              watchlist_items: db.watchlist_items.filter(i => i.watchlist_id === w.id).map(({ kind, item_key, note, added_at }) => ({ kind, item_key, note, added_at })) }
            : pick(w, sel))));
        }
        if (method === 'POST') {
          if (body.user_id !== userId) return send({ code: '42501', message: 'new row violates row-level security policy' }, 403);
          if (db.watchlists.some(w => w.name === body.name)) return send({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409);
          const w = { id: uuid(), user_id: userId, name: body.name, created_at: now() };
          db.watchlists.push(w);
          return rows([pick(w, sel)]);
        }
        if (method === 'PATCH') { db.watchlists.filter(match).forEach(w => Object.assign(w, body)); return empty(); }
        if (method === 'DELETE') {
          const gone = db.watchlists.filter(match).map(w => w.id);
          db.watchlists = db.watchlists.filter(w => !gone.includes(w.id));
          db.watchlist_items = db.watchlist_items.filter(i => !gone.includes(i.watchlist_id));
          return empty();
        }
        break;
      }
      case '/rest/v1/watchlist_items': {
        if (method === 'POST') {
          for (const it of Array.isArray(body) ? body : [body]) {
            if (it.user_id !== userId || !db.watchlists.some(w => w.id === it.watchlist_id)) return send({ code: '42501', message: 'new row violates row-level security policy' }, 403);
            if (!db.watchlist_items.some(i => i.watchlist_id === it.watchlist_id && i.kind === it.kind && i.item_key === it.item_key)) {
              db.watchlist_items.push({ ...it, note: null, added_at: now() });
            }
          }
          return empty(201);
        }
        if (method === 'DELETE') { db.watchlist_items = db.watchlist_items.filter(i => !match(i)); return empty(); }
        break;
      }
      case '/rest/v1/screen_alerts': {
        if (method === 'HEAD' || (/count=exact/.test(req.headers().prefer || '') && sel === 'id')) {
          return empty(200, { 'Content-Range': `*/${db.screen_alerts.filter(match).length}` });
        }
        if (method === 'GET') {
          return send(db.screen_alerts.filter(match).map(({ user_id, ...a }) => {
            const s = db.saved_screens.find(x => x.id === a.screen_id);
            return { ...a, saved_screens: s ? { name: s.name, scope: s.scope } : null };
          }));
        }
        if (method === 'PATCH') {
          // 0015 grants UPDATE (seen) only.
          if (Object.keys(body || {}).some(k => k !== 'seen')) return send({ code: '42501', message: 'permission denied for table screen_alerts' }, 403);
          db.screen_alerts.filter(match).forEach(a => { a.seen = body.seen; });
          return empty();
        }
        break;
      }
    }
    return send({ code: 'PGRST205', message: 'Could not find the table in the schema cache' }, 404);
  };
}

// ---------------------------------------------------------------- the real AI screen builder
const SB_FAKE_API = 'https://smoke-supabase.invalid';
const PROVIDER_URLS = ['https://api.groq.com/', 'https://ollama.com/', 'https://openrouter.ai/'];
process.env.SUPABASE_URL = SB_FAKE_API;
process.env.SUPABASE_ANON_KEY = 'smoke-anon-key';
process.env.GROQ_API_KEY = 'smoke-not-a-key';
delete process.env.OLLAMA_API_KEY; delete process.env.OPENROUTER_API_KEY; delete process.env.ALLOWED_ORIGINS;
const screenBuilder = require(path.join(REPO, 'api/screen-builder.js'));

let CURRENT_DB = null;     // the db of the context whose request is being handled
const jsonResponse = (status, obj) => new Response(obj === undefined ? '' : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
// The function's only outbound calls: Supabase (auth + two RPCs) and the model tiers.
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const db = CURRENT_DB;
  if (url.startsWith(SB_FAKE_API)) {
    const p = new URL(url).pathname;
    const tok = String((init.headers || {}).Authorization || '').replace(/^Bearer /, '');
    const claims = (() => { try { return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()); } catch { return null; } })();
    if (!claims) return jsonResponse(401, { msg: 'invalid JWT' });
    if (p === '/auth/v1/user') return jsonResponse(200, { id: claims.sub, email: claims.email, is_anonymous: false });
    if (p === '/rest/v1/rpc/is_trusted') return jsonResponse(200, !!(db && db.trusted && claims.sub === UID));
    if (p === '/rest/v1/rpc/ai_quota_take') { const ok = !!db && db.quota > 0; if (ok) db.quota--; return jsonResponse(200, ok); }
    return jsonResponse(404, {});
  }
  if (PROVIDER_URLS.some(u => url.startsWith(u))) {
    let sentence = '';
    try { const b = JSON.parse(init.body); sentence = b.messages.find(m => m.role === 'user').content; } catch { /* malformed */ }
    const reply = MODEL[String(sentence).toLowerCase()];
    if (db) db.api.push({ provider: url, sentence });
    if (!reply) return jsonResponse(503, { error: 'no canned reply' });
    return jsonResponse(200, { choices: [{ message: { content: JSON.stringify(reply) } }] });
  }
  throw new Error(`smoke: unexpected fetch ${url}`);
};

async function screenBuilderRoute(route, db) {
  const req = route.request();
  const u = new URL(req.url());
  const headers = { ...(await req.allHeaders()), host: u.host };
  const body = req.postData() || '';
  const res = { statusCode: 200, headers: {}, headersSent: false, body: '',
    setHeader(k, v) { this.headers[String(k).toLowerCase()] = String(v); },
    end(b) { this.body = b == null ? '' : String(b); this.headersSent = true; } };
  // The function logs one status line per request; keep it with the call record.
  const lines = [], log = console.log;
  CURRENT_DB = db;
  console.log = (...x) => lines.push(x.join(' '));
  try { await screenBuilder({ method: req.method(), headers, body, url: u.pathname }, res); }
  finally { CURRENT_DB = null; console.log = log; }
  let parsed = null;
  try { parsed = JSON.parse(res.body); } catch { parsed = null; }
  db.api.push({ status: res.statusCode, request: (() => { try { return JSON.parse(body); } catch { return null; } })(),
    auth: /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(headers.authorization || ''), response: parsed, log: lines });
  return route.fulfill({ status: res.statusCode, headers: res.headers, body: res.body });
}

// ---------------------------------------------------------------- TradingView stand-in
// Runs inside the sandboxed srcdoc iframe; reports what it could reach.
const TV_FAKE = `(function(){var s=document.currentScript,cfg={};try{cfg=JSON.parse(s.textContent)}catch(e){}
var ls;try{localStorage.getItem('x');ls='readable'}catch(e){ls='blocked'}
var par;try{par=String(parent.document.title)}catch(e){par='blocked'}
var w=document.getElementById('w'),f=document.createElement('div');f.style.cssText='height:100%;background:#13233a;color:#60a5fa;font:12px sans-serif;padding:8px';
f.textContent='TradingView stand-in: '+cfg.symbol;w.appendChild(f);
parent.postMessage({tvfake:true,symbol:cfg.symbol,ls:ls,par:par,origin:String(self.origin)},'*');})();`;

// ---------------------------------------------------------------- preparation
function sh(cmd, args, opts = {}) { return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString(); }

function npmPackage(spec, dirName, file) {
  const dir = path.join(VENDOR, dirName);
  const target = path.join(dir, 'package', file);
  if (fs.existsSync(target)) return fs.readFileSync(target);
  if (ARGS.offline) return null;
  fs.mkdirSync(dir, { recursive: true });
  const tgz = sh('npm', ['pack', spec, '--silent', '--pack-destination', dir]).trim().split('\n').pop();
  sh('tar', ['-xzf', path.join(dir, tgz), '-C', dir]);
  return fs.readFileSync(target);
}

// Tailwind classes used by the dashboard, compiled once per run (the Play CDN's runtime
// compiler can't be vendored); the stub defines window.tailwind like the real script.
function tailwindCSS() {
  const twDir = path.join(VENDOR, 'tailwind');
  const cli = path.join(twDir, 'node_modules', 'tailwindcss', 'lib', 'cli.js');
  if (!fs.existsSync(cli)) {
    if (ARGS.offline) return '';
    fs.mkdirSync(twDir, { recursive: true });
    sh('npm', ['install', '--prefix', twDir, '--no-save', '--no-audit', '--no-fund', '--silent', 'tailwindcss@3.4.17']);
  }
  const cfg = path.join(twDir, 'tailwind.config.js'), inp = path.join(twDir, 'in.css'), out = path.join(twDir, 'out.css');
  // The same theme index.html gives the Play CDN.
  fs.writeFileSync(cfg, `module.exports = { darkMode: 'class', content: ${JSON.stringify([path.join(DASH, '*.html'), path.join(DASH, '*.js')])},
  theme: { extend: { colors: { ink: '#0b0f17', panel: '#121826', panel2: '#1a2235', line: '#243049',
    cheap: '#34d399', rich: '#f87171', warn: '#fbbf24', accent: '#60a5fa' } } } };\n`);
  fs.writeFileSync(inp, '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n');
  sh(process.execPath, [cli, '-c', cfg, '-i', inp, '-o', out, '--minify']);
  return fs.readFileSync(out, 'utf8');
}

// The dashboard as it was before this feature (Overview identity check).
function originalDashboard() {
  const dir = path.join(WORK, 'orig');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  let files;
  try { files = sh('git', ['-C', REPO, 'ls-tree', '--name-only', `${ARGS.origRef}:dashboard`]).trim().split('\n'); }
  catch { return null; }
  for (const f of files) {
    if (f === 'dashboard_data.json') continue;
    fs.writeFileSync(path.join(dir, f), execFileSync('git', ['-C', REPO, 'show', `${ARGS.origRef}:dashboard/${f}`]));
  }
  fs.copyFileSync(path.join(DASH, 'dashboard_data.json'), path.join(dir, 'dashboard_data.json'));
  const same = fs.readFileSync(path.join(dir, 'app.js'), 'utf8') === fs.readFileSync(path.join(DASH, 'app.js'), 'utf8');
  return same ? null : dir;
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
async function serve(dir) {
  const port = await freePort();
  const proc = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', dir], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise(r => http.get(url, res => { res.resume(); r(res.statusCode === 200); }).on('error', () => r(false)));
    if (ok) return { url, proc };
    await new Promise(r => setTimeout(r, 100));
  }
  proc.kill();
  throw new Error(`http.server did not start for ${dir}`);
}

// ---------------------------------------------------------------- browser contexts
let LIB = {};
const IGNORED_CONSOLE = /Failed to load resource|net::ERR_/;

async function newCtx(browser, base, { viewport = { width: 1280, height: 900 }, user = null, trusted = false, cdn = true, db = null, reports = null } = {}) {
  const ctx = await browser.newContext({ viewport, locale: 'en-US', timezoneId: 'UTC' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !IGNORED_CONSOLE.test(m.text())) errors.push(`console: ${m.text()}`); });
  page.on('dialog', d => { errors.push(`dialog: ${d.type()} ${d.message()}`); d.dismiss().catch(() => {}); });
  db = db || makeDB({ trusted });
  const local = new URL(base).origin;
  const js = body => ({ status: 200, contentType: 'application/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.origin === local) {
      if (u.pathname === '/api/screen-builder') return screenBuilderRoute(route, db);
      if (u.pathname.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      if (reports === 'fixture' && u.pathname.startsWith('/reports/')) {
        db.reportFetches = (db.reportFetches || []).concat(u.pathname);
        const body = u.pathname === '/reports/index.json' ? REPORT_FIX_INDEX : u.pathname === `/reports/${REPORT_FIX.slug}.json` ? REPORT_FIX
          : u.pathname === `/reports/models/${MODEL_FIX.slug}.json` ? MODEL_FIX : null;
        return body ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
          : route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      }
      return route.continue();
    }
    if (u.origin === SB_ORIGIN) return supabaseStub(db, { userId: user })(route);
    if (!cdn) return route.abort();
    if (u.href === CDN.tailwind || u.href === CDN.tailwindOrig) {
      return route.fulfill(js(`window.tailwind={config:{}};document.head.insertAdjacentHTML('beforeend',${JSON.stringify(`<style>${LIB.tw}</style>`)});`));
    }
    if ((u.href === CDN.supabase || u.href === CDN.supabaseOrig) && LIB.supabase) return route.fulfill(js(LIB.supabase));
    if (u.href === CDN.lwc && LIB.lwc) return route.fulfill(js(LIB.lwc));
    if (u.href === CDN.tv) return route.fulfill(js(TV_FAKE));
    return route.abort();
  });
  if (user) {
    const s = sessionFor(user, user === UID ? ACCOUNT.user.email : 'someone@example.com');
    await page.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch { /* blocked */ } }, [`sb-${SB_REF}-auth-token`, JSON.stringify(s)]);
  }
  await page.addInitScript(() => {
    // Every hash the page has had (the router must never rewrite an auth fragment), and
    // the TradingView stand-in's reports.
    window.__hashes = [location.hash];
    window.addEventListener('hashchange', () => window.__hashes.push(location.hash));
    for (const fn of ['replaceState', 'pushState']) {
      const orig = history[fn].bind(history);
      history[fn] = (s, t, u) => { window.__hashes.push(`${fn}:${u}`); return orig(s, t, u); };
    }
    window.__tv = [];
    window.addEventListener('message', e => { if (e.data && e.data.tvfake) window.__tv.push(e.data); });
  });
  return { ctx, page, errors, db };
}

const settle = (page, ms = 250) => page.waitForTimeout(ms);
async function boot(a, base, hash = '') {
  await a.page.goto(base + hash, { waitUntil: 'load' });
  await a.page.waitForFunction(() => document.querySelector('#tbody tr') && typeof ROUTER !== 'undefined' && ROUTER.started, null, { timeout: 15000 });
  await settle(a.page);
}
const text = (page, sel) => page.$eval(sel, e => e.textContent.replace(/\s+/g, ' ').trim());
const noHScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
async function go(page, hash) { await page.evaluate(h => { location.hash = h; }, hash); await settle(page); }

// The Overview's sections, with the attributes this feature adds on purpose normalised away
// (stock rows/cards became clickable: data-tk + a link class + a title).
const overviewSections = page => page.evaluate(() => ['#picks', '#brief', '#insights', '#topOpp', '#topGrowth', '#topValue', '#scatter',
  '#heatmap', '#thead', '#tbody', '#rowcount', '#focus', '#asof', '#meta', '#tuning', '#trackrecord']
  .map(s => [s, (document.querySelector(s)?.innerHTML || '').replace(/ data-tk="[^"]*"/g, '')
    .replace(/ class="stock-link /g, ' class="').replace(/ title="Open [^"]*"/g, '')]));
function sameOverview(na, oa) {
  for (let i = 0; i < na.length; i++) assert.strictEqual(na[i][1], oa[i][1], `Overview section ${na[i][0]} differs from the original`);
}

// ---------------------------------------------------------------- steps
const results = [];
async function step(name, fn) {
  if (ARGS.only && !name.includes(ARGS.only)) return;
  const t = Date.now();
  try { await fn(); results.push(['ok', name]); console.log(`ok    ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push(['FAIL', name]); console.log(`FAIL  ${name}\n${e && (e.stack || e)}`); }
}
const noErrors = a => assert.deepStrictEqual(a.errors, [], 'console/page errors');

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  LIB = {
    supabase: npmPackage('@supabase/supabase-js@2.45.4', 'supabase-js', 'dist/umd/supabase.js'),
    lwc: npmPackage('lightweight-charts@4.2.3', 'lightweight-charts', 'dist/lightweight-charts.standalone.production.js'),
    tw: (() => { try { return tailwindCSS(); } catch (e) { console.log(`(tailwind build unavailable: ${e.message.split('\n')[0]} — running unstyled)`); return ''; } })(),
  };
  if (!LIB.supabase || !LIB.lwc) console.log('(library packages unavailable — run once without --offline)');
  const origDir = originalDashboard();
  const srvNew = await serve(DASH);
  const srvOrig = origDir ? await serve(origDir) : null;
  const NEW = srvNew.url, ORIG = srvOrig && srvOrig.url;
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const PHONE = { width: 390, height: 844 };

  try {
    // 1. Overview unchanged (anonymous, libraries served through their SRI pins).
    await step('overview: identical to the original; supabase-js passes its SRI pin; tabs + inline sign-in', async () => {
      const a = await newCtx(browser, NEW);
      await boot(a, NEW);
      await a.page.waitForFunction(() => Auth.available());
      assert.strictEqual(await a.page.evaluate(() => typeof window.supabase), 'object', 'supabase-js did not load (SRI mismatch?)');
      if (ORIG) {
        const o = await newCtx(browser, ORIG);
        await o.page.goto(ORIG, { waitUntil: 'load' });
        await o.page.waitForFunction(() => document.querySelector('#tbody tr') && typeof Auth !== 'undefined' && Auth.available());
        await settle(o.page);
        sameOverview(await overviewSections(a.page), await overviewSections(o.page));
        noErrors(o);
        await o.ctx.close();
      }
      assert.strictEqual(await a.page.evaluate(() => location.hash), '', 'the router must not add a hash on a plain load');
      assert.deepStrictEqual(await a.page.$$eval('.view-tabs [data-view]', t => t.filter(x => !x.hidden).map(x => x.dataset.view)), ['overview', 'screener', 'reports', 'lists', 'alerts']);
      assert.strictEqual(await a.page.$eval('#alr-badge', b => b.hidden), true);
      await a.page.click('#signInBtn');
      await a.page.fill('#signinEmail', 'someone@example.com');
      await a.page.click('#signinSend');
      await a.page.waitForFunction(() => /Link sent/.test(document.getElementById('signinMsg').textContent));
      const otp = a.db.log.find(r => r.path === '/auth/v1/otp');
      assert.ok(otp, 'magic-link request sent');
      await shot(a.page, 'overview_desktop');
      noErrors(a);
      await a.ctx.close();
    });

    // 2. All CDNs blocked: the Overview still renders exactly as before, nothing throws.
    await step('all CDNs blocked: overview renders (same as the original), drawer + screener degrade quietly', async () => {
      const a = await newCtx(browser, NEW, { cdn: false });
      await boot(a, NEW);
      assert.strictEqual(await a.page.evaluate(() => Auth.available()), false);
      if (ORIG) {
        const o = await newCtx(browser, ORIG, { cdn: false });
        await o.page.goto(ORIG, { waitUntil: 'load' });
        await o.page.waitForFunction(() => document.querySelector('#tbody tr'));
        await settle(o.page);
        sameOverview(await overviewSections(a.page), await overviewSections(o.page));
        await o.ctx.close();
      }
      assert.deepStrictEqual(await a.page.$$eval('.view-tabs [data-view]', t => t.filter(x => !x.hidden).map(x => x.dataset.view)), ['overview', 'screener', 'reports']);
      await a.page.click('#tbody tr[data-mk]');
      await a.page.waitForFunction(() => STATE.drawer && STATE.drawer.kind === 'market');
      await a.page.waitForSelector('#drawer iframe.chr-tv');
      await a.page.keyboard.press('Escape');
      assert.strictEqual(await a.page.evaluate(() => STATE.drawer), null);
      await go(a.page, '#/screener');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      await shot(a.page, 'cdn_blocked_screener');
      noErrors(a);
      await a.ctx.close();
    });

    // 3. Magic link: supabase-js owns the fragment; the router never rewrites it.
    await step('magic-link hash (#access_token=…) is not rewritten by the router', async () => {
      const a = await newCtx(browser, NEW);
      await a.page.goto(`${NEW}#access_token=fake&type=magiclink`, { waitUntil: 'load' });
      await a.page.waitForFunction(() => document.querySelector('#tbody tr') && typeof ROUTER !== 'undefined' && ROUTER.started);
      await settle(a.page, 500);
      const hashes = await a.page.evaluate(() => window.__hashes);
      assert.ok(!hashes.some(h => /#\/|overview/.test(h)), `router rewrote the auth fragment: ${JSON.stringify(hashes)}`);
      assert.strictEqual(await a.page.evaluate(() => STATE.view), 'overview');
      assert.strictEqual(await a.page.$eval('#view-overview', e => e.hidden), false);
      // An incomplete fragment is left for supabase-js (which ignores it); nobody else touches it.
      assert.strictEqual(await a.page.evaluate(() => location.hash), '#access_token=fake&type=magiclink');
      noErrors(a);
      await a.ctx.close();
    });

    // 4. Markets screener, signed out: presets, chips, local rules parser, stocks gated.
    await step('screener (markets, anonymous): preset, rule-based chat, stocks gated, share link', async () => {
      const a = await newCtx(browser, NEW);
      await boot(a, NEW, '#/screener');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      const total = await a.page.$$eval('#view-screener .sbx-table tbody tr', r => r.length);
      assert.ok(total > 10, 'markets listed');
      await a.page.click('[data-scr-act="preset"][data-scr-id="mkt_cheapest"]');
      await a.page.waitForFunction(() => /Sorted by/.test(document.querySelector('#view-screener [data-sbx-part="chips"]').textContent));
      await a.page.fill('#scr-ai-input', 'cheap asian markets');
      await a.page.click('#scr-ai-form button[type="submit"]');
      await a.page.waitForSelector('#scr-thread .scr-turn');
      assert.match(await text(a.page, '#scr-thread .scr-badge'), /^rules · sign in for AI$/);
      assert.strictEqual(a.db.api.length, 0, 'signed out: the AI endpoint is never called');
      await a.page.click('[data-scr-act="ai-apply"]');
      const chips = await text(a.page, '#view-screener [data-sbx-part="chips"]');
      assert.match(chips, /Asia-Pacific/); assert.match(chips, /Value ≥ 70/);
      const rows = await a.page.$$eval('#view-screener .sbx-table tbody tr', r => r.length);
      assert.ok(rows >= 1 && rows < total, `filtered rows: ${rows}`);
      await a.page.click('[data-scr-act="panel"][data-scr-panel="share"]');
      const share = await a.page.$eval('#scr-share-url', e => e.value);
      assert.match(share, /#\/screener\?s=[A-Za-z0-9_-]+$/);
      await a.page.click('[data-scr-act="scope"][data-scr-scope="stocks"]');
      await a.page.waitForSelector('#scr-gate:not([hidden])');
      assert.match(await text(a.page, '#scr-gate'), /limited to the owner/);
      assert.strictEqual(await a.page.$('#view-screener .sbx-table'), null, 'no stock rows for anonymous viewers');
      assert.ok(!a.db.log.some(r => r.path === '/rest/v1/screener_snapshots'), 'anonymous never asks for the stock snapshot');
      // The share link restores the same markets screen in a fresh page.
      const b = await newCtx(browser, NEW);
      await boot(b, NEW, share.slice(share.indexOf('#')));
      await b.page.waitForSelector('#view-screener .sbx-table tbody tr');
      assert.strictEqual(await b.page.$$eval('#view-screener .sbx-table tbody tr', r => r.length), rows);
      noErrors(b); await b.ctx.close();
      await go(a.page, '#/screener');
      await a.page.click('[data-scr-act="scope"][data-scr-scope="markets"]');
      await shot(a.page, 'screener_markets_anon_desktop');
      // Overview scoreboard -> "Open in Screener" carries its filters over.
      await go(a.page, '#/overview');
      const region = await a.page.$eval('#fRegion', s => [...s.options].map(o => o.value).find(Boolean));
      await a.page.selectOption('#fRegion', region);
      const shown = await a.page.$$eval('#tbody tr[data-mk]', r => r.length);
      await a.page.click('#scr-open-scoreboard');
      await a.page.waitForFunction(() => location.hash === '#/screener' && !document.getElementById('view-screener').hidden);
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      assert.match(await text(a.page, '#view-screener [data-sbx-part="chips"]'), new RegExp(`Region: ${region}`));
      assert.strictEqual(await a.page.$$eval('#view-screener .sbx-table tbody tr', r => r.length), shown, 'same markets as the scoreboard showed');
      noErrors(a);
      await a.ctx.close();
    });

    // 5-6. Stocks screener as the trusted owner: AI chat through the real function, the
    // growth guard's fallback to rules, quota, then save with alerts.
    await step('screener (stocks, trusted): AI chat via api/screen-builder.js, rules fallback, quota, save screen', async () => {
      const a = await newCtx(browser, NEW, { user: UID, trusted: true });
      await boot(a, NEW, '#/screener');
      await a.page.click('[data-scr-act="scope"][data-scr-scope="stocks"]');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      assert.match(await text(a.page, '#scr-universe'), new RegExp(`${STOCKS.length} stocks · owner-only snapshot · as of ${ASOF}`));
      assert.match(await text(a.page, '#view-screener [data-sbx-part="hidden"]'), /hidden for data issues/);
      // AI path: the real function validates + growth-guards the canned model reply.
      await a.page.fill('#scr-ai-input', 'cheap profitable tech stocks');
      await a.page.click('#scr-ai-form button[type="submit"]');
      await a.page.waitForFunction(() => /^AI · /.test(document.querySelector('#scr-thread .scr-turn:last-child .scr-badge')?.textContent || ''));
      assert.strictEqual(await text(a.page, '#scr-thread .scr-turn:last-child .scr-badge'), 'AI · groq/llama-3.3-70b-versatile');
      const call = a.db.api.find(x => x.status);
      assert.ok(call && call.auth && call.status === 200, 'POST /api/screen-builder with a Bearer token');
      assert.deepStrictEqual(Object.keys(call.request).sort(), ['current', 'scope', 'sentence']);
      assert.strictEqual(call.request.scope, 'stocks');
      assert.match(await text(a.page, '#scr-thread .scr-turn:last-child .scr-confirm'), /1 match/);
      assert.ok(await a.page.$('#scr-thread [data-scr-act="ai-rules"]'), 'the rules reading stays one click away');
      await a.page.click('#scr-thread [data-scr-act="ai-apply"]');
      assert.deepStrictEqual(await a.page.$$eval('#view-screener .sbx-table tbody tr', r => r.map(x => x.dataset.sbxKey)), ['FXA']);
      // A model answer that maps "growing" to a price field is refused -> rules reading.
      await a.page.fill('#scr-ai-input', 'growing companies');
      await a.page.click('#scr-ai-form button[type="submit"]');
      await a.page.waitForFunction(() => /couldn't read it/.test(document.querySelector('#scr-thread .scr-turn:last-child .scr-badge')?.textContent || ''));
      const diff = await text(a.page, '#scr-thread .scr-turn:last-child .scr-diff');
      assert.match(diff, /Rev CAGR > 0%/, `growth -> fundamental revenue/earnings record: ${diff}`);
      assert.match(diff, /Earnings CAGR > 0%/);
      assert.ok(!/price/i.test(diff), 'growth never becomes a price field');
      // Quota spent -> rules with the fixed note.
      a.db.quota = 0;
      await a.page.fill('#scr-ai-input', 'cheap profitable tech stocks');
      await a.page.click('#scr-ai-form button[type="submit"]');
      await a.page.waitForFunction(() => /daily AI limit reached/.test(document.querySelector('#scr-thread .scr-turn:last-child .scr-badge')?.textContent || ''));
      await a.page.click('#scr-thread .scr-turn:last-child [data-scr-act="ai-apply"]').catch(() => { /* no change to apply */ });
      // The function's log lines: status/provider tokens only — no sentence, email or token.
      const logs = a.db.api.filter(x => x.log).flatMap(x => x.log);
      assert.ok(logs.length >= 3 && logs.every(l => /^screen-builder (ai|rules)\b/.test(l)), JSON.stringify(logs));
      assert.ok(!logs.some(l => /cheap|growing|example\.com|Bearer|eyJ/.test(l)), 'function logs carry no request content');
      await shot(a.page, 'screener_stocks_trusted_desktop');
      // Save with alerts on.
      await a.page.click('[data-scr-act="panel"][data-scr-panel="save"]');
      await a.page.fill('#scr-save-name', 'Smoke: cheap tech');
      await a.page.check('#scr-save-alerts');
      assert.match(await text(a.page, '#scr-panel'), /Checked daily after the data run/);
      await a.page.click('#scr-save-form [data-scr-mode="new"]');
      await a.page.waitForFunction(() => /Smoke: cheap tech/.test(document.getElementById('scr-saved').textContent));
      const ins = a.db.log.find(r => r.method === 'POST' && r.path === '/rest/v1/saved_screens');
      assert.ok(ins, 'saved_screens insert');
      assert.strictEqual(ins.body.user_id, UID); assert.strictEqual(ins.body.scope, 'stocks'); assert.strictEqual(ins.body.alerts_enabled, true);
      assert.ok(ScreenDSL.validate(ins.body.filter, 'stocks').ok, 'the saved filter re-validates');
      // A saved screen loads back by its link.
      await go(a.page, `#/screener?id=${ACCOUNT.saved_screens[1].id}`);
      await a.page.waitForFunction(() => /Editing: Cheap markets \(fixture\)/.test(document.getElementById('scr-actions').textContent));
      noErrors(a);
      await a.ctx.close();
    });

    await step('screener (signed in, NOT trusted): stocks gated, AI not called, stocks screen insert refused by RLS stub', async () => {
      const a = await newCtx(browser, NEW, { user: OTHER_UID, trusted: false });
      await boot(a, NEW, '#/screener');
      await a.page.click('[data-scr-act="scope"][data-scr-scope="stocks"]');
      await a.page.waitForSelector('#scr-gate:not([hidden])');
      assert.match(await text(a.page, '#scr-gate'), /not on the owner list/);
      await a.page.click('[data-scr-act="scope"][data-scr-scope="markets"]');
      await a.page.fill('#scr-ai-input', 'cheap asian markets');
      await a.page.click('#scr-ai-form button[type="submit"]');
      await a.page.waitForSelector('#scr-thread .scr-turn');
      assert.strictEqual(await text(a.page, '#scr-thread .scr-badge'), 'rules · AI limited to approved accounts');
      assert.strictEqual(a.db.api.length, 0);
      assert.ok(!a.db.log.some(r => r.path === '/rest/v1/screener_snapshots'));
      // RLS (0015) refuses a stocks screen from an untrusted account; markets saves work.
      const res = await a.page.evaluate(async () => {
        const f = { v: 1, scope: 'stocks', where: [], sort: null, limit: 100, include_flagged: false };
        const s = await Auth.saveScreen({ name: 'x', scope: 'stocks', filter: f });
        const code = Auth.lastError && Auth.lastError.code;
        const m = await Auth.saveScreen({ name: 'Mine', scope: 'markets', filter: { ...f, scope: 'markets' } });
        return { s, code, m: m && m.name };
      });
      assert.deepStrictEqual(res, { s: null, code: '42501', m: 'Mine' });
      await a.page.click('[data-scr-act="panel"][data-scr-panel="save"]');
      assert.match(await text(a.page, '#scr-panel'), /Checked weekly \(Monday refresh\)/);
      noErrors(a);
      await a.ctx.close();
    });

    // 7. Stock drawer: owner chart (Lightweight Charts) + growth record bars.
    await step('stock drawer (trusted): Lightweight Charts line + long-average check + growth bars', async () => {
      const a = await newCtx(browser, NEW, { user: UID, trusted: true });
      await boot(a, NEW, '#/screener');
      await a.page.click('[data-scr-act="scope"][data-scr-scope="stocks"]');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr[data-sbx-key="FXA"]');
      await a.page.click('#view-screener .sbx-table tbody tr[data-sbx-key="FXA"] td:nth-child(2)');
      await a.page.waitForSelector('#drawer .chr-canvas canvas', { timeout: 15000 });
      const lib = await a.page.$eval('script[data-chr-lib]', s => ({ src: s.src, integrity: s.integrity }));
      assert.strictEqual(lib.src, CDN.lwc); assert.match(lib.integrity, /^sha384-/);
      assert.match(await text(a.page, '#drawer [data-drw="head"]'), /Fixture Alpha Software/);
      // Snapshot strategy ids are shown with the published labels.
      const top = await text(a.page, '#drawer [data-drw="top"]');
      assert.match(top, /Quality on sale/); assert.ok(!/\bon_sale\b/.test(top), top);
      const note = await text(a.page, '#drawer [data-chr-note]');
      assert.match(note, /2-year average price \(used for "on sale"; 5 years of prices not on file yet\): 141\.\d\d/);
      assert.ok(!/chart's own closes average/.test(note), 'chart mean agrees with the snapshot average within 0.5%');
      assert.deepStrictEqual(await a.page.$$eval('#drawer [data-chr-range]', b => b.map(x => x.textContent.trim())), ['1M', '3M', '6M', '1Y', 'All (1.9y)']);
      const g = await a.page.$eval('#drawer .chr-growth', e => ({ t: e.textContent, gaps: e.querySelectorAll('.chr-gap').length }));
      assert.match(g.t, /Growth record/); assert.strictEqual(g.gaps, 2, 'null fiscal years are gaps, not zeros');
      assert.match(await text(a.page, '#drawer .chr-foot'), /no candles\/volume \(licence\)/);
      assert.match(await text(a.page, '#drawer [data-drw="body"]'), /Fundamental growth record \(EDGAR\)/);
      await shot(a.page, 'drawer_stock_trusted_desktop');
      // Header symbol search knows the owner's tickers and routes to the drawer.
      await a.page.keyboard.press('Escape');
      await a.page.focus('#symbolSearch');
      await a.page.waitForFunction(() => document.querySelector('#scr-symbol-list option[value^="FXC "]'));
      await a.page.fill('#symbolSearch', 'fxc');
      await a.page.keyboard.press('Enter');
      await a.page.waitForFunction(() => location.hash === '#/stock/FXC' && STATE.drawer && STATE.drawer.key === 'FXC');
      await a.page.waitForSelector('#drawer .chr-growth');
      await a.page.keyboard.press('Escape');
      assert.strictEqual(await a.page.evaluate(() => STATE.drawer), null);
      // A row hidden from screens says why, in words.
      await go(a.page, '#/stock/FXN');
      await a.page.waitForFunction(() => /data caveats/.test(document.querySelector('#drawer [data-drw="body"]').textContent));
      assert.match(await text(a.page, '#drawer [data-drw="body"]'), /data caveats: foreign listing, open data check \(stale filings\)/);
      noErrors(a);
      await a.ctx.close();
    });

    // 8. Market drawer: TradingView widget in a sandboxed srcdoc iframe (opaque origin).
    await step('market drawer: sandboxed TradingView iframe (no allow-same-origin), widget cannot reach the page', async () => {
      const a = await newCtx(browser, NEW, { user: UID, trusted: true });
      await boot(a, NEW);
      const key = await a.page.$eval('#tbody tr[data-mk]', r => r.dataset.mk);
      await go(a.page, `#/market/${key}`);
      await a.page.waitForSelector('#drawer iframe.chr-tv');
      const sandbox = await a.page.$eval('#drawer iframe.chr-tv', f => f.getAttribute('sandbox'));
      assert.strictEqual(sandbox, 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      await a.page.waitForFunction(() => window.__tv.length > 0, null, { timeout: 10000 });
      const tv = await a.page.evaluate(() => window.__tv[0]);
      const sym = DATA.scoreboard.find(m => m.key === key).symbol.replace(/-/g, '.').toUpperCase();
      assert.strictEqual(tv.symbol, sym);
      assert.strictEqual(tv.ls, 'blocked', 'widget must not read our localStorage (Supabase session)');
      assert.strictEqual(tv.par, 'blocked', 'widget must not reach the parent document');
      assert.strictEqual(tv.origin, 'null');
      assert.match(await a.page.$eval('#drawer iframe.chr-tv', f => f.srcdoc), /chart by TradingView/);
      await shot(a.page, 'drawer_market_desktop');
      noErrors(a);
      await a.ctx.close();
    });

    // 9. Watchlists via the one star control.
    await step('watchlists: star picker adds a stock + a market, list view, remove', async () => {
      const a = await newCtx(browser, NEW, { user: UID, trusted: true });
      await boot(a, NEW, '#/stock/FXA');
      await a.page.waitForSelector('#drawer [data-lst-star][data-lst-key="FXA"]');
      await a.page.click('#drawer [data-lst-star]');
      await a.page.waitForSelector('.lst-pop [data-lst-pick="new-starred-stocks"]');
      await a.page.click('.lst-pop [data-lst-pick="new-starred-stocks"]');
      await a.page.waitForFunction(() => document.querySelector('#drawer [data-lst-star]').classList.contains('on'));
      assert.ok(a.db.watchlists.some(w => w.name === 'Starred stocks'), '"Starred stocks" list auto-created');
      assert.ok(a.db.watchlist_items.some(i => i.kind === 'stock' && i.item_key === 'FXA' && i.user_id === UID));
      await a.page.keyboard.press('Escape');   // closes the picker
      await a.page.keyboard.press('Escape');   // closes the drawer
      const key = await a.page.$eval('#tbody tr[data-mk]', r => r.dataset.mk);
      await go(a.page, `#/market/${key}`);
      await a.page.waitForSelector('#drawer [data-lst-star="market"]');
      await a.page.click('#drawer [data-lst-star]');
      await a.page.click('.lst-pop [data-lst-pick="starred-markets"]');
      await a.page.waitForFunction(() => document.querySelector('#drawer [data-lst-star]').classList.contains('on'));
      assert.deepStrictEqual(a.db.user_watchlist, [key]);
      await a.page.keyboard.press('Escape'); await a.page.keyboard.press('Escape');
      await go(a.page, '#/lists');
      await a.page.waitForSelector('#view-lists .lst-tab');
      assert.match(await text(a.page, '#view-lists .lst-tabs'), /Starred markets 1/);
      await a.page.click('#view-lists .lst-tab:has-text("Starred stocks")');
      await a.page.waitForSelector('#view-lists tr[data-lst-open="stock:FXA"]');
      const row = await text(a.page, '#view-lists tr[data-lst-open="stock:FXA"]');
      assert.match(row, /Fixture Alpha Software/); assert.match(row, /\$120\.50/, 'price column for the trusted owner');
      await shot(a.page, 'watchlists_desktop');
      // "Screen this list" opens the stocks screener on exactly the list's tickers.
      await a.page.click('#view-lists [data-lst-screen="stocks"]');
      await a.page.waitForFunction(() => location.hash === '#/screener');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      assert.deepStrictEqual(await a.page.$$eval('#view-screener .sbx-table tbody tr', r => r.map(x => x.dataset.sbxKey)), ['FXA']);
      await go(a.page, '#/lists');
      await a.page.waitForSelector('#view-lists tr[data-lst-open="stock:FXA"]');
      await a.page.click('#view-lists [data-lst-remove="stock:FXA"]');
      await a.page.waitForFunction(() => !document.querySelector('#view-lists tr[data-lst-open="stock:FXA"]'));
      assert.ok(!a.db.watchlist_items.some(i => i.item_key === 'FXA'), 'item deleted');
      noErrors(a);
      await a.ctx.close();
    });

    // 10. Alerts inbox: badge, unseen first, hidden-by-data-issue apart, mark seen.
    await step('alerts: badge, inbox, mark seen (PATCH sends only `seen`), mark all seen', async () => {
      const a = await newCtx(browser, NEW, { user: UID, trusted: true });
      await boot(a, NEW);
      await a.page.waitForFunction(() => document.getElementById('alr-badge').textContent === '2' && !document.getElementById('alr-badge').hidden);
      await go(a.page, '#/alerts');
      await a.page.waitForSelector('#view-alerts .alr-card');
      const cards = await a.page.$$eval('#view-alerts .alr-card', c => c.map(x => [x.dataset.alrId, x.classList.contains('unseen')]));
      assert.deepStrictEqual(cards, [['11', true], ['12', true], ['10', false]], 'unseen first, newest first');
      const first = await text(a.page, '#view-alerts .alr-card[data-alr-id="11"]');
      assert.match(first, /Entered \(1\)/); assert.match(first, /Left \(1\)/); assert.match(first, /Hidden by a data issue \(1\)/);
      await shot(a.page, 'alerts_desktop');
      await a.page.click('#view-alerts [data-alr-seen="11"]');
      await a.page.waitForFunction(() => document.getElementById('alr-badge').textContent === '1');
      const patch = a.db.log.find(r => r.method === 'PATCH' && r.path === '/rest/v1/screen_alerts');
      assert.deepStrictEqual(patch.body, { seen: true });
      await a.page.click('#view-alerts [data-alr-allseen]');
      await a.page.waitForFunction(() => document.getElementById('alr-badge').hidden);
      assert.ok(a.db.screen_alerts.every(x => x.seen));
      noErrors(a);
      await a.ctx.close();
    });

    // 11. 390 px: no page-level horizontal scroll anywhere.
    await step('390 px phone: overview, screener (markets + stocks), drawers, watchlists, alerts — no page-level horizontal scroll', async () => {
      const a = await newCtx(browser, NEW, { viewport: PHONE, user: UID, trusted: true });
      await boot(a, NEW);
      const check = async name => { assert.ok(await noHScroll(a.page), `${name}: page scrolls horizontally at 390 px`); await shot(a.page, `phone_${name}`); };
      // The drawer is position:fixed (it can't widen the page), so check it on its own:
      // once its slide-in has finished it must sit inside the viewport with nothing cut off.
      const drawerFits = async name => {
        await settle(a.page, 400);
        const m = await a.page.$eval('#drawer', d => ({ l: d.getBoundingClientRect().left, r: d.getBoundingClientRect().right,
          sw: d.scrollWidth, cw: d.clientWidth, vw: window.innerWidth }));
        assert.ok(m.l >= -1 && m.r <= m.vw + 1 && m.sw <= m.cw + 1, `${name}: drawer overflows at 390 px ${JSON.stringify(m)}`);
      };
      await check('overview');
      await go(a.page, '#/screener');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr');
      await check('screener_markets');
      await a.page.click('[data-scr-act="scope"][data-scr-scope="stocks"]');
      await a.page.waitForSelector('#view-screener .sbx-table tbody tr[data-sbx-key="FXA"]');
      await check('screener_stocks');
      await a.page.click('#view-screener .sbx-table tbody tr[data-sbx-key="FXA"] td:nth-child(2)');
      await a.page.waitForSelector('#drawer .chr-canvas canvas', { timeout: 15000 });
      await drawerFits('drawer_stock');
      await check('drawer_stock');
      await a.page.keyboard.press('Escape');
      const key = await a.page.evaluate(() => STATE.rows[0].key);
      await go(a.page, `#/market/${key}`);
      await a.page.waitForSelector('#drawer iframe.chr-tv');
      await drawerFits('drawer_market');
      await check('drawer_market');
      await a.page.keyboard.press('Escape');
      await go(a.page, '#/lists');
      await a.page.waitForSelector('#view-lists .lst-tab');
      await check('watchlists');
      await go(a.page, '#/alerts');
      await a.page.waitForSelector('#view-alerts .alr-card');
      await check('alerts');
      noErrors(a);
      await a.ctx.close();
      const b = await newCtx(browser, NEW, { viewport: PHONE });
      await boot(b, NEW, '#/screener');
      await b.page.waitForSelector('#view-screener .sbx-table tbody tr');
      assert.ok(await noHScroll(b.page), 'anonymous screener scrolls horizontally at 390 px');
      await shot(b.page, 'phone_screener_anon');
      noErrors(b);
      await b.ctx.close();
    });

    // 12. Key reports (public): list, a report, citations, print / PDF, not found, drawer link.
    await step('key reports: list, fixture report, citations scroll in place (hash untouched), print mode + A4 PDF, not found, drawer link', async () => {
      const a = await newCtx(browser, NEW, { reports: 'fixture' });
      await boot(a, NEW, '#/reports');
      await a.page.waitForSelector('#view-reports .rpt-card');
      assert.strictEqual(await a.page.$eval('.view-tab[data-view="reports"]', t => t.classList.contains('active')), true);
      assert.deepStrictEqual(await a.page.$$eval('#view-reports .rpt-card', c => c.map(x => x.getAttribute('href'))), ['#/reports/fxr']);
      assert.match(await text(a.page, '#view-reports .rpt-card'), /Fixture Corp.*Neutral.*Risk: High/);
      await shot(a.page, 'reports_list_desktop');
      await a.page.click('#view-reports .rpt-card');
      await a.page.waitForSelector('#view-reports .rpt-report');
      assert.strictEqual(await a.page.evaluate(() => location.hash), '#/reports/fxr');
      assert.strictEqual(await a.page.$$eval('#view-reports .rpt-sec', s => s.length), REPORT_FIX.sections.length + 1);
      assert.strictEqual(await a.page.$$eval('#view-reports .rpt-stat', s => s.length), REPORT_FIX.key_stats.length);
      assert.ok(await a.page.$('#view-reports svg.rpt-bars title'), 'bar chart with an accessible title');
      assert.match(await a.page.evaluate(() => document.title), /^Fixture Corp \(FXR\) — Key report/);
      // The chart block is charts.js's sandboxed TradingView iframe.
      await a.page.waitForSelector('#view-reports .rpt-chart-slot iframe.chr-tv');
      assert.strictEqual(await a.page.$eval('#view-reports iframe.chr-tv', f => f.getAttribute('sandbox')), 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
      await a.page.waitForFunction(() => window.__tv.some(t => t.symbol === 'NASDAQ:FXR'), null, { timeout: 10000 });
      const tv = await a.page.evaluate(() => window.__tv.find(t => t.symbol === 'NASDAQ:FXR'));
      assert.strictEqual(tv.ls, 'blocked'); assert.strictEqual(tv.par, 'blocked');
      // Citations and the contents list scroll in place: no hashchange, no history entry.
      const before = await a.page.evaluate(() => window.__hashes.length);
      await a.page.click('#view-reports .rpt-summary [data-rpt-src="s1"]');
      await a.page.waitForFunction(() => document.getElementById('src-s1').classList.contains('rpt-flash'));
      await a.page.click('#view-reports .rpt-toc [data-rpt-sec="valuation"]');
      await settle(a.page, 600);
      assert.strictEqual(await a.page.evaluate(() => location.hash), '#/reports/fxr');
      assert.strictEqual(await a.page.evaluate(() => window.__hashes.length), before, 'citation clicks must not touch the hash');
      assert.ok(await a.page.$eval('#rpt-sec-valuation', s => Math.abs(s.getBoundingClientRect().top) < 120), 'contents link scrolled to its section');
      const srcLinks = await a.page.$$eval('#view-reports .rpt-srcs a', l => l.map(x => [x.href, x.target, x.rel]));
      assert.deepStrictEqual(srcLinks, REPORT_FIX.sources.map(s => [s.url, '_blank', 'noopener noreferrer']));
      await shot(a.page, 'report_fxr_desktop', { fullPage: true });
      // "Download PDF" opens the print dialog with a descriptive title (the PDF's file name).
      await a.page.evaluate(() => { window.print = () => { window.__printed = document.title; }; });
      await a.page.click('#view-reports [data-rpt-print]');
      assert.match(await a.page.evaluate(() => window.__printed), /^FXR — Fixture Corp: .*\(GIVA Research, 2026-10-15\)$/);
      assert.match(await a.page.evaluate(() => document.title), /Key report/, 'title restored after print');
      // Print stylesheet: chrome + live chart hidden, the note shown, black on white, A4.
      await a.page.emulateMedia({ media: 'print' });
      const pr = await a.page.evaluate(() => {
        const vis = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
        return { header: vis('#app > header'), tabs: vis('.view-tabs'), toolbar: vis('.rpt-toolbar'), chart: vis('.rpt-chart-slot'),
          note: vis('.rpt-chart .rpt-print-only'), bg: getComputedStyle(document.body).backgroundColor, color: getComputedStyle(document.querySelector('.rpt-company')).color };
      });
      assert.deepStrictEqual(pr, { header: false, tabs: false, toolbar: false, chart: false, note: true, bg: 'rgb(255, 255, 255)', color: 'rgb(0, 0, 0)' });
      await a.page.pdf({ path: path.join(SHOTS, 'report_fxr.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true });
      await a.page.emulateMedia({ media: 'screen' });
      // Unknown / malformed slugs: "Report not found" with a way back, nothing odd fetched.
      for (const h of ['#/reports/nope', '#/reports/..%2F..%2Fsecrets', '#/reports/%E0%A4%A']) {
        await go(a.page, h);
        await a.page.waitForFunction(() => /Report not found/.test(document.getElementById('view-reports').textContent));
        assert.ok(await a.page.$('#view-reports .rpt-empty a[href="#/reports"]'));
      }
      assert.ok(a.db.reportFetches.every(p => /^\/reports\/(models\/)?[a-z0-9-]+\.json$/.test(p)), a.db.reportFetches.join(' '));
      await go(a.page, '#/reports/FXR');   // slugs are lower-cased
      await a.page.waitForSelector('#view-reports .rpt-report');
      // Leaving the section drops the live chart and print mode.
      await go(a.page, '#/overview');
      assert.strictEqual(await a.page.$('#view-reports iframe'), null);
      assert.strictEqual(await a.page.evaluate(() => document.documentElement.classList.contains('rpt-on')), false);
      // The stock drawer links to the report for its ticker.
      await go(a.page, '#/stock/FXR');
      await a.page.waitForSelector('#drawer .rpt-drawer-link');
      assert.match(await text(a.page, '#drawer .rpt-drawer-link'), /Read the key report/);
      await a.page.click('#drawer .rpt-drawer-link');
      await a.page.waitForSelector('#view-reports .rpt-report');
      assert.strictEqual(await a.page.evaluate(() => STATE.drawer), null, 'drawer closed');
      assert.strictEqual(await a.page.evaluate(() => location.hash), '#/reports/fxr');
      // A ticker without a report: no link.
      await go(a.page, '#/stock/ZZZQ');
      await settle(a.page, 400);
      assert.strictEqual(await a.page.$('#drawer .rpt-drawer-link'), null);
      noErrors(a);
      await a.ctx.close();
    });

    // 13. Key reports at 360 px (and an empty index): no page-level horizontal scroll.
    await step('key reports at 360 px: list, report, tables/charts scroll in their own box; empty index shows an empty state', async () => {
      const a = await newCtx(browser, NEW, { viewport: { width: 360, height: 780 }, reports: 'fixture' });
      await boot(a, NEW, '#/reports');
      await a.page.waitForSelector('#view-reports .rpt-card');
      assert.ok(await noHScroll(a.page), 'reports list scrolls horizontally at 360 px');
      await shot(a.page, 'phone_reports_list');
      await go(a.page, '#/reports/fxr');
      await a.page.waitForSelector('#view-reports .rpt-report');
      await settle(a.page, 400);
      assert.ok(await noHScroll(a.page), 'report scrolls horizontally at 360 px');
      const side = await a.page.$eval('.rpt-side', s => s.getBoundingClientRect().top), main = await a.page.$eval('.rpt-main', s => s.getBoundingClientRect().top);
      assert.ok(side < main, 'key data comes before the body on a phone');
      await shot(a.page, 'phone_report_fxr', { fullPage: true });
      noErrors(a);
      await a.ctx.close();
      if (!fs.existsSync(path.join(DASH, 'reports', 'crwv.json'))) {
        const b = await newCtx(browser, NEW, { viewport: { width: 360, height: 780 } });
        await boot(b, NEW, '#/reports');
        await b.page.waitForFunction(() => /No key reports are published yet/.test(document.getElementById('view-reports').textContent));
        noErrors(b);
        await b.ctx.close();
      }
    });

    // 13b. The stress-test model block (fixture model on the fixture report).
    const kpi = (page, k) => page.$eval(`.mdl [data-mdl-kpi="${k}"] .mdl-kpi-v`, e => e.textContent);
    const money = t => { const m = /(−?)US\$([\d,.]+)(m|bn)?/.exec(t); return m ? (m[1] ? -1 : 1) * parseFloat(m[2].replace(/,/g, '')) * (m[3] === 'bn' ? 1000 : 1) : NaN; };
    await step('stress-test model: lazy mount, SOFR slider moves FY2027E interest + value/share, URL state round-trips, tabs, tornado, grid, print, model route', async () => {
      const a = await newCtx(browser, NEW, { reports: 'fixture' });
      await a.ctx.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
      await boot(a, NEW, '#/reports/fxr');
      await a.page.waitForSelector('#view-reports .mdl [data-mdl-kpi="interest"]', { timeout: 10000 });
      assert.deepStrictEqual(await a.page.evaluate(() => [typeof ModelEngine, typeof ReportModel, document.querySelectorAll('script[src="model.js"]').length,
        document.querySelectorAll('link[href="model.css"]').length]), ['object', 'object', 1, 1], 'assets loaded once');
      assert.strictEqual(await a.page.$$eval('.mdl .mdl-chip[aria-pressed="true"]', c => c.map(x => x.textContent).join()), 'Base');
      assert.strictEqual(await a.page.$$eval('.mdl .mdl-kpi', k => k.length), 7, 'seven headline KPIs');
      assert.match(await text(a.page, '.mdl-keyd'), /Key P&L drivers.*(cuts|lifts) FY2027E net income by US\$/);
      const i0 = money(await kpi(a.page, 'interest')), v0 = money(await kpi(a.page, 'value_per_share'));
      assert.ok(i0 > 0 && v0 > 0, `${i0} ${v0}`);
      await shot(a.page, 'model_fxr_base', { fullPage: true });
      // SOFR slider by keyboard: 4 steps of 25 bp = +100 bp
      await a.page.focus('.mdl input[data-mdl-driver="sofr_shift"]');
      for (let i = 0; i < 4; i++) await a.page.keyboard.press('ArrowRight');
      await settle(a.page, 300);
      assert.strictEqual(await a.page.$eval('.mdl input[data-mdl-num="sofr_shift"]', e => e.value), '100');
      const i1 = money(await kpi(a.page, 'interest')), v1 = money(await kpi(a.page, 'value_per_share'));
      assert.ok(i1 > i0, `FY2027E interest rises with SOFR (${i0} -> ${i1})`);
      assert.ok(v1 < v0, `value per share falls with SOFR (${v0} -> ${v1})`);
      assert.match(await text(a.page, '.mdl [data-mdl-kpi="interest"] .mdl-kpi-d'), /▼ \+US\$[\d.]+m vs base/);
      assert.strictEqual(await a.page.$eval('.mdl .mdl-chip.custom', c => c.hidden), false, 'Custom chip shown when edited');
      // the state is in the route's query, written in place (replaceState, no hashchange)
      const hash = await a.page.evaluate(() => location.hash);
      assert.match(hash, /^#\/reports\/fxr\?m=[A-Za-z0-9_-]+$/);
      assert.deepStrictEqual(await a.page.evaluate(h => fetch('reports/models/fxr.json').then(r => r.json())
        .then(spec => ModelEngine.decodeState(spec, h.split('?m=')[1]).overrides), hash), { sofr_shift: 100 });
      assert.ok(!(await a.page.evaluate(() => window.__hashes)).some(x => /^#\/reports\/fxr\?m=/.test(x)), 'no hashchange for model state');
      // typed value in the numeric input
      await a.page.fill('.mdl input[data-mdl-num="exit_ev_ebitda"]', '12');
      await settle(a.page, 300);
      const v2 = money(await kpi(a.page, 'value_per_share'));
      assert.ok(v2 > v1, 'a higher exit multiple raises value per share');
      const hash2 = await a.page.evaluate(() => location.hash);
      // round trip: a fresh page on that link shows the same state
      const b = await newCtx(browser, NEW, { reports: 'fixture' });
      await boot(b, NEW, hash2);
      await b.page.waitForSelector('#view-reports .mdl [data-mdl-kpi="interest"]');
      assert.strictEqual(await b.page.$eval('.mdl input[data-mdl-driver="sofr_shift"]', e => e.value), '100');
      assert.strictEqual(await b.page.$eval('.mdl input[data-mdl-num="exit_ev_ebitda"]', e => e.value), '12');
      assert.strictEqual(money(await kpi(b.page, 'value_per_share')), v2, 'same value per share from the link');
      assert.strictEqual(await b.page.evaluate(() => location.hash), hash2, 'link kept as is');
      // a tampered link is clamped / ignored, never applied raw, never an error
      const evil = Buffer.from(JSON.stringify({ v: 1, m: 'fxr', o: { sofr_shift: 99999, __proto__x: 1, tax_rate: 'x' } })).toString('base64url');
      await go(b.page, `#/reports/fxr?m=${evil}`);
      await settle(b.page, 400);
      assert.strictEqual(await b.page.$eval('.mdl input[data-mdl-driver="sofr_shift"]', e => e.value), '500', 'out-of-range value clamped');
      assert.match(await text(b.page, '.mdl-status'), /adjusted/);
      noErrors(b);
      await b.ctx.close();
      // scenario chip, reset
      await a.page.click('.mdl .mdl-chip[data-mdl-scen="bear"]');
      await settle(a.page, 300);
      assert.strictEqual(await a.page.$eval('.mdl .mdl-chip[data-mdl-scen="bear"]', c => c.getAttribute('aria-pressed')), 'true');
      assert.strictEqual(await a.page.$eval('.mdl input[data-mdl-driver="spread_shift"]', e => e.value), '200');
      // copy link (clipboard or the fallback box)
      await a.page.click('.mdl [data-mdl-copy]');
      await a.page.waitForFunction(() => /copied|Copy the link/.test(document.querySelector('.mdl-status').textContent));
      // every tab draws; the tornado + grid render on the Sensitivity tab
      for (const t of ['debt', 'sens', 'val', 'cal', 'pl']) {
        await a.page.click(`.mdl [data-mdl-tab="${t}"]`);
        await settle(a.page, 150);
        assert.strictEqual(await a.page.$eval(`.mdl [data-mdl-panel="${t}"]`, p => !p.hidden && p.childElementCount > 0), true, `tab ${t}`);
        if (t === 'debt') {
          assert.ok(await a.page.$('.mdl [data-mdl-panel="debt"] svg title'), 'rate chart');
          assert.match(await text(a.page, '.mdl [data-mdl-panel="debt"]'), /Predicted rate path.*Interest expense by tranche.*Q3 2026 interest expense guide.*Debt maturity ladder.*Debt stack/);
          assert.ok(await a.page.$('.mdl [data-mdl-panel="debt"] path.mdl-mark'), 'guide marker on the stub year');
          await a.page.locator('#view-reports .mdl').screenshot({ path: path.join(SHOTS, 'model_fxr_debt.png') });
        }
        if (t === 'sens') {
          const bars = await a.page.$$eval('.mdl svg.mdl-tornado rect', r => r.length);
          assert.ok(bars >= 20, `tornado bars (${bars})`);
          assert.strictEqual(await a.page.$$eval('.mdl table.mdl-grid2 td.now', c => c.length), 1, 'current cell outlined');
          const cells = await a.page.$$eval('.mdl table.mdl-grid2 tbody td', c => c.length);
          assert.ok(cells >= 49, `grid cells (${cells})`);
          await a.page.selectOption('.mdl select[aria-label="Grid metric"]', 'interest');
          await settle(a.page, 200);
          assert.strictEqual(await a.page.$eval('.mdl select[aria-label="Grid columns driver"]', s => s.value), 'sofr_shift');
          assert.strictEqual(await a.page.$eval('.mdl select[aria-label="Grid rows driver"]', s => s.value), 'spread_shift');
          await a.page.selectOption('.mdl select[aria-label="Tornado metric"]', 'interest');
          await settle(a.page, 200);
          assert.match(await a.page.$eval('.mdl svg.mdl-tornado title', t => t.textContent), /interest/);
          await a.page.locator('#view-reports .mdl').screenshot({ path: path.join(SHOTS, 'model_fxr_sens.png') });
        }
        if (t === 'val') {
          assert.match(await text(a.page, '.mdl [data-mdl-panel="val"]'), /Implied forward multiples.*at US\$20\.00 price.*model value.*Exit valuation bridge.*value per share today/);
          await a.page.locator('#view-reports .mdl').screenshot({ path: path.join(SHOTS, 'model_fxr_val.png') });
        }
        if (t === 'cal') assert.match(await text(a.page, '.mdl [data-mdl-panel="cal"]'), /✗ outside/, 'the deliberate miss shows');
      }
      // keyboard tab navigation
      await a.page.focus('.mdl [data-mdl-tab="pl"]');
      await a.page.keyboard.press('ArrowRight');
      assert.strictEqual(await a.page.evaluate(() => document.activeElement.getAttribute('data-mdl-tab')), 'debt');
      await a.page.click('.mdl [data-mdl-reset]');
      await settle(a.page, 300);
      assert.strictEqual(await a.page.evaluate(() => location.hash), '#/reports/fxr', 'reset clears ?m');
      // a help expander cites the report's sources; the citation scrolls in place
      await a.page.click('.mdl .mdl-drv[data-mdl-row="share_price"] .mdl-help');
      await a.page.click('.mdl .mdl-drv[data-mdl-row="share_price"] .mdl-helpbox [data-rpt-src="s2"]');
      await a.page.waitForFunction(() => document.getElementById('src-s2').classList.contains('rpt-flash'));
      // print: a static snapshot replaces the controls
      await a.page.click('.mdl input[data-mdl-driver="sofr_shift"]');
      await a.page.evaluate(() => { const r = document.querySelector('.mdl input[data-mdl-driver="sofr_shift"]'); r.value = '200'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await settle(a.page, 900);
      await a.page.emulateMedia({ media: 'print' });
      const pr = await a.page.evaluate(() => {
        const vis = s => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none'; };
        return { live: vis('.mdl-live'), print: vis('.mdl-print'), tornado: !!document.querySelector('.mdl-print svg.mdl-tornado'),
          table: !!document.querySelector('.mdl-print table'), note: /Scenario as of print/.test(document.querySelector('.mdl-print').textContent),
          sofr: /SOFR shift \+200 bp/.test(document.querySelector('.mdl-print').textContent) };
      });
      assert.deepStrictEqual(pr, { live: false, print: true, tornado: true, table: true, note: true, sofr: true });
      await a.page.pdf({ path: path.join(SHOTS, 'report_fxr_model.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true });
      await a.page.emulateMedia({ media: 'screen' });
      // the full-width route keeps the state
      const enc = (await a.page.evaluate(() => location.hash)).split('?m=')[1];
      await a.page.click('.mdl a.mdl-full');
      await a.page.waitForSelector('#view-reports .rpt-modelpage .mdl [data-mdl-kpi="interest"]');
      assert.strictEqual(await a.page.evaluate(() => location.hash), `#/reports/fxr/model?m=${enc}`);
      assert.strictEqual(await a.page.$eval('.mdl input[data-mdl-driver="sofr_shift"]', e => e.value), '200');
      assert.match(await text(a.page, '.rpt-modelpage .rpt-strip'), /Fixture Corp.*Stance: Neutral/);
      assert.strictEqual(await a.page.$$eval('#view-reports .rpt-sec', s => s.length), 1, 'only the sources section');
      assert.strictEqual(await a.page.$eval('.view-tab[data-view="reports"]', t => t.classList.contains('active')), true);
      await shot(a.page, 'model_fxr_fullwidth', { fullPage: true });
      // SOFR moves interest on this route too
      const iA = money(await kpi(a.page, 'interest'));
      await a.page.evaluate(() => { const r = document.querySelector('.mdl input[data-mdl-driver="sofr_shift"]'); r.value = '-100'; r.dispatchEvent(new Event('input', { bubbles: true })); });
      await settle(a.page, 300);
      assert.ok(money(await kpi(a.page, 'interest')) < iA, 'lower SOFR, lower interest');
      // a stock drawer opened over the model page restores the current state on close
      const hNow = await a.page.evaluate(() => location.hash);
      await go(a.page, '#/stock/FXR');
      await a.page.waitForSelector('#drawer .rpt-drawer-link');
      await a.page.evaluate(() => closeDrawer());
      await settle(a.page, 300);
      assert.strictEqual(await a.page.evaluate(() => location.hash), hNow, 'drawer close restores the model state');
      await a.page.click('.rpt-modelpage .rpt-back');
      await a.page.waitForSelector('#view-reports .rpt-report:not(.rpt-modelpage) .mdl [data-mdl-kpi="interest"]');
      await go(a.page, '#/reports/fxr/oops');
      await a.page.waitForFunction(() => /Report not found/.test(document.getElementById('view-reports').textContent));
      noErrors(a);
      await a.ctx.close();
    });
    await step('stress-test model at 360 px: no page-level horizontal scroll on any tab (report + full-width route)', async () => {
      const a = await newCtx(browser, NEW, { viewport: { width: 360, height: 780 }, reports: 'fixture' });
      await boot(a, NEW, '#/reports/fxr');
      await a.page.waitForSelector('#view-reports .mdl [data-mdl-kpi="interest"]');
      for (const route of ['#/reports/fxr', '#/reports/fxr/model']) {
        await go(a.page, route);
        await a.page.waitForSelector('#view-reports .mdl [data-mdl-kpi="interest"]');
        for (const t of ['pl', 'debt', 'sens', 'val', 'cal']) {
          await a.page.click(`.mdl [data-mdl-tab="${t}"]`);
          await settle(a.page, 200);
          assert.ok(await noHScroll(a.page), `${route} tab ${t} scrolls horizontally at 360 px`);
        }
        // the SOFR slider is usable by touch-width: within the viewport
        const r = await a.page.$eval('.mdl input[data-mdl-driver="sofr_shift"]', e => { const b = e.getBoundingClientRect(); return [b.left, b.right]; });
        assert.ok(r[0] >= 0 && r[1] <= 360, `slider inside the viewport ${r}`);
        await shot(a.page, `phone_model_${route.endsWith('model') ? 'fullwidth' : 'report'}`, { fullPage: true });
      }
      noErrors(a);
      await a.ctx.close();
    });

    // 14. The real CoreWeave report, when it has been written (public content).
    if (fs.existsSync(path.join(DASH, 'reports', 'crwv.json'))) {
      await step('key reports: the real dashboard/reports/crwv.json renders (desktop + 360 px + A4 PDF), drawer link on #/stock/CRWV', async () => {
        const crwv = readJSON(path.join(DASH, 'reports', 'crwv.json'));
        for (const vp of [{ width: 1280, height: 900 }, { width: 360, height: 780 }]) {
          const a = await newCtx(browser, NEW, { viewport: vp });
          await boot(a, NEW, '#/reports');
          await a.page.waitForSelector('#view-reports a.rpt-card[href="#/reports/crwv"]');
          await go(a.page, '#/reports/crwv');
          await a.page.waitForSelector('#view-reports .rpt-report');
          await settle(a.page, 500);
          assert.strictEqual(await a.page.$$eval('#view-reports .rpt-sec', s => s.length), crwv.sections.length + 1);
          assert.ok(await noHScroll(a.page), `crwv report scrolls horizontally at ${vp.width} px`);
          await shot(a.page, `report_crwv_${vp.width}`, { fullPage: true });
          if (vp.width > 400) {
            // Bar charts: no two value labels overprint, and no chart is drawn past 1:1.
            const bars = await a.page.$$eval('#view-reports svg.rpt-bars', svgs => svgs.map(svg => {
              const r = [...svg.querySelectorAll('text.rpt-val')].map(t => t.getBoundingClientRect());
              let over = 0;
              for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
                const p = r[i], q = r[j];
                if (p.left < q.right - 0.5 && q.left < p.right - 0.5 && p.top < q.bottom - 0.5 && q.top < p.bottom - 0.5) over++;
              }
              return { title: svg.querySelector('title').textContent, over, scale: svg.getBoundingClientRect().width / svg.viewBox.baseVal.width };
            }));
            for (const c of bars) {
              assert.strictEqual(c.over, 0, `${c.title}: ${c.over} overlapping value labels`);
              assert.ok(c.scale <= 1.001, `${c.title}: drawn at ${c.scale.toFixed(2)}x`);
            }
            // Back from a stock drawer opened over the report keeps the reader's place and
            // does not refetch the report.
            const fetched = [];
            a.page.on('request', rq => { if (/\/reports\/crwv\.json$/.test(rq.url())) fetched.push(rq.url()); });
            await a.page.evaluate(() => window.scrollTo(0, 4000));
            await settle(a.page, 200);
            const y0 = await a.page.evaluate(() => window.scrollY);
            await go(a.page, '#/stock/CRWV');
            await a.page.waitForSelector('#drawer .rpt-drawer-link');
            await a.page.goBack();
            await settle(a.page, 600);
            assert.strictEqual(await a.page.evaluate(() => location.hash), '#/reports/crwv');
            assert.ok(Math.abs((await a.page.evaluate(() => window.scrollY)) - y0) < 5, 'scroll position kept after Back');
            assert.strictEqual(fetched.length, 0, 'report not refetched on Back');
            // A short desktop window: the sticky sidebar scrolls inside itself, so Contents stays reachable.
            await a.page.setViewportSize({ width: 1366, height: 650 });
            await settle(a.page, 200);
            const side = await a.page.$eval('.rpt-side', e => ({ h: e.getBoundingClientRect().height, oy: getComputedStyle(e).overflowY, vh: window.innerHeight }));
            assert.ok(side.h <= side.vh && side.oy === 'auto', `sidebar ${side.h}px in a ${side.vh}px window (overflow ${side.oy})`);
            await a.page.setViewportSize(vp);
            await a.page.emulateMedia({ media: 'print' });
            await a.page.pdf({ path: path.join(SHOTS, 'report_crwv.pdf'), format: 'A4', preferCSSPageSize: true, printBackground: true });
            await a.page.emulateMedia({ media: 'screen' });
            await go(a.page, '#/stock/CRWV');
            await a.page.waitForSelector('#drawer .rpt-drawer-link');
          }
          noErrors(a);
          await a.ctx.close();
        }
        // Tailwind CDN blocked: the report still sits on its own dark background.
        const c = await newCtx(browser, NEW, { cdn: false });
        await boot(c, NEW, '#/reports/crwv');
        await c.page.waitForSelector('#view-reports .rpt-report');
        assert.strictEqual(await c.page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(11, 15, 23)', 'report background without Tailwind');
        await shot(c.page, 'report_crwv_cdn_blocked');
        await c.ctx.close();
      });
    } else console.log('skip  key reports: dashboard/reports/crwv.json not written yet');
  } finally {
    await browser.close();
    srvNew.proc.kill();
    if (srvOrig) srvOrig.proc.kill();
  }

  const failed = results.filter(r => r[0] !== 'ok');
  console.log(`\nsmoke_dashboard: ${results.length - failed.length} passed, ${failed.length} failed${ORIG ? '' : ' (no original to compare: --orig-ref matches the working tree)'} — screenshots in ${SHOTS}`);
  process.exitCode = failed.length || !results.length ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
