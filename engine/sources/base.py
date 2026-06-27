"""Source-adapter interface + the small value types the probe scores against.

Adapters are intentionally thin: given a few of our canonical universe keys, return
normalized `Record`s so the probe can measure coverage / completeness / sanity /
freshness without knowing anything source-specific.
"""
from __future__ import annotations

import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum


class DataKind(str, Enum):
    PRICE = "price"
    INDEX_VALUATION = "index_valuation"   # P/E, P/B, yield at index/ETF level
    FUNDAMENTALS = "fundamentals"         # stock-level financials/ratios/growth
    NEWS = "news"
    FX = "fx"
    MACRO = "macro"
    CORP_ACTIONS = "corp_actions"
    FILINGS = "filings"


class License(str, Enum):
    PUBLIC_DOMAIN = "public_domain"
    REDISTRIBUTION_OK = "redistribution_ok"
    PERSONAL_ONLY = "personal_only"
    PROHIBITED = "prohibited"
    UNKNOWN = "unknown"


# Licenses acceptable for a PUBLIC / potentially-commercial deployment.
PUBLIC_OK = {License.PUBLIC_DOMAIN, License.REDISTRIBUTION_OK}

# Fields the probe expects per kind, used to score completeness + sanity.
EXPECTED_FIELDS = {
    DataKind.PRICE: ["price"],
    DataKind.INDEX_VALUATION: ["pe", "pb", "ps", "dividend_yield"],
    DataKind.FUNDAMENTALS: ["pe", "pb", "rev_growth", "earnings_growth"],
    DataKind.NEWS: ["headline", "published"],
}


@dataclass
class Record:
    """One normalized observation, keyed by our canonical universe key."""
    key: str
    fields: dict = field(default_factory=dict)
    asof: str | None = None   # ISO date of the observation (for freshness)


@dataclass
class SampleResult:
    source_id: str
    kind: str
    records: list = field(default_factory=list)   # list[Record]
    latency_ms: float | None = None
    fetched_at: str | None = None
    error: str | None = None
    rate_limited: bool = False


class SourceAdapter(ABC):
    id: str = "base"
    name: str = "base"
    provider: str = ""
    kinds: tuple = ()                     # tuple[DataKind]
    markets: str = ""                     # human description of coverage
    license: License = License.UNKNOWN
    access_method: str = "rest_api"       # rest_api | bulk_file | scrape | rss
    endpoint: str = ""
    requires_key_env: str | None = None   # env var name if a free key is needed

    @abstractmethod
    def fetch_sample(self, kind: str, keys: list[str]) -> SampleResult:
        """Cheaply fetch a sample for the given canonical keys."""
        ...

    def available(self) -> bool:
        return self.requires_key_env is None or bool(os.getenv(self.requires_key_env))

    def public_safe(self) -> bool:
        return self.license in PUBLIC_OK

    def health(self, sample_keys: list[str]) -> dict:
        t0 = time.time()
        try:
            kind = self.kinds[0].value if self.kinds else "price"
            r = self.fetch_sample(kind, sample_keys[:3])
            return {"ok": r.error is None and bool(r.records),
                    "latency_ms": round((time.time() - t0) * 1000, 1), "error": r.error}
        except Exception as e:  # never let a bad source crash the agent
            return {"ok": False, "latency_ms": round((time.time() - t0) * 1000, 1), "error": str(e)[:200]}
