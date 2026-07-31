// Global Index Valuation Agent — dashboard front-end (no build step).
// Reads the engine's JSON contract, surfaces insights, and writes feedback back.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = (p, opts) => fetch(p, opts).then(r => r.json());

let STATE = { data: null, rows: [], focus: 'Country', hasApi: false, sort: { key: 'opportunity_score', dir: -1 }, currency: 'USD', openDrawerKey: null };

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
}
// Registered once (not inside load(), which re-runs on manual refresh) so
// repeated refreshes don't accumulate duplicate listeners.
Auth.onChange(() => { renderAuthUI(); if (STATE.openDrawerKey) openDrawer(STATE.openDrawerKey); });

function render() {
  const d = STATE.data;
  $('#asof').textContent = `as of ${d.asof}`;
  const rb = $('#refreshBtn');
  if (!STATE.hasApi) { rb.textContent = '↻ weekly'; rb.title = 'Hosted snapshot — refreshed weekly by CI. Click for details.'; }
  $('#briefText').textContent = d.brief;
  $('#meta').textContent = `${d.meta.data_source} · growth: ${d.meta.growth_signal} · ${d.meta.note}`;
  renderTrackRecord(d.accuracy);
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
    if (STATE.openDrawerKey) openDrawer(STATE.openDrawerKey);
  };
}

// ---- auth (Phase D, ADR-026) ----
function renderAuthUI() {
  const el = $('#authBox');
  if (!Auth.available()) { el.innerHTML = ''; return; }
  const u = Auth.currentUser();
  el.innerHTML = u
    ? `<span class="text-xs text-slate-400 truncate max-w-[160px]" title="${u.email}">${u.email}</span>
       <button id="signOutBtn" class="ctrl">Sign out</button>`
    : `<button id="signInBtn" class="ctrl">Sign in</button>`;
  const inBtn = $('#signInBtn'), outBtn = $('#signOutBtn');
  if (inBtn) inBtn.onclick = async () => {
    const email = prompt('Email for a magic sign-in link:');
    if (!email) return;
    try { await Auth.signInWithEmail(email); alert(`Check ${email} for a sign-in link.`); }
    catch (e) { alert(`Sign-in failed: ${e.message || e}`); }
  };
  if (outBtn) outBtn.onclick = async () => { await Auth.signOut(); };
}

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

function renderTrackRecord(acc) {
  const el = $('#trackrecord');
  if (!acc || !acc.evaluations) { el.innerHTML = `<span class="text-slate-500">track record: building…</span>`; return; }
  const ic = acc.avg_rank_ic, hr = acc.avg_hit_rate;
  const good = ic > 0.05;
  el.innerHTML = `track record: <span class="font-semibold" style="color:${good ? '#34d399' : '#fbbf24'}">
    IC ${fmt(ic, 2)}</span> · hit ${fmt(hr * 100, 0)}% <span class="text-slate-500">(${acc.evaluations} runs)</span>`;
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
  if (m.value_trap) s += `<span class="pill" style="background:#fbbf2422;color:#fbbf24">trap</span> `;
  if (m.overvalued) s += `<span class="pill" style="background:#f8717122;color:#f87171">rich</span> `;
  if (!s && m.value_band === 'Cheap') s += `<span class="pill" style="background:#34d39922;color:#34d399">cheap</span>`;
  return s || '—';
}
function renderFilters() {
  const regions = [...new Set(STATE.rows.map(m => m.region))].sort();
  const devs = [...new Set(STATE.rows.map(m => m.development))].sort();
  $('#fRegion').innerHTML = `<option value="">All regions</option>` + regions.map(r => `<option>${r}</option>`).join('');
  $('#fDev').innerHTML = `<option value="">All markets</option>` + devs.map(r => `<option>${r}</option>`).join('');
  ['#search', '#fRegion', '#fDev', '#fBand', '#fHideRich'].forEach(s => $(s).oninput = renderTable);
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
// is broken" — most often it's a real, explainable coverage boundary. The common
// one (reported by the user): focus=Sectors + region=Europe/Asia-Pacific, because
// every sector proxy we track is a US or Global fund, so none carry a non-US
// region tag. Name the actual cause and offer the way out.
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
  return `<div class="flex items-center justify-between gap-2 py-1.5 border-b border-line/50">
    <div class="min-w-0">
      <div class="text-[13px] text-slate-100">${s.ticker}${s.garp ? ' <span class="pill" style="background:#2dd4bf22;color:#2dd4bf">GARP</span>' : ''}</div>
      <div class="text-[10px] text-slate-500 truncate">${s.name || ''}${s.sector ? ' · ' + s.sector : ''}</div>
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
function watchStarBtn(key) {
  const signedIn = Auth.available() && Auth.currentUser();
  const on = signedIn && Auth.isWatched(key);
  const title = Auth.available()
    ? (signedIn ? (on ? 'Remove from watchlist' : 'Add to watchlist') : 'Sign in to save a personal watchlist')
    : 'Watchlist needs Supabase configured (see .env.example)';
  return `<button id="watchStarBtn" class="text-xl leading-none ${signedIn ? '' : 'opacity-40 cursor-not-allowed'}"
    style="color:${on ? '#fbbf24' : '#64748b'}" title="${title}">${on ? '★' : '☆'}</button>`;
}
function openDrawer(key) {
  const m = STATE.rows.find(x => x.key === key); if (!m) return;
  STATE.openDrawerKey = key;
  const row = (l, v) => `<div class="flex justify-between py-1.5 border-b border-line/50"><span class="text-slate-400">${l}</span><span class="text-slate-100 tabular-nums">${v}</span></div>`;
  $('#drawer').innerHTML = `
    <div class="flex items-start justify-between mb-3">
      <div><div class="text-lg font-semibold text-white">${m.name}</div>
        <div class="text-xs text-slate-500">${m.kind} · ${m.country} · ${m.region} · ${m.development} · proxy ${m.symbol}</div></div>
      <div class="flex items-center gap-2">
        ${watchStarBtn(key)}
        <button id="closeDrawer" class="text-slate-400 hover:text-white text-xl leading-none">×</button>
      </div>
    </div>
    <div class="text-[13px] text-slate-300 italic mb-3">${m.tag || ''}${tagProvenance(m)}</div>
    <div class="grid grid-cols-3 gap-2 mb-4">
      ${scoreTile('Value', m.value_score)}${scoreTile('Growth', m.growth_score)}${scoreTile('Opportunity', m.opportunity_score)}
    </div>
    <div class="text-sm">
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
      ${row('vs 200d MA', pct(m.ma200_ratio))}${row('52w range pos', fmt((m.pct_52w_range ?? 0) * 100, 0) + '%')}
      ${row('Flags', flagPills(m))}
      ${stockBreakdownBlock(key)}
      ${investBlock(m)}
    </div>
    <div class="mt-4">
      <div class="text-xs text-slate-400 mb-1.5">Does this call look right to you?</div>
      <div class="flex gap-2">
        <button class="fb-btn flex-1" data-fb="up">👍 Good call</button>
        <button class="fb-btn flex-1" data-fb="pin">📌 Watch</button>
        <button class="fb-btn flex-1" data-fb="down">👎 Off</button>
      </div>
    </div>`;
  $('#closeDrawer').onclick = closeDrawer;
  $('#watchStarBtn').onclick = async () => {
    if (!Auth.available()) return;
    if (!Auth.currentUser()) { alert('Sign in (top right) to save a personal watchlist.'); return; }
    try { await Auth.toggleWatch(key); openDrawer(key); }
    catch (e) { alert(`Watchlist update failed: ${e.message || e}`); }
  };
  $$('#drawer [data-fb]').forEach(b => b.onclick = () => { sendFeedback('market', key, b.dataset.fb); b.classList.add('active'); });
  $('#drawer').classList.remove('translate-x-full');
  $('#scrim').classList.remove('hidden');
}
function scoreTile(label, s) {
  return `<div class="rounded-lg bg-panel border border-line p-2 text-center">
    <div class="text-[10px] text-slate-500 uppercase">${label}</div>
    <div class="text-xl font-bold" style="color:${scoreColor(s)}">${fmt(s, 0)}</div></div>`;
}
function closeDrawer() { STATE.openDrawerKey = null; $('#drawer').classList.add('translate-x-full'); $('#scrim').classList.add('hidden'); }
$('#scrim').onclick = closeDrawer;

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
