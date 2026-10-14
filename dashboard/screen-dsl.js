// Screen DSL — the one filter language shared by the screener (browser), the AI screen
// builder (api/screen-builder.js, Node) and the Python jobs (engine/screens.py mirrors
// validate + evaluate). The field registry is dashboard/screen_fields.json; nothing here
// ever evals anything — a filter is plain data checked against that registry.
//
// UMD: assigns window.ScreenDSL in the browser (call ScreenDSL.load() once, it fetches
// screen_fields.json) and module.exports under Node (registry required at load). It
// declares no other global — app.js already owns ~60 top-level names.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./screen_fields.json'));
  else root.ScreenDSL = factory(null);
})(typeof self !== 'undefined' ? self : this, function (BUNDLED) {
  'use strict';

  const TOP_KEYS = new Set(['v', 'scope', 'where', 'sort', 'limit', 'include_flagged', 'columns']);
  const COND_KEYS = new Set(['field', 'op', 'value']);
  const SORT_KEYS = new Set(['field', 'dir']);
  const NUM_TYPES = new Set(['number', 'percent', 'money']);
  const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
  const OP_SYM = { '<': '<', '<=': '≤', '>': '>', '>=': '≥', '=': '=', '!=': '≠' };

  // Registry state. Maps (not plain objects) so '__proto__' / 'constructor' / 'toString'
  // can never pass a lookup (ADR-037: model output, saved screens and share links all
  // flow through validate()).
  let REG = null, L = null;
  let FIELDS = new Map(), TYPE_OPS = new Map(), ENUMS = new Map(), SCOPES = new Set(), RESERVED = new Set();
  let PRESETS = [];
  let readyPromise = null;

  const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isNum = x => typeof x === 'number' && isFinite(x);
  const clip = s => String(s).slice(0, 40);
  const numStr = n => String(n);

  function setRegistry(json) {
    if (!isObj(json) || !Array.isArray(json.fields)) throw new Error('ScreenDSL: bad registry');
    const fields = new Map(), typeOps = new Map(), enums = new Map();
    for (const k of Object.keys(json.type_ops || {})) typeOps.set(k, json.type_ops[k].slice());
    for (const f of json.fields) {
      fields.set(f.key, f);
      if (f.type === 'enum') {
        // lower-cased value or synonym -> canonical value (validate() is case-insensitive)
        const m = new Map();
        for (const v of f.enum) m.set(v.toLowerCase(), v);
        const syn = f.enum_synonyms || {};
        for (const v of f.enum) for (const s of (own(syn, v) ? syn[v] : [])) if (!m.has(s.toLowerCase())) m.set(s.toLowerCase(), v);
        enums.set(f.key, m);
      }
    }
    REG = json; L = json.limits; FIELDS = fields; TYPE_OPS = typeOps; ENUMS = enums;
    SCOPES = new Set(json.scopes); RESERVED = new Set(json.reserved_scopes || []);
    PRESETS = (json.presets || []).slice();
    return api;
  }

  // Browser: fetch the registry once. Node gets it via require() at module load.
  function load(url) {
    if (REG) return Promise.resolve(api);
    if (!readyPromise) {
      readyPromise = fetch(url || 'screen_fields.json')
        .then(r => { if (!r.ok) throw new Error('registry ' + r.status); return r.json(); })
        .then(setRegistry)
        .catch(e => { readyPromise = null; throw e; });
    }
    return readyPromise;
  }

  const opsFor = f => (f.list ? TYPE_OPS.get('list') : TYPE_OPS.get(f.type)) || [];

  function toNum(x) {
    if (typeof x === 'number') return isFinite(x) ? x : null;
    if (typeof x === 'string' && NUM_RE.test(x.trim())) return Number(x.trim());
    return null;
  }

  function boolish(v) {
    if (v === true || v === false) return v;
    if (v === 'true') return true;
    if (v === 'false') return false;
    return null;
  }

  function lev(a, b) {
    if (a === b) return 0;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }

  // The three valid values nearest to `s` (edit distance over value + synonyms), so a
  // rejected LLM answer names what it should have said.
  function closest(f, s) {
    const q = s.trim().toLowerCase();
    const syn = f.enum_synonyms || {};
    return f.enum.map((v, i) => {
      let d = lev(q, v.toLowerCase());
      for (const x of (own(syn, v) ? syn[v] : [])) d = Math.min(d, lev(q, x.toLowerCase()));
      return [d, i, v];
    }).sort((a, b) => a[0] - b[0] || a[1] - b[1]).slice(0, 3).map(x => x[2]);
  }

  function canon(f, s) {
    const m = ENUMS.get(f.key);
    const k = s.trim().toLowerCase();
    return m && m.has(k) ? m.get(k) : null;
  }

  function checkNum(f, n, p, errors) {
    if (f.min != null && n < f.min) { errors.push(`${p}: ${numStr(n)} is below the minimum ${numStr(f.min)} for ${f.short}`); return false; }
    if (f.max != null && n > f.max) { errors.push(`${p}: ${numStr(n)} is above the maximum ${numStr(f.max)} for ${f.short}`); return false; }
    return true;
  }

  function checkText(v, p, errors) {
    if (typeof v !== 'string') { errors.push(`${p}: must be a string`); return null; }
    const t = v.trim();
    if (!t.length) { errors.push(`${p}: must not be empty`); return null; }
    if (t.length > L.max_text_length) { errors.push(`${p}: at most ${L.max_text_length} characters`); return null; }
    return t;
  }

  function checkList(f, value, p, errors) {
    const arr = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(arr) || !arr.length) { errors.push(`${p}: must be a non-empty list`); return null; }
    if (arr.length > L.max_list_values) { errors.push(`${p}: at most ${L.max_list_values} values`); return null; }
    const out = [];
    let ok = true;
    arr.forEach((x, j) => {
      const pj = `${p}[${j}]`;
      let v = null;
      if (f.type === 'enum') {
        if (typeof x !== 'string') errors.push(`${pj}: must be a string`);
        else if ((v = canon(f, x)) === null) errors.push(`${pj}: '${clip(x)}' is not a valid ${f.short} (closest: ${closest(f, x).join(', ')})`);
      } else v = checkText(x, pj, errors);
      if (v === null) ok = false;
      else if (!out.includes(v)) out.push(v);
    });
    return ok ? out : null;
  }

  function checkCond(c, p, sc, errors) {
    if (!isObj(c)) { errors.push(`${p}: must be an object`); return null; }
    const bad = Object.keys(c).filter(k => !COND_KEYS.has(k));
    if (bad.length) { bad.forEach(k => errors.push(`${p}.${clip(k)}: unknown key`)); return null; }
    if (typeof c.field !== 'string') { errors.push(`${p}.field: must be a string`); return null; }
    const f = FIELDS.get(c.field);
    if (!f) { errors.push(`${p}.field: unknown field '${clip(c.field)}'`); return null; }
    if (!f.scopes.includes(sc)) { errors.push(`${p}.field: '${f.key}' is not available for ${sc}`); return null; }
    let op = c.op;
    let value = own(c, 'value') ? c.value : undefined;
    if (typeof op !== 'string') { errors.push(`${p}.op: must be a string`); return null; }
    if (f.type === 'bool' && (op === '=' || op === '!=')) {
      const b = boolish(value);
      if (b !== null) { op = (b === (op === '=')) ? 'is_true' : 'is_false'; value = undefined; }
    }
    const ops = opsFor(f);
    if (!ops.includes(op)) { errors.push(`${p}.op: '${clip(op)}' is not allowed for ${f.short} (use ${ops.join(', ')})`); return null; }
    const pv = `${p}.value`;
    if (f.type === 'bool') return { field: f.key, op };
    if (NUM_TYPES.has(f.type)) {
      if (op === 'between') {
        if (!Array.isArray(value) || value.length !== 2) { errors.push(`${pv}: between needs [low, high]`); return null; }
        const ns = value.map(toNum);
        if (ns[0] === null || ns[1] === null) { errors.push(`${pv}: between needs two numbers`); return null; }
        ns.sort((a, b) => a - b);
        if (!checkNum(f, ns[0], pv, errors) || !checkNum(f, ns[1], pv, errors)) return null;
        return { field: f.key, op, value: ns };
      }
      const n = toNum(value);
      if (n === null) { errors.push(`${pv}: must be a number`); return null; }
      return checkNum(f, n, pv, errors) ? { field: f.key, op, value: n } : null;
    }
    if (op === 'in' || op === 'not_in') {
      const vs = checkList(f, value, pv, errors);
      return vs === null ? null : { field: f.key, op, value: vs };
    }
    if (f.type === 'enum') {
      if (typeof value !== 'string') { errors.push(`${pv}: must be a string`); return null; }
      const v = canon(f, value);
      if (v === null) { errors.push(`${pv}: '${clip(value)}' is not a valid ${f.short} (closest: ${closest(f, value).join(', ')})`); return null; }
      return { field: f.key, op, value: v };
    }
    const t = checkText(value, pv, errors);
    return t === null ? null : { field: f.key, op, value: t };
  }

  // validate(filter, scope?) -> {ok, filter (normalised) | null, errors[]}. Never throws on
  // bad input; engine/screens.py produces the identical result for every parity vector.
  function validate(filter, scope) {
    const errors = [];
    if (!REG) return { ok: false, filter: null, errors: ['registry: not loaded'] };
    if (!isObj(filter)) return { ok: false, filter: null, errors: ['filter: must be an object'] };
    for (const k of Object.keys(filter)) if (!TOP_KEYS.has(k)) errors.push(`filter.${clip(k)}: unknown key`);
    if (own(filter, 'v') && filter.v !== 1) errors.push('filter.v: must be 1');

    let sc = own(filter, 'scope') ? filter.scope : null;
    if (sc === null || sc === undefined) sc = scope == null ? null : scope;
    else if (scope != null && sc !== scope) {
      errors.push(`filter.scope: '${clip(sc)}' does not match the requested scope '${clip(scope)}'`);
      return { ok: false, filter: null, errors };
    }
    if (typeof sc === 'string' && RESERVED.has(sc)) {
      errors.push(`filter.scope: '${sc}' is not available yet`);
      return { ok: false, filter: null, errors };
    }
    if (typeof sc !== 'string' || !SCOPES.has(sc)) {
      errors.push(`filter.scope: must be one of ${REG.scopes.join(', ')}`);
      return { ok: false, filter: null, errors };
    }

    let where = own(filter, 'where') ? filter.where : null;
    if (where === null || where === undefined) where = [];
    const outWhere = [];
    if (!Array.isArray(where)) errors.push('filter.where: must be a list');
    else {
      if (where.length > L.max_conditions) errors.push(`filter.where: at most ${L.max_conditions} conditions (got ${where.length})`);
      where.forEach((c, i) => { const r = checkCond(c, `where[${i}]`, sc, errors); if (r) outWhere.push(r); });
    }

    let outSort = null;
    const sort = own(filter, 'sort') ? filter.sort : null;
    if (sort !== null && sort !== undefined) {
      const n0 = errors.length;
      if (!isObj(sort)) errors.push('filter.sort: must be an object or null');
      else {
        for (const k of Object.keys(sort)) if (!SORT_KEYS.has(k)) errors.push(`filter.sort.${clip(k)}: unknown key`);
        const sf = sort.field;
        const f = typeof sf === 'string' ? FIELDS.get(sf) : undefined;
        if (typeof sf !== 'string') errors.push('filter.sort.field: must be a string');
        else if (!f) errors.push(`filter.sort.field: unknown field '${clip(sf)}'`);
        else if (!f.scopes.includes(sc)) errors.push(`filter.sort.field: '${f.key}' is not available for ${sc}`);
        else if (f.list) errors.push(`filter.sort.field: '${f.key}' cannot be sorted`);
        const dir = own(sort, 'dir') && sort.dir !== null && sort.dir !== undefined ? sort.dir : 'desc';
        if (dir !== 'asc' && dir !== 'desc') errors.push("filter.sort.dir: must be 'asc' or 'desc'");
        if (errors.length === n0) outSort = { field: sf, dir };
      }
    }

    let limit = L.limit_default;
    if (own(filter, 'limit') && filter.limit !== null && filter.limit !== undefined) {
      const n = toNum(filter.limit);
      if (n === null || !Number.isInteger(n) || n < L.limit_min || n > L.limit_max) {
        errors.push(`filter.limit: must be a whole number from ${L.limit_min} to ${L.limit_max}`);
      } else limit = n;
    }

    let flagged = false;
    if (own(filter, 'include_flagged') && filter.include_flagged !== null && filter.include_flagged !== undefined) {
      if (typeof filter.include_flagged !== 'boolean') errors.push('filter.include_flagged: must be true or false');
      else flagged = filter.include_flagged;
    }

    let columns = null;
    if (own(filter, 'columns') && filter.columns !== null && filter.columns !== undefined) {
      const cols = filter.columns;
      if (!Array.isArray(cols)) errors.push('filter.columns: must be a list of field keys');
      else if (cols.length > L.max_columns) errors.push(`filter.columns: at most ${L.max_columns} fields`);
      else {
        columns = [];
        cols.forEach((k, j) => {
          const f = typeof k === 'string' ? FIELDS.get(k) : undefined;
          if (!f) errors.push(`filter.columns[${j}]: unknown field '${clip(k)}'`);
          else if (!f.scopes.includes(sc)) errors.push(`filter.columns[${j}]: '${f.key}' is not available for ${sc}`);
          else if (!columns.includes(k)) columns.push(k);
        });
      }
    }

    if (errors.length) return { ok: false, filter: null, errors };
    const out = { v: 1, scope: sc, where: outWhere, sort: outSort, limit, include_flagged: flagged };
    if (columns) out.columns = columns;
    return { ok: true, filter: out, errors: [] };
  }

  // ---- evaluation ----
  // Markets have no data_ok column: it is (data_sane is not false), the same rule as
  // engine/screens.py. Stock snapshot rows carry their own data_ok.
  function dataOk(row) {
    if (own(row, 'data_ok') && typeof row.data_ok === 'boolean') return row.data_ok;
    return !(own(row, 'data_sane') && row.data_sane === false);
  }
  const getVal = (row, k) => k === 'data_ok' ? dataOk(row) : (own(row, k) ? row[k] : null);
  const rowKey = (row, scope) => (scope || 'stocks') === 'stocks' ? row.ticker : row.key;

  function test(c, row) {
    const f = FIELDS.get(c.field);
    const v = getVal(row, c.field);
    if (f.type === 'bool') return c.op === 'is_true' ? v === true : v === false;
    if (NUM_TYPES.has(f.type)) {
      if (!isNum(v)) return false;   // null / NaN / strings never match, not even '!='
      switch (c.op) {
        case '<': return v < c.value;
        case '<=': return v <= c.value;
        case '>': return v > c.value;
        case '>=': return v >= c.value;
        case '=': return v === c.value;
        case '!=': return v !== c.value;
        case 'between': return v >= c.value[0] && v <= c.value[1];
      }
      return false;
    }
    if (f.list) {
      const arr = Array.isArray(v) ? v : (typeof v === 'string' ? [v] : []);
      const q = c.value.toLowerCase();
      return arr.some(x => typeof x === 'string' && x.toLowerCase().includes(q));
    }
    if (typeof v !== 'string') return false;
    if (f.type === 'enum') {
      switch (c.op) {
        case '=': return v === c.value;
        case '!=': return v !== c.value;
        case 'in': return c.value.includes(v);
        case 'not_in': return !c.value.includes(v);
      }
      return false;
    }
    const lv = v.toLowerCase();
    switch (c.op) {
      case '=': return lv === c.value.toLowerCase();
      case '!=': return lv !== c.value.toLowerCase();
      case 'contains': return lv.includes(c.value.toLowerCase());
      case 'in': return c.value.some(x => x.toLowerCase() === lv);
      case 'not_in': return !c.value.some(x => x.toLowerCase() === lv);
    }
    return false;
  }

  function sortKey(f, v) {
    if (NUM_TYPES.has(f.type)) return isNum(v) ? v : null;
    if (f.type === 'bool') return typeof v === 'boolean' ? (v ? 1 : 0) : null;
    return typeof v === 'string' ? v.toLowerCase() : null;
  }

  // evaluate(filter, rows) -> {rows, total}: total = matches before the limit. Nulls sort
  // last in both directions; ties keep input order (stable, same as Python's sorted()).
  function evaluate(filter, rows) {
    const res = validate(filter);
    if (!res.ok) return { rows: [], total: 0, errors: res.errors };
    const fl = res.filter;
    const conds = fl.where.slice();
    if (!fl.include_flagged) conds.push({ field: 'data_ok', op: 'is_true' });
    let out = (Array.isArray(rows) ? rows : []).filter(r => isObj(r) && conds.every(c => test(c, r)));
    if (fl.sort) {
      const f = FIELDS.get(fl.sort.field), d = fl.sort.dir === 'desc' ? -1 : 1;
      out = out.map(r => [sortKey(f, getVal(r, f.key)), r]).sort((a, b) => {
        const x = a[0], y = b[0];
        if (x === null) return y === null ? 0 : 1;
        if (y === null) return -1;
        return x < y ? -d : x > y ? d : 0;
      }).map(p => p[1]);
    }
    return { rows: out.slice(0, fl.limit), total: out.length };
  }

  // ---- human-readable chips ----
  const trim = (v, d) => String(Number(Number(v).toFixed(d)));
  const fmtPct = v => trim(v * 100, 2) + '%';
  function fmtMoney(v) {
    const a = Math.abs(v);
    const [div, suf] = a >= 1e12 ? [1e12, 'T'] : a >= 1e9 ? [1e9, 'B'] : a >= 1e6 ? [1e6, 'M'] : [1, ''];
    return '$' + trim(v / div, 2) + suf;
  }
  function formatValue(f, v, withUnit = true) {
    if (typeof f === 'string') f = FIELDS.get(f);
    if (!f || v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '—';
    if (typeof v !== 'number') return Array.isArray(v) ? v.join(', ') : String(v);
    if (f.type === 'percent') return fmtPct(v) + (withUnit && f.unit ? ' ' + f.unit : '');
    if (f.type === 'money') return fmtMoney(v);
    return trim(v, 2) + (withUnit && f.unit === 'years' ? ' years' : '');
  }
  const windowText = y => y == null || !isFinite(y) ? 'long-run' : y >= 4.75 ? '5-year' : `${trim(y, 1)}-year`;
  function listText(vs) {
    return vs.length > 6 ? vs.slice(0, 5).join(', ') + ` +${vs.length - 5} more` : vs.join(', ');
  }

  function chip(c, opts) {
    const f = FIELDS.get(c.field);
    if (f.type === 'bool') return c.op === 'is_true' ? f.label : (f.label_false || `Not: ${f.label}`);
    if (f.key === 'discount_long' && c.op !== 'between' && c.op !== '=' && c.op !== '!=') {
      const w = windowText(opts && opts.longAvgYears);
      const v = c.value, below = c.op === '<' || c.op === '<=';
      if (below && v < 0) return `${c.op === '<=' ? '≥' : '>'}${fmtPct(-v)} below its ${w} average`;
      if (!below && v > 0) return `${c.op === '>=' ? '≥' : '>'}${fmtPct(v)} above its ${w} average`;
      if (v === 0) {
        const t = below ? 'below' : 'above';
        return c.op.length === 2 ? `At or ${t} its ${w} average` : `${t[0].toUpperCase()}${t.slice(1)} its ${w} average`;
      }
      return `vs ${w} average ${OP_SYM[c.op]} ${v > 0 ? '+' : ''}${fmtPct(v)}`;
    }
    if (NUM_TYPES.has(f.type)) {
      if (c.op === 'between') return `${f.short} ${formatValue(f, c.value[0], false)}–${formatValue(f, c.value[1])}`;
      return `${f.short} ${OP_SYM[c.op]} ${formatValue(f, c.value)}`;
    }
    if (f.list) return `${f.short} include "${c.value}"`;
    if (c.op === 'in') return `${f.short}: ${listText(c.value)}`;
    if (c.op === 'not_in') return `${f.short}: not ${listText(c.value)}`;
    if (f.type === 'enum') return c.op === '=' ? `${f.short}: ${c.value}` : `${f.short}: not ${c.value}`;
    if (c.op === 'contains') return `${f.short} contains "${c.value}"`;
    return `${f.short} ${OP_SYM[c.op]} "${c.value}"`;
  }

  // describe(filter, {longAvgYears}?) -> ["P/E ≤ 20", "Revenue up ≥ 80% of years", ...].
  // Pass longAvgYears when every matched row shares one window, so the chip can say
  // "2-year average" instead of the vaguer "long-run average".
  function describe(filter, opts) {
    const r = validate(filter);
    if (!r.ok) return [];
    const fl = r.filter;
    const out = fl.where.map(c => chip(c, opts));
    if (fl.sort) {
      const f = FIELDS.get(fl.sort.field);
      out.push(`Sorted by ${f.short} ${fl.sort.dir === 'desc' ? '↓' : '↑'}`);
    }
    if (fl.limit !== L.limit_default) out.push(`Top ${fl.limit}`);
    if (fl.include_flagged) out.push('Including rows with data issues');
    return out;
  }

  // diff(prev, next) -> {added, removed, changed} chips, for the AI chat's "+ / − / ~" view.
  function diff(prev, next) {
    const a = prev ? validate(prev) : { ok: false }, b = next ? validate(next) : { ok: false };
    const pa = a.ok ? a.filter : { where: [], sort: null, limit: L.limit_default };
    const pb = b.ok ? b.filter : { where: [], sort: null, limit: L.limit_default };
    const byField = w => w.reduce((m, c) => m.set(c.field, (m.get(c.field) || []).concat([JSON.stringify(c)])), new Map());
    const fa = byField(pa.where), fb = byField(pb.where);
    const out = { added: [], removed: [], changed: [] };
    for (const c of pb.where) {
      if (!fa.has(c.field)) out.added.push(chip(c));
      else if (fa.get(c.field).join('|') !== fb.get(c.field).join('|') && !fa.get(c.field).includes(JSON.stringify(c))) out.changed.push(chip(c));
    }
    for (const c of pa.where) if (!fb.has(c.field)) out.removed.push(chip(c));
    const sa = JSON.stringify(pa.sort), sb = JSON.stringify(pb.sort);
    if (sa !== sb) {
      if (!pb.sort) out.removed.push('Sort');
      else (pa.sort ? out.changed : out.added).push(`Sorted by ${FIELDS.get(pb.sort.field).short} ${pb.sort.dir === 'desc' ? '↓' : '↑'}`);
    }
    if (pa.limit !== pb.limit) out.changed.push(`Top ${pb.limit}`);
    return out;
  }

  // ---- growth guard (ADR-037) ----
  // "Growth" always means fundamentals. If a sentence talks about growth, the screen must
  // use at least one growth:true field and no price_signal field unless the sentence
  // names that price signal itself ("below its average", "turning up", "opportunity").
  // A price_signal field already in `current` (refine mode) is the user's earlier choice.
  const GROWTH_RE = /grow|growth|growing|compound|expanding/i;
  function growthGuard(sentence, filter, current) {
    let s = String(sentence || '').toLowerCase().replace(/[-_]/g, ' ');
    s = s.replace(/\b(?:remove|drop|delete|clear|without|no|not|ignore|forget|excluding|exclude)\s+(?:the\s+|any\s+)?(?:\w+\s+)?(?:grow\w*|growth|compound\w*|expanding)/g, ' ')
      .replace(/\bdividends?\s+grow\w*/g, ' ');
    if (!GROWTH_RE.test(s)) return { ok: true, reason: '' };
    const v = validate(filter);
    if (!v.ok) return { ok: false, reason: 'The screen is not valid.' };
    const fl = v.filter;
    const used = fl.where.map(c => c.field).concat(fl.sort ? [fl.sort.field] : []);
    if (!used.some(k => FIELDS.get(k).growth)) {
      return { ok: false, reason: 'The sentence asks for growth but the screen has no fundamental growth field (revenue or earnings record).' };
    }
    const cv = current ? validate(current) : { ok: false };
    const prior = new Set(cv.ok ? cv.filter.where.map(c => c.field).concat(cv.filter.sort ? [cv.filter.sort.field] : []) : []);
    for (const k of used) {
      const f = FIELDS.get(k);
      if (!f.price_signal || prior.has(k)) continue;
      const lex = (f.lexemes || []).concat(f.synonyms || []);
      if (!lex.some(x => s.includes(x.toLowerCase()))) {
        return { ok: false, reason: `${f.short} moves with the share price, so it can't stand in for growth (growth means revenue and earnings).` };
      }
    }
    return { ok: true, reason: '' };
  }

  // ---- deterministic sentence -> filter parser (no LLM; the free fallback) ----
  const NUM = String.raw`(\$?\s?-?\d+(?:\.\d+)?|-?\.\d+)\s*(%|percent|pct|trillion|tn|billion|bn|million|mn|thousand|[tbmkx])?(?![a-z0-9])`;
  const WORDNUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const YQ = String.raw`(?:(\d+(?:\.\d+)?|one|two|three|four|five|ten)\s*(?:y|yr|yrs|year|years)\s+)?`;
  const AVG_TAIL = String.raw`(?:(?:long\s+run|long\s+term|historical|historic|own|trailing)\s+)*(?:average|avg|mean)(?:\s+(?:price|close|level))?`;
  const AVG = String.raw`(?:(?:its|their|the|own|a)\s+)*` + YQ + AVG_TAIL;
  const COMPS = [
    ['less than or equal to', '<='], ['greater than or equal to', '>='], ['no more than', '<='], ['not more than', '<='],
    ['at most', '<='], ['up to', '<='], ['maximum', '<='], ['max', '<='], ['no less than', '>='], ['not less than', '>='],
    ['at least', '>='], ['minimum', '>='], ['min', '>='], ['less than', '<'], ['lower than', '<'], ['smaller than', '<'],
    ['fewer than', '<'], ['under', '<'], ['below', '<'], ['beneath', '<'], ['more than', '>'], ['greater than', '>'],
    ['higher than', '>'], ['bigger than', '>'], ['larger than', '>'], ['over', '>'], ['above', '>'], ['exceeding', '>'],
    ['exceeds', '>'], ['equal to', '='], ['equals', '='], ['<=', '<='], ['=<', '<='], ['>=', '>='], ['=>', '>='],
    ['<', '<'], ['>', '>'], ['==', '='], ['=', '=']];
  const COMP_MAP = new Map(COMPS);
  const STOP = new Set(('a an the and or & with without that which who whose where are is be been being have has having ' +
    'of in on at by for to from as into than then also only just please show me find give list get want need i we ' +
    'my our their its it them they those these this all any some each every one ones stocks stock companies company ' +
    'shares equities equity securities names markets market funds fund etfs etf indices index indexes countries ideas ' +
    'picks results screen screener filter filters look looking search trading trade trades currently now today good ' +
    'nice great very really quite solid decent like such not but more most less least still yet lots lot plenty ' +
    'should could would can will do does which ones there here what so too well businesses business also , . - + / $ % ' +
    'listed same keep plus add sector sectors industry industries space us instead rather').split(/\s+/));
  const AMBIGUOUS = new Set(['us', 'it', 'em', 'dm', 'hk', 'nz']);
  const AMBIG_NEXT = String.raw`(?=\s+(?:stocks?|companies|company|sector|sectors|names|listed|equities|shares|markets?|funds?|etfs?|tech|banks|exposure)(?![a-z0-9]))`;

  const esc = s => s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  const phraseRe = p => esc(p.toLowerCase()).replace(/\s+/g, String.raw`\s+`);
  const alt = list => list.slice().sort((a, b) => b.length - a.length).map(phraseRe).join('|');
  const W = (body, flags) => new RegExp(String.raw`(?<![a-z0-9])(?:` + body + String.raw`)(?![a-z0-9])`, flags || 'g');
  const yearsOf = t => t == null ? null : (own(WORDNUM, t) ? WORDNUM[t] : Number(t));

  function normalise(sentence) {
    return String(sentence == null ? '' : sentence).slice(0, 400).toLowerCase()
      .replace(/≤/g, ' <= ').replace(/≥/g, ' >= ').replace(/[‒-―−]/g, '-')
      .replace(/[‘’]/g, "'").replace(/'s(?![a-z])/g, '').replace(/'/g, '')
      .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
      .replace(/\bp\s*\/\s*(cf|e|b|s)\b/g, 'p/$1')
      .replace(/([a-z])-(?=[a-z0-9])/g, '$1 ').replace(/(\d)-(?=[a-z])/g, '$1 ')
      .replace(/[,;:!?()[\]{}"]/g, ' ').replace(/\.(?!\d)/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // ruleParse(sentence, scope, current?) -> {filter, unparsed[], notes[]}. With `current`
  // (a valid filter) it refines: conditions on a field the sentence mentions replace the
  // old ones, "remove/drop/without <field>" deletes, "sort by"/"top N" replace sort/limit.
  // Regexes use lookbehind (built at call time, so an engine without it only loses the
  // parser — the wrapper below — never the whole file).
  function ruleParse(sentence, scope, current) {
    try { return parseSentence(sentence, scope, current); }
    catch (e) {
      const v = current ? validate(current, scope) : validate({ v: 1, scope, where: [] }, scope);
      return { filter: v.ok ? v.filter : null, unparsed: [], notes: ["Couldn't read that sentence here; edit the filters directly."] };
    }
  }

  function parseSentence(sentence, scope, current) {
    const notes = [], unparsed = [];
    if (!REG) return { filter: null, unparsed: [], notes: ['registry: not loaded'] };
    if (!SCOPES.has(scope)) {
      const msg = RESERVED.has(scope) ? `The ${scope} screener is not available yet.` : `Unknown scope '${clip(scope)}'.`;
      const s0 = normalise(sentence);
      return { filter: null, unparsed: s0 ? [s0] : [], notes: [msg] };
    }
    const note = m => { if (!notes.includes(m)) notes.push(m); };
    let base = null;
    if (current) {
      const cv = validate(current, scope);
      if (cv.ok) base = cv.filter;
      else note('Started a new screen: the current one is not valid for this scope.');
    }
    const original = String(sentence == null ? '' : sentence);
    const st = { s: normalise(sentence) };
    const adds = [], removes = new Set();
    let removeGrowth = false, removeSort = false, removeLimit = false, reset = false;
    let sort, limit, flagged, autoSort = null;
    const scopeFields = REG.fields.filter(f => f.scopes.includes(scope));
    const has = k => FIELDS.has(k) && FIELDS.get(k).scopes.includes(scope);
    const isStocks = scope === 'stocks';

    // Replace a consumed span with \0 so later rules cannot re-read it and the leftover
    // scan can tell consumed text from real gaps.
    function take(re, fn) {
      const ms = [...st.s.matchAll(re)];
      const keep = [];
      for (const m of ms) if (fn(m) !== false) keep.push(m);
      for (const m of keep.reverse()) {
        st.s = st.s.slice(0, m.index) + '\0'.repeat(m[0].length) + st.s.slice(m.index + m[0].length);
      }
    }
    function addCond(c, phrase) {
      const errs = [];
      const r = checkCond(c, 'where', scope, errs);
      if (!r) { if (phrase) unparsed.push(phrase.trim()); note(`Couldn't use "${(phrase || c.field).trim()}": ${errs[0] || 'invalid'}.`); return false; }
      if (!adds.some(x => JSON.stringify(x) === JSON.stringify(r))) adds.push(r);
      return true;
    }
    function toValue(f, numText, unit, phrase) {
      let v = parseFloat(numText.replace(/[$\s]/g, ''));
      const u = (unit || '').toLowerCase();
      const pctUnit = u === '%' || u === 'percent' || u === 'pct';
      const mult = { t: 1e12, tn: 1e12, trillion: 1e12, b: 1e9, bn: 1e9, billion: 1e9, m: 1e6, mn: 1e6, million: 1e6, k: 1e3, thousand: 1e3 }[u];
      if (f.type === 'percent') {
        if (pctUnit) v = v / 100;
        else if (Math.abs(v) > 1) { note(`Read "${phrase.trim()}" as ${trim(v, 2)}%.`); v = v / 100; }
      } else if (f.type === 'money') {
        if (mult) v = v * mult;
        else if (f.key === 'market_cap' && Math.abs(v) < 1e4) { note(`Read "${phrase.trim()}" as $${trim(v, 2)}B.`); v = v * 1e9; }
      }
      return Number(v.toPrecision(12));
    }

    // Field phrases for this scope (synonyms + key spelled out), longest first.
    const phraseField = new Map();
    for (const f of scopeFields) {
      for (const p of (f.synonyms || []).concat([f.key.replace(/_/g, ' '), f.key])) {
        const k = p.toLowerCase();
        if (!phraseField.has(k)) phraseField.set(k, f.key);
      }
    }
    const numPhrases = [...phraseField].filter(([, k]) => NUM_TYPES.has(FIELDS.get(k).type)).map(([p]) => p);
    const anyPhrases = [...phraseField].filter(([, k]) => !FIELDS.get(k).list).map(([p]) => p);
    const fieldOf = p => phraseField.get(p.replace(/\s+/g, ' '));
    const NF = alt(numPhrases), COMP = alt(COMPS.map(c => c[0]));
    const SORT_ALIAS = new Map([['growth', 'growth_score'], ['fundamental growth', 'growth_score'], ['value', 'value_score'],
      ['valuation', 'value_score'], ['cheapness', 'value_score'], ['yield', 'dividend_yield'], ['size', 'market_cap'],
      ['discount', 'discount_long'], ['quality', 'consistency_score']].filter(([, k]) => has(k)));
    const sortPhrases = anyPhrases.concat([...SORT_ALIAS.keys()]);
    const sortFieldOf = p => SORT_ALIAS.get(p.replace(/\s+/g, ' ')) || fieldOf(p);
    const SF = alt(sortPhrases);

    // 0. start over / include flagged rows
    take(W(String.raw`start\s+over|reset|clear\s+all|clear\s+everything|new\s+screen|from\s+scratch`), () => { reset = true; });
    take(W(String.raw`(?:includ(?:e|ing)|incl|show(?:ing)?|with)\s+(?:the\s+)?(?:flagged|excluded|hidden|everything|all\s+rows|foreign\s+listings?|data\s+issues)(?:\s+(?:rows|stocks|ones))?|show\s+all`), () => { flagged = true; });
    take(W(String.raw`(?:exclud(?:e|ing)|hide|hiding|without)\s+(?:the\s+)?(?:flagged|data\s+issues)(?:\s+(?:rows|stocks|ones))?`), () => { flagged = false; });

    // 1. refine: remove / drop <field>
    const GROUP_ALIAS = new Map([['growth', 'growth'], ['growth filters', 'growth'], ['sort', 'sort'], ['sorting', 'sort'],
      ['order', 'sort'], ['ordering', 'sort'], ['limit', 'limit'], ['top n', 'limit'], ['average', 'avg'],
      ['long run average', 'avg'], ['discount', 'discount_long']]);
    const enumWordField = new Map();   // enum value words -> field, for "drop tech"
    for (const f of scopeFields) if (f.type === 'enum') for (const [w] of ENUMS.get(f.key)) if (!enumWordField.has(w)) enumWordField.set(w, f.key);
    if (!isStocks && FIELDS.has('sector')) for (const [w] of ENUMS.get('sector')) if (!enumWordField.has(w)) enumWordField.set(w, 'sector_hint');
    const RT = alt(anyPhrases.concat([...GROUP_ALIAS.keys()], [...enumWordField.keys()].filter(w => !AMBIGUOUS.has(w))));
    // What a removal phrase points at: field keys and/or the growth group / sort / limit.
    const targetOf = p => {
      const k = p.replace(/\s+/g, ' ');
      const g = GROUP_ALIAS.get(k);
      if (g === 'growth' || g === 'sort' || g === 'limit') return { fields: [], what: g };
      if (g === 'avg') return { fields: ['discount_long', 'long_avg_years'] };
      if (g) return { fields: [g] };
      if (phraseField.has(k)) return { fields: [phraseField.get(k)] };
      if (enumWordField.get(k) === 'sector_hint') return { fields: ['kind', 'name'] };
      return { fields: enumWordField.has(k) ? [enumWordField.get(k)] : [] };
    };
    const applyTarget = t => {
      t.fields.forEach(k => removes.add(k));
      if (t.what === 'growth') removeGrowth = true;
      if (t.what === 'sort') removeSort = true;
      if (t.what === 'limit') removeLimit = true;
    };
    const removeTarget = p => applyTarget(targetOf(p));
    take(W(String.raw`(?:remove|drop|delete|clear|forget|ignore|undo|cancel|get\s+rid\s+of|no\s+longer\s+(?:filter\s+(?:by|on)|require|need))\s+(?:the\s+)?(?:filter\s+(?:on|for)\s+)?(` + RT + String.raw`)(?:\s+(?:filter|filters|condition|conditions|criteria|criterion|requirement|rule))?`), m => removeTarget(m[1]));

    // 2. long-run average / discount phrases (price position — never growth)
    let years = null;
    const noteYears = y => {
      if (y == null) return;
      years = Math.max(years || 0, y);
    };
    take(W(String.raw`(?:(?:at\s+least|by\s+at\s+least|more\s+than|over|by)\s+)?` + NUM + String.raw`\s+(?:or\s+more\s+)?(below|under|beneath|off|above|over)\s+` + AVG), m => {
      const f = FIELDS.get('discount_long');
      if (!has('discount_long')) return false;
      let v = Math.abs(toValue(f, m[1], m[2] || '%', m[0]));
      const below = !/above|over/.test(m[3]);
      addCond({ field: 'discount_long', op: below ? '<=' : '>=', value: below ? -v : v }, m[0]);
      noteYears(yearsOf(m[4]));
    });
    take(W(String.raw`(?:(?:trading|priced|trades|is|are|sitting|still)\s+)?(below|under|beneath|above|over)\s+` + AVG), m => {
      if (!has('discount_long')) return false;
      const below = !/above|over/.test(m[1]);
      addCond({ field: 'discount_long', op: below ? '<' : '>', value: 0 }, m[0]);
      noteYears(yearsOf(m[2]));
    });
    take(W(String.raw`(?:cheap|cheaper|discounted|on\s+sale)\s+(?:vs|versus|relative\s+to|compared\s+(?:to|with))\s+(?:(?:its|their|the|own)\s+)*` + YQ + String.raw`(?:(?:long\s+run|long\s+term|historical|historic|own)\s+)*(?:average|avg|mean|history)(?:\s+price)?`), m => {
      if (!has('discount_long')) return false;
      addCond({ field: 'discount_long', op: '<', value: 0 }, m[0]);
      noteYears(yearsOf(m[1]));
    });
    take(W(String.raw`(?:a\s+)?discount\s+(?:of\s+)?(?:at\s+least\s+|over\s+|more\s+than\s+)?` + NUM + '|' + NUM + String.raw`\s+(?:or\s+more\s+)?discount`), m => {
      if (!has('discount_long')) return false;
      const n = m[1] !== undefined ? [m[1], m[2]] : [m[3], m[4]];
      const v = Math.abs(toValue(FIELDS.get('discount_long'), n[0], n[1] || '%', m[0]));
      addCond({ field: 'discount_long', op: '<=', value: -v }, m[0]);
    });
    take(W(String.raw`at\s+a\s+discount(?:\s+to\s+` + AVG + ')?'), m => {
      if (!has('discount_long')) return false;
      addCond({ field: 'discount_long', op: '<', value: 0 }, m[0]);
      noteYears(yearsOf(m[1]));
    });
    // Never drop a year qualifier silently: "5 year average" anywhere keeps its window.
    const ym = st.s.match(new RegExp(String.raw`(?<![a-z0-9])(\d+(?:\.\d+)?|one|two|three|four|five|ten)\s*(?:y|yr|yrs|year|years)\s+(?:[a-z]+\s+)?(?:average|avg|mean)(?![a-z0-9])`));
    if (ym && years == null && has('long_avg_years')) {
      noteYears(yearsOf(ym[1]));
      take(W(esc(ym[0])), () => {});
    }
    if (years != null && has('long_avg_years')) {
      addCond({ field: 'long_avg_years', op: '>=', value: years });
      if (isStocks && years > 2) note(`Stock prices cover about 2 years so far; ${trim(years, 1)}-year averages exist only for markets, so no stock matches the "${trim(years, 1)}-year" condition until more price history is on file.`);
      else if (!isStocks && years > 5) note('Market averages cover at most 5 years.');
    }

    // 3. numeric comparisons: ranges first, then "<field> <comp> <n>", "<field> <n> or more",
    //    "<comp> <n> <field>"
    take(W(String.raw`(` + NF + String.raw`)(?:\s+(?:is|are|ratio|of))*\s+(?:between|from|of)?\s*` + NUM + String.raw`\s*(?:-|to|and)\s*` + NUM), m => {
      const f = FIELDS.get(fieldOf(m[1]));
      const pct = /%|percent|pct/.test((m[3] || '') + (m[5] || '')) ? '%' : '';
      const u1 = m[3] || (pct || m[5]), u2 = m[5] || (pct || m[3]);
      addCond({ field: f.key, op: 'between', value: [toValue(f, m[2], u1, m[0]), toValue(f, m[4], u2, m[0])] }, m[0]);
    });
    take(W(String.raw`(` + NF + String.raw`)(?:\s+(?:is|are|ratio|of|in|that\s+is|which\s+is|being|be))*\s*(` + COMP + String.raw`)\s*` + NUM + String.raw`(?:\s+of\s+(?:the\s+)?(?:years|time))?`), m => {
      const f = FIELDS.get(fieldOf(m[1]));
      addCond({ field: f.key, op: COMP_MAP.get(m[2].replace(/\s+/g, ' ')), value: toValue(f, m[3], m[4], m[0]) }, m[0]);
    });
    take(W(String.raw`(` + NF + String.raw`)\s+(?:of\s+)?` + NUM + String.raw`\s*(or\s+more|or\s+higher|or\s+above|or\s+greater|\+|or\s+less|or\s+lower|or\s+below|or\s+under)`), m => {
      const f = FIELDS.get(fieldOf(m[1]));
      addCond({ field: f.key, op: /more|higher|above|greater|\+/.test(m[4]) ? '>=' : '<=', value: toValue(f, m[2], m[3], m[0]) }, m[0]);
    });
    take(W(String.raw`(` + COMP + String.raw`)\s*` + NUM + String.raw`\s+(?:of\s+|in\s+)?(` + NF + ')'), m => {
      const f = FIELDS.get(fieldOf(m[4]));
      addCond({ field: f.key, op: COMP_MAP.get(m[1].replace(/\s+/g, ' ')), value: toValue(f, m[2], m[3], m[0]) }, m[0]);
    });

    // 4. sort / top N
    const setSort = (k, dir) => { sort = { field: k, dir: dir || FIELDS.get(k).sort_default || (k === 'discount_long' ? 'asc' : 'desc') }; };
    take(W(String.raw`(?:sort(?:ed)?|order(?:ed)?|rank(?:ed)?)\s+(?:them\s+|it\s+|results\s+)?by\s+(?:the\s+)?(?:(lowest|highest|smallest|largest|biggest|best)\s+)?(` + SF + String.raw`)(?:\s+(asc(?:ending)?|desc(?:ending)?|lowest\s+first|highest\s+first|low\s+to\s+high|high\s+to\s+low|smallest\s+first|largest\s+first|biggest\s+first))?`), m => {
      const k = sortFieldOf(m[2]);
      const d = m[3] || m[1] || '';
      setSort(k, /asc|lowest|low\s+to|smallest/.test(d) ? 'asc' : /desc|highest|high\s+to|largest|biggest|best/.test(d) ? 'desc' : null);
    });
    take(W(String.raw`(?:top|first|best|limit(?:\s+to)?|show(?:\s+me)?(?:\s+the)?(?:\s+top)?)\s+(\d{1,4})(?![.%])`), m => {
      const n = Number(m[1]);
      if (!n) return false;
      if (n > L.limit_max) note(`Showing at most ${L.limit_max} rows.`);
      limit = Math.min(n, L.limit_max);
    });
    take(W(String.raw`(\d{1,4})(?=\s+(?:stocks|companies|names|markets|results|countries|sectors|ideas|picks)(?![a-z0-9]))`), m => {
      const n = Number(m[1]);
      if (!n || limit !== undefined) return false;
      limit = Math.min(n, L.limit_max);
    });
    take(W(String.raw`(lowest|highest|smallest|largest|biggest|cheapest)\s+(?:by\s+)?(` + SF + ')'), m => {
      setSort(sortFieldOf(m[2]), /lowest|smallest|cheapest/.test(m[1]) ? 'asc' : 'desc');
    });
    take(W(String.raw`cheapest|most\s+undervalued|best\s+value`), () => setSort('value_score', 'desc'));
    if (isStocks) take(W(String.raw`(?:biggest|largest)(?=\s+(?:companies|stocks|names))`), () => setSort('market_cap', 'desc'));
    take(W(String.raw`by\s+(` + SF + ')'), m => { if (sort) return false; setSort(sortFieldOf(m[1])); });

    // 5. yes/no flags ("on sale", "no value traps", "steady compounders")
    const boolPhrases = new Map();
    for (const f of scopeFields) if (f.type === 'bool') for (const p of f.synonyms || []) if (!boolPhrases.has(p)) boolPhrases.set(p, f.key);
    const BP = alt([...boolPhrases.keys()]);
    const boolOf = p => boolPhrases.get(p.replace(/\s+/g, ' '));
    if (BP) {
      take(W(String.raw`(?:not|no|non|excluding|exclude|without|avoid(?:ing)?|except|skip|never)\s+(?:a\s+|an\s+|any\s+|the\s+)?(` + BP + ')'), m => {
        addCond({ field: boolOf(m[1]), op: 'is_false' }, m[0]);
      });
    }
    // "without <field>" removes a condition only when the current screen has one on it
    // ("without dividends" on a fresh screen means no dividend, handled below).
    take(W(String.raw`without\s+(?:the\s+|any\s+)?(` + RT + ')'), m => {
      const t = targetOf(m[1]);
      const hit = base && (base.where.some(c => t.fields.includes(c.field)
        || (t.what === 'growth' && FIELDS.get(c.field).growth)) || (t.what === 'sort' && base.sort) || t.what === 'limit');
      if (!hit) return false;
      applyTarget(t);
    });
    if (BP) take(W('(' + BP + ')'), m => { addCond({ field: boolOf(m[1]), op: 'is_true' }, m[0]); });

    // 6. growth — FUNDAMENTALS only (revenue/earnings record), never price
    const revField = isStocks ? 'rev_cagr' : 'rev_growth', niField = isStocks ? 'ni_cagr' : 'earnings_growth';
    take(W(String.raw`dividends?\s+(?:growth|growers?|growing)`), m => {
      unparsed.push(m[0]);
      note("Dividend growth history isn't a screen field yet.");
    });
    take(W(String.raw`not\s+growing|shrinking|declining|contracting|(?:falling|declining|shrinking)\s+(?:revenue|sales|earnings|profits?)`), m => {
      addCond({ field: /earn|profit/.test(m[0]) ? niField : revField, op: '<', value: 0 }, m[0]);
    });
    take(W(String.raw`(revenue|sales|top\s+line|earnings|profits?|net\s+income)\s+(?:is\s+|are\s+|has\s+been\s+|have\s+been\s+)?(?:growing|growth|rising|increasing|up|expanding)|(?:growing|rising|increasing|expanding)\s+(revenue|sales|top\s+line|earnings|profits?|net\s+income)`), m => {
      const w = m[1] || m[2];
      addCond({ field: /earn|profit|income/.test(w) ? niField : revField, op: '>', value: 0 }, m[0]);
    });
    take(W(String.raw`(?:(fastest|faster|fast|rapidly|quickly|quick|high|higher|strong|strongly|consistent(?:ly)?|steady|steadily|reliabl[ey]|stable)\s+)?(?:growing|growth|growers?|grew|expanding|compounding)(?:\s+(?:stocks|companies|names|markets|businesses|record))?`), m => {
      const q = m[1] || '';
      if (/consist|stead|reliab|stable/.test(q)) {
        if (isStocks) addCond({ field: 'rev_up_ratio', op: '>=', value: 0.8 }, m[0]);
        else { addCond({ field: 'growth_score', op: '>=', value: 60 }, m[0]); note('Markets have no multi-year growth record; used the growth score instead.'); }
        return;
      }
      if (isStocks) {
        addCond({ field: 'rev_cagr', op: '>', value: 0 }, m[0]);
        addCond({ field: 'ni_cagr', op: '>', value: 0 }, m[0]);
      } else addCond({ field: 'growth_score', op: '>=', value: 60 }, m[0]);
      if (/fast(?!est)|rapid|quick|high|strong/.test(q)) addCond({ field: 'growth_score', op: '>=', value: 75 }, m[0]);
      if (/fastest/.test(q)) setSort('growth_score', 'desc');
      else autoSort = autoSort || { field: 'growth_score', dir: 'desc' };
    });

    // 7. value / profitability / size / dividends
    take(W(String.raw`not\s+(?:too\s+|very\s+)?(?:expensive|overvalued|pricey)`), m => { addCond({ field: 'value_score', op: '>', value: 33 }, m[0]); });
    take(W(String.raw`expensive|overvalued|over\s+valued|pricey|rich\s+valuations?`), m => { addCond({ field: 'value_score', op: '<=', value: 33 }, m[0]); });
    take(W(String.raw`cheap|cheaper|undervalued|under\s+valued|inexpensive|bargains?|good\s+value|great\s+value|value\s+stocks|value\s+plays?|low\s+valuations?|attractively\s+valued|value`), m => {
      addCond({ field: 'value_score', op: '>=', value: 70 }, m[0]);
    });
    take(W(String.raw`unprofitable|loss\s+making|losing\s+money|money\s+losing`), m => {
      if (isStocks) addCond({ field: 'ni_pos_ratio', op: '<', value: 0.5 }, m[0]);
      else { unparsed.push(m[0]); note('Markets have no profitability record field.'); }
    });
    take(W(String.raw`(?:consistently\s+)?(?:profitable|profit\s+making|money\s+making|making\s+money|positive\s+earnings|in\s+the\s+black)`), m => {
      if (isStocks) addCond({ field: 'ni_pos_ratio', op: '>=', value: 0.8 }, m[0]);
      else addCond({ field: 'pe', op: '>', value: 0 }, m[0]);
    });
    take(W(String.raw`(mega|large|big|mid|medium|small|micro|nano)\s*caps?`), m => {
      if (!isStocks) { unparsed.push(m[0]); note('Market cap applies to stocks only.'); return; }
      const t = m[1];
      if (t === 'mega') addCond({ field: 'market_cap', op: '>=', value: 2e11 }, m[0]);
      else if (t === 'large' || t === 'big') addCond({ field: 'market_cap', op: '>=', value: 1e10 }, m[0]);
      else if (t === 'mid' || t === 'medium') addCond({ field: 'market_cap', op: 'between', value: [2e9, 1e10] }, m[0]);
      else if (t === 'small') addCond({ field: 'market_cap', op: 'between', value: [3e8, 2e9] }, m[0]);
      else {
        addCond({ field: 'market_cap', op: '<', value: 3e8 }, m[0]);
        note('Companies under $300M are hidden by the data checks; say "include flagged" to see them.');
      }
    });
    take(W(String.raw`(?:no|non|zero|without)\s+dividends?|non\s+dividend\s+paying|(?:doesnt|dont|do\s+not|does\s+not)\s+pay\s+(?:a\s+)?dividends?`), m => {
      addCond({ field: 'dividend_yield', op: '<=', value: 0 }, m[0]);
    });
    take(W(String.raw`(?:high|higher|big|juicy|strong|generous|good)\s+(?:dividend\s+yields?|dividends?|yields?|income)|high\s+yield(?:ing)?`), m => {
      addCond({ field: 'dividend_yield', op: '>=', value: isStocks ? 0.04 : 0.03 }, m[0]);
    });
    take(W(String.raw`dividend\s+(?:payers?|paying|stocks)|pays?\s+(?:a\s+)?dividends?|paying\s+(?:a\s+)?dividends?|with\s+(?:a\s+)?dividends?|income\s+stocks|dividends?`), m => {
      addCond({ field: 'dividend_yield', op: '>', value: 0 }, m[0]);
    });

    // 8. price-only ideas are not screen fields — say so instead of guessing
    take(W(String.raw`price\s+momentum|momentum|(?:price\s+|stock\s+|total\s+)?returns?|performance|(?:top\s+|best\s+)?performers?|gainers|winners|losers|trending|52\s*week\s+(?:highs?|lows?)|all\s+time\s+highs?|breakouts?|rsi|moving\s+averages?|technicals?|charts?`), m => {
      unparsed.push(m[0].trim());
      note('Price momentum and returns are not screen fields — growth here always means revenue and earnings.');
    });

    // 9. classification words: sectors, countries, regions, development, market type
    const pos = new Map(), neg = new Map();
    const push = (mp, k, v) => { if (!mp.has(k)) mp.set(k, []); if (!mp.get(k).includes(v)) mp.get(k).push(v); };
    const enumFields = isStocks ? ['sector', 'country'] : ['region', 'development', 'kind', 'sector', 'country'];
    const words = new Map();   // phrase -> [field, value]
    for (const k of enumFields) {
      // sector is stocks-only, but in markets its words still find sector funds by name
      if (!FIELDS.has(k) || (!has(k) && k !== 'sector')) continue;
      for (const [w, v] of ENUMS.get(k)) {
        if (isStocks && k === 'country' && (v === 'Europe' || v === 'Regional' || v === 'Global')) continue;
        if (!words.has(w)) words.set(w, [k, v]);
      }
    }
    const plain = [...words.keys()].filter(w => !AMBIGUOUS.has(w));
    const ambig = [...words.keys()].filter(w => AMBIGUOUS.has(w));
    const NEG = String.raw`(?:(not|no|non|ex|excluding|exclude|except|without|outside(?:\s+of)?|other\s+than)\s+(?:the\s+)?)?`;
    let hint = null;
    const onEnum = (negWord, phrase) => {
      const [k, v] = words.get(phrase.replace(/\s+/g, ' '));
      if (k === 'sector' && !isStocks) {
        if (negWord) { unparsed.push(`${negWord} ${phrase}`); note("Markets can't exclude a sector by name."); return; }
        push(pos, 'kind', 'Sector');
        const h = (FIELDS.get('sector').market_name_hint || {})[v];
        if (!h) { unparsed.push(phrase); return; }
        if (hint && hint !== h) note(`Markets match one sector name at a time; used "${hint}".`);
        else hint = h;
        return;
      }
      push(negWord ? neg : pos, k, v);
    };
    take(W(String.raw`international|foreign|overseas|non\s+us|ex\s+us|outside\s+(?:of\s+)?(?:the\s+)?us|non\s+american`), () => {
      push(neg, 'country', 'United States');
      if (isStocks) note('Foreign listings are hidden by the data checks (ADR-ratio-distorted P/E); say "include flagged" to see them.');
    });
    if (ambig.length) {
      take(new RegExp(String.raw`(?<![a-z0-9])` + NEG + '(' + alt(ambig) + ')' + AMBIG_NEXT, 'g'), m => onEnum(m[1], m[2]));
      // An upper-case "US" / "IT" in the original sentence is unambiguous on its own.
      for (const w of ambig) {
        if (new RegExp(String.raw`(?<![A-Za-z0-9])` + w.toUpperCase() + String.raw`(?![A-Za-z0-9])`).test(original)) {
          take(W(NEG + '(' + phraseRe(w) + ')'), m => onEnum(m[1], m[2]));
        }
      }
    }
    if (plain.length) take(W(NEG + '(' + alt(plain) + ')'), m => onEnum(m[1], m[2]));
    if (isStocks) {
      take(W(String.raw`europe|european|asia|asian|asia\s+pacific|latin\s+america|latin\s+american|latam|africa|african|middle\s+east|middle\s+eastern|emerging\s+markets?|developed\s+markets?|frontier\s+markets?`), m => {
        unparsed.push(m[0]);
        note("Regions apply to markets; for stocks name the countries (e.g. 'UK, France').");
      });
    }
    for (const [k, vs] of pos) addCond({ field: k, op: 'in', value: vs });
    for (const [k, vs] of neg) addCond({ field: k, op: 'not_in', value: vs });
    if (hint) addCond({ field: 'name', op: 'contains', value: hint });

    // 10. whatever is left, minus filler words, is reported back as unparsed
    for (const seg of st.s.split(/\0+/)) {
      let run = [];
      const flush = () => { if (run.length) unparsed.push(run.join(' ')); run = []; };
      for (const t of seg.split(/\s+/)) {
        if (!t || STOP.has(t) || !/[a-z0-9]/.test(t)) flush();
        else run.push(t);
      }
      flush();
    }

    // assemble: refine mode replaces conditions on fields the sentence touched
    if (reset) base = null;
    const removed = new Set(removes);
    if (removed.size || removeGrowth || removeSort || removeLimit) {
      if (!base) note('Nothing to remove — there is no current screen.');
    }
    const touched = new Set(adds.map(c => c.field));
    const kept = base ? base.where.filter(c => !touched.has(c.field) && !removed.has(c.field) && !(removeGrowth && FIELDS.get(c.field).growth)) : [];
    let where = kept.concat(adds);
    if (where.length > L.max_conditions) {
      note(`Kept the first ${L.max_conditions} conditions.`);
      where = where.slice(0, L.max_conditions);
    }
    let finalSort = sort !== undefined ? sort : (removeSort ? null : (base ? base.sort : null));
    if (finalSort && removeGrowth && FIELDS.get(finalSort.field).growth && sort === undefined) finalSort = null;
    if (!finalSort && !removeSort && autoSort) finalSort = autoSort;
    const out = {
      v: 1, scope, where, sort: finalSort,
      limit: limit !== undefined ? limit : (removeLimit || !base ? L.limit_default : base.limit),
      include_flagged: flagged !== undefined ? flagged : (base ? base.include_flagged : false),
    };
    if (base && base.columns) out.columns = base.columns;
    let res = validate(out, scope);
    if (!res.ok) {
      note('Some conditions could not be combined: ' + res.errors[0]);
      res = validate(base || { v: 1, scope, where: [] }, scope);
    }
    const guard = growthGuard(sentence, res.filter, base);
    if (!guard.ok) note(guard.reason);
    return { filter: res.filter, unparsed: [...new Set(unparsed.filter(Boolean).map(u => u.slice(0, 80)))].slice(0, 10), notes };
  }

  // ---- registry accessors / small helpers for the UI ----
  const field = k => (typeof k === 'string' && FIELDS.has(k) ? FIELDS.get(k) : null);
  const fields = scope => REG ? REG.groups.flatMap(g => REG.fields.filter(f => f.group === g && (!scope || f.scopes.includes(scope)))) : [];
  const presets = scope => PRESETS.filter(p => !scope || p.scope === scope);
  const opsOf = k => { const f = field(k); return f ? opsFor(f).slice() : []; };

  // Share links carry only a validated filter, base64url-encoded (never a sentence).
  function encodeFilter(filter) {
    const r = validate(filter);
    if (!r.ok) return null;
    const json = JSON.stringify(r.filter);
    const b64 = typeof Buffer !== 'undefined' ? Buffer.from(json, 'utf8').toString('base64')
      : btoa(unescape(encodeURIComponent(json)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function decodeFilter(s, scope) {
    try {
      if (typeof s !== 'string' || s.length > 12000 || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad');
      const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
      const json = typeof Buffer !== 'undefined' ? Buffer.from(b64, 'base64').toString('utf8')
        : decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4))));
      return validate(JSON.parse(json), scope);
    } catch (e) {
      return { ok: false, filter: null, errors: ['filter: not a valid share link'] };
    }
  }

  // CSV of the given rows/columns; text cells starting with = + - @ get a leading ' so a
  // spreadsheet never runs them as formulas.
  function toCSV(rows, columns) {
    const cell = v => {
      if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '';
      let s = Array.isArray(v) ? v.join('; ') : String(v);
      if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = [columns.map(cell).join(',')];
    for (const r of rows || []) lines.push(columns.map(k => cell(isObj(r) && own(r, k) ? r[k] : null)).join(','));
    return lines.join('\r\n');
  }

  const api = {
    load, setRegistry,
    isReady: () => !!REG,
    registry: () => REG,
    field, fields, presets, ops: opsOf,
    validate, evaluate, describe, diff, growthGuard, ruleParse,
    rowKey, dataOk, formatValue, encodeFilter, decodeFilter, toCSV,
  };
  if (BUNDLED) setRegistry(BUNDLED);
  return api;
});
