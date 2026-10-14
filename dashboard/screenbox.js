// Screen box — the self-contained screener widget (ADR-037): filter chips with a field
// picker, a column picker, a sortable results table (sticky symbol column, score bars,
// flag pills), "Showing N of M matches", the hidden-row count with its reasons and the
// include-flagged toggle, and a formula-safe CSV export for trusted viewers.
//
// Self-contained on purpose: no app.js globals (it brings its own esc/format helpers),
// `sbx-` classes styled by screener.css (not Tailwind utilities), `data-sbx-*`
// attributes, no element ids — so the index page's Screener view and, later, the
// portfolio page can each mount it without colliding with their own handlers.
// Filters are plain data checked by ScreenDSL (screen-dsl.js); nothing is ever eval'd,
// and every string that reaches the DOM goes through esc().
//
//   const h = ScreenBox.mount(el, {scope, rows, registry, trusted, onOpen(key), onChange(filter),
//                                  filter?, starHTML?(kind, key), bindStars?(el)})
//   h.setRows(rows, {asof?, message?})  h.setFilter(filter)  h.getFilter()  h.count(filter)
//   h.setTrusted(bool)  h.destroy()
// `registry` is the ScreenDSL API object (defaults to window.ScreenDSL, loaded).
const ScreenBox = (() => {
  'use strict';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = v => typeof v === 'number' && isFinite(v);
  const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } };

  // Columns shown before the user picks any (filter fields and the sort field are added).
  const DEFAULT_COLS = {
    stocks: ['sector', 'market_cap', 'pe', 'value_score', 'growth_score', 'rev_cagr', 'discount_long', 'dividend_yield'],
    markets: ['kind', 'region', 'pe', 'value_score', 'growth_score', 'earnings_growth', 'discount_long', 'dividend_yield'],
  };
  // The sticky first column: what a row IS. Its header sorts by this field.
  const ID_FIELD = { stocks: 'ticker', markets: 'name' };
  const ID_LABEL = { stocks: 'Symbol', markets: 'Market' };
  const NOUN = { stocks: ['stock', 'stocks'], markets: ['market', 'markets'] };
  // Strategy/quality flags shown as pills in the Flags column (when true for the row).
  const PILLS = ['on_sale', 'deep_value_intact', 'steady_compounder', 'garp', 'fundamentally_strong', 'turning_up'];
  const LIMITS = [25, 50, 100, 250, 500];
  const LS_COLS = 'giva_sbx_cols:';
  // Why a row is hidden (engine/picks.py exclusion_reasons codes; quality:<check> below).
  const REASONS = {
    foreign_listing: ['foreign listing', 'foreign listings'],
    non_usd_reporter: ['non-USD reporter', 'non-USD reporters'],
    implausible_pe: ['implausible P/E', 'implausible P/Es'],
    implausible_ps: ['implausible P/S', 'implausible P/S ratios'],
    below_min_mcap: ['below the minimum market cap', 'below the minimum market cap'],
    short_history: ['short filing history', 'short filing histories'],
  };
  const reasonText = (code, n) => {
    if (Object.prototype.hasOwnProperty.call(REASONS, code)) return REASONS[code][n === 1 ? 0 : 1];
    if (/^quality:/.test(code)) return `open data check (${code.slice(8).replace(/_/g, ' ')})`;
    return String(code).replace(/_/g, ' ');
  };
  const OP_LABEL = {
    '<': 'below', '<=': 'at most', '>': 'above', '>=': 'at least', '=': 'equals', '!=': 'is not',
    between: 'between', in: 'is any of', not_in: 'is none of', contains: 'contains',
  };
  const GROWTHY = new Set(['rev_growth', 'earnings_growth', 'rev_cagr', 'ni_cagr', 'fwd_growth']);
  const NUM_TYPES = new Set(['number', 'percent', 'money']);
  let mounts = 0;   // per-mount suffix for the editor's <datalist> id

  // ---- formatting (own helpers; no app.js) ----
  const trimNum = (v, d) => String(Number(Number(v).toFixed(d)));
  function fmtMoney(v) {
    const a = Math.abs(v);
    const [div, suf] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1, ''];
    return (v < 0 ? '-$' : '$') + (a / div).toFixed(div === 1 ? 2 : (a / div >= 100 ? 0 : 1)) + suf;
  }
  const isScore = f => f && f.type === 'number' && f.unit === '/100';
  const scoreColor = s => s == null ? '#475569' : `hsl(${Math.round((Math.max(0, Math.min(100, s)) / 100) * 140)} 65% 55%)`;
  function cellHTML(f, v) {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '<span class="sbx-na">—</span>';
    if (f.type === 'bool') return v === true ? '<span class="sbx-yes">✓</span>' : '<span class="sbx-na">·</span>';
    if (Array.isArray(v)) {
      if (!v.length) return '<span class="sbx-na">—</span>';
      return esc((f.key === 'data_flags' ? v.map(c => reasonText(c, 1)) : v).join(', '));
    }
    if (typeof v !== 'number') return esc(v);
    if (isScore(f)) {
      return `<span class="sbx-bar"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${scoreColor(v)}"></i></span>`
        + `<span class="sbx-num">${Math.round(v)}</span>`;
    }
    if (f.type === 'percent') {
      const t = `${trimNum(v * 100, Math.abs(v) < 0.1 ? 1 : 0)}%`;
      if (GROWTHY.has(f.key)) return `<span class="${v >= 0 ? 'sbx-up' : 'sbx-down'}">${v > 0 ? '+' : ''}${t}</span>`;
      if (f.key === 'discount_long') return `${v > 0 ? '+' : ''}${t}`;
      return t;
    }
    if (f.type === 'money') return fmtMoney(v);
    return trimNum(v, Math.abs(v) >= 100 ? 0 : 1);
  }
  // A value as the editor shows it (percent in %, money with a b/m/t suffix).
  function editText(f, v) {
    if (!isNum(v)) return '';
    if (f.type === 'percent') return String(Number((v * 100).toPrecision(10)));
    if (f.type === 'money') {
      const a = Math.abs(v);
      for (const [d, s] of [[1e12, 't'], [1e9, 'b'], [1e6, 'm']]) if (a >= d) return String(Number((v / d).toPrecision(10))) + s;
    }
    return String(v);
  }
  // Parse what the user typed; NaN when it isn't a number.
  function parseVal(f, s) {
    s = String(s ?? '').trim().replace(/,/g, '');
    if (!s) return NaN;
    if (f.type === 'percent') {
      const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+))\s*%?$/);
      return m ? Number(m[1]) / 100 : NaN;
    }
    if (f.type === 'money') {
      const m = s.toLowerCase().match(/^\$?\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(k|m|mn|b|bn|t|tn)?$/);
      if (!m) return NaN;
      const mult = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9, t: 1e12, tn: 1e12 }[m[2]] || 1;
      return Number(m[1]) * mult;
    }
    return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s) ? Number(s) : NaN;
  }
  const unitHint = f => f.type === 'percent' ? '%' : f.type === 'money' ? 'e.g. 10b' : (f.unit && f.unit !== '/100' ? f.unit : '');

  function mount(el, opts = {}) {
    if (!el) throw new Error('ScreenBox.mount: no element');
    const D = opts.registry && typeof opts.registry.validate === 'function' ? opts.registry
      : (typeof ScreenDSL !== 'undefined' ? ScreenDSL : null);
    const scope = opts.scope === 'stocks' ? 'stocks' : 'markets';
    const kind = scope === 'stocks' ? 'stock' : 'market';
    const uid = ++mounts;
    const st = {
      rows: Array.isArray(opts.rows) ? opts.rows : [], meta: {}, trusted: !!opts.trusted,
      filter: null, cols: null, colsExplicit: false,
      editor: null,     // {i: index or -1 (new), field, op, value}
      colsOpen: false, editorErr: '', alive: true,
    };
    const ready = () => !!(D && D.isReady && D.isReady());
    const blank = () => ({ v: 1, scope, where: [], sort: { field: 'value_score', dir: 'desc' }, limit: 100, include_flagged: false });
    const fieldDef = k => (ready() ? D.field(k) : null);
    const inScope = f => !!f && f.scopes.includes(scope);

    // Columns: an explicit filter.columns, else the user's last pick for this scope, else defaults.
    function storedCols() {
      try {
        const v = JSON.parse(lsGet(LS_COLS + scope) || 'null');
        return Array.isArray(v) ? v.filter(k => typeof k === 'string' && inScope(fieldDef(k))).slice(0, 20) : null;
      } catch { return null; }
    }
    function baseCols() { return st.cols || storedCols() || DEFAULT_COLS[scope].filter(k => inScope(fieldDef(k))); }
    // Displayed = base + any filtered/sorted field not already there (the user sees what they asked for).
    function shownCols() {
      const out = baseCols().filter(k => k !== ID_FIELD[scope]);
      const f = st.filter;
      if (f) for (const k of f.where.map(c => c.field).concat(f.sort ? [f.sort.field] : [])) {
        if (k !== ID_FIELD[scope] && k !== 'ticker' && !out.includes(k) && out.length < 20) out.push(k);
      }
      return out.filter(k => fieldDef(k));
    }

    function setFilterInternal(f, { fromUser = false } = {}) {
      if (!ready()) return false;
      const v = D.validate(f || blank(), scope);
      if (!v.ok) return false;
      st.filter = v.filter;
      if (v.filter.columns) { st.cols = v.filter.columns.slice(); st.colsExplicit = true; }
      if (fromUser && typeof opts.onChange === 'function') { try { opts.onChange(getFilter()); } catch { /* caller's problem */ } }
      return true;
    }
    function getFilter() {
      if (!st.filter) return null;
      const f = JSON.parse(JSON.stringify(st.filter));
      if (st.colsExplicit && st.cols) f.columns = st.cols.slice(0, 20); else delete f.columns;
      return f;
    }
    // Change the current filter from a user action: validate, keep, re-render, notify.
    function change(mut) {
      const f = getFilter() || blank();
      mut(f);
      const v = D.validate(f, scope);
      if (!v.ok) return v.errors;
      setFilterInternal(v.filter, { fromUser: true });
      render();
      return null;
    }

    // One long-average window shared by every row -> chips say "2-year average".
    function longAvgYears() {
      const ys = new Set();
      for (const r of st.rows) if (r && isNum(r.long_avg_years)) { ys.add(Math.round(r.long_avg_years * 10) / 10); if (ys.size > 1) return null; }
      return ys.size === 1 ? [...ys][0] : null;
    }
    const chipText = c => (D.describe({ v: 1, scope, where: [c] }, { longAvgYears: longAvgYears() })[0] || c.field);

    // Matching rows that the data_ok gate hides, and why (a row can have several reasons).
    function hiddenInfo(f) {
      const bad = st.rows.filter(r => r && !D.dataOk(r));
      if (!bad.length) return { n: 0, reasons: [] };
      const probe = { ...f, sort: null, limit: 500, include_flagged: true };
      delete probe.columns;
      const hit = [];
      // evaluate() caps at 500 AFTER filtering, so 500-row slices return every match.
      for (let i = 0; i < bad.length; i += 500) hit.push(...D.evaluate(probe, bad.slice(i, i + 500)).rows);
      const counts = new Map();
      for (const r of hit) {
        const codes = Array.isArray(r.data_flags) && r.data_flags.length ? r.data_flags : ['data_check'];
        for (const c of codes) counts.set(c, (counts.get(c) || 0) + 1);
      }
      const reasons = [...counts].sort((a, b) => b[1] - a[1]).map(([c, n]) =>
        c === 'data_check' ? `${n} failed the data sanity check` : `${n} ${reasonText(c, n)}`);
      return { n: hit.length, reasons };
    }

    // ---- rendering ----
    el.classList.add('sbx');
    el.innerHTML = `
      <div class="sbx-filters">
        <div class="sbx-chips" data-sbx-part="chips"></div>
        <div data-sbx-part="editor"></div>
        <div data-sbx-part="cols"></div>
      </div>
      <div class="sbx-bar-row">
        <div class="sbx-count" data-sbx-part="count" aria-live="polite"></div>
        <div class="sbx-tools" data-sbx-part="tools"></div>
      </div>
      <div class="sbx-hidden" data-sbx-part="hidden"></div>
      <div class="sbx-scroll" data-sbx-part="table"></div>`;
    const part = n => el.querySelector(`[data-sbx-part="${n}"]`);

    function renderChips() {
      const f = st.filter;
      const chips = f.where.map((c, i) => `<span class="sbx-chip${st.editor && st.editor.i === i ? ' sbx-chip-on' : ''}">
          <button type="button" class="sbx-chip-t" data-sbx-act="edit" data-sbx-i="${i}" title="Edit this condition">${esc(chipText(c))}</button>
          <button type="button" class="sbx-chip-x" data-sbx-act="rm" data-sbx-i="${i}" aria-label="Remove ${esc(chipText(c))}">×</button></span>`);
      if (f.sort) {
        const sf = fieldDef(f.sort.field);
        chips.push(`<span class="sbx-chip sbx-chip-sort"><span class="sbx-chip-t">Sorted by ${esc(sf ? sf.short : f.sort.field)} ${f.sort.dir === 'desc' ? '↓' : '↑'}</span>
          <button type="button" class="sbx-chip-x" data-sbx-act="rm-sort" aria-label="Remove the sort">×</button></span>`);
      }
      const full = f.where.length >= (D.registry().limits.max_conditions || 12);
      chips.push(`<button type="button" class="sbx-add" data-sbx-act="add"${full ? ' disabled title="At most 12 conditions"' : ''}>+ Add filter</button>`);
      if (f.where.length) chips.push('<button type="button" class="sbx-link" data-sbx-act="clear">Clear filters</button>');
      part('chips').innerHTML = chips.join('');
    }

    function fieldOptions(selected) {
      return D.registry().groups.map(g => {
        const fs = D.fields(scope).filter(f => f.group === g && f.key !== 'data_ok');
        if (!fs.length) return '';
        return `<optgroup label="${esc(g)}">${fs.map(f =>
          `<option value="${esc(f.key)}"${f.key === selected ? ' selected' : ''}>${esc(f.label)}</option>`).join('')}</optgroup>`;
      }).join('');
    }
    // Ops offered in the picker (enum '='/'!=' are the one-value case of in / not in).
    function pickerOps(f) {
      const ops = D.ops(f.key);
      if (f.type === 'enum') return ops.filter(o => o === 'in' || o === 'not_in');
      return ops;
    }
    function opLabel(f, op) {
      if (op === 'is_true') return f.label;
      if (op === 'is_false') return f.label_false || `Not: ${f.label}`;
      return OP_LABEL[op] || op;
    }
    function observedValues(k) {
      const seen = new Set();
      for (const r of st.rows) {
        const v = r && r[k];
        for (const x of Array.isArray(v) ? v : [v]) if (typeof x === 'string' && x && seen.size < 60) seen.add(x);
      }
      return [...seen].sort();
    }

    function renderEditor() {
      const ed = st.editor, box = part('editor');
      if (!ed) { box.innerHTML = ''; return; }
      const f = fieldDef(ed.field);
      const ops = pickerOps(f);
      if (!ops.includes(ed.op)) ed.op = ops[0];
      let val = '';
      const v = ed.value;
      if (f.type === 'bool') {
        val = '';
      } else if (f.type === 'enum') {
        const on = new Set(Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []));
        val = `<div class="sbx-enum">${f.enum.map(x => `<label><input type="checkbox" data-sbx-ed="enum" value="${esc(x)}"${on.has(x) ? ' checked' : ''}> ${esc(x)}</label>`).join('')}</div>`;
      } else if (ed.op === 'between') {
        const [a, b] = Array.isArray(v) ? v : [null, null];
        val = `<input class="sbx-in sbx-in-num" data-sbx-ed="v0" inputmode="decimal" maxlength="24" value="${esc(editText(f, a))}" aria-label="From">
          <span class="sbx-and">and</span>
          <input class="sbx-in sbx-in-num" data-sbx-ed="v1" inputmode="decimal" maxlength="24" value="${esc(editText(f, b))}" aria-label="To">
          <span class="sbx-unit">${esc(unitHint(f))}</span>`;
      } else if (NUM_TYPES.has(f.type)) {
        val = `<input class="sbx-in sbx-in-num" data-sbx-ed="v0" inputmode="decimal" maxlength="24" value="${esc(editText(f, v))}" aria-label="Value">
          <span class="sbx-unit">${esc(unitHint(f))}</span>`;
      } else {
        const text = Array.isArray(v) ? v.join(', ') : (typeof v === 'string' ? v : '');
        const sugg = observedValues(f.key);
        const hint = ed.op === 'in' || ed.op === 'not_in' ? 'comma-separated' : '';
        val = `<input class="sbx-in sbx-in-text" data-sbx-ed="text" maxlength="${ed.op === 'in' || ed.op === 'not_in' ? 4000 : 80}"
            value="${esc(text)}" aria-label="Text"${sugg.length && hint === '' ? ` list="sbx-dl-${uid}-${esc(f.key)}"` : ''} placeholder="${esc(hint)}">
          ${sugg.length ? `<datalist id="sbx-dl-${uid}-${esc(f.key)}">${sugg.map(s => `<option value="${esc(s)}"></option>`).join('')}</datalist>` : ''}`;
      }
      box.innerHTML = `<div class="sbx-editor" data-sbx-editor role="group" aria-label="${ed.i < 0 ? 'Add a filter' : 'Edit filter'}">
        <div class="sbx-ed-row">
          <select class="sbx-in" data-sbx-ed="field" aria-label="Field">${fieldOptions(ed.field)}</select>
          <select class="sbx-in" data-sbx-ed="op" aria-label="Condition">${ops.map(o => `<option value="${esc(o)}"${o === ed.op ? ' selected' : ''}>${esc(opLabel(f, o))}</option>`).join('')}</select>
          ${val}
        </div>
        ${f.help ? `<div class="sbx-help">${esc(f.help)}</div>` : ''}
        ${st.editorErr ? `<div class="sbx-err" role="alert">${esc(st.editorErr)}</div>` : ''}
        <div class="sbx-ed-row">
          <button type="button" class="sbx-btn sbx-btn-pri" data-sbx-act="ed-apply">${ed.i < 0 ? 'Add' : 'Apply'}</button>
          <button type="button" class="sbx-btn" data-sbx-act="ed-cancel">Cancel</button>
        </div></div>`;
      const first = box.querySelector('[data-sbx-ed="v0"], [data-sbx-ed="text"]');
      if (first && ed.focus) { first.focus(); ed.focus = false; }
    }

    // Read the editor's inputs into ed.value (keeps what was typed across re-renders).
    function readEditor() {
      const ed = st.editor, box = part('editor');
      if (!ed) return;
      const f = fieldDef(ed.field);
      const q = s => box.querySelector(`[data-sbx-ed="${s}"]`);
      if (f.type === 'enum') ed.value = [...box.querySelectorAll('[data-sbx-ed="enum"]:checked')].map(x => x.value);
      else if (q('v1')) ed.value = [parseVal(f, q('v0').value), parseVal(f, q('v1').value)];
      else if (q('v0')) ed.value = parseVal(f, q('v0').value);
      else if (q('text')) {
        const t = q('text').value;
        ed.value = ed.op === 'in' || ed.op === 'not_in' ? t.split(',').map(s => s.trim()).filter(Boolean) : t.trim();
      }
    }
    function editorCond() {
      const ed = st.editor, f = fieldDef(ed.field);
      if (f.type === 'bool') return { field: f.key, op: ed.op };
      const v = ed.value;
      if (f.type === 'enum') {
        if (!Array.isArray(v) || !v.length) return 'Pick at least one value.';
        return { field: f.key, op: ed.op, value: v };
      }
      if (ed.op === 'between') {
        if (!Array.isArray(v) || !isNum(v[0]) || !isNum(v[1])) return 'Enter two numbers.';
        return { field: f.key, op: 'between', value: v[0] <= v[1] ? v : [v[1], v[0]] };
      }
      if (NUM_TYPES.has(f.type)) {
        if (!isNum(v)) return f.type === 'money' ? 'Enter a number (10b, 500m, 1.5t are fine).' : 'Enter a number.';
        return { field: f.key, op: ed.op, value: v };
      }
      if (Array.isArray(v) ? !v.length : !v) return 'Enter some text.';
      return { field: f.key, op: ed.op, value: v };
    }
    function openEditor(i) {
      const c = i >= 0 ? st.filter.where[i] : null;
      const field = c ? c.field : 'pe';
      let op = c ? c.op : '<=';
      let value = c ? c.value : null;
      const f = fieldDef(field);
      if (c && f.type === 'enum' && (op === '=' || op === '!=')) { value = [value]; op = op === '=' ? 'in' : 'not_in'; }
      st.editor = { i, field, op, value, focus: true };
      st.editorErr = '';
      st.colsOpen = false;
      renderChips(); renderEditor(); renderCols();
    }

    function renderCols() {
      const box = part('cols');
      if (!st.colsOpen) { box.innerHTML = ''; return; }
      const chosen = baseCols();
      const full = chosen.length >= 20;
      box.innerHTML = `<div class="sbx-cols" role="group" aria-label="Columns">
        <div class="sbx-cols-head"><strong>Columns</strong> <span class="sbx-muted">${chosen.length} of 20 chosen; filtered fields are always shown</span></div>
        <div class="sbx-cols-grid">${D.registry().groups.map(g => {
          const fs = D.fields(scope).filter(f => f.group === g && f.key !== ID_FIELD[scope]);
          if (!fs.length) return '';
          return `<fieldset><legend>${esc(g)}</legend>${fs.map(f => {
            const on = chosen.includes(f.key);
            return `<label title="${esc(f.help || '')}"><input type="checkbox" data-sbx-col="${esc(f.key)}"${on ? ' checked' : ''}${!on && full ? ' disabled' : ''}> ${esc(f.label)}</label>`;
          }).join('')}</fieldset>`;
        }).join('')}</div>
        <div class="sbx-ed-row"><button type="button" class="sbx-btn sbx-btn-pri" data-sbx-act="cols-done">Done</button>
          <button type="button" class="sbx-btn" data-sbx-act="cols-reset">Reset to default</button></div></div>`;
    }

    function renderTools(res) {
      const f = st.filter;
      const lim = LIMITS.includes(f.limit) ? LIMITS : LIMITS.concat([f.limit]).sort((a, b) => a - b);
      part('tools').innerHTML = `
        <label class="sbx-muted">Show <select class="sbx-in" data-sbx-ed="limit" aria-label="Rows to show">${lim.map(n =>
          `<option value="${n}"${n === f.limit ? ' selected' : ''}>top ${n}</option>`).join('')}</select></label>
        <button type="button" class="sbx-btn${st.colsOpen ? ' sbx-btn-on' : ''}" data-sbx-act="cols" aria-expanded="${st.colsOpen}">Columns</button>
        ${st.trusted ? `<button type="button" class="sbx-btn" data-sbx-act="csv"${res.rows.length ? '' : ' disabled'} title="Download the rows shown (formula-safe CSV)">CSV</button>` : ''}`;
    }

    function renderCount(res) {
      const [one, many] = NOUN[scope];
      let t;
      if (st.meta.message && !st.rows.length) t = '';
      else if (!res.total) t = 'No matches';
      else if (res.rows.length < res.total) t = `Showing <b>${res.rows.length}</b> of <b>${res.total.toLocaleString()}</b> matches`;
      else t = `<b>${res.total.toLocaleString()}</b> ${res.total === 1 ? 'match' : 'matches'}`;
      const universe = st.rows.length ? ` <span class="sbx-muted">· ${st.rows.length.toLocaleString()} ${st.rows.length === 1 ? one : many}${st.meta.asof ? ` · as of ${esc(st.meta.asof)}` : ''}</span>` : '';
      part('count').innerHTML = t + universe;
    }

    function renderHidden() {
      const f = st.filter, box = part('hidden');
      if (!st.rows.length) { box.innerHTML = ''; return; }
      const toggle = (on, label) => `<label class="sbx-toggle"><input type="checkbox" data-sbx-ed="flagged"${on ? ' checked' : ''}> ${label}</label>`;
      if (f.include_flagged) {
        const all = D.evaluate({ ...f, limit: 500 }, st.rows.filter(r => r && !D.dataOk(r))).total;
        box.innerHTML = all ? `<span class="sbx-warn">⚠ Including ${all.toLocaleString()} ${all === 1 ? 'row' : 'rows'} with data issues (marked ⚠ — their ratios may be distorted).</span> ${toggle(true, 'Include them')}` : toggle(true, 'Include rows with data issues');
        return;
      }
      const h = hiddenInfo(f);
      if (!h.n) { box.innerHTML = ''; return; }
      const several = scope === 'stocks' && h.reasons.length > 1 ? ' (a stock can have several reasons)' : '';
      box.innerHTML = `<span class="sbx-muted">${h.n.toLocaleString()} more ${h.n === 1 ? 'match is' : 'matches are'} hidden for data issues${several}: ${esc(h.reasons.join(', '))}.</span> ${toggle(false, 'Include them')}`;
    }

    function headCell(k, label, title, sortable = true) {
      const s = st.filter.sort;
      const on = s && s.field === k;
      const arrow = on ? (s.dir === 'desc' ? ' ↓' : ' ↑') : '';
      return `<th scope="col"${sortable ? ` data-sbx-sort="${esc(k)}" tabindex="0" aria-sort="${on ? (s.dir === 'desc' ? 'descending' : 'ascending') : 'none'}"` : ''} title="${esc(title)}">${esc(label)}${arrow}</th>`;
    }
    function colLabel(f) {
      if (f.key === 'discount_long') {
        const y = longAvgYears();
        return y == null ? 'vs long-run avg' : `vs ${y >= 4.75 ? 5 : trimNum(y, 1)}y avg`;
      }
      return f.short || f.label;
    }
    function pillsHTML(r) {
      const out = [];
      for (const k of PILLS) {
        const f = fieldDef(k);
        if (inScope(f) && r[k] === true) out.push(`<span class="sbx-pill" title="${esc(f.help || f.label)}">${esc(f.short || f.label)}</span>`);
      }
      const trap = fieldDef('value_trap');
      if (inScope(trap) && r.value_trap === true) out.push(`<span class="sbx-pill sbx-pill-bad" title="${esc(trap.help || trap.label)}">${esc(trap.short || 'Value trap')}</span>`);
      if (!D.dataOk(r)) {
        const why = Array.isArray(r.data_flags) && r.data_flags.length ? r.data_flags.map(c => reasonText(c, 1)).join(', ') : 'failed the data sanity check';
        out.push(`<span class="sbx-pill sbx-pill-warn" title="${esc(why)}">⚠ data</span>`);
      }
      return out.join(' ');
    }
    function idCell(r) {
      const star = typeof opts.starHTML === 'function' ? (() => { try { return opts.starHTML(kind, D.rowKey(r, scope)) || ''; } catch { return ''; } })() : '';
      const starSpan = star ? `<span class="sbx-star" data-sbx-star>${star}</span>` : '';
      if (scope === 'stocks') {
        return `<td class="sbx-sticky">${starSpan}<span class="sbx-id"><b>${esc(r.ticker)}</b><small>${esc(r.name || '')}</small></span></td>`;
      }
      const sub = [r.symbol, r.kind].filter(Boolean).join(' · ');
      return `<td class="sbx-sticky">${starSpan}<span class="sbx-id"><b>${esc(r.name || r.key)}</b><small>${esc(sub)}</small></span></td>`;
    }

    function renderTable(res) {
      const box = part('table');
      if (!st.rows.length) {
        box.innerHTML = `<div class="sbx-empty">${esc(st.meta.message || 'No data loaded yet.')}</div>`;
        return;
      }
      if (!res.rows.length) {
        box.innerHTML = `<div class="sbx-empty">Nothing matches every condition. Remove or loosen a filter${st.filter.include_flagged ? '' : ', or include rows with data issues'}.</div>`;
        return;
      }
      const cols = shownCols().map(fieldDef);
      const head = headCell(ID_FIELD[scope], ID_LABEL[scope], 'Sort by ' + (scope === 'stocks' ? 'ticker' : 'name'))
        .replace('<th ', '<th class="sbx-sticky" ')
        + cols.map(f => headCell(f.key, colLabel(f), `${f.label}${f.unit && f.unit !== '/100' ? ` (${f.unit})` : ''}${f.help ? ' — ' + f.help : ''}`, !f.list)).join('')
        + headCell('_flags', 'Flags', 'Strategy flags; ⚠ = data issue', false);
      const body = res.rows.map(r => {
        const key = D.rowKey(r, scope);
        return `<tr data-sbx-key="${esc(key)}" tabindex="0"${D.dataOk(r) ? '' : ' class="sbx-flagged"'}>${idCell(r)}${cols.map(f =>
          `<td class="${f.type === 'text' || f.type === 'enum' ? 'sbx-l' : ''}">${cellHTML(f, r[f.key])}</td>`).join('')}<td class="sbx-l sbx-flags">${pillsHTML(r)}</td></tr>`;
      }).join('');
      box.innerHTML = `<table class="sbx-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
      if (typeof opts.bindStars === 'function') { try { opts.bindStars(box); } catch { /* caller's problem */ } }
    }

    let last = { rows: [], total: 0 };
    function render() {
      if (!st.alive) return;
      if (!ready()) {
        el.querySelectorAll('[data-sbx-part]').forEach(p => { p.innerHTML = ''; });
        part('table').innerHTML = '<div class="sbx-empty">The screener\'s field list (screen_fields.json) didn\'t load — reload the page to try again.</div>';
        return;
      }
      if (!st.filter) setFilterInternal(opts.filter || null) || setFilterInternal(null);
      last = D.evaluate(st.filter, st.rows);
      renderChips(); renderEditor(); renderCols();
      renderTools(last); renderCount(last); renderHidden(); renderTable(last);
    }

    function downloadCSV() {
      if (!st.trusted || !last.rows.length) return;
      const cols = (scope === 'stocks' ? ['ticker', 'name'] : ['key', 'name', 'symbol']).concat(shownCols().filter(k => !['ticker', 'name', 'key', 'symbol'].includes(k)));
      const csv = D.toCSV(last.rows, cols);
      try {
        const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        const a = document.createElement('a');
        a.href = url;
        a.download = `screen-${scope}${st.meta.asof ? '-' + String(st.meta.asof).replace(/[^0-9-]/g, '') : ''}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch { /* download blocked */ }
    }

    // ---- events (delegated on the root; namespaced data-sbx-* only) ----
    function onClick(e) {
      if (e.target.closest('[data-sbx-star]')) return;   // the star's own handler
      const a = e.target.closest('[data-sbx-act]');
      if (a && el.contains(a)) {
        const i = Number(a.dataset.sbxI);
        switch (a.dataset.sbxAct) {
          case 'add': openEditor(-1); return;
          case 'edit': openEditor(i); return;
          case 'rm': st.editor = null; change(f => { f.where.splice(i, 1); }); return;
          case 'rm-sort': change(f => { f.sort = null; }); return;
          case 'clear': st.editor = null; change(f => { f.where = []; }); return;
          case 'ed-cancel': st.editor = null; st.editorErr = ''; renderChips(); renderEditor(); return;
          case 'ed-apply': return applyEditor();
          case 'cols': st.colsOpen = !st.colsOpen; st.editor = null; renderChips(); renderEditor(); renderCols(); renderTools(last); return;
          case 'cols-done': st.colsOpen = false; renderCols(); renderTools(last); return;
          case 'cols-reset':
            st.cols = null; st.colsExplicit = false; lsSet(LS_COLS + scope, null);
            setFilterInternal(getFilter(), { fromUser: true }); render(); return;
          case 'csv': downloadCSV(); return;
        }
        return;
      }
      const th = e.target.closest('[data-sbx-sort]');
      if (th && el.contains(th)) return sortBy(th.dataset.sbxSort);
      const tr = e.target.closest('tr[data-sbx-key]');
      if (tr && el.contains(tr) && typeof opts.onOpen === 'function') { try { opts.onOpen(tr.dataset.sbxKey); } catch { /* caller's problem */ } }
    }
    function sortBy(k) {
      const f = fieldDef(k);
      if (!f || f.list) return;
      change(fl => {
        const s = fl.sort;
        if (s && s.field === k) fl.sort = { field: k, dir: s.dir === 'desc' ? 'asc' : 'desc' };
        else fl.sort = { field: k, dir: f.sort_default || (f.type === 'text' || f.type === 'enum' ? 'asc' : 'desc') };
      });
    }
    function applyEditor() {
      readEditor();
      const c = editorCond();
      if (typeof c === 'string') { st.editorErr = c; renderEditor(); return; }
      const i = st.editor.i;
      const errs = change(f => { if (i >= 0 && i < f.where.length) f.where[i] = c; else f.where.push(c); });
      if (errs) {
        // DSL errors read like "where[2].value: must be at least 0" — keep the part after the colon.
        st.editorErr = errs.map(x => String(x).replace(/^[^:]*:\s*/, '')).slice(0, 2).join('; ');
        renderEditor();
        return;
      }
      st.editor = null; st.editorErr = '';
      renderChips(); renderEditor();
    }
    function onChangeEv(e) {
      const t = e.target;
      if (!el.contains(t)) return;
      if (t.dataset.sbxCol) {
        const cur = baseCols().slice();
        const k = t.dataset.sbxCol;
        const next = t.checked ? (cur.includes(k) ? cur : cur.concat([k])) : cur.filter(x => x !== k);
        st.cols = next.slice(0, 20); st.colsExplicit = true;
        lsSet(LS_COLS + scope, JSON.stringify(st.cols));
        setFilterInternal(getFilter(), { fromUser: true });
        last = D.evaluate(st.filter, st.rows);
        renderCols(); renderTable(last);
        return;
      }
      const ed = t.dataset.sbxEd;
      if (ed === 'field' && st.editor) {
        readEditor();
        const f = fieldDef(t.value);
        if (!f) return;
        const prev = fieldDef(st.editor.field);
        st.editor.field = f.key;
        if (!prev || prev.type !== f.type || !!prev.list !== !!f.list) {
          // New kind of value: start empty, with the natural condition (P/E "at most", scores "at least").
          st.editor.value = null;
          st.editor.op = NUM_TYPES.has(f.type) ? (f.sort_default === 'asc' ? '<=' : '>=') : pickerOps(f)[0];
        }
        st.editorErr = ''; st.editor.focus = true;
        renderEditor();
      } else if (ed === 'op' && st.editor) {
        readEditor();
        const was = st.editor.op;
        const v = st.editor.value;
        st.editor.op = t.value;
        if (t.value === 'between' && was !== 'between') st.editor.value = [isNum(v) ? v : null, null];
        else if (was === 'between' && t.value !== 'between') st.editor.value = Array.isArray(v) ? v[0] : v;
        renderEditor();
      } else if (ed === 'limit') {
        const n = Number(t.value);
        change(f => { f.limit = n; });
      } else if (ed === 'flagged') {
        change(f => { f.include_flagged = !!t.checked; });
      }
    }
    function onKey(e) {
      const t = e.target;
      if (!el.contains(t)) return;
      if (st.editor && t.closest('[data-sbx-editor]')) {
        if (e.key === 'Enter' && t.tagName === 'INPUT' && t.type !== 'checkbox') { e.preventDefault(); applyEditor(); }
        else if (e.key === 'Escape') { e.stopPropagation(); st.editor = null; st.editorErr = ''; renderChips(); renderEditor(); }
        return;
      }
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const th = t.closest('[data-sbx-sort]');
      if (th) { e.preventDefault(); sortBy(th.dataset.sbxSort); return; }
      if (t.matches('tr[data-sbx-key]') && typeof opts.onOpen === 'function') { e.preventDefault(); try { opts.onOpen(t.dataset.sbxKey); } catch { /* caller's problem */ } }
    }
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChangeEv);
    el.addEventListener('keydown', onKey);

    render();

    return {
      setRows(rows, meta) {
        st.rows = Array.isArray(rows) ? rows : [];
        st.meta = meta && typeof meta === 'object' ? { asof: meta.asof || null, message: meta.message || null } : {};
        render();
      },
      setFilter(f) {
        st.editor = null; st.editorErr = '';
        // A filter without `columns` keeps the current column choice.
        const ok = setFilterInternal(f);
        render();
        return ok;
      },
      getFilter,
      // Matches for a filter over the current rows (the AI chat's confirm bar), or null.
      count(f) {
        if (!ready()) return null;
        const r = D.evaluate(f, st.rows);
        return r.errors ? null : r.total;
      },
      setTrusted(v) { st.trusted = !!v; if (ready() && st.filter) renderTools(last); },
      destroy() {
        st.alive = false;
        el.removeEventListener('click', onClick);
        el.removeEventListener('change', onChangeEv);
        el.removeEventListener('keydown', onKey);
        el.classList.remove('sbx');
        el.innerHTML = '';
      },
    };
  }

  return { mount };
})();
