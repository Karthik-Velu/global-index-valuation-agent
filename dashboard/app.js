// Global Index Valuation Agent — dashboard front-end (no build step).
// Reads the engine's JSON contract, surfaces insights, and writes feedback back.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = (p, opts) => fetch(p, opts).then(r => r.json());

let STATE = { data: null, rows: [], focus: 'Country', hasApi: false, sort: { key: 'opportunity_score', dir: -1 }, currency: 'USD', drawer: null, view: 'overview' };
// STATE.drawer = {kind: 'market'|'stock', key} names what the drawer shows (ADR-037).
// openDrawerKey survives as an alias for the market case, for older callers.
Object.defineProperty(STATE, 'openDrawerKey', {
  get: () => (STATE.drawer?.kind === 'market' ? STATE.drawer.key : null),
  set: v => { STATE.drawer = v ? { kind: 'market', key: v } : null; },
});

// Feedback persistence: writes to the engine API when present, and always mirrors
// to localStorage so pins/dismissals survive on the static (Vercel) deployment.
const LS_KEY = 'giva_feedback';
const localFb = () => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; } };
const setLocalFb = (t, s) => { const f = localFb(); f[t] = s; localStorage.setItem(LS_KEY, JSON.stringify(f)); };

// Rows under the current focus lens (kind). 'All' = everything.
const focusedRows = () => STATE.focus === 'All' ? STATE.rows : STATE.rows.filter(m => m.kind === STATE.focus);
const inFocus = key => { const m = STATE.rows.find(x => x.key === key); return STATE.focus === 'All' || (m && m.kind === STATE.focus); };

const REGION_COLORS = {
  'North America': '#60a5fa', 'Latin America': '#f59e0b', 'Europe': '#a78bfa',
  'Emerging Europe': '#f472b6', 'Africa/MEA': '#fb7185', 'Asia-Pacific': '#34d399',
  'Global': '#94a3b8',
};
const regColor = r => REGION_COLORS[r] || '#94a3b8';

// ---- formatting helpers ----
const fmt = (v, d = 1) => (v == null || isNaN(v)) ? '—' : Number(v).toFixed(d);
const pct = (v, d = 1) => (v == null || isNaN(v)) ? '—' : (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
// `null * 100` is 0 in JS, so an ungradeable hit rate used to render as a
// confident '0%'. Say we don't know instead.
const hitPct = v => (v == null || isNaN(v)) ? '—' : (v * 100).toFixed(0) + '%';
const scoreColor = s => s == null ? '#475569'
  : `hsl(${Math.round((s / 100) * 140)} 65% 55%)`; // red(0)->green(140)
const retColor = v => v == null ? '#94a3b8' : v >= 0 ? '#34d399' : '#f87171';

// ---- display-currency conversion (Phase D, ADR-023) ----
// Pure presentation: converts the investability panel's USD-native price/
// market_cap for display only. Every SCORE stays USD/dimensionless — nothing
// here ever touches value_score/growth_score/etc.
const convertUSD = v => {
  if (v == null || STATE.currency === 'USD') return v;
  const rate = STATE.data?.meta?.fx?.rates?.[STATE.currency];
  return rate ? v * rate : v;
};
// usdValue in, converted + formatted in STATE.currency out.
function money(usdValue) {
  const v = convertUSD(usdValue);
  if (v == null || isNaN(v)) return '—';
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: STATE.currency, maximumFractionDigits: v >= 1000 ? 0 : 2 }).format(v); }
  catch { return `${fmt(v, 2)} ${STATE.currency}`; }
}
function marketCap(usdValue) {
  const v = convertUSD(usdValue);
  if (v == null || isNaN(v)) return '—';
  const abs = Math.abs(v);
  const [div, suf] = abs >= 1e12 ? [1e12, 'T'] : abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : [1, ''];
  const scaled = v / div;
  try { return `${new Intl.NumberFormat(undefined, { style: 'currency', currency: STATE.currency, maximumFractionDigits: 1 }).format(scaled)}${suf}`; }
  catch { return `${fmt(scaled, 1)} ${STATE.currency}${suf}`; }
}

function scoreBar(s) {
  return `<span class="scorebar"><i style="width:${s ?? 0}%;background:${scoreColor(s)}"></i></span>
          <span class="ml-1 tabular-nums text-slate-300">${fmt(s, 0)}</span>`;
}

// ---- boot ----
async function load() {
  let d = null;
  // 1. Try the live engine API (local dev).
  try {
    const r = await fetch('/api/dashboard');
    if (r.ok) { d = await r.json(); STATE.hasApi = !d.error; }
  } catch { /* no API — static host */ }
  // 2. Fall back to the published static snapshot (Vercel).
  if (!d || d.error) {
    STATE.hasApi = false;
    try { d = await fetch('dashboard_data.json', { cache: 'no-store' }).then(r => r.json()); }
    catch (e) {
      $('#briefText').textContent = 'No data found. Run `python -m engine.cli refresh` to generate it.';
      // Modules waiting on data (screener, lists) must hear about the failure too,
      // or a deep link to #/screener waits forever.
      await announceData(false, null);
      return;
    }
  }
  STATE.data = d;
  STATE.rows = d.scoreboard;
  // Best-effort — Auth.init resolves false (never throws) when Supabase isn't
  // configured or the CDN script didn't load; the dashboard works either way.
  // Re-init is safe (load() re-runs on manual refresh): Auth.init() just
  // re-creates the client and re-checks the session.
  try { await Auth.init(d.meta?.supabase); } catch { /* auth UI just stays hidden */ }
  render();
  await announceData(true, d);
}
// Registered once (not inside load(), which re-runs on manual refresh) so
// repeated refreshes don't accumulate duplicate listeners. A token refresh fires
// this about hourly: it redraws only the header and the drawer's money/star parts,
// never the chart (which would lose zoom and leak the chart instance).
let lastAuthUid = null;
Auth.onChange(() => {
  const uid = Auth.currentUser()?.id || null;
  const userChanged = uid !== lastAuthUid;
  lastAuthUid = uid;
  renderAuthUI(); renderViewTabs(); refreshDrawerParts(); refreshAlertsBadge();
  SYMBOLS.map = new Map(); SYMBOLS.trustedLoaded = false;   // owner tickers follow the user
  if (userChanged) buildSymbolList();     // drop the previous user's suggestions from the DOM now
  // A different user (sign-in, sign-out) may not see the same chart: an owner-only price
  // series must not stay mounted after sign-out. A token refresh (same user) keeps it.
  if (userChanged && STATE.drawer?.kind === 'stock') mountChart(stockChartSpec(STATE.drawer.key, STATE.drawerRow));
  // Consume the saved route only when the router can apply it; startRouter() picks it up
  // otherwise (sign-in callbacks often fire before the router has started).
  if (!ROUTER.started) return;
  const saved = Auth.currentUser() ? Auth.consumeSavedRoute() : null;
  if (saved && saved !== location.hash) location.hash = saved;
});

// ---- module hook + router (ADR-037) ----
// The screener/charts/lists scripts load after this one. They learn about data via
// `dashboard:data` — dispatched after Auth.init, once the DOM (and so every module
// script) is in, and with ok:false when loading failed. load() re-runs on manual
// refresh, so modules must render idempotently.
const domReady = () => document.readyState !== 'loading' ? Promise.resolve()
  : new Promise(res => document.addEventListener('DOMContentLoaded', res, { once: true }));
const withTimeout = (p, ms) => Promise.race([p, new Promise(res => setTimeout(res, ms))]);

async function announceData(ok, data) {
  await domReady();
  // The screen registry (screen_fields.json) — modules validate against it. Capped so a
  // stalled fetch can't hold the event (or the router) hostage.
  if (typeof ScreenDSL !== 'undefined' && ScreenDSL.load) {
    try { await withTimeout(ScreenDSL.load().catch(() => null), 5000); } catch { /* registry optional */ }
  }
  renderViewTabs();
  SYMBOLS.map = new Map(); SYMBOLS.trustedLoaded = false;
  try { document.dispatchEvent(new CustomEvent('dashboard:data', { detail: { ok, data, hasApi: STATE.hasApi } })); }
  catch { /* a listener's problem */ }
  startRouter();
  refreshAlertsBadge();
}

// Routes: #/overview · #/screener[?s=<base64url filter>|?id=<saved screen id>] · #/lists ·
// #/alerts · #/reports[/<slug>[/model]][?m=<base64url model state>] · #/stock/<TICKER> ·
// #/market/<key>. Rules (design review, magic-link safety):
//  - the router does not touch location.hash until Auth.init has resolved (startRouter is
//    called from announceData, after it);
//  - a hash carrying access_token / refresh_token / error_code / error_description is
//    supabase-js's to consume: render Overview, never rewrite it;
//  - unknown routes render Overview WITHOUT rewriting the URL;
//  - the hash never carries free text and never triggers the AI screen builder.
const ROUTER = { started: false, base: 'overview' };
const VIEWS = ['overview', 'screener', 'reports', 'lists', 'alerts'];
const AUTH_HASH_RE = /(^|[#&?])(access_token|refresh_token|error_code|error_description)=/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROUTE_TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;
const ROUTE_KEY_RE = /^[A-Za-z0-9_.\-]{1,64}$/;
const REPORT_SLUG_RE = /^[a-z0-9-]{1,40}$/;    // reports.js checks it again before fetching
const MODEL_STATE_RE = /^[A-Za-z0-9_-]{1,4096}$/;   // ModelEngine.decodeState validates the content

function parseRoute(hash) {
  const h = String(hash || '');
  if (!h || h === '#' || h === '#/') return { view: 'overview' };
  if (AUTH_HASH_RE.test(h)) return { view: 'overview', auth: true };
  const m = h.match(/^#\/([a-z]+)(?:\/([^?]*))?(?:\?(.*))?$/);
  if (!m) return { view: 'overview', unknown: true };
  const [, name, arg, query] = m;
  if (name === 'stock' || name === 'market') {
    let a = '';
    try { a = decodeURIComponent(arg || ''); } catch { return { view: 'overview', unknown: true }; }
    if (name === 'stock') {
      a = a.toUpperCase();
      return ROUTE_TICKER_RE.test(a) ? { view: null, drawer: { kind: 'stock', key: a } } : { view: 'overview', unknown: true };
    }
    return ROUTE_KEY_RE.test(a) ? { view: null, drawer: { kind: 'market', key: a } } : { view: 'overview', unknown: true };
  }
  // #/reports/<slug>: anything that isn't a well-formed slug gets the section's "report not
  // found" (slug ''), never Overview — and the text is never shown or fetched.
  // #/reports/<slug>/model is the report's stress-test model full-width; ?m= carries the
  // model's state (opaque base64url: shape-checked here, decoded + validated by the engine).
  if (name === 'reports' && arg) {
    const parts = arg.split('/');
    let a = '';
    try { a = decodeURIComponent(parts[0]).toLowerCase(); } catch { a = ''; }   // slugs are lower-case
    const model = parts.length === 2 && parts[1] === 'model';
    if (parts.length > 2 || (parts.length === 2 && !model)) a = '';
    const params = { slug: REPORT_SLUG_RE.test(a) ? a : '' };
    if (model) params.view = 'model';
    const m = query ? new URLSearchParams(query).get('m') : null;
    if (m && MODEL_STATE_RE.test(m)) params.m = m;
    return { view: 'reports', params };
  }
  if (!VIEWS.includes(name) || arg) return { view: 'overview', unknown: true };
  const params = {};
  if (name === 'screener' && query) {
    const q = new URLSearchParams(query);
    const sv = q.get('s'), id = q.get('id');
    if (sv && sv.length <= 12000 && /^[A-Za-z0-9_-]+$/.test(sv)) params.s = sv;
    if (id && UUID_RE.test(id)) params.id = id;
  }
  return { view: name, params };
}

function startRouter() {
  if (ROUTER.started) { route(); return; }
  ROUTER.started = true;
  window.addEventListener('hashchange', route);
  route();
  const saved = Auth.currentUser() ? Auth.consumeSavedRoute() : null;
  if (saved && saved !== location.hash) location.hash = saved;
}

function route() {
  if (!ROUTER.started) return;
  const r = parseRoute(location.hash);
  if (r.drawer) {
    // A symbol route opens the drawer over whatever view is showing (Overview on a
    // fresh load), so closing it returns there.
    showView(ROUTER.base, null, { skipModule: STATE.view === ROUTER.base });
    if (r.drawer.kind === 'stock') openStockDrawer(r.drawer.key, { fromRoute: true });
    else openDrawer(r.drawer.key, { fromRoute: true });
    return;
  }
  if (STATE.drawer) closeDrawer({ keepHash: true });
  ROUTER.baseHash = r.unknown || r.auth ? '' : location.hash;
  showView(r.view, r.params || {});
}

function showView(view, params, { skipModule = false } = {}) {
  if (!VIEWS.includes(view)) view = 'overview';
  const changed = STATE.view !== view;
  STATE.view = view; ROUTER.base = view;
  VIEWS.forEach(v => { const el = document.getElementById(`view-${v}`); if (el) el.hidden = v !== view; });
  $$('.view-tabs [data-view]').forEach(a => {
    const on = a.dataset.view === view;
    a.classList.toggle('active', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  if (changed) window.scrollTo(0, 0);
  // Leaving Key reports drops its live chart and its print mode.
  if (view !== 'reports' && typeof Reports !== 'undefined' && Reports.unmount) { try { Reports.unmount(); } catch { /* module's problem */ } }
  if (skipModule) return;
  if (view === 'screener') {
    if (typeof Screener !== 'undefined' && Screener.show) { try { Screener.show(params || {}); } catch (e) { moduleMissing(view, true); } }
    else moduleMissing(view);
  } else if (view === 'reports') {
    // Public (static JSON, no sign-in). params.slug present = one report, else the list.
    const el = document.getElementById('view-reports');
    if (typeof Reports !== 'undefined' && Reports.renderList) {
      try {
        // onUrl: the model rewrote the route's ?m= in place (replaceState): closing a drawer
        // opened over the page must restore that hash, not the one first routed.
        const p = params && params.slug != null
          ? Reports.renderReport(el, params.slug, { view: params.view, m: params.m, onUrl: h => { ROUTER.baseHash = h; } })
          : Reports.renderList(el);
        if (p && p.catch) p.catch(() => moduleMissing(view, true));
      } catch (e) { moduleMissing(view, true); }
    } else moduleMissing(view);
  } else if (view === 'lists' || view === 'alerts') {
    // Tabs are hidden without sign-in configured; a typed/bookmarked link still gets a reason.
    if (!Auth.available()) {
      document.getElementById(`view-${view}`).innerHTML = `<div class="rounded-xl bg-panel border border-line p-6 text-sm text-slate-400">
        ${view === 'lists' ? 'Watchlists' : 'Alerts'} need sign-in, which isn't available on this deployment right now.
        The Overview and the markets Screener work without it.</div>`;
      return;
    }
    if (typeof Lists !== 'undefined' && Lists.show) { try { Lists.show(view); } catch (e) { moduleMissing(view, true); } }
    else moduleMissing(view);
  }
}

// A module script that failed to load (blocked, 404, offline) leaves its view empty;
// say so instead of showing a blank page.
function moduleMissing(view, crashed) {
  const el = document.getElementById(`view-${view}`);
  if (!el || el.childElementCount) return;
  const what = { screener: 'The screener', reports: 'Key reports', lists: 'Watchlists', alerts: 'Alerts' }[view] || 'This view';
  el.innerHTML = `<div class="rounded-xl bg-panel border border-line p-6 text-sm text-slate-400">
    ${what} ${crashed ? 'hit an error' : "couldn't load"} &mdash; try reloading the page. The Overview works without it.</div>`;
}

// Watchlists/Alerts need sign-in, which needs Supabase configured.
function renderViewTabs() {
  const on = Auth.available();
  $$('.view-tabs [data-view="lists"], .view-tabs [data-view="alerts"]').forEach(a => { a.hidden = !on; });
}

// Unseen-alert badge on the Alerts tab. Lists owns the count when it's loaded
// (Lists.refreshBadge may be async and may call setAlertsBadge itself).
async function refreshAlertsBadge() {
  if (!Auth.available() || !Auth.currentUser()) { setAlertsBadge(0); return; }
  try {
    if (typeof Lists !== 'undefined' && Lists.refreshBadge) {
      const n = await Lists.refreshBadge();
      if (typeof n === 'number') setAlertsBadge(n);
      return;
    }
    setAlertsBadge(typeof Lists !== 'undefined' && Lists.unseenCount ? await Lists.unseenCount() : await Auth.unseenCount());
  } catch { setAlertsBadge(0); }
}
function setAlertsBadge(n) {
  const b = document.getElementById('alr-badge');
  if (!b) return;
  n = Number(n) || 0;
  b.textContent = n > 99 ? '99+' : String(n);
  b.hidden = n <= 0;
  b.title = n > 0 ? `${n} unseen alert${n === 1 ? '' : 's'}` : '';
}

function render() {
  const d = STATE.data;
  $('#asof').textContent = `as of ${d.asof}`;
  const rb = $('#refreshBtn');
  if (!STATE.hasApi) { rb.textContent = '↻ weekly'; rb.title = 'Hosted snapshot — refreshed weekly by CI. Click for details.'; }
  $('#briefText').textContent = d.brief;
  $('#meta').textContent = `${d.meta.data_source} · growth: ${d.meta.growth_signal} · ${d.meta.note}`;
  renderTrackRecord(d.accuracy);
  renderPicks(d.top_picks);
  renderTuning(d.tuning);
  renderCurrencySelector();
  renderAuthUI();
  renderFocus(d.kinds || []);
  renderFilters();
  renderFocusedViews();
}

// Re-render everything that responds to the focus lens.
function renderFocusedViews() {
  let ins = STATE.data.insights.filter(it => inFocus(it.market_key));
  if (!ins.length) ins = STATE.data.insights;
  ins = ins.slice(0, STATE.focus === 'All' ? 8 : 6);
  renderInsights(ins);
  renderTopLists();
  renderScatter();
  renderHeatmap();
  renderTable();
}

// ---- display currency (Phase D, ADR-023) ----
function renderCurrencySelector() {
  const el = $('#currency');
  const rates = STATE.data.meta?.fx?.rates || {};
  const options = ['USD', ...Object.keys(rates).sort()];
  el.innerHTML = options.map(c => `<option value="${c}" ${c === STATE.currency ? 'selected' : ''}>${c}</option>`).join('');
  el.title = STATE.data.meta?.fx
    ? `Indicative reference rates as of ${STATE.data.meta.fx.asof} (Frankfurter/ECB) — display only, not a live execution rate.`
    : 'Display currency (USD only — no FX rates in this snapshot)';
  el.onchange = () => {
    STATE.currency = el.value;
    refreshDrawerParts();   // money fields only — the chart is left alone
  };
}

// ---- auth (Phase D, ADR-026) ----
// Inline magic-link form (admin.html's pattern) instead of prompt()/alert(): the
// panel lives outside #authBox, so this re-render (every auth event, incl. the
// hourly token refresh) never wipes a half-typed address or a "link sent" message.
function renderAuthUI() {
  const el = $('#authBox');
  if (!Auth.available()) { el.innerHTML = ''; showSignin(false); return; }
  const u = Auth.currentUser();
  el.innerHTML = u
    ? `<span class="text-xs text-slate-400 truncate max-w-[160px]" title="${esc(u.email)}">${esc(u.email)}</span>
       <button id="signOutBtn" class="ctrl">Sign out</button>`
    : `<button id="signInBtn" class="ctrl" aria-controls="signinPanel">Sign in</button>`;
  const inBtn = $('#signInBtn'), outBtn = $('#signOutBtn');
  if (inBtn) inBtn.onclick = () => showSignin($('#signinPanel').hidden);
  if (outBtn) outBtn.onclick = async () => { await Auth.signOut(); };
  if (u) { showSignin(false); return; }
  // A failed magic link (expired / already spent by a mail scanner) lands here with
  // error params; say so next to the form rather than bouncing back silently.
  const err = Auth.readAuthError();
  if (err) { setSigninMsg(err, true); showSignin(true, { focus: false }); }
}
function showSignin(on, { focus = true } = {}) {
  const panel = $('#signinPanel');
  if (!panel) return;
  // The panel sits top-right, exactly under the drawer and its scrim: close the drawer
  // first (e.g. "Sign in" from the star picker inside it) so the form is reachable.
  if (on && STATE.drawer) closeDrawer();
  panel.hidden = !on;
  if (on) {
    $('#signinForm').hidden = false;
    try { panel.scrollIntoView({ block: 'nearest' }); } catch { /* old browsers */ }
    if (focus) $('#signinEmail').focus();
  }
}
function setSigninMsg(text, isError) {
  const m = $('#signinMsg');
  m.textContent = text;
  m.className = `text-sm ${isError ? 'text-rich' : 'text-slate-400'}`;
}
$('#signinForm').onsubmit = async e => {
  e.preventDefault();
  const email = $('#signinEmail').value.trim();
  if (!email) { $('#signinEmail').focus(); return; }
  if (!Auth.available()) { setSigninMsg('Still starting up — try again in a moment.'); return; }
  const btn = $('#signinSend');
  btn.disabled = true;
  try {
    await Auth.signInWithEmail(email);
    const m = $('#signinMsg');
    m.className = 'text-sm text-slate-300';
    m.innerHTML = `Link sent to <b>${esc(email)}</b>. Open it on this device, and soon — each link works once, `
      + `and some mail providers use it up by scanning it. If it doesn't work, just request another.`;
    $('#signinForm').hidden = true;
  } catch (err) {
    setSigninMsg(err?.message ? `Sign-in failed: ${String(err.message).slice(0, 200)}` : 'Sign-in failed.', true);
  } finally { btn.disabled = false; }
};
$('#signinCancel').onclick = () => showSignin(false);

const KIND_LABEL = { Country: 'Countries', Sector: 'Sectors', Style: 'Styles', Region: 'Regions', Broad: 'Broad' };
function renderFocus(kinds) {
  const opts = ['All', ...kinds];
  $('#focus').innerHTML = opts.map(k => {
    const on = STATE.focus === k;
    return `<button data-k="${k}" class="px-3 py-1 rounded-lg text-xs border transition ${on
      ? 'bg-accent/25 border-accent/50 text-accent' : 'bg-panel border-line text-slate-400 hover:text-slate-200'}">
      ${KIND_LABEL[k] || k}</button>`;
  }).join('');
  $$('#focus button').forEach(b => b.onclick = () => { STATE.focus = b.dataset.k; renderFocus(kinds); renderFocusedViews(); });
}

function renderTuning(t) {
  const el = $('#tuning');
  if (!t || !t.tuned) { el.innerHTML = `<span class="text-slate-500">weights: defaults</span>`; return; }
  const w = t.opportunity_weights;
  el.innerHTML = `<span style="color:#34d399">⚙ auto-tuned</span> <span class="text-slate-500">v${(w.value*100|0)}/m${(w.momentum*100|0)}/r${(w.mean_reversion*100|0)} · ${t.evaluations_used} runs</span>`;
}

// "Track record" is a claim about SKILL, and a handful of evaluations cannot
// support one. On 2026-08-03 this widget read `IC -0.00 · hit 100% (3 runs)` —
// i.e. no measured skill sitting next to a perfect-looking hit rate that is
// purely an artefact of n=3. Rendering that under the words "track record" is
// the single most misleading thing on the page, and ARCHITECTURE.md §6 already
// gates launch on "a real backtest before any track record is presented as
// trustworthy".
//
// Below the floor we say plainly that it means nothing yet. The provisional
// numbers stay visible on hover rather than being hidden — concealing them
// would be its own kind of dishonesty, and the point is to stop the figure
// being read as evidence, not to stop it being seen.
//
// 12 is a floor for "worth displaying at all", NOT a significance test. A real
// gate needs a t-stat on the IC series; when the backtest carries enough
// history to compute one, this should become that instead.
const MIN_TRACK_EVALS = 12;

function renderTrackRecord(acc) {
  const el = $('#trackrecord');
  if (!acc || !acc.evaluations) {
    el.innerHTML = `<span class="text-slate-500">track record: building…</span>`;
    return;
  }
  const ic = acc.avg_rank_ic, hr = acc.avg_hit_rate, n = acc.evaluations;
  if (n < MIN_TRACK_EVALS) {
    el.innerHTML = `<span class="text-slate-500" title="Provisional and not evidence of skill: `
      + `rank-IC ${fmt(ic, 3)}, hit rate ${hitPct(hr)} over ${n} evaluation(s). `
      + `Too few periods to distinguish from chance — shown once there are ${MIN_TRACK_EVALS}.">`
      + `track record: <span class="text-warn">not yet meaningful</span> `
      + `— ${n}/${MIN_TRACK_EVALS} evaluations</span>`;
    return;
  }
  const good = ic > 0.05;
  el.innerHTML = `track record: <span class="font-semibold" style="color:${good ? '#34d399' : '#fbbf24'}">
    IC ${fmt(ic, 2)}</span> · hit ${hitPct(hr)} <span class="text-slate-500">(${n} runs)</span>`;
}

// ---- 0. top picks (engine/picks.py) ----
// The engine chooses these by rule and writes every reason line from the numbers;
// this only lays them out. Snapshots older than the feature carry no `top_picks`,
// so the block stays hidden rather than rendering empty.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STRAT_COLOR = { 'Quality on sale': '#60a5fa', 'Deep discount, fundamentals intact': '#34d399', 'Quality on sale, turning up': '#2dd4bf', 'Steady compounder on sale': '#a78bfa' };
// The owner's snapshot rows carry strategy ids (engine/strategies.py); picks carry labels.
const stratLabel = s => STATE.data?.top_picks?.strategies?.[s]?.label || s;
const stratBadges = labels => (labels || []).map(l =>
  `<span class="pill" style="background:${STRAT_COLOR[l] || '#94a3b8'}22;color:${STRAT_COLOR[l] || '#94a3b8'}">${esc(l)}</span>`).join(' ');

function pickCard(p, isMarket) {
  const head = isMarket
    ? `<div class="flex items-center gap-2 min-w-0"><span class="badge shrink-0" style="background:#60a5fa22;color:#60a5fa">${esc(p.symbol)}</span>
         <span class="text-[11px] text-slate-500 truncate">${esc(p.kind)} · ${esc(p.region)}</span></div>`
    : `<div class="flex items-center gap-2 min-w-0"><span class="badge shrink-0" style="background:#a78bfa22;color:#a78bfa">${esc(p.ticker)}</span>
         <span class="text-[11px] text-slate-500 truncate">${esc(p.kind)} · ${money(p.price)} · ${marketCap(p.market_cap)}</span></div>`;
  const why = [...(p.reasons || []).map(r => `<li class="ok">${esc(r)}</li>`),
               ...(p.cautions || []).map(c => `<li class="warn">${esc(c)}</li>`)].join('');
  return `<div class="pick-card" ${isMarket ? `data-mk="${esc(p.key)}"` : `data-tk="${esc(p.ticker)}"`}>
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">${head}
        <div class="text-[14px] font-medium text-slate-100 mt-1 leading-snug">${esc(p.name)}</div></div>
      <div class="text-right shrink-0" title="Opportunity score (0–100)">
        <div class="text-lg font-bold tabular-nums leading-none" style="color:${scoreColor(p.opportunity_score)}">${fmt(p.opportunity_score, 0)}</div>
        <div class="text-[10px] text-slate-500">score</div></div>
    </div>
    <ul class="pick-why">${why}</ul>
    ${p.strategies?.length ? `<div>${stratBadges(p.strategies)}</div>` : ''}
  </div>`;
}

// The long-run average is 5 years where that much price history is on file, else
// whatever is (stock prices start 2024-10-04) — so the label states the window.
const avgLabel = y => (y == null || y >= 4.75) ? 'vs 5y avg' : `vs ${fmt(y, 1)}y avg`;

function saleRow(p, isMarket) {
  const id = isMarket ? p.symbol : p.ticker;
  return `<div class="sale-row" ${isMarket ? `data-mk="${esc(p.key)}"` : `data-tk="${esc(p.ticker)}"`}>
    <div class="min-w-0 text-[13px] text-slate-100 truncate"><span class="text-slate-400 tabular-nums">${esc(id)}</span> ${esc(p.name)}</div>
    <div class="text-[13px] font-semibold tabular-nums text-right" style="color:#f87171">${pct(p.discount_long ?? p.discount_52w, 0)}</div>
    <div class="min-w-0 text-[11px] text-slate-500 truncate">${esc(p.reasons?.find(r => r.startsWith('Growth record') || r.startsWith('Business growing')) || p.reasons?.[0] || '')}</div>
    <div class="text-[10px] text-slate-500 text-right">${avgLabel(p.long_avg_years)}</div>
  </div>`;
}

function renderPicks(tp) {
  const sec = $('#picks');
  if (!tp || !(tp.markets?.length || tp.stocks?.length)) { sec.classList.add('hidden'); return; }
  sec.classList.remove('hidden');
  $('#picksEvidence').textContent = tp.evidence || '';
  const grid = (cards, isMarket) => `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">${cards.map(c => pickCard(c, isMarket)).join('')}</div>`;
  const onSale = tp.on_sale || {};
  const rule = tp.strategies?.on_sale?.rule || '';
  const saleList = (rows, isMarket, title) => rows?.length
    ? `<div class="min-w-0"><div class="pick-sub">${title}</div>${rows.map(r => saleRow(r, isMarket)).join('')}</div>` : '';
  const sale = saleList(onSale.markets, true, 'Markets &amp; funds') + saleList(onSale.stocks, false, 'Stocks');
  const strategyDefs = Object.values(tp.strategies || {}).map(s =>
    `<li><span class="text-slate-300">${esc(s.label)}</span> — ${esc(s.rule)}</li>`).join('');
  const ex = tp.excluded || {};
  const exLine = Object.keys(ex).length
    ? `Left out of the stock picks for data reasons: ${ex.strong_with_data_issues ?? 0} otherwise-strong names with an open data-quality issue, `
      + `${ex.non_usd_reporters ?? 0} companies that report in a non-USD currency (their ratios aren't comparable yet), `
      + (ex.foreign_listings != null ? `${ex.foreign_listings} foreign listings (share counts not yet adjusted for ADR ratios), ` : '')
      + (ex.short_history ? `${ex.short_history} strong names with under 3 years of history on file, ` : '')
      + `and ${ex.implausible_valuation ?? 0} with an implausible valuation (e.g. P/E below 3).` : '';

  $('#picksBody').innerHTML = `
    ${tp.markets?.length ? `<div class="pick-sub">Markets &amp; funds</div>${grid(tp.markets, true)}` : ''}
    ${tp.stocks?.length ? `<div class="pick-sub">Stocks</div>${grid(tp.stocks, false)}` : ''}
    ${sale ? `<div class="border-t border-line pt-3">
      <div class="text-[13px] font-semibold text-slate-200">Quality on sale <span class="font-normal text-slate-500">— strong businesses trading well below their long-run (5-year) average price</span></div>
      <div class="text-[11px] text-slate-500 mb-2">${esc(rule)}</div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-x-6">${sale}</div></div>` : ''}
    <details class="mt-3 text-[11px] text-slate-500 leading-relaxed">
      <summary class="cursor-pointer text-slate-400 hover:text-slate-200">How these are chosen</summary>
      <p class="mt-1.5">${esc(tp.method)}</p>
      <ul class="mt-1.5 list-disc pl-5">${strategyDefs}</ul>
      ${exLine ? `<p class="mt-1.5">${esc(exLine)}</p>` : ''}
    </details>`;
  $$('#picks [data-mk]').forEach(el => el.onclick = () => openDrawer(el.dataset.mk));
  $$('#picks [data-tk]').forEach(el => el.onclick = () => openStockDrawer(el.dataset.tk));
}

// ---- 2. insight cards ----
const KIND = {
  garp: { label: 'CHEAP + GROWING', c: '#2dd4bf' }, growth: { label: 'GROWTH', c: '#a78bfa' },
  value: { label: 'VALUE', c: '#34d399' }, opportunity: { label: 'OPPORTUNITY', c: '#60a5fa' },
  avoid: { label: 'AVOID', c: '#fbbf24' }, expensive: { label: 'EXPENSIVE', c: '#f87171' },
};
function renderInsights(items) {
  $('#insights').innerHTML = items.map(it => {
    const k = KIND[it.kind] || { label: it.kind.toUpperCase(), c: '#94a3b8' };
    return `<div class="rounded-xl bg-panel2 border border-line p-3.5 flex flex-col gap-2" data-mk="${it.market_key}">
      <div class="flex items-center justify-between">
        <span class="badge" style="background:${k.c}22;color:${k.c}">${k.label}</span>
        <div class="flex gap-1">
          <button class="fb-btn" data-fb="pin" title="Pin — surface more like this">📌</button>
          <button class="fb-btn" data-fb="dismiss" title="Dismiss">✕</button>
        </div>
      </div>
      <div class="font-medium text-slate-100 text-[13.5px] leading-snug">${it.title}</div>
      <div class="text-xs text-slate-400 leading-relaxed">${it.detail}</div>
    </div>`;
  }).join('');
  $$('#insights [data-fb]').forEach(b => b.onclick = e => {
    e.stopPropagation();
    const card = b.closest('[data-mk]');
    sendFeedback('market', card.dataset.mk, b.dataset.fb);
    b.classList.add('active');
    if (b.dataset.fb === 'dismiss') card.style.opacity = .35;
  });
  // Restore persisted feedback (e.g. on the static host across reloads).
  const fb = localFb();
  $$('#insights [data-mk]').forEach(c => {
    const sig = fb[`market:${c.dataset.mk}`];
    if (sig === 'dismiss') c.style.opacity = .35;
    if (sig) { const b = c.querySelector(`[data-fb="${sig === 'dismiss' ? 'dismiss' : 'pin'}"]`); if (b) b.classList.add('active'); }
    c.onclick = () => openDrawer(c.dataset.mk);
  });
}

// ---- 3. top lists ----
function miniRow(m, metricLabel, metricVal, metricColor) {
  return `<div class="flex items-center justify-between gap-2 py-1 px-2 rounded-lg hover:bg-panel2 cursor-pointer" data-mk="${m.key}">
    <div class="min-w-0">
      <div class="text-[13px] text-slate-100 truncate">${m.name}</div>
      <div class="text-[11px] text-slate-500">P/E ${fmt(m.pe)} · ${m.region}</div>
    </div>
    <div class="text-right shrink-0">
      <div class="text-[13px] font-semibold tabular-nums" style="color:${metricColor}">${metricVal}</div>
      <div class="text-[10px] text-slate-500">${metricLabel}</div>
    </div></div>`;
}
function renderTopLists() {
  const rows = focusedRows();
  const val = [...rows].sort((a, b) => (b.value_score ?? 0) - (a.value_score ?? 0)).slice(0, 5);
  const growth = [...rows].sort((a, b) => (b.growth_score ?? -1) - (a.growth_score ?? -1)).slice(0, 5);
  // GARP first; if too few flagged, fall back to best opportunity not overvalued
  let garp = [...rows].filter(m => m.garp).sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0));
  if (garp.length < 3) garp = [...rows].filter(m => !m.overvalued).sort((a, b) => (b.opportunity_score ?? 0) - (a.opportunity_score ?? 0));
  garp = garp.slice(0, 5);
  $('#topValue').innerHTML = val.map(m => miniRow(m, 'value', fmt(m.value_score, 0), scoreColor(m.value_score))).join('');
  $('#topGrowth').innerHTML = growth.map(m => miniRow(m, gLabel(m), fmt(m.growth_score, 0), scoreColor(m.growth_score))).join('');
  $('#topOpp').innerHTML = garp.map(m => miniRow(m, 'opp', fmt(m.opportunity_score, 0), scoreColor(m.opportunity_score))).join('');
  $$('#topValue [data-mk],#topGrowth [data-mk],#topOpp [data-mk]').forEach(r => r.onclick = () => openDrawer(r.dataset.mk));
}
const gLabel = m => (m.fwd_growth != null || m.earnings_growth != null)
  ? `${pct(m.fwd_growth ?? m.earnings_growth, 0)} g` : 'growth';

// ---- 3b. scatter: value vs momentum ----
function renderScatter() {
  const rows = focusedRows();
  const W = 720, H = 380, pad = 38;
  const x = v => pad + (v / 100) * (W - pad * 2);
  const y = v => H - pad - (v / 100) * (H - pad * 2);
  const dots = rows.map(m => {
    const cx = x(m.value_score ?? 0), cy = y(m.growth_score ?? 0);
    let fill = regColor(m.region), stroke = 'none', sw = 2;
    if (m.value_trap) stroke = '#fbbf24';
    if (m.overvalued) fill = '#f87171';
    if (m.garp) { stroke = '#2dd4bf'; sw = 3; }      // cheap + growing = highlighted
    const r = m.garp ? 8 : 6;
    return `<circle class="dot" cx="${cx}" cy="${cy}" r="${r}" fill="${fill}" fill-opacity="0.82"
      stroke="${stroke}" stroke-width="${sw}" data-mk="${m.key}"
      data-tip="${m.name} · P/E ${fmt(m.pe)} · value ${fmt(m.value_score, 0)} / growth ${fmt(m.growth_score, 0)} (${pct(m.fwd_growth ?? m.earnings_growth, 0)})"></circle>`;
  }).join('');
  const grid = `
    <line x1="${x(50)}" y1="${pad}" x2="${x(50)}" y2="${H - pad}" stroke="#243049" stroke-dasharray="4 4"/>
    <line x1="${pad}" y1="${y(50)}" x2="${W - pad}" y2="${y(50)}" stroke="#243049" stroke-dasharray="4 4"/>
    <text x="${W - pad}" y="${y(95)}" text-anchor="end" fill="#2dd4bf">cheap &amp; growing ★</text>
    <text x="${pad + 4}" y="${y(95)}" fill="#a78bfa">pricey, high growth</text>
    <text x="${pad + 4}" y="${y(4)}" fill="#64748b">pricey, low growth</text>
    <text x="${W - pad}" y="${y(4)}" text-anchor="end" fill="#fbbf24">cheap, low growth (trap watch)</text>
    <text x="${W / 2}" y="${H - 6}" text-anchor="middle">← richer    VALUE SCORE    cheaper →</text>
    <text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle">← low   FUNDAMENTAL GROWTH   high →</text>`;
  $('#scatter').innerHTML =
    `<svg viewBox="0 0 ${W} ${H}" class="w-full" style="max-height:380px">${grid}${dots}</svg>
     <div id="tip" class="fixed hidden px-2 py-1 rounded bg-black/90 text-xs text-white pointer-events-none z-50"></div>`;
  const tip = $('#tip');
  $$('#scatter .dot').forEach(c => {
    c.onmousemove = e => { tip.textContent = c.dataset.tip; tip.style.left = (e.clientX + 12) + 'px'; tip.style.top = (e.clientY + 12) + 'px'; tip.classList.remove('hidden'); };
    c.onmouseleave = () => tip.classList.add('hidden');
    c.onclick = () => openDrawer(c.dataset.mk);
  });
}

// ---- 3c. regional valuation heatmap ----
function renderHeatmap() {
  const rows = focusedRows();
  const byReg = {};
  rows.forEach(m => { (byReg[m.region] ??= []).push(m); });
  const cells = Object.entries(byReg).map(([reg, ms]) => {
    const vs = ms.map(m => m.value_score).filter(v => v != null);
    const avg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
    const opp = ms.map(m => m.opportunity_score).filter(v => v != null);
    const avgOpp = opp.length ? opp.reduce((a, b) => a + b, 0) / opp.length : null;
    return { reg, avg, avgOpp, n: ms.length };
  }).sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
  $('#heatmap').innerHTML = cells.map(c => `
    <div class="rounded-lg p-3 border border-line cursor-pointer" data-reg="${c.reg}"
         style="background:${scoreColor(c.avg)}1f">
      <div class="text-[12px] text-slate-200 font-medium truncate">${c.reg}</div>
      <div class="text-2xl font-bold tabular-nums" style="color:${scoreColor(c.avg)}">${fmt(c.avg, 0)}</div>
      <div class="text-[10px] text-slate-500">${c.n} markets · opp ${fmt(c.avgOpp, 0)}</div>
    </div>`).join('');
  $$('#heatmap [data-reg]').forEach(el => el.onclick = () => {
    $('#fRegion').value = el.dataset.reg; renderTable();
    document.getElementById('table').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ---- 4. filters + table ----
const COLS = [
  ['name', 'Market', m => `<div class="text-slate-100">${m.name}</div><div class="text-[11px] text-slate-500">${m.country}</div>`],
  ['pe', 'P/E', m => fmt(m.pe)],
  ['pb', 'P/B', m => fmt(m.pb)],
  ['dividend_yield', 'Div', m => pct(m.dividend_yield)],
  ['fwd_growth', 'Fund. growth', m => `<span style="color:${retColor(m.fwd_growth ?? m.earnings_growth)}">${pct(m.fwd_growth ?? m.earnings_growth, 0)}</span>`],
  ['value_score', 'Value', m => scoreBar(m.value_score)],
  ['growth_score', 'Growth', m => scoreBar(m.growth_score)],
  ['opportunity_score', 'Opportunity', m => scoreBar(m.opportunity_score)],
  ['flags', 'Flags', m => flagPills(m)],
];
function flagPills(m) {
  let s = '';
  if (m.garp) s += `<span class="pill" style="background:#2dd4bf22;color:#2dd4bf">GARP</span> `;
  if (m.high_growth && !m.garp) s += `<span class="pill" style="background:#a78bfa22;color:#a78bfa">growth</span> `;
  if (m.on_sale) s += `<span class="pill" style="background:#60a5fa22;color:#60a5fa" title="Fundamentally strong and ≥10% below its 5-year average price">on sale</span> `;
  if (m.value_trap) s += `<span class="pill" style="background:#fbbf2422;color:#fbbf24">trap</span> `;
  if (m.overvalued) s += `<span class="pill" style="background:#f8717122;color:#f87171">rich</span> `;
  if (!s && m.value_band === 'Cheap') s += `<span class="pill" style="background:#34d39922;color:#34d399">cheap</span>`;
  return s || '—';
}
function renderFilters() {
  const regions = [...new Set(STATE.rows.map(m => m.region))].sort();
  const devs = [...new Set(STATE.rows.map(m => m.development))].sort();
  // Rebuilding the options wipes the selection. render() re-runs on manual
  // refresh, so without this a filter the user set silently un-sets itself.
  const keepReg = $('#fRegion').value, keepDev = $('#fDev').value;
  $('#fRegion').innerHTML = `<option value="">All regions</option>` + regions.map(r => `<option>${r}</option>`).join('');
  $('#fDev').innerHTML = `<option value="">All markets</option>` + devs.map(r => `<option>${r}</option>`).join('');
  if (regions.includes(keepReg)) $('#fRegion').value = keepReg;
  if (devs.includes(keepDev)) $('#fDev').value = keepDev;
  // `input` for the text box (filter as you type); `change` for the dropdowns
  // and the checkbox, because that is the event those controls are guaranteed
  // to fire. WebKit does not fire `input` on a <select>, so binding the whole
  // set to `oninput` left every dropdown on this page dead in Safari and in
  // every iOS browser (all WebKit) while working perfectly in desktop Chrome.
  // That asymmetry is why the region filter survived an earlier round of
  // "fixing": the empty-state copy below got rewritten, the wiring never did.
  $('#search').oninput = renderTable;
  ['#fRegion', '#fDev', '#fBand', '#fHideRich'].forEach(s => $(s).onchange = renderTable);
}
function applyFilters() {
  const rows = focusedRows();
  const q = $('#search').value.toLowerCase(), reg = $('#fRegion').value, dev = $('#fDev').value,
    band = $('#fBand').value, hideRich = $('#fHideRich').checked;
  return rows.filter(m =>
    (!q || m.name.toLowerCase().includes(q) || (m.country || '').toLowerCase().includes(q)) &&
    (!reg || m.region === reg) && (!dev || m.development === dev) &&
    (!band || m.value_band === band) && (!hideRich || !m.overvalued));
}
// Why did this filter combination return nothing? A blank table reads as "the app
// is broken" — sometimes it's a real, explainable coverage boundary. The known
// one: focus=Sectors + region=Asia-Pacific, because no liquid US-listed
// Asia-Pacific SECTOR ETF exists (engine/universe.py documents the search).
// Sectors DO now cover Europe (EUFN), so this is a per-region fact read off the
// data, never a blanket "sectors are US-only" claim. Name the cause, offer a way
// out — and do not let it excuse a filter that simply failed to fire.
function emptyStateHTML() {
  const reg = $('#fRegion').value, dev = $('#fDev').value, band = $('#fBand').value;
  const q = $('#search').value.trim(), hideRich = $('#fHideRich').checked;
  const focus = STATE.focus;
  let why = 'No markets match this combination of filters.';

  if (reg && focus !== 'All') {
    // Which regions DO carry this kind? Derived from the data, not hardcoded, so
    // it stays true as the universe grows.
    const regionsForKind = [...new Set(STATE.rows.filter(m => m.kind === focus).map(m => m.region))].sort();
    if (!regionsForKind.includes(reg)) {
      why = `No <b>${KIND_LABEL[focus] || focus}</b> are tracked for <b>${reg}</b>.
        ${KIND_LABEL[focus] || focus} coverage currently spans: ${regionsForKind.map(r => `<b>${r}</b>`).join(', ')}.
        <span class="block mt-1 text-slate-500">Each ${focus.toLowerCase()} is tracked via a US-listed ETF proxy, and the
        liquid ones are US- or globally-scoped — so a region-specific ${focus.toLowerCase()} view
        needs regional ${focus.toLowerCase()} funds added to the universe (a known gap, not a bug).</span>`;
    }
  } else if (q) {
    why = `Nothing matches “<b>${q}</b>” under the <b>${KIND_LABEL[focus] || focus}</b> lens.`;
  } else if (band || hideRich || dev) {
    why = `No <b>${KIND_LABEL[focus] || focus}</b> match these valuation filters right now.`;
  }
  return `<div class="text-center text-xs text-slate-400 leading-relaxed max-w-xl mx-auto">
    <div class="text-2xl mb-1 opacity-40">⌀</div>
    <div>${why}</div>
    <button id="clearFilters" class="ctrl mt-3">Clear filters</button></div>`;
}

function renderTable() {
  $('#thead').innerHTML = COLS.map(([k, label]) => {
    const arrow = STATE.sort.key === k ? (STATE.sort.dir < 0 ? ' ↓' : ' ↑') : '';
    return `<th data-k="${k}">${label}${arrow}</th>`;
  }).join('');
  $$('#thead th').forEach(th => th.onclick = () => {
    const k = th.dataset.k; if (k === 'flags') return;
    STATE.sort = { key: k, dir: STATE.sort.key === k ? -STATE.sort.dir : -1 };
    renderTable();
  });
  let rows = applyFilters();
  const { key, dir } = STATE.sort;
  rows.sort((a, b) => {
    if (key === 'name') return dir * a.name.localeCompare(b.name);
    return dir * (((a[key] ?? -1) - (b[key] ?? -1)));
  });
  $('#rowcount').textContent = `${rows.length} of ${focusedRows().length} markets`;
  $('#tbody').innerHTML = rows.length
    ? rows.map(m => `<tr data-mk="${m.key}">${COLS.map(([k, , f]) => `<td>${f(m)}</td>`).join('')}</tr>`).join('')
    : `<tr><td colspan="${COLS.length}" class="py-6">${emptyStateHTML()}</td></tr>`;
  $$('#tbody tr[data-mk]').forEach(tr => tr.onclick = () => openDrawer(tr.dataset.mk));
  const clr = $('#clearFilters');
  if (clr) clr.onclick = () => {
    $('#search').value = ''; $('#fRegion').value = ''; $('#fDev').value = '';
    $('#fBand').value = ''; $('#fHideRich').checked = false;
    renderTable();
  };
}

// ---- bottom-up: stocks within this market (Phase C) ----
// "Investability" line (Phase D, ADR-024) — the practical "can I actually buy
// this, and what does it cost" complement to the score: price/market cap
// converted to the selected display currency (money()/marketCap() convert
// from the USD-native value the engine computed), plus how to buy it.
function investability(s) {
  if (s.price == null && s.market_cap == null) return '';
  return `<div class="text-[10px] text-slate-500 mt-0.5">
    ${money(s.price)} · mkt cap ${marketCap(s.market_cap)}
    <span class="text-slate-600">· US-listed (${s.currency || 'USD'} native)</span></div>`;
}
function stockRow(s) {
  return `<div class="stock-link flex items-center justify-between gap-2 py-1.5 border-b border-line/50" data-tk="${esc(s.ticker)}" title="Open ${esc(s.ticker)}">
    <div class="min-w-0">
      <div class="text-[13px] text-slate-100">${esc(s.ticker)}${s.garp ? ' <span class="pill" style="background:#2dd4bf22;color:#2dd4bf">GARP</span>' : ''}</div>
      <div class="text-[10px] text-slate-500 truncate">${esc(s.name || '')}${s.sector ? ' · ' + esc(s.sector) : ''}</div>
      ${investability(s)}
    </div>
    <div class="text-right shrink-0">
      <div class="text-[13px] font-semibold tabular-nums" style="color:${scoreColor(s.opportunity_score)}">${fmt(s.opportunity_score, 0)}</div>
      <div class="text-[10px] text-slate-500">P/E ${fmt(s.pe)}</div>
    </div></div>`;
}
function stockBreakdownBlock(key) {
  const rows = STATE.data.stock_breakdown && STATE.data.stock_breakdown[key];
  const head = `<div class="text-[11px] uppercase tracking-wider text-slate-500 mt-3 mb-1">Top stocks within this market (bottom-up)</div>`;
  // An absent breakdown used to render as nothing at all — a silent blank for
  // 61 of 132 markets. Say WHY: it's a structural coverage boundary (our stock
  // universe is SEC/EDGAR-derived), not a glitch or a still-loading state.
  if (!rows || !rows.length) {
    const why = STATE.data.meta?.stock_coverage?.why
      || 'Bottom-up stock rows come from SEC EDGAR filings, so only markets with US-listed constituents have them.';
    return `${head}<div class="text-[11px] text-slate-500 leading-relaxed bg-panel2 border border-line rounded-lg p-2.5">
      No stock-level breakdown for this market. ${why}</div>`;
  }
  return `${head}${rows.map(stockRow).join('')}`;
}

// ---- how to invest (ADR-027) ----
// Answers "I like this call — now what?". Issuer links are ROOT domains only and
// may be absent (engine/investing.py never guesses an issuer); the access route
// names the LRS mechanism, never a broker.
function investBlock(m) {
  const access = STATE.data.meta?.access_route;
  const issuer = m.issuer;
  // Three states, not two: linked issuer, issuer named but URL unverified (we
  // refuse to ship a link we haven't checked), and no confirmed issuer at all.
  const issuerLine = !issuer
    ? `<span class="text-slate-500">issuer not attributed</span>`
    : issuer.url
      ? `<a href="${issuer.url}" target="_blank" rel="noopener noreferrer"
           class="text-accent hover:underline">${issuer.name} ↗</a>`
      : `<span class="text-slate-300" title="Issuer confirmed; official site not linked because the URL isn't verified.">${issuer.name}</span>`;
  const points = access?.points?.length
    ? `<ul class="list-disc pl-4 mt-1.5 space-y-0.5 text-slate-400">${access.points.map(p => `<li>${p}</li>`).join('')}</ul>`
    : '';
  return `
    <div class="text-[11px] uppercase tracking-wider text-slate-500 mt-4 mb-1">How to invest</div>
    <div class="rounded-lg bg-panel2 border border-line p-3 text-xs leading-relaxed">
      <div class="flex items-center justify-between gap-2 mb-2">
        <div><span class="text-slate-400">Ticker</span>
             <span class="ml-1.5 font-semibold text-slate-100 tabular-nums">${m.symbol}</span>
             <span class="ml-1.5 text-slate-500">· US-listed ETF</span></div>
        <div>${issuerLine}</div>
      </div>
      ${access ? `<div class="text-slate-300 font-medium">${access.label}</div>
        <div class="text-slate-400 mt-0.5">${access.summary}</div>${points}
        <div class="text-slate-500 mt-2 pt-2 border-t border-line/60 italic">${access.note}</div>` : ''}
    </div>`;
}

// A market's one-line tag can come from the LLM or from a deterministic
// fallback, and the two read identically. Mark the fallback so a rule-derived
// label is never mistaken for a model's judgement (audit item, 2026-07-22).
// Only the fallback is marked — labelling the normal case would be noise.
function tagProvenance(m) {
  if (m.tag_source !== 'deterministic' || !m.tag) return '';
  return ` <span class="not-italic text-[10px] text-slate-500 align-middle"
    title="Rule-derived label, not model output — no LLM tag was available for this market on this run.">·&nbsp;rule-based</span>`;
}

// ---- drill-down drawer ----
// One drawer, two kinds (STATE.drawer = {kind: 'market'|'stock', key}). It is built in
// four parts — head (name, star), top (tag, score tiles), chart, body (numbers, money) —
// so an auth event or a currency change can redraw head/top/body WITHOUT touching the
// chart: rebuilding it would lose zoom and leak the chart instance (ADR-037).
let chartDispose = null;
let drawerSeq = 0;            // bumps on every open; a late async result for an older drawer is dropped
const drawerPart = name => $(`#drawer [data-drw="${name}"]`);

function disposeChart() {
  const d = chartDispose;
  chartDispose = null;
  if (typeof d === 'function') { try { d(); } catch { /* chart already gone */ } }
}
// Charts.mount(el, spec) -> dispose(), when charts.js loaded. Without it the block stays
// hidden, so the drawer reads exactly as it did before charts existed.
function mountChart(spec) {
  disposeChart();
  const el = drawerPart('chart');
  if (!el) return;
  el.innerHTML = '';
  if (typeof Charts === 'undefined' || !Charts.mount) { el.hidden = true; return; }
  el.hidden = false;
  try {
    const d = Charts.mount(el, spec);
    chartDispose = typeof d === 'function' ? d : null;
  } catch {
    el.innerHTML = '<div class="text-xs text-slate-500 py-6 text-center">chart unavailable</div>';
  }
}

function drawerShell() {
  $('#drawer').innerHTML = `
    <div data-drw="head"></div>
    <div data-drw="report"></div>
    <div data-drw="top"></div>
    <div data-drw="chart" class="chr-slot mb-4" hidden></div>
    <div data-drw="body" class="text-sm"></div>`;
}
function showDrawer() {
  $('#drawer').classList.remove('translate-x-full');
  $('#scrim').classList.remove('hidden');
}

// The one star control (Lists.starHTML: list picker; markets' built-in "Starred" list
// is user_watchlist). Until lists.js is in, markets keep the old single star.
function starControl(kind, key) {
  if (typeof Lists !== 'undefined' && Lists.starHTML) {
    try { return Lists.starHTML(kind, key) || ''; } catch { return ''; }
  }
  return kind === 'market' ? watchStarBtn(key) : '';
}
function bindStar(kind, key) {
  if (typeof Lists !== 'undefined' && Lists.starHTML) {
    if (Lists.bindStars) { try { Lists.bindStars(drawerPart('head')); } catch { /* lists' problem */ } }
    return;
  }
  const b = $('#watchStarBtn');
  if (!b || kind !== 'market') return;
  b.onclick = async () => {
    if (!Auth.available()) return;
    if (!Auth.currentUser()) { showSignin(true); return; }
    try { await Auth.toggleWatch(key); refreshDrawerParts(); }
    catch (e) { b.title = `Watchlist update failed: ${e.message || e}`; b.style.color = '#f87171'; }
  };
}
function watchStarBtn(key) {
  const signedIn = Auth.available() && Auth.currentUser();
  const on = signedIn && Auth.isWatched(key);
  const title = Auth.available()
    ? (signedIn ? (on ? 'Remove from watchlist' : 'Add to watchlist') : 'Sign in to save a personal watchlist')
    : 'Watchlist needs Supabase configured (see .env.example)';
  return `<button id="watchStarBtn" class="text-xl leading-none ${signedIn ? '' : 'opacity-40 cursor-not-allowed'}"
    style="color:${on ? '#fbbf24' : '#64748b'}" title="${title}">${on ? '★' : '☆'}</button>`;
}
const drawerRow = (l, v) => `<div class="flex justify-between gap-3 py-1.5 border-b border-line/50"><span class="text-slate-400">${l}</span><span class="text-slate-100 tabular-nums text-right">${v}</span></div>`;
const drawerSub = t => `<div class="text-[11px] uppercase tracking-wider text-slate-500 mt-3 mb-1">${t}</div>`;
const closeBtn = () => `<button id="closeDrawer" class="text-slate-400 hover:text-white text-xl leading-none" title="Close (Esc)" aria-label="Close">×</button>`;

// -- market drawer --
function marketHead(m) {
  return `
    <div class="flex items-start justify-between mb-3">
      <div class="min-w-0"><div class="text-lg font-semibold text-white">${m.name}</div>
        <div class="text-xs text-slate-500">${m.kind} · ${m.country} · ${m.region} · ${m.development} · proxy ${m.symbol}</div></div>
      <div class="flex items-center gap-2 shrink-0">
        ${starControl('market', m.key)}
        ${closeBtn()}
      </div>
    </div>`;
}
function marketTop(m) {
  return `
    <div class="text-[13px] text-slate-300 italic mb-3">${m.tag || ''}${tagProvenance(m)}</div>
    <div class="grid grid-cols-3 gap-2 mb-4">
      ${scoreTile('Value', m.value_score)}${scoreTile('Growth', m.growth_score)}${scoreTile('Opportunity', m.opportunity_score)}
    </div>`;
}
function marketBody(m) {
  const row = drawerRow;
  return `
      <div class="text-[11px] uppercase tracking-wider text-slate-500 mt-1 mb-1">Valuation</div>
      ${row('P/E', fmt(m.pe))}${row('P/B', fmt(m.pb))}${row('P/S', fmt(m.ps))}${row('P/CF', fmt(m.pcf))}
      ${row('Dividend yield', pct(m.dividend_yield))}${row('Earnings yield', pct(m.earnings_yield))}
      <div class="text-[11px] uppercase tracking-wider text-slate-500 mt-3 mb-1">Fundamental growth (top holdings)</div>
      ${row('Revenue growth (YoY)', pct(m.rev_growth))}
      ${row('Earnings growth (YoY)', pct(m.earnings_growth))}
      ${row('Forward growth (analyst +1y)', pct(m.fwd_growth))}
      ${row('Holdings data coverage', pct(m.growth_cov, 0))}
      <div class="text-[11px] uppercase tracking-wider text-slate-500 mt-3 mb-1">Price (context / momentum)</div>
      ${row('3m / 6m / 12m', pct(m.ret_3m) + ' / ' + pct(m.ret_6m) + ' / ' + pct(m.ret_12m))}
      ${row('vs 200d MA', pct(m.ma200_ratio))}${row(m.long_avg_years != null && m.long_avg_years < 4.75 ? `vs ${fmt(m.long_avg_years, 1)}-yr average` : 'vs 5-year average', pct(m.discount_long ?? m.discount_52w))}${row('52w range pos', fmt((m.pct_52w_range ?? 0) * 100, 0) + '%')}
      ${row('Flags', flagPills(m))}
      ${stockBreakdownBlock(m.key)}
      ${investBlock(m)}
    <div class="mt-4">
      <div class="text-xs text-slate-400 mb-1.5">Does this call look right to you?</div>
      <div class="flex gap-2">
        <button class="fb-btn flex-1" data-fb="up">👍 Good call</button>
        <button class="fb-btn flex-1" data-fb="pin">📌 Watch</button>
        <button class="fb-btn flex-1" data-fb="down">👎 Off</button>
      </div>
    </div>`;
}
function fillMarketDrawer(m) {
  drawerPart('head').innerHTML = marketHead(m);
  drawerPart('top').innerHTML = marketTop(m);
  drawerPart('body').innerHTML = marketBody(m);
  $('#closeDrawer').onclick = () => closeDrawer();
  bindStar('market', m.key);
  $$('#drawer [data-drw="body"] [data-fb]').forEach(b => b.onclick = () => { sendFeedback('market', m.key, b.dataset.fb); b.classList.add('active'); });
  $$('#drawer [data-drw="body"] [data-tk]').forEach(r => r.onclick = () => {
    STATE.drawerBack = { kind: 'market', key: m.key, name: m.name };
    openStockDrawer(r.dataset.tk, { keepBack: true });
  });
}
function openDrawer(key, { fromRoute = false } = {}) {
  const m = STATE.rows.find(x => x.key === key); if (!m) return;
  drawerSeq++;
  STATE.drawer = { kind: 'market', key };
  STATE.drawerBack = null;
  STATE.drawerFromRoute = fromRoute;
  disposeChart();
  drawerShell();
  fillMarketDrawer(m);
  showDrawer();
  // Markets chart via the TradingView widget on the ETF proxy (charts.js decides).
  mountChart({ kind: 'market', key: m.key, symbol: m.symbol });
}

// -- stock drawer --
// Resolution order: the trusted snapshot (owner only, RLS) when it's loaded, else the
// public rows already in dashboard_data.json (top picks, on-sale list, per-market
// breakdowns) — public fields only, nothing new is exposed.
function publicStockRow(t) {
  const d = STATE.data || {};
  const tp = d.top_picks || {};
  const parts = [], markets = [];
  for (const [mk, rows] of Object.entries(d.stock_breakdown || {})) {
    const r = (rows || []).find(x => String(x.ticker).toUpperCase() === t);
    if (r) { parts.push(r); markets.push(mk); }
  }
  for (const r of [...(tp.on_sale?.stocks || []), ...(tp.stocks || [])]) {
    if (String(r.ticker).toUpperCase() === t) parts.push(r);
  }
  if (!parts.length) return null;
  const row = Object.assign({}, ...parts);
  row.sector = row.sector || row.kind;   // picks carry the sector as `kind`
  row._markets = markets;
  return row;
}
async function trustedStockRow(t) {
  if (!Auth.available() || !Auth.currentUser()) return null;
  try { const snap = await Auth.stockSnapshot(); return snap?.byTicker?.get(t) || null; }
  catch { return null; }
}
function resolvedStock(t, snapRow) {
  const pub = publicStockRow(t);
  if (!snapRow) return pub;
  // Snapshot numbers win; the public row only adds the picks' reasons and market links.
  return { ...(pub || {}), ...snapRow, _markets: pub?._markets || [], _trusted: true,
    reasons: pub?.reasons, cautions: pub?.cautions };
}

// Why a snapshot row is hidden from screens (picks.exclusion_reasons codes) — the
// screener's wording (screenbox.js REASONS).
const DATA_FLAG_TEXT = { foreign_listing: 'foreign listing', non_usd_reporter: 'non-USD reporter', implausible_pe: 'implausible P/E',
  implausible_ps: 'implausible P/S', below_min_mcap: 'below the minimum market cap', short_history: 'short filing history' };
const dataFlagText = c => DATA_FLAG_TEXT[c] || (/^quality:/.test(c) ? `open data check (${c.slice(8).replace(/_/g, ' ')})` : String(c).replace(/_/g, ' '));
const BOOL_FLAGS = [
  ['on_sale', 'on sale', '#60a5fa'], ['garp', 'GARP', '#2dd4bf'], ['steady_compounder', 'steady compounder', '#a78bfa'],
  ['deep_value_intact', 'deep value, intact', '#34d399'], ['fundamentally_strong', 'fundamentally strong', '#34d399'],
  ['turning_up', 'turning up', '#2dd4bf'], ['value_trap', 'trap', '#fbbf24'], ['overvalued', 'rich', '#f87171'],
];
function stockFlags(s) {
  const pills = BOOL_FLAGS.filter(([k]) => s[k] === true)
    .map(([, l, c]) => `<span class="pill" style="background:${c}22;color:${c}">${l}</span>`).join(' ');
  return pills || '—';
}
function stockHead(t, s) {
  const back = STATE.drawerBack?.kind === 'market'
    ? `<button id="drawerBack" class="text-[11px] text-accent hover:underline mb-1">&larr; ${esc(STATE.drawerBack.name || STATE.drawerBack.key)}</button>` : '';
  const sub = s ? [s.sector, s.country].filter(Boolean).map(esc).join(' · ') : '';
  return `${back}
    <div class="flex items-start justify-between mb-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2"><span class="badge" style="background:#a78bfa22;color:#a78bfa">${esc(t)}</span>
          <span class="text-[11px] text-slate-500">stock${sub ? ' · ' + sub : ''}</span></div>
        <div class="text-lg font-semibold text-white mt-1">${esc(s?.name || t)}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        ${starControl('stock', t)}
        ${closeBtn()}
      </div>
    </div>`;
}
function stockTop(t, s, { loading = false } = {}) {
  if (!s) {
    return `<div class="text-[12px] text-slate-400 leading-relaxed bg-panel border border-line rounded-lg p-3 mb-4">
      ${loading ? 'Loading&hellip;' : `No figures for ${esc(t)} are published here. Stock-level data on this page covers the
      top picks and the per-market breakdowns; the full stock universe is limited to the owner while the
      price-data licence is reviewed.`}</div>`;
  }
  const why = [...(s.reasons || []).map(r => `<li class="ok">${esc(r)}</li>`),
               ...(s.cautions || []).map(c => `<li class="warn">${esc(c)}</li>`)].join('');
  return `${why ? `<ul class="pick-why mb-3">${why}</ul>` : ''}
    ${s.strategies?.length ? `<div class="mb-3">${stratBadges(s.strategies.map(stratLabel))}</div>` : ''}
    <div class="grid grid-cols-3 gap-2 mb-4">
      ${scoreTile('Value', s.value_score)}${scoreTile('Growth', s.growth_score)}${scoreTile('Opportunity', s.opportunity_score)}
    </div>`;
}
function stockBody(t, s) {
  if (!s) return '';
  const row = drawerRow;
  const has = k => s[k] != null;
  const rowsIf = list => list.filter(([k]) => has(k)).map(([, l, f]) => row(l, f(s))).join('');
  const val = rowsIf([['pe', 'P/E', x => fmt(x.pe)], ['pb', 'P/B', x => fmt(x.pb)], ['ps', 'P/S', x => fmt(x.ps)],
    ['pcf', 'P/CF', x => fmt(x.pcf)], ['dividend_yield', 'Dividend yield', x => pct(x.dividend_yield)]]);
  // "Growth" is the business's own record (EDGAR revenue / earnings) — never price.
  const share = v => v == null ? '—' : `${Math.round(v * 100)}% of years`;
  const growth = rowsIf([['rev_growth', 'Revenue growth (last year)', x => pct(x.rev_growth)],
    ['earnings_growth', 'Earnings growth (last year)', x => pct(x.earnings_growth)],
    ['rev_cagr', 'Revenue growth per year (CAGR)', x => pct(x.rev_cagr)],
    ['ni_cagr', 'Earnings growth per year (CAGR)', x => pct(x.ni_cagr)],
    ['rev_up_ratio', 'Revenue up', x => share(x.rev_up_ratio)], ['ni_up_ratio', 'Earnings up', x => share(x.ni_up_ratio)],
    ['ni_pos_ratio', 'Profitable', x => share(x.ni_pos_ratio)], ['hist_years', 'Years on file', x => fmt(x.hist_years, 0)],
    ['consistency_score', 'Consistency score', x => fmt(x.consistency_score, 0)]]);
  const price = rowsIf([['price', 'Price', x => money(x.price)], ['market_cap', 'Market cap', x => marketCap(x.market_cap)],
    ['discount_long', `${avgLabel(s.long_avg_years)} price`, x => pct(x.discount_long)]]);
  const caveats = s._trusted && s.data_ok === false && s.data_flags?.length
    ? `<div class="text-[11px] text-warn bg-panel border border-line rounded-lg p-2.5 mt-3">Hidden from screens by default — data caveats: ${esc(s.data_flags.map(dataFlagText).join(', '))}</div>` : '';
  const mk = (s._markets || []).map(k => STATE.rows.find(m => m.key === k)).filter(Boolean);
  const inMarkets = mk.length
    ? `${drawerSub('In these markets (bottom-up breakdown)')}<div class="flex flex-wrap gap-1.5">${mk.map(m =>
        `<button class="pill stock-mk" style="background:#60a5fa22;color:#60a5fa" data-mk="${esc(m.key)}">${esc(m.name)}</button>`).join('')}</div>` : '';
  return `
    ${val ? `${drawerSub('Valuation')}${val}` : ''}
    ${growth ? `${drawerSub('Fundamental growth record (EDGAR)')}${growth}` : ''}
    ${price ? `${drawerSub('Price (context)')}${price}` : ''}
    ${row('Flags', stockFlags(s))}
    ${caveats}${inMarkets}
    <div class="text-[10px] text-slate-500 mt-3">${s._trusted ? 'Owner view: daily stock snapshot.' : 'Figures from this week\'s published snapshot.'}
      US-listed${s.currency ? ` (${esc(s.currency)} native)` : ''}. Not investment advice.</div>`;
}
function fillStockDrawer(t, s, opts = {}) {
  drawerPart('head').innerHTML = stockHead(t, s);
  drawerPart('top').innerHTML = stockTop(t, s, opts);
  drawerPart('body').innerHTML = stockBody(t, s);
  $('#closeDrawer').onclick = () => closeDrawer();
  const back = $('#drawerBack');
  if (back) back.onclick = () => openDrawer(STATE.drawerBack.key);
  bindStar('stock', t);
  $$('#drawer [data-drw="body"] [data-mk]').forEach(b => b.onclick = () => openDrawer(b.dataset.mk));
}
// A key report on file for this ticker (reports/index.json, read once by reports.js) gets a
// small link under the drawer head. No module, no index or no report: nothing is shown.
function mountReportLink(t, seq) {
  if (typeof Reports === 'undefined' || !Reports.findByTicker) return;
  Reports.findByTicker(t).then(r => {
    const el = drawerPart('report');
    if (!r || !el || seq !== drawerSeq || !REPORT_SLUG_RE.test(String(r.slug))) return;
    const meta = [r.report_type, r.published].filter(Boolean).map(esc).join(' · ');
    el.innerHTML = `<a href="#/reports/${r.slug}" class="rpt-drawer-link" data-rpt-link="${r.slug}">
      <span>Read the key report &rarr;</span>${meta ? `<span class="rpt-drawer-meta">${meta}</span>` : ''}</a>`;
  }).catch(() => { /* silent: the drawer reads as before */ });
}
const stockChartSpec = (t, s) => ({ kind: 'stock', ticker: t, symbol: t, price: s?.price ?? null,
  discount_long: s?.discount_long ?? null, long_avg_years: s?.long_avg_years ?? null });

async function openStockDrawer(ticker, { fromRoute = false, keepBack = false } = {}) {
  const t = String(ticker ?? '').trim().toUpperCase();
  if (!ROUTE_TICKER_RE.test(t)) return;
  const seq = ++drawerSeq;
  STATE.drawer = { kind: 'stock', key: t };
  if (!keepBack) STATE.drawerBack = null;
  STATE.drawerFromRoute = fromRoute;
  disposeChart();
  drawerShell();
  const signedIn = Auth.available() && !!Auth.currentUser();
  const pub = publicStockRow(t);
  fillStockDrawer(t, pub, { loading: signedIn && !pub });
  showDrawer();
  mountReportLink(t, seq);
  // The owner's snapshot may still be downloading on first open — wait a little for it so
  // the chart gets the snapshot's price/average, then carry on with what we have.
  let snapRow = null;
  if (signedIn) {
    const pending = trustedStockRow(t);
    snapRow = await withTimeout(pending, 4000) || null;
    if (!snapRow) pending.then(r => {  // arrived late: refresh the numbers, keep the chart
      if (r && seq === drawerSeq) { STATE.drawerRow = resolvedStock(t, r); fillStockDrawer(t, STATE.drawerRow); }
    });
  }
  if (seq !== drawerSeq) return;
  STATE.drawerRow = resolvedStock(t, snapRow);
  fillStockDrawer(t, STATE.drawerRow);
  mountChart(stockChartSpec(t, STATE.drawerRow));
}

// Redraw the parts that depend on sign-in state or display currency — never the chart.
function refreshDrawerParts() {
  const dr = STATE.drawer;
  if (!dr || !$('#drawer [data-drw="head"]')) return;
  if (dr.kind === 'market') {
    const m = STATE.rows.find(x => x.key === dr.key);
    if (m) fillMarketDrawer(m);
    return;
  }
  const seq = drawerSeq;
  fillStockDrawer(dr.key, STATE.drawerRow || publicStockRow(dr.key));
  // Signing in (or out) can change what the owner may see; re-resolve, chart untouched.
  trustedStockRow(dr.key).then(r => {
    if (seq !== drawerSeq || STATE.drawer?.key !== dr.key) return;
    const next = resolvedStock(dr.key, r);
    if (!!next?._trusted !== !!STATE.drawerRow?._trusted) { STATE.drawerRow = next; fillStockDrawer(dr.key, next); }
  });
}

function scoreTile(label, s) {
  return `<div class="rounded-lg bg-panel border border-line p-2 text-center">
    <div class="text-[10px] text-slate-500 uppercase">${label}</div>
    <div class="text-xl font-bold" style="color:${scoreColor(s)}">${fmt(s, 0)}</div></div>`;
}
function closeDrawer({ keepHash = false } = {}) {
  drawerSeq++;
  disposeChart();
  STATE.drawer = null; STATE.drawerRow = null; STATE.drawerBack = null;
  $('#drawer').classList.add('translate-x-full'); $('#scrim').classList.add('hidden');
  // Closing a drawer that a #/stock/… or #/market/… link opened returns the URL to the
  // view underneath (replaceState: no hashchange, no history entry).
  if (!keepHash && /^#\/(stock|market)\//.test(location.hash)) {
    try { history.replaceState(null, '', ROUTER.baseHash || (location.pathname + location.search)); } catch { /* sandboxed */ }
  }
}
$('#scrim').onclick = () => closeDrawer();
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (STATE.drawer) closeDrawer();
  else if (!$('#signinPanel').hidden) showSignin(false);
});

// ---- header symbol search (TradingView-style) ----
// Markets (key / name / ETF symbol), public stock tickers, and — for the owner only —
// the snapshot's tickers, loaded when the box is first focused. Enter routes.
const SYMBOLS = { map: new Map(), trustedLoaded: false };
function buildSymbolList(extraStocks) {
  const d = STATE.data;
  if (!d) return;
  const map = new Map(), opts = [];
  const add = (value, label, hash) => {
    if (map.has(value.toLowerCase())) return;
    map.set(value.toLowerCase(), hash);
    opts.push(`<option value="${esc(value)}" label="${esc(label)}"></option>`);
  };
  for (const m of STATE.rows) add(`${m.symbol} · ${m.name}`, `${m.kind} · ${m.region}`, `#/market/${encodeURIComponent(m.key)}`);
  const stocks = new Map();
  for (const rows of Object.values(d.stock_breakdown || {})) for (const r of rows || []) stocks.set(r.ticker, r.name);
  for (const r of [...(d.top_picks?.stocks || []), ...(d.top_picks?.on_sale?.stocks || [])]) stocks.set(r.ticker, r.name);
  for (const [t, n] of extraStocks || []) if (!stocks.has(t)) stocks.set(t, n);
  for (const [t, n] of stocks) if (t && ROUTE_TICKER_RE.test(String(t).toUpperCase())) add(`${t} · ${n || ''}`.trim(), 'stock', `#/stock/${encodeURIComponent(String(t).toUpperCase())}`);
  SYMBOLS.map = map;
  $('#scr-symbol-list').innerHTML = opts.join('');
}
function resolveSymbol(text) {
  const q = String(text || '').trim();
  if (!q) return null;
  const hit = SYMBOLS.map.get(q.toLowerCase());
  if (hit) return hit;
  const lq = q.toLowerCase();
  const m = STATE.rows.find(x => x.key.toLowerCase() === lq || String(x.symbol).toLowerCase() === lq || x.name.toLowerCase() === lq);
  if (m) return `#/market/${encodeURIComponent(m.key)}`;
  for (const [label, hash] of SYMBOLS.map) if (label.split(' · ')[0] === lq) return hash;
  // Any well-formed ticker opens a stock drawer (it says when nothing is published for it).
  const t = q.toUpperCase();
  return ROUTE_TICKER_RE.test(t) ? `#/stock/${encodeURIComponent(t)}` : null;
}
(() => {
  const box = $('#symbolSearch');
  const go = () => {
    const hash = resolveSymbol(box.value);
    if (!hash) { box.style.borderColor = '#f87171'; return; }
    box.style.borderColor = '';
    box.value = '';
    box.blur();
    if (location.hash === hash) route(); else location.hash = hash;
  };
  box.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  // Picking a datalist suggestion fires `input` with the full option value.
  box.addEventListener('input', e => {
    box.style.borderColor = '';
    if (e.inputType === 'insertReplacementText' || (e.inputType == null && SYMBOLS.map.has(box.value.toLowerCase()))) go();
  });
  box.addEventListener('focus', async () => {
    if (!SYMBOLS.map.size) buildSymbolList();
    if (SYMBOLS.trustedLoaded || !Auth.available() || !Auth.currentUser()) return;
    SYMBOLS.trustedLoaded = true;
    try {
      if (!(await Auth.isTrusted())) { if (Auth.trustUnknown?.()) SYMBOLS.trustedLoaded = false; return; }
      const snap = await Auth.stockSnapshot();
      if (snap?.records) buildSymbolList(snap.records.map(r => [r.ticker, r.name]));
      else SYMBOLS.trustedLoaded = false;      // not published yet / failed: retry on next focus
    } catch { SYMBOLS.trustedLoaded = false; }
  });
})();

// ---- Overview scoreboard -> Screener (markets scope) ----
// Converts the scoreboard's current lens + filters into the same screen, so the user can
// keep refining there. Value bands use metrics.py's cut points (Expensive ≤ 33 < Fair ≤
// 66 < Cheap). "hide overvalued" has no screener field (richness is internal), so it is
// left out and the link says so. include_flagged: the scoreboard shows every market.
function scoreboardFilter() {
  const where = [];
  if (STATE.focus && STATE.focus !== 'All') where.push({ field: 'kind', op: 'in', value: [STATE.focus] });
  const reg = $('#fRegion').value, dev = $('#fDev').value, band = $('#fBand').value, q = $('#search').value.trim();
  if (reg) where.push({ field: 'region', op: 'in', value: [reg] });
  if (dev) where.push({ field: 'development', op: 'in', value: [dev] });
  if (band === 'Cheap') where.push({ field: 'value_score', op: '>', value: 66 });
  if (band === 'Fair') where.push({ field: 'value_score', op: '>', value: 33 }, { field: 'value_score', op: '<=', value: 66 });
  if (band === 'Expensive') where.push({ field: 'value_score', op: '<=', value: 33 });
  if (q) {
    // The scoreboard search matches name OR country; the DSL has no OR, so when the
    // country half adds rows, carry the exact set of matching markets instead.
    const ql = q.toLowerCase();
    const hits = focusedRows().filter(m => m.name.toLowerCase().includes(ql) || (m.country || '').toLowerCase().includes(ql));
    if (hits.every(m => m.name.toLowerCase().includes(ql))) where.push({ field: 'name', op: 'contains', value: q.slice(0, 80) });
    else where.push({ field: 'key', op: 'in', value: hits.map(m => m.key).slice(0, 500) });
  }
  const { key, dir } = STATE.sort;
  const sortable = typeof ScreenDSL !== 'undefined' && ScreenDSL.isReady?.() ? !!ScreenDSL.field(key) : key !== 'flags';
  return { v: 1, scope: 'markets', where, sort: sortable && key !== 'flags' ? { field: key, dir: dir < 0 ? 'desc' : 'asc' } : null,
    limit: 500, include_flagged: true };
}
$('#scr-open-scoreboard').onclick = e => {
  e.preventDefault();
  let filter = scoreboardFilter();
  if (typeof ScreenDSL !== 'undefined' && ScreenDSL.isReady?.()) {
    const v = ScreenDSL.validate(filter, 'markets');
    if (v.ok) filter = v.filter;
    else filter = { v: 1, scope: 'markets', where: [], sort: filter.sort, limit: 500, include_flagged: true };
  }
  if (typeof Screener !== 'undefined' && Screener.openWithFilter) {
    // Show the view without Screener.show() (which would apply its own state), then hand
    // over the filter. pushState: Back returns to the Overview.
    try { history.pushState(null, '', '#/screener'); } catch { /* sandboxed */ }
    if (STATE.drawer) closeDrawer({ keepHash: true });
    ROUTER.baseHash = '#/screener';
    showView('screener', null, { skipModule: true });
    try { Screener.openWithFilter(filter); } catch { moduleMissing('screener', true); }
    return;
  }
  const s = typeof ScreenDSL !== 'undefined' && ScreenDSL.encodeFilter ? ScreenDSL.encodeFilter(filter) : null;
  location.hash = s ? `#/screener?s=${s}` : '#/screener';
};
$('#fHideRich').addEventListener('change', () => {
  $('#scr-open-scoreboard').title = $('#fHideRich').checked
    ? 'Open in the Screener (the "hide overvalued" toggle has no screener equivalent and is not carried over)'
    : 'Open these markets in the Screener with the same filters';
});

// ---- feedback + refresh ----
function sendFeedback(kind, target, signal) {
  setLocalFb(`${kind}:${target}`, signal);  // persist locally (works on static host too)
  api('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, target, signal }) }).catch(() => { });
}
$('#refreshBtn').onclick = async () => {
  if (!STATE.hasApi) {
    alert('This is the published snapshot (as of ' + (STATE.data?.asof || '') + ').\n\n' +
      'Live refresh runs in the local engine:\n  python -m engine.cli refresh\n\n' +
      'The hosted data is refreshed automatically every week by the GitHub Action.');
    return;
  }
  const b = $('#refreshBtn'); b.textContent = 'Refreshing…'; b.disabled = true;
  try { await api('/api/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ use_cache: false, with_llm: true }) }); await load(); }
  finally { b.textContent = 'Refresh'; b.disabled = false; }
};

load();
