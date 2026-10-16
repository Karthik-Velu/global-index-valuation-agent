#!/usr/bin/env node
// Tests for the AI screen builder (api/screen-builder.js) — no network, no secrets.
// global.fetch is replaced by a stub that routes Supabase Auth / PostgREST RPC / model
// calls to per-test handlers and records every call, so each case can assert both the
// response and exactly which upstreams were (or were not) contacted.
//
//   node scripts/test_screen_builder.js
'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ROOT = path.join(__dirname, '..');
const FN = path.join(ROOT, 'api', 'screen-builder.js');

// Fictitious values only — nothing here is a real key, token, user or address.
const ENV = {
  SUPABASE_URL: 'https://example-project.supabase.test',
  SUPABASE_ANON_KEY: 'anon-placeholder',
  GROQ_API_KEY: 'gsk-placeholder',
  OLLAMA_API_KEY: 'ollama-placeholder',
  OPENROUTER_API_KEY: '',
  ALLOWED_ORIGINS: 'https://allowed.example.test',
};
const SECRET_SENTENCE_MARK = 'zqxj';   // a token we can grep the logs for

let passed = 0, failed = 0;
const results = [];
function ok(cond, name, extra) {
  if (cond) passed++;
  else { failed++; results.push(`FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---- fixtures ------------------------------------------------------------------------

const b64u = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(claims) {
  const c = Object.assign({ sub: '00000000-0000-4000-8000-0000000000aa', role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, claims || {});
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(c)}.c2lnbmF0dXJl`;
}
const GOOD = jwt();

function makeReq({ method = 'POST', headers = {}, body, rawBody, origin = 'https://app.example.test', host = 'app.example.test', token = GOOD, noAuth = false } = {}) {
  const raw = rawBody !== undefined ? rawBody : (body === undefined ? '' : JSON.stringify(body));
  const h = Object.assign({ host, 'content-type': 'application/json' }, headers);
  if (origin) h.origin = origin;
  if (!noAuth && token) h.authorization = `Bearer ${token}`;
  if (headers['content-length'] === undefined && raw) h['content-length'] = String(Buffer.byteLength(raw));
  const req = Readable.from(raw ? [Buffer.from(raw)] : []);
  req.method = method;
  req.headers = h;
  return req;
}

function makeRes() {
  const res = {
    statusCode: 200, headers: {}, body: '', headersSent: false, ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    end(b) { this.body = b === undefined ? '' : String(b); this.ended = true; this.headersSent = true; },
  };
  return res;
}

// Routed fetch stub. `routes` maps a name to a handler(init) -> {status, json?, text?}
// or a Promise; unknown URLs fail the test loudly.
function installFetch(routes) {
  const calls = [];
  global.fetch = (url, init) => {
    const u = String(url);
    let name = null;
    if (u === `${ENV.SUPABASE_URL}/auth/v1/user`) name = 'user';
    else if (u === `${ENV.SUPABASE_URL}/rest/v1/rpc/is_trusted`) name = 'trusted';
    else if (u === `${ENV.SUPABASE_URL}/rest/v1/rpc/ai_quota_take`) name = 'quota';
    else if (u === 'https://api.groq.com/openai/v1/chat/completions') name = 'groq';
    else if (u === 'https://ollama.com/v1/chat/completions') name = 'ollamacloud';
    else if (u === 'https://openrouter.ai/api/v1/chat/completions') name = 'openrouter';
    calls.push({ name: name || u, url: u, init });
    if (!name || !routes[name]) return Promise.reject(new Error('unexpected fetch ' + u));
    return Promise.resolve(routes[name](init, calls)).then(r => {
      if (r instanceof Error) throw r;
      const status = r.status || 200;
      const text = r.text !== undefined ? r.text : JSON.stringify(r.json);
      return {
        ok: status >= 200 && status < 300, status,
        json: () => Promise.resolve().then(() => JSON.parse(text)),
        text: () => Promise.resolve(text),
      };
    });
  };
  return calls;
}

const okUser = () => ({ json: { id: '00000000-0000-4000-8000-0000000000aa', aud: 'authenticated', email: 'owner@example.test' } });
const yes = () => ({ json: true });
const no = () => ({ json: false });
const chat = content => () => ({ json: { choices: [{ message: { role: 'assistant', content } }] } });
const modelSays = obj => chat(JSON.stringify(obj));
const happy = extra => Object.assign({ user: okUser, trusted: yes, quota: yes }, extra);

function freshModule() {
  delete require.cache[require.resolve(FN)];
  return require(FN);
}

// Run the handler with env + fetch routes; capture console output.
async function run(reqOpts, routes, envOverride) {
  const saved = {};
  const env = Object.assign({}, ENV, envOverride || {});
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  const calls = installFetch(routes || {});
  const logs = [];
  const ol = console.log, oe = console.error, ow = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => logs.push(a.join(' '));
  console.warn = (...a) => logs.push(a.join(' '));
  const res = makeRes();
  try {
    await handler(makeReq(reqOpts), res);
  } finally {
    console.log = ol; console.error = oe; console.warn = ow;
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  let json = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch (e) { json = null; }
  return { res, json, calls, logs, names: calls.map(c => c.name) };
}

const handler = freshModule();
const I = handler._internal;
const DSL = require(path.join(ROOT, 'dashboard', 'screen-dsl.js'));

// ---- tests ---------------------------------------------------------------------------

async function main() {
  // AbortSignal.timeout() timers are unref'd: keep the loop alive while a stubbed
  // "hung" provider waits for its abort (a real fetch holds a socket instead).
  const keepAlive = setInterval(() => { }, 1000);
  // --- static: config files ----------------------------------------------------------
  const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  ok(vj.outputDirectory === 'dashboard' && vj.cleanUrls === true && vj.framework === null, 'vercel.json keeps the static-site config');
  ok(vj.functions && vj.functions['api/screen-builder.js'] && vj.functions['api/screen-builder.js'].maxDuration === 30, 'vercel.json maxDuration 30');
  ok(I.CONFIG.deadlineMs + 3000 <= vj.functions['api/screen-builder.js'].maxDuration * 1000, 'deadline fits inside maxDuration');
  const allH = (vj.headers || []).find(h => h.source === '/(.*)');
  const hv = k => allH && (allH.headers.find(x => x.key === k) || {}).value;
  ok(hv('X-Content-Type-Options') === 'nosniff' && hv('Referrer-Policy') === 'strict-origin-when-cross-origin' && hv('X-Frame-Options') === 'DENY', 'vercel.json security headers');
  ok(!(vj.headers || []).some(h => h.headers.some(x => /content-security-policy/i.test(x.key))), 'no CSP in v1 (Tailwind Play CDN needs eval)');
  ok((vj.headers || []).some(h => h.source === '/dashboard_data.json'), 'vercel.json keeps the dashboard_data.json cache header');

  const vi = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  ok(['engine/', 'scripts/', 'data/', '.env'].every(x => vi.includes(x)), '.vercelignore still excludes engine/ scripts/ data/ .env');
  // crude gitignore-style check: no pattern may match the function or the two DSL files
  const globRe = p => new RegExp('^(?:.*/)?' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\/$/, '(?:/.*)?') + '$');
  for (const f of ['api/screen-builder.js', 'dashboard/screen-dsl.js', 'dashboard/screen_fields.json']) {
    ok(!vi.some(p => globRe(p.replace(/^\//, '')).test(f) || f.startsWith(p)), `.vercelignore keeps ${f}`);
  }

  // --- static: source hygiene --------------------------------------------------------
  const src = fs.readFileSync(FN, 'utf8');
  ok(!/\brequire\(\s*['"](?!\.\.\/dashboard\/)/.test(src), 'zero npm deps (only ../dashboard requires)');
  ok(!/Access-Control-Allow-Origin['"],\s*['"]\*/.test(src), 'never ACAO *');
  const rules = fs.readFileSync(path.join(ROOT, 'engine', 'context', 'house_rules.md'), 'utf8');
  const bullet = rules.split(/\n(?=- )/).find(b => b.includes('"Growth" always means'));
  const norm = s => s.replace(/\*\*/g, '').replace(/^- /, '').replace(/\s+/g, ' ').trim();
  ok(bullet && norm(bullet) === norm(I.GROWTH_RULE), 'growth rule quoted verbatim from house_rules.md', bullet && norm(bullet));
  for (const sc of ['stocks', 'markets']) {
    const sp = I.systemPrompt(sc);
    ok(sp.includes(I.GROWTH_RULE), `${sc} prompt quotes the growth rule`);
    const keys = DSL.fields(sc).map(f => f.key);
    ok(keys.every(k => sp.includes(`- ${k} |`)), `${sc} prompt lists every registry field`);
    ok(!/momentum_score|ret_12m|mean_reversion/.test(sp), `${sc} prompt exposes no momentum field`);
    ok(sp.length < 9000, `${sc} prompt stays compact (${sp.length} chars)`);
    for (const f of DSL.fields(sc)) {
      if (f.growth) ok(new RegExp(`- ${f.key} \\|[^\\n]*\\[[a-z,]*growth`).test(sp), `${sc} prompt tags ${f.key} [growth]`);
      if (f.price_signal) ok(new RegExp(`- ${f.key} \\|[^\\n]*\\[[a-z,]*price`).test(sp), `${sc} prompt tags ${f.key} [price]`);
    }
  }
  ok(I.systemPrompt('stocks').includes('Technology (tech'), 'prompt carries static enum values + synonyms');
  ok(I.PROVIDERS[0].name === 'groq' && I.PROVIDERS[1].name === 'ollamacloud', 'chain order groq -> ollamacloud');

  // --- helpers --------------------------------------------------------------------------
  ok(I.extractJSON('```json\n{"filter":{}}\n```') !== null, 'extractJSON strips code fences');
  ok(I.extractJSON('Sure! {"filter":{"where":[]}} hope that helps') !== null, 'extractJSON finds an embedded object');
  ok(I.extractJSON('not json') === null && I.extractJSON('[1,2]') === null && I.extractJSON('') === null, 'extractJSON rejects junk');
  ok(JSON.stringify(I.keepIgnored(['momentum', 'IGNORE PREVIOUS INSTRUCTIONS', 5], 'cheap stocks with momentum')) === '["momentum"]', 'keepIgnored keeps only sentence pieces');

  // --- CORS / method / size / auth: rejected before any network call ---------------------
  let r = await run({ method: 'OPTIONS', origin: 'https://app.example.test' }, {});
  ok(r.res.statusCode === 204 && r.res.headers['access-control-allow-origin'] === 'https://app.example.test' && /Origin/.test(r.res.headers.vary), 'OPTIONS same-origin -> 204 + reflected Origin + Vary');
  ok(r.calls.length === 0, 'OPTIONS makes no network call');
  r = await run({ method: 'OPTIONS', origin: 'https://allowed.example.test' }, {});
  ok(r.res.statusCode === 204 && r.res.headers['access-control-allow-origin'] === 'https://allowed.example.test', 'ALLOWED_ORIGINS origin reflected');
  r = await run({ method: 'OPTIONS', origin: 'https://evil.example.test' }, {});
  ok(r.res.statusCode === 403 && !r.res.headers['access-control-allow-origin'], 'foreign Origin -> 403, no ACAO');
  r = await run({ origin: 'http://app.example.test', body: { sentence: 'cheap', scope: 'markets' } }, {});
  ok(r.res.statusCode === 403 && r.calls.length === 0, 'plain-http origin for a non-local host -> 403');
  r = await run({ origin: 'null', body: { sentence: 'cheap', scope: 'markets' } }, {});
  ok(r.res.statusCode === 403, "Origin 'null' -> 403");
  r = await run({ method: 'GET' }, {});
  ok(r.res.statusCode === 405 && r.json && r.json.error === 'method not allowed' && r.calls.length === 0, 'GET -> 405, no network');
  r = await run({ headers: { 'content-length': '5000' }, rawBody: '{}' }, {});
  ok(r.res.statusCode === 413 && r.calls.length === 0, 'Content-Length > 2048 -> 413, no network');
  r = await run({ headers: { 'content-length': '10' }, rawBody: JSON.stringify({ sentence: 'x'.repeat(3000), scope: 'stocks' }) }, {});
  ok(r.res.statusCode === 413 && r.calls.length === 0, 'lying Content-Length, body > 2048 -> 413');
  r = await run({ noAuth: true, body: { sentence: 'cheap', scope: 'stocks' } }, {});
  ok(r.res.statusCode === 401 && r.json.error === 'unauthorized' && r.calls.length === 0, 'missing Bearer -> 401, no network');
  for (const [label, tok] of [['two-part token', 'abc.def'], ['non-base64url chars', 'a$b.c.d'], ['payload not JSON', 'aaaa.bm90IGpzb24.cccc'],
    ['expired', jwt({ exp: Math.floor(Date.now() / 1000) - 10 })], ['no exp', `${b64u({ alg: 'HS256' })}.${b64u({ sub: 'x' })}.c2ln`],
    ['anonymous', jwt({ is_anonymous: true })]]) {
    r = await run({ token: tok, body: { sentence: 'cheap', scope: 'stocks' } }, {});
    ok(r.res.statusCode === 401 && r.calls.length === 0, `${label} -> 401, no network`);
  }
  r = await run({ headers: { authorization: 'Basic abc' }, noAuth: true, body: { sentence: 'cheap', scope: 'stocks' } }, {});
  ok(r.res.statusCode === 401 && r.calls.length === 0, 'non-Bearer scheme -> 401');

  // --- request validation ---------------------------------------------------------------
  for (const [label, body] of [['bad JSON', null], ['portfolio scope (reserved)', { sentence: 'cheap', scope: 'portfolio' }],
    ['unknown scope', { sentence: 'cheap', scope: 'bonds' }], ['empty sentence', { sentence: '  \u0007 ', scope: 'stocks' }],
    ['sentence > 400 chars', { sentence: 'a'.repeat(401), scope: 'stocks' }], ['non-object current', { sentence: 'cheap', scope: 'stocks', current: 'x' }],
    ['array body', [1, 2]]]) {
    r = await run(body === null ? { rawBody: '{"sentence":' } : { body }, happy());
    ok(r.res.statusCode === 400 && r.json.error === 'invalid request' && r.calls.length === 0, `${label} -> 400, no network`);
  }

  // --- Supabase auth outcomes -----------------------------------------------------------
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, { user: () => ({ status: 401, json: { msg: 'invalid JWT' } }) });
  ok(r.res.statusCode === 401 && r.json.error === 'unauthorized' && r.names.join() === 'user', 'Supabase rejects token -> 401, nothing else called');
  ok(!r.res.body.includes('invalid JWT'), 'upstream error text never returned');
  const uc = r.calls[0];
  ok(uc.init.method === 'GET' && uc.init.headers.apikey === ENV.SUPABASE_ANON_KEY && uc.init.headers.Authorization === `Bearer ${GOOD}`, 'auth/v1/user called with apikey + caller token');
  r = await run({ body: { sentence: 'cheap', scope: 'stocks' } }, { user: () => ({ json: { id: 'u', is_anonymous: true } }) });
  ok(r.res.statusCode === 401, 'anonymous user record -> 401');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, { user: () => ({ status: 503, text: 'down' }) });
  ok(r.res.statusCode === 200 && r.json.source === 'rules' && r.json.note === 'AI temporarily unavailable', 'auth outage -> rules');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, { user: () => new Error('ECONNRESET') });
  ok(r.res.statusCode === 200 && r.json.source === 'rules' && r.json.note === 'AI temporarily unavailable', 'auth network error -> rules');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, happy(), { SUPABASE_URL: '' });
  ok(r.res.statusCode === 200 && r.json.source === 'rules' && r.calls.length === 0, 'Supabase not configured -> rules, no network');

  // --- untrusted / no key / quota -> rules ---------------------------------------------
  r = await run({ body: { sentence: 'cheap tech stocks with p/e under 20', scope: 'stocks' } }, happy({ trusted: no }));
  const expectRules = DSL.ruleParse('cheap tech stocks with p/e under 20', 'stocks');
  ok(r.res.statusCode === 200 && r.json.source === 'rules' && r.json.note === 'AI parsing is limited to approved accounts', 'untrusted -> rules + note');
  ok(JSON.stringify(r.json.filter) === JSON.stringify(expectRules.filter) && JSON.stringify(r.json.rules.filter) === JSON.stringify(expectRules.filter), 'untrusted gets exactly the ruleParse filter');
  ok(r.names.join() === 'user,trusted', 'untrusted: no quota, no LLM call');
  ok(r.calls[1].init.method === 'POST' && r.calls[1].init.headers.Authorization === `Bearer ${GOOD}`, 'is_trusted called with the caller token');
  r = await run({ body: { sentence: 'cheap', scope: 'stocks' } }, happy({ trusted: () => ({ status: 404, json: { code: 'PGRST202' } }) }));
  ok(r.json.source === 'rules' && r.json.note === 'AI temporarily unavailable' && r.names.join() === 'user,trusted', 'is_trusted missing (pre-migration) -> rules');
  r = await run({ body: { sentence: 'cheap', scope: 'stocks' } }, happy(), { GROQ_API_KEY: '', OLLAMA_API_KEY: '', OPENROUTER_API_KEY: '' });
  ok(r.json.source === 'rules' && r.names.join() === 'user,trusted', 'no provider key -> rules, quota not spent');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, happy({ quota: no }));
  ok(r.json.source === 'rules' && r.json.note === 'daily AI limit reached' && r.names.join() === 'user,trusted,quota', 'quota false -> rules, no LLM');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, happy({ quota: () => ({ status: 404, json: {} }) }));
  ok(r.json.source === 'rules' && r.json.note === 'AI temporarily unavailable' && !r.names.includes('groq'), 'quota RPC non-200 -> rules, no LLM');
  r = await run({ body: { sentence: 'cheap tech stocks', scope: 'stocks' } }, happy({ quota: () => ({ json: 'true' }) }));
  ok(r.json.source === 'rules' && !r.names.includes('groq'), "quota must be JSON true (not 'true')");

  // --- the model waterfall ---------------------------------------------------------------
  const goodTech = { filter: { v: 1, scope: 'stocks', where: [{ field: 'sector', op: 'in', value: ['tech'] }, { field: 'pe', op: '<', value: 20 }], sort: { field: 'value_score', dir: 'desc' } }, ignored: [] };
  r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({ groq: modelSays(goodTech) }));
  ok(r.res.statusCode === 200 && r.json.source === 'groq:llama-3.3-70b-versatile', 'success on tier 1 (groq)', JSON.stringify(r.json));
  ok(r.json.filter && r.json.filter.where[0].value[0] === 'Technology', 'model enum synonym canonicalised by validate');
  ok(r.json.note === null && Array.isArray(r.json.rules.notes) && r.json.rules.filter, 'AI response still carries the rules reading');
  ok(r.names.join() === 'user,trusted,quota,groq', 'success: one model call');
  const gb = JSON.parse(r.calls[3].init.body);
  ok(gb.model === 'llama-3.3-70b-versatile' && gb.temperature === 0 && gb.max_tokens === 700 && gb.response_format && gb.response_format.type === 'json_object', 'model request: temp 0, max_tokens 700, json_object');
  ok(gb.messages.length === 2 && gb.messages[0].role === 'system' && gb.messages[1].content === 'tech stocks with p/e under 20', 'user message = the sentence only');
  ok(r.calls[3].init.headers.Authorization === `Bearer ${ENV.GROQ_API_KEY}` && r.calls[3].init.signal, 'provider key sent as Bearer, with an abort signal');
  ok(!gb.messages[0].content.includes(ENV.GROQ_API_KEY) && !gb.messages[0].content.includes(GOOD), 'no key/token in the prompt');

  // control chars stripped from the sentence before parsing and before the model sees it
  r = await run({ body: { sentence: 'tech\u0000 stocks\u202e with p/e\n under 20', scope: 'stocks' } }, happy({ groq: modelSays(goodTech) }));
  ok(JSON.parse(r.calls[3].init.body).messages[1].content === 'tech stocks with p/e under 20', 'control/bidi chars stripped');

  // invalid JSON on tier 1 -> tier 2
  r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({ groq: chat('I think you want tech stocks!'), ollamacloud: modelSays(goodTech) }));
  ok(r.json.source === 'ollamacloud:gpt-oss:120b' && r.names.join() === 'user,trusted,quota,groq,ollamacloud', 'invalid JSON -> next tier');
  // empty content, 429, network error, unknown field, __proto__ -> next tier
  for (const [label, groq] of [['empty content', chat('')], ['429', () => ({ status: 429, json: { error: 'rate' } })],
    ['network error', () => new Error('socket hang up')], ['unknown field', modelSays({ filter: { where: [{ field: 'beta', op: '<', value: 1 }] } })],
    ['__proto__ field', chat('{"filter":{"where":[{"field":"__proto__","op":"<","value":1}]}}')],
    ['constructor op', modelSays({ filter: { where: [{ field: 'pe', op: 'constructor', value: 1 }] } })],
    ['wrong scope', modelSays({ filter: { scope: 'markets', where: [] } })], ['no filter key', modelSays({ where: [] })]]) {
    r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({ groq, ollamacloud: modelSays(goodTech) }));
    ok(r.json && r.json.source === 'ollamacloud:gpt-oss:120b', `${label} on tier 1 -> tier 2`, r.json && JSON.stringify(r.json.source));
  }

  // growthGuard: "growing" mapped to a price signal is rejected -> next tier
  const priceAsGrowth = { filter: { where: [{ field: 'discount_long', op: '<', value: 0 }, { field: 'turning_up', op: 'is_true' }] } };
  const fundGrowth = { filter: { where: [{ field: 'rev_cagr', op: '>', value: 0 }, { field: 'ni_cagr', op: '>', value: 0 }], sort: { field: 'growth_score', dir: 'desc' } } };
  r = await run({ body: { sentence: 'fast growing companies', scope: 'stocks' } }, happy({ groq: modelSays(priceAsGrowth), ollamacloud: modelSays(fundGrowth) }));
  ok(r.json.source === 'ollamacloud:gpt-oss:120b' && r.json.filter.where.every(c => DSL.field(c.field).growth), 'growthGuard rejects price-as-growth -> next tier');
  // growth sentence with no growth field at all -> rejected
  r = await run({ body: { sentence: 'growing companies', scope: 'stocks' } }, happy({ groq: modelSays({ filter: { where: [{ field: 'pe', op: '<', value: 15 }] } }), ollamacloud: modelSays(fundGrowth) }));
  ok(r.json.source === 'ollamacloud:gpt-oss:120b', 'growth sentence without a growth field -> next tier');
  // every tier fails -> rules (whose growth reading is fundamental)
  r = await run({ body: { sentence: 'fast growing companies', scope: 'stocks' } }, happy({ groq: modelSays(priceAsGrowth), ollamacloud: modelSays(priceAsGrowth) }));
  ok(r.json.source === 'rules' && r.json.note && /rule-based/.test(r.json.note), 'all tiers fail -> rules + note');
  ok(r.json.filter.where.length > 0 && r.json.filter.where.every(c => !DSL.field(c.field).price_signal), 'rules growth reading has no price signal');
  // the price signal is fine when the sentence names it
  r = await run({ body: { sentence: 'growing companies trading below their average price', scope: 'stocks' } },
    happy({ groq: modelSays({ filter: { where: [{ field: 'rev_cagr', op: '>', value: 0 }, { field: 'discount_long', op: '<', value: 0 }] } }) }));
  ok(r.json.source === 'groq:llama-3.3-70b-versatile', 'named price signal + growth field accepted');

  // 400 with response_format -> retried once without it, same tier
  let attempts = 0;
  r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({
    groq: init => { attempts++; return JSON.parse(init.body).response_format ? { status: 400, json: { error: 'response_format' } } : modelSays(goodTech)(); },
  }));
  ok(r.json.source === 'groq:llama-3.3-70b-versatile' && attempts === 2, '400 on json mode -> one plain retry');

  // timeouts: hung tier aborted by its signal, next tier answers; deadline stops the chain
  const hang = init => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason || new Error('aborted'))));
  const saved = Object.assign({}, I.CONFIG);
  Object.assign(I.CONFIG, { tierTimeoutMs: 60, deadlineMs: 5000, minTierMs: 10 });
  let t0 = Date.now();
  r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({ groq: hang, ollamacloud: modelSays(goodTech) }));
  ok(r.json.source === 'ollamacloud:gpt-oss:120b' && Date.now() - t0 < 2000, 'hung tier times out -> next tier');
  ok(r.logs.some(l => /groq:timeout/.test(l)), 'timeout logged by provider name');
  Object.assign(I.CONFIG, { tierTimeoutMs: 80, deadlineMs: 120, minTierMs: 50 });
  t0 = Date.now();
  r = await run({ body: { sentence: 'tech stocks with p/e under 20', scope: 'stocks' } }, happy({ groq: hang, ollamacloud: hang }));
  ok(r.json.source === 'rules' && !r.names.includes('ollamacloud') && Date.now() - t0 < 2000, 'overall deadline stops the chain -> rules');
  Object.assign(I.CONFIG, saved);

  // OpenRouter is tried only when its key is set
  r = await run({ body: { sentence: 'tech stocks', scope: 'stocks' } }, happy({ groq: chat('x'), ollamacloud: chat('y'), openrouter: modelSays(goodTech) }), { OPENROUTER_API_KEY: 'or-placeholder' });
  ok(r.json.source === 'openrouter:meta-llama/llama-3.3-70b-instruct:free', 'openrouter tier when configured');
  r = await run({ body: { sentence: 'tech stocks', scope: 'stocks' } }, happy({ groq: chat('x'), ollamacloud: chat('y'), openrouter: modelSays(goodTech) }));
  ok(r.json.source === 'rules' && !r.names.includes('openrouter'), 'openrouter skipped without key');
  // only Ollama configured -> Groq never contacted
  r = await run({ body: { sentence: 'tech stocks', scope: 'stocks' } }, happy({ ollamacloud: modelSays(goodTech) }), { GROQ_API_KEY: '' });
  ok(r.json.source === 'ollamacloud:gpt-oss:120b' && !r.names.includes('groq'), 'tier without key skipped');

  // --- no raw model text in the response --------------------------------------------------
  const chatty = Object.assign({}, goodTech, { explanation: 'EXPLAIN-' + SECRET_SENTENCE_MARK, ignored: ['<img src=x onerror=alert(1)>', 'with momentum'] });
  r = await run({ body: { sentence: 'tech stocks with momentum', scope: 'stocks' } }, happy({ groq: modelSays(chatty) }));
  ok(r.json.source.startsWith('groq') && !r.res.body.includes('EXPLAIN-') && !r.res.body.includes('onerror'), 'model free text / injected HTML never returned');
  ok(JSON.stringify(r.json.unparsed) === '["with momentum"]', 'ignored phrases limited to pieces of the sentence');
  ok(JSON.stringify(Object.keys(r.json).sort()) === JSON.stringify(['filter', 'note', 'notes', 'rules', 'source', 'unparsed']), 'response keys fixed');

  // --- refine mode ------------------------------------------------------------------------
  const current = DSL.ruleParse('cheap tech stocks with p/e under 20', 'stocks').filter;
  r = await run({ body: { sentence: 'p/e under 12', scope: 'stocks', current } }, happy({ groq: modelSays({ filter: Object.assign({}, current, { where: current.where.map(c => c.field === 'pe' ? { field: 'pe', op: '<', value: 12 } : c) }) }) }));
  const sys = JSON.parse(r.calls[3].init.body).messages[0].content;
  ok(sys.includes('REFINE MODE') && sys.includes(JSON.stringify(current)), 'current filter included in the prompt');
  ok(r.json.rules.filter.where.find(c => c.field === 'pe').value === 12, 'rules refine applied to current');
  ok(r.json.filter.where.find(c => c.field === 'pe').value === 12 && r.json.filter.where.length === current.where.length, 'AI refine result validated');
  // a refine that keeps a price field already in `current` passes the growth guard
  const curOnSale = DSL.validate({ v: 1, scope: 'stocks', where: [{ field: 'discount_long', op: '<', value: -0.1 }] }, 'stocks').filter;
  r = await run({ body: { sentence: 'only growing ones', scope: 'stocks', current: curOnSale } },
    happy({ groq: modelSays({ filter: { where: [{ field: 'discount_long', op: '<', value: -0.1 }, { field: 'rev_cagr', op: '>', value: 0 }] } }) }));
  ok(r.json.source.startsWith('groq'), 'growthGuard exempts price fields already in current');
  // invalid current -> ignored with a note, not a 400
  r = await run({ body: { sentence: 'cheap', scope: 'stocks', current: { where: [{ field: 'nope', op: '<', value: 1 }] } } }, happy({ trusted: no }));
  ok(r.res.statusCode === 200 && r.json.notes.some(n => /new screen/.test(n)), 'invalid current -> new screen note');

  // --- N-year average qualifier is never dropped -------------------------------------------
  r = await run({ body: { sentence: 'markets below their 5-year average', scope: 'markets' } },
    happy({ groq: modelSays({ filter: { where: [{ field: 'discount_long', op: '<', value: 0 }] } }) }));
  ok(r.json.source.startsWith('groq') && r.json.filter.where.some(c => c.field === 'long_avg_years' && c.value >= 5), 'long_avg_years from the rules carried into the AI filter', JSON.stringify(r.json.filter));

  // --- markets scope --------------------------------------------------------------------------
  r = await run({ body: { sentence: 'cheap emerging markets', scope: 'markets' } },
    happy({ groq: modelSays({ filter: { where: [{ field: 'development', op: '=', value: 'emerging' }, { field: 'value_score', op: '>=', value: 70 }] } }) }));
  ok(r.json.source.startsWith('groq') && r.json.filter.scope === 'markets', 'markets scope success', JSON.stringify(r.json));
  ok(JSON.parse(r.calls[3].init.body).messages[0].content.includes('markets screen'), 'markets prompt used');

  // --- rules notes survive an AI answer (review fix) -------------------------------------------
  r = await run({ body: { sentence: 'stocks trading below their 5-year average', scope: 'stocks' } },
    happy({ groq: modelSays({ filter: { where: [{ field: 'discount_long', op: '<', value: 0 }] } }) }));
  ok(r.json.source.startsWith('groq') && r.json.filter.where.some(c => c.field === 'long_avg_years'), 'AI filter keeps the 5-year qualifier', JSON.stringify(r.json));
  ok(r.json.notes.some(n => /5-year averages exist only for markets/.test(n)), 'AI answer carries the rules notes (5-year warning)', JSON.stringify(r.json.notes));

  // --- a screen holding a user-built ticker list never reaches a model (review fix) -------------
  const listCur = { v: 1, scope: 'stocks', where: [{ field: 'ticker', op: 'in', value: ['FXA', 'FXB', 'FXC'] }] };
  r = await run({ body: { sentence: 'only the cheap ones', scope: 'stocks', current: listCur } }, happy({ groq: modelSays(goodTech) }));
  ok(r.json.source === 'rules' && r.json.note === I.NOTE.privateList, 'ticker-list screen -> rules, private-list note', JSON.stringify(r.json));
  ok(!r.calls.some(c => /rpc\/ai_quota_take|groq|ollama|openrouter/.test(c.url)), 'ticker-list screen spends no quota and calls no provider', r.calls.map(c => c.url).join(' '));
  ok(r.json.filter.where.some(c => c.field === 'ticker' && c.op === 'in'), 'rules refine keeps the ticker list');

  // --- logs: status codes + provider only ------------------------------------------------------
  r = await run({ body: { sentence: `tech stocks ${SECRET_SENTENCE_MARK}`, scope: 'stocks' } }, happy({ groq: chat('bad'), ollamacloud: modelSays(goodTech) }));
  const logText = r.logs.join('\n');
  ok(r.logs.length === 1 && /^screen-builder ai /.test(r.logs[0]), 'one log line per request', logText);
  ok(!logText.includes(SECRET_SENTENCE_MARK) && !logText.includes('owner@example.test') && !logText.includes(GOOD) && !logText.includes('placeholder') && !logText.includes('0000000000aa'), 'logs carry no sentence/email/token/key/user id');
  ok(/groq:200:rejected/.test(logText) && /ollamacloud:200:ok/.test(logText), 'logs carry provider + status');

  // --- Vercel helper path: pre-parsed req.body ---------------------------------------------------
  const vreq = makeReq({ body: { sentence: 'cheap', scope: 'markets' } });
  vreq.body = { sentence: 'cheap', scope: 'markets' };
  const vres = makeRes();
  const savedEnv = {}; for (const k of Object.keys(ENV)) { savedEnv[k] = process.env[k]; process.env[k] = ENV[k]; }
  installFetch(happy({ trusted: no }));
  const ol = console.log; console.log = () => { };
  try { await handler(vreq, vres); } finally { console.log = ol; for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } }
  ok(vres.statusCode === 200 && JSON.parse(vres.body).source === 'rules', 'works with Vercel pre-parsed req.body');
  const breq = makeReq({ body: {} });
  Object.defineProperty(breq, 'body', { get() { throw new Error('Invalid JSON'); } });
  const bres = makeRes();
  console.log = () => { };
  try { await handler(breq, bres); } finally { console.log = ol; }
  ok(bres.statusCode === 400, 'Vercel req.body getter throwing -> 400');

  // --- security headers on every response -------------------------------------------------------
  ok(r.res.headers['cache-control'] === 'no-store' && r.res.headers['x-content-type-options'] === 'nosniff', 'no-store + nosniff on responses');

  console.log(results.join('\n'));
  console.log(`\ntest_screen_builder: ${passed} passed, ${failed} failed`);
  clearInterval(keepAlive);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
