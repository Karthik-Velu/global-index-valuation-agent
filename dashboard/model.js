// Stress test & projections — the interactive face of a report's {"type":"model"} block
// (MODEL SPEC v1, dashboard/reports/models/<slug>.json; maths in model-engine.js, docs in
// docs/REPORTS.md). Loaded on demand by reports.js, which hands it the parsed model, the
// parent report (whose sources the model's [sN] citations point at) and the route's state.
//
//   ReportModel.mount(el, {model, report, rich, state, onState, links, standalone}) -> dispose
//     rich      Reports.richText(report): {inline(text), cite(ids)} — **bold** + [sN] links
//     state     the route's ?m= (ModelEngine.decodeState validates + clamps it; never eval'd)
//     onState   called with ModelEngine.encodeState(...) after every change ('' = at base)
//     links     {self, full, report}: this view's route, the full-width route, the report
//   dispose() unmounts; dispose.setState(str) applies a new ?m in place; dispose.getState().
//
// Layout: scenario chips + Reset + Copy link, a headline KPI strip (each with its delta vs the
// base scenario), a "Key P&L drivers" callout written from the tornado, the driver panel
// (sliders + numeric inputs, grouped) and five tabs: P&L projection, Interest & debt (the
// predicted rate path, interest by tranche, maturity ladder), Sensitivity (tornado + 2-way
// grid), Valuation & multiples, Calibration. Inputs recompute on the next animation frame;
// the tornado and grid only for the tab on screen. Print swaps the controls for a static
// snapshot (KPIs + P&L + tornado) of the scenario on screen.
//
// Safety: as reports.js — createElement / textContent only (innerHTML is never assigned);
// spec text reaches the page as text nodes, citations through rich.cite. Charts are inline
// SVG built the same way. UMD: window.ReportModel; module.exports under Node (tests).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ReportModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  // The dashboard palette, ordered so neighbouring series stay apart under colour-vision
  // deficiency (checked with the dataviz validator); a sixth+ tranche folds into "Other".
  const SERIES = ['#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#2dd4bf'];
  const C_ACTUAL = '#64748b', C_OTHER = '#94a3b8', C_LOW = '#60a5fa', C_HIGH = '#fbbf24';
  const MINUS = '−';
  const TABS = [['pl', 'P&L projection'], ['debt', 'Interest & debt'], ['sens', 'Sensitivity'], ['val', 'Valuation & multiples'], ['cal', 'Calibration']];
  const PL_ROWS = ['revenue', 'revenue_growth', 'gross_profit', 'gross_margin', 'ebitda', 'ebitda_margin', 'da', 'ebit', 'interest',
    'pretax', 'net_income', 'eps', 'capex', 'ocf', 'fcf'];
  const STRONG_ROWS = new Set(['revenue', 'ebitda', 'net_income', 'fcf']);
  // +1: higher is better for the shareholder, -1: lower is better, 0: neither (colour only by sign).
  const GOOD = { revenue: 1, revenue_growth: 1, gross_profit: 1, gross_margin: 1, ebitda: 1, ebitda_margin: 1, da: -1, ebit: 1,
    interest: -1, pretax: 1, net_income: 1, eps: 1, capex: 0, ocf: 1, fcf: 1, value_per_share: 1, upside_pct: 1,
    net_debt_ebitda: -1, interest_cover: 1, funding: -1, ev_ebitda: -1, ev_sales: -1, pe: -1, fcf_yield: 1 };
  // Grid defaults per metric (x, y): the ask was SOFR x exit multiple for value, SOFR x spread for interest.
  const GRID_DEFAULTS = { value_per_share: ['sofr_shift', 'exit_ev_ebitda'], interest: ['sofr_shift', 'spread_shift'],
    net_income: ['sofr_shift', 'revenue_growth'], net_debt_ebitda: ['sofr_shift', 'capex'] };
  // Stub-year actuals behind a row (for a quarterly guide inside the stub year).
  const ACTUAL_KEY = { revenue: 'revenue', cost_of_revenue: 'cost_of_revenue', interest: 'interest', capex: 'capex', ocf: 'ocf', da: 'da', sbc: 'sbc' };

  const isNum = v => typeof v === 'number' && isFinite(v);
  const str = v => (v == null ? '' : String(v));
  const doc = () => document;
  let UID = 0;

  // ---------------- formatting (pure) ----------------
  // fmt(1234.5, 'US$m', 0) -> 'US$1,235m'; fmt(-0.4, '%', 1, true) -> '−0.4%'; null -> '—'.
  // A value that rounds to zero carries no sign (never '−0').
  function fmt(v, unit, dp, signed) {
    if (!isNum(v)) return '—';
    const d = Number.isInteger(dp) ? Math.max(0, Math.min(6, dp)) : 1;
    const n = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    const zero = Math.abs(v) < 0.5 * Math.pow(10, -d);
    const s = zero ? '' : v < 0 ? MINUS : signed ? '+' : '';
    switch (unit) {
      case 'US$m': return `${s}US$${n}m`;
      case 'US$bn': return `${s}US$${n}bn`;
      case 'US$': return `${s}US$${n}`;
      case '%': return `${s}${n}%`;
      case 'pp': return `${s}${n} pp`;
      case 'bp': return `${s}${n} bp`;
      case 'x': return `${s}${n}x`;
      case 'yrs': return `${s}${n} yrs`;
      case 'm': return `${s}${n}m`;
      default: return s + n;
    }
  }
  // Money in the headline tiles: US$m below a billion, US$bn above.
  function money(v, signed) {
    if (!isNum(v)) return '—';
    const a = Math.abs(v);
    return a >= 1000 ? fmt(v / 1000, 'US$bn', a >= 100000 ? 0 : a >= 10000 ? 1 : 2, signed) : fmt(v, 'US$m', 0, signed);
  }
  // Axis ticks: short, no trailing zeros ('US$250m', 'US$1bn', 'US$1.5bn').
  function tickMoney(v) {
    if (!isNum(v)) return '';
    const a = Math.abs(v), s = v < 0 ? MINUS : '';
    return a >= 1000 ? `${s}US$${+(a / 1000).toFixed(2)}bn` : `${s}US$${+a.toFixed(1)}m`;
  }
  // A change in a row's unit: a % row moves in percentage points.
  const deltaUnit = u => (u === '%' ? 'pp' : u);
  // Tone of a change: 'pos' (good for the shareholder), 'neg', or 'flat'.
  function tone(delta, good, eps) {
    if (!isNum(delta) || Math.abs(delta) <= (eps || 1e-9) || !good) return 'flat';
    return delta * good > 0 ? 'pos' : 'neg';
  }
  const arrow = t => (t === 'pos' ? '▲' : t === 'neg' ? '▼' : '•');

  function niceStep(range, target) {
    const raw = range / Math.max(1, target);
    if (!(raw > 0)) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  }
  // Axis covering [lo, hi] (and zero when `zero`), in nice ticks.
  function scale(values, zero, target) {
    const nums = values.filter(isNum);
    let lo = nums.length ? Math.min(...nums) : 0, hi = nums.length ? Math.max(...nums) : 1;
    if (zero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
    if (lo === hi) { hi = lo + 1; if (!zero) lo -= 1; }
    const step = niceStep(hi - lo, target || 4);
    lo = Math.floor(lo / step + 1e-9) * step || 0;
    hi = Math.ceil(hi / step - 1e-9) * step || 0;
    const ticks = [];
    for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toPrecision(12) || 0);
    return { lo, hi, step, ticks };
  }
  // Grid axis: n points from lo to hi on the driver's step, plus the current value; sorted, unique.
  function axisValues(d, cur, n) {
    const lo = isNum(d.low) ? d.low : d.min, hi = isNum(d.high) ? d.high : d.max;
    const k = Math.max(2, n || 7), out = [];
    const snap = v => +(Math.round(v / d.step) * d.step).toPrecision(10);
    for (let i = 0; i < k; i++) out.push(snap(lo + (hi - lo) * i / (k - 1)));
    if (isNum(cur)) out.push(+cur.toPrecision(10));
    return [...new Set(out.map(v => Math.min(d.max, Math.max(d.min, v))))].sort((a, b) => a - b);
  }
  // A driver's name inside a sentence: "SOFR shift" -> "SOFR", "Capex" -> "capex".
  function driverNoun(label) {
    const s = str(label).replace(/\s+shift$/i, '');
    return /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
  }
  // "A 200 bp rise in SOFR", "20% more capex", "Depreciation life at 4.0 yrs (now 6.0 yrs)".
  function moveText(d, from, to) {
    const diff = to - from, noun = driverNoun(d.label);
    if (d.kind === 'shift_bp' || d.kind === 'shift_pp') return `A ${fmt(Math.abs(diff), d.unit, d.dp)} ${diff > 0 ? 'rise' : 'fall'} in ${noun}`;
    if (d.kind === 'scale_pct') return `${fmt(Math.abs(diff), '%', 0)} ${diff > 0 ? 'more' : 'less'} ${noun}`;
    return `${str(d.label)} at ${fmt(to, d.unit, d.dp)} (now ${fmt(from, d.unit, d.dp)})`;
  }
  // Top-5 plain-English lines from a tornado (the side that moves the metric most).
  function keyDriverLines(sens, drivers, what, unit) {
    if (!sens || sens.error || !isNum(sens.base)) return [];
    const byId = new Map(drivers.map(d => [d.id, d]));
    return sens.bars.filter(b => isNum(b.swing) && b.swing > 1e-9).slice(0, 5).map(b => {
      const d = byId.get(b.id);
      const dl = isNum(b.v_low) ? b.v_low - sens.base : 0, dh = isNum(b.v_high) ? b.v_high - sens.base : 0;
      const useHigh = Math.abs(dh) >= Math.abs(dl);
      const to = useHigh ? b.high : b.low, v = useHigh ? b.v_high : b.v_low, delta = v - sens.base;
      if (!d || Math.abs(to - b.current) < 1e-12) return null;
      const amt = unit === 'US$m' ? money(Math.abs(delta)) : fmt(Math.abs(delta), unit, unit === 'x' ? 1 : 2);
      const to2 = unit === 'US$m' ? money(v) : fmt(v, unit, unit === 'x' ? 1 : 2);
      return { id: b.id, delta, text: `${moveText(d, b.current, to)} ${delta < 0 ? 'cuts' : 'lifts'} ${what} by ${amt} (to ${to2}).` };
    }).filter(Boolean);
  }
  // A quarterly / annual guide vs the model: 'YYYY-Qn' inside the stub year = the projected
  // remainder spread evenly over its quarters; a later year = FY / 4; 'YYYY' = FY.
  function guideValue(res, spec, g) {
    if (!res || res.error || !g || typeof g.metric !== 'string' || !Array.isArray(res.rows[g.metric])) return null;
    const m = /^(\d{4})(?:-Q([1-4]))?$/.exec(str(g.period));
    if (!m) return null;
    const y = +m[1], i = res.years.indexOf(y);
    if (i < 0) return null;
    const fy = res.rows[g.metric][i];
    if (!isNum(fy)) return null;
    if (!m[2]) return fy;
    const stub = spec && spec.stub;
    if (stub && stub.year === y && Number.isInteger(stub.actual_months)) {
      const q = +m[2], doneQ = stub.actual_months / 3, leftQ = 4 - doneQ;
      const key = ACTUAL_KEY[g.metric], act = stub.actuals && key ? stub.actuals[key] : null;
      if (q <= doneQ || !(leftQ > 0) || !isNum(act)) return null;
      return (fy - act) / leftQ;
    }
    return fy / 4;
  }

  // ---------------- DOM builders (createElement / textContent only) ----------------
  function put(el, attrs, kids) {
    if (attrs) for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v != null && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const k of kids.flat(3)) {
      if (k == null || k === false) continue;
      el.appendChild(typeof k === 'object' ? k : doc().createTextNode(String(k)));
    }
    return el;
  }
  const h = (tag, attrs, ...kids) => put(doc().createElement(tag), attrs, kids);
  const sv = (tag, attrs, ...kids) => put(doc().createElementNS(SVG_NS, tag), attrs, kids);
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  const f1 = v => (+v).toFixed(1);
  // Without Reports.richText: citations stay readable text.
  const plainRich = { inline: t => [doc().createTextNode(str(t))], cite: ids => doc().createTextNode(` [${[].concat(ids).join(',')}]`) };

  // ---------------- charts (inline SVG) ----------------
  // Lines over years: zero-based y axis, 2px lines, end-of-line labels nudged apart.
  function lineChart({ id, title, desc, labels, series, unit, dp }) {
    const W = Math.max(520, 140 + labels.length * 90), H = 240, padL = 46, padR = 132, padT = 14, padB = 28;
    const sc = scale(series.flatMap(s => s.values), true, 4);
    const pw = W - padL - padR, ph = H - padT - padB;
    const x = i => padL + (labels.length === 1 ? pw / 2 : i * pw / (labels.length - 1));
    const y = v => padT + (sc.hi - v) / (sc.hi - sc.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    for (const t of sc.ticks) {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, fmt(t, unit, sc.step < 1 ? 1 : 0)));
    }
    labels.forEach((l, i) => svg.appendChild(sv('text', { x: f1(x(i)), y: H - 9, 'text-anchor': 'middle', class: 'mdl-xl' }, l)));
    const ends = [];
    for (const s of series) {
      const pts = s.values.map((v, i) => (isNum(v) ? [x(i), y(v), v, i] : null)).filter(Boolean);
      if (!pts.length) continue;
      svg.appendChild(sv('polyline', { points: pts.map(p => `${f1(p[0])},${f1(p[1])}`).join(' '), fill: 'none', stroke: s.color,
        'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dash ? '5 4' : null, opacity: s.faint ? 0.75 : null }));
      for (const p of pts) {
        svg.appendChild(sv('circle', { cx: f1(p[0]), cy: f1(p[1]), r: s.dash ? 3 : 4, fill: s.dash ? 'var(--rpt-panel)' : s.color, stroke: s.dash ? s.color : 'var(--rpt-panel)', 'stroke-width': 2 },
          sv('title', null, `${labels[p[3]]} · ${s.name}: ${fmt(p[2], unit, dp)}`)));
      }
      const last = pts[pts.length - 1];
      ends.push({ y: last[1], x: last[0], text: `${s.short || s.name} ${fmt(last[2], unit, dp)}` });
    }
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 12) ends[i].y = ends[i - 1].y + 12;
    for (const e of ends) svg.appendChild(sv('text', { x: f1(e.x + 8), y: f1(e.y + 3.5), class: 'mdl-end' }, e.text));
    return svg;
  }

  // Stacked columns (non-negative parts), 2px surface gap between segments; `marks` are
  // reference ranges drawn as a bracket beside a column ({i, lo, hi, label}).
  function stackedBars({ id, title, desc, labels, series, unit, marks }) {
    const W = Math.max(480, 130 + labels.length * 84), H = 250, padL = 66, padR = 16, padT = 22, padB = 28;
    const totals = labels.map((_, j) => series.reduce((s, x) => s + (isNum(x.values[j]) ? Math.max(0, x.values[j]) : 0), 0));
    const sc = scale(totals.concat((marks || []).flatMap(m => [m.lo, m.hi])), true, 4);
    const pw = W - padL - padR, ph = H - padT - padB, gw = pw / Math.max(1, labels.length), bw = Math.min(24, gw * 0.5);
    const y = v => padT + (sc.hi - v) / (sc.hi - sc.lo) * ph;
    const svg = sv('svg', { class: 'mdl-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc));
    for (const t of sc.ticks) {
      svg.appendChild(sv('line', { x1: padL, x2: W - padR, y1: f1(y(t)), y2: f1(y(t)), class: t === 0 ? 'mdl-zero' : 'mdl-grid' }));
      svg.appendChild(sv('text', { x: padL - 6, y: f1(y(t) + 3.5), 'text-anchor': 'end', class: 'mdl-tick' }, tickMoney(t)));
    }
    labels.forEach((l, j) => {
      const cx = padL + gw * (j + 0.5), x0 = cx - bw / 2;
      let acc = 0;
      for (const s of series) {
        const v = isNum(s.values[j]) ? Math.max(0, s.values[j]) : 0;
        if (v <= 0) continue;
        const top = y(acc + v), bot = y(acc), hgt = Math.max(0.6, bot - top - (acc > 0 ? 2 : 0));
        svg.appendChild(sv('rect', { x: f1(x0), y: f1(top), width: f1(bw), height: f1(hgt), fill: s.color },
          sv('title', null, `${l} · ${s.name}: ${fmt(v, unit, 0)}`)));
        acc += v;
      }
      if (acc > 0) svg.appendChild(sv('text', { x: f1(cx), y: f1(y(acc) - 5), 'text-anchor': 'middle', class: 'mdl-val' }, money(acc)));
      svg.appendChild(sv('text', { x: f1(cx), y: H - 9, 'text-anchor': 'middle', class: 'mdl-xl' }, l));
    });
    for (const m of marks || []) {
      if (!isNum(m.lo) || !isNum(m.hi)) continue;
      const bx = padL + gw * (m.i + 0.5) + bw / 2 + 6, y1 = y(Math.max(m.lo, m.hi)), y2 = y(Math.min(m.lo, m.hi));
      svg.appendChild(sv('path', { d: `M${f1(bx + 5)} ${f1(y1)}H${f1(bx)}V${f1(Math.max(y2, y1 + 2))}H${f1(bx + 5)}`, class: 'mdl-mark' },
        sv('title', null, `${m.label}: ${fmt(m.lo, unit, 0)}–${fmt(m.hi, unit, 0)}`)));
      svg.appendChild(sv('text', { x: f1(bx + 8), y: f1((y1 + y2) / 2 + 3.5), class: 'mdl-markt' }, 'Guide'));
    }
    return svg;
  }

  // Tornado: one row per driver, bars from the current value to the metric at the driver's
  // low (blue) and high (amber) end; sorted by swing (the engine's order).
  function tornado({ id, sens, drivers, unit, dp, title }) {
    // drivers that leave the metric unchanged are listed under the chart instead
    const bars = sens.bars.filter(b => isNum(b.v_low) && isNum(b.v_high) && b.swing > 1e-9).slice(0, 12);
    const W = 660, rowH = 30, padL = 178, padT = 22, padB = 10, H = padT + padB + Math.max(1, bars.length) * rowH;
    const plotL = padL + 62, plotR = W - 66;                    // room for the end-value labels
    const byId = new Map(drivers.map(d => [d.id, d]));
    const vals = bars.flatMap(b => [b.v_low, b.v_high]).concat([sens.base]);
    const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || Math.abs(sens.base) || 1;
    const x = v => plotL + (v - (lo - span * 0.02)) / (span * 1.04) * (plotR - plotL);
    const desc = bars.map(b => `${b.label}: ${fmt(b.v_low, unit, dp)} at ${fmt(b.low, b.unit)} to ${fmt(b.v_high, unit, dp)} at ${fmt(b.high, b.unit)}`).join('; ');
    const svg = sv('svg', { class: 'mdl-svg mdl-tornado', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-labelledby': `${id}-t ${id}-d` },
      sv('title', { id: `${id}-t` }, title), sv('desc', { id: `${id}-d` }, desc || 'No driver moves this metric.'));
    const bx = x(sens.base);
    svg.appendChild(sv('text', { x: f1(bx), y: 12, 'text-anchor': 'middle', class: 'mdl-tick' }, `Now ${fmt(sens.base, unit, dp)}`));
    bars.forEach((b, i) => {
      const d = byId.get(b.id) || b, cy = padT + i * rowH + rowH / 2;
      const name = str(b.label).length > 26 ? str(b.label).slice(0, 25) + '…' : str(b.label);
      svg.appendChild(sv('text', { x: padL - 8, y: f1(cy - 2), 'text-anchor': 'end', class: 'mdl-tl' }, name));
      svg.appendChild(sv('text', { x: padL - 8, y: f1(cy + 10), 'text-anchor': 'end', class: 'mdl-tick' },
        `${fmt(b.low, b.unit, d.dp)} → ${fmt(b.high, b.unit, d.dp)}`));
      for (const [v, c, side, at] of [[b.v_low, C_LOW, 'low', b.low], [b.v_high, C_HIGH, 'high', b.high]]) {
        const x1 = Math.min(bx, x(v)), w = Math.abs(x(v) - bx);
        svg.appendChild(sv('rect', { x: f1(x1), y: f1(cy - 7), width: f1(Math.max(0.8, w)), height: 14, rx: 3, fill: c },
          sv('title', null, `${b.label} at its ${side} end (${fmt(at, b.unit, d.dp)}): ${fmt(v, unit, dp)}`)));
      }
      const left = Math.min(b.v_low, b.v_high), right = Math.max(b.v_low, b.v_high);
      if (Math.abs(right - left) > 1e-9) {
        svg.appendChild(sv('text', { x: f1(Math.min(x(left), bx) - 4), y: f1(cy + 3.5), 'text-anchor': 'end', class: 'mdl-val' }, fmt(left, unit, dp)));
        svg.appendChild(sv('text', { x: f1(Math.max(x(right), bx) + 4), y: f1(cy + 3.5), class: 'mdl-val' }, fmt(right, unit, dp)));
      }
    });
    svg.appendChild(sv('line', { x1: f1(bx), x2: f1(bx), y1: padT - 4, y2: H - padB + 4, class: 'mdl-zero' }));
    return svg;
  }

  const legend = items => h('div', { class: 'mdl-legend' }, items.map(([name, color, dash]) =>
    h('span', null, h('i', { class: dash ? 'dash' : null, style: dash ? `border-color:${color}` : `background:${color}` }), name)));
  // Legend above, the chart scrolling sideways in its own box on a narrow screen.
  const chartBox = (svg, ...extra) => {
    const t = svg.firstChild && svg.firstChild.textContent;
    return h('div', { class: 'mdl-chart' }, extra, h('div', { class: 'mdl-scroll', role: 'region', tabindex: '0', 'aria-label': t || 'Chart' }, svg));
  };

  // ---------------- the module ----------------
  function mount(el, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const E = o.engine || (typeof ModelEngine !== 'undefined' ? ModelEngine : null);
    const spec = o.model;
    const rich = o.rich && typeof o.rich.inline === 'function' ? o.rich : plainRich;
    const links = o.links && typeof o.links === 'object' ? o.links : {};
    const noop = () => {};
    noop.setState = noop; noop.getState = () => '';
    clear(el);
    const fail = msg => { el.appendChild(h('div', { class: 'rpt-chart-na' }, msg)); return noop; };
    if (!E || !spec || typeof spec !== 'object') return fail('The stress-test model couldn’t load right now.');
    const v = E.validateSpec(spec);
    if (!v.ok) return fail('This model couldn’t be run: ' + v.errors.slice(0, 3).join('; '));

    const uid = `mdl${++UID}`;
    const D = E.drivers(spec), byId = new Map(D.map(d => [d.id, d]));
    const tpl = E.template(spec.template) || {};
    const RM = tpl.rows || {};
    const years = spec.years.slice();
    const stubbed = !!(spec.stub && spec.stub.year === years[0]);
    const KY = years[stubbed && years.length > 1 ? 1 : 0];              // first full projected year
    const XY = (spec.valuation && years.includes(spec.valuation.exit_year)) ? spec.valuation.exit_year : years[Math.min(2, years.length - 1)];
    const yl = y => `FY${String(y).slice(-2)}E`;
    const ylong = y => `FY${y}E`;
    const scen = Array.isArray(spec.scenarios) ? spec.scenarios.filter(s => s && typeof s.id === 'string') : [];
    const baseOv = E.applyScenario(spec, 'base') || {};
    const BASE = E.project(spec, baseOv);
    const tranches = (Array.isArray(spec.debt) ? spec.debt : []).filter(t => t && typeof t.id === 'string');
    const guides = (Array.isArray(spec.guides) ? spec.guides : []).filter(g => g && typeof g === 'object').slice(0, 20);
    const sensMetrics = [
      { key: 'value_per_share', label: 'Value per share', metric: 'value_per_share', unit: 'US$', dp: 2, good: 1, what: 'value per share' },
      { key: 'net_income', label: `${ylong(KY)} net income`, metric: 'net_income', year: KY, unit: 'US$m', dp: 0, good: 1, what: `${ylong(KY)} net income` },
      { key: 'interest', label: `${ylong(KY)} interest expense`, metric: 'interest', year: KY, unit: 'US$m', dp: 0, good: -1, what: `${ylong(KY)} interest expense` },
      { key: 'net_debt_ebitda', label: `${ylong(XY)} net debt / EBITDA`, metric: 'net_debt_ebitda', year: XY, unit: 'x', dp: 1, good: -1, what: `${ylong(XY)} net debt / EBITDA` },
    ];
    const st = { ov: {}, res: null, raf: 0, tab: 'pl', stale: new Set(TABS.map(t => t[0])), sens: 'value_per_share',
      grid: { metric: 'value_per_share', x: 'sofr_shift', y: 'exit_ev_ebitda' }, enc: '', snapT: 0, alive: true, refs: new Map() };

    // ---- state ----
    function decode(s) {
      const r = E.decodeState(spec, s || '');
      st.ov = r.ok ? r.overrides : {};
      if (s && (!r.ok || r.errors.length)) status(r.ok ? 'Some settings in this link were out of range or unknown and were adjusted.' : 'That model link could not be read; showing the base case.');
    }
    function setOv(next) { st.ov = E.cleanOverrides(spec, next); schedule(); }
    function setDriver(id, value) { const n = Object.assign({}, st.ov); n[id] = value; setOv(n); }
    const cur = id => (Object.prototype.hasOwnProperty.call(st.ov, id) ? st.ov[id] : byId.get(id).base);
    function schedule() {
      if (st.raf) return;
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16);
      st.raf = raf(() => { st.raf = 0; if (st.alive) update(); });
    }

    // ---- skeleton ----
    const statusEl = h('p', { class: 'mdl-status', role: 'status', 'aria-live': 'polite' });
    let statusT = 0;
    function status(msg) {
      statusEl.textContent = msg;
      clearTimeout(statusT);
      if (msg) statusT = setTimeout(() => { statusEl.textContent = ''; }, 6000);
    }
    const chips = h('div', { class: 'mdl-chips', role: 'group', 'aria-label': 'Scenarios' });
    const scenNote = h('p', { class: 'mdl-scen-note' });
    const chipEls = new Map();
    for (const s of scen) {
      const b = h('button', { type: 'button', class: `mdl-chip ${/^(bear|bull|base|restructuring)$/.test(s.id) ? s.id : ''}`, 'aria-pressed': 'false', 'data-mdl-scen': s.id }, str(s.name || s.id));
      b.addEventListener('click', () => { setOv(E.applyScenario(spec, s.id) || {}); status(`${str(s.name)} scenario applied.`); });
      chipEls.set(s.id, b); chips.appendChild(b);
    }
    const customChip = h('span', { class: 'mdl-chip custom', hidden: true }, 'Custom');
    chips.appendChild(customChip);
    const resetBtn = h('button', { type: 'button', class: 'rpt-btn mdl-ctl', 'data-mdl-reset': '' }, 'Reset');
    resetBtn.addEventListener('click', () => { setOv(baseOv); status('Back to the base case.'); });
    const copyBtn = h('button', { type: 'button', class: 'rpt-btn mdl-ctl', 'data-mdl-copy': '' }, 'Copy link');
    const copyBox = h('input', { class: 'mdl-copybox', type: 'text', readonly: true, 'aria-label': 'Link to this scenario', hidden: true });
    copyBtn.addEventListener('click', copyLink);
    const fullLink = links.full && !o.standalone ? h('a', { class: 'mdl-full', href: links.full }, 'Open full-width ↗') : null;

    const kpis = h('div', { class: 'mdl-kpis', role: 'list', 'aria-label': 'Headline outputs' });
    const keyd = h('aside', { class: 'rpt-callout info mdl-keyd', role: 'note' });
    const drvPanel = h('div', { class: 'mdl-drivers', role: 'group', 'aria-label': 'Model drivers' });
    const tablist = h('div', { class: 'mdl-tabs', role: 'tablist', 'aria-label': 'Model views' });
    const panels = new Map(), tabBtns = new Map();
    for (const [k, label] of TABS) {
      const b = h('button', { type: 'button', role: 'tab', id: `${uid}-tab-${k}`, 'aria-controls': `${uid}-p-${k}`, 'aria-selected': k === st.tab ? 'true' : 'false',
        tabindex: k === st.tab ? '0' : '-1', class: 'mdl-tab', 'data-mdl-tab': k }, label);
      b.addEventListener('click', () => selectTab(k));
      b.addEventListener('keydown', e => {
        const i = TABS.findIndex(t => t[0] === k);
        let j = null;
        if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') j = 0; else if (e.key === 'End') j = TABS.length - 1;
        if (j === null) return;
        e.preventDefault(); selectTab(TABS[j][0]); tabBtns.get(TABS[j][0]).focus();
      });
      tabBtns.set(k, b); tablist.appendChild(b);
      panels.set(k, h('div', { role: 'tabpanel', id: `${uid}-p-${k}`, 'aria-labelledby': `${uid}-tab-${k}`, class: 'mdl-panel', hidden: k !== st.tab, 'data-mdl-panel': k }));
    }
    function selectTab(k) {
      st.tab = k;
      for (const [t, b] of tabBtns) { b.setAttribute('aria-selected', t === k ? 'true' : 'false'); b.setAttribute('tabindex', t === k ? '0' : '-1'); }
      for (const [t, p] of panels) p.hidden = t !== k;
      if (st.stale.has(k)) renderPanel(k);
    }

    const printBox = h('div', { class: 'mdl-print', 'aria-hidden': 'true' });
    const asof = str(spec.asof);
    const root = h('section', { class: 'mdl', 'aria-label': 'Stress test and projections', 'data-mdl-slug': str(spec.slug) },
      h('div', { class: 'mdl-live' },
        h('header', { class: 'mdl-head' },
          h('div', null,
            h('h3', { class: 'mdl-title' }, 'Stress test & projections'),
            h('p', { class: 'mdl-sub' }, `Interactive ${years[0]}–${years[years.length - 1]} model · ${str(spec.currency || 'USD')} millions unless stated · drivers as of ${asof}`)),
          fullLink),
        h('div', { class: 'mdl-bar mdl-ctl' }, chips, h('div', { class: 'mdl-actions' }, resetBtn, copyBtn)),
        copyBox, scenNote, statusEl, kpis, keyd,
        h('div', { class: 'mdl-body' },
          h('aside', { class: 'mdl-side mdl-ctl' }, h('h4', { class: 'mdl-h4' }, 'Drivers'),
            h('p', { class: 'mdl-hint' }, 'Move a slider or type a value; the tick marks the base case, the shaded band the stress range used by the tornado.'),
            drvPanel),
          h('div', { class: 'mdl-main' }, tablist, [...panels.values()])),
        h('p', { class: 'mdl-disc' }, 'Illustrative model, not investment advice. It is a simplified projection of the company’s accounts: '
          + 'outputs are only as good as the drivers, which are our estimates and the cited public sources.')),
      printBox);
    el.appendChild(root);

    // ---- drivers ----
    const narrow = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(max-width: 700px)').matches;
    const groups = (tpl.groups || []).filter(g => D.some(d => d.group === g));
    const pct = (d, x) => ((x - d.min) / ((d.max - d.min) || 1) * 100).toFixed(2) + '%';
    groups.forEach((g, gi) => {
      const box = h('details', { class: 'mdl-group', open: !narrow || gi < 2 ? true : null },
        h('summary', null, h('span', null, g), h('span', { class: 'mdl-gcount', 'data-mdl-gcount': g })));
      for (const d of D.filter(x => x.group === g)) box.appendChild(driverRow(d));
      drvPanel.appendChild(box);
    });
    function driverRow(d) {
      const rid = `${uid}-d-${d.id}`;
      const range = h('input', { type: 'range', id: rid, min: d.min, max: d.max, step: d.step, value: d.base, class: 'mdl-range', 'data-mdl-driver': d.id,
        'aria-label': `${d.label} (${d.unit})` });
      const numIn = h('input', { type: 'number', min: d.min, max: d.max, step: d.step, value: d.base, class: 'mdl-num', inputmode: 'decimal',
        'aria-label': `${d.label}, value in ${d.unit}`, 'data-mdl-num': d.id });
      const delta = h('span', { class: 'mdl-dd' });
      const effect = h('span', { class: 'mdl-eff' });
      const reset = h('button', { type: 'button', class: 'mdl-rs', 'aria-label': `Reset ${d.label} to base`, title: 'Back to base', hidden: true }, '↺');
      const helpId = `${rid}-help`;
      const helpBtn = h('button', { type: 'button', class: 'mdl-help', 'aria-expanded': 'false', 'aria-controls': helpId, 'aria-label': `About ${d.label}` }, '?');
      const helpBox = h('div', { class: 'mdl-helpbox', id: helpId, hidden: true },
        h('p', null, rich.inline(d.help), d.src && d.src.length ? rich.cite(d.src) : null),
        h('p', { class: 'mdl-dim' }, `Range ${fmt(d.min, d.unit, d.dp)} to ${fmt(d.max, d.unit, d.dp)} · base ${fmt(d.base, d.unit, d.dp)}`
          + (isNum(d.low) && isNum(d.high) ? ` · stress range ${fmt(d.low, d.unit, d.dp)} to ${fmt(d.high, d.unit, d.dp)}` : '')),
        pathLine(d));
      helpBtn.addEventListener('click', () => {
        const open = helpBox.hidden;
        helpBox.hidden = !open; helpBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      const track = h('div', { class: 'mdl-track' },
        isNum(d.low) && isNum(d.high) ? h('span', { class: 'mdl-band', 'aria-hidden': 'true' }) : null,
        h('span', { class: 'mdl-base', 'aria-hidden': 'true', title: `Base ${fmt(d.base, d.unit, d.dp)}` }),
        range);
      track.style.setProperty('--b', pct(d, d.base));
      if (isNum(d.low) && isNum(d.high)) { track.style.setProperty('--l', pct(d, Math.min(d.low, d.high))); track.style.setProperty('--h', pct(d, Math.max(d.low, d.high))); }
      range.addEventListener('input', () => setDriver(d.id, +range.value));
      const fromNum = () => {
        const t = String(numIn.value).trim();
        if (t === '' || !isFinite(+t)) return;
        setDriver(d.id, +t);
      };
      numIn.addEventListener('input', fromNum);
      numIn.addEventListener('change', () => { fromNum(); numIn.value = String(cur(d.id)); });
      reset.addEventListener('click', () => { const n = Object.assign({}, st.ov); delete n[d.id]; setOv(n); range.focus(); });
      st.refs.set(d.id, { range, numIn, delta, effect, reset });
      return h('div', { class: 'mdl-drv', 'data-mdl-row': d.id },
        h('div', { class: 'mdl-drv-top' },
          h('label', { for: rid, class: 'mdl-lab' }, d.label), helpBtn,
          h('span', { class: 'mdl-in' }, numIn, h('span', { class: 'mdl-unit' }, d.unit)), reset),
        track, h('div', { class: 'mdl-drv-foot' }, delta, effect), helpBox);
    }
    function pathLine(d) {
      let p = null, unit = d.unit;
      if (d.id === 'sofr_shift' && spec.rates && spec.rates.path) { p = years.map(y => spec.rates.path[String(y)]); unit = '%'; }
      else if (Array.isArray(d.path)) { p = d.path; unit = d.kind === 'scale_pct' ? 'US$m' : '%'; }
      if (!p) return null;
      return h('p', { class: 'mdl-dim' }, `Base path: ${years.map((y, i) => `${yl(y)} ${unit === 'US$m' ? money(p[i]) : fmt(p[i], unit, unit === '%' ? 2 : 1)}`).join(' · ')}`,
        d.id === 'sofr_shift' && spec.rates && Array.isArray(spec.rates.src) ? rich.cite(spec.rates.src) : null);
    }
    // "FY27E 40.0% → 45.0%" under a path driver; the all-in rate under new_debt_rate.
    function effectText(d) {
      const i = years.indexOf(KY), x = cur(d.id);
      if (d.id === 'sofr_shift' && st.res && !st.res.error) {
        const b = spec.rates && spec.rates.path ? spec.rates.path[String(KY)] : null;
        return isNum(b) ? `SOFR ${yl(KY)} ${fmt(b, '%', 2)} → ${fmt(st.res.rows.sofr[i], '%', 2)}` : '';
      }
      if (Array.isArray(d.path) && isNum(d.path[i])) {
        if (d.kind === 'scale_pct') return `${yl(KY)} ${money(d.path[i])} → ${money(d.path[i] * (1 + x / 100))}`;
        return `${yl(KY)} ${fmt(d.path[i], '%', 1)} → ${fmt(d.path[i] + x, '%', 1)}`;
      }
      if (d.id === 'new_debt_rate') {
        const beta = spec.rates && isNum(spec.rates.new_debt_sofr_beta) ? spec.rates.new_debt_sofr_beta : 1;
        return `all-in ${fmt(x + cur('spread_shift') / 100 + beta * cur('sofr_shift') / 100, '%', 2)} with the shifts`;
      }
      return '';
    }
    function syncDrivers() {
      const counts = new Map();
      for (const d of D) {
        const r = st.refs.get(d.id), x = cur(d.id), changed = Math.abs(x - d.base) > 1e-12;
        if (String(r.range.value) !== String(x)) r.range.value = String(x);
        r.range.setAttribute('aria-valuetext', fmt(x, d.unit, d.dp));
        if (doc().activeElement !== r.numIn && String(r.numIn.value) !== String(x)) r.numIn.value = String(x);
        r.delta.textContent = changed ? `${fmt(x - d.base, d.unit, d.dp, true)} vs base` : 'at base';
        r.delta.className = `mdl-dd${changed ? ' on' : ''}`;
        r.effect.textContent = effectText(d);
        r.reset.hidden = !changed;
        if (changed) counts.set(d.group, (counts.get(d.group) || 0) + 1);
      }
      for (const c of drvPanel.querySelectorAll ? drvPanel.querySelectorAll('[data-mdl-gcount]') : []) {
        const n = counts.get(c.getAttribute('data-mdl-gcount')) || 0;
        c.textContent = n ? `${n} changed` : '';
      }
    }

    // ---- headline KPIs ----
    const at = (res, row, y) => (res && !res.error && Array.isArray(res.rows[row]) ? res.rows[row][res.years.indexOf(y)] : null);
    function fundingTo(res, y) {
      if (!res || res.error) return { raised: null, minCash: null, minYear: null };
      let raised = 0, minCash = Infinity, minYear = null;
      res.years.forEach((yy, i) => {
        if (yy > y) return;
        raised += (res.rows.new_debt[i] || 0) + (res.rows.new_equity_m[i] || 0);
        if (isNum(res.rows.cash_end[i]) && res.rows.cash_end[i] < minCash) { minCash = res.rows.cash_end[i]; minYear = yy; }
      });
      return { raised, minCash: isNum(minCash) ? minCash : null, minYear };
    }
    function kpiList(res) {
      const V = res.valuation, B = BASE.error ? null : BASE.valuation;
      const fu = fundingTo(res, XY), fb = fundingTo(BASE, XY);
      return [
        { key: 'value_per_share', label: 'Value per share', value: fmt(V.value_per_share, 'US$', 2), raw: V.value_per_share, base: B && B.value_per_share, unit: 'US$', dp: 2,
          sub: `vs ${fmt(V.share_price, 'US$', 2)} price · ${fmt(V.upside_pct, '%', 0, true)} ${isNum(V.upside_pct) && V.upside_pct < 0 ? 'downside' : 'upside'}`, good: 1 },
        { key: 'net_income', label: `${ylong(KY)} net income`, value: money(at(res, 'net_income', KY)), raw: at(res, 'net_income', KY), base: at(BASE, 'net_income', KY), unit: 'US$m', good: 1,
          sub: `EPS ${fmt(at(res, 'eps', KY), 'US$', 2)}` },
        { key: 'interest', label: `${ylong(KY)} interest expense`, value: money(at(res, 'interest', KY)), raw: at(res, 'interest', KY), base: at(BASE, 'interest', KY), unit: 'US$m', good: -1,
          sub: `avg cost of debt ${fmt(at(res, 'avg_cost_of_debt', KY), '%', 1)}` },
        { key: 'net_debt_ebitda', label: `${ylong(KY)} net debt / EBITDA`, value: fmt(at(res, 'net_debt_ebitda', KY), 'x', 1), raw: at(res, 'net_debt_ebitda', KY), base: at(BASE, 'net_debt_ebitda', KY), unit: 'x', dp: 1, good: -1,
          sub: `net debt ${money(at(res, 'net_debt', KY))}` },
        { key: 'interest_cover', label: `${ylong(KY)} interest cover`, value: fmt(at(res, 'interest_cover', KY), 'x', 1), raw: at(res, 'interest_cover', KY), base: at(BASE, 'interest_cover', KY), unit: 'x', dp: 1, good: 1,
          sub: 'adj. EBITDA ÷ interest' },
        { key: 'funding', label: `Funding raised to ${XY}`, value: money(fu.raised), raw: fu.raised, base: fb.raised, unit: 'US$m', good: -1,
          sub: `lowest cash ${money(fu.minCash)}${fu.minYear ? ` (${yl(fu.minYear)})` : ''}` },
        { key: 'ev_ebitda', label: `${ylong(KY)} EV/EBITDA at price`, value: fmt(at(res, 'ev_ebitda', KY), 'x', 1), raw: at(res, 'ev_ebitda', KY), base: at(BASE, 'ev_ebitda', KY), unit: 'x', dp: 1, good: -1,
          sub: `at ${fmt(V.share_price, 'US$', 2)} · P/E ${fmt(at(res, 'pe', KY), 'x', 1)}` },
      ];
    }
    function kpiTile(k) {
      const d = isNum(k.raw) && isNum(k.base) ? k.raw - k.base : null;
      const t = tone(d, k.good, k.unit === 'US$m' ? 0.5 : k.unit === 'US$' ? 0.005 : 0.05);
      const dTxt = d === null ? 'vs base n/a' : t === 'flat' ? 'at base' : `${k.unit === 'US$m' ? money(d, true) : fmt(d, k.unit, k.dp, true)} vs base`;
      return h('div', { class: `mdl-kpi ${t}`, role: 'listitem', 'data-mdl-kpi': k.key },
        h('div', { class: 'mdl-kpi-l' }, k.label),
        h('div', { class: 'mdl-kpi-v' }, k.value),
        h('div', { class: 'mdl-kpi-s' }, k.sub),
        h('div', { class: `mdl-kpi-d ${t}` }, h('span', { 'aria-hidden': 'true' }, arrow(t)), ' ', dTxt));
    }

    // ---- P&L table ----
    function plTable(res, withDelta) {
      const head = h('tr', null, h('th', { scope: 'col', class: 'l' }, 'US$m unless stated'),
        years.map((y, i) => h('th', { scope: 'col', class: 'r' }, ylong(y), i === 0 && stubbed ? h('span', { class: 'mdl-th-note' }, `${spec.stub.actual_months}m actual + rest`) : null)));
      const body = PL_ROWS.filter(k => Array.isArray(res.rows[k])).map(k => {
        const m = RM[k] || { label: k, unit: '', dp: 0 };
        const label = k === 'eps' ? 'EPS, diluted (US$)' : m.label + (m.unit === '%' ? ' (%)' : m.unit === 'x' ? ' (x)' : '');
        return h('tr', { class: STRONG_ROWS.has(k) ? 'mdl-strong' : null },
          h('th', { scope: 'row', class: 'l' }, label),
          years.map((y, i) => {
            const val = res.rows[k][i], b = BASE.error ? null : BASE.rows[k][i];
            const dd = withDelta && isNum(val) && isNum(b) ? val - b : null;
            const unit = m.unit === 'US$m' ? '' : m.unit === 'US$' ? '' : m.unit;
            const t = tone(dd, GOOD[k], m.unit === '%' ? 0.05 : m.unit === 'US$' ? 0.005 : 0.5);
            return h('td', { class: 'r' }, fmt(val, unit, m.dp),
              dd !== null && t !== 'flat' ? h('span', { class: `mdl-cd ${t}` }, fmt(dd, deltaUnit(unit), m.dp, true)) : null);
          }));
      });
      return h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'P&L projection' },
        h('table', { class: 'rpt-table mdl-table' }, h('thead', null, head), h('tbody', null, body)));
    }
    function renderPL(p, res) {
      p.appendChild(h('p', { class: 'mdl-note' }, `Projection under the current drivers. Small figures under a cell are the change vs the base case `
        + `(green = better for shareholders). ${stubbed ? `${ylong(years[0])} = ${spec.stub.actual_months} months reported + the model’s remainder of the year.` : ''}`));
      p.appendChild(plTable(res, true));
      p.appendChild(h('p', { class: 'mdl-note' }, 'Adj. EBITDA = revenue − cost of revenue − operating costs, before stock-based comp and D&A. '
        + 'Operating cash flow ≈ net income + D&A + SBC + customer prepayments (no other working capital). Tax on positive pre-tax profit only.'));
    }

    // ---- Interest & debt ----
    function trancheSeries(res) {
      const ids = tranches.map(t => t.id).filter(id => res.rows.interest_by_tranche[id]);
      const ranked = ids.slice().sort((a, b) => (tranches.find(t => t.id === b).balance || 0) - (tranches.find(t => t.id === a).balance || 0));
      const keep = new Set(ranked.slice(0, SERIES.length - 1));
      const name = id => str((tranches.find(t => t.id === id) || {}).name || id);
      const out = [];
      if (stubbed) out.push({ id: '_actual', name: `${spec.stub.actual_months}-month actual (all debt)`, color: C_ACTUAL, values: res.rows.interest_actual });
      let ci = 0;
      for (const id of ids) if (keep.has(id)) out.push({ id, name: name(id), color: SERIES[ci++], values: res.rows.interest_by_tranche[id] });
      const other = ids.filter(id => !keep.has(id));
      if (other.length) out.push({ id: '_other', name: `Other tranches (${other.length})`, color: C_OTHER, values: years.map((_, i) => other.reduce((s, id) => s + (res.rows.interest_by_tranche[id][i] || 0), 0)) });
      const nd = res.rows.interest_by_tranche[E.NEW_DEBT_ID];
      if (nd && nd.some(x => x > 0.5)) out.push({ id: E.NEW_DEBT_ID, name: 'New & refinancing debt', color: SERIES[SERIES.length - 1], values: nd });
      return out;
    }
    function trancheColor(res) {
      const m = new Map();
      for (const s of trancheSeries(res)) m.set(s.id, s.color);
      return id => m.get(id) || C_OTHER;
    }
    function renderDebt(p, res) {
      const R = res.rows, rp = spec.rates && spec.rates.path ? years.map(y => (isNum(spec.rates.path[String(y)]) ? spec.rates.path[String(y)] : null)) : null;
      const sofrSh = cur('sofr_shift'), spSh = cur('spread_shift');
      const series = [];
      if (rp) series.push({ name: `${str(spec.rates.base_name || 'SOFR')} path (base)`, short: 'SOFR base', color: C_LOW, values: rp, dash: true, faint: true });
      if (rp && Math.abs(sofrSh) > 1e-9) series.push({ name: `${str(spec.rates.base_name || 'SOFR')} path (${fmt(sofrSh, 'bp', 0, true)})`, short: 'SOFR now', color: C_LOW, values: R.sofr });
      if (!BASE.error && (Math.abs(sofrSh) > 1e-9 || Math.abs(spSh) > 1e-9 || JSON.stringify(st.ov) !== JSON.stringify(baseOv))) {
        series.push({ name: 'Avg cost of debt (base)', short: 'Debt base', color: C_HIGH, values: BASE.rows.avg_cost_of_debt, dash: true, faint: true });
      }
      series.push({ name: 'All-in avg cost of debt', short: 'Debt cost', color: C_HIGH, values: R.avg_cost_of_debt });
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Predicted rate path'));
      p.appendChild(h('p', { class: 'mdl-note' }, `Annual average ${str(spec.rates && spec.rates.base_name || 'SOFR')} and the model’s all-in average cost of debt (interest ÷ average debt). `
        + `Floating tranches pay the rate plus their spread; fixed notes keep their coupon until they mature and are refinanced at the new-debt rate.`));
      p.appendChild(chartBox(lineChart({ id: `${uid}-rates`, title: 'Predicted rate path and average cost of debt (%)', labels: years.map(yl), series, unit: '%', dp: 2,
        desc: series.map(s => `${s.name}: ${s.values.map((x, i) => `${yl(years[i])} ${fmt(x, '%', 2)}`).join(', ')}`).join('; ') }),
      legend(series.map(s => [s.name, s.color, s.dash]))));
      if (spec.rates && (spec.rates.note || spec.rates.src)) {
        p.appendChild(h('p', { class: 'mdl-src' }, 'Rate path: ', rich.inline(spec.rates.note || ''), Array.isArray(spec.rates.src) ? rich.cite(spec.rates.src) : null));
      }

      // interest by tranche + the company's guide as a bracket on the stub year
      const ts = trancheSeries(res);
      const marks = [];
      const gl = [];
      for (const g of guides.filter(x => x.metric === 'interest')) {
        const mv = guideValue(res, spec, g);
        const m = /^(\d{4})-Q([1-4])$/.exec(str(g.period));
        if (m && stubbed && +m[1] === years[0] && isNum(g.lo) && isNum(g.hi)) {
          const left = 4 - spec.stub.actual_months / 3, act = spec.stub.actuals.interest;
          marks.push({ i: 0, lo: act + g.lo * left, hi: act + g.hi * left, label: `${ylong(years[0])} implied by the ${str(g.label)}` });
        }
        gl.push(h('li', null, h('strong', null, str(g.label)), `: ${fmt(g.lo, 'US$m', 0)}–${fmt(g.hi, 'US$m', 0)} `, Array.isArray(g.src) ? rich.cite(g.src) : null,
          ` · model ${fmt(mv, 'US$m', 0)} `, passPill(isNum(mv) ? (mv >= g.lo && mv <= g.hi) : null)));
      }
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Interest expense by tranche'));
      p.appendChild(chartBox(stackedBars({ id: `${uid}-int`, title: 'Interest expense by tranche (US$m)', labels: years.map(yl), series: ts, unit: 'US$m', marks,
        desc: years.map((y, i) => `${yl(y)}: ${ts.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).join(', ')}`).join('; ') }),
      legend(ts.map(s => [s.name, s.color]).concat(marks.length ? [['Company guide (implied full year)', 'var(--rpt-strong)', true]] : []))));
      if (gl.length) p.appendChild(h('ul', { class: 'rpt-bul mdl-guides' }, gl));

      // maturity ladder (opening stack)
      const color = trancheColor(res);
      const openY = +str(spec.opening && spec.opening.date).slice(0, 4) || years[0];
      const matY = tranches.map(t => +str(t.maturity).slice(0, 4)).filter(isNum);
      const lastY = Math.min(openY + 12, Math.max(years[years.length - 1], ...matY));
      const ly = []; for (let y = openY; y <= lastY; y++) ly.push(y);
      // amortising loans: linear from the opening date to maturity, as the engine runs them
      const mIdx = s => { const x = /^(\d{4})-(\d{2})/.exec(str(s)); return x ? +x[1] * 12 + +x[2] : null; };
      const om = mIdx(spec.opening && spec.opening.date);
      const lad = tranches.map(t => {
        const my = +str(t.maturity).slice(0, 4), mm = mIdx(t.maturity);
        const vals = ly.map(() => 0);
        if ((t.amort === 'straight' || t.amort === 'cashsweep') && om !== null && mm !== null && mm > om) {
          ly.forEach((y, i) => { vals[i] = t.balance * Math.max(0, Math.min((y + 1) * 12, mm) - Math.max(y * 12, om)) / (mm - om); });
        } else { const i = ly.indexOf(my); if (i >= 0) vals[i] = t.balance; }
        return { id: t.id, name: str(t.name || t.id), color: color(t.id), values: vals };
      });
      // tranches folded into "Other" in the interest chart share its colour here too
      const ladSeries = [];
      const otherVals = ly.map(() => 0);
      let hasOther = false;
      for (const s of lad) {
        if (s.color === C_OTHER) { hasOther = true; s.values.forEach((x, i) => { otherVals[i] += x; }); } else ladSeries.push(s);
      }
      if (hasOther) ladSeries.push({ id: '_other', name: 'Other tranches', color: C_OTHER, values: otherVals });
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Debt maturity ladder'));
      p.appendChild(h('p', { class: 'mdl-note' }, `Principal falling due each year from the ${str(spec.opening && spec.opening.date)} debt stack (amortising loans spread evenly to maturity). `
        + 'Bullet maturities inside the model horizon are refinanced at the new-debt rate.'));
      p.appendChild(chartBox(stackedBars({ id: `${uid}-mat`, title: 'Debt maturity ladder (US$m of principal)', labels: ly.map(String), series: ladSeries, unit: 'US$m',
        desc: ly.map((y, i) => `${y}: ${ladSeries.map(s => `${s.name} ${fmt(s.values[i], 'US$m', 0)}`).filter((_, k) => ladSeries[k].values[i] > 0).join(', ') || 'none'}`).join('; ') }),
      legend(ladSeries.map(s => [s.name, s.color]))));

      // debt table
      const rateNow = id => (R.rate_by_tranche[id] ? R.rate_by_tranche[id][0] : null);
      const rows = tranches.map(t => h('tr', null,
        h('th', { scope: 'row', class: 'l' }, h('i', { class: 'mdl-sw', style: `background:${color(t.id)}`, 'aria-hidden': 'true' }), str(t.name || t.id),
          Array.isArray(t.src) ? rich.cite(t.src) : null, t.note ? h('span', { class: 'mdl-th-note' }, str(t.note)) : null),
        h('td', { class: 'r' }, fmt(t.balance, '', 0)),
        h('td', { class: 'l' }, t.kind === 'floating' ? `Floating, SOFR + ${fmt(t.spread_bp, '', 0)} bp` : `Fixed ${fmt(t.coupon_pct, '%', 2)}`),
        h('td', { class: 'r' }, fmt(rateNow(t.id), '%', 2)),
        h('td', { class: 'r' }, str(t.maturity)),
        h('td', { class: 'l' }, [t.amort, t.secured ? 'secured' : 'unsecured', t.recourse === false ? 'non-recourse' : null].filter(Boolean).join(', '))));
      const ndEnd = R.debt_by_tranche[E.NEW_DEBT_ID];
      const xi = years.indexOf(XY);
      if (ndEnd && ndEnd[xi] > 0.5) rows.push(h('tr', null, h('th', { scope: 'row', class: 'l' }, h('i', { class: 'mdl-sw', style: `background:${color(E.NEW_DEBT_ID)}`, 'aria-hidden': 'true' }), 'New debt raised by the model'),
        h('td', { class: 'r' }, `${fmt(ndEnd[xi], '', 0)} by ${yl(XY)}`), h('td', { class: 'l' }, 'New-debt rate'), h('td', { class: 'r' }, fmt(R.rate_by_tranche[E.NEW_DEBT_ID][xi], '%', 2)),
        h('td', { class: 'r' }, '—'), h('td', { class: 'l' }, 'funds the cash gap')));
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Debt stack'));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Debt stack' },
        h('table', { class: 'rpt-table mdl-table' },
          h('thead', null, h('tr', null, ['Tranche', 'Balance (US$m)', 'Terms', `Rate ${yl(years[0])}`, 'Maturity', 'Structure'].map((c, i) =>
            h('th', { scope: 'col', class: [0, 2, 5].includes(i) ? 'l' : 'r' }, c)))),
          h('tbody', null, rows))));
      if (spec.opening && Array.isArray(spec.opening.src)) p.appendChild(h('p', { class: 'mdl-src' }, `Balances at ${str(spec.opening.date)}`, rich.cite(spec.opening.src)));
    }

    // ---- Sensitivity ----
    function metricSel(value, onChange, label) {
      const s = h('select', { class: 'ctrl mdl-sel', 'aria-label': label });
      for (const m of sensMetrics) s.appendChild(h('option', { value: m.key, selected: m.key === value ? true : null }, m.label));
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    function driverSel(value, onChange, label) {
      const s = h('select', { class: 'ctrl mdl-sel', 'aria-label': label });
      for (const d of D) s.appendChild(h('option', { value: d.id, selected: d.id === value ? true : null }, `${d.label} (${d.unit})`));
      s.value = value;
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    const sensOf = key => sensMetrics.find(m => m.key === key) || sensMetrics[0];
    function renderSens(p) {
      const m = sensOf(st.sens);
      const t0 = E.sensitivity(spec, st.ov, { metric: m.metric, year: m.year });
      p.appendChild(h('div', { class: 'mdl-row' }, h('h4', { class: 'mdl-h4' }, 'Tornado: what moves the answer most'),
        h('label', { class: 'mdl-sel-l' }, 'Metric ', metricSel(st.sens, k => { st.sens = k; renderPanel('sens'); }, 'Tornado metric'))));
      p.appendChild(h('p', { class: 'mdl-note' }, `Each bar re-runs the model with one driver at the low or high end of its stress range, everything else as set now. `
        + `Sorted by swing.`));
      if (t0.error) p.appendChild(h('p', { class: 'mdl-note' }, 'The tornado couldn’t be computed for these settings.'));
      else {
        p.appendChild(chartBox(tornado({ id: `${uid}-tor`, sens: t0, drivers: D, unit: m.unit, dp: m.dp, title: `Tornado: ${m.label} (${m.unit})` }),
          legend([['Driver at its low end', C_LOW], ['Driver at its high end', C_HIGH]])));
        const flat = t0.bars.filter(b => !(b.swing > 1e-9)).map(b => b.label);
        if (flat.length) p.appendChild(h('p', { class: 'mdl-note' }, `No effect on this metric: ${flat.join(', ')}.`));
      }

      // 2-way grid
      const gm = sensOf(st.grid.metric);
      const gx = byId.get(st.grid.x) ? st.grid.x : D[0].id, gy = byId.get(st.grid.y) ? st.grid.y : D[1].id;
      const xs = axisValues(byId.get(gx), cur(gx), 7), ys = axisValues(byId.get(gy), cur(gy), 7);
      const g = E.grid(spec, st.ov, gx, xs, gy, ys, gm.year ? `${gm.metric}@${gm.year}` : gm.metric);
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Two-way sensitivity'));
      p.appendChild(h('div', { class: 'mdl-gridctl' },
        h('label', { class: 'mdl-sel-l' }, 'Metric ', metricSel(gm.key, k => {
          const dft = GRID_DEFAULTS[k] || GRID_DEFAULTS.value_per_share;
          st.grid = { metric: k, x: dft[0], y: dft[1] }; renderPanel('sens');
        }, 'Grid metric')),
        h('label', { class: 'mdl-sel-l' }, 'Across ', driverSel(gx, id => { st.grid.x = id; renderPanel('sens'); }, 'Grid columns driver')),
        h('label', { class: 'mdl-sel-l' }, 'Down ', driverSel(gy, id => { st.grid.y = id; renderPanel('sens'); }, 'Grid rows driver'))));
      if (g.error) { p.appendChild(h('p', { class: 'mdl-note' }, 'The grid couldn’t be computed for these drivers.')); return; }
      const now = E.metricValue(st.res, gm.metric, gm.year);
      const all = g.z.flat().filter(isNum);
      const maxDev = Math.max(1e-9, ...all.map(z => Math.abs(z - (isNum(now) ? now : 0))));
      const dx = byId.get(gx), dy = byId.get(gy);
      const near = (vals, c) => vals.reduce((bi, v, i) => (Math.abs(v - c) < Math.abs(vals[bi] - c) ? i : bi), 0);
      const cx = near(g.x.values, cur(gx)), cy = near(g.y.values, cur(gy));
      const head = h('tr', null, h('th', { scope: 'col', class: 'l mdl-corner' }, `${dy.label} ↓ / ${dx.label} →`),
        g.x.values.map(xv => h('th', { scope: 'col', class: 'r' }, fmt(xv, dx.unit, dx.dp))));
      const body = g.y.values.map((yv, yi) => h('tr', null, h('th', { scope: 'row', class: 'r' }, fmt(yv, dy.unit, dy.dp)),
        g.z[yi].map((z, xi) => {
          const td = h('td', { class: `r mdl-heat${xi === cx && yi === cy ? ' now' : ''}`, title: `${dx.label} ${fmt(g.x.values[xi], dx.unit, dx.dp)}, ${dy.label} ${fmt(yv, dy.unit, dy.dp)}: ${fmt(z, gm.unit, gm.dp)}` },
            gm.unit === 'US$m' ? fmt(z, '', 0) : fmt(z, gm.unit === 'US$' ? '' : gm.unit, gm.dp));
          if (isNum(z) && isNum(now)) {
            const t = (z - now) / maxDev * gm.good, a = Math.min(0.55, Math.abs(t) * 0.55);
            if (a > 0.02) td.style.setProperty('background', t > 0 ? `rgba(52,211,153,${a.toFixed(3)})` : `rgba(248,113,113,${a.toFixed(3)})`);
          }
          return td;
        })));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Two-way sensitivity grid' },
        h('table', { class: 'rpt-table mdl-table mdl-grid2' }, h('caption', { class: 'mdl-cap' }, `${gm.label} (${gm.unit})`), h('thead', null, head), h('tbody', null, body))));
      p.appendChild(h('p', { class: 'mdl-note' }, `Outlined cell = the current setting (${fmt(now, gm.unit, gm.dp)}). Green is better for shareholders than now, red worse; deeper = further away.`));
    }

    // ---- Valuation & multiples ----
    function renderVal(p, res) {
      const V = res.valuation;
      const mt = [['ev_sales', 'EV / sales', 'x', 1], ['ev_ebitda', 'EV / adj. EBITDA', 'x', 1], ['pe', 'P/E', 'x', 1], ['fcf_yield', 'FCF yield', '%', 1]];
      const rows = [];
      for (const [k, label, unit, dp] of mt) {
        rows.push(h('tr', null, h('th', { scope: 'row', class: 'l' }, label, h('span', { class: 'mdl-th-note' }, `at ${fmt(V.share_price, 'US$', 2)} price`)),
          years.map((_, i) => h('td', { class: 'r' }, fmt(V.implied_fwd_multiples_at_price[k][i], unit, dp)))));
        rows.push(h('tr', { class: 'mdl-sub-row' }, h('th', { scope: 'row', class: 'l' }, label, h('span', { class: 'mdl-th-note' }, `at ${fmt(V.value_per_share, 'US$', 2)} model value`)),
          years.map((_, i) => h('td', { class: 'r' }, fmt(V.implied_multiples_at_value[k][i], unit, dp)))));
      }
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Implied forward multiples'));
      p.appendChild(h('p', { class: 'mdl-note' }, `Today’s enterprise value at the price = market cap ${money(V.market_cap)} + net debt ${money(V.net_debt_now)} = ${money(V.ev_now)}. `
        + 'Multiples use each year’s projected revenue, adj. EBITDA, EPS and free cash flow; n/m (—) where the denominator is negative.'));
      p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Implied forward multiples' },
        h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col', class: 'l' }, 'Multiple'), years.map(y => h('th', { scope: 'col', class: 'r' }, ylong(y))))),
          h('tbody', null, rows))));
      const sp = byId.get('share_price');
      if (sp && Array.isArray(sp.src) && sp.src.length) p.appendChild(h('p', { class: 'mdl-src' }, 'Share price', rich.cite(sp.src)));

      const step = (label, value, note) => h('li', { class: 'mdl-step' }, h('span', { class: 'mdl-step-l' }, label), h('span', { class: 'mdl-step-v' }, value), note ? h('span', { class: 'mdl-step-n' }, note) : null);
      const bsY = V.balance_sheet_year;
      p.appendChild(h('h4', { class: 'mdl-h4' }, 'Exit valuation bridge'));
      p.appendChild(h('ol', { class: 'mdl-bridge', 'aria-label': 'Exit valuation bridge' },
        step(`${ylong(V.exit_year)} adj. EBITDA`, money(V.exit_ebitda)),
        step('× exit EV/EBITDA', fmt(V.exit_multiple, 'x', 1)),
        step('= enterprise value', money(V.exit_ev)),
        step(`− net debt${bsY ? ` (end ${bsY})` : ''}`, money(V.exit_net_debt)),
        step('= equity value', money(V.exit_equity), isNum(V.exit_equity) && V.exit_equity <= 0 ? 'debt exceeds EV: value floored at 0' : null),
        step(`÷ shares${bsY ? ` (end ${bsY})` : ''}`, fmt(V.exit_shares, 'm', 0)),
        step(`= value at ${str(V.valuation_date)}`, fmt(V.exit_value_per_share, 'US$', 2)),
        step(`× discount (${fmt(cur('discount_rate'), '%', 1)} for ${fmt(V.years_to_valuation, '', 1)} yrs)`, fmt(V.discount_factor, '', 3)),
        step('= value per share today', fmt(V.value_per_share, 'US$', 2), `vs ${fmt(V.share_price, 'US$', 2)}: ${fmt(V.upside_pct, '%', 0, true)}`)));
    }

    // ---- Calibration ----
    function passPill(pass) {
      return h('span', { class: `mdl-pass ${pass === true ? 'ok' : pass === false ? 'miss' : 'na'}` }, pass === true ? '✓ within' : pass === false ? '✗ outside' : 'n/a');
    }
    function renderCal(p, res) {
      const unitOf = mk => (RM[mk] ? RM[mk].unit : mk === 'value_per_share' ? 'US$' : '');
      const rng = (c, u) => (c.lo !== null && c.hi !== null ? `${fmt(c.lo, u, 0)} – ${fmt(c.hi, u, 0)}` : c.lo !== null ? `≥ ${fmt(c.lo, u, 0)}` : c.hi !== null ? `≤ ${fmt(c.hi, u, 0)}` : '—');
      const rows = res.checks.map(c => {
        const u = unitOf(c.metric);
        return h('tr', null, h('th', { scope: 'row', class: 'l' }, str(c.label), c.src && c.src.length ? rich.cite(c.src) : null),
          h('td', { class: 'r' }, fmt(c.value, u, u === '%' || u === 'x' ? 1 : 0)), h('td', { class: 'r' }, rng(c, u)), h('td', { class: 'l' }, passPill(c.pass)));
      });
      for (const g of guides) {
        const mv = guideValue(res, spec, g), u = unitOf(g.metric);
        const c = { lo: isNum(g.lo) ? g.lo : null, hi: isNum(g.hi) ? g.hi : null };
        const pass = isNum(mv) ? (c.lo === null || mv >= c.lo) && (c.hi === null || mv <= c.hi) : null;
        rows.push(h('tr', null, h('th', { scope: 'row', class: 'l' }, `${str(g.label)} (${str(g.period)})`, Array.isArray(g.src) ? rich.cite(g.src) : null),
          h('td', { class: 'r' }, fmt(mv, u, 0)), h('td', { class: 'r' }, rng(c, u)), h('td', { class: 'l' }, passPill(pass))));
      }
      const nOk = rows.length ? res.checks.filter(c => c.pass === true).length : 0;
      p.appendChild(h('p', { class: 'mdl-note' }, `How the model, under the current drivers, compares with the company’s guidance and other cited targets `
        + `(${nOk} of ${res.checks.length} checks within range). A miss is a prompt to revisit a driver, not proof the model is wrong.`));
      if (rows.length) {
        p.appendChild(h('div', { class: 'rpt-tablewrap', role: 'region', tabindex: '0', 'aria-label': 'Calibration checks' },
          h('table', { class: 'rpt-table mdl-table' }, h('thead', null, h('tr', null, ['Check', 'Model', 'Target', 'Result'].map((c, i) => h('th', { scope: 'col', class: i % 3 === 0 ? 'l' : 'r' }, c)))),
            h('tbody', null, rows))));
      } else p.appendChild(h('p', { class: 'mdl-note' }, 'This model has no calibration targets.'));
      if (res.warnings && res.warnings.length) {
        p.appendChild(h('h4', { class: 'mdl-h4' }, 'Model notes'));
        p.appendChild(h('ul', { class: 'rpt-bul mdl-warn' }, res.warnings.slice(0, 12).map(w => h('li', null, str(w)))));
      }
    }

    function renderPanel(k) {
      const p = panels.get(k);
      if (!p || !st.res || st.res.error) return;
      clear(p);
      try {
        if (k === 'pl') renderPL(p, st.res);
        else if (k === 'debt') renderDebt(p, st.res);
        else if (k === 'sens') renderSens(p);
        else if (k === 'val') renderVal(p, st.res);
        else if (k === 'cal') renderCal(p, st.res);
      } catch (e) { clear(p); p.appendChild(h('p', { class: 'mdl-note' }, 'This view couldn’t be drawn for these settings.')); }
      st.stale.delete(k);
    }

    // ---- Key P&L drivers callout ----
    function renderKeyDrivers() {
      clear(keyd);
      const m = sensMetrics[1];
      const s = E.sensitivity(spec, st.ov, { metric: m.metric, year: m.year });
      const lines = keyDriverLines(s, D, m.what, m.unit);
      keyd.appendChild(h('div', { class: 'rpt-callout-t' }, `Key P&L drivers — ${m.what}`));
      if (!lines.length) { keyd.appendChild(h('p', null, 'No single driver moves this line at the current settings.')); return; }
      keyd.appendChild(h('ul', { class: 'rpt-bul' }, lines.map(l => h('li', null, l.text))));
      keyd.appendChild(h('p', { class: 'mdl-note' }, `From the tornado at the current settings: each driver moved alone to the end of its stress range that matters most.`));
    }

    // ---- print snapshot ----
    function scenarioName() {
      const id = E.matchScenario(spec, st.ov);
      const s = id && scen.find(x => x.id === id);
      return s ? str(s.name) : 'Custom';
    }
    function renderPrint() {
      st.snapT = 0;
      if (!st.res || st.res.error) return;
      clear(printBox);
      const changed = D.filter(d => Math.abs(cur(d.id) - d.base) > 1e-12).map(d => `${d.label} ${fmt(cur(d.id), d.unit, d.dp, /^shift|^scale/.test(d.kind))}`);
      const today = new Date().toISOString().slice(0, 10);
      printBox.appendChild(h('h3', { class: 'mdl-title' }, 'Stress test & projections'));
      printBox.appendChild(h('p', { class: 'mdl-note' }, `Scenario as of print (${today}): ${scenarioName()}. `
        + (changed.length ? `Drivers changed from base: ${changed.join('; ')}.` : 'All drivers at base.')));
      printBox.appendChild(h('div', { class: 'mdl-kpis' }, kpiList(st.res).map(kpiTile)));
      printBox.appendChild(plTable(st.res, false));
      const m = sensMetrics[0], t0 = E.sensitivity(spec, st.ov, { metric: m.metric });
      if (!t0.error) printBox.appendChild(h('div', { class: 'mdl-chart' }, h('div', { class: 'mdl-cap' }, `Tornado: ${m.label} (${m.unit})`),
        tornado({ id: `${uid}-ptor`, sens: t0, drivers: D, unit: m.unit, dp: m.dp, title: `Tornado: ${m.label}` }),
        legend([['Driver at its low end', C_LOW], ['Driver at its high end', C_HIGH]])));
      printBox.appendChild(h('p', { class: 'mdl-disc' }, 'Illustrative model, not investment advice; outputs are only as good as the drivers.'));
    }
    const onBeforePrint = () => renderPrint();
    if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('beforeprint', onBeforePrint);

    // ---- copy link ----
    function shareUrl() {
      const base = str(links.self) || '';
      const hash = base + (st.enc ? `?m=${st.enc}` : '');
      if (typeof location === 'undefined') return hash;
      return location.href.split('#')[0] + hash;
    }
    function copyLink() {
      const url = shareUrl();
      const shown = () => { copyBox.hidden = false; copyBox.value = url; try { copyBox.focus(); copyBox.select(); } catch { /* old browsers */ } status('Copy the link from the box.'); };
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url).then(() => { copyBox.hidden = true; status('Link to this scenario copied.'); }, shown);
        } else shown();
      } catch { shown(); }
    }

    // ---- update ----
    function update() {
      const res = E.project(spec, st.ov);
      st.res = res;
      if (res.error) { clear(kpis); kpis.appendChild(h('p', { class: 'mdl-note' }, 'The model couldn’t be run with these settings.')); return; }
      syncDrivers();
      const id = E.matchScenario(spec, st.ov);
      for (const [sid, b] of chipEls) { const on = sid === id; b.setAttribute('aria-pressed', on ? 'true' : 'false'); b.classList.toggle('on', on); }
      customChip.hidden = !!id;
      const sc = id && scen.find(x => x.id === id);
      scenNote.textContent = sc ? (sc.note ? `${str(sc.name)}: ${str(sc.note)}` : '') : 'Custom: drivers edited by hand.';
      clear(kpis);
      for (const k of kpiList(res)) kpis.appendChild(kpiTile(k));
      renderKeyDrivers();
      for (const [k] of TABS) st.stale.add(k);
      renderPanel(st.tab);
      st.enc = E.encodeState(spec, st.ov);
      if (fullLink) fullLink.setAttribute('href', str(links.full) + (st.enc ? `?m=${st.enc}` : ''));
      if (typeof o.onState === 'function') { try { o.onState(st.enc); } catch { /* caller's problem */ } }
      clearTimeout(st.snapT);
      st.snapT = setTimeout(renderPrint, 600);
    }

    decode(o.state);
    update();

    const dispose = () => {
      st.alive = false;
      clearTimeout(st.snapT); clearTimeout(statusT);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('beforeprint', onBeforePrint);
      if (root.parentNode) root.parentNode.removeChild(root);
    };
    dispose.setState = s => { decode(s); schedule(); };
    dispose.getState = () => st.enc;
    return dispose;
  }

  return {
    mount,
    // Pure helpers, exposed for tests.
    _internal: { fmt, money, tickMoney, tone, scale, axisValues, driverNoun, moveText, keyDriverLines, guideValue },
  };
});
