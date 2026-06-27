// Global Index Valuation Agent — dashboard front-end (no build step).
// Reads the engine's JSON contract, surfaces insights, and writes feedback back.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = (p, opts) => fetch(p, opts).then(r => r.json());

let STATE = { data: null, rows: [], focus: 'Country', hasApi: false, sort: { key: 'opportunity_score', dir: -1 } };

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
  render();
}

function render() {
  const d = STATE.data;
  $('#asof').textContent = `as of ${d.asof}`;
  const rb = $('#refreshBtn');
  if (!STATE.hasApi) { rb.textContent = '↻ weekly'; rb.title = 'Hosted snapshot — refreshed weekly by CI. Click for details.'; }
  $('#briefText').textContent = d.brief;
  $('#meta').textContent = `${d.meta.data_source} · growth: ${d.meta.growth_signal} · ${d.meta.note}`;
  renderTrackRecord(d.accuracy);
  renderTuning(d.tuning);
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
  $('#tbody').innerHTML = rows.map(m => `<tr data-mk="${m.key}">${COLS.map(([k, , f]) => `<td>${f(m)}</td>`).join('')}</tr>`).join('');
  $$('#tbody tr').forEach(tr => tr.onclick = () => openDrawer(tr.dataset.mk));
}

// ---- drill-down drawer ----
function openDrawer(key) {
  const m = STATE.rows.find(x => x.key === key); if (!m) return;
  const row = (l, v) => `<div class="flex justify-between py-1.5 border-b border-line/50"><span class="text-slate-400">${l}</span><span class="text-slate-100 tabular-nums">${v}</span></div>`;
  $('#drawer').innerHTML = `
    <div class="flex items-start justify-between mb-3">
      <div><div class="text-lg font-semibold text-white">${m.name}</div>
        <div class="text-xs text-slate-500">${m.kind} · ${m.country} · ${m.region} · ${m.development} · proxy ${m.symbol}</div></div>
      <button id="closeDrawer" class="text-slate-400 hover:text-white text-xl leading-none">×</button>
    </div>
    <div class="text-[13px] text-slate-300 italic mb-3">${m.tag || ''}</div>
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
  $$('#drawer [data-fb]').forEach(b => b.onclick = () => { sendFeedback('market', key, b.dataset.fb); b.classList.add('active'); });
  $('#drawer').classList.remove('translate-x-full');
  $('#scrim').classList.remove('hidden');
}
function scoreTile(label, s) {
  return `<div class="rounded-lg bg-panel border border-line p-2 text-center">
    <div class="text-[10px] text-slate-500 uppercase">${label}</div>
    <div class="text-xl font-bold" style="color:${scoreColor(s)}">${fmt(s, 0)}</div></div>`;
}
function closeDrawer() { $('#drawer').classList.add('translate-x-full'); $('#scrim').classList.add('hidden'); }
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
