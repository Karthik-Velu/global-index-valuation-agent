"""Canonical identities for agent proposals (ADR-044).

The dedup key used to be the raw target string, so 'FRED', 'fred', 'fred_index'
and 'fred_idx' were four decisions, and declining one did not stop tomorrow's
synonym. The 31 Oct 2026 queue review measured it: 83 source rows were 28
provider-by-need ideas, and 73 KPI rows were 41 concepts. These functions reduce a
target to the decision it stands for:

  source_adapter   normalised provider @ need        source_adapter:fred@macro_fred
  catalog_kpi      concept @ broad sector            catalog_kpi:crop_yield@materials
  quality_check    the PROPOSED check, normalised    quality_check:revenue_tag_fallback

A KPI is scoped to its broad sector because one word names different measures in
different sectors (Telecom subscriber churn is not SaaS revenue churn). Sub-sectors
inside one sector merge as scopes of one decision.

Pure functions, stdlib only, so the agents, the backfill and the tests share one
set of rules.
"""
from __future__ import annotations

import re

from .sectoragent import sic_map


def _squash(s: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (s or "").lower())


def _tokens(s: str | None) -> list[str]:
    s = (s or "").replace("&", " and ")
    s = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", s)          # CropYield -> Crop Yield
    return [t for t in re.split(r"[^a-z0-9]+", s.lower()) if t]


def _singular(t: str) -> str:
    return t[:-1] if len(t) > 3 and t.endswith("s") and not t.endswith(("ss", "us", "is", "ies")) else t


def _dedup(items) -> list:
    out = []
    for i in items:
        if i and i not in out:
            out.append(i)
    return out


# --------------------------------------------------------------------------- #
# providers
# --------------------------------------------------------------------------- #

# Words that name a product, a legal form or a transport, never the provider.
_PROVIDER_STOP = {"inc", "llc", "ltd", "gmbh", "plc", "co", "corp", "corporation",
                  "company", "the", "of", "api", "apis", "data", "dataset", "datasets",
                  "feed", "feeds", "index", "idx", "free", "tier", "rest", "service",
                  "services", "com", "io", "org", "net", "via", "official", "unofficial",
                  "v1", "v2", "v3"}

# The providers the 31 Oct queue spelled many ways, plus everything in the registry.
_PROVIDER_ALIASES_RAW = {
    "FRED": "fred", "ALFRED": "fred", "Federal Reserve Economic Data": "fred",
    "Federal Reserve Bank of St. Louis": "fred", "St. Louis Fed": "fred",
    "Alpha Vantage": "alpha_vantage",
    "Nasdaq Data Link": "nasdaq_data_link", "Quandl": "nasdaq_data_link",
    "ECB": "ecb", "European Central Bank": "ecb",
    "SEC": "sec", "SEC EDGAR": "sec", "EDGAR": "sec",
    "U.S. Securities and Exchange Commission": "sec",
    "Securities and Exchange Commission": "sec",
    "EDINET": "edinet", "Financial Services Agency of Japan": "edinet",
    "Japan Financial Services Agency": "edinet", "FSA Japan": "edinet",
    "World Bank": "world_bank", "World Bank Group": "world_bank",
    "IMF": "imf", "International Monetary Fund": "imf",
    "Bureau of Labor Statistics": "bls", "Bureau of Economic Analysis": "bea",
    "DBnomics": "dbnomics", "OECD": "oecd",
    "Yahoo": "yahoo", "Yahoo Finance": "yahoo", "yfinance": "yahoo",
    "Finnhub": "finnhub", "Financial Modeling Prep": "fmp", "FMP": "fmp",
    "EOD Historical Data": "eodhd", "EODHD": "eodhd", "Twelve Data": "twelve_data",
    "Tiingo": "tiingo", "SimFin": "simfin", "Stooq": "stooq",
    "Massive": "massive", "Polygon": "massive", "Polygon.io": "massive",
}


def _provider_core(s: str) -> str:
    s = re.sub(r"\([^)]*\)", " ", s or "")
    return "".join(t for t in _tokens(s) if t not in _PROVIDER_STOP)


_PROVIDER_ALIASES = {_provider_core(k): v for k, v in _PROVIDER_ALIASES_RAW.items()}
# Short aliases that are safe as a prefix ('ecbportalsdmx'); 'sec' and 'bea' are not.
_SHORT_PREFIX_OK = {"ecb", "imf", "fmp"}


def provider(name: str | None) -> str:
    """The provider a source belongs to, however the model spelled it.

    'FRED', 'fred_index', 'fred_idx' and 'Federal Reserve Bank of St. Louis' are all
    'fred'. A product suffix on a known provider ('alpha_vantage_fundamentals')
    still resolves to the provider. Idempotent: provider(provider(x)) == provider(x).
    """
    raw = name or ""
    cands = [_provider_core(raw)] + [_provider_core(i) for i in re.findall(r"\(([^)]*)\)", raw)]
    for c in cands:
        if c in _PROVIDER_ALIASES:
            return _PROVIDER_ALIASES[c]
    for c in cands:
        hits = [k for k in _PROVIDER_ALIASES
                if c.startswith(k) and (len(k) >= 4 or k in _SHORT_PREFIX_OK)]
        if hits:
            return _PROVIDER_ALIASES[max(hits, key=len)]
    return cands[0] or _squash(raw) or "unknown"


# --------------------------------------------------------------------------- #
# KPIs
# --------------------------------------------------------------------------- #

_KPI_STOP = {"ratio", "rate", "pct", "percent", "percentage", "total", "the", "of", "and",
             "metric", "kpi", "level"}
_KPI_SYN = {"avg": "average", "utilisation": "utilization", "util": "utilization",
            "rev": "revenue", "num": "count", "number": "count", "qty": "volume",
            "quantity": "volume"}


def _concept_raw(code: str | None) -> str:
    toks = [_singular(_KPI_SYN.get(t, t)) for t in _tokens(code)]
    return "_".join(t for t in toks if t not in _KPI_STOP)


# Synonyms of catalogue codes the agents kept re-proposing. Left side: a spelling;
# right side: the catalogue code it means. Both are normalised the same way.
_KPI_ALIASES_RAW = {
    "average_revenue_per_user": "arpu", "average_revenue_per_unit": "arpu",
    "average_revenue_per_account": "arpu",
    "net_subscriber_additions": "subscribers_net_adds", "net_adds": "subscribers_net_adds",
    "subscriber_additions": "subscribers_net_adds",
    "subscriber_churn": "churn_rate", "customer_churn": "churn_rate",
    "same_store_sales": "comparable_store_sales_growth",
    "same_store_sales_growth": "comparable_store_sales_growth",
    "comparable_sales": "comparable_store_sales_growth",
    "comparable_sales_growth": "comparable_store_sales_growth",
    "like_for_like_sales": "comparable_store_sales_growth",
    "return_on_invested_capital": "roic",
    "research_and_development_intensity": "rd_intensity", "r_and_d_intensity": "rd_intensity",
    "rd_to_revenue": "rd_intensity",
    "funds_from_operations": "ffo_per_share", "aisc": "all_in_sustaining_cost",
    "capital_expenditure": "capex", "nim": "net_interest_margin",
    "days_inventory_outstanding": "inventory_and_days", "inventory_days": "inventory_and_days",
    "noi_growth": "same_store_noi_growth", "order_book": "order_backlog",
}
_KPI_ALIASES = {_concept_raw(k): _concept_raw(v) for k, v in _KPI_ALIASES_RAW.items()}


def kpi_concept(code: str | None) -> str:
    """The concept a KPI code names: 'Capacity-Utilisation', 'capacity_utilization_rate'
    and 'capacity_utilization' are one concept; 'average_revenue_per_user' is 'arpu'."""
    c = _concept_raw(code)
    return _KPI_ALIASES.get(c, c) or "unnamed"


def resolve_kpi(code: str | None, catalogue_codes) -> str | None:
    """The existing catalogue code this KPI already is, or None if it is new."""
    codes = sorted(set(catalogue_codes or []))
    if code in codes:
        return code
    want = kpi_concept(code)
    for existing in codes:
        if kpi_concept(existing) == want:
            return existing
    return None


def kpi_need(code: str | None, need_ids) -> str | None:
    """The KPI-specific need ('kpi:warranty_cost_ratio') this code falls under, if any.
    A specific need outranks the generic sector-KPI ones, so parking one KPI holds."""
    want = kpi_concept(code)
    return next((n for n in sorted(need_ids or []) if n.startswith("kpi:")
                 and kpi_concept(n[4:]) == want), None)


def scope_list(payload: dict | None) -> list[str]:
    """The scopes a KPI payload DECLARES (merged scopes first, then the single field).
    An inferred scope is deliberately not here: it is a guess, kept apart."""
    p = payload or {}
    raw = p.get("scopes") or [p.get("applies_to") or p.get("sector")
                              or p.get("proposed_for_sub_sector")]
    return _dedup(s.strip() for item in raw if isinstance(item, str) for s in item.split(";"))


def sector_key(scope: str | None) -> str:
    """The broad sector a scope belongs to, as a key: 'Electronics' -> 'technology'."""
    s = (scope or "").strip()
    if not s or _squash(s) in {"all", "allsectors", "allsector"}:
        return "all"
    return "_".join(_tokens(sic_map.sector_of(s) or s)) or "all"


# --------------------------------------------------------------------------- #
# quality checks
# --------------------------------------------------------------------------- #

_CHECK_LEAD = {"check", "detect", "flag", "validate", "verify", "new", "add"}
_CHECK_TAIL = {"check", "validation", "validator", "detector", "detection", "guard",
               "rule", "test"}


def check_name(name: str | None) -> str:
    """A proposed check's name without the filler: 'check_missing_revenue_tags' and
    'missing_revenue_tag_validation' are one check."""
    toks = [_singular(t) for t in _tokens(name)]
    while toks and toks[0] in _CHECK_LEAD:
        toks.pop(0)
    while toks and toks[-1] in _CHECK_TAIL:
        toks.pop()
    return "_".join(toks) or "unnamed"


# --------------------------------------------------------------------------- #
# XBRL tags
# --------------------------------------------------------------------------- #

_NS = {"usgaap": "us-gaap", "gaap": "us-gaap", "ifrsfull": "ifrs-full", "ifrs": "ifrs-full",
       "dei": "dei", "srt": "srt"}
_TAG_RE = re.compile(r"^\s*(?:([A-Za-z][A-Za-z_ \-]*?)\s*[:_])?\s*([A-Z][A-Za-z0-9]+)\s*$")


def xbrl_tag(tag) -> str | None:
    """'us-gaap_Revenues', 'US-GAAP: Revenues' and 'Revenues' -> 'us-gaap:Revenues'.
    None for anything that is not one namespaced CamelCase concept."""
    m = _TAG_RE.match(str(tag or ""))
    if not m:
        return None
    ns = _NS.get(_squash(m.group(1) or "us-gaap"))
    return f"{ns}:{m.group(2)}" if ns else None


# --------------------------------------------------------------------------- #
# the key
# --------------------------------------------------------------------------- #

def canonical_key(kind: str, target: str, payload: dict | None = None,
                  need_id: str | None = None) -> str:
    p = payload or {}
    if kind == "source_adapter":
        src = p.get("source") if isinstance(p.get("source"), dict) else {}
        need = p.get("need") if isinstance(p.get("need"), dict) else {}
        nid = need_id or need.get("id") or p.get("need_id") or "any"
        return f"source_adapter:{provider(src.get('provider') or target)}@{nid}"
    if kind == "catalog_kpi":
        scopes = scope_list(p) or scope_list({"applies_to": p.get("inferred_scope")}) or [None]
        return f"catalog_kpi:{kpi_concept(target)}@{sector_key(scopes[0])}"
    if kind == "quality_check":
        return f"quality_check:{check_name(p.get('check_name') or target)}"
    return f"{kind}:{_squash(target) or 'unnamed'}"


def blocking_keys(key: str) -> list[str]:
    """Keys whose decline or park also blocks `key`. An unscoped KPI decision covers
    every sector: the legacy rows carry no scope, so their decline was a decline of
    the concept."""
    if key.startswith("catalog_kpi:") and not key.endswith("@all"):
        return [key, key.rsplit("@", 1)[0] + "@all"]
    return [key]


def merge_payload(kind: str, old: dict | None, new: dict | None) -> dict:
    """A re-proposal adds what it knows without discarding what is already there.
    For a KPI the declared scopes are unioned (so approval writes all of them) and
    only deterministically verified XBRL tags stay in xbrl_tags."""
    old, new = dict(old or {}), dict(new or {})
    out = dict(old)
    for k, v in new.items():
        if out.get(k) in (None, "", [], {}):
            out[k] = v
    if kind == "catalog_kpi":
        scopes = _dedup(scope_list(old) + scope_list(new))
        if scopes:
            out["scopes"] = scopes
            out["applies_to"] = "; ".join(scopes)
        verified = _dedup(t for p in (old, new) if p.get("xbrl_verified")
                          for t in p.get("xbrl_tags") or [])
        guessed = _dedup([t for p in (old, new) for t in p.get("proposed_tags") or []]
                         + [t for p in (old, new) if not p.get("xbrl_verified")
                            for t in p.get("xbrl_tags") or []])
        out["xbrl_tags"], out["xbrl_verified"] = verified, bool(verified)
        out["proposed_tags"] = [t for t in guessed if t not in verified]
    return out
