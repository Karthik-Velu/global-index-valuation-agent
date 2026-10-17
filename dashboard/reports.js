// Key reports (#/reports, #/reports/<slug>) — fund-house-style research notes, published as
// static JSON next to the page: dashboard/reports/<slug>.json, listed newest first in
// dashboard/reports/index.json (schema v1, checked by scripts/test_reports.js). Public: a
// report is EDGAR (public domain) plus cited public sources, so no sign-in, no Supabase.
//
// Safety: report text is data, never markup. Every node is built with createElement /
// textContent (innerHTML is never assigned in this file). The only inline markup is
// **bold** and citation markers [s3] / [s3,s5], which become <strong> and superscript
// links to the numbered source list. Links are https: only (new tab, rel="noopener
// noreferrer"). A citation scrolls to its source from a click handler: the hash belongs to
// the router, so the link's href is the report's own route (open-in-new-tab still works).
// The "chart" block reuses charts.js's sandboxed TradingView iframe (Charts.mount, kind
// 'symbol'); print hides it and shows a note in its place.
//
// UMD: assigns window.Reports in the browser and module.exports under Node (the tests),
// like screen-dsl.js; declares no other global.
//   Reports.renderList(el) -> Promise              #/reports: the report cards
//   Reports.renderReport(el, slug) -> Promise      #/reports/<slug> ("not found" otherwise)
//   Reports.findByTicker(ticker) -> Promise<index entry | null>   never rejects
//   Reports.unmount()                              the view was left: drop the live chart
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reports = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SLUG_RE = /^[a-z0-9-]{1,40}$/;
  const CITE_SRC = '\\[(s\\d{1,3}(?:\\s*,\\s*s\\d{1,3})*)\\]';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const FETCH_TIMEOUT_MS = 10000;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // The dashboard palette (accent, cheap, warn, then the chart accents charts.js uses).
  const SERIES_COLORS = ['#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#f472b6', '#2dd4bf'];
  const STANCE_TONE = { Positive: 'pos', Neutral: 'neu', Cautious: 'cau' };
  const RISK_TONE = { Low: 'pos', Medium: 'neu', High: 'cau', 'Very high': 'neg' };
  // Bear / Base / Bull are required; a Restructuring (equity ≈ 0) tail case is optional.
  const SCENARIOS = ['Restructuring', 'Bear', 'Base', 'Bull'];
  const CALLOUT_TONES = new Set(['info', 'positive', 'risk']);

  // seq: bumps on every render/unmount, so a late fetch for a page that was left is dropped.
  const S = { seq: 0, disposers: [], indexP: null, shown: null, title: null };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const str = v => (v == null ? '' : String(v));
  const doc = () => document;

  // ---------------- pure helpers (exported for tests) ----------------
  // '**a** b [s1,s2]' -> [{t:'b', parts:[{t:'text', v:'a'}]}, {t:'text', v:' b '}, {t:'cite', ids:['s1','s2']}].
  // An unmatched trailing '**' stays literal text; nothing else is markup.
  function citeTokens(seg) {
    const out = [], re = new RegExp(CITE_SRC, 'g');
    let last = 0, m;
    while ((m = re.exec(seg))) {
      if (m.index > last) out.push({ t: 'text', v: seg.slice(last, m.index) });
      out.push({ t: 'cite', ids: m[1].split(',').map(x => x.trim()) });
      last = m.index + m[0].length;
    }
    if (last < seg.length) out.push({ t: 'text', v: seg.slice(last) });
    return out;
  }
  function parseInline(text) {
    const parts = str(text).split('**');
    const matched = parts.length % 2 === 1;      // an even number of '**': every one is paired
    const out = [];
    parts.forEach((seg, i) => {
      const bold = i % 2 === 1;
      if (bold && !matched && i === parts.length - 1) { out.push(...citeTokens('**' + seg)); return; }
      if (!seg) return;
      if (bold) out.push({ t: 'b', parts: citeTokens(seg) });
      else out.push(...citeTokens(seg));
    });
    // Neighbouring text tokens (from a literal '**') read as one.
    return out.reduce((acc, tk) => {
      const prev = acc[acc.length - 1];
      if (tk.t === 'text' && prev && prev.t === 'text') prev.v += tk.v; else acc.push(tk);
      return acc;
    }, []);
  }
  // Markup stripped: for card summaries and accessible labels.
  const plainText = text => parseInline(text).map(tk => tk.t === 'text' ? tk.v
    : tk.t === 'b' ? tk.parts.filter(p => p.t === 'text').map(p => p.v).join('') : '').join('').replace(/\s+/g, ' ').replace(/\s([.,;:])/g, '$1').trim();
  function safeUrl(u) {
    try { const x = new URL(str(u)); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
  }
  // 'YYYY-MM-DD' -> '17 Oct 2026'; 'YYYY-MM' (a source page that gives no day) -> 'Oct 2026'.
  // No Date parsing: no timezone shift.
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(str(d));
    if (!m || +m[2] < 1 || +m[2] > 12) return str(d);
    return m[3] ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : `${MONTHS[+m[2] - 1]} ${m[1]}`;
  }
  const minus = s => s.replace(/^-/, '−');
  function fmtCell(v) {
    if (v == null) return '—';
    if (typeof v === 'number') return isNum(v) ? minus(v.toLocaleString('en-US', { maximumFractionDigits: 2 })) : '—';
    return str(v);
  }
  function fmtVal(v) {
    const a = Math.abs(v);
    return minus(v.toLocaleString('en-US', { maximumFractionDigits: a >= 100 ? 0 : a >= 10 ? 1 : 2 }));
  }
  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  // The value axis always includes zero, so bars grow from a zero baseline either way.
  function barsScale(values) {
    const nums = values.filter(isNum);
    let lo = Math.min(0, ...nums), hi = Math.max(0, ...nums);
    if (lo === hi) hi = 1;                      // all zero / no data: a unit axis
    const step = niceStep(hi - lo, 4);
    lo = Math.floor(lo / step + 1e-9) * step || 0;       // `|| 0`: never a -0 tick
    hi = Math.ceil(hi / step - 1e-9) * step || 0;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12) || 0);
    return { lo, hi, step, ticks };
  }

  // ---------------- DOM builders (createElement / textContent only) ----------------
  function put(el, attrs, kids) {
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat(2)) {
      if (k == null || k === false) continue;
      el.appendChild(typeof k === 'object' ? k : doc().createTextNode(String(k)));
    }
    return el;
  }
  const h = (tag, attrs, ...kids) => put(doc().createElement(tag), attrs, kids);
  const sv = (tag, attrs, ...kids) => put(doc().createElementNS(SVG_NS, tag), attrs, kids);
  const txt = t => doc().createTextNode(str(t));
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }

  function cite(ids, ctx) {
    const sup = h('sup', { class: 'rpt-cite' });
    ids.forEach((id, i) => {
      if (i) sup.appendChild(txt(','));
      const n = ctx.num.get(id);
      if (!n) { sup.appendChild(txt(id)); return; }
      sup.appendChild(h('a', { href: ctx.self, 'data-rpt-src': id, title: ctx.srcLabel.get(id), 'aria-label': `Source ${n}` }, String(n)));
    });
    return sup;
  }
  function inline(text, ctx) {
    return parseInline(text).map(tk => tk.t === 'text' ? txt(tk.v)
      : tk.t === 'cite' ? cite(tk.ids, ctx)
      : h('strong', null, tk.parts.map(p => (p.t === 'cite' ? cite(p.ids, ctx) : txt(p.v)))));
  }
  const pill = (label, tone) => h('span', { class: `rpt-pill ${tone || 'neu'}` }, label);
  function srcLine(ids, ctx) {
    const list = (Array.isArray(ids) ? ids : ids ? [ids] : []).filter(id => ctx.num.has(id));
    if (!list.length) return null;
    const line = h('div', { class: 'rpt-srcline' }, list.length > 1 ? 'Sources: ' : 'Source: ');
    list.forEach((id, i) => {
      if (i) line.appendChild(txt('; '));
      line.appendChild(h('a', { href: ctx.self, 'data-rpt-src': id }, `[${ctx.num.get(id)}] ${ctx.srcShort.get(id)}`));
    });
    return line;
  }
  const exhibit = (ctx, caption) => h('figcaption', { class: 'rpt-cap' },
    h('span', { class: 'rpt-exh' }, `Exhibit ${++ctx.exhibit}`), txt(caption ? ` ${caption}` : ''));

  // ---------------- blocks ----------------
  function tableBlock(b, ctx) {
    const cols = Array.isArray(b.columns) ? b.columns : [];
    const align = i => (Array.isArray(b.align) && (b.align[i] === 'l' || b.align[i] === 'r') ? b.align[i] : i === 0 ? 'l' : 'r');
    const head = h('tr', null, cols.map((c, i) => h('th', { scope: 'col', class: align(i) }, str(c))));
    const body = (Array.isArray(b.rows) ? b.rows : []).map(row => h('tr', null, cols.map((_, i) => {
      const v = Array.isArray(row) ? row[i] : null;
      const cell = typeof v === 'string' ? inline(v, ctx) : fmtCell(v);
      return i === 0 ? h('th', { scope: 'row', class: align(i) }, cell) : h('td', { class: align(i) }, cell);
    })));
    return h('figure', { class: 'rpt-fig' }, exhibit(ctx, b.caption),
      h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': str(b.caption) || 'Table' },
        h('table', { class: 'rpt-table' }, h('thead', null, head), h('tbody', null, body))),
      b.note ? h('div', { class: 'rpt-note' }, inline(b.note, ctx)) : null,
      srcLine(b.src, ctx));
  }

  // Grouped bars as inline SVG (the scatter's hand-built idiom): a zero baseline, negative
  // bars hang below it, a null is a gap marked n/a — never drawn as zero. The SVG carries its
  // own width, so CSS only ever shrinks it (narrow screens), never scales it past 1:1 — and
  // never below BARS_MIN_SCALE either (--rpt-bars-minw): a 1000-unit chart squeezed into a
  // phone's 440 px would set its 10px labels at ~4px, so past that point the chart keeps a
  // legible size and scrolls sideways in its own box instead.
  // Value labels never overprint: a label that would collide with one already placed in its
  // group is nudged one line further from the bar, and dropped if it still collides or would
  // leave the plot (its value stays in the bar's tooltip and the chart's <desc>).
  const LABEL_CHAR_W = 6.2, LABEL_H = 11, BARS_MIN_SCALE = 0.9;
  const labelBox = (cx, y, t) => { const w = t.length * LABEL_CHAR_W; return { x0: cx - w / 2, x1: cx + w / 2, y0: y - 9, y1: y + 2 }; };
  const overlaps = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
  function barsBlock(b, ctx) {
    const labels = (Array.isArray(b.labels) ? b.labels : []).map(str);
    const series = (Array.isArray(b.series) ? b.series : []).slice(0, SERIES_COLORS.length)
      .map((s, i) => ({ name: str(s && s.name), color: SERIES_COLORS[i], values: labels.map((_, j) => (s && Array.isArray(s.values) && isNum(s.values[j]) ? s.values[j] : null)) }));
    const unit = str(b.unit);
    const pctUnit = unit.trim() === '%';
    const sc = barsScale(series.flatMap(s => s.values));
    const nS = Math.max(1, series.length), nG = Math.max(1, labels.length);
    const padL = 52, padR = 12, padT = 20, padB = 30, H = 270;
    const W = Math.max(520, padL + padR + nG * (nS * 30 + 26));
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const y = v => padT + ((sc.hi - v) / (sc.hi - sc.lo)) * plotH;
    const y0 = y(0), groupW = plotW / nG;
    const barW = Math.min(30, (groupW * 0.78) / nS);
    const id = `rpt-bars-${ctx.slug}-${++ctx.bars}`;
    const valText = v => fmtVal(v) + (pctUnit ? '%' : '');
    const desc = labels.map((l, j) => `${l}: ${series.map(s => `${s.name} ${s.values[j] == null ? 'n/a' : valText(s.values[j])}`).join(', ')}`).join('; ');
    const svg = sv('svg', { class: 'rpt-bars', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d`, preserveAspectRatio: 'xMidYMid meet',
        style: `--rpt-bars-minw:${Math.ceil(W * BARS_MIN_SCALE)}px` },
      sv('title', { id: `${id}-t` }, `${str(b.title)}${unit ? ` (${unit})` : ''}`),
      sv('desc', { id: `${id}-d` }, desc));
    for (const t of sc.ticks) {
      const ty = y(t).toFixed(1);
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: ty, y2: ty, class: t === 0 ? 'rpt-zero' : 'rpt-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: (+ty + 3.5).toFixed(1), 'text-anchor': 'end', class: 'rpt-tick' }, valText(t)));
    }
    labels.forEach((l, j) => {
      const gx = padL + j * groupW, x0 = gx + (groupW - barW * nS) / 2;
      const placed = [];
      series.forEach((s, i) => {
        const v = s.values[j], bx = x0 + i * barW, cx = (bx + barW / 2).toFixed(1);
        if (v == null) { svg.appendChild(sv('text', { x: cx, y: (y0 - 4).toFixed(1), 'text-anchor': 'middle', class: 'rpt-na' }, 'n/a')); return; }
        const top = Math.min(y(v), y0), hgt = Math.max(Math.abs(y(v) - y0), v === 0 ? 0 : 0.8);
        svg.appendChild(sv('rect', { x: (bx + 1).toFixed(1), y: top.toFixed(1), width: Math.max(1, barW - 2).toFixed(1), height: hgt.toFixed(1), fill: s.color, rx: 1.5 },
          sv('title', null, `${l} · ${s.name}: ${valText(v)}${unit && !pctUnit ? ` ${unit}` : ''}`)));
        const t = valText(v), dir = v >= 0 ? -1 : 1;
        let ly = v >= 0 ? top - 4 : top + hgt + 11;
        for (let k = 0; k < 2 && placed.some(b => overlaps(b, labelBox(+cx, ly, t))); k++) ly += dir * LABEL_H;
        const box = labelBox(+cx, ly, t);
        if (placed.some(b => overlaps(b, box)) || box.y0 < 0 || box.y1 > H) return;
        placed.push(box);
        svg.appendChild(sv('text', { x: cx, y: ly.toFixed(1), 'text-anchor': 'middle', class: 'rpt-val' }, t));
      });
      svg.appendChild(sv('text', { x: (gx + groupW / 2).toFixed(1), y: H - 10, 'text-anchor': 'middle', class: 'rpt-xl' }, l));
    });
    const legend = h('div', { class: 'rpt-legend' },
      series.map(s => h('span', null, h('i', { style: `background:${s.color}` }), s.name)),
      unit ? h('span', { class: 'rpt-unit' }, unit) : null);
    return h('figure', { class: 'rpt-fig' }, exhibit(ctx, b.title), legend,
      h('div', { class: 'rpt-barswrap' }, svg), srcLine(b.src, ctx));
  }

  function scenariosBlock(b, ctx) {
    const rows = (Array.isArray(b.rows) ? b.rows : []).filter(r => r && SCENARIOS.includes(r.name))
      .sort((a, c) => SCENARIOS.indexOf(a.name) - SCENARIOS.indexOf(c.name));
    return h('div', { class: `rpt-scen${rows.length > 3 ? ' n4' : ''}` }, rows.map(r => h('div', { class: `rpt-scen-card ${r.name.toLowerCase()}` },
      h('div', { class: 'rpt-scen-name' }, `${r.name} case`),
      h('div', { class: 'rpt-scen-val' }, str(r.value)),
      r.prob ? h('div', { class: 'rpt-scen-prob' }, `Probability: ${str(r.prob)}`) : null,
      h('p', null, inline(r.text, ctx)))));
  }

  function chartBlock(b, ctx) {
    const sym = str(b.symbol).toUpperCase();
    const slot = h('div', { class: 'rpt-chart-slot' });
    ctx.charts.push(() => mountChart(slot, sym));
    return h('figure', { class: 'rpt-fig rpt-chart' }, exhibit(ctx, `Share-price performance (${sym})`), slot,
      h('p', { class: 'rpt-print-only rpt-note' }, `Live share-price chart (${sym}, TradingView data) in the online version of this report.`),
      h('div', { class: 'rpt-srcline rpt-noprint' }, 'Live chart: TradingView data, shown for context — not part of this report’s analysis.'));
  }
  function mountChart(slot, sym) {
    if (typeof Charts === 'undefined' || !Charts || typeof Charts.mount !== 'function') {
      slot.appendChild(h('div', { class: 'rpt-chart-na' }, 'Chart unavailable right now.'));
      return;
    }
    try {
      const d = Charts.mount(slot, { kind: 'symbol', symbol: sym, height: 380 });
      if (typeof d === 'function') S.disposers.push(d);
    } catch { slot.appendChild(h('div', { class: 'rpt-chart-na' }, 'Chart unavailable right now.')); }
  }

  function block(b, ctx) {
    if (!b || typeof b !== 'object') return null;
    switch (b.type) {
      case 'p': return h('p', null, inline(b.text, ctx));
      case 'bullets': return h('ul', { class: 'rpt-bul' }, (Array.isArray(b.items) ? b.items : []).map(it => h('li', null, inline(it, ctx))));
      case 'table': return tableBlock(b, ctx);
      case 'bars': return barsBlock(b, ctx);
      case 'callout': {
        const tone = CALLOUT_TONES.has(b.tone) ? b.tone : 'info';
        return h('aside', { class: `rpt-callout ${tone}`, role: 'note' },
          b.title ? h('div', { class: 'rpt-callout-t' }, str(b.title)) : null, h('p', null, inline(b.text, ctx)));
      }
      case 'scenarios': return scenariosBlock(b, ctx);
      case 'kv': return h('dl', { class: 'rpt-kv' }, (Array.isArray(b.items) ? b.items : []).map(it =>
        h('div', null, h('dt', null, str(it && it.label)), h('dd', null, inline(it && it.value, ctx)))));
      case 'chart': return chartBlock(b, ctx);
      default: return null;                    // unknown block type: skipped (the validator rejects it)
    }
  }

  // ---------------- the report ----------------
  function build(r) {
    const slug = str(r.slug);
    const sources = Array.isArray(r.sources) ? r.sources.filter(s => s && typeof s.id === 'string') : [];
    const ctx = { slug, self: `#/reports/${slug}`, num: new Map(), srcLabel: new Map(), srcShort: new Map(), exhibit: 0, bars: 0, charts: [] };
    sources.forEach((s, i) => {
      if (ctx.num.has(s.id)) return;
      ctx.num.set(s.id, i + 1);
      ctx.srcLabel.set(s.id, [s.title, s.publisher].filter(Boolean).map(str).join(' — '));
      ctx.srcShort.set(s.id, str(s.publisher || s.title));
    });
    const stance = r.stance && typeof r.stance === 'object' ? r.stance : {};
    const sections = (Array.isArray(r.sections) ? r.sections : []).filter(s => s && typeof s === 'object');

    const cover = h('header', { class: 'rpt-cover' },
      h('div', { class: 'rpt-eyebrow' },
        h('span', null, 'GIVA Research · Key report'),
        h('span', null, [r.report_type, r.sector, fmtDate(r.published)].filter(Boolean).map(str).join(' · '))),
      h('h1', { class: 'rpt-company' }, str(r.company), ' ',
        h('span', { class: 'rpt-tk' }, `${str(r.exchange)}${r.exchange ? ': ' : ''}${str(r.ticker)}`)),
      h('h2', { class: 'rpt-title' }, str(r.title)),
      r.subtitle ? h('p', { class: 'rpt-subtitle' }, str(r.subtitle)) : null,
      h('div', { class: 'rpt-stance' },
        stance.label ? pill(`Stance: ${str(stance.label)}`, STANCE_TONE[stance.label]) : null,
        stance.risk ? pill(`Risk: ${str(stance.risk)}`, RISK_TONE[stance.risk]) : null,
        stance.horizon ? h('span', { class: 'rpt-horizon' }, `Horizon: ${str(stance.horizon)}`) : null),
      stance.summary ? h('p', { class: 'rpt-stance-sum' }, inline(stance.summary, ctx)) : null);

    const stats = (Array.isArray(r.key_stats) ? r.key_stats : []).filter(s => s && typeof s === 'object');
    const side = h('aside', { class: 'rpt-side' },
      h('div', { class: 'rpt-box rpt-stats' },
        h('h3', { class: 'rpt-boxt' }, 'Key data'),
        h('dl', null, stats.map(s => h('div', { class: 'rpt-stat' },
          h('dt', null, str(s.label), s.note ? h('span', { class: 'rpt-stat-note' }, str(s.note)) : null),
          h('dd', null, str(s.value), s.src ? cite(Array.isArray(s.src) ? s.src : [s.src], ctx) : null)))),
        h('div', { class: 'rpt-asof' }, `Data as of ${fmtDate(r.data_asof)} · published ${fmtDate(r.published)}`)),
      sections.length ? h('nav', { class: 'rpt-box rpt-toc', 'aria-label': 'Contents' },
        h('h3', { class: 'rpt-boxt' }, 'Contents'),
        h('ol', null, sections.map(s => h('li', null, h('a', { href: ctx.self, 'data-rpt-sec': str(s.id) }, str(s.title)))),
          h('li', null, h('a', { href: ctx.self, 'data-rpt-sec': 'sources' }, 'Sources & disclosures')))) : null);

    const highlights = (Array.isArray(r.highlights) ? r.highlights : []);
    const main = h('div', { class: 'rpt-main' },
      highlights.length ? h('section', { class: 'rpt-summary', 'aria-label': 'Investment summary' },
        h('h2', null, 'Investment summary'),
        h('ul', { class: 'rpt-bul' }, highlights.map(t => h('li', null, inline(t, ctx))))) : null,
      sections.map((s, i) => h('section', { class: 'rpt-sec', id: `rpt-sec-${str(s.id)}` },
        h('h2', null, h('span', { class: 'rpt-num' }, String(i + 1)), h('span', null, str(s.title))),
        (Array.isArray(s.blocks) ? s.blocks : []).map(b => block(b, ctx)))),
      h('section', { class: 'rpt-sec rpt-end', id: 'rpt-sec-sources' },
        h('h2', null, h('span', { class: 'rpt-num' }, String(sections.length + 1)), h('span', null, 'Sources')),
        h('ol', { class: 'rpt-srcs' }, sources.map(s => {
          const url = safeUrl(s.url);
          return h('li', { id: `src-${s.id}`, tabindex: '-1' },
            h('span', { class: 'rpt-src-t' }, str(s.title)), '. ',
            [s.publisher, s.date ? fmtDate(s.date) : ''].filter(Boolean).map(str).join(', '), s.publisher || s.date ? '. ' : '',
            url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url) : h('span', { class: 'rpt-dim' }, str(s.url)));
        })),
        h('h3', { class: 'rpt-disch' }, 'Disclosures'),
        h('div', { class: 'rpt-disc' }, (Array.isArray(r.disclosures) ? r.disclosures : []).map(t => h('p', null, inline(t, ctx)))),
        h('p', { class: 'rpt-stamp' }, `${str(r.author || 'GIVA Research')} · ${str(r.company)} (${str(r.ticker)}) · published ${fmtDate(r.published)} · data as of ${fmtDate(r.data_asof)}`)));

    const pdf = h('button', { type: 'button', class: 'rpt-btn', 'data-rpt-print': '' }, 'Download PDF');
    const art = h('article', { class: 'rpt rpt-report', 'data-rpt-slug': slug },
      h('div', { class: 'rpt-toolbar' }, h('a', { href: '#/reports', class: 'rpt-back' }, '← All key reports'), pdf),
      cover, h('div', { class: 'rpt-layout' }, side, main));
    art.addEventListener('click', e => onClick(e, r));
    return { el: art, charts: ctx.charts };
  }

  // Citations / contents scroll in place (the hash is the router's); print opens the
  // browser's dialog, whose "Save as PDF" gives the PDF.
  function onClick(e, r) {
    const t = e.target && e.target.closest ? e.target.closest('[data-rpt-src],[data-rpt-sec],[data-rpt-print]') : null;
    if (!t) return;
    if (t.hasAttribute('data-rpt-print')) { printReport(r); return; }
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;   // new tab: the report's own route
    e.preventDefault();
    const src = t.getAttribute('data-rpt-src');
    const target = doc().getElementById(src ? `src-${src}` : `rpt-sec-${t.getAttribute('data-rpt-sec')}`);
    if (!target) return;
    try { target.scrollIntoView({ behavior: 'smooth', block: src ? 'center' : 'start' }); } catch { target.scrollIntoView(); }
    if (src) {
      target.classList.add('rpt-flash');
      try { target.focus({ preventScroll: true }); } catch { /* old browsers */ }
      setTimeout(() => target.classList.remove('rpt-flash'), 1600);
    }
  }
  function printReport(r) {
    if (typeof window === 'undefined' || typeof window.print !== 'function') return;
    const before = doc().title;
    doc().title = `${str(r.ticker)} — ${str(r.title)} (GIVA Research, ${str(r.published)})`;   // the PDF's file name
    try { window.print(); } finally { doc().title = before; }
  }

  // ---------------- fetch ----------------
  function getJSON(url) {
    if (typeof fetch !== 'function') return Promise.resolve({ status: 0, data: null });
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => { if (ctl) ctl.abort(); }, FETCH_TIMEOUT_MS);
    return Promise.resolve()
      .then(() => fetch(url, { cache: 'no-cache', signal: ctl ? ctl.signal : undefined }))
      .then(res => (res.ok ? res.json().then(data => ({ status: res.status, data }), () => ({ status: res.status, data: null }))
        : { status: res.status, data: null }))
      .catch(() => ({ status: 0, data: null }))
      .then(out => { clearTimeout(timer); return out; });
  }
  // The index, memoised for the drawer link; a failed load is retried next time.
  function loadIndex(force) {
    if (!S.indexP || force) {
      const p = S.indexP = getJSON('reports/index.json').then(res => {
        const list = res.data && Array.isArray(res.data.reports)
          ? res.data.reports.filter(e => e && typeof e === 'object' && SLUG_RE.test(str(e.slug))) : null;
        if (!list && S.indexP === p) S.indexP = null;
        return list;
      });
    }
    return S.indexP;
  }
  function findByTicker(ticker) {
    const t = str(ticker).trim().toUpperCase();
    if (!t) return Promise.resolve(null);
    return loadIndex(false).then(list => (list || []).find(e => str(e.ticker).toUpperCase() === t) || null).catch(() => null);
  }

  // ---------------- views ----------------
  const notice = (title, text, back) => h('div', { class: 'rpt rpt-empty' },
    title ? h('h2', null, title) : null, h('p', null, text),
    back ? h('a', { href: '#/reports', class: 'rpt-back' }, '← All key reports') : null);
  const notFound = () => notice('Report not found', 'There is no key report at this address — it may have been renamed or withdrawn.', true);

  function card(e) {
    const stance = e.stance && typeof e.stance === 'object' ? e.stance : {};
    return h('a', { class: 'rpt-card', href: `#/reports/${e.slug}` },
      h('div', { class: 'rpt-card-top' },
        h('span', { class: 'rpt-card-tk' }, str(e.ticker)),
        h('span', { class: 'rpt-card-co' }, str(e.company))),
      h('div', { class: 'rpt-card-meta' }, [e.report_type, e.sector, fmtDate(e.published)].filter(Boolean).map(str).join(' · ')),
      h('h3', { class: 'rpt-card-title' }, str(e.title)),
      e.summary ? h('p', { class: 'rpt-card-sum' }, plainText(e.summary)) : null,
      h('div', { class: 'rpt-card-foot' },
        stance.label ? pill(str(stance.label), STANCE_TONE[stance.label]) : null,
        stance.risk ? pill(`Risk: ${str(stance.risk)}`, RISK_TONE[stance.risk]) : null,
        h('span', { class: 'rpt-card-go' }, 'Read report →')));
  }
  function listView(list) {
    const head = h('header', { class: 'rpt-list-head' },
      h('h2', null, 'Key reports'),
      h('p', null, 'In-depth, fund-house-style research notes on individual companies: fundamentals from SEC EDGAR filings, '
        + 'every other figure cited to a public source. AI-assisted research — not investment advice.'));
    if (!list) return h('section', { class: 'rpt rpt-list' }, head, notice('', 'Key reports couldn’t load right now — try reloading the page.'));
    const sorted = list.slice().sort((a, b) => str(b.published).localeCompare(str(a.published)));
    return h('section', { class: 'rpt rpt-list' }, head, sorted.length
      ? h('div', { class: 'rpt-cards' }, sorted.map(card))
      : notice('', 'No key reports are published yet. New reports appear here as they are written.'));
  }

  function setReportMode(r) {
    const de = doc().documentElement;
    if (de && de.classList) { if (r) de.classList.add('rpt-on'); else de.classList.remove('rpt-on'); }
    if (r) {
      if (S.title == null) S.title = doc().title;
      doc().title = `${str(r.company)} (${str(r.ticker)}) — Key report · Global Index Valuation Agent`;
    } else if (S.title != null) { doc().title = S.title; S.title = null; }
  }
  function unmount() {
    S.seq++;
    for (const d of S.disposers.splice(0)) { try { d(); } catch { /* already gone */ } }
    setReportMode(null);
    S.shown = null;
  }
  // A different page of the section starts at the top (the router only scrolls on a view change).
  function shown(what) {
    if (S.shown !== what && typeof window !== 'undefined' && typeof window.scrollTo === 'function') { try { window.scrollTo(0, 0); } catch { /* jsdom */ } }
    S.shown = what;
  }

  function renderList(el) {
    if (!el) return Promise.resolve();
    unmount();
    const seq = S.seq;
    shown('list');
    clear(el);
    el.appendChild(notice('', 'Loading key reports…'));
    return loadIndex(true).then(list => {
      if (seq !== S.seq) return;
      clear(el);
      el.appendChild(listView(list));
    });
  }
  function renderReport(el, slug) {
    if (!el) return Promise.resolve();
    const s = str(slug);
    // The router re-runs for the page already on screen (Back from a stock drawer opened over
    // the report, a data refresh): keep the reader's place, the live chart and the fetched JSON.
    const cur = el.firstChild;
    if (S.shown === `report:${s}` && cur && cur.getAttribute && cur.getAttribute('data-rpt-slug') === s) return Promise.resolve();
    unmount();
    const seq = S.seq;
    shown(`report:${s}`);
    clear(el);
    if (!SLUG_RE.test(s)) { el.appendChild(notFound()); return Promise.resolve(); }
    el.appendChild(notice('', 'Loading report…'));
    return getJSON(`reports/${s}.json`).then(res => {
      if (seq !== S.seq) return;
      clear(el);
      const r = res.data;
      if (!r || typeof r !== 'object' || r.v !== 1 || r.slug !== s) {
        el.appendChild(res.status === 0 ? notice('Report unavailable', 'This report couldn’t load right now — try reloading the page.', true) : notFound());
        return;
      }
      let out;
      try { out = build(r); } catch { el.appendChild(notice('Report unavailable', 'This report couldn’t be displayed.', true)); return; }
      el.appendChild(out.el);
      setReportMode(r);
      for (const fn of out.charts) fn();
    });
  }

  return {
    renderList, renderReport, findByTicker, unmount,
    // Pure helpers, exposed for tests.
    _internal: { parseInline, plainText, safeUrl, fmtDate, fmtCell, barsScale, build, SLUG_RE },
  };
});
