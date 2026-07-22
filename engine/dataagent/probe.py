"""Deterministic source evaluation — no LLM, so it's free and runs as often as we like.

Given an adapter, a data kind, and a sample of canonical keys, measure:
  - coverage:     fraction of requested keys the source actually returned
  - completeness: fraction of expected fields that are non-null
  - sanity:       fraction of numeric fields within plausible ranges
  - freshness:    days since the newest observation (lower is better)
  - latency:      wall-clock of the sample fetch
and blend them into a 0-100 quality score the agent can rank on.
"""
from __future__ import annotations

import math
import time
from dataclasses import asdict, dataclass
from datetime import date, datetime, timezone

from ..sources.base import EXPECTED_FIELDS, DataKind, SourceAdapter

# Plausible numeric ranges; values outside count as insane (bad data).
SANE = {
    "price": (1e-4, 1e7), "pe": (1, 400), "pb": (0.02, 100), "ps": (0.005, 150),
    "pcf": (0.5, 400), "dividend_yield": (0, 0.5), "rev_growth": (-1, 8),
    "earnings_growth": (-1, 12),
}

# How the five sub-scores combine into the headline quality score.
WEIGHTS = {"coverage": 0.35, "completeness": 0.25, "sanity": 0.20, "freshness": 0.12, "latency": 0.08}


@dataclass
class Scorecard:
    source_id: str
    kind: str
    coverage_pct: float | None = None
    completeness_pct: float | None = None
    sanity_pct: float | None = None
    freshness_days: float | None = None
    latency_ms: float | None = None
    rate_ok: bool = True
    sample_n: int = 0
    quality_score: float | None = None
    error: str | None = None
    detail: dict | None = None

    def as_eval(self) -> dict:
        d = asdict(self)
        return d


def _num(v):
    try:
        v = float(v)
        return v if math.isfinite(v) else None
    except (TypeError, ValueError):
        return None


def _freshness_days(records) -> float | None:
    ages = []
    today = datetime.now(timezone.utc).date()
    for r in records:
        if not r.asof:
            continue
        try:
            d = datetime.fromisoformat(str(r.asof)[:10]).date()
            ages.append((today - d).days)
        except Exception:
            continue
    return float(min(ages)) if ages else None   # newest observation's age


def _latency_score(ms) -> float:
    if ms is None:
        return 50.0
    # 0ms -> 100, ~3s -> ~0 (log-ish, forgiving)
    return max(0.0, 100.0 - (ms / 30.0))


def _freshness_score(days, kind) -> float:
    if days is None:
        return 50.0
    # news wants hours; prices/fundamentals tolerate days
    horizon = 1.0 if kind == DataKind.NEWS.value else 7.0
    return max(0.0, 100.0 * (1.0 - min(days, horizon * 4) / (horizon * 4)))


def probe(adapter: SourceAdapter, kind: str, keys: list[str]) -> Scorecard:
    """Run one evaluation of `adapter` for `kind` over `keys`."""
    t0 = time.time()
    try:
        res = adapter.fetch_sample(kind, keys)
    except Exception as e:
        return Scorecard(adapter.id, kind, error=str(e)[:300], sample_n=len(keys),
                         quality_score=0.0, detail={"stage": "fetch"})
    latency = res.latency_ms if res.latency_ms is not None else (time.time() - t0) * 1000
    if res.error:
        return Scorecard(adapter.id, kind, error=res.error[:300], latency_ms=round(latency, 1),
                         rate_ok=not res.rate_limited, sample_n=len(keys), quality_score=0.0)

    if not res.records:
        # A silent empty response (no exception, no error string) is a broken
        # source, not a "middling" one — score it like the error/exception
        # paths above, not with the neutral completeness/sanity defaults
        # further down (those exist for "not applicable to this kind", e.g.
        # sanity on NEWS text fields, not for "no data at all").
        return Scorecard(adapter.id, kind, coverage_pct=0.0, latency_ms=round(latency, 1),
                         rate_ok=not res.rate_limited, sample_n=0, quality_score=0.0,
                         detail={"requested": len(keys), "returned": 0})

    requested = set(keys)
    got = {r.key for r in res.records if r.key in requested} if requested else {r.key for r in res.records}
    coverage = (len(got) / len(requested) * 100) if requested else (100.0 if res.records else 0.0)

    expected = [f.value if hasattr(f, "value") else f for f in EXPECTED_FIELDS.get(DataKind(kind), [])] \
        if kind in [k.value for k in DataKind] else []
    expected = EXPECTED_FIELDS.get(DataKind(kind), []) if kind in DataKind._value2member_map_ else []

    filled = total = sane = sane_total = 0
    for r in res.records:
        for f in expected:
            total += 1
            v = r.fields.get(f)
            if v not in (None, "", []):
                filled += 1
                if f in SANE:
                    sane_total += 1
                    lo, hi = SANE[f]
                    nv = _num(v)
                    if nv is not None and lo <= nv <= hi:
                        sane += 1
    completeness = (filled / total * 100) if total else None
    sanity = (sane / sane_total * 100) if sane_total else None
    fresh_days = _freshness_days(res.records)

    parts = {
        "coverage": coverage,
        "completeness": completeness if completeness is not None else 60.0,
        "sanity": sanity if sanity is not None else 70.0,
        "freshness": _freshness_score(fresh_days, kind),
        "latency": _latency_score(latency),
    }
    quality = round(sum(WEIGHTS[k] * v for k, v in parts.items()), 1)

    return Scorecard(
        source_id=adapter.id, kind=kind,
        coverage_pct=round(coverage, 1),
        completeness_pct=round(completeness, 1) if completeness is not None else None,
        sanity_pct=round(sanity, 1) if sanity is not None else None,
        freshness_days=fresh_days, latency_ms=round(latency, 1),
        rate_ok=not res.rate_limited, sample_n=len(res.records),
        quality_score=quality, detail={"requested": len(requested), "returned": len(res.records),
                                       "subscores": {k: round(v, 1) for k, v in parts.items()},
                                       "license": adapter.license.value, "public_safe": adapter.public_safe()},
    )
