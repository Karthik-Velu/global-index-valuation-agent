"""Free data layer (Phase 1).

Pulls per-index valuation + price metrics from Yahoo via yfinance. Yahoo stores
the ETF "Price/X" fields as reciprocals (yield form), so we invert them back to
conventional ratios. Everything is cached per run-date in SQLite so re-runs and
the prediction-scoring pass are free and offline-friendly.

This module is intentionally dumb: fetch, normalise, cache. No scoring here.
"""
from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone

import numpy as np
import pandas as pd
import yfinance as yf

from .config import DB_PATH
from .universe import UNIVERSE, Index


@dataclass
class Snapshot:
    """Everything we know about one index proxy at one point in time."""
    key: str
    symbol: str
    name: str
    asof: str
    price: float | None = None
    # Valuation (conventional ratios; higher = more expensive)
    pe: float | None = None
    pb: float | None = None
    ps: float | None = None
    pcf: float | None = None
    dividend_yield: float | None = None  # fraction, e.g. 0.018
    # Price-derived signals
    ret_1m: float | None = None
    ret_3m: float | None = None
    ret_6m: float | None = None
    ret_12m: float | None = None
    ma200_ratio: float | None = None     # price / 200d MA - 1
    pct_52w_range: float | None = None   # 0 (at low) .. 1 (at high)
    drawdown_52w: float | None = None    # price / 52w high - 1  (<= 0)
    # Fundamental growth (weighted from top holdings; set by enrich_growth)
    holdings: list | None = None          # [(symbol, weight), ...] top-N
    rev_growth: float | None = None       # weighted trailing revenue growth (YoY)
    earnings_growth: float | None = None  # weighted trailing earnings growth (YoY)
    fwd_growth: float | None = None       # weighted forward (analyst +1y) EPS growth
    growth_cov: float | None = None       # sum of holding weights we had data for


def _invert(v) -> float | None:
    """Yahoo reciprocal -> conventional ratio. Guards bad values."""
    try:
        v = float(v)
        if not np.isfinite(v) or v <= 0:
            return None
        return round(1.0 / v, 2)
    except Exception:
        return None


def _ret(close: pd.Series, days: int) -> float | None:
    """Total return over ~`days` trading-calendar window using nearest prior bar."""
    if close is None or close.empty:
        return None
    last = close.iloc[-1]
    target = close.index[-1] - pd.Timedelta(days=days)
    prior = close.loc[:target]
    if prior.empty or last is None or pd.isna(last):
        return None
    base = prior.iloc[-1]
    if base is None or pd.isna(base) or base == 0:
        return None
    return round(float(last) / float(base) - 1.0, 4)


def _price_signals(close: pd.Series) -> dict:
    out: dict = {}
    if close is None or close.empty:
        return out
    close = close.dropna()
    if close.empty:
        return out
    out["price"] = round(float(close.iloc[-1]), 4)
    out["ret_1m"] = _ret(close, 30)
    out["ret_3m"] = _ret(close, 91)
    out["ret_6m"] = _ret(close, 182)
    out["ret_12m"] = _ret(close, 365)
    if len(close) >= 200:
        ma200 = close.tail(200).mean()
        if ma200:
            out["ma200_ratio"] = round(float(close.iloc[-1]) / float(ma200) - 1.0, 4)
    last_year = close.tail(252)
    if len(last_year) > 20:
        hi, lo = float(last_year.max()), float(last_year.min())
        px = float(close.iloc[-1])
        if hi > lo:
            out["pct_52w_range"] = round((px - lo) / (hi - lo), 4)
        if hi > 0:
            out["drawdown_52w"] = round(px / hi - 1.0, 4)
    return out


def fetch_one(ix: Index, asof: str) -> Snapshot:
    snap = Snapshot(key=ix.key, symbol=ix.proxy, name=ix.name, asof=asof)
    t = yf.Ticker(ix.proxy)

    # --- valuation from ETF equity holdings (single consistent methodology) ---
    try:
        eh = t.funds_data.equity_holdings
        col = eh.columns[0]

        def grab(label):
            try:
                return eh.loc[label, col]
            except Exception:
                return None

        snap.pe = _invert(grab("Price/Earnings"))
        snap.pb = _invert(grab("Price/Book"))
        snap.ps = _invert(grab("Price/Sales"))
        snap.pcf = _invert(grab("Price/Cashflow"))
    except Exception:
        pass

    # --- dividend yield (ETF distribution yield) ---
    try:
        info = t.get_info()
        dy = info.get("yield") or info.get("dividendYield")
        if dy is not None:
            dy = float(dy)
            # Yahoo is inconsistent: sometimes 1.8 (pct), sometimes 0.018 (frac).
            snap.dividend_yield = round(dy / 100.0 if dy > 1 else dy, 4)
    except Exception:
        pass

    # --- price history -> momentum + mean-reversion signals ---
    try:
        hist = t.history(period="2y", interval="1d", auto_adjust=True)
        if hist is not None and not hist.empty:
            for k, v in _price_signals(hist["Close"]).items():
                setattr(snap, k, v)
    except Exception:
        pass

    # --- top holdings (symbols + weights) for the fundamental-growth pass ---
    try:
        th = t.funds_data.top_holdings
        if th is not None and not th.empty:
            wcol = "Holding Percent" if "Holding Percent" in th.columns else th.columns[-1]
            snap.holdings = [
                [str(sym), float(w)] for sym, w in th[wcol].items()
                if w is not None and not np.isnan(float(w)) and _valid_sym(sym)
            ]
    except Exception:
        pass

    return snap


# --- fundamental growth from constituents (cheap "mini bottom-up") ----------

def _valid_sym(s) -> bool:
    """Skip cash/placeholder rows that aren't real tickers."""
    if s is None:
        return False
    s = str(s).strip().upper()
    return bool(s) and s not in {"-", "--", "N/A", "NA", "CASH", "USD", ".", "TODO"} and len(s) <= 15


def _stock_growth(sym: str) -> dict:
    """One call gives trailing growth; an optional second gives forward analyst growth.
    Fully defensive — any bad symbol or network error yields empty (None) values."""
    from .config import FETCH_FORWARD_GROWTH

    out = {"rev": None, "earn": None, "qoq": None, "fwd": None}
    if not _valid_sym(sym):
        return out
    try:
        t = yf.Ticker(sym)
    except Exception:
        return out
    try:
        info = t.get_info()
        out["rev"] = _num(info.get("revenueGrowth"))
        out["earn"] = _num(info.get("earningsGrowth"))
        out["qoq"] = _num(info.get("earningsQuarterlyGrowth"))
    except Exception:
        pass
    if FETCH_FORWARD_GROWTH:
        try:
            ge = t.growth_estimates
            col = "stockTrend" if "stockTrend" in ge.columns else ge.columns[0]
            out["fwd"] = _num(ge.loc["+1y", col])
        except Exception:
            pass
    return out


def _num(v):
    try:
        v = float(v)
        return None if np.isnan(v) else v
    except Exception:
        return None


def _growth_cache(asof: str) -> dict:
    c = _conn()
    c.execute("""CREATE TABLE IF NOT EXISTS holding_growth
                 (asof TEXT, symbol TEXT, rev REAL, earn REAL, qoq REAL, fwd REAL,
                  PRIMARY KEY (asof, symbol))""")
    rows = c.execute("SELECT symbol,rev,earn,qoq,fwd FROM holding_growth WHERE asof=?", (asof,)).fetchall()
    c.close()
    return {r[0]: {"rev": r[1], "earn": r[2], "qoq": r[3], "fwd": r[4]} for r in rows}


def _growth_cache_put(asof: str, sym: str, g: dict) -> None:
    c = _conn()
    c.execute("""CREATE TABLE IF NOT EXISTS holding_growth
                 (asof TEXT, symbol TEXT, rev REAL, earn REAL, qoq REAL, fwd REAL,
                  PRIMARY KEY (asof, symbol))""")
    with c:
        c.execute("INSERT OR REPLACE INTO holding_growth VALUES (?,?,?,?,?,?)",
                  (asof, sym, g["rev"], g["earn"], g["qoq"], g["fwd"]))
    c.close()


def enrich_growth(snaps: list[Snapshot], asof: str, sleep: float = 0.15) -> list[Snapshot]:
    """Dedup all top-holdings, fetch each one's growth once (cached), then weight
    up to an index-level fundamental-growth estimate. This is the real revenue/
    profit growth signal — not price momentum."""
    from .config import GROWTH_WINSOR

    lo, hi = GROWTH_WINSOR
    # 1. unique holding universe across every index
    universe = {}
    for s in snaps:
        for sym, _w in (s.holdings or []):
            if _valid_sym(sym):
                universe.setdefault(sym, None)

    cache = _growth_cache(asof)
    todo = [sym for sym in universe if sym not in cache]
    print(f"  growth: {len(universe)} unique holdings, {len(todo)} to fetch, {len(cache)} cached")
    for i, sym in enumerate(todo, 1):
        g = _stock_growth(sym)
        _growth_cache_put(asof, sym, g)
        cache[sym] = g
        if i % 50 == 0:
            print(f"    growth fetched {i}/{len(todo)}")
        time.sleep(sleep)

    # 2. weight up to each index
    def clip(x):
        return None if x is None else max(lo, min(hi, x))

    for s in snaps:
        rev = _wavg(s.holdings, cache, "rev", clip)
        earn = _wavg(s.holdings, cache, "earn", clip)
        fwd = _wavg(s.holdings, cache, "fwd", clip)
        s.rev_growth = rev["val"]
        s.earnings_growth = earn["val"]
        s.fwd_growth = fwd["val"]
        s.growth_cov = round(max(rev["cov"], earn["cov"], fwd["cov"]), 3)
    return snaps


def _wavg(holdings, cache, field, clip) -> dict:
    if not holdings:
        return {"val": None, "cov": 0.0}
    num = den = 0.0
    for sym, w in holdings:
        g = cache.get(sym)
        if not g:
            continue
        v = clip(g.get(field))
        if v is None:
            continue
        num += w * v
        den += w
    return {"val": round(num / den, 4) if den > 0 else None, "cov": den}


# --- persistence -----------------------------------------------------------

def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.execute(
        """CREATE TABLE IF NOT EXISTS snapshots (
            asof TEXT, key TEXT, symbol TEXT, json TEXT,
            PRIMARY KEY (asof, key))"""
    )
    return c


def save_snapshots(snaps: list[Snapshot]) -> None:
    c = _conn()
    with c:
        for s in snaps:
            c.execute(
                "INSERT OR REPLACE INTO snapshots(asof,key,symbol,json) VALUES (?,?,?,?)",
                (s.asof, s.key, s.symbol, json.dumps(asdict(s))),
            )
    c.close()


def load_snapshots(asof: str) -> list[Snapshot]:
    c = _conn()
    rows = c.execute("SELECT json FROM snapshots WHERE asof=?", (asof,)).fetchall()
    c.close()
    return [Snapshot(**json.loads(r[0])) for r in rows]


def refresh(asof: str | None = None, sleep: float = 0.4, use_cache: bool = True) -> list[Snapshot]:
    """Fetch (or load cached) snapshots for the whole universe."""
    asof = asof or date.today().isoformat()
    if use_cache:
        cached = load_snapshots(asof)
        if len(cached) >= len(UNIVERSE):
            return cached

    snaps: list[Snapshot] = []
    for i, ix in enumerate(UNIVERSE, 1):
        snap = fetch_one(ix, asof)
        ok = snap.pe is not None or snap.price is not None
        print(f"  [{i:>2}/{len(UNIVERSE)}] {ix.proxy:<5} {ix.name:<32} "
              f"PE={snap.pe} px={snap.price} holds={len(snap.holdings or [])} {'ok' if ok else 'MISS'}")
        snaps.append(snap)
        time.sleep(sleep)  # be polite to the free endpoint

    # second pass: real fundamental growth from the constituents
    enrich_growth(snaps, asof)

    save_snapshots(snaps)
    return snaps


def to_frame(snaps: list[Snapshot]) -> pd.DataFrame:
    df = pd.DataFrame([asdict(s) for s in snaps])
    meta = {ix.key: ix for ix in UNIVERSE}
    df["country"] = df["key"].map(lambda k: meta[k].country if k in meta else "")
    df["region"] = df["key"].map(lambda k: meta[k].region if k in meta else "")
    df["development"] = df["key"].map(lambda k: meta[k].development if k in meta else "")
    df["kind"] = df["key"].map(lambda k: meta[k].kind if k in meta else "Country")
    return sanitize(df)


# Plausible bounds for an equity *index* — anything outside is bad/thin data
# (e.g. an ETF that returned its ratio in non-reciprocal form). Nulled, not kept.
_BOUNDS = {"pe": (2, 200), "pb": (0.1, 50), "ps": (0.05, 60), "pcf": (1, 200),
          "dividend_yield": (0, 0.25)}


def sanitize(df: pd.DataFrame) -> pd.DataFrame:
    for col, (lo, hi) in _BOUNDS.items():
        if col in df:
            bad = (df[col] < lo) | (df[col] > hi)
            df.loc[bad, col] = np.nan
    return df


if __name__ == "__main__":
    s = refresh(use_cache=False)
    print(f"\nFetched {len(s)} snapshots at {datetime.now(timezone.utc).isoformat()}")
