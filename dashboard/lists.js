// Lists — watchlists, the one star control, and the Alerts view (ADR-037).
//
//  - One star everywhere (drawers, screener rows, list rows): Lists.starHTML(kind, key)
//    draws it, a click opens a list picker (a checkbox per list + "New list"). The
//    built-in "Starred markets" list IS user_watchlist (Auth.isWatched / toggleWatch,
//    unchanged since 0011); stocks go to an auto-created "Starred stocks" list
//    (Auth.ensureList). Any custom list can hold both kinds.
//  - #/lists: lists CRUD and an items table — Symbol, Name, P/E, Value, Growth
//    (fundamental), Opportunity, vs long-run average (with its window), flags; Price only
//    for trusted viewers. Rows are the latest snapshot (markets weekly, stocks daily), not
//    live quotes. Stock rows come from the owner's snapshot when trusted, else only from
//    what dashboard_data.json already publishes (top picks / on-sale / per-market
//    breakdowns); anything else shows "—" (stock data is limited to the owner while the
//    price-data licence is reviewed). "Screen this list" opens the screener on it.
//  - #/alerts: what entered / left each saved screen (written by the deterministic alert
//    job), unseen first; entries hidden by a data issue are listed apart from real exits.
//    The tab badge is the unseen count.
//
// Public: Lists.show('lists'|'alerts'), starHTML(kind, key), bindStars(root), refresh(),
// refreshBadge() -> Promise<number>, unseenCount() -> Promise<number>.
// Never throws into its callers; every Auth call resolves to null/[]/false on failure.
const Lists = (() => {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };
  const auth = () => (typeof Auth !== 'undefined' && Auth ? Auth : null);
  const authOn = () => { const a = auth(); try { return !!(a && a.available && a.available()); } catch { return false; } };
  const signedIn = () => { const a = auth(); try { return authOn() && !!a.currentUser(); } catch { return false; } };
  const uid = () => { try { return signedIn() ? auth().currentUser().id ?? null : null; } catch { return null; } };
  const isNum = v => typeof v === 'number' && isFinite(v);

  const STARRED_STOCKS = 'Starred stocks';
  const BUILTIN = 'starred-markets';            // the built-in list's id (user_watchlist)
  const NEW_STARRED = 'new-starred-stocks';     // "Starred stocks" before it exists
  const ITEM_KEY_RE = /^[A-Za-z0-9._:\-]{1,32}$/;
  const LS_SEL = 'giva_lst_sel';
  const ALERTS_LIMIT = 100;
  const SCREEN_MAX = 500;                       // screen_fields.json limits.max_list_values

  const S = {
    data: null, asof: null,
    markets: new Map(),        // market key -> scoreboard row (public)
    pubStocks: new Map(),      // ticker -> merged public stock row (dashboard_data.json)
    uid: null,
    lists: null, listsP: null, listsErr: null,
    trusted: false, snap: null, stocksP: null, stocksDone: false,
    alerts: null, alertsP: null, alertsErr: null,
    sel: lsGet(LS_SEL) || BUILTIN,
    form: null,                // null | 'new' | 'rename' | 'delete'
    msg: '',
    sort: { key: null, dir: -1 },
    alertMsg: '',
    shown: null, drawnUid: null,
  };

  // ---------------- data ----------------
  function setData(d) {
    S.data = d || null;
    S.asof = d && d.asof ? String(d.asof).slice(0, 10) : null;
    S.markets = new Map((d && Array.isArray(d.scoreboard) ? d.scoreboard : []).filter(m => m && m.key).map(m => [m.key, m]));
    // Public stock rows: per-market breakdowns first, then the picks (which carry the
    // long-run average and the reasons) — the same fields the Overview already shows.
    const pub = new Map();
    const merge = r => {
      if (!r || !r.ticker) return;
      const t = String(r.ticker).toUpperCase();
      const row = Object.assign(pub.get(t) || {}, r);
      if (!row.sector && r.kind) row.sector = r.kind;   // picks carry the sector as `kind`
      pub.set(t, row);
    };
    for (const rows of Object.values((d && d.stock_breakdown) || {})) (rows || []).forEach(merge);
    const tp = (d && d.top_picks) || {};
    [...((tp.on_sale && tp.on_sale.stocks) || []), ...(tp.stocks || [])].forEach(merge);
    S.pubStocks = pub;
  }

  // The signed-in user changed (sign-in, sign-out, another account): drop their data.
  function syncUser() {
    const u = uid();
    if (u === S.uid) return false;
    S.uid = u;
    S.lists = null; S.listsP = null; S.listsErr = null;
    S.trusted = false; S.snap = null; S.stocksP = null; S.stocksDone = false;
    S.alerts = null; S.alertsP = null; S.alertsErr = null;
    S.form = null; S.msg = ''; S.alertMsg = '';
    return true;
  }

  // What went wrong with the last Auth call, in words for this view.
  function errText(what) {
    const e = auth() && auth().lastError;
    if (e && e.notAvailable) return `${what} aren't available yet — they appear after the next daily data run.`;
    if (e && e.code === '23505') return 'You already have a list with that name.';
    if (e && e.code === 'network') return 'Network error — check the connection and try again.';
    if (e && e.message) return String(e.message).slice(0, 200);
    return 'Something went wrong — try again.';
  }

  function loadLists(force) {
    syncUser();
    if (!signedIn()) { S.lists = []; return Promise.resolve(S.lists); }
    if (S.listsP && !force) return S.listsP;
    const me = S.uid;
    const p = S.listsP = (async () => {
      let ls = [];
      try { ls = await auth().listWatchlists(); } catch { ls = []; }
      const e = auth().lastError;
      if (me !== S.uid || p !== S.listsP) return S.lists;
      const failed = !!(e && (!ls || !ls.length));
      S.listsErr = failed ? { notAvailable: !!e.notAvailable, message: errText('Watchlists') } : null;
      // A blip on a reload keeps the lists already on screen.
      if (!(failed && !e.notAvailable && S.lists && S.lists.length)) S.lists = Array.isArray(ls) ? ls : [];
      return S.lists;
    })();
    p.then(() => { if (p === S.listsP) afterListsChange(); }, () => {});
    return p;
  }

  // Trusted viewers' stock rows come from the owner's snapshot (RLS-gated); nobody else's do.
  function loadStocks() {
    syncUser();
    if (!signedIn()) { S.stocksDone = true; return Promise.resolve(null); }
    if (S.stocksP) return S.stocksP;
    const me = S.uid;
    const p = S.stocksP = (async () => {
      let trusted = false, snap = null;
      try { trusted = await auth().isTrusted(); } catch { trusted = false; }
      if (trusted) { try { snap = await auth().stockSnapshot(); } catch { snap = null; } }
      if (me !== S.uid) return null;
      S.trusted = !!trusted; S.snap = snap || null; S.stocksDone = true;
      // A snapshot that failed to load, or a trust check that failed (blip, timeout —
      // not a definite "no"), shouldn't stick for the session: the next visit retries.
      const a = auth();
      if ((trusted && !snap) || (!trusted && a.trustUnknown && a.trustUnknown())) S.stocksP = null;
      return S.snap;
    })();
    return p;
  }

  function loadAlerts() {
    syncUser();
    if (!signedIn()) { S.alerts = []; return Promise.resolve([]); }
    const me = S.uid;
    const p = S.alertsP = (async () => {
      let rows = [];
      try { rows = await auth().listAlerts({ limit: ALERTS_LIMIT }); } catch { rows = []; }
      const e = auth().lastError;
      if (me !== S.uid || p !== S.alertsP) return S.alerts;
      S.alertsErr = e && (!rows || !rows.length) ? { notAvailable: !!e.notAvailable, message: errText('Alerts') } : null;
      S.alerts = Array.isArray(rows) ? rows : [];
      return S.alerts;
    })();
    return p;
  }

  // ---------------- membership ----------------
  const customLists = () => (S.lists || []).filter(l => l && l.id);
  const starredStocksList = () => customLists().find(l => l.name === STARRED_STOCKS) || null;
  const has = (l, kind, key) => (l.items || []).some(i => i.kind === kind && i.key === key);
  const watched = key => { try { return !!auth().isWatched(key); } catch { return false; } };

  function isStarred(kind, key) {
    if (!signedIn()) return false;
    if (kind === 'market' && watched(key)) return true;
    return customLists().some(l => has(l, kind, key));
  }

  // The built-in list's rows: markets on user_watchlist, in scoreboard order.
  function builtinItems() {
    if (!signedIn()) return [];
    return [...S.markets.keys()].filter(watched).map(key => ({ kind: 'market', key }));
  }

  function localAdd(listId, kind, key) {
    const l = customLists().find(x => x.id === listId);
    if (l && !has(l, kind, key)) l.items = [{ kind, key, added_at: new Date().toISOString() }, ...(l.items || [])];
  }
  function localRemove(listId, kind, key) {
    const l = customLists().find(x => x.id === listId);
    if (l) l.items = (l.items || []).filter(i => !(i.kind === kind && i.key === key));
  }

  // ---------------- the star control ----------------
  const okKind = k => k === 'market' || k === 'stock';
  function starState(kind, key) {
    if (!authOn()) return { on: false, title: 'Watchlists need sign-in, which isn\'t configured on this deployment', dis: true };
    if (!signedIn()) return { on: false, title: 'Sign in to keep watchlists', dis: false };
    const on = isStarred(kind, key);
    return { on, title: on ? 'In your watchlists — change lists' : 'Add to a watchlist', dis: false };
  }

  function starHTML(kind, key) {
    try {
      key = String(key ?? '');
      if (!okKind(kind) || !ITEM_KEY_RE.test(key)) return '';
      // Membership needs the user's lists; fetch them once, then repaint every star.
      if (signedIn() && (S.uid !== uid() || (!S.lists && !S.listsP))) loadLists();
      const st = starState(kind, key);
      return `<button type="button" class="lst-star${st.on ? ' on' : ''}${st.dis ? ' dis' : ''}" data-lst-star="${kind}"
        data-lst-key="${esc(key)}" aria-haspopup="dialog" aria-label="${esc(st.title)}: ${esc(key)}" title="${esc(st.title)}">${st.on ? '★' : '☆'}</button>`;
    } catch { return ''; }
  }

  // Repaint stars in place (no re-render of their containers).
  function updateStars(root) {
    try {
      const r = root && root.querySelectorAll ? root : document;
      r.querySelectorAll('[data-lst-star]').forEach(b => {
        const st = starState(b.dataset.lstStar, b.dataset.lstKey);
        b.classList.toggle('on', st.on);
        b.classList.toggle('dis', st.dis);
        b.textContent = st.on ? '★' : '☆';
        b.title = st.title;
        b.setAttribute('aria-label', `${st.title}: ${b.dataset.lstKey}`);
      });
    } catch { /* detached */ }
  }
  // Kept for callers (app.js, ScreenBox) that bind after rendering: clicks are delegated
  // at the document, so binding is just a repaint.
  const bindStars = root => updateStars(root);

  function afterListsChange() {
    updateStars();
    if (P) renderPicker();
    if (visible('lists')) renderLists();
  }

  // ---------------- list picker popover ----------------
  let P = null;   // {pop, btn, kind, key, busy, msg}

  function openPicker(btn) {
    const kind = btn.dataset.lstStar, key = btn.dataset.lstKey;
    if (!okKind(kind) || !ITEM_KEY_RE.test(key || '')) return;
    if (P && P.btn === btn) { closePicker(); return; }
    closePicker();
    if (!authOn()) return;
    const pop = document.createElement('div');
    pop.className = 'lst-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', `Watchlists for ${key}`);
    P = { pop, btn, kind, key, busy: false, msg: '' };
    document.body.appendChild(pop);
    renderPicker();
    if (signedIn() && (!S.lists || S.uid !== uid())) loadLists();
    const first = pop.querySelector('input, button');
    if (first) { try { first.focus({ preventScroll: true }); } catch { /* old browser */ } }
  }

  function closePicker({ refocus = false } = {}) {
    if (!P) return;
    const { pop, btn } = P;
    P = null;
    try { pop.remove(); } catch { /* gone */ }
    if (refocus && btn && btn.isConnected) { try { btn.focus({ preventScroll: true }); } catch { /* gone */ } }
  }

  function placePicker() {
    if (!P) return;
    const { pop, btn } = P;
    if (!btn.isConnected) { closePicker(); return; }
    const r = btn.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = Math.min(280, vw - 16);
    pop.style.width = `${w}px`;
    const h = pop.offsetHeight || 200;
    const left = Math.max(8, Math.min(r.right - w, vw - w - 8));
    let top = r.bottom + 6;
    if (top + h > vh - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  }

  function pickerRows() {
    const { kind, key } = P;
    const rows = [];
    if (kind === 'market') rows.push({ id: BUILTIN, name: 'Starred markets', on: watched(key), builtin: true });
    else {
      const ss = starredStocksList();
      rows.push(ss ? { id: ss.id, name: ss.name, on: has(ss, kind, key) } : { id: NEW_STARRED, name: STARRED_STOCKS, on: false });
    }
    for (const l of customLists()) {
      if (l.name === STARRED_STOCKS) continue;
      rows.push({ id: l.id, name: l.name, on: has(l, kind, key) });
    }
    return rows;
  }

  function renderPicker() {
    if (!P) return;
    const { pop, kind, key, busy, msg } = P;
    const label = kind === 'market' ? (S.markets.get(key)?.name || key) : key;
    let body;
    if (!signedIn()) {
      body = `<p class="lst-pop-p">Sign in to keep watchlists and get alerts when a saved screen changes.</p>
        <button type="button" class="lst-btn lst-btn-pri" data-lst-act="signin">Sign in</button>`;
    } else if (!S.lists && S.listsP) {
      body = '<p class="lst-pop-p lst-muted">Loading your lists…</p>';
    } else {
      const rows = pickerRows();
      // The built-in markets list predates 0015; custom lists need it.
      const custom = !(S.listsErr && S.listsErr.notAvailable);
      body = `<div class="lst-pop-list">${rows.filter(r => r.builtin || custom).map(r => `
          <label class="lst-pop-row"><input type="checkbox" data-lst-pick="${esc(r.id)}"${r.on ? ' checked' : ''}${busy ? ' disabled' : ''}>
            <span>${r.builtin ? '★ ' : ''}${esc(r.name)}</span></label>`).join('')}</div>
        ${custom ? `<form class="lst-pop-new" data-lst-newform>
          <input type="text" class="lst-in" maxlength="60" placeholder="New list…" aria-label="New list name" autocomplete="off"${busy ? ' disabled' : ''}>
          <button type="submit" class="lst-btn"${busy ? ' disabled' : ''}>Add</button></form>`
          : `<p class="lst-pop-p lst-muted">${esc(S.listsErr.message)}</p>`}`;
    }
    pop.innerHTML = `<div class="lst-pop-h"><b>${esc(label)}</b><button type="button" class="lst-x" data-lst-act="close" aria-label="Close">×</button></div>
      ${body}
      ${msg ? `<p class="lst-pop-p lst-err" role="alert">${esc(msg)}</p>` : ''}
      ${signedIn() ? '<a class="lst-pop-link" href="#/lists" data-lst-act="golists">Open watchlists →</a>' : ''}`;
    placePicker();
  }

  // Busy: disable the picker's inputs in place (a re-render would swap the checkbox under
  // the pointer); the re-render after the write shows the stored state.
  function pickerBusy(cur) {
    cur.busy = true; cur.msg = '';
    cur.pop.querySelectorAll('input, button:not([data-lst-act])').forEach(x => { x.disabled = true; });
  }

  async function pickToggle(id, on) {
    if (!P || P.busy) return;
    const cur = P, { kind, key } = cur;
    const A = auth();
    pickerBusy(cur);
    let ok = false, msg = '';
    try {
      if (id === BUILTIN) {
        if (watched(key) === on) ok = true;
        else {
          try { ok = (await A.toggleWatch(key)) === on; } catch { ok = false; }
          if (!ok) msg = 'Couldn\'t update Starred markets — try again.';
        }
      } else if (id === NEW_STARRED) {
        const lid = on ? await A.ensureList(STARRED_STOCKS) : null;
        ok = !!(lid && await A.addItem(lid, kind, key));
        if (!ok) msg = errText('Watchlists');
        else { await loadLists(true); }
      } else {
        ok = on ? await A.addItem(id, kind, key) : await A.removeItem(id, kind, key);
        if (ok) { if (on) localAdd(id, kind, key); else localRemove(id, kind, key); }
        else msg = errText('Watchlists');
      }
    } catch { ok = false; msg = 'Something went wrong — try again.'; }
    if (P === cur) { cur.busy = false; cur.msg = msg; }
    afterListsChange();
  }

  async function pickNew(name) {
    if (!P || P.busy) return;
    const cur = P, { kind, key } = cur;
    name = String(name ?? '').trim().slice(0, 60);
    if (!name) return;
    const A = auth();
    pickerBusy(cur);
    let msg = '';
    try {
      const existing = customLists().find(l => l.name === name);
      const l = existing || await A.createList(name);
      if (!l) msg = errText('Watchlists');
      else {
        if (!existing) S.lists = [...customLists(), { ...l, items: l.items || [] }];
        if (await A.addItem(l.id, kind, key)) localAdd(l.id, kind, key);
        else msg = errText('Watchlists');
      }
    } catch { msg = 'Something went wrong — try again.'; }
    if (P === cur) { cur.busy = false; cur.msg = msg; }
    afterListsChange();
  }

  function signIn() {
    closePicker();
    if (typeof showSignin === 'function') { try { showSignin(true); return; } catch { /* app's problem */ } }
    try { window.scrollTo(0, 0); } catch { /* headless */ }
  }

  // ---------------- views ----------------
  const viewEl = v => document.getElementById(`view-${v}`);
  const visible = v => { const el = viewEl(v); return !!(el && !el.hidden && S.shown === v); };

  function shell(inner) {
    return `<section class="lst">${inner}</section>`;
  }
  function gateHTML(what) {
    if (!authOn()) {
      return shell(`<div class="lst-card lst-empty">${esc(what)} need sign-in, which isn't available on this deployment right now.
        The Overview and the markets Screener work without it.</div>`);
    }
    return shell(`<div class="lst-card lst-empty">
      <p>Sign in to keep ${what === 'Alerts' ? 'alerts on your saved screens' : 'watchlists of markets and stocks'}.</p>
      <p class="lst-muted">${what === 'Alerts'
        ? 'Save a screen in the Screener with alerts on; each data run reports what entered or left it.'
        : 'Star a market or a stock anywhere on the page (☆) to add it to a list.'}</p>
      <button type="button" class="lst-btn lst-btn-pri" data-lst-act="signin">Sign in</button></div>`);
  }

  // ---- formatting (own copies: this module doesn't depend on app.js helpers) ----
  const f1 = v => isNum(v) ? v.toFixed(1) : '—';
  const pctS = v => isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—';
  const scoreColor = s => !isNum(s) ? '#475569' : s >= 70 ? '#34d399' : s >= 55 ? '#a3e635' : s >= 45 ? '#94a3b8' : s >= 30 ? '#fb923c' : '#f87171';
  const scoreCell = s => isNum(s)
    ? `<span class="lst-score"><span class="lst-bar"><i style="width:${Math.max(0, Math.min(100, s)).toFixed(0)}%;background:${scoreColor(s)}"></i></span><b style="color:${scoreColor(s)}">${s.toFixed(0)}</b></span>`
    : '—';
  const yrsS = y => !isNum(y) ? '' : Math.abs(y - Math.round(y)) < 0.15 ? `${y.toFixed(0)}y` : `${y.toFixed(1)}y`;
  function priceS(v) {
    if (!isNum(v)) return '—';
    if (typeof money === 'function') { try { return money(v); } catch { /* fall through */ } }
    return `$${v >= 1000 ? v.toFixed(0) : v.toFixed(2)}`;
  }
  const FLAGS = [
    ['on_sale', 'on sale', '#60a5fa'], ['garp', 'GARP', '#2dd4bf'], ['steady_compounder', 'steady compounder', '#a78bfa'],
    ['deep_value_intact', 'deep value, intact', '#34d399'], ['fundamentally_strong', 'fundamentally strong', '#34d399'],
    ['turning_up', 'turning up', '#2dd4bf'], ['value_trap', 'trap', '#fbbf24'], ['overvalued', 'rich', '#f87171'],
  ];
  // picks.exclusion_reasons codes, in the screener's wording (screenbox.js REASONS).
  const FLAG_TEXT = { foreign_listing: 'foreign listing', non_usd_reporter: 'non-USD reporter', implausible_pe: 'implausible P/E',
    implausible_ps: 'implausible P/S', below_min_mcap: 'below the minimum market cap', short_history: 'short filing history' };
  const flagText = c => FLAG_TEXT[c] || (/^quality:/.test(c) ? `open data check (${String(c).slice(8).replace(/_/g, ' ')})` : String(c).replace(/_/g, ' '));
  function flagsHTML(r, kind) {
    const out = FLAGS.filter(([k]) => r[k] === true).map(([, l, c]) => `<span class="lst-pill" style="background:${c}22;color:${c}">${esc(l)}</span>`);
    const bad = kind === 'market' ? r.data_sane === false : r.data_ok === false;
    if (bad) {
      const why = Array.isArray(r.data_flags) && r.data_flags.length ? r.data_flags.map(flagText).join(', ') : 'failed the data sanity check';
      out.push(`<span class="lst-pill lst-pill-warn" title="${esc(why)}">⚠ data</span>`);
    }
    return out.join(' ') || '<span class="lst-muted">—</span>';
  }

  // The row a viewer may see for an item, and why there isn't one.
  function resolve(item) {
    if (item.kind === 'market') {
      const m = S.markets.get(item.key);
      return m ? { row: m, src: 'market' } : { row: null, why: S.data ? 'Not in this week\'s scoreboard' : 'Loading market data…' };
    }
    const t = String(item.key).toUpperCase();
    if (S.trusted && S.snap && S.snap.byTicker) {
      const r = S.snap.byTicker.get(t);
      return r ? { row: r, src: 'snapshot' } : { row: S.pubStocks.get(t) || null, src: 'public', why: 'Not in the latest stock snapshot' };
    }
    const r = S.pubStocks.get(t);
    return r ? { row: r, src: 'public' } : { row: null, why: 'Stock data limited to owner' };
  }

  const COLS = [
    { key: 'name', label: 'Name', l: true, get: r => r.name },
    { key: 'pe', label: 'P/E', get: r => r.pe, fmt: v => f1(v) },
    { key: 'value_score', label: 'Value', get: r => r.value_score, fmt: scoreCell },
    { key: 'growth_score', label: 'Growth', title: 'Growth score — the business\'s revenue/earnings record (fundamentals), never price', get: r => r.growth_score, fmt: scoreCell },
    { key: 'opportunity_score', label: 'Opportunity', title: 'Blend: value + fundamental growth + some price momentum / mean-reversion — not a growth measure', get: r => r.opportunity_score, fmt: scoreCell },
    { key: 'discount_long', label: 'vs long-run avg', title: 'Price vs its long-run average price; the window is shown per row (stock prices cover ~2 years so far)', get: r => r.discount_long,
      fmt: (v, r) => isNum(v) ? `<span style="color:${v < 0 ? '#34d399' : '#f87171'}">${pctS(v)}</span>${yrsS(r.long_avg_years) ? ` <small class="lst-muted">${yrsS(r.long_avg_years)}</small>` : ''}` : '—' },
    { key: '_flags', label: 'Flags', l: true, nosort: true },
    { key: 'price', label: 'Price', trusted: true, get: r => r.price, fmt: v => priceS(v) },
  ];
  const cols = () => COLS.filter(c => !c.trusted || S.trusted);

  function sortItems(items) {
    const { key, dir } = S.sort;
    const c = COLS.find(x => x.key === key);
    if (!c || !c.get) return items;
    const val = it => { const r = resolve(it).row; const v = r ? c.get(r) : null; return v == null || (typeof v === 'number' && !isFinite(v)) ? null : v; };
    return items.map((it, i) => ({ it, i, v: val(it) })).sort((a, b) => {
      if (a.v == null && b.v == null) return a.i - b.i;
      if (a.v == null) return 1;
      if (b.v == null) return -1;
      const d = typeof a.v === 'number' && typeof b.v === 'number' ? a.v - b.v : String(a.v).localeCompare(String(b.v));
      return d * dir || a.i - b.i;
    }).map(x => x.it);
  }

  function rowHTML(item, removable) {
    const { row, why } = resolve(item);
    const sym = item.kind === 'market' ? (row && row.symbol) || item.key : item.key;
    const sub = item.kind === 'market' ? 'market' : (row && row.sector) || 'stock';
    const dash = `<span class="lst-muted" title="${esc(why || '')}">—</span>`;
    const cells = cols().map(c => {
      if (c.key === '_flags') return `<td class="lst-l">${row ? flagsHTML(row, item.kind) : dash}</td>`;
      if (!row) return `<td class="${c.l ? 'lst-l' : ''}">${dash}</td>`;
      const v = c.get(row);
      if (c.key === 'name') return `<td class="lst-l lst-name" title="${esc(v || '')}">${esc(v || '—')}</td>`;
      return `<td>${c.fmt ? c.fmt(v, row) : esc(v ?? '—')}</td>`;
    }).join('');
    const rm = removable
      ? `<td class="lst-rm"><button type="button" class="lst-x" data-lst-remove="${esc(item.kind)}:${esc(item.key)}" title="Remove from this list" aria-label="Remove ${esc(sym)} from this list">×</button></td>`
      : '<td></td>';
    return `<tr data-lst-open="${esc(item.kind)}:${esc(item.key)}" tabindex="0"${row ? '' : ' class="lst-nodata"'}>
      <td class="lst-sticky">${starHTML(item.kind, item.key)}<span class="lst-id"><b>${esc(sym)}</b><small>${esc(sub)}</small></span></td>
      ${cells}${rm}</tr>`;
  }

  function selectedList() {
    if (S.sel === BUILTIN) return { id: BUILTIN, name: 'Starred markets', builtin: true, items: builtinItems() };
    const l = customLists().find(x => x.id === S.sel);
    return l ? { ...l, items: l.items || [] } : { id: BUILTIN, name: 'Starred markets', builtin: true, items: builtinItems() };
  }

  function asofText() {
    const parts = [];
    if (S.asof) parts.push(`markets as of ${esc(S.asof)}`);
    if (S.trusted && S.snap && S.snap.asof) parts.push(`stocks as of ${esc(String(S.snap.asof).slice(0, 10))}`);
    else if (S.asof && S.pubStocks.size) parts.push(`published stock figures as of ${esc(S.asof)}`);
    return parts.join(' · ');
  }

  function renderLists() {
    const el = viewEl('lists');
    if (!el) return;
    if (!signedIn()) { el.innerHTML = gateHTML('Watchlists'); return; }
    if (!S.lists) { el.innerHTML = shell('<div class="lst-card lst-empty lst-muted">Loading your watchlists…</div>'); return; }
    const l = selectedList();
    if (l.id !== S.sel) S.sel = l.id;
    const notAvail = S.listsErr && S.listsErr.notAvailable;
    const tabs = [{ id: BUILTIN, name: '★ Starred markets', n: builtinItems().length },
      ...customLists().map(x => ({ id: x.id, name: x.name, n: (x.items || []).length }))]
      .map(t => `<button type="button" role="tab" class="lst-tab${t.id === l.id ? ' on' : ''}" aria-selected="${t.id === l.id}"
          data-lst-sel="${esc(t.id)}">${esc(t.name)} <span class="lst-n">${t.n}</span></button>`).join('');
    let form = '';
    if (S.form === 'new') {
      form = `<form class="lst-form" data-lst-form="new"><input type="text" class="lst-in" maxlength="60" placeholder="List name" aria-label="New list name" autocomplete="off">
        <button type="submit" class="lst-btn lst-btn-pri">Create</button><button type="button" class="lst-btn" data-lst-act="cancel">Cancel</button></form>`;
    } else if (S.form === 'rename' && !l.builtin) {
      form = `<form class="lst-form" data-lst-form="rename"><input type="text" class="lst-in" maxlength="60" value="${esc(l.name)}" aria-label="List name" autocomplete="off">
        <button type="submit" class="lst-btn lst-btn-pri">Rename</button><button type="button" class="lst-btn" data-lst-act="cancel">Cancel</button></form>`;
    } else if (S.form === 'delete' && !l.builtin) {
      form = `<div class="lst-form lst-confirm">Delete “${esc(l.name)}” and its ${l.items.length} item${l.items.length === 1 ? '' : 's'}?
        <button type="button" class="lst-btn lst-btn-danger" data-lst-act="delete-yes">Delete</button><button type="button" class="lst-btn" data-lst-act="cancel">Cancel</button></div>`;
    }
    const nStocks = l.items.filter(i => i.kind === 'stock').length, nMarkets = l.items.filter(i => i.kind === 'market').length;
    const screenBtns = [
      nMarkets ? `<button type="button" class="lst-btn" data-lst-screen="markets">Screen ${nMarkets === 1 ? 'this market' : `these ${nMarkets} markets`}</button>` : '',
      nStocks ? `<button type="button" class="lst-btn" data-lst-screen="stocks"${S.trusted ? '' : ' disabled title="Stock-level screening is limited to approved accounts while the price-data licence is reviewed"'}>Screen ${nStocks === 1 ? 'this stock' : `these ${nStocks} stocks`}</button>` : '',
    ].join('');
    const manage = l.builtin ? '' : `<button type="button" class="lst-btn" data-lst-act="rename">Rename</button>
      <button type="button" class="lst-btn" data-lst-act="delete">Delete</button>`;
    const items = sortItems(l.items);
    const head = `<th class="lst-sticky lst-l">Symbol</th>${cols().map(c => c.nosort
      ? `<th class="${c.l ? 'lst-l' : ''}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.label)}</th>`
      : `<th class="${c.l ? 'lst-l' : ''}" data-lst-sort="${c.key}" tabindex="0"${c.title ? ` title="${esc(c.title)}"` : ''}
          aria-sort="${S.sort.key === c.key ? (S.sort.dir > 0 ? 'ascending' : 'descending') : 'none'}">${esc(c.label)}${S.sort.key === c.key ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}<th></th>`;
    const table = items.length
      ? `<div class="lst-tablebox"><table class="lst-table"><thead><tr>${head}</tr></thead>
          <tbody>${items.map(i => rowHTML(i, true)).join('')}</tbody></table></div>`
      : `<div class="lst-card lst-empty lst-muted">${l.builtin
          ? 'No starred markets yet. Open a market (Overview or Screener) and click ☆.'
          : 'This list is empty. Click ☆ on any market or stock — in a drawer, the Screener or a list — to add it here.'}</div>`;
    const limited = l.items.some(i => i.kind === 'stock') && !S.trusted
      ? ' Stock figures are shown only where this page already publishes them (top picks and per-market breakdowns); the full stock universe is limited to the owner while the price-data licence is reviewed.' : '';
    el.innerHTML = shell(`
      <div class="lst-head">
        <h2 class="lst-title">Watchlists</h2>
        <span class="lst-asof">${asofText()}</span>
        <span class="lst-spacer"></span>
        ${notAvail ? '' : '<button type="button" class="lst-btn lst-btn-pri" data-lst-act="new">+ New list</button>'}
      </div>
      ${notAvail ? `<div class="lst-note">${esc(S.listsErr.message)} Starred markets work already.</div>`
        : S.listsErr ? `<div class="lst-note lst-err">${esc(S.listsErr.message)}</div>` : ''}
      ${S.msg ? `<div class="lst-note lst-err" role="alert">${esc(S.msg)}</div>` : ''}
      <div class="lst-tabs" role="tablist" aria-label="Your watchlists">${tabs}</div>
      ${form}
      <div class="lst-toolbar">
        <span class="lst-muted">${l.items.length} item${l.items.length === 1 ? '' : 's'}</span>
        <span class="lst-spacer"></span>${screenBtns}${manage}
      </div>
      ${table}
      <p class="lst-foot">Snapshot figures, not live quotes: markets refresh weekly (Monday), stocks daily after the data run.
        Growth = the business's revenue / earnings record (fundamentals), never price moves.${limited}</p>`);
    const f = el.querySelector('[data-lst-form] input');
    if (f) { try { f.focus({ preventScroll: true }); if (S.form === 'rename') f.select(); } catch { /* old browser */ } }
  }

  // ---- alerts ----
  const keyLabel = (scope, k) => scope === 'markets' ? (S.markets.get(k)?.name || k) : k;
  function chipsHTML(keys, scope, cls) {
    return (keys || []).filter(k => ITEM_KEY_RE.test(String(k))).map(k => {
      const kind = scope === 'markets' ? 'market' : 'stock';
      return `<button type="button" class="lst-kchip ${cls}" data-lst-open="${kind}:${esc(k)}" title="Open ${esc(keyLabel(scope, k))}">${esc(keyLabel(scope, k))}</button>`;
    }).join('');
  }
  function alertHTML(a) {
    const scope = a.screen_scope === 'markets' ? 'markets' : 'stocks';
    const added = Array.isArray(a.added) ? a.added : [], removed = Array.isArray(a.removed) ? a.removed : [];
    const hidden = Array.isArray(a.hidden_data_issue) ? a.hidden_data_issue : [];
    const nA = isNum(a.n_added) ? a.n_added : added.length, nR = isNum(a.n_removed) ? a.n_removed : removed.length;
    const more = (n, shown) => n > shown ? ` <span class="lst-muted">+${n - shown} more</span>` : '';
    const name = a.screen_name ? esc(a.screen_name) : '<span class="lst-muted">(deleted screen)</span>';
    const link = a.screen_id && a.screen_name ? `<a class="lst-alink" href="#/screener?id=${encodeURIComponent(a.screen_id)}">${name}</a>` : name;
    return `<article class="alr-card${a.seen ? '' : ' unseen'}" data-alr-id="${esc(a.id)}">
      <div class="alr-top">
        ${a.seen ? '' : '<span class="alr-dot" title="Unseen"></span>'}
        <span class="alr-name">${link}</span>
        <span class="lst-pill">${scope === 'markets' ? 'Markets' : 'Stocks'}</span>
        <span class="lst-muted alr-date">data of ${esc(String(a.asof || '').slice(0, 10))}</span>
        <span class="lst-spacer"></span>
        ${a.seen ? '' : `<button type="button" class="lst-btn" data-alr-seen="${esc(a.id)}">Mark seen</button>`}
      </div>
      ${nA ? `<div class="alr-line"><span class="alr-lbl alr-in">Entered (${nA})</span><span class="alr-chips">${chipsHTML(added, scope, 'in')}${more(nA, added.length)}</span></div>` : ''}
      ${nR ? `<div class="alr-line"><span class="alr-lbl alr-out">Left (${nR})</span><span class="alr-chips">${chipsHTML(removed, scope, 'out')}${more(nR, removed.length)}</span></div>` : ''}
      ${hidden.length ? `<div class="alr-line"><span class="alr-lbl alr-hid" title="Dropped out because a data check failed, not because the numbers changed">Hidden by a data issue (${hidden.length})</span><span class="alr-chips">${chipsHTML(hidden, scope, 'hid')}</span></div>` : ''}
    </article>`;
  }

  function renderAlerts() {
    const el = viewEl('alerts');
    if (!el) return;
    if (!signedIn()) { el.innerHTML = gateHTML('Alerts'); return; }
    if (!S.alerts) { el.innerHTML = shell('<div class="lst-card lst-empty lst-muted">Loading alerts…</div>'); return; }
    const rows = S.alerts.slice().sort((a, b) => (a.seen === b.seen ? 0 : a.seen ? 1 : -1)
      || String(b.created_at || b.asof || '').localeCompare(String(a.created_at || a.asof || '')));
    const unseen = rows.filter(a => !a.seen);
    const body = S.alertsErr
      ? `<div class="lst-card lst-empty${S.alertsErr.notAvailable ? ' lst-muted' : ' lst-err'}">${esc(S.alertsErr.message)}</div>`
      : rows.length ? rows.map(alertHTML).join('')
        : `<div class="lst-card lst-empty lst-muted">No alerts yet. Save a screen in the <a href="#/screener" class="lst-alink">Screener</a> with alerts on;
           the first check sets a baseline, and later checks report what entered or left it.</div>`;
    el.innerHTML = shell(`
      <div class="lst-head">
        <h2 class="lst-title">Alerts</h2>
        <span class="lst-asof">${unseen.length ? `${unseen.length} unseen` : 'all caught up'}</span>
        <span class="lst-spacer"></span>
        ${unseen.length ? '<button type="button" class="lst-btn" data-alr-allseen>Mark all seen</button>' : ''}
      </div>
      ${S.alertMsg ? `<div class="lst-note lst-err" role="alert">${esc(S.alertMsg)}</div>` : ''}
      <p class="lst-foot lst-foot-top">Stock screens are checked daily after the data run, market screens weekly (Monday refresh).
        Membership uses every match, not just the rows shown; the first check sets a baseline. Alerts are kept 120 days.</p>
      <div class="alr-list">${body}</div>`);
  }

  async function markSeen(ids) {
    ids = ids.filter(Boolean);
    if (!ids.length) return;
    let ok = false;
    try { ok = await auth().markSeen(ids); } catch { ok = false; }
    S.alertMsg = ok ? '' : errText('Alerts');
    if (ok && S.alerts) { const set = new Set(ids.map(String)); S.alerts.forEach(a => { if (set.has(String(a.id))) a.seen = true; }); }
    if (visible('alerts')) renderAlerts();
    refreshBadge();
  }

  // ---- open / screen ----
  function openItem(kind, key) {
    try {
      if (kind === 'stock') {
        if (typeof openStockDrawer === 'function') openStockDrawer(key);
        else location.hash = `#/stock/${encodeURIComponent(key)}`;
      } else if (typeof openDrawer === 'function' && S.markets.has(key)) openDrawer(key);
      else location.hash = `#/market/${encodeURIComponent(key)}`;
    } catch { /* drawer's problem */ }
  }

  function screenList(scope) {
    const l = selectedList();
    const kind = scope === 'stocks' ? 'stock' : 'market';
    const keys = [...new Set(l.items.filter(i => i.kind === kind).map(i => kind === 'stock' ? String(i.key).toUpperCase() : i.key))].slice(0, SCREEN_MAX);
    if (!keys.length) return;
    const D = typeof ScreenDSL !== 'undefined' && ScreenDSL.isReady && ScreenDSL.isReady() ? ScreenDSL : null;
    const filter = { v: 1, scope, where: [{ field: scope === 'stocks' ? 'ticker' : 'key', op: 'in', value: keys }],
      sort: { field: 'value_score', dir: 'desc' }, limit: Math.min(SCREEN_MAX, Math.max(100, keys.length)), include_flagged: true };
    if (!D) { S.msg = 'The screener\'s field list didn\'t load — try reloading the page.'; renderLists(); return; }
    const v = D.validate(filter, scope);
    if (!v.ok) { S.msg = `Couldn't build that screen: ${v.errors.slice(0, 2).join('; ')}`; renderLists(); return; }
    if (typeof Screener !== 'undefined' && Screener.openWithFilter) {
      try { Screener.openWithFilter(v.filter); } catch { /* the router shows the screener anyway */ }
      location.hash = '#/screener';
    } else {
      const enc = D.encodeFilter && D.encodeFilter(v.filter);
      if (enc) location.hash = `#/screener?s=${enc}`;
    }
  }

  // ---------------- events (delegated; namespaced data-lst-* / data-alr-*) ----------------
  async function onViewClick(e) {
    const t = e.target;
    if (t.closest('[data-lst-star]')) return;   // the document-level star handler
    const act = t.closest('[data-lst-act]');
    if (act) {
      const a = act.dataset.lstAct;
      if (a === 'signin') { signIn(); return; }
      if (a === 'new' || a === 'rename' || a === 'delete') { S.form = S.form === a ? null : a; S.msg = ''; renderLists(); return; }
      if (a === 'cancel') { S.form = null; renderLists(); return; }
      if (a === 'delete-yes') {
        const l = selectedList();
        if (l.builtin) return;
        const ok = await auth().deleteList(l.id);
        if (ok) { S.lists = customLists().filter(x => x.id !== l.id); S.sel = BUILTIN; lsSet(LS_SEL, BUILTIN); S.form = null; S.msg = ''; }
        else S.msg = errText('Watchlists');
        afterListsChange();
        return;
      }
    }
    const sel = t.closest('[data-lst-sel]');
    if (sel) { S.sel = sel.dataset.lstSel; lsSet(LS_SEL, S.sel); S.form = null; S.msg = ''; S.sort = { key: null, dir: -1 }; renderLists(); return; }
    const srt = t.closest('[data-lst-sort]');
    if (srt) { sortBy(srt.dataset.lstSort); return; }
    const sc = t.closest('[data-lst-screen]');
    if (sc && !sc.disabled) { screenList(sc.dataset.lstScreen); return; }
    const rm = t.closest('[data-lst-remove]');
    if (rm) { removeFromSelected(rm.dataset.lstRemove); return; }
    const seen = t.closest('[data-alr-seen]');
    if (seen) { markSeen([seen.dataset.alrSeen]); return; }
    if (t.closest('[data-alr-allseen]')) { markSeen((S.alerts || []).filter(a => !a.seen).map(a => a.id).slice(0, 500)); return; }
    const open = t.closest('[data-lst-open]');
    if (open) {
      const s = open.dataset.lstOpen, i = s.indexOf(':');
      openItem(s.slice(0, i), s.slice(i + 1));
    }
  }

  function sortBy(key) {
    S.sort = S.sort.key === key ? { key, dir: -S.sort.dir } : { key, dir: key === 'name' ? 1 : -1 };
    renderLists();
  }

  async function removeFromSelected(spec) {
    const i = spec.indexOf(':'), kind = spec.slice(0, i), key = spec.slice(i + 1);
    const l = selectedList();
    let ok = false;
    try {
      if (l.builtin) { ok = !watched(key) || (await auth().toggleWatch(key)) === false; }
      else { ok = await auth().removeItem(l.id, kind, key); if (ok) localRemove(l.id, kind, key); }
    } catch { ok = false; }
    S.msg = ok ? '' : errText('Watchlists');
    afterListsChange();
  }

  async function onViewSubmit(e) {
    const f = e.target.closest('[data-lst-form]');
    if (!f) return;
    e.preventDefault();
    const name = String(f.querySelector('input')?.value || '').trim().slice(0, 60);
    if (!name) return;
    const A = auth();
    if (f.dataset.lstForm === 'new') {
      const l = await A.createList(name);
      if (l) { S.lists = [...customLists(), { ...l, items: l.items || [] }]; S.sel = l.id; lsSet(LS_SEL, l.id); S.form = null; S.msg = ''; }
      else S.msg = errText('Watchlists');
    } else if (f.dataset.lstForm === 'rename') {
      const l = selectedList();
      if (l.builtin) return;
      if (await A.renameList(l.id, name)) { const x = customLists().find(y => y.id === l.id); if (x) x.name = name; S.form = null; S.msg = ''; }
      else S.msg = errText('Watchlists');
    }
    afterListsChange();
  }

  function onViewKey(e) {
    const t = e.target;
    if (e.key === 'Escape' && S.form && t.closest('[data-lst-form]')) { e.stopPropagation(); S.form = null; renderLists(); return; }
    if (e.key !== 'Enter' && e.key !== ' ') return;
    if (t.matches('[data-lst-sort]')) { e.preventDefault(); sortBy(t.dataset.lstSort); return; }
    if (t.matches('tr[data-lst-open]')) {
      e.preventDefault();
      const s = t.dataset.lstOpen, i = s.indexOf(':');
      openItem(s.slice(0, i), s.slice(i + 1));
    }
  }

  function bindView(el) {
    if (!el || el.dataset.lstBound) return;
    el.dataset.lstBound = '1';
    el.addEventListener('click', e => { onViewClick(e).catch(() => { /* view re-renders on the next change */ }); });
    el.addEventListener('submit', e => { onViewSubmit(e).catch(() => {}); });
    el.addEventListener('keydown', onViewKey);
  }

  // ---------------- public ----------------
  function show(view) {
    view = view === 'alerts' ? 'alerts' : 'lists';
    S.shown = view;
    closePicker();
    syncUser();
    S.drawnUid = uid();
    const el = viewEl(view);
    if (!el) return;
    bindView(el);
    if (view === 'lists') {
      renderLists();
      if (signedIn()) {
        loadLists(true);                      // fresh on every visit (other devices)
        loadStocks().then(() => { if (visible('lists')) renderLists(); });
      }
    } else {
      renderAlerts();
      if (signedIn()) loadAlerts().then(() => { if (visible('alerts')) renderAlerts(); refreshBadge(); });
    }
  }

  function setBadge(n) {
    if (typeof setAlertsBadge === 'function') { try { setAlertsBadge(n); return; } catch { /* fall through */ } }
    const b = document.getElementById('alr-badge');
    if (!b) return;
    b.textContent = n > 99 ? '99+' : String(n);
    b.hidden = n <= 0;
  }

  async function unseenCount() {
    if (!signedIn()) return 0;
    try { const n = Number(await auth().unseenCount()); return isFinite(n) && n > 0 ? n : 0; } catch { return 0; }
  }

  async function refreshBadge() {
    const n = await unseenCount();
    setBadge(n);
    return n;
  }

  function refresh() {
    syncUser();
    S.lists = null; S.listsP = null; S.stocksP = null; S.alerts = null; S.alertsP = null;
    if (signedIn()) loadLists(true);
    if (visible('lists')) show('lists');
    else if (visible('alerts')) show('alerts');
    else updateStars();
    return refreshBadge();
  }

  if (typeof document !== 'undefined') {
    // One delegated handler for every star on the page (drawers, screener, lists).
    document.addEventListener('click', e => {
      const t = e.target;
      const star = t && t.closest ? t.closest('[data-lst-star]') : null;
      if (star) {
        e.preventDefault();
        if (star.classList.contains('dis')) return;
        try { openPicker(star); } catch { closePicker(); }
        return;
      }
      if (!P || !t || !t.closest) return;
      if (!P.pop.contains(t)) { closePicker(); return; }
      const act = t.closest('[data-lst-act]');
      if (act && act.dataset.lstAct === 'close') { closePicker({ refocus: true }); return; }
      if (act && act.dataset.lstAct === 'signin') { signIn(); return; }
      if (act && act.dataset.lstAct === 'golists') { closePicker(); return; }
    });
    document.addEventListener('change', e => {
      const cb = e.target && e.target.closest ? e.target.closest('[data-lst-pick]') : null;
      if (!cb || !P || !P.pop.contains(cb)) return;
      pickToggle(cb.dataset.lstPick, cb.checked).catch(() => {});
    });
    document.addEventListener('submit', e => {
      const f = e.target && e.target.closest ? e.target.closest('[data-lst-newform]') : null;
      if (!f || !P || !P.pop.contains(f)) return;
      e.preventDefault();
      pickNew(f.querySelector('input')?.value).catch(() => {});
    });
    // Capture on window: Escape closes the picker before app.js's handler closes the drawer.
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && P) { e.stopPropagation(); closePicker({ refocus: true }); }
    }, true);
    const reflow = () => { if (P) placePicker(); };
    window.addEventListener('resize', reflow);
    window.addEventListener('scroll', reflow, true);

    document.addEventListener('dashboard:data', e => {
      const d = e && e.detail;
      if (d && d.ok && d.data) setData(d.data);
      if (visible('lists')) renderLists();
      if (visible('alerts')) renderAlerts();
    });
  }
  if (typeof Auth !== 'undefined' && Auth && Auth.onChange) {
    // Fires on sign-in/out AND on hourly token refreshes: only a different user re-renders,
    // so a refresh never wipes a half-typed list name. (Compared with the user the views
    // were last drawn for — app.js's own listener runs first and may already have synced
    // the caches through starHTML.)
    Auth.onChange(() => {
      syncUser();
      const u = uid(), changed = u !== S.drawnUid;
      S.drawnUid = u;
      if (!signedIn()) closePicker();
      if (!changed) { updateStars(); return; }
      if (signedIn()) loadLists();
      if (visible('lists')) show('lists');
      else if (visible('alerts')) show('alerts');
      updateStars();
      if (P) renderPicker();
    });
  }

  return { show, starHTML, bindStars, refresh, refreshBadge, unseenCount };
})();
