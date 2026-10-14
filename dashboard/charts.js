// Charts — the drawer's chart block (ADR-037). Two kinds of chart, chosen per viewer:
//
//  - Owner view (trusted, a chart_series row on file): a Lightweight Charts 4.2.3 line of
//    daily closes with range buttons (1M · 3M · 6M · 1Y · All, "All" labelled with the
//    real span — no 5Y button until five years are on file), a crosshair legend, 50/200-day
//    averages, the long-run average the "on sale" call was measured against (a horizontal
//    line across exactly the window it covers), and a Compare overlay of one more stock in
//    percentage mode labelled "Price change" (never growth). Below it, the Growth record:
//    annual revenue / net income as inline SVG bars from the same cleaned EDGAR series the
//    screener's growth fields come from (growthhistory.annual_series).
//  - Everyone else, and every market: TradingView's free Advanced Chart widget (their data,
//    their display, their attribution) — always inside a sandboxed srcdoc iframe WITHOUT
//    allow-same-origin, so the third-party script runs in an opaque origin and can't read
//    the Supabase session in our localStorage. Trusted viewers get it as a second tab.
//
// Licence notes: closes only (no candles/volume) because chart_series is a close-only
// display cache served under RLS to the owner; Lightweight Charts (Apache-2.0) keeps its
// TradingView attribution logo on. The library is NOT in <head>: ensureLib() injects the
// pinned, integrity-checked build on first use.
//
//   const dispose = Charts.mount(el, spec)   // never throws; dispose() is idempotent
//     spec = {kind: 'stock', ticker, symbol?, price?, discount_long?, long_avg_years?}
//          | {kind: 'market', key, symbol, name?}
//   Charts.ensureLib() -> Promise<LightweightCharts | null>
const Charts = (() => {
  'use strict';

  const LWC_URL = 'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.3/dist/lightweight-charts.standalone.production.js';
  // sha384 of dist/lightweight-charts.standalone.production.js in the npm tarball
  // lightweight-charts@4.2.3 (jsDelivr's /npm/ path serves the tarball's bytes unchanged).
  const LWC_SRI = 'sha384-stKllnUqA9AD0gsKCuUtf5XlqAW7PwIgDagoNsTWkjkBmJ/GZ/uHTgEBxdLV2VSK';
  const LIB_TIMEOUT_MS = 15000;
  const SERIES_TIMEOUT_MS = 8000;
  const TV_SCRIPT = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  // engine/config.py: LONG_AVG_YEARS = 5, LONG_AVG_DAYS = 252 * 5, LONG_AVG_MIN_DAYS = 252.
  const LONG_AVG_YEARS = 5, TRADING_DAYS = 252;
  const LONG_AVG_DAYS = TRADING_DAYS * LONG_AVG_YEARS, LONG_AVG_MIN_DAYS = TRADING_DAYS;
  const AVG_TOLERANCE = 0.005;   // chart mean vs the screen's average: within 0.5%
  const DAY = 86400;
  const RANGES = [['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365]];
  const COLORS = { close: '#60a5fa', avg: '#fbbf24', sma50: '#a78bfa', sma200: '#2dd4bf', compare: '#f472b6',
    revenue: '#60a5fa', income: '#34d399', loss: '#f87171' };
  const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,15}$/;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && isFinite(v);
  const isoDay = t => new Date(t * 1000).toISOString().slice(0, 10);
  // Lightweight Charts formats axis dates with navigator.language and throws on every
  // frame when that isn't a valid BCP 47 tag (e.g. 'en-US@posix' from a C/POSIX locale).
  const safeLocale = () => {
    try {
      const l = typeof navigator !== 'undefined' && navigator.language ? String(navigator.language) : 'en-US';
      return Intl.DateTimeFormat.supportedLocalesOf([l]).length ? l : 'en-US';
    } catch { return 'en-US'; }
  };
  const fmtPrice = v => isNum(v) ? (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(2)) : '—';
  const fmtPct = v => isNum(v) ? `${v >= 0 ? '+' : '−'}${Math.abs(v * 100).toFixed(1)}%` : '—';
  const unavailableHTML = (why = 'chart unavailable') => `<div class="chr-empty">${esc(why)}</div>`;
  const auth = () => (typeof Auth !== 'undefined' && Auth && typeof Auth.chartSeries === 'function') ? Auth : null;

  // ---- library loader ----
  let libPromise = null;
  function ensureLib() {
    const have = () => (typeof window !== 'undefined' && window.LightweightCharts
      && typeof window.LightweightCharts.createChart === 'function') ? window.LightweightCharts : null;
    if (have()) return Promise.resolve(have());
    if (libPromise) return libPromise;
    let done = false, timer = null, resolveFn = null;
    const p = new Promise(res => { resolveFn = res; });
    const finish = ok => {
      if (done) return;
      done = true; clearTimeout(timer);
      // A failure isn't remembered: the next chart open tries again (it may be back online).
      if (!ok && libPromise === p) libPromise = null;
      resolveFn(ok ? have() : null);
    };
    libPromise = p;
    try {
      const s = document.createElement('script');
      s.src = LWC_URL; s.integrity = LWC_SRI; s.crossOrigin = 'anonymous'; s.async = true;
      s.setAttribute('data-chr-lib', 'lightweight-charts');
      s.onload = () => finish(true);
      s.onerror = () => { try { s.remove(); } catch { /* gone */ } finish(false); };
      timer = setTimeout(() => finish(false), LIB_TIMEOUT_MS);
      document.head.appendChild(s);
    } catch { setTimeout(() => finish(false), 0); }
    return p;
  }

  // ---- data shaping (pure) ----
  // chart_series: one shared calendar row ({start_date, days: day offsets}) and the
  // stock's closes aligned to it (null = no bar that day). Anything misaligned — another
  // start date or length — is refused rather than drawn against the wrong days.
  function seriesPoints(cal, row) {
    if (!cal || !row || !Array.isArray(cal.days) || !Array.isArray(row.closes)) return null;
    if (row.start_date && cal.start_date && row.start_date !== cal.start_date) return null;
    if (row.closes.length !== cal.days.length || !cal.days.length) return null;
    const t0 = Date.parse(`${cal.start_date}T00:00:00Z`) / 1000;
    if (!isFinite(t0)) return null;
    const pts = [];
    let prev = -Infinity, n = 0;
    for (let i = 0; i < cal.days.length; i++) {
      const d = cal.days[i];
      if (!isNum(d)) return null;
      const time = t0 + Math.round(d) * DAY;
      if (time <= prev) return null;               // the calendar must be strictly increasing
      prev = time;
      const c = row.closes[i];
      if (isNum(c) && c > 0) { pts.push({ time, value: c }); n++; } else pts.push({ time });
    }
    return n ? pts : null;
  }

  // Simple moving average over the bars that exist; a point only where the FULL window is
  // available (an expanding mean labelled "200-day" would be a different number).
  function sma(points, n) {
    const vals = points.filter(p => isNum(p.value));
    const out = [];
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      sum += vals[i].value;
      if (i >= n) sum -= vals[i - n].value;
      if (i >= n - 1) out.push({ time: vals[i].time, value: sum / n });
    }
    return out;
  }

  // The long-run average the "on sale" call used: discount_long = price / mean(last n_long
  // closes) − 1 with n_long = min(bars on file, LONG_AVG_DAYS) (stockvaluation._price_features),
  // so avg = price / (1 + discount_long). The chart re-derives the mean from its own closes
  // with the engine's own n when that agrees with the stated window (long_avg_years =
  // round(n_long / 252, 1)), else round(long_avg_years × 252), and says so when the two
  // means disagree by more than 0.5%, e.g. a chart cache from another day.
  function longAverage(points, spec) {
    const vals = points.filter(p => isNum(p.value));
    const yrs = isNum(spec.long_avg_years) && spec.long_avg_years > 0 ? spec.long_avg_years : null;
    const target = isNum(spec.price) && isNum(spec.discount_long) && spec.discount_long > -1
      ? spec.price / (1 + spec.discount_long) : null;
    const nEngine = Math.min(vals.length, LONG_AVG_DAYS);
    const n = !yrs || Math.abs(Math.round((nEngine / TRADING_DAYS) * 10) / 10 - yrs) < 0.05
      ? nEngine : Math.min(vals.length, Math.round(yrs * TRADING_DAYS));
    if (n < LONG_AVG_MIN_DAYS) {
      // Under a year of closes on the chart: no long average (the engine draws none either).
      return target != null && yrs ? { level: target, years: yrs, from: null, to: null, check: null, mean: null } : null;
    }
    const win = vals.slice(-n);
    const mean = win.reduce((a, p) => a + p.value, 0) / n;
    const years = yrs ?? Math.round((n / TRADING_DAYS) * 10) / 10;
    const base = { years, from: win[0].time, to: win[win.length - 1].time, mean, n };
    if (target == null) return { ...base, level: mean, check: null };
    const off = mean / target - 1;
    return { ...base, level: target, check: Math.abs(off) <= AVG_TOLERANCE, off };
  }

  // picks._avg_label's wording, plus what the line is for.
  function avgLabel(y) {
    if (!isNum(y) || y >= LONG_AVG_YEARS - 0.25) return `${LONG_AVG_YEARS}-year average price (used for "on sale")`;
    const s = Math.abs(y - Math.round(y)) < 0.15 ? y.toFixed(0) : y.toFixed(1);
    return `${s}-year average price (used for "on sale"; ${LONG_AVG_YEARS} years of prices not on file yet)`;
  }
  const avgShort = y => (!isNum(y) || y >= LONG_AVG_YEARS - 0.25) ? `${LONG_AVG_YEARS}y avg`
    : `${Math.abs(y - Math.round(y)) < 0.15 ? y.toFixed(0) : y.toFixed(1)}y avg`;

  // TradingView writes share classes with '.', the data with '-' (MOG-A -> MOG.A).
  function tvSymbol(sym) {
    const s = String(sym ?? '').trim().toUpperCase().replace(/-/g, '.');
    return /^[A-Z0-9][A-Z0-9.:]{0,19}$/.test(s) ? s : null;
  }

  // ---- growth record (inline SVG, the scatter's hand-built idiom) ----
  // fundamentals = {period_end: [...], revenue: [...], net_income: [...], currency} — at most
  // 7 annual points; a null is a year that wasn't reported as a full year (a quarter or a
  // stub period tagged FY), drawn as a gap, never as zero.
  function bigMoney(v, cur) {
    if (!isNum(v)) return '—';
    const a = Math.abs(v);
    const [d, s] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : a >= 1e3 ? [1e3, 'K'] : [1, ''];
    const n = `${v < 0 ? '−' : ''}${(a / d).toFixed(a / d >= 100 ? 0 : 1)}${s}`;
    return !cur || cur === 'USD' ? `${n.startsWith('−') ? '−$' + n.slice(1) : '$' + n}` : `${n} ${cur}`;
  }
  function growthSVG(f) {
    if (!f || !Array.isArray(f.period_end)) return '';
    const n = Math.min(f.period_end.length, 12);
    const rev = Array.isArray(f.revenue) ? f.revenue : [], ni = Array.isArray(f.net_income) ? f.net_income : [];
    const years = [];
    for (let i = 0; i < n; i++) {
      const pe = String(f.period_end[i] ?? '').slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(pe)) continue;
      years.push({ pe, fy: pe.slice(0, 4), rev: isNum(rev[i]) ? rev[i] : null, ni: isNum(ni[i]) ? ni[i] : null });
    }
    if (!years.length || !years.some(y => y.rev != null || y.ni != null)) return '';
    const cur = typeof f.currency === 'string' && /^[A-Z]{3}$/.test(f.currency) ? f.currency : null;
    const W = 340, H = 150, padL = 4, padR = 4, padT = 14, padB = 18;
    const vals = years.flatMap(y => [y.rev, y.ni]).filter(isNum);
    const hi = Math.max(0, ...vals), lo = Math.min(0, ...vals);
    const span = hi - lo || 1;
    const plotH = H - padT - padB;
    const yOf = v => padT + ((hi - v) / span) * plotH;
    const zero = yOf(0);
    const slot = (W - padL - padR) / years.length;
    const bw = Math.max(4, Math.min(18, slot * 0.32));
    const bar = (x, v, color, what, y) => {
      if (v == null) {
        const h = Math.min(28, plotH * 0.3);
        return `<g class="chr-gap"><rect x="${x.toFixed(1)}" y="${(zero - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}"
          fill="none" stroke="#475569" stroke-dasharray="2 2"/><text x="${(x + bw / 2).toFixed(1)}" y="${(zero - h - 3).toFixed(1)}"
          text-anchor="middle" class="chr-gap-t">n/r</text><title>FY${esc(y.fy)} ${what}: not reported as a full year</title></g>`;
      }
      const y0 = Math.min(zero, yOf(v)), h = Math.max(1, Math.abs(yOf(v) - zero));
      return `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${color}">
        <title>FY${esc(y.fy)} (year ended ${esc(y.pe)}) ${what}: ${esc(bigMoney(v, cur))}</title></rect>`;
    };
    const bars = years.map((y, i) => {
      const cx = padL + slot * i + slot / 2;
      return bar(cx - bw - 1, y.rev, COLORS.revenue, 'revenue', y)
        + bar(cx + 1, y.ni, y.ni != null && y.ni < 0 ? COLORS.loss : COLORS.income, 'net income', y)
        + `<text x="${cx.toFixed(1)}" y="${H - 5}" text-anchor="middle">FY${esc(y.fy.slice(2))}</text>`;
    }).join('');
    const last = years[years.length - 1];
    return `<div class="chr-growth">
      <div class="chr-sub">Growth record <span>— annual revenue &amp; net income (fundamentals, EDGAR)</span></div>
      <div class="chr-key"><i style="background:${COLORS.revenue}"></i>Revenue <i style="background:${COLORS.income}"></i>Net income
        <span class="chr-dim">latest FY${esc(last.fy)}: ${esc(bigMoney(last.rev, cur))} / ${esc(bigMoney(last.ni, cur))}${cur && cur !== 'USD' ? ` · reported in ${esc(cur)}` : ''}</span></div>
      <svg viewBox="0 0 ${W} ${H}" class="chr-growth-svg" role="img" aria-label="Annual revenue and net income, ${years.length} fiscal years">
        <line x1="${padL}" x2="${W - padR}" y1="${zero.toFixed(1)}" y2="${zero.toFixed(1)}" stroke="#334155"/>${bars}
      </svg>
      ${years.some(y => y.rev == null || y.ni == null) ? '<div class="chr-dim">n/r = not reported as a full year (left as a gap, not zero).</div>' : ''}
    </div>`;
  }

  // ---- TradingView widget (sandboxed) ----
  function tvSrcdoc(sym) {
    const cfg = JSON.stringify({
      autosize: true, symbol: sym, interval: 'D', timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en',
      backgroundColor: '#121826', hide_side_toolbar: true, allow_symbol_change: false, save_image: false,
      calendar: false, support_host: 'https://www.tradingview.com',
    }).replace(/</g, '\\u003c');
    const link = `https://www.tradingview.com/symbols/${encodeURIComponent(sym)}/`;
    // The widget script replaces .tradingview-widget-container__widget with its own iframe.
    // Offline / blocked: the script's onerror, or no iframe after 20 s, says so in place.
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer-when-downgrade">
<style>html,body{margin:0;height:100%;background:#121826;color:#94a3b8;font:12px system-ui,sans-serif}
.tradingview-widget-container{height:100%;width:100%;display:flex;flex-direction:column}
.tradingview-widget-container__widget{flex:1;min-height:0}
.tradingview-widget-copyright{height:22px;line-height:22px;text-align:right;padding:0 6px;font-size:11px}
.tradingview-widget-copyright a{color:#60a5fa;text-decoration:none}
.na{display:flex;align-items:center;justify-content:center;height:100%;color:#64748b}</style></head><body>
<div class="tradingview-widget-container">
<div class="tradingview-widget-container__widget" id="w"></div>
<div class="tradingview-widget-copyright"><a href="${esc(link)}" rel="noopener nofollow" target="_blank">${esc(sym)} chart by TradingView</a></div>
<script>function na(){var w=document.getElementById('w');if(w&&!w.querySelector('iframe'))w.innerHTML='<div class="na">chart unavailable</div>';}
setTimeout(na,20000);</script>
<script type="text/javascript" src="${TV_SCRIPT}" async onerror="na()">${cfg}</script>
</div></body></html>`;
  }
  function mountTV(host, sym, height) {
    const s = tvSymbol(sym);
    if (!s) { host.innerHTML = unavailableHTML(); return; }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) { host.innerHTML = unavailableHTML(); return; }
    const f = document.createElement('iframe');
    // No allow-same-origin: an opaque origin with no access to our cookies/localStorage.
    f.setAttribute('sandbox', 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
    f.setAttribute('title', `${s} chart (TradingView)`);
    f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    f.className = 'chr-tv';
    f.style.height = `${height}px`;
    f.srcdoc = tvSrcdoc(s);
    host.innerHTML = '';
    host.appendChild(f);
  }

  // ---- mount ----
  function mount(el, spec) {
    const ctx = { el, spec: spec || {}, disposed: false, chart: null, cleanups: [], box: null };
    const dispose = () => {
      if (ctx.disposed) return;
      ctx.disposed = true;
      for (const fn of ctx.cleanups.splice(0)) { try { fn(); } catch { /* already gone */ } }
      if (ctx.chart) { try { ctx.chart.remove(); } catch { /* already gone */ } ctx.chart = null; }
      // Take the iframe out too, so a closed drawer doesn't keep a widget running.
      if (ctx.box && ctx.box.parentNode) { try { ctx.box.remove(); } catch { /* gone */ } }
    };
    if (!el || typeof el.appendChild !== 'function') return dispose;
    try { start(ctx); }
    catch { try { el.innerHTML = unavailableHTML(); } catch { /* nothing to do */ } }
    return dispose;
  }

  function start(ctx) {
    const { el, spec } = ctx;
    const box = ctx.box = document.createElement('div');
    box.className = 'chr-box';
    el.innerHTML = '';
    el.appendChild(box);
    if (spec.kind === 'market') {
      const sym = tvSymbol(spec.symbol);
      box.innerHTML = `<div class="chr-head"><span class="chr-title">Chart</span>
          <span class="chr-dim">${sym ? `ETF proxy ${esc(sym)} · TradingView data` : ''}</span></div>
        <div data-chr-pane="tv"></div>`;
      mountTV(box.querySelector('[data-chr-pane="tv"]'), spec.symbol, 300);
      return;
    }
    const t = String(spec.ticker ?? spec.symbol ?? '').trim().toUpperCase();
    if (spec.kind !== 'stock' || !TICKER_RE.test(t)) { box.innerHTML = unavailableHTML(); return; }
    ctx.ticker = t;
    const A = auth();
    const maybeOwner = !!(A && A.available && A.available() && A.currentUser && A.currentUser());
    if (!maybeOwner) { showTVOnly(ctx); return; }
    box.innerHTML = `<div class="chr-head"><span class="chr-title">Chart</span></div>${unavailableHTML('Loading chart…')}`;
    const timeout = new Promise(res => setTimeout(() => res(null), SERIES_TIMEOUT_MS));
    Promise.race([Promise.resolve().then(() => A.chartSeries(t)), timeout])
      .catch(() => null)
      .then(res => {
        if (ctx.disposed) return;
        const pts = res ? seriesPoints(res.calendar, res.row) : null;
        const fund = res?.row?.fundamentals;
        if (!pts && !fund) { showTVOnly(ctx); return; }
        showOwner(ctx, res, pts, fund);
      })
      .catch(() => { if (!ctx.disposed) box.innerHTML = unavailableHTML(); });
  }

  function showTVOnly(ctx) {
    ctx.box.innerHTML = `<div class="chr-head"><span class="chr-title">Chart</span>
        <span class="chr-dim">TradingView data</span></div><div data-chr-pane="tv"></div>`;
    mountTV(ctx.box.querySelector('[data-chr-pane="tv"]'), ctx.ticker, 300);
  }

  // Owner view: tabs [Price | TradingView], the LWC pane, the growth record, the footnote.
  function showOwner(ctx, res, pts, fund) {
    const { box, ticker } = ctx;
    const growth = fund ? growthSVG(typeof fund === 'string' ? safeJSON(fund) : fund) : '';
    // The last bar actually on the chart (the row's asof is when the cache was written).
    const lastBar = pts ? (() => { for (let i = pts.length - 1; i >= 0; i--) if (isNum(pts[i].value)) return isoDay(pts[i].time); return null; })() : null;
    box.innerHTML = `<div class="chr-head">
        <div class="chr-tabs" role="tablist">
          <button type="button" role="tab" class="chr-tab" data-chr-tab="price" aria-selected="true">Price</button>
          <button type="button" role="tab" class="chr-tab" data-chr-tab="tv" aria-selected="false">TradingView</button>
        </div>
        <span class="chr-dim">${lastBar ? `closes to ${esc(lastBar)}` : ''}</span></div>
      <div data-chr-pane="price"></div>
      <div data-chr-pane="tv" hidden></div>
      ${growth}`;
    const pricePane = box.querySelector('[data-chr-pane="price"]');
    const tvPane = box.querySelector('[data-chr-pane="tv"]');
    let tvMounted = false;
    const onTab = e => {
      const b = e.target.closest('[data-chr-tab]');
      if (!b || !box.contains(b)) return;
      const which = b.dataset.chrTab;
      box.querySelectorAll('[data-chr-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
      pricePane.hidden = which !== 'price';
      tvPane.hidden = which !== 'tv';
      if (which === 'tv' && !tvMounted) { tvMounted = true; mountTV(tvPane, ticker, 300); }
    };
    box.addEventListener('click', onTab);
    ctx.cleanups.push(() => box.removeEventListener('click', onTab));
    if (!pts) {
      // A growth record but no closes on file: the price view is TradingView's.
      pricePane.innerHTML = unavailableHTML('No owner price series on file for this stock.');
      box.querySelector('[data-chr-tab="tv"]').click();
      return;
    }
    pricePane.innerHTML = unavailableHTML('Loading chart…');
    ensureLib().then(LW => {
      if (ctx.disposed) return;
      if (!LW) { pricePane.innerHTML = unavailableHTML(); return; }
      try { drawPrice(ctx, LW, pricePane, pts); }
      catch { if (ctx.chart) { try { ctx.chart.remove(); } catch { /* gone */ } ctx.chart = null; } pricePane.innerHTML = unavailableHTML(); }
    });
  }
  const safeJSON = s => { try { return JSON.parse(s); } catch { return null; } };

  function drawPrice(ctx, LW, pane, pts) {
    const { spec, ticker } = ctx;
    const first = pts[0].time, last = pts[pts.length - 1].time;
    const spanYears = (last - first) / (365.25 * DAY);
    const avg = longAverage(pts, spec);
    const ranges = RANGES.filter(([, d]) => d * DAY < last - first);
    pane.innerHTML = `
      <div class="chr-toolbar">
        <div class="chr-ranges" role="group" aria-label="Range">
          ${ranges.map(([l, d]) => `<button type="button" data-chr-range="${d}">${l}</button>`).join('')}
          <button type="button" data-chr-range="all" class="on">All (${spanYears.toFixed(1)}y)</button>
        </div>
      </div>
      <div class="chr-legend" aria-live="off"></div>
      <div class="chr-canvas"></div>
      <div class="chr-toggles">
        ${avg ? `<label title="${esc(avgLabel(avg.years))}"><input type="checkbox" data-chr-toggle="avg" checked> <i style="background:${COLORS.avg}"></i>${esc(avgShort(avg.years))}</label>` : ''}
        <label><input type="checkbox" data-chr-toggle="sma50"> <i style="background:${COLORS.sma50}"></i>50-day</label>
        <label><input type="checkbox" data-chr-toggle="sma200"> <i style="background:${COLORS.sma200}"></i>200-day</label>
        <form class="chr-compare" data-chr-compare>
          <input type="text" maxlength="16" placeholder="Compare ticker" aria-label="Compare with another stock" autocomplete="off" spellcheck="false">
          <button type="submit">Compare</button>
        </form>
      </div>
      <div class="chr-note" data-chr-note></div>
      <div class="chr-foot">Split-adjusted daily closes only — no candles/volume (licence). Price moves are not growth:
        growth here is the business's revenue/earnings record below.</div>`;
    const canvas = pane.querySelector('.chr-canvas');
    const legend = pane.querySelector('.chr-legend');
    const note = pane.querySelector('[data-chr-note]');
    const H = 240;
    const chart = ctx.chart = LW.createChart(canvas, {
      autoSize: true, width: canvas.clientWidth || 320, height: H,
      layout: { background: { type: 'solid', color: '#121826' }, textColor: '#94a3b8', fontSize: 11, attributionLogo: true },
      grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } },
      rightPriceScale: { borderColor: '#243049' },
      timeScale: { borderColor: '#243049', timeVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0 },
      localization: { locale: safeLocale() },
      // Vertical swipes scroll the drawer, not the chart.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    });
    const price = chart.addLineSeries({ color: COLORS.close, lineWidth: 2, title: ticker,
      priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, priceLineVisible: false });
    price.setData(pts);
    const overlay = opts => chart.addLineSeries({ lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: 2, minMove: 0.01 }, ...opts });
    const S = { price, avg: null, sma50: null, sma200: null, compare: null, compareTicker: null };
    const data = new Map([[price, pts]]);

    // The long-run average: a level, drawn across exactly the window it averages.
    const notes = [];
    if (avg) {
      if (avg.from != null) {
        S.avg = overlay({ color: COLORS.avg, lineStyle: 2, lineWidth: 1, lastValueVisible: true, title: avgShort(avg.years) });
        const line = pts.filter(p => p.time >= avg.from && p.time <= avg.to).map(p => ({ time: p.time, value: avg.level }));
        S.avg.setData(line);
        data.set(S.avg, line);
      }
      notes.push(`<span><i style="background:${COLORS.avg}"></i>${esc(avgLabel(avg.years))}: ${esc(fmtPrice(avg.level))}</span>`);
      if (avg.check === false) {
        notes.push(`<span class="chr-warn">The chart's own closes average ${esc(fmtPrice(avg.mean))} (${esc(fmtPct(avg.off))} vs the screen's figure) —
          the chart cache and the stock snapshot may be from different days.</span>`);
      } else if (avg.check == null && avg.mean != null) {
        notes.push('<span class="chr-dim">Computed from the closes on this chart (no snapshot figure to check against).</span>');
      }
    }
    note.innerHTML = notes.join('');

    const setSMA = (which, on) => {
      const n = which === 'sma50' ? 50 : 200;
      if (on && !S[which]) {
        const d = sma(pts, n);
        if (!d.length) { note.insertAdjacentHTML('beforeend', `<span class="chr-dim">Not enough closes for a ${n}-day average.</span>`); return false; }
        S[which] = overlay({ color: COLORS[which], title: `${n}d` });
        S[which].setData(d);
        data.set(S[which], d);
      } else if (!on && S[which]) {
        data.delete(S[which]);
        chart.removeSeries(S[which]);
        S[which] = null;
      }
      return true;
    };

    // Legend: the crosshair's day, or the last bar. In compare mode, price change since the
    // first visible bar, per series — labelled as price change, never growth.
    const valueAt = (arr, time) => {
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].time === time) return isNum(arr[mid].value) ? arr[mid].value : null;
        if (arr[mid].time < time) lo = mid + 1; else hi = mid - 1;
      }
      return null;
    };
    const firstVisible = arr => {
      const r = chart.timeScale().getVisibleRange();
      const from = r && isNum(r.from) ? r.from : first;
      for (const p of arr) if (p.time >= from && isNum(p.value)) return p.value;
      return null;
    };
    const lastValue = arr => { for (let i = arr.length - 1; i >= 0; i--) if (isNum(arr[i].value)) return arr[i]; return null; };
    const updateLegend = time => {
      const t = isNum(time) ? time : lastValue(pts)?.time;
      if (!isNum(t)) { legend.textContent = ''; return; }
      const parts = [`<b>${esc(isoDay(t))}</b>`];
      if (S.compare) {
        for (const [s, lbl, c] of [[price, ticker, COLORS.close], [S.compare, S.compareTicker, COLORS.compare]]) {
          const arr = data.get(s), v = valueAt(arr, t), v0 = firstVisible(arr);
          parts.push(`<span><i style="background:${c}"></i>${esc(lbl)} ${esc(v != null && v0 ? fmtPct(v / v0 - 1) : '—')}</span>`);
        }
        parts.push('<span class="chr-dim">price change since the first visible day</span>');
      } else {
        parts.push(`<span><i style="background:${COLORS.close}"></i>close ${esc(fmtPrice(valueAt(pts, t)))}</span>`);
        if (S.avg) { const v = valueAt(data.get(S.avg), t); if (v != null) parts.push(`<span><i style="background:${COLORS.avg}"></i>${esc(avgShort(avg.years))} ${esc(fmtPrice(v))}</span>`); }
        for (const [k, l] of [['sma50', '50d'], ['sma200', '200d']]) {
          if (!S[k]) continue;
          const v = valueAt(data.get(S[k]), t);
          if (v != null) parts.push(`<span><i style="background:${COLORS[k]}"></i>${l} ${esc(fmtPrice(v))}</span>`);
        }
      }
      legend.innerHTML = parts.join('');
    };
    const onMove = param => { if (!ctx.disposed) updateLegend(param && isNum(param.time) ? param.time : null); };
    chart.subscribeCrosshairMove(onMove);
    const onRange = () => { if (!ctx.disposed && S.compare) updateLegend(null); };
    chart.timeScale().subscribeVisibleTimeRangeChange(onRange);
    ctx.cleanups.push(() => { chart.unsubscribeCrosshairMove(onMove); chart.timeScale().unsubscribeVisibleTimeRangeChange(onRange); });

    const setRange = r => {
      pane.querySelectorAll('[data-chr-range]').forEach(b => b.classList.toggle('on', b.dataset.chrRange === r));
      if (r === 'all') chart.timeScale().fitContent();
      else chart.timeScale().setVisibleRange({ from: Math.max(first, last - Number(r) * DAY), to: last });
    };
    setRange('all');
    updateLegend(null);

    // Compare: one more owner series on the same calendar, both in percentage mode.
    const compareChip = () => {
      const f = pane.querySelector('[data-chr-compare]');
      const chip = pane.querySelector('[data-chr-uncompare]');
      if (chip) chip.remove();
      if (S.compare) {
        f.insertAdjacentHTML('afterend', `<button type="button" class="chr-chip" data-chr-uncompare title="Remove the comparison">
          <i style="background:${COLORS.compare}"></i>${esc(S.compareTicker)} ×</button>`);
      }
    };
    // Compare mode is percentage-scaled, where price-level overlays mean nothing: hide them,
    // then restore each one as its own checkbox says.
    const setOverlaysVisible = on => {
      const box = k => pane.querySelector(`[data-chr-toggle="${k}"]`);
      for (const k of ['avg', 'sma50', 'sma200']) {
        if (S[k]) S[k].applyOptions({ visible: on && (!box(k) || box(k).checked) });
      }
      pane.querySelectorAll('[data-chr-toggle]').forEach(i => { i.disabled = !on; });
    };
    const removeCompare = () => {
      if (!S.compare) return;
      data.delete(S.compare);
      chart.removeSeries(S.compare);
      S.compare = null; S.compareTicker = null;
      chart.priceScale('right').applyOptions({ mode: 0 });   // PriceScaleMode.Normal
      setOverlaysVisible(true);
      compareChip(); updateLegend(null);
    };
    const doCompare = async raw => {
      const other = String(raw ?? '').trim().toUpperCase();
      const say = m => { note.querySelector('[data-chr-cmpmsg]')?.remove(); if (m) note.insertAdjacentHTML('beforeend', `<span class="chr-warn" data-chr-cmpmsg>${esc(m)}</span>`); };
      if (!other) return;
      if (!TICKER_RE.test(other)) { say('Enter a ticker, e.g. MSFT.'); return; }
      if (other === ticker) { say('That is this chart.'); return; }
      const A = auth();
      say('');
      const res = A ? await Promise.race([Promise.resolve().then(() => A.chartSeries(other)).catch(() => null),
        new Promise(r => setTimeout(() => r(null), SERIES_TIMEOUT_MS))]) : null;
      if (ctx.disposed) return;
      const cp = res ? seriesPoints(res.calendar, res.row) : null;
      if (!cp) { say(`No owner price series on file for ${other}.`); return; }
      if (S.compare) { data.delete(S.compare); chart.removeSeries(S.compare); }
      S.compare = chart.addLineSeries({ color: COLORS.compare, lineWidth: 2, title: other, priceLineVisible: false });
      S.compare.setData(cp);
      data.set(S.compare, cp);
      S.compareTicker = other;
      chart.priceScale('right').applyOptions({ mode: 2 });   // PriceScaleMode.Percentage
      setOverlaysVisible(false);
      compareChip(); updateLegend(null);
    };

    const onClick = e => {
      const r = e.target.closest('[data-chr-range]');
      if (r && pane.contains(r)) { setRange(r.dataset.chrRange); return; }
      if (e.target.closest('[data-chr-uncompare]')) removeCompare();
    };
    const onChange = e => {
      const tg = e.target.closest('[data-chr-toggle]');
      if (!tg) return;
      const k = tg.dataset.chrToggle;
      if (k === 'avg') { if (S.avg) S.avg.applyOptions({ visible: tg.checked }); }
      else if (!setSMA(k, tg.checked)) tg.checked = false;
      updateLegend(null);
    };
    const onSubmit = e => {
      if (!e.target.closest('[data-chr-compare]')) return;
      e.preventDefault();
      const input = e.target.querySelector('input');
      doCompare(input.value).catch(() => { /* chart gone */ });
    };
    pane.addEventListener('click', onClick);
    pane.addEventListener('change', onChange);
    pane.addEventListener('submit', onSubmit);
    ctx.cleanups.push(() => {
      pane.removeEventListener('click', onClick); pane.removeEventListener('change', onChange); pane.removeEventListener('submit', onSubmit);
    });
  }

  return {
    mount, ensureLib,
    // Pure helpers, exposed for tests.
    _internal: { seriesPoints, sma, longAverage, avgLabel, tvSymbol, growthSVG, tvSrcdoc },
  };
})();
