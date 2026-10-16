// Global Index Valuation Agent — Supabase Auth + per-user data (Phase D ADR-026; ADR-037).
// No-build: supabase-js loaded from CDN in index.html (window.supabase). Degrades
// to "unavailable" when SUPABASE_URL/ANON_KEY aren't configured (empty in
// dashboard_data.json's meta.supabase, or the CDN script failed to load) —
// callers MUST check Auth.available() before showing sign-in/watchlist UI; the
// existing anonymous localStorage pin/dismiss flow (app.js) keeps working either way.
//
// ADR-037 adds saved screens, watchlists, screen alerts and the trusted-only stock
// snapshot / chart series. Every one of those methods resolves gracefully — null, []
// or false — when auth is unavailable, the caller is signed out, or PostgREST says the
// table isn't there yet (404 / PGRST205 / 42P01: migration 0015 lands with the first
// daily run after merge, up to ~24 h after the frontend deploys). They never throw;
// Auth.lastError says what went wrong, and `notAvailable: true` means "not deployed
// yet" rather than a real failure, so the UI can say so instead of showing an error.
// The real gate is RLS (0015); nothing here decides what a user may see.

const Auth = (() => {
  let client = null;
  let user = null;
  let watchlistKeys = new Set();
  const listeners = [];
  let authError = null;      // human message from a failed magic link, see readAuthError()
  let lastError = null;      // {code, status, notAvailable, message} of the last failed call

  // Per-user caches — cleared whenever the signed-in user changes. Token refreshes
  // (about hourly) fire onAuthStateChange with the SAME user and keep them.
  let cacheUid = null;
  let trusted = null;        // Promise<boolean> for cacheUid
  let snapshot = null;       // Promise<payload|null>
  let calendar = null;       // Promise<calendar row|null>
  const series = new Map();  // ticker -> Promise<row|null>
  const SERIES_CACHE_MAX = 40;

  const available = () => !!client;
  const currentUser = () => user;
  const onChange = cb => listeners.push(cb);
  const notify = () => listeners.forEach(cb => { try { cb(user); } catch { /* listener's problem */ } });

  function resetCaches() {
    cacheUid = user?.id ?? null;
    trusted = null; snapshot = null; calendar = null; series.clear();
  }

  // PostgREST / Postgres codes that mean "this table or function doesn't exist (yet)".
  const NOT_AVAILABLE = new Set(['PGRST205', 'PGRST202', '42P01', '42883']);
  function fail(error) {
    const code = error?.code ?? null, status = error?.status ?? null;
    const notAvailable = status === 404 || NOT_AVAILABLE.has(code);
    lastError = {
      code, status, notAvailable,
      message: notAvailable ? 'Not available yet — this appears after the next daily data run.'
        : (error?.message ? String(error.message).slice(0, 200) : 'Request failed'),
    };
    return null;
  }
  // Run a supabase-js query builder; null on any error (incl. a thrown network error).
  async function run(query) {
    try {
      const res = await query;
      if (res.error) return fail({ ...res.error, status: res.error.status ?? res.status });
      lastError = null;
      return res;
    } catch (e) {
      return fail({ code: 'network', message: 'Network error' });
    }
  }
  const signedIn = () => !!(client && user);

  async function refreshWatchlist() {
    if (!client || !user) { watchlistKeys = new Set(); return; }
    const { data, error } = await client.from('user_watchlist').select('market_key');
    watchlistKeys = new Set(error || !data ? [] : data.map(r => r.market_key));
  }

  // Supabase reports a failed magic link by redirecting back with error params —
  // in the hash for the implicit flow, in the query string for PKCE. Ported from
  // admin.js (same reasoning): otp_expired usually means a mail provider's link
  // scanner already spent the token; a redirect mismatch sends tokens elsewhere.
  // Reads the URL once (then cleans it, so a refresh doesn't re-show a resolved
  // error) and keeps the message until a sign-in succeeds.
  function readAuthError() {
    if (authError) return authError;
    const parse = s => new URLSearchParams((s || '').replace(/^[#?]/, ''));
    for (const src of [location.hash, location.search]) {
      const p = parse(src);
      const code = p.get('error_code') || p.get('error');
      if (!code) continue;
      const desc = (p.get('error_description') || '').replace(/\+/g, ' ');
      try { history.replaceState(null, '', location.pathname); } catch { /* sandboxed */ }
      authError = /expired|not_found|invalid/i.test(code + desc)
        ? 'That sign-in link had already been used or expired. Request a fresh one and open it '
          + 'as soon as it arrives — some mail providers scan links automatically, which uses them up.'
        : `Sign-in failed: ${(desc || code).slice(0, 160)}`;
      return authError;
    }
    return null;
  }

  // cfg = dashboard_data.json's meta.supabase = {url, anon_key}. Returns false
  // (never throws) when auth isn't configured or the CDN script didn't load —
  // a static-host / offline-dev fallback, same spirit as app.js's hasApi check.
  async function init(cfg) {
    readAuthError();
    if (!cfg || !cfg.url || !cfg.anon_key || typeof window.supabase === 'undefined') return false;
    try {
      client = window.supabase.createClient(cfg.url, cfg.anon_key);
      const { data: { session } } = await client.auth.getSession();
      user = session?.user ?? null;
    } catch { client = null; user = null; return false; }
    resetCaches();
    // Capped: a hung Supabase must not hold up the first render of the whole dashboard
    // (the watchlist stars fill in when it answers; onChange re-renders).
    if (user) {
      authError = null;
      const done = refreshWatchlist().catch(() => { /* offline */ });
      const capped = await Promise.race([done.then(() => true), new Promise(r => setTimeout(() => r(false), 4000))]);
      if (!capped) done.then(() => notify());
    }
    // Deferred with setTimeout: supabase-js runs this callback while it holds its
    // auth lock, and a query awaited inside it (refreshWatchlist) can deadlock.
    client.auth.onAuthStateChange((_event, newSession) => setTimeout(async () => {
      user = newSession?.user ?? null;
      if ((user?.id ?? null) !== cacheUid) resetCaches();
      if (user) authError = null;
      try { await refreshWatchlist(); } catch { /* offline */ }
      notify();
    }, 0));
    return true;
  }

  // Magic-link (email OTP) sign-in — no password to store or leak. The link
  // redirects back to this page's clean path (never location.href: a routed href
  // like /#/screener would collide with the token fragment, and Supabase matches the
  // whole URL against its redirect allowlist). The current route is kept in
  // localStorage for 30 minutes and restored after sign-in (consumeSavedRoute) —
  // not sessionStorage, because mail clients usually open the link in a NEW tab.
  async function signInWithEmail(email) {
    if (!client) throw new Error('Sign-in is not configured on this deployment.');
    email = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error('Enter a valid email address.');
    try { if (/^#\/[a-z]/.test(location.hash)) localStorage.setItem('giva_route', JSON.stringify({ r: location.hash.slice(0, 4000), t: Date.now() })); } catch { /* storage blocked */ }
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
    if (error) throw error;
    authError = null;
  }

  // The route saved before a magic-link round trip, once (then forgotten). Only a
  // plain app route ever comes back — never a token or error fragment.
  function consumeSavedRoute() {
    let r = null;
    try {
      const saved = JSON.parse(localStorage.getItem('giva_route') || 'null');
      localStorage.removeItem('giva_route');
      if (saved && typeof saved.r === 'string' && Date.now() - saved.t < 30 * 60 * 1000) r = saved.r;
    } catch { return null; }
    return r && /^#\/(overview|screener|lists|alerts|stock|market)\b/.test(r) ? r : null;
  }

  async function signOut() {
    if (client) { try { await client.auth.signOut(); } catch { /* offline: session stays until expiry */ } }
  }

  async function accessToken() {
    if (!client) return null;
    try { const { data } = await client.auth.getSession(); return data?.session?.access_token ?? null; }
    catch { return null; }
  }

  // RPC is_trusted (0015): admins + allowlisted addresses with can_view_prices.
  // Decides only what to DRAW — RLS enforces it again on every read. Cached per user.
  // A blip (network error, 5xx, or no answer within 6 s) resolves false but sets
  // trustUnknown(), so callers show "try again" rather than "not on the owner list".
  let trustFailed = false;
  const TRUST_TIMEOUT_MS = 6000;
  function isTrusted() {
    if (!signedIn()) return Promise.resolve(false);
    if (cacheUid !== user.id) resetCaches();
    if (!trusted) {
      const timeout = new Promise(r => setTimeout(() => r('timeout'), TRUST_TIMEOUT_MS));
      const p = trusted = Promise.race([run(client.rpc('is_trusted')), timeout]).then(res => {
        const failed = res === 'timeout' || (!res && !lastError?.notAvailable);
        trustFailed = failed;
        // Keep a definite answer (or "not deployed yet") for the session; retry a blip.
        if (failed && trusted === p) trusted = null;
        return !failed && res?.data === true;
      });
    }
    return trusted;
  }
  const trustUnknown = () => trustFailed;

  const isWatched = marketKey => watchlistKeys.has(marketKey);

  // Insert/delete against user_watchlist (migration 0011). RLS requires the
  // row's user_id to match auth.uid() from the caller's own JWT — the client
  // must set it explicitly, RLS only checks it, it doesn't fill it in.
  async function toggleWatch(marketKey) {
    if (!client || !user) throw new Error('Sign in required');
    if (watchlistKeys.has(marketKey)) {
      const { error } = await client.from('user_watchlist').delete().eq('market_key', marketKey);
      if (error) throw error;
      watchlistKeys.delete(marketKey);
    } else {
      const { error } = await client.from('user_watchlist').insert({ user_id: user.id, market_key: marketKey });
      if (error) throw error;
      watchlistKeys.add(marketKey);
    }
    return watchlistKeys.has(marketKey);
  }

  // ---- saved screens (saved_screens, 0015) ----
  const SCREEN_COLS = 'id,name,scope,filter,alerts_enabled,last_evaluated_asof,created_at,updated_at';

  async function listScreens() {
    if (!signedIn()) return [];
    const res = await run(client.from('saved_screens').select(SCREEN_COLS).order('updated_at', { ascending: false }));
    return res?.data || [];
  }

  // Re-validated here as well as in the screener: a saved filter feeds the alert job
  // (which re-validates once more in Python). Returns the saved row, or null.
  async function saveScreen({ id, name, scope, filter, alerts_enabled } = {}) {
    if (!signedIn()) return null;
    name = String(name ?? '').trim().slice(0, 80);
    if (!name) return fail({ code: 'invalid', message: 'Give the screen a name.' });
    if (scope !== 'stocks' && scope !== 'markets') return fail({ code: 'invalid', message: 'Unknown screen scope.' });
    if (typeof ScreenDSL !== 'undefined' && ScreenDSL.isReady && ScreenDSL.isReady()) {
      const v = ScreenDSL.validate(filter, scope);
      if (!v.ok) return fail({ code: 'invalid', message: `Invalid screen: ${v.errors.slice(0, 2).join('; ')}` });
      filter = v.filter;
    }
    const row = { name, scope, filter, alerts_enabled: !!alerts_enabled };
    const q = id
      ? client.from('saved_screens').update(row).eq('id', id).select(SCREEN_COLS).maybeSingle()
      : client.from('saved_screens').insert({ ...row, user_id: user.id }).select(SCREEN_COLS).single();
    const res = await run(q);
    return res?.data || null;
  }

  async function deleteScreen(id) {
    if (!signedIn() || !id) return false;
    return !!(await run(client.from('saved_screens').delete().eq('id', id)));
  }

  // ---- watchlists (watchlists + watchlist_items, 0015) ----
  // The built-in "Starred" markets list is still user_watchlist (isWatched/toggleWatch).
  async function listWatchlists() {
    if (!signedIn()) return [];
    const res = await run(client.from('watchlists')
      .select('id,name,created_at,watchlist_items(kind,item_key,note,added_at)')
      .order('created_at', { ascending: true }));
    return (res?.data || []).map(w => ({
      id: w.id, name: w.name, created_at: w.created_at,
      items: (w.watchlist_items || [])
        .map(i => ({ kind: i.kind, key: i.item_key, note: i.note, added_at: i.added_at }))
        .sort((a, b) => String(b.added_at).localeCompare(String(a.added_at))),
    }));
  }

  const listName = n => String(n ?? '').trim().slice(0, 60);

  // Returns {id, name, items: []} or null.
  async function createList(name) {
    if (!signedIn()) return null;
    name = listName(name);
    if (!name) return fail({ code: 'invalid', message: 'Give the list a name.' });
    const res = await run(client.from('watchlists').insert({ user_id: user.id, name }).select('id,name,created_at').single());
    return res?.data ? { ...res.data, items: [] } : null;
  }

  async function renameList(id, name) {
    if (!signedIn() || !id) return false;
    name = listName(name);
    if (!name) { fail({ code: 'invalid', message: 'Give the list a name.' }); return false; }
    return !!(await run(client.from('watchlists').update({ name }).eq('id', id)));
  }

  async function deleteList(id) {
    if (!signedIn() || !id) return false;
    return !!(await run(client.from('watchlists').delete().eq('id', id)));
  }

  const ITEM_KEY_RE = /^[A-Za-z0-9._:\-]{1,32}$/;
  const okItem = (kind, key) => (kind === 'stock' || kind === 'market') && ITEM_KEY_RE.test(String(key ?? ''));

  // Idempotent: adding an item that is already on the list is a success.
  async function addItem(listId, kind, key) {
    if (!signedIn() || !listId || !okItem(kind, key)) return false;
    return !!(await run(client.from('watchlist_items')
      .upsert({ watchlist_id: listId, user_id: user.id, kind, item_key: String(key) },
        { onConflict: 'watchlist_id,kind,item_key', ignoreDuplicates: true })));
  }

  async function removeItem(listId, kind, key) {
    if (!signedIn() || !listId || !okItem(kind, key)) return false;
    return !!(await run(client.from('watchlist_items').delete()
      .eq('watchlist_id', listId).eq('kind', kind).eq('item_key', String(key))));
  }

  // The id of the caller's list with this name, creating it if needed (e.g. the
  // auto-created "Starred stocks" list). null when unavailable.
  async function ensureList(name) {
    if (!signedIn()) return null;
    name = listName(name);
    if (!name) return null;
    const find = async () => (await run(client.from('watchlists').select('id').eq('name', name).limit(1)))?.data?.[0]?.id ?? null;
    const have = await find();
    if (have) return have;
    if (lastError) return null;
    const made = await createList(name);
    if (made) return made.id;
    return lastError?.code === '23505' ? find() : null;  // created concurrently (unique user_id+name)
  }

  // ---- screen alerts (screen_alerts, written only by the alert job) ----
  // Unseen first, newest first; each row gains screen_name.
  async function listAlerts({ limit = 50 } = {}) {
    if (!signedIn()) return [];
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const res = await run(client.from('screen_alerts')
      .select('id,screen_id,asof,added,removed,n_added,n_removed,hidden_data_issue,seen,created_at,saved_screens(name,scope)')
      .order('seen', { ascending: true }).order('created_at', { ascending: false }).limit(n));
    return (res?.data || []).map(({ saved_screens: s, ...a }) => ({
      ...a, screen_name: s?.name ?? null, screen_scope: s?.scope ?? null,
    }));
  }

  // Only `seen` is writable (column grant) — that's all this sends.
  async function markSeen(ids) {
    ids = (Array.isArray(ids) ? ids : [ids]).filter(x => x != null).slice(0, 500);
    if (!signedIn() || !ids.length) return false;
    return !!(await run(client.from('screen_alerts').update({ seen: true }).in('id', ids)));
  }

  async function unseenCount() {
    if (!signedIn()) return 0;
    const res = await run(client.from('screen_alerts').select('id', { count: 'exact', head: true }).eq('seen', false));
    return res?.count ?? 0;
  }

  // ---- trusted-only stock data (RLS: is_trusted) ----
  // The screener's stock universe: screener_snapshots.payload, columnar
  // {v, asof, fields, rows: [[...]], n, n_hidden, excluded_counts, coverage}. Returned
  // as-is plus `records` (rows decoded to objects keyed by field) and `byTicker`
  // (Map). Never fetched for untrusted users. Cached per user/session.
  function stockSnapshot() {
    if (!signedIn()) return Promise.resolve(null);
    if (cacheUid !== user.id) resetCaches();
    if (!snapshot) {
      const p = snapshot = (async () => {
        if (!(await isTrusted())) return null;
        const res = await run(client.from('screener_snapshots').select('asof,payload').eq('scope', 'stocks').maybeSingle());
        const p = res?.data?.payload;
        if (!p || !Array.isArray(p.fields) || !Array.isArray(p.rows)) return null;
        const records = p.rows.map(r => {
          const o = {};
          p.fields.forEach((k, i) => { o[k] = r[i]; });
          return o;
        });
        const byTicker = new Map(records.filter(r => r.ticker).map(r => [String(r.ticker).toUpperCase(), r]));
        return { ...p, asof: p.asof || res.data.asof, records, byTicker };
      })();
      // A transient failure shouldn't stick for the whole session.
      p.then(v => { if (v == null && lastError && !lastError.notAvailable && snapshot === p) snapshot = null; });
    }
    return snapshot;
  }

  // Close-only display cache (chart_series): the shared trading calendar row plus the
  // stock's row ({closes aligned to calendar, fundamentals}). null when untrusted,
  // missing or unavailable — charts then fall back to the TradingView widget.
  const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;
  function chartSeries(ticker) {
    const t = String(ticker ?? '').toUpperCase();
    if (!signedIn() || !TICKER_RE.test(t)) return Promise.resolve(null);
    if (cacheUid !== user.id) resetCaches();
    const COLS = 'key,kind,asof,start_date,days,closes,fundamentals';
    if (!series.has(t)) {
      if (series.size >= SERIES_CACHE_MAX) series.delete(series.keys().next().value);
      series.set(t, (async () => {
        if (!(await isTrusted())) return null;
        if (!calendar) {
          const c = calendar = run(client.from('chart_series').select(COLS).eq('key', 'calendar:us').maybeSingle()).then(r => r?.data || null);
          c.then(v => { if (!v && calendar === c) calendar = null; });
        }
        const [cal, res] = await Promise.all([calendar,
          run(client.from('chart_series').select(COLS).eq('key', `stock:${t}`).maybeSingle())]);
        const row = res?.data || null;
        if (!cal || !row) { series.delete(t); return null; }
        return { calendar: cal, row };
      })());
    }
    return series.get(t);
  }

  return {
    init, available, currentUser, onChange, signInWithEmail, signOut, readAuthError, consumeSavedRoute,
    isTrusted, trustUnknown, accessToken, client: () => client, isWatched, toggleWatch,
    listScreens, saveScreen, deleteScreen,
    listWatchlists, createList, renameList, deleteList, addItem, removeItem, ensureList,
    listAlerts, markSeen, unseenCount, stockSnapshot, chartSeries,
    get lastError() { return lastError; },
  };
})();
