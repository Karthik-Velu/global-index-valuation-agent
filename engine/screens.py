"""Screen DSL core (Python side) — registry loading, validate() and evaluate().

The screener, the AI screen builder and the alert jobs all speak one filter language,
defined by `dashboard/screen_fields.json` and implemented in `dashboard/screen-dsl.js`.
This module is the Python mirror of the JS validator/evaluator so a job grading a saved
screen gets exactly the rows the browser showed (parity vectors in
tests/screen_vectors.json run under both `node scripts/test_screens.js` and
`python tests/test_screens.py`).

Deliberately STDLIB ONLY: CI runs the parity tests with no `pip install`, so anything
that needs pandas/psycopg (publishing the snapshot, running alerts) lives in
`engine/screenjobs.py` instead. There is no language parsing here — turning a sentence
into a filter is the browser's / the function's job (ScreenDSL.ruleParse); jobs only
ever re-validate and evaluate stored filters.

Filter shape (v1):
    {"v": 1, "scope": "stocks" | "markets",
     "where": [{"field": "pe", "op": "<=", "value": 20}, ...],      # AND only, <= 12
     "sort": {"field": "value_score", "dir": "desc"} | None,
     "limit": 1..500 (default 100), "include_flagged": False,
     "columns": [field keys] (optional, display only)}

Semantics shared with the JS: nulls/NaN never match a comparison (not even '!='); text
ops are case-insensitive; enum values are canonicalised through the registry synonyms;
include_flagged=False adds an implicit `data_ok is_true`; sorting puts nulls last in both
directions and is stable.
"""
from __future__ import annotations

import json
import math
import re
from functools import cmp_to_key, lru_cache
from pathlib import Path
from typing import Any

REGISTRY_PATH = Path(__file__).resolve().parent.parent / "dashboard" / "screen_fields.json"

_TOP_KEYS = ("v", "scope", "where", "sort", "limit", "include_flagged", "columns")
_COND_KEYS = ("field", "op", "value")
_SORT_KEYS = ("field", "dir")
_NUM_TYPES = ("number", "percent", "money")
_NUM_RE = re.compile(r"^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$")
_MISSING = object()


class Registry:
    """The parsed screen_fields.json: field defs by key (a dict, so '__proto__' or
    'constructor' are just unknown keys), ops per type, enum lookups."""

    def __init__(self, data: dict):
        self.data = data
        self.limits = data["limits"]
        self.scopes = list(data["scopes"])
        self.reserved = set(data.get("reserved_scopes", []))
        self.type_ops = {k: list(v) for k, v in data["type_ops"].items()}
        self.fields: dict[str, dict] = {}
        self.enums: dict[str, dict[str, str]] = {}
        for f in data["fields"]:
            self.fields[f["key"]] = f
            if f["type"] == "enum":
                m = {v.lower(): v for v in f["enum"]}
                syn = f.get("enum_synonyms", {})
                for v in f["enum"]:
                    for s in syn.get(v, []):
                        m.setdefault(s.lower(), v)
                self.enums[f["key"]] = m
        self.presets = list(data.get("presets", []))

    def ops_for(self, f: dict) -> list[str]:
        return self.type_ops.get("list" if f.get("list") else f["type"], [])

    def fields_for(self, scope: str) -> list[dict]:
        """Field defs available in `scope`, in registry group order."""
        return [f for g in self.data["groups"] for f in self.data["fields"]
                if f["group"] == g and scope in f["scopes"]]


@lru_cache(maxsize=1)
def registry() -> Registry:
    return Registry(json.loads(REGISTRY_PATH.read_text(encoding="utf-8")))


def field_keys(scope: str) -> list[str]:
    """Registry field keys for a scope — what a published snapshot row should carry."""
    return [f["key"] for f in registry().fields_for(scope)]


# ---- helpers (each mirrors the JS function of the same name) ----

def _is_num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def _to_num(x: Any):
    if isinstance(x, bool):
        return None
    if isinstance(x, (int, float)):
        return x if math.isfinite(x) else None
    if isinstance(x, str) and _NUM_RE.match(x.strip()):
        v = float(x.strip())
        return int(v) if v.is_integer() and abs(v) < 1e15 else v
    return None


def _num_str(n) -> str:
    # JS String(n): integral floats print without '.0'
    if isinstance(n, float) and n.is_integer() and abs(n) < 1e21:
        return str(int(n))
    return repr(n) if isinstance(n, float) else str(n)


def _clip(s) -> str:
    return _js_str(s)[:40]


def _boolish(v):
    if v is True or v is False:
        return v
    if v == "true" and isinstance(v, str):
        return True
    if v == "false" and isinstance(v, str):
        return False
    return None


def _lev(a: str, b: str) -> int:
    if a == b:
        return 0
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        cur = [i]
        for j in range(1, len(b) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if a[i - 1] == b[j - 1] else 1)))
        prev = cur
    return prev[len(b)]


def _closest(f: dict, s: str) -> list[str]:
    q = s.strip().lower()
    syn = f.get("enum_synonyms", {})
    scored = []
    for i, v in enumerate(f["enum"]):
        d = _lev(q, v.lower())
        for x in syn.get(v, []):
            d = min(d, _lev(q, x.lower()))
        scored.append((d, i, v))
    scored.sort(key=lambda t: (t[0], t[1]))
    return [t[2] for t in scored[:3]]


def _canon(reg: Registry, f: dict, s: str):
    return reg.enums.get(f["key"], {}).get(s.strip().lower())


def _check_num(f: dict, n, p: str, errors: list) -> bool:
    if f.get("min") is not None and n < f["min"]:
        errors.append(f"{p}: {_num_str(n)} is below the minimum {_num_str(f['min'])} for {f['short']}")
        return False
    if f.get("max") is not None and n > f["max"]:
        errors.append(f"{p}: {_num_str(n)} is above the maximum {_num_str(f['max'])} for {f['short']}")
        return False
    return True


def _check_text(reg: Registry, v, p: str, errors: list):
    if not isinstance(v, str):
        errors.append(f"{p}: must be a string")
        return None
    t = v.strip()
    if not t:
        errors.append(f"{p}: must not be empty")
        return None
    mx = reg.limits["max_text_length"]
    if len(t) > mx:
        errors.append(f"{p}: at most {mx} characters")
        return None
    return t


def _check_list(reg: Registry, f: dict, value, p: str, errors: list):
    arr = [value] if isinstance(value, str) else value
    if not isinstance(arr, list) or not arr:
        errors.append(f"{p}: must be a non-empty list")
        return None
    mx = reg.limits["max_list_values"]
    if len(arr) > mx:
        errors.append(f"{p}: at most {mx} values")
        return None
    out, ok = [], True
    for j, x in enumerate(arr):
        pj = f"{p}[{j}]"
        v = None
        if f["type"] == "enum":
            if not isinstance(x, str):
                errors.append(f"{pj}: must be a string")
            else:
                v = _canon(reg, f, x)
                if v is None:
                    errors.append(f"{pj}: '{_clip(x)}' is not a valid {f['short']} "
                                  f"(closest: {', '.join(_closest(f, x))})")
        else:
            v = _check_text(reg, x, pj, errors)
        if v is None:
            ok = False
        elif v not in out:
            out.append(v)
    return out if ok else None


def _check_cond(reg: Registry, c, p: str, sc: str, errors: list):
    if not isinstance(c, dict):
        errors.append(f"{p}: must be an object")
        return None
    bad = [k for k in c if k not in _COND_KEYS]
    if bad:
        for k in bad:
            errors.append(f"{p}.{_clip(k)}: unknown key")
        return None
    field = c.get("field")
    if not isinstance(field, str):
        errors.append(f"{p}.field: must be a string")
        return None
    f = reg.fields.get(field)
    if f is None:
        errors.append(f"{p}.field: unknown field '{_clip(field)}'")
        return None
    if sc not in f["scopes"]:
        errors.append(f"{p}.field: '{f['key']}' is not available for {sc}")
        return None
    op = c.get("op")
    value = c.get("value", _MISSING)
    if not isinstance(op, str):
        errors.append(f"{p}.op: must be a string")
        return None
    if f["type"] == "bool" and op in ("=", "!="):
        b = _boolish(None if value is _MISSING else value)
        if b is not None:
            op = "is_true" if b == (op == "=") else "is_false"
            value = _MISSING
    ops = reg.ops_for(f)
    if op not in ops:
        errors.append(f"{p}.op: '{_clip(op)}' is not allowed for {f['short']} (use {', '.join(ops)})")
        return None
    pv = f"{p}.value"
    if f["type"] == "bool":
        return {"field": f["key"], "op": op}
    if f["type"] in _NUM_TYPES:
        if op == "between":
            if not isinstance(value, list) or len(value) != 2:
                errors.append(f"{pv}: between needs [low, high]")
                return None
            ns = [_to_num(x) for x in value]
            if ns[0] is None or ns[1] is None:
                errors.append(f"{pv}: between needs two numbers")
                return None
            ns.sort()
            if not _check_num(f, ns[0], pv, errors) or not _check_num(f, ns[1], pv, errors):
                return None
            return {"field": f["key"], "op": op, "value": ns}
        n = _to_num(None if value is _MISSING else value)
        if n is None:
            errors.append(f"{pv}: must be a number")
            return None
        return {"field": f["key"], "op": op, "value": n} if _check_num(f, n, pv, errors) else None
    if op in ("in", "not_in"):
        vs = _check_list(reg, f, None if value is _MISSING else value, pv, errors)
        return None if vs is None else {"field": f["key"], "op": op, "value": vs}
    if f["type"] == "enum":
        if not isinstance(value, str):
            errors.append(f"{pv}: must be a string")
            return None
        v = _canon(reg, f, value)
        if v is None:
            errors.append(f"{pv}: '{_clip(value)}' is not a valid {f['short']} "
                          f"(closest: {', '.join(_closest(f, value))})")
            return None
        return {"field": f["key"], "op": op, "value": v}
    t = _check_text(reg, None if value is _MISSING else value, pv, errors)
    return None if t is None else {"field": f["key"], "op": op, "value": t}


def validate(flt: Any, scope: str | None = None) -> dict:
    """-> {"ok": bool, "filter": normalised filter | None, "errors": [str]}. Never raises
    on bad input; error strings are identical to ScreenDSL.validate()'s."""
    reg = registry()
    lim = reg.limits
    errors: list[str] = []
    if not isinstance(flt, dict):
        return {"ok": False, "filter": None, "errors": ["filter: must be an object"]}
    for k in flt:
        if k not in _TOP_KEYS:
            errors.append(f"filter.{_clip(k)}: unknown key")
    if "v" in flt and not (_is_num(flt["v"]) and flt["v"] == 1):
        errors.append("filter.v: must be 1")

    sc = flt.get("scope")
    if sc is None:
        sc = scope
    elif scope is not None and sc != scope:
        errors.append(f"filter.scope: '{_clip(sc)}' does not match the requested scope '{_clip(scope)}'")
        return {"ok": False, "filter": None, "errors": errors}
    if isinstance(sc, str) and sc in reg.reserved:
        errors.append(f"filter.scope: '{sc}' is not available yet")
        return {"ok": False, "filter": None, "errors": errors}
    if not isinstance(sc, str) or sc not in reg.scopes:
        errors.append(f"filter.scope: must be one of {', '.join(reg.scopes)}")
        return {"ok": False, "filter": None, "errors": errors}

    where = flt.get("where")
    if where is None:
        where = []
    out_where = []
    if not isinstance(where, list):
        errors.append("filter.where: must be a list")
    else:
        if len(where) > lim["max_conditions"]:
            errors.append(f"filter.where: at most {lim['max_conditions']} conditions (got {len(where)})")
        for i, c in enumerate(where):
            r = _check_cond(reg, c, f"where[{i}]", sc, errors)
            if r is not None:
                out_where.append(r)

    out_sort = None
    srt = flt.get("sort")
    if srt is not None:
        n0 = len(errors)
        if not isinstance(srt, dict):
            errors.append("filter.sort: must be an object or null")
        else:
            for k in srt:
                if k not in _SORT_KEYS:
                    errors.append(f"filter.sort.{_clip(k)}: unknown key")
            sf = srt.get("field")
            f = reg.fields.get(sf) if isinstance(sf, str) else None
            if not isinstance(sf, str):
                errors.append("filter.sort.field: must be a string")
            elif f is None:
                errors.append(f"filter.sort.field: unknown field '{_clip(sf)}'")
            elif sc not in f["scopes"]:
                errors.append(f"filter.sort.field: '{f['key']}' is not available for {sc}")
            elif f.get("list"):
                errors.append(f"filter.sort.field: '{f['key']}' cannot be sorted")
            d = srt.get("dir")
            if d is None:
                d = "desc"
            if d not in ("asc", "desc") or not isinstance(d, str):
                errors.append("filter.sort.dir: must be 'asc' or 'desc'")
            if len(errors) == n0:
                out_sort = {"field": sf, "dir": d}

    limit = lim["limit_default"]
    if flt.get("limit") is not None:
        n = _to_num(flt["limit"])
        if n is None or not float(n).is_integer() or n < lim["limit_min"] or n > lim["limit_max"]:
            errors.append(f"filter.limit: must be a whole number from {lim['limit_min']} to {lim['limit_max']}")
        else:
            limit = int(n)

    flagged = False
    if flt.get("include_flagged") is not None:
        if not isinstance(flt["include_flagged"], bool):
            errors.append("filter.include_flagged: must be true or false")
        else:
            flagged = flt["include_flagged"]

    columns = None
    if flt.get("columns") is not None:
        cols = flt["columns"]
        if not isinstance(cols, list):
            errors.append("filter.columns: must be a list of field keys")
        elif len(cols) > lim["max_columns"]:
            errors.append(f"filter.columns: at most {lim['max_columns']} fields")
        else:
            columns = []
            for j, k in enumerate(cols):
                f = reg.fields.get(k) if isinstance(k, str) else None
                if f is None:
                    errors.append(f"filter.columns[{j}]: unknown field '{_clip(k)}'")
                elif sc not in f["scopes"]:
                    errors.append(f"filter.columns[{j}]: '{f['key']}' is not available for {sc}")
                elif k not in columns:
                    columns.append(k)

    if errors:
        return {"ok": False, "filter": None, "errors": errors}
    out = {"v": 1, "scope": sc, "where": out_where, "sort": out_sort, "limit": limit,
           "include_flagged": flagged}
    if columns is not None:
        out["columns"] = columns
    return {"ok": True, "filter": out, "errors": []}


def _js_str(x) -> str:
    """String(x) as JS would print it, for the rare non-string echoed in an error."""
    if x is None:
        return "null"
    if isinstance(x, bool):
        return "true" if x else "false"
    if isinstance(x, (int, float)):
        return _num_str(x)
    if isinstance(x, list):
        return ",".join(_js_str(v) for v in x)
    if isinstance(x, dict):
        return "[object Object]"
    return str(x)


# ---- evaluation ----

def data_ok(row: dict) -> bool:
    """A row passes the data checks. Stock snapshot rows carry data_ok; market rows
    (the public scoreboard) don't, and pass unless data_sane is explicitly False."""
    v = row.get("data_ok")
    if isinstance(v, bool):
        return v
    return row.get("data_sane") is not False


def row_key(row: dict, scope: str = "stocks"):
    return row.get("ticker") if scope == "stocks" else row.get("key")


def _get(row: dict, k: str):
    return data_ok(row) if k == "data_ok" else row.get(k)


def _test(reg: Registry, c: dict, row: dict) -> bool:
    f = reg.fields[c["field"]]
    v = _get(row, c["field"])
    op = c["op"]
    if f["type"] == "bool":
        return v is True if op == "is_true" else v is False
    if f["type"] in _NUM_TYPES:
        if not _is_num(v):      # null / NaN / strings never match, not even '!='
            return False
        x = c["value"]
        if op == "<":
            return v < x
        if op == "<=":
            return v <= x
        if op == ">":
            return v > x
        if op == ">=":
            return v >= x
        if op == "=":
            return v == x
        if op == "!=":
            return v != x
        if op == "between":
            return x[0] <= v <= x[1]
        return False
    if f.get("list"):
        arr = v if isinstance(v, list) else ([v] if isinstance(v, str) else [])
        q = c["value"].lower()
        return any(isinstance(s, str) and q in s.lower() for s in arr)
    if not isinstance(v, str):
        return False
    if f["type"] == "enum":
        if op == "=":
            return v == c["value"]
        if op == "!=":
            return v != c["value"]
        if op == "in":
            return v in c["value"]
        if op == "not_in":
            return v not in c["value"]
        return False
    lv = v.lower()
    if op == "=":
        return lv == c["value"].lower()
    if op == "!=":
        return lv != c["value"].lower()
    if op == "contains":
        return c["value"].lower() in lv
    if op == "in":
        return any(s.lower() == lv for s in c["value"])
    if op == "not_in":
        return not any(s.lower() == lv for s in c["value"])
    return False


def _sort_key(f: dict, v):
    if f["type"] in _NUM_TYPES:
        return v if _is_num(v) else None
    if f["type"] == "bool":
        return (1 if v else 0) if isinstance(v, bool) else None
    return v.lower() if isinstance(v, str) else None


def evaluate(flt: Any, rows: list[dict]) -> dict:
    """-> {"rows": matched rows (sorted, limited), "total": matches before the limit}.
    An invalid filter matches nothing: {"rows": [], "total": 0, "errors": [...]}."""
    res = validate(flt)
    if not res["ok"]:
        return {"rows": [], "total": 0, "errors": res["errors"]}
    reg = registry()
    fl = res["filter"]
    conds = list(fl["where"])
    if not fl["include_flagged"]:
        conds.append({"field": "data_ok", "op": "is_true"})
    out = [r for r in (rows if isinstance(rows, list) else [])
           if isinstance(r, dict) and all(_test(reg, c, r) for c in conds)]
    if fl["sort"]:
        f = reg.fields[fl["sort"]["field"]]
        d = -1 if fl["sort"]["dir"] == "desc" else 1

        def cmp(a, b):
            x, y = a[0], b[0]
            if x is None:
                return 0 if y is None else 1
            if y is None:
                return -1
            return -d if x < y else (d if x > y else 0)

        keyed = [(_sort_key(f, _get(r, f["key"])), r) for r in out]
        out = [r for _, r in sorted(keyed, key=cmp_to_key(cmp))]
    return {"rows": out[:fl["limit"]], "total": len(out)}


def matching_keys(flt: Any, rows: list[dict]) -> list:
    """Sorted row keys of the FULL match set (sort and limit ignored) — what an alert
    compares between runs, so rank churn inside a top-N never reads as a change."""
    res = validate(flt)
    if not res["ok"]:
        return []
    reg = registry()
    fl = res["filter"]
    conds = list(fl["where"])
    if not fl["include_flagged"]:
        conds.append({"field": "data_ok", "op": "is_true"})
    keys = {row_key(r, fl["scope"]) for r in (rows if isinstance(rows, list) else [])
            if isinstance(r, dict) and all(_test(reg, c, r) for c in conds)}
    return sorted(k for k in keys if k is not None)
