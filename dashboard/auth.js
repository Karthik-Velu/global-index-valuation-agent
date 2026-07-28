// Global Index Valuation Agent — Supabase Auth + per-user watchlist (Phase D, ADR-026).
// No-build: supabase-js loaded from CDN in index.html (window.supabase). Degrades
// to "unavailable" when SUPABASE_URL/ANON_KEY aren't configured (empty in
// dashboard_data.json's meta.supabase, or the CDN script failed to load) —
// callers MUST check Auth.available() before showing sign-in/watchlist UI; the
// existing anonymous localStorage pin/dismiss flow (app.js) keeps working either way.

const Auth = (() => {
  let client = null;
  let user = null;
  let watchlistKeys = new Set();
  const listeners = [];

  const available = () => !!client;
  const currentUser = () => user;
  const onChange = cb => listeners.push(cb);
  const notify = () => listeners.forEach(cb => { try { cb(user); } catch { /* listener's problem */ } });

  async function refreshWatchlist() {
    if (!client || !user) { watchlistKeys = new Set(); return; }
    const { data, error } = await client.from('user_watchlist').select('market_key');
    watchlistKeys = new Set(error || !data ? [] : data.map(r => r.market_key));
  }

  // cfg = dashboard_data.json's meta.supabase = {url, anon_key}. Returns false
  // (never throws) when auth isn't configured or the CDN script didn't load —
  // a static-host / offline-dev fallback, same spirit as app.js's hasApi check.
  async function init(cfg) {
    if (!cfg || !cfg.url || !cfg.anon_key || typeof window.supabase === 'undefined') return false;
    client = window.supabase.createClient(cfg.url, cfg.anon_key);
    const { data: { session } } = await client.auth.getSession();
    user = session?.user ?? null;
    if (user) await refreshWatchlist();
    client.auth.onAuthStateChange(async (_event, newSession) => {
      user = newSession?.user ?? null;
      await refreshWatchlist();
      notify();
    });
    return true;
  }

  // Magic-link (email OTP) sign-in — no password to store or leak. The link
  // redirects back to this same page; Supabase handles the token exchange and
  // fires onAuthStateChange above.
  async function signInWithEmail(email) {
    if (!client) throw new Error('Auth not configured');
    const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
    if (error) throw error;
  }

  async function signOut() {
    if (client) await client.auth.signOut();
  }

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

  return { init, available, currentUser, onChange, signInWithEmail, signOut, isWatched, toggleWatch };
})();
