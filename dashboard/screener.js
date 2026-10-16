// Screener view (#/screener, ADR-037): Markets | Stocks scope, preset screens, the AI
// screen builder chat, saved screens, share links — around the ScreenBox widget
// (screenbox.js), which owns the chips, columns and results table.
//
// Data: markets = the public scoreboard (the `dashboard:data` event's detail.data);
// stocks = the owner's screener snapshot (Auth.stockSnapshot), drawn ONLY when
// Auth.isTrusted() — price-derived stock ratios stay behind the trusted gate while the
// price-data licence is reviewed (RLS enforces it again server-side).
//
// AI screen builder (a request-time feature — not an agent, not a job): every sentence
// is parsed locally first by ScreenDSL.ruleParse (free, instant, the provisional
// preview). For trusted signed-in users it is then sent to POST /api/screen-builder,
// whose answer replaces the preview once it passes ScreenDSL.validate and growthGuard
// here too. Model text is never rendered — only validated chips, the user's own
// ignored fragments and fixed notes. The thread lives in memory (per session, per
// scope); the URL never carries a sentence and never triggers the AI.
//
// Public: Screener.show({s?, id?}) (router), Screener.openWithFilter(filter).
const Screener = (() => {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } };
  const dsl = () => (typeof ScreenDSL !== 'undefined' && ScreenDSL.isReady && ScreenDSL.isReady() ? ScreenDSL : null);
  const auth = () => (typeof Auth !== 'undefined' ? Auth : null);
  const signedIn = () => { const a = auth(); return !!(a && a.available() && a.currentUser()); };

  const LS_SCOPE = 'giva_scr_scope';
  const LS_SCREENS = 'giva_screens';         // signed-out saves, this browser only
  const LOCAL_MAX = 10;
  const THREAD_MAX = 20;
  const AI_TIMEOUT_MS = 28000;
  const SCOPES = ['markets', 'stocks'];
  const LABEL = { markets: 'Markets', stocks: 'Stocks' };
  const CADENCE = {
    stocks: 'Checked daily after the data run.',
    markets: 'Checked weekly (Monday refresh).',
  };
  // Fixed server notes -> source badge text (anything else: "AI unavailable").
  const NOTE_BADGE = {
    'AI parsing is limited to approved accounts': 'rules · AI limited to approved accounts',
    'daily AI limit reached': 'rules · daily AI limit reached',
    'AI is not configured on this deployment': 'rules · AI not configured',
    "AI couldn't read that sentence; showing the rule-based reading": "rules · AI couldn't read it",
    'Screens holding a ticker list are refined by rules, so the list never leaves this site': 'rules · ticker lists stay on this site',
  };

  // Conditions carrying a user-built list (mirrors api/screen-builder.js LIST_FIELDS).
  const LIST_FIELDS = new Set(['ticker', 'key', 'name', 'symbol']);

  // Fixed notes the screen-builder may attach to an AI answer (api/screen-builder.js NOTE).
  const SERVER_NOTES = new Set(['Started a new screen: the current one is not valid for this scope.']);

  const S = {
    inited: false, root: null, scope: 'markets',
    data: null, markets: [], marketsAsof: null, dataFailed: false,
    stocks: { state: 'idle', snap: null, msg: '' },  // idle|loading|ready|signin|untrusted|unavailable|error
    uid: null, trusted: false,
    filters: { markets: null, stocks: null },
    loaded: { markets: null, stocks: null },        // {id, name, local} of the screen being edited
    box: null, boxScope: null,
    threads: { markets: [], stocks: [] }, turnSeq: 0, pending: null,
    saved: [], savedState: 'idle', savedMsg: '',     // account screens
    renaming: null, confirmDel: null,
    panel: null,                                      // 'save' | 'share' | null
    saveMsg: '', notice: '',
  };

  // ---- data ----
  function setMarketData(data) {
    if (!data || typeof data !== 'object') return;
    S.data = data;
    S.markets = Array.isArray(data.scoreboard) ? data.scoreboard.filter(r => r && typeof r === 'object') : [];
    S.marketsAsof = data.asof || null;
    S.dataFailed = false;
  }
  // The event normally arrives after this script loads; if it was missed (script order
  // changed, a module re-init), app.js's STATE is the fallback — read only.
  function marketRows() {
    if (!S.data && typeof STATE !== 'undefined' && STATE && STATE.data) setMarketData(STATE.data);
    return S.markets;
  }

  async function refreshAuth() {
    const a = auth();
    const uid = signedIn() ? a.currentUser().id : null;
    const changed = uid !== S.uid;
    const wasTrusted = S.trusted;
    S.uid = uid;
    if (changed) {
      // Another person (or nobody) now: nothing of the previous user's stays on screen.
      S.trusted = false;
      S.threads = { markets: [], stocks: [] };
      if (S.pending) S.pending.abort();
      S.saved = []; S.savedState = 'idle'; S.savedMsg = '';
      S.stocks = { state: 'idle', snap: null, msg: '' };
      S.loaded.stocks = S.loaded.stocks && S.loaded.stocks.local ? S.loaded.stocks : null;
      S.loaded.markets = S.loaded.markets && S.loaded.markets.local ? S.loaded.markets : null;
    }
    if (uid) { try { S.trusted = !!(await a.isTrusted()); } catch { S.trusted = false; } }
    if (uid !== S.uid) return;   // signed out/in again meanwhile
    if (!S.inited) return;
    if (S.box) S.box.setTrusted(S.trusted);
    if (changed || wasTrusted !== S.trusted) { renderHead(); renderAI(); renderThread(); }
    if (changed) {
      if (S.scope === 'stocks') ensureStocks();
      else renderMain();
      loadSaved();
    }
  }

  async function ensureStocks() {
    const st = S.stocks;
    if (st.state === 'loading' || st.state === 'ready') return;
    const a = auth();
    if (!a || !a.available() || !a.currentUser()) { S.stocks = { state: 'signin', snap: null, msg: '' }; renderMain(); return; }
    S.stocks = { state: 'loading', snap: null, msg: '' };
    renderMain();
    const uid = S.uid;
    let trusted = false;
    try { trusted = !!(await a.isTrusted()); } catch { trusted = false; }
    S.trusted = trusted;
    if (uid !== S.uid) return;
    if (!trusted) {
      // A failed check (network blip, 5xx, timeout) is "try again", not "not the owner".
      const state = a.lastError && a.lastError.notAvailable ? 'unavailable'
        : (a.trustUnknown && a.trustUnknown() ? 'error' : 'untrusted');
      S.stocks = { state, snap: null, msg: '' };
      renderMain(); return;
    }
    let snap = null;
    try { snap = await a.stockSnapshot(); } catch { snap = null; }
    if (uid !== S.uid) return;
    if (snap && Array.isArray(snap.records)) S.stocks = { state: 'ready', snap, msg: '' };
    // No row yet (table there, first daily run not done or skipped) = not available yet;
    // only a failed request is an error.
    else if (a.lastError && !a.lastError.notAvailable) S.stocks = { state: 'error', snap: null, msg: '' };
    else S.stocks = { state: 'unavailable', snap: null, msg: '' };
    renderHead(); renderMain(); renderThread();
  }

  // ---- saved screens: the account (Auth, RLS) + this browser (localStorage, signed out) ----
  function readLocal() {
    const D = dsl();
    let arr;
    try { arr = JSON.parse(lsGet(LS_SCREENS) || '[]'); } catch { arr = []; }
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const x of arr) {
      if (!x || typeof x !== 'object' || !/^local-[a-z0-9]{4,24}$/.test(String(x.id))) continue;
      if (typeof x.name !== 'string' || !x.name.trim() || !SCOPES.includes(x.scope)) continue;
      const v = D ? D.validate(x.filter, x.scope) : { ok: false };
      if (!v.ok) continue;
      out.push({ id: x.id, name: x.name.trim().slice(0, 80), scope: x.scope, filter: v.filter, updated_at: String(x.updated_at || ''), local: true });
      if (out.length >= LOCAL_MAX) break;
    }
    return out;
  }
  function writeLocal(list) {
    lsSet(LS_SCREENS, JSON.stringify(list.slice(0, LOCAL_MAX).map(({ id, name, scope, filter, updated_at }) => ({ id, name, scope, filter, updated_at }))));
  }
  const localId = () => 'local-' + Math.random().toString(36).slice(2, 12);

  async function loadSaved() {
    const a = auth();
    if (!signedIn()) { S.saved = []; S.savedState = 'idle'; renderSaved(); return; }
    S.savedState = 'loading'; renderSaved();
    const uid = S.uid;
    let rows = [];
    try { rows = await a.listScreens(); } catch { rows = []; }
    if (uid !== S.uid) return;
    const err = a.lastError;
    S.saved = Array.isArray(rows) ? rows.filter(r => r && r.id && SCOPES.includes(r.scope)) : [];
    S.savedState = !S.saved.length && err ? (err.notAvailable ? 'unavailable' : 'error') : 'ready';
    S.savedMsg = S.savedState === 'error' ? (err.message || 'Could not load your screens.') : '';
    renderSaved();
  }

  // ---- the widget ----
  const rowsFor = scope => scope === 'stocks' ? (S.stocks.state === 'ready' ? S.stocks.snap.records : []) : marketRows();
  const metaFor = scope => scope === 'stocks'
    ? { asof: S.stocks.snap ? S.stocks.snap.asof : null, message: S.stocks.state === 'loading' ? 'Loading the stock universe…' : null }
    : { asof: S.marketsAsof, message: S.data ? 'No markets in this snapshot.' : S.dataFailed ? "Couldn't load the market data — try reloading the page." : 'Loading markets…' };

  function openRow(key) {
    if (S.scope === 'stocks') {
      if (typeof openStockDrawer === 'function') openStockDrawer(key);
      else location.hash = '#/stock/' + encodeURIComponent(key);
    } else if (typeof openDrawer === 'function') openDrawer(key);
    else location.hash = '#/market/' + encodeURIComponent(key);
  }

  function mountBox() {
    const el = document.getElementById('scr-box');
    if (!el || typeof ScreenBox === 'undefined' || !dsl()) return;
    if (S.box && S.boxScope === S.scope) return;
    if (S.box) { S.filters[S.boxScope] = S.box.getFilter(); S.box.destroy(); S.box = null; }
    const scope = S.scope;
    S.box = ScreenBox.mount(el, {
      scope, rows: rowsFor(scope), trusted: S.trusted, filter: S.filters[scope],
      registry: dsl(),
      onOpen: openRow,
      onChange: f => { S.filters[scope] = f; renderThread(); },
      starHTML: (kind, key) => (typeof Lists !== 'undefined' && Lists.starHTML ? Lists.starHTML(kind, key) : ''),
      bindStars: root => { if (typeof Lists !== 'undefined' && Lists.bindStars) Lists.bindStars(root); },
    });
    S.box.setRows(rowsFor(scope), metaFor(scope));
    S.boxScope = scope;
    S.filters[scope] = S.box.getFilter();
  }
  const currentFilter = () => (S.box && S.boxScope === S.scope ? S.box.getFilter() : S.filters[S.scope]);
  function applyFilter(f, { loaded = null } = {}) {
    S.filters[S.scope] = f;
    S.loaded[S.scope] = loaded;
    if (S.box && S.boxScope === S.scope) { S.box.setFilter(f); S.filters[S.scope] = S.box.getFilter(); }
    renderHead();
  }
  // Keep the user's column choice when a preset / AI result / saved screen without columns lands.
  function withColumns(f) {
    const cur = currentFilter();
    return cur && cur.columns && f && !f.columns ? { ...f, columns: cur.columns } : f;
  }

  // ---- layout ----
  function init() {
    if (S.inited) return true;
    const root = document.getElementById('view-screener');
    if (!root) return false;
    S.root = root;
    // Stocks is remembered only for someone who can sign in; anyone else starts on markets.
    const saved = lsGet(LS_SCOPE);
    S.scope = saved === 'stocks' && signedIn() ? 'stocks' : 'markets';
    root.innerHTML = `
      <div class="scr">
        <div class="scr-head">
          <div class="scr-scopes" role="tablist" aria-label="Screen"></div>
          <div class="scr-universe" id="scr-universe"></div>
          <div class="scr-actions" id="scr-actions"></div>
        </div>
        <div class="scr-notice" id="scr-notice" role="status" hidden></div>
        <div class="scr-panel" id="scr-panel" hidden></div>
        <div class="scr-grid">
          <div class="scr-build">
            <section class="scr-card">
              <h3 class="scr-h">Presets</h3>
              <div class="scr-presets" id="scr-presets"></div>
            </section>
            <section class="scr-card scr-ai">
              <h3 class="scr-h">AI screen builder</h3>
              <p class="scr-muted scr-small">Describe a screen in plain words, then refine it: &ldquo;cheap industrials&rdquo; &rarr; &ldquo;only profitable ones&rdquo; &rarr; &ldquo;sort by growth&rdquo;.</p>
              <div class="scr-thread" id="scr-thread" aria-live="polite"></div>
              <form class="scr-ai-form" id="scr-ai-form" autocomplete="off">
                <input id="scr-ai-input" class="scr-in" maxlength="400" spellcheck="true"
                       placeholder="Describe a screen&hellip;" aria-label="Describe a screen" />
                <button type="submit" class="scr-btn scr-btn-pri">Build</button>
              </form>
              <p class="scr-muted scr-small" id="scr-ai-note"></p>
            </section>
          </div>
          <div class="scr-main">
            <div id="scr-gate" class="scr-gate" hidden></div>
            <div id="scr-box"></div>
          </div>
          <div class="scr-saved">
            <section class="scr-card">
              <h3 class="scr-h">Saved screens</h3>
              <div id="scr-saved"></div>
            </section>
          </div>
        </div>
      </div>`;
    root.addEventListener('click', onClick);
    root.addEventListener('submit', onSubmit);
    root.addEventListener('keydown', onKey);
    S.inited = true;
    return true;
  }

  function renderHead() {
    if (!S.inited) return;
    const D = dsl();
    S.root.querySelector('.scr-scopes').innerHTML = SCOPES.map(sc => {
      const lock = sc === 'stocks' && !S.trusted ? ' <span class="scr-lock" title="Owner only while the price-data licence is reviewed">🔒</span>' : '';
      return `<button type="button" role="tab" class="scr-scope${sc === S.scope ? ' on' : ''}" aria-selected="${sc === S.scope}" data-scr-act="scope" data-scr-scope="${sc}">${LABEL[sc]}${lock}</button>`;
    }).join('');
    const u = document.getElementById('scr-universe');
    if (S.scope === 'markets') {
      const n = marketRows().length;
      u.textContent = n ? `${n} markets · public scoreboard${S.marketsAsof ? ' · as of ' + S.marketsAsof : ''}` : '';
    } else if (S.stocks.state === 'ready') {
      const sn = S.stocks.snap;
      u.textContent = `${sn.records.length.toLocaleString()} stocks · owner-only snapshot${sn.asof ? ' · as of ' + sn.asof : ''}`;
    } else u.textContent = '';
    const usable = !!D && (S.scope === 'markets' || S.stocks.state === 'ready');
    const ld = S.loaded[S.scope];
    document.getElementById('scr-actions').innerHTML = usable ? `
      ${ld ? `<span class="scr-muted scr-small" title="The saved screen you are editing">Editing: <b>${esc(ld.name)}</b></span>` : ''}
      <button type="button" class="scr-btn" data-scr-act="new" title="Start an empty screen">New</button>
      <button type="button" class="scr-btn${S.panel === 'save' ? ' on' : ''}" data-scr-act="panel" data-scr-panel="save">Save</button>
      <button type="button" class="scr-btn${S.panel === 'share' ? ' on' : ''}" data-scr-act="panel" data-scr-panel="share">Share</button>` : '';
  }

  function renderNotice() {
    const n = document.getElementById('scr-notice');
    if (!n) return;
    n.hidden = !S.notice;
    n.innerHTML = S.notice ? `${esc(S.notice)} <button type="button" class="scr-link" data-scr-act="dismiss">Dismiss</button>` : '';
  }
  function notice(msg) { S.notice = msg || ''; renderNotice(); }

  function renderPresets() {
    const D = dsl();
    const el = document.getElementById('scr-presets');
    if (!el) return;
    el.innerHTML = D ? D.presets(S.scope).map(p =>
      `<button type="button" class="scr-preset" data-scr-act="preset" data-scr-id="${esc(p.id)}" title="${esc(D.describe(p.filter).join(' · '))}">${esc(p.name)}</button>`).join('') : '';
  }

  // Who the AI path is for, in one line under the input.
  function renderAI() {
    const el = document.getElementById('scr-ai-note');
    if (!el) return;
    const a = auth();
    if (signedIn() && S.trusted) el.textContent = "Your sentence (and the current screen's conditions, never a ticker list you built) is sent to a third-party AI model (Groq/Ollama); don't include personal details. Built-in rules answer instantly while it thinks.";
    else if (signedIn()) el.textContent = 'Built-in rules read your sentence in this browser. AI reading is limited to approved accounts.';
    else if (a && a.available()) el.textContent = 'Built-in rules read your sentence in this browser — sign in for AI.';
    else el.textContent = 'Built-in rules read your sentence in this browser.';
  }

  function renderMain() {
    if (!S.inited) return;
    const gate = document.getElementById('scr-gate');
    const boxEl = document.getElementById('scr-box');
    const build = S.root.querySelector('.scr-build');
    if (!dsl()) {
      if (S.box) { S.box.destroy(); S.box = null; S.boxScope = null; }
      gate.hidden = false; boxEl.hidden = true; build.hidden = true;
      gate.innerHTML = `<p>The screener's field list (screen_fields.json) didn't load.</p>
        <button type="button" class="scr-btn" data-scr-act="retry-dsl">Try again</button>`;
      return;
    }
    const st = S.stocks;
    const gated = S.scope === 'stocks' && st.state !== 'ready' && st.state !== 'loading';
    gate.hidden = !gated; boxEl.hidden = gated; build.hidden = gated;
    if (gated) {
      // Never leave owner-only rows in the (hidden) DOM after a sign-out.
      if (S.box && S.boxScope === 'stocks') { S.filters.stocks = S.box.getFilter(); S.box.destroy(); S.box = null; S.boxScope = null; }
      const a = auth();
      const back = '<button type="button" class="scr-btn scr-btn-pri" data-scr-act="scope" data-scr-scope="markets">Screen markets instead</button>';
      const why = '<p>Stock-level screening is limited to the owner while the price-data licence is reviewed. The markets screener works for everyone.</p>';
      let body;
      if (st.state === 'signin' || st.state === 'idle') {
        body = why + (a && a.available()
          ? '<p class="scr-muted">If you are the owner, sign in (top right) to screen the stock universe.</p>'
          : '<p class="scr-muted">Sign-in is not configured on this deployment.</p>');
      } else if (st.state === 'untrusted') body = why + '<p class="scr-muted">This account is not on the owner list.</p>';
      else if (st.state === 'unavailable') body = '<p>The stock universe is not available yet &mdash; it appears after the next daily data run.</p>';
      else body = '<p>Could not load the stock universe.</p><button type="button" class="scr-btn" data-scr-act="retry-stocks">Try again</button>';
      gate.innerHTML = body + back;
      return;
    }
    mountBox();
    if (S.box) S.box.setRows(rowsFor(S.scope), metaFor(S.scope));
  }

  // ---- AI chat thread ----
  function badgeClass(t) { return t.source && t.source !== 'rules' ? 'scr-badge scr-badge-ai' : 'scr-badge'; }
  function chipList(list, cls, sign) {
    return list.map(c => `<span class="scr-dchip ${cls}"><b aria-hidden="true">${sign}</b> ${esc(c)}</span>`).join('');
  }
  function renderThread() {
    const el = document.getElementById('scr-thread');
    if (!el) return;
    const D = dsl();
    const turns = S.threads[S.scope];
    if (!D || !turns.length) { el.innerHTML = ''; return; }
    const lastId = turns[turns.length - 1].id;
    el.innerHTML = turns.map(t => {
      let diff = '', any = 0;
      if (t.filter) {
        const d = D.diff(t.base, t.filter);
        any = d.added.length + d.removed.length + d.changed.length;
        diff = any ? chipList(d.added, 'add', '+') + chipList(d.removed, 'rm', '−') + chipList(d.changed, 'chg', '~')
          : '<span class="scr-muted scr-small">No change to the screen.</span>';
      } else diff = '<span class="scr-muted scr-small">Couldn\'t build a screen from that.</span>';
      const ign = t.unparsed.length ? `<div class="scr-small scr-muted">Ignored: ${t.unparsed.map(u => `<q>${esc(u)}</q>`).join(', ')}</div>` : '';
      const notes = t.notes.length ? t.notes.map(n => `<div class="scr-small scr-note">${esc(n)}</div>`).join('') : '';
      let foot = '';
      if (t.status === 'asking') {
        foot = `<div class="scr-asking"><span class="scr-spin" aria-hidden="true"></span> Asking AI&hellip; <button type="button" class="scr-link" data-scr-act="ai-cancel">cancel</button></div>`;
      }
      if ((t.status === 'ready' || t.status === 'asking') && t.id === lastId && t.filter) {
        const alt = t.status === 'ready' && t.rulesFilter && t.source !== 'rules'
          && JSON.stringify(t.rulesFilter.where) !== JSON.stringify(t.filter.where)
          ? '<button type="button" class="scr-link" data-scr-act="ai-rules">Use the rules reading instead</button>' : '';
        if (any) {
          // The live match count for the proposed screen, before the user applies it.
          const n = S.box ? S.box.count(t.filter) : null;
          const cnt = n == null ? '' : `<b>${n.toLocaleString()}</b> ${n === 1 ? 'match' : 'matches'}`;
          foot += `<div class="scr-confirm">${cnt}
            <button type="button" class="scr-btn scr-btn-pri" data-scr-act="ai-apply" data-scr-turn="${t.id}">Apply</button>
            <button type="button" class="scr-btn" data-scr-act="ai-discard" data-scr-turn="${t.id}">Discard</button> ${alt}</div>`;
        } else if (alt) foot += `<div class="scr-confirm">${alt}</div>`;
      } else if (t.status === 'applied') foot += '<div class="scr-small scr-ok">✓ Applied</div>';
      else if (t.status === 'discarded') foot += '<div class="scr-small scr-muted">Discarded</div>';
      return `<div class="scr-turn">
        <div class="scr-q">${esc(t.sentence)}</div>
        <div class="scr-diff">${diff}</div>
        <div class="scr-meta"><span class="${badgeClass(t)}">${esc(t.badge)}</span></div>
        ${ign}${notes}${foot}</div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  }

  const strArr = (x, n = 10) => (Array.isArray(x) ? x.filter(s => typeof s === 'string').map(s => s.slice(0, 200)).slice(0, n) : []);
  const prettySource = s => String(s).replace(/[^A-Za-z0-9.:_\/-]/g, '').slice(0, 60).replace(':', '/');

  async function submitSentence(sentence) {
    const D = dsl();
    sentence = String(sentence || '').replace(/\s+/g, ' ').trim().slice(0, 400);
    if (!D || !sentence) return;
    if (S.scope === 'stocks' && S.stocks.state !== 'ready') return;
    if (S.pending) S.pending.abort();
    const scope = S.scope;
    const cur = currentFilter();
    const cv = cur ? D.validate(cur, scope) : { ok: false };
    const current = cv.ok ? cv.filter : null;
    const rp = D.ruleParse(sentence, scope, current);
    const turns = S.threads[scope];
    for (const t of turns) if (t.status === 'ready' || t.status === 'asking') t.status = 'skipped';
    const a = auth();
    const turn = {
      id: ++S.turnSeq, scope, sentence, base: current, status: 'ready',
      filter: rp.filter ? withColumns(rp.filter) : null, rulesFilter: rp.filter, source: 'rules',
      unparsed: strArr(rp.unparsed), notes: strArr(rp.notes), rulesNotes: strArr(rp.notes), rulesUnparsed: strArr(rp.unparsed),
      badge: signedIn() ? (S.trusted ? 'rules · preview' : 'rules · AI limited to approved accounts') : (a && a.available() ? 'rules · sign in for AI' : 'rules'),
    };
    turns.push(turn);
    if (turns.length > THREAD_MAX) turns.splice(0, turns.length - THREAD_MAX);
    if (signedIn() && S.trusted) {
      turn.status = 'asking';
      renderThread();
      await askAI(turn, current);
    }
    renderThread();
  }

  async function askAI(turn, current) {
    const D = dsl(), a = auth();
    const ctrl = new AbortController();
    S.pending = ctrl;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, AI_TIMEOUT_MS);
    try {
      const token = await a.accessToken();
      if (!token) { turn.badge = 'rules · sign in again for AI'; return; }
      // Columns are display-only, so leave them out. A screen holding a list the user
      // built (e.g. a watchlist opened here) is never sent to a third-party model, and a
      // request too big for the server's 2 KB limit is not silently stripped of the
      // current screen (that would replace the screen instead of refining it): both stay
      // with the rule-based reading.
      let cur = current ? { ...current } : null;
      if (cur) delete cur.columns;
      if (cur && (cur.where || []).some(c => LIST_FIELDS.has(c.field) && (c.op === 'in' || c.op === 'not_in'))) {
        turn.badge = 'rules · ticker lists stay on this site'; return;
      }
      const body = JSON.stringify({ sentence: turn.sentence, scope: turn.scope, current: cur });
      if (new TextEncoder().encode(body).length > 2000) { turn.badge = 'rules · screen too large for AI'; return; }
      const r = await fetch('/api/screen-builder', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body,
      });
      if (r.status === 401) { turn.badge = 'rules · sign in again for AI'; return; }
      if (!r.ok) { turn.badge = 'rules · AI unavailable'; return; }
      let j = null;
      try { j = await r.json(); } catch { j = null; }
      if (!j || typeof j !== 'object') { turn.badge = 'rules · AI unavailable'; return; }
      if (typeof j.source === 'string' && j.source !== 'rules') {
        // Re-checked here: validate (scope, registry) and the growth rule.
        const v = D.validate(j.filter, turn.scope);
        const g = v.ok ? D.growthGuard(turn.sentence, v.filter, current) : { ok: false };
        if (!v.ok || !g.ok) { turn.badge = 'rules · AI answer rejected'; return; }
        turn.filter = withColumns(v.filter);
        turn.source = j.source;
        turn.badge = 'AI · ' + prettySource(j.source);
        // The server already keeps only verbatim pieces of the sentence and fixed notes;
        // checked again so no model text can reach the page.
        const said = turn.sentence.toLowerCase();
        turn.unparsed = strArr(j.unparsed).filter(u => u.trim() && said.includes(u.trim().toLowerCase()));
        turn.notes = strArr(j.notes).filter(n => turn.rulesNotes.includes(n) || SERVER_NOTES.has(n));
      } else {
        turn.badge = NOTE_BADGE[j.note] || (j.note ? 'rules · AI unavailable' : 'rules');
      }
    } catch (e) {
      turn.badge = timedOut ? 'rules · AI timed out' : (ctrl.signal.aborted ? 'rules · AI cancelled' : 'rules · AI unavailable');
    } finally {
      clearTimeout(timer);
      if (S.pending === ctrl) S.pending = null;
      if (turn.status === 'asking') turn.status = 'ready';
    }
  }

  function findTurn(id) { return S.threads[S.scope].find(t => t.id === Number(id)) || null; }

  // ---- saved screens UI ----
  function savedItem(x) {
    const id = esc(x.id);
    if (S.renaming === x.id) {
      return `<li class="scr-sv"><form class="scr-rename" data-scr-rename="${id}">
        <input class="scr-in" maxlength="80" value="${esc(x.name)}" aria-label="New name" />
        <button type="submit" class="scr-btn scr-btn-pri">Save</button>
        <button type="button" class="scr-btn" data-scr-act="rename-cancel">Cancel</button></form></li>`;
    }
    const del = S.confirmDel === x.id
      ? `<button type="button" class="scr-link scr-bad" data-scr-act="delete" data-scr-id="${id}">Confirm delete</button>`
      : `<button type="button" class="scr-link" data-scr-act="delete-ask" data-scr-id="${id}">Delete</button>`;
    const move = x.local && signedIn()
      ? `<button type="button" class="scr-link" data-scr-act="move" data-scr-id="${id}" title="Save to your account and remove from this browser">Move to account</button>` : '';
    return `<li class="scr-sv">
      <button type="button" class="scr-sv-name" data-scr-act="load" data-scr-id="${id}">${esc(x.name)}</button>
      <span class="scr-tag">${LABEL[x.scope]}</span>${x.alerts_enabled ? '<span class="scr-tag scr-tag-alert" title="Alerts on">alerts</span>' : ''}
      <span class="scr-sv-act"><button type="button" class="scr-link" data-scr-act="rename" data-scr-id="${id}">Rename</button> ${move} ${del}</span></li>`;
  }
  function renderSaved() {
    const el = document.getElementById('scr-saved');
    if (!el) return;
    const local = readLocal();
    const a = auth();
    let acct = '';
    if (signedIn()) {
      if (S.savedState === 'loading') acct = '<p class="scr-muted scr-small">Loading&hellip;</p>';
      else if (S.savedState === 'unavailable') acct = '<p class="scr-muted scr-small">Saving to your account is not available yet &mdash; it appears after the next daily data run.</p>';
      else if (S.savedState === 'error') acct = `<p class="scr-small scr-bad">${esc(S.savedMsg)}</p>`;
      else acct = S.saved.length ? `<ul class="scr-svl">${S.saved.map(savedItem).join('')}</ul>` : '<p class="scr-muted scr-small">No saved screens yet.</p>';
    }
    const localHTML = local.length ? `${signedIn() ? '<div class="scr-sub">On this device</div>' : ''}<ul class="scr-svl">${local.map(savedItem).join('')}</ul>` : '';
    const hint = signedIn() ? '' : `<p class="scr-muted scr-small">${local.length ? '' : 'No saved screens yet. '}Screens save in this browser (up to ${LOCAL_MAX})${a && a.available() ? ' &mdash; sign in to keep them in your account and get alerts.' : '.'}</p>`;
    el.innerHTML = acct + localHTML + hint;
  }

  function renderPanel() {
    const el = document.getElementById('scr-panel');
    if (!el) return;
    const D = dsl();
    const f = currentFilter();
    if (!S.panel || !D || !f) { el.hidden = true; el.innerHTML = ''; return; }
    el.hidden = false;
    if (S.panel === 'share') {
      const enc = D.encodeFilter(f);
      const url = enc ? `${location.origin}${location.pathname}#/screener?s=${enc}` : '';
      el.innerHTML = `<div class="scr-row"><strong>Share this screen</strong>
          <button type="button" class="scr-link" data-scr-act="panel-close" aria-label="Close">Close</button></div>
        <div class="scr-row"><input class="scr-in scr-grow" id="scr-share-url" readonly value="${esc(url)}" aria-label="Share link" />
          <button type="button" class="scr-btn scr-btn-pri" data-scr-act="copy">Copy</button></div>
        <p class="scr-muted scr-small">The link carries the filter only &mdash; never any data.${S.scope === 'stocks' ? ' Stock screens open only for the owner.' : ''}</p>
        <p class="scr-small scr-ok" id="scr-copy-msg" role="status"></p>`;
      return;
    }
    const ld = S.loaded[S.scope];
    const account = signedIn();
    const alertsOn = ld && !ld.local ? !!(S.saved.find(x => x.id === ld.id) || {}).alerts_enabled : false;
    el.innerHTML = `<form class="scr-save" id="scr-save-form">
      <div class="scr-row"><strong>Save this ${S.scope === 'stocks' ? 'stock' : 'market'} screen</strong>
        <button type="button" class="scr-link" data-scr-act="panel-close">Close</button></div>
      <div class="scr-row"><input class="scr-in scr-grow" id="scr-save-name" maxlength="80" required
        placeholder="Name, e.g. Cheap Asian growers" value="${esc(ld ? ld.name : '')}" aria-label="Screen name" /></div>
      ${account ? `<label class="scr-row scr-small"><input type="checkbox" id="scr-save-alerts"${alertsOn ? ' checked' : ''} />
          Alert me when ${S.scope === 'stocks' ? 'stocks' : 'markets'} join or leave this screen.</label>
        <p class="scr-muted scr-small">${CADENCE[S.scope]} The first run sets a baseline and doesn't alert.</p>`
        : `<p class="scr-muted scr-small">Saved in this browser only (up to ${LOCAL_MAX}).${auth() && auth().available() ? ' Sign in for alerts and to keep screens in your account.' : ''}</p>`}
      <div class="scr-row">
        ${ld && (ld.local ? !account : account) ? `<button type="submit" class="scr-btn scr-btn-pri" data-scr-mode="update">Update &ldquo;${esc(ld.name)}&rdquo;</button>` : ''}
        <button type="submit" class="scr-btn${ld ? '' : ' scr-btn-pri'}" data-scr-mode="new">Save as new</button>
      </div>
      <p class="scr-small" id="scr-save-msg" role="status">${esc(S.saveMsg)}</p></form>`;
  }

  async function saveScreen(mode) {
    const D = dsl(), a = auth();
    const f = currentFilter();
    const nameEl = document.getElementById('scr-save-name');
    const name = (nameEl ? nameEl.value : '').trim().slice(0, 80);
    const msg = t => { S.saveMsg = t; const m = document.getElementById('scr-save-msg'); if (m) m.textContent = t; };
    if (!name) { msg('Give the screen a name.'); return; }
    const v = D.validate(f, S.scope);
    if (!v.ok) { msg('This screen is not valid: ' + v.errors.slice(0, 2).join('; ')); return; }
    const ld = S.loaded[S.scope];
    if (signedIn()) {
      const alertsEl = document.getElementById('scr-save-alerts');
      const row = await a.saveScreen({ id: mode === 'update' && ld && !ld.local ? ld.id : undefined, name, scope: S.scope, filter: v.filter, alerts_enabled: !!(alertsEl && alertsEl.checked) });
      if (!row) { msg((a.lastError && a.lastError.message) || 'Could not save the screen.'); return; }
      S.loaded[S.scope] = { id: row.id, name: row.name, local: false };
      S.saveMsg = ''; S.panel = null;
      await loadSaved();
    } else {
      const list = readLocal();
      const now = new Date().toISOString();
      if (mode === 'update' && ld && ld.local && list.some(x => x.id === ld.id)) {
        const x = list.find(y => y.id === ld.id);
        Object.assign(x, { name, filter: v.filter, scope: S.scope, updated_at: now });
      } else {
        if (list.length >= LOCAL_MAX) { msg(`This browser holds up to ${LOCAL_MAX} screens — delete one first${a && a.available() ? ', or sign in' : ''}.`); return; }
        const x = { id: localId(), name, scope: S.scope, filter: v.filter, updated_at: now, local: true };
        list.unshift(x);
        S.loaded[S.scope] = { id: x.id, name, local: true };
      }
      if (S.loaded[S.scope]) S.loaded[S.scope].name = name;
      writeLocal(list);
      S.saveMsg = ''; S.panel = null;
      renderSaved();
    }
    renderHead(); renderPanel();
    notice(`Saved “${name}”.`);
  }

  function loadScreen(x) {
    const D = dsl();
    const v = D ? D.validate(x.filter, x.scope) : { ok: false };
    if (!v.ok) { notice('That saved screen no longer matches the field list — edit and save it again.'); return; }
    S.panel = null;
    setScope(x.scope, { filter: v.filter, loaded: { id: x.id, name: x.name, local: !!x.local } });
  }
  const findSaved = id => S.saved.find(x => x.id === id) || readLocal().find(x => x.id === id) || null;

  async function deleteScreen(id) {
    const x = findSaved(id);
    S.confirmDel = null;
    if (!x) return;
    if (x.local) writeLocal(readLocal().filter(y => y.id !== id));
    else if (!(await auth().deleteScreen(id))) { notice((auth().lastError && auth().lastError.message) || 'Could not delete the screen.'); renderSaved(); return; }
    for (const sc of SCOPES) if (S.loaded[sc] && S.loaded[sc].id === id) S.loaded[sc] = null;
    if (!x.local) await loadSaved(); else renderSaved();
    renderHead();
  }
  async function renameScreen(id, name) {
    name = String(name || '').trim().slice(0, 80);
    const x = findSaved(id);
    S.renaming = null;
    if (!x || !name) { renderSaved(); return; }
    if (x.local) {
      const list = readLocal();
      const y = list.find(z => z.id === id);
      if (y) { y.name = name; y.updated_at = new Date().toISOString(); writeLocal(list); }
      renderSaved();
    } else {
      const row = await auth().saveScreen({ id, name, scope: x.scope, filter: x.filter, alerts_enabled: !!x.alerts_enabled });
      if (!row) notice((auth().lastError && auth().lastError.message) || 'Could not rename the screen.');
      await loadSaved();
    }
    for (const sc of SCOPES) if (S.loaded[sc] && S.loaded[sc].id === id) S.loaded[sc].name = name;
    renderHead();
  }
  async function moveToAccount(id) {
    const x = readLocal().find(y => y.id === id);
    if (!x || !signedIn()) return;
    const row = await auth().saveScreen({ name: x.name, scope: x.scope, filter: x.filter, alerts_enabled: false });
    if (!row) { notice((auth().lastError && auth().lastError.message) || 'Could not move the screen.'); return; }
    writeLocal(readLocal().filter(y => y.id !== id));
    for (const sc of SCOPES) if (S.loaded[sc] && S.loaded[sc].id === id) S.loaded[sc] = { id: row.id, name: row.name, local: false };
    await loadSaved();
    renderHead();
  }

  // ---- scope + full render ----
  function setScope(scope, { filter = null, loaded } = {}) {
    if (!SCOPES.includes(scope)) return;
    if (S.box && S.boxScope) S.filters[S.boxScope] = S.box.getFilter();
    if (S.pending && scope !== S.scope) S.pending.abort();
    S.scope = scope;
    lsSet(LS_SCOPE, scope);
    if (filter) { S.filters[scope] = filter; S.loaded[scope] = loaded || null; }
    if (S.box && S.boxScope !== scope) { S.box.destroy(); S.box = null; S.boxScope = null; }
    if (scope === 'stocks') ensureStocks();
    renderAll();
    if (filter && S.box && S.boxScope === scope) applyFilter(filter, { loaded: S.loaded[scope] });
  }

  function renderAll() {
    if (!S.inited) return;
    renderHead(); renderNotice(); renderPresets(); renderAI(); renderMain(); renderThread(); renderSaved(); renderPanel();
  }

  // ---- events ----
  async function onClick(e) {
    const b = e.target.closest('[data-scr-act]');
    if (!b || !S.root.contains(b)) return;
    const act = b.dataset.scrAct, id = b.dataset.scrId;
    const D = dsl();
    switch (act) {
      case 'scope': if (b.dataset.scrScope !== S.scope) { S.panel = null; setScope(b.dataset.scrScope); } return;
      case 'dismiss': notice(''); return;
      case 'retry-dsl':
        if (typeof ScreenDSL !== 'undefined' && ScreenDSL.load) { try { await ScreenDSL.load(); } catch { /* still down */ } }
        renderAll(); return;
      case 'retry-stocks': S.stocks = { state: 'idle', snap: null, msg: '' }; ensureStocks(); return;
      case 'new':
        applyFilter(withColumns({ v: 1, scope: S.scope, where: [], sort: { field: 'value_score', dir: 'desc' }, limit: 100, include_flagged: false }));
        renderThread(); return;
      case 'preset': {
        const p = D && D.presets(S.scope).find(x => x.id === id);
        if (p) { applyFilter(withColumns(p.filter)); renderThread(); }
        return;
      }
      case 'panel': S.panel = S.panel === b.dataset.scrPanel ? null : b.dataset.scrPanel; S.saveMsg = ''; renderHead(); renderPanel();
        if (S.panel === 'save') { const n = document.getElementById('scr-save-name'); if (n) n.focus(); }
        return;
      case 'panel-close': S.panel = null; renderHead(); renderPanel(); return;
      case 'copy': {
        const inp = document.getElementById('scr-share-url'), m = document.getElementById('scr-copy-msg');
        if (!inp) return;
        let ok = false;
        try { await navigator.clipboard.writeText(inp.value); ok = true; } catch { try { inp.select(); ok = document.execCommand('copy'); } catch { ok = false; } }
        if (m) m.textContent = ok ? 'Link copied.' : 'Select the link and copy it.';
        return;
      }
      case 'ai-cancel': if (S.pending) S.pending.abort(); return;
      case 'ai-apply': {
        const t = findTurn(b.dataset.scrTurn);
        if (!t || !t.filter) return;
        if (S.pending && t.status === 'asking') S.pending.abort();
        applyFilter(t.filter);
        t.status = 'applied';
        renderThread(); return;
      }
      case 'ai-discard': { const t = findTurn(b.dataset.scrTurn); if (t) { if (t.status === 'asking' && S.pending) S.pending.abort(); t.status = 'discarded'; renderThread(); } return; }
      case 'ai-rules': {
        const t = S.threads[S.scope][S.threads[S.scope].length - 1];
        if (t && t.rulesFilter) {
          t.filter = withColumns(t.rulesFilter); t.source = 'rules'; t.badge = 'rules (chosen over AI)';
          t.unparsed = t.rulesUnparsed; t.notes = t.rulesNotes; renderThread();
        }
        return;
      }
      case 'load': { const x = findSaved(id); if (x) loadScreen(x); return; }
      case 'rename': S.renaming = id; S.confirmDel = null; renderSaved();
        { const inp = S.root.querySelector('.scr-rename input'); if (inp) { inp.focus(); inp.select(); } }
        return;
      case 'rename-cancel': S.renaming = null; renderSaved(); return;
      case 'delete-ask': S.confirmDel = id; S.renaming = null; renderSaved(); return;
      case 'delete': await deleteScreen(id); return;
      case 'move': await moveToAccount(id); return;
    }
  }
  function onSubmit(e) {
    const f = e.target;
    if (!S.root.contains(f)) return;
    e.preventDefault();
    if (f.id === 'scr-ai-form') {
      const inp = document.getElementById('scr-ai-input');
      const v = inp.value;
      inp.value = '';
      submitSentence(v);
    } else if (f.id === 'scr-save-form') {
      const mode = e.submitter && e.submitter.dataset.scrMode === 'update' ? 'update' : 'new';
      saveScreen(mode);
    } else if (f.dataset.scrRename) {
      renameScreen(f.dataset.scrRename, f.querySelector('input').value);
    }
  }
  function onKey(e) {
    if (e.key === 'Escape' && S.root.contains(e.target)) {
      if (S.renaming && e.target.closest('.scr-rename')) { e.stopPropagation(); S.renaming = null; renderSaved(); }
      else if (S.panel && e.target.closest('#scr-panel')) { e.stopPropagation(); S.panel = null; renderHead(); renderPanel(); }
    }
  }

  // ---- public ----
  async function show(params) {
    if (!init()) return;
    params = params || {};
    if (!dsl() && typeof ScreenDSL !== 'undefined' && ScreenDSL.load) {
      try { await ScreenDSL.load(); } catch { /* renderMain says so */ }
    }
    await refreshAuth();
    const D = dsl();
    if (D && params.s) {
      const r = D.decodeFilter(params.s);
      if (r.ok) { setScope(r.filter.scope, { filter: r.filter, loaded: null }); notice(''); }
      else { notice("That share link isn't a valid screen."); renderAll(); }
    } else if (D && params.id) {
      if (signedIn() && S.savedState !== 'ready') await loadSaved();
      const x = findSaved(params.id);
      if (x) { loadScreen(x); notice(''); }
      else { notice("That saved screen isn't available — it may have been deleted, or it belongs to another account."); renderAll(); }
    } else {
      if (S.scope === 'stocks') ensureStocks();
      renderAll();
    }
    if (signedIn() && S.savedState === 'idle') loadSaved();
  }

  function openWithFilter(filter) {
    if (!init()) return;
    const D = dsl();
    if (!D) { renderAll(); return; }
    const v = D.validate(filter);
    if (!v.ok) { notice("Couldn't open that screen: " + v.errors.slice(0, 2).join('; ')); renderAll(); return; }
    S.panel = null;
    setScope(v.filter.scope, { filter: v.filter, loaded: null });
    refreshAuth();
    if (signedIn() && S.savedState === 'idle') loadSaved();
  }

  // Data + sign-in hooks. Both re-render only this view's own containers.
  if (typeof document !== 'undefined') {
    document.addEventListener('dashboard:data', e => {
      const d = e && e.detail;
      if (d && d.ok && d.data) setMarketData(d.data);
      else if (d && !d.ok && !S.data) S.dataFailed = true;
      if (!S.inited) return;
      if (S.box && S.boxScope === 'markets') S.box.setRows(rowsFor('markets'), metaFor('markets'));
      renderHead(); renderPresets(); renderThread();
    });
  }
  if (typeof Auth !== 'undefined' && Auth.onChange) Auth.onChange(() => { refreshAuth(); });

  return { show, openWithFilter };
})();
