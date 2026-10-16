"""Screen DSL tests (Python side) — stdlib only, no pytest needed:

    python tests/test_screens.py

Runs the parity vectors shared with `node scripts/test_screens.js` (validate, evaluate,
presets) against engine/screens.py, so a saved screen graded by a job matches what the
browser showed. Also checks the registry against the real engine column names and the
public dashboard data. pytest will collect the test_* functions too.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from engine import screens  # noqa: E402

VECTORS = json.loads((ROOT / "tests" / "screen_vectors.json").read_text(encoding="utf-8"))
FIXTURES = {s: json.loads((ROOT / "tests" / "fixtures" / f"screen_{s}.json").read_text(encoding="utf-8"))
            for s in ("stocks", "markets")}
REG = json.loads(screens.REGISTRY_PATH.read_text(encoding="utf-8"))


def _revive(x):
    """{"$num": "NaN"} -> float('nan') etc. (JSON can't carry non-finite numbers)."""
    if isinstance(x, list):
        return [_revive(v) for v in x]
    if isinstance(x, dict):
        if list(x) == ["$num"]:
            return float(x["$num"].replace("Infinity", "inf"))
        return {k: _revive(v) for k, v in x.items()}
    return x


def _same(a, b) -> bool:
    """Deep equality where 20 == 20.0 (JS has one number type) but True != 1."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k]) for k in a)
    return a == b


def test_validate_vectors():
    for t in VECTORS["validate"]:
        r = screens.validate(t["filter"], t.get("scope"))
        for k, want in t["expect"].items():
            assert _same(r[k], want), f"validate '{t['name']}' {k}: got {r[k]!r}, want {want!r}"


def test_evaluate_vectors():
    for t in VECTORS["evaluate"]:
        rows = _revive(t["rows"]) if "rows" in t else FIXTURES[t["fixture"]]
        scope = t.get("scope") or t["fixture"]
        r = screens.evaluate(t["filter"], rows)
        keys = [screens.row_key(x, scope) for x in r["rows"]]
        assert keys == t["expect"]["keys"], f"evaluate '{t['name']}': got {keys}"
        assert r["total"] == t["expect"]["total"], f"evaluate '{t['name']}' total: got {r['total']}"


def test_presets_validate():
    ids = set()
    for p in REG["presets"]:
        assert p["id"] not in ids, p["id"]
        ids.add(p["id"])
        r = screens.validate(p["filter"], p["scope"])
        assert r["ok"], (p["id"], r["errors"])
        used = [c["field"] for c in r["filter"]["where"]] + ([r["filter"]["sort"]["field"]] if r["filter"]["sort"] else [])
        assert "opportunity_score" not in used, p["id"]


def test_matching_keys_ignores_sort_and_limit():
    flt = {"scope": "stocks", "where": [{"field": "pe", "op": "<=", "value": 20}],
           "sort": {"field": "pe", "dir": "asc"}, "limit": 1}
    assert screens.evaluate(flt, FIXTURES["stocks"])["total"] == 5
    assert screens.matching_keys(flt, FIXTURES["stocks"]) == ["FXA", "FXC", "FXD", "FXE", "FXL"]
    assert screens.matching_keys({"scope": "stocks", "where": [{"field": "nope"}]}, FIXTURES["stocks"]) == []
    mk = screens.matching_keys({"scope": "markets", "where": [{"field": "garp", "op": "is_true"}]}, FIXTURES["markets"])
    assert mk == ["fx_br", "fx_eufin"]


def test_nan_rows_from_pandas_style_input():
    rows = [{"ticker": "FXA", "pe": math.nan, "data_ok": True}, {"ticker": "FXB", "pe": 5.0, "data_ok": True}]
    r = screens.evaluate({"scope": "stocks", "where": [{"field": "pe", "op": "!=", "value": 1}]}, rows)
    assert [x["ticker"] for x in r["rows"]] == ["FXB"]


def test_field_keys_by_scope():
    stock = screens.field_keys("stocks")
    market = screens.field_keys("markets")
    for k in ("rev_cagr", "ni_cagr", "rev_up_ratio", "steady_compounder", "data_flags", "ticker", "price"):
        assert k in stock and k not in market, k
    for k in ("region", "development", "kind", "symbol", "key", "fwd_growth", "growth_cov"):
        assert k in market and k not in stock, k
    for k in ("momentum_score", "ret_12m", "ret_1m", "portfolio"):
        assert k not in stock and k not in market


def test_stock_fields_exist_in_engine_output():
    """Every stock field (bar the job-computed data_ok/data_flags) must be a column the
    real pipeline produces: score_frame = _universe + _fundamentals_frame (incl.
    growthhistory.FEATURES) + _price_features + metrics.compute + strategies.apply."""
    src = "".join((ROOT / "engine" / f).read_text(encoding="utf-8")
                  for f in ("stockvaluation.py", "metrics.py", "strategies.py", "growthhistory.py"))
    for f in REG["fields"]:
        if "stocks" not in f["scopes"] or f["key"] in ("data_ok", "data_flags"):
            continue
        assert f'"{f["key"]}"' in src, f"stock field {f['key']} is not an engine output column"


def test_market_fields_exist_in_scoreboard():
    p = ROOT / "dashboard" / "dashboard_data.json"
    if not p.exists():
        return
    data = json.loads(p.read_text(encoding="utf-8"))
    sb = data.get("scoreboard") or []
    assert sb
    for f in REG["fields"]:
        if "markets" in f["scopes"] and f["key"] != "data_ok":
            assert all(f["key"] in r for r in sb), f"market field {f['key']} missing from scoreboard rows"
    reg = screens.registry()
    for k in ("region", "development", "kind", "country"):
        for v in {r.get(k) for r in sb if r.get(k) is not None}:
            assert v in reg.fields[k]["enum"], f"scoreboard {k} '{v}' missing from the registry enum"
    stocks = [r for rows in (data.get("stock_breakdown") or {}).values() for r in rows]
    for k in ("sector", "country"):
        for v in {r.get(k) for r in stocks if r.get(k) is not None}:
            assert v in reg.fields[k]["enum"], f"stock {k} '{v}' missing from the registry enum"


def test_stdlib_only():
    """engine/screens.py must import nothing outside the standard library (CI runs it
    with no pip install)."""
    import ast
    tree = ast.parse((ROOT / "engine" / "screens.py").read_text(encoding="utf-8"))
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            mods.update(a.name.split(".")[0] for a in node.names)
        elif isinstance(node, ast.ImportFrom):
            assert node.level == 0, "no relative imports in the stdlib core"
            mods.add((node.module or "").split(".")[0])
    stdlib = getattr(sys, "stdlib_module_names", None)
    allowed = {"__future__", "json", "math", "re", "functools", "pathlib", "typing"}
    assert mods <= (set(stdlib) | {"__future__"} if stdlib else allowed), mods


def main() -> int:
    tests = [(n, f) for n, f in sorted(globals().items()) if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {name}: {e}")
    n_vec = len(VECTORS["validate"]) + len(VECTORS["evaluate"])
    print(f"\n{len(tests) - failed} passed, {failed} failed ({n_vec} parity vectors)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
