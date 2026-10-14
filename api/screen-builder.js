// AI screen builder — Vercel function (Node 20+, CommonJS, zero npm deps, global fetch).
//
// POST {sentence, scope: 'stocks'|'markets', current?: filter|null} -> 200
//   {filter, source, unparsed, notes, note, rules}
// source = 'rules' or '<provider>:<model>'; note = why the AI path was not used (null
// when it was); rules = the deterministic reading {filter, unparsed, notes}, always.
// It turns ONE sentence into a Screen DSL filter (dashboard/screen-dsl.js). It is a
// request-time feature, not an agent and not a job (ADR-037).
//
// The deterministic rules parser (ScreenDSL.ruleParse) runs first, always, and is the
// answer whenever anything about the AI path is unavailable: caller not approved
// (is_trusted), daily quota spent (ai_quota_take), no provider key, every model tier
// failing. The model only ever proposes a filter; that proposal must pass
// ScreenDSL.validate and ScreenDSL.growthGuard ("growth" = fundamentals, never price)
// or the next tier is tried. No model text reaches the caller — only a validated
// filter, plus the "ignored" phrases that are verbatim pieces of the caller's own sentence.
//
// Cost/abuse guards (design review): cheap checks reject before any network call
// (method, body size, Bearer JWT shape, exp, anonymous); the LLM runs only for trusted
// callers; quotas are server-side (public.ai_config); responses carry fixed strings
// only; logs carry status codes + provider names only — never the sentence, token,
// email or user id. The provider keys here are SEPARATE accounts from the GitHub
// Actions ones, so request-time use cannot starve the pipeline's agents (.env.example).
'use strict';

const ScreenDSL = require('../dashboard/screen-dsl.js');
require('../dashboard/screen_fields.json'); // already loaded by screen-dsl.js; named here so the bundle keeps it

// Mutable only so the test runner can shrink timeouts; nothing in production writes it.
const CONFIG = {
  maxBody: 2048,          // bytes
  maxSentence: 400,       // characters
  supabaseTimeoutMs: 5000,
  tierTimeoutMs: 9000,    // per model tier
  deadlineMs: 24000,      // whole request (vercel.json maxDuration is 30 s)
  minTierMs: 1500,        // don't start a tier with less than this left
  maxTokens: 700,
};

// Free tiers only. Groq first on purpose: latency matters on a 24 s budget
// (engine/config.py puts Ollama Cloud first for the batch agents). Base URLs and model
// ids are the ones engine/llm.py and engine/config.py already use.
const PROVIDERS = [
  { name: 'groq', model: 'llama-3.3-70b-versatile', url: 'https://api.groq.com/openai/v1/chat/completions', env: 'GROQ_API_KEY' },
  { name: 'ollamacloud', model: 'gpt-oss:120b', url: 'https://ollama.com/v1/chat/completions', env: 'OLLAMA_API_KEY' },
  { name: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', url: 'https://openrouter.ai/api/v1/chat/completions', env: 'OPENROUTER_API_KEY' },
];

// Quoted verbatim from engine/context/house_rules.md (markdown emphasis removed);
// scripts/test_screen_builder.js fails if the two drift apart.
const GROWTH_RULE = '"Growth" always means FUNDAMENTAL growth — revenue and earnings growth of the ' +
  'underlying companies (plus forward analyst estimates) — never price momentum.';

const SCOPES = new Set(['stocks', 'markets']);

// Fixed strings — the only text the caller ever gets besides its own sentence pieces.
const ERR = {
  method: 'method not allowed',
  origin: 'origin not allowed',
  size: 'request too large',
  invalid: 'invalid request',
  auth: 'unauthorized',
  internal: 'internal error',
};
const NOTE = {
  untrusted: 'AI parsing is limited to approved accounts',
  quota: 'daily AI limit reached',
  unavailable: 'AI temporarily unavailable',
  noKey: 'AI is not configured on this deployment',
  failed: "AI couldn't read that sentence; showing the rule-based reading",
  current: 'Started a new screen: the current one is not valid for this scope.',
};

const nowMs = () => Date.now();
const env = k => String(process.env[k] || '').trim();
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
// Control characters, line/paragraph separators and bidi overrides -> space.
const clean = s => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();

// ---- HTTP plumbing ----------------------------------------------------------

function header(req, k) {
  const v = req.headers ? req.headers[k] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(obj === undefined ? '' : JSON.stringify(obj));
}

// CORS: same-origin only. Reflect Origin only when it is the request's own host or is
// listed in ALLOWED_ORIGINS (comma list) — never '*'. No Origin (curl, server-side) is
// fine: the Bearer token is still required.
function originAllowed(req) {
  const origin = header(req, 'origin');
  if (!origin) return { ok: true, origin: null };
  const list = env('ALLOWED_ORIGINS').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (list.includes(origin)) return { ok: true, origin };
  let u;
  try { u = new URL(origin); } catch (e) { return { ok: false, origin: null }; }
  const host = String(header(req, 'x-forwarded-host') || header(req, 'host') || '').split(',')[0].trim().toLowerCase();
  const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(u.host);
  const schemeOk = u.protocol === 'https:' || (u.protocol === 'http:' && local);
  if (host && schemeOk && u.host.toLowerCase() === host && origin === u.origin) return { ok: true, origin };
  return { ok: false, origin: null };
}

// Body: Vercel's Node helpers pre-buffer it and expose a lazy req.body getter (which
// throws on bad JSON); a plain http server gives the stream. Both are capped.
async function readBody(req) {
  let b;
  try { b = req.body; } catch (e) { return { error: 'invalid' }; }
  if (b !== undefined && b !== null) {
    if (Buffer.isBuffer(b)) b = b.toString('utf8');
    if (typeof b === 'string') {
      if (Buffer.byteLength(b, 'utf8') > CONFIG.maxBody) return { error: 'size' };
      try { return { json: JSON.parse(b) }; } catch (e) { return { error: 'invalid' }; }
    }
    if (isObj(b)) {
      if (Buffer.byteLength(JSON.stringify(b), 'utf8') > CONFIG.maxBody) return { error: 'size' };
      return { json: b };
    }
    return { error: 'invalid' };
  }
  if (typeof req.on !== 'function') return { error: 'invalid' };
  return new Promise(resolve => {
    const chunks = [];
    let n = 0, done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    req.on('data', c => {
      if (done) return;
      n += c.length;
      if (n > CONFIG.maxBody) { finish({ error: 'size' }); if (typeof req.destroy === 'function') req.destroy(); return; }
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on('end', () => {
      try { finish({ json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
      catch (e) { finish({ error: 'invalid' }); }
    });
    req.on('error', () => finish({ error: 'invalid' }));
  });
}

// Shape-check the Supabase access token locally (no signature check — that is what
// /auth/v1/user is for). Rejects junk before it can cost a round trip.
function checkBearer(req) {
  const h = header(req, 'authorization');
  if (typeof h !== 'string' || h.length > 4096) return null;
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h.trim());
  if (!m) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!isObj(claims)) return null;
  if (typeof claims.exp !== 'number' || !isFinite(claims.exp) || claims.exp * 1000 <= nowMs()) return null;
  if (claims.is_anonymous === true) return null;
  return `${m[1]}.${m[2]}.${m[3]}`;
}

function parseRequest(json) {
  if (!isObj(json)) return null;
  const { sentence, scope } = json;
  if (typeof sentence !== 'string' || typeof scope !== 'string' || !SCOPES.has(scope)) return null;
  if (sentence.length > CONFIG.maxSentence) return null;
  const s = clean(sentence);
  if (!s) return null;
  const current = own(json, 'current') ? json.current : null;
  if (current !== null && current !== undefined && !isObj(current)) return null;
  return { sentence: s, scope, current: current || null };
}

// ---- Supabase (caller's own token; RLS + SECURITY DEFINER RPCs decide) -------

async function supa(path, token, method) {
  const base = env('SUPABASE_URL').replace(/\/+$/, '');
  const r = await fetch(base + path, {
    method,
    headers: {
      apikey: env('SUPABASE_ANON_KEY'),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: method === 'POST' ? '{}' : undefined,
    signal: AbortSignal.timeout(CONFIG.supabaseTimeoutMs),
  });
  let body = null;
  if (r.ok) { try { body = await r.json(); } catch (e) { body = null; } }
  return { status: r.status, body };
}

// ---- prompt ------------------------------------------------------------------

const promptCache = new Map();
function systemPrompt(scope) {
  if (promptCache.has(scope)) return promptCache.get(scope);
  const reg = ScreenDSL.registry();
  const L = reg.limits;
  const lines = ScreenDSL.fields(scope).map(f => {
    const type = f.list ? 'list' : f.type;
    const tags = [f.growth ? 'growth' : '', f.price_signal ? 'price' : ''].filter(Boolean);
    const syn = (f.synonyms || []).filter(s => s.toLowerCase() !== f.key).slice(0, 3);
    let line = `- ${f.key} | ${f.label} | ${type}${f.unit ? ' (' + f.unit + ')' : ''}`;
    if (tags.length) line += ` | [${tags.join(',')}]`;
    if (syn.length) line += ` | aka ${syn.join(', ')}`;
    if (f.type === 'enum') {
      const es = f.enum_synonyms || {};
      const few = f.enum.length <= 15;
      line += ' | values: ' + f.enum.map(v => {
        const s = few && own(es, v) ? es[v].filter(x => x.toLowerCase() !== v.toLowerCase()).slice(0, 3) : [];
        return s.length ? `${v} (${s.join(', ')})` : v;
      }).join('; ');
    }
    return line;
  });
  const ops = Object.keys(reg.type_ops).map(t => `${t}: ${reg.type_ops[t].join(' ')}`).join('; ');
  const text = [
    `You turn ONE sentence into a ${scope} screen for a valuation dashboard.`,
    'Reply with exactly ONE JSON object and nothing else (no markdown, no prose):',
    '{"filter": <filter>, "ignored": [<phrases copied from the sentence that the screen cannot express>]}',
    '',
    `House rule, verbatim: ${GROWTH_RULE}`,
    'So growth words (grow, growing, growth, compounding, expanding) map ONLY to fields tagged [growth].',
    'Fields tagged [price] move with the share price: use one only when the sentence names that price idea',
    'itself (e.g. "below its average", "turning up", "opportunity score"). Price momentum and returns are',
    'not available at all: put such phrases in "ignored".',
    '',
    'Filter grammar:',
    `{"v":1,"scope":"${scope}","where":[{"field":<key>,"op":<op>,"value":<value>}],"sort":{"field":<key>,"dir":"asc"|"desc"} or null,"limit":<${L.limit_min}-${L.limit_max}, default ${L.limit_default}>,"include_flagged":false}`,
    `- "where" is an AND of at most ${L.max_conditions} conditions. Use only the field keys listed below.`,
    `- Operators by type: ${ops}. "between" takes [low, high]; "in"/"not_in" take a list; is_true/is_false take no value.`,
    '- percent fields are FRACTIONS: 8% -> 0.08; "20% below" -> -0.2. money is in USD: 10 billion -> 10000000000.',
    '- enum values must be one of the listed values, spelled exactly.',
    '- "top N" sets limit N; "cheapest"/"highest X" set sort. include_flagged stays false unless the sentence asks for flagged or excluded rows.',
    '- If part of the sentence cannot be expressed with these fields, leave it out and list it in "ignored". Never invent fields.',
    '',
    `Fields for scope "${scope}" (key | label | type | tags | synonyms | values):`,
    ...lines,
  ].join('\n');
  promptCache.set(scope, text);
  return text;
}

function refineBlock(current) {
  if (!current) return '';
  return '\n\nREFINE MODE. The CURRENT screen is below. Return the complete updated screen: keep its conditions ' +
    'unless the sentence changes or removes them; a new condition on a field already present replaces it; ' +
    '"remove/drop/without X" deletes X; "sort by"/"top N" replace sort/limit; "start over" means an empty screen.\n' +
    'CURRENT: ' + JSON.stringify(current);
}

// ---- model output --------------------------------------------------------------

// One JSON object out of a model reply (tolerates code fences / stray prose).
function extractJSON(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { const o = JSON.parse(t); return isObj(o) ? o : null; } catch (e) { /* fall through */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { const o = JSON.parse(t.slice(a, b + 1)); return isObj(o) ? o : null; } catch (e) { return null; }
}

// "ignored" is model text, so only pieces that occur verbatim in the caller's own
// sentence are passed on — the model can't put words in the UI.
function keepIgnored(ignored, sentence) {
  if (!Array.isArray(ignored)) return [];
  const s = sentence.toLowerCase();
  const out = [];
  for (const x of ignored) {
    if (typeof x !== 'string') continue;
    const p = clean(x).slice(0, 80);
    if (p && s.includes(p.toLowerCase()) && !out.includes(p)) out.push(p);
    if (out.length >= 10) break;
  }
  return out;
}

// A "N-year average" qualifier is never silently dropped (ADR-037): if the rules parse
// pinned long_avg_years and the model's filter didn't, carry the rules condition over.
function keepYearQualifier(filter, rulesFilter, scope) {
  if (!rulesFilter) return filter;
  const req = rulesFilter.where.find(c => c.field === 'long_avg_years');
  if (!req || filter.where.some(c => c.field === 'long_avg_years')) return filter;
  const v = ScreenDSL.validate(Object.assign({}, filter, { where: filter.where.concat([req]) }), scope);
  return v.ok ? v.filter : null;
}

// Returns {filter, ignored} or null (=> next tier).
function acceptModelOutput(obj, req, rulesFilter) {
  if (!obj || !isObj(obj.filter)) return null;
  const f = Object.assign({}, obj.filter);
  if (!own(f, 'scope') || f.scope === null) f.scope = req.scope;
  if (!own(f, 'v')) f.v = 1;
  const v = ScreenDSL.validate(f, req.scope);
  if (!v.ok) return null;
  const filter = keepYearQualifier(v.filter, rulesFilter, req.scope);
  if (!filter) return null;
  const g = ScreenDSL.growthGuard(req.sentence, filter, req.current);
  if (!g.ok) return null;
  return { filter, ignored: keepIgnored(obj.ignored, req.sentence) };
}

async function askTier(p, key, system, sentence, timeoutMs, jsonMode) {
  const body = {
    model: p.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: sentence }],
    temperature: 0,
    max_tokens: CONFIG.maxTokens,
    stream: false,
  };
  if (jsonMode) body.response_format = { type: 'json_object' };
  const r = await fetch(p.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) return { status: r.status, text: null };
  let j = null;
  try { j = await r.json(); } catch (e) { return { status: r.status, text: null }; }
  const msg = j && Array.isArray(j.choices) && j.choices[0] && j.choices[0].message;
  return { status: r.status, text: msg && typeof msg.content === 'string' ? msg.content : null };
}

// Walk the free-tier chain within the deadline; first validated + growth-guarded
// filter wins. `log` collects status codes + provider names only.
async function runChain(req, rulesFilter, keys, started, log) {
  const system = systemPrompt(req.scope) + refineBlock(req.current);
  for (const p of PROVIDERS) {
    const key = keys[p.name];
    if (!key) continue;
    let jsonMode = true;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = CONFIG.deadlineMs - (nowMs() - started);
      if (left < CONFIG.minTierMs) { log.push('deadline'); return null; }
      let out;
      try { out = await askTier(p, key, system, req.sentence, Math.min(CONFIG.tierTimeoutMs, left), jsonMode); }
      catch (e) { log.push(`${p.name}:${e && e.name === 'TimeoutError' ? 'timeout' : 'error'}`); break; }
      // Some OpenAI-compatible endpoints reject response_format: retry once without it
      // (as engine/llm.py does).
      if (out.status === 400 && jsonMode) { log.push(`${p.name}:400`); jsonMode = false; continue; }
      if (out.text === null) { log.push(`${p.name}:${out.status}`); break; }
      const got = acceptModelOutput(extractJSON(out.text), req, rulesFilter);
      log.push(`${p.name}:${out.status}:${got ? 'ok' : 'rejected'}`);
      if (got) return Object.assign(got, { source: `${p.name}:${p.model}` });
      break;
    }
  }
  return null;
}

// ---- handler -------------------------------------------------------------------

function logLine(outcome, log) {
  // Aggregate-free, content-free: outcome + provider/status tokens only.
  try { console.log(`screen-builder ${outcome}${log.length ? ' ' + log.join(' ') : ''}`); } catch (e) { /* ignore */ }
}

async function handler(req, res) {
  const started = nowMs();
  const log = [];
  try {
    res.setHeader('Vary', 'Origin');
    const o = originAllowed(req);
    if (!o.ok) { logLine('403', log); return send(res, 403, { error: ERR.origin }); }
    if (o.origin) res.setHeader('Access-Control-Allow-Origin', o.origin);

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type');
      res.setHeader('Access-Control-Max-Age', '600');
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST, OPTIONS'); logLine('405', log); return send(res, 405, { error: ERR.method }); }

    const cl = Number(header(req, 'content-length'));
    if (isFinite(cl) && cl > CONFIG.maxBody) { logLine('413', log); return send(res, 413, { error: ERR.size }); }

    const token = checkBearer(req);
    if (!token) { logLine('401', log); return send(res, 401, { error: ERR.auth }); }

    const body = await readBody(req);
    if (body.error === 'size') { logLine('413', log); return send(res, 413, { error: ERR.size }); }
    const r = body.error ? null : parseRequest(body.json);
    if (!r) { logLine('400', log); return send(res, 400, { error: ERR.invalid }); }

    // A stale/invalid `current` (e.g. saved under an older registry) starts a new screen.
    const notes0 = [];
    if (r.current) {
      const cv = ScreenDSL.validate(r.current, r.scope);
      if (cv.ok) r.current = cv.filter;
      else { r.current = null; notes0.push(NOTE.current); }
    }

    // The free path, always computed first.
    const rp = ScreenDSL.ruleParse(r.sentence, r.scope, r.current);
    const rules = { filter: rp.filter, unparsed: rp.unparsed, notes: notes0.concat(rp.notes.filter(n => !notes0.includes(n))) };
    const asRules = (note, outcome) => {
      logLine(outcome, log);
      return send(res, 200, {
        filter: rules.filter, source: 'rules', unparsed: rules.unparsed,
        notes: rules.notes.slice(), note: note || null, rules,
      });
    };

    if (!env('SUPABASE_URL') || !env('SUPABASE_ANON_KEY')) return asRules(NOTE.unavailable, 'rules:no-supabase');

    // 1. Who is this? (signature + session check by Supabase Auth)
    let u;
    try { u = await supa('/auth/v1/user', token, 'GET'); }
    catch (e) { log.push('auth:error'); return asRules(NOTE.unavailable, 'rules'); }
    log.push(`auth:${u.status}`);
    if (u.status === 401 || u.status === 403) { logLine('401', log); return send(res, 401, { error: ERR.auth }); }
    if (u.status !== 200 || !isObj(u.body) || typeof u.body.id !== 'string') return asRules(NOTE.unavailable, 'rules');
    if (u.body.is_anonymous === true) { logLine('401', log); return send(res, 401, { error: ERR.auth }); }

    // 2. Approved account? The LLM is only for trusted callers (free-tier budget).
    let t;
    try { t = await supa('/rest/v1/rpc/is_trusted', token, 'POST'); }
    catch (e) { log.push('trusted:error'); return asRules(NOTE.unavailable, 'rules'); }
    log.push(`trusted:${t.status}`);
    if (t.status !== 200) return asRules(NOTE.unavailable, 'rules');
    if (t.body !== true) return asRules(NOTE.untrusted, 'rules');

    // 3. Any provider configured? (checked before the quota so nothing is spent)
    const keys = {};
    for (const p of PROVIDERS) keys[p.name] = env(p.env);
    if (!PROVIDERS.some(p => keys[p.name])) return asRules(NOTE.noKey, 'rules:no-key');

    // 4. Server-side daily quota (per user + global). Anything but 200 true -> rules.
    let q;
    try { q = await supa('/rest/v1/rpc/ai_quota_take', token, 'POST'); }
    catch (e) { log.push('quota:error'); return asRules(NOTE.unavailable, 'rules'); }
    log.push(`quota:${q.status}`);
    if (q.status !== 200) return asRules(NOTE.unavailable, 'rules');
    if (q.body !== true) return asRules(NOTE.quota, 'rules');

    // 5. The model waterfall.
    const ai = await runChain(r, rules.filter, keys, started, log);
    if (!ai) return asRules(NOTE.failed, 'rules');
    logLine('ai', log);
    return send(res, 200, { filter: ai.filter, source: ai.source, unparsed: ai.ignored, notes: notes0, note: null, rules });
  } catch (e) {
    logLine('500', log);
    if (!res.headersSent) return send(res, 500, { error: ERR.internal });
  }
}

module.exports = handler;
// Internals for scripts/test_screen_builder.js only (not routes).
module.exports._internal = { CONFIG, PROVIDERS, GROWTH_RULE, NOTE, ERR, systemPrompt, extractJSON, keepIgnored, checkBearer };
