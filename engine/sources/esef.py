"""filings.xbrl.org (ESEF / UKSEF) — pan-European IFRS fundamentals. (ADR-031)

The non-US fundamentals gap has exactly one licence-clean answer per jurisdiction:
the regulator's own filings. This is the European half of that — the same shape as
`edgar.py` is for the US, and chosen first for three concrete reasons:

  * ONE adapter buys 28 countries. AT BE CY CZ DK EE ES FI FR GB GR HR HU IS IT LT
    LU LV MT NL NO PL PT RO SE SI SK UA — roughly 25,000 annual report filings.
  * The licence is clean. Free, no key, and `redistribution_ok` in the source
    catalog: the underlying ESEF reports are public regulator filings, and the
    index itself is offered for reuse. Every broad commercial alternative
    (EODHD, FMP, Finnhub, Twelve Data, Marketstack, Tiingo, Yahoo) is
    personal-use-only on the tier we would actually use, which this product
    cannot ship on.
  * We already speak the taxonomy. ESEF mandates IFRS tagging, and
    `catalog._CANONICAL` already pins the `ifrs-full` concepts (Revenue,
    ProfitLoss, EquityAttributableToOwnersOfParent, ...) because 20-F/40-F
    foreign filers needed them. The extraction and scoring path downstream
    should work unchanged.

WHAT THIS DOES NOT SOLVE — read before planning on top of it. ESEF gives
fundamentals, not prices. Massive's grouped endpoint is
`/v2/aggs/grouped/locale/us/market/stocks/` — US locale only — so a European
company ingested here has revenue and earnings but NO price, and therefore no
P/E, no P/B, and no backtest. Fundamental growth, margins and returns-on-capital
all work; every price-derived signal does not. Closing that needs a separate
decision about a non-US price licence (see ADR-031).

Annual consolidated only — ESEF is an annual-report regime, so there is no
quarterly cadence here the way EDGAR gives one.

  python -m engine.sources.esef probe            # learn/verify the live API shape
  python -m engine.sources.esef probe --countries FI,FR,DE --limit 5
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import requests

from . import catalog

ESEF_BASE = os.getenv("ESEF_BASE", "https://filings.xbrl.org/api").rstrip("/")
# Report URLs come back RELATIVE ("/549300.../2021-12-31/ESEF/SE/1/....zip"), so
# they need the site root, not the /api root. Measured from run 1 of the probe,
# which failed on exactly this and is the reason the probe exists.
ESEF_SITE = os.getenv("ESEF_SITE", "https://filings.xbrl.org").rstrip("/")
_TIMEOUT = 30


def _abs(url: str | None) -> str | None:
    if not url:
        return None
    return url if url.startswith("http") else f"{ESEF_SITE}/{url.lstrip('/')}"

# The provider asks heavy users to identify themselves rather than blocking them,
# so we do, using the same descriptive-agent convention EDGAR requires.
_UA = os.getenv("ESEF_USER_AGENT") or os.getenv("SEC_USER_AGENT") or \
    "global-index-valuation-agent (contact via repository issues)"


def _get(path: str, params: dict | None = None) -> dict:
    r = requests.get(f"{ESEF_BASE}/{path.lstrip('/')}", params=params or {},
                     headers={"Accept": "application/json", "User-Agent": _UA},
                     timeout=_TIMEOUT)
    r.raise_for_status()
    return r.json()


def list_filings(country: str | None = None, limit: int = 10,
                 include_entity: bool = True) -> tuple[list[dict], list[dict]]:
    """One page of the filing index. Returns (filings, included).

    JSON:API, so `data` carries the filings and `included` the related entities.
    Deliberately does not assume which attributes exist — `probe` reports the
    real key set, because building a parser against a guessed shape is how you
    ship something that fails only in CI.
    """
    # Newest first. The default order returned 2020-2022 filings from UA/SE/PL,
    # which is a fine smoke test and a bad basis for judging current coverage.
    params: dict = {"page[size]": max(1, min(limit, 100)), "sort": "-date_added"}
    if include_entity:
        params["include"] = "entity"
    if country:
        params["filter[country]"] = country
    doc = _get("filings", params)
    return doc.get("data") or [], doc.get("included") or []


def _entity_index(included: list[dict]) -> dict[str, dict]:
    return {e.get("id"): (e.get("attributes") or {})
            for e in included if e.get("type") == "entity"}


def _entity_of(filing: dict, idx: dict[str, dict]) -> dict:
    rel = ((filing.get("relationships") or {}).get("entity") or {}).get("data") or {}
    return idx.get(rel.get("id"), {})


def _facts_from_xbrl_json(url: str) -> dict:
    """Concept -> count, from an xBRL-JSON report if the index offers one.

    xBRL-JSON means we never parse iXBRL ourselves. Whether it is actually
    populated for real filings is the single most important unknown about this
    source, which is why the probe measures it rather than assuming it.
    """
    r = requests.get(url, headers={"User-Agent": _UA}, timeout=_TIMEOUT)
    r.raise_for_status()
    doc = r.json()
    counts: dict[str, int] = {}
    for f in (doc.get("facts") or {}).values():
        concept = ((f.get("dimensions") or {}).get("concept") or "")
        if concept:
            counts[concept.split(":")[-1]] = counts.get(concept.split(":")[-1], 0) + 1
    return counts


def probe(countries: list[str] | None = None, limit: int = 5) -> dict:
    """Answer the three questions that decide whether this source is usable.

    1. Does the index respond, and what attributes does a filing actually carry?
    2. Is there a machine-readable report (xBRL-JSON) or only an iXBRL package?
    3. Do the facts use the IFRS concepts `catalog.xbrl_tag_map()` already knows?

    (3) is the one that matters: if the concepts line up, the whole extraction
    and scoring path downstream works unchanged and this is mostly plumbing. If
    they don't, ESEF needs its own tag map and the estimate changes.
    """
    out: dict = {"base": ESEF_BASE, "countries": {}, "errors": []}
    known = catalog.xbrl_tag_map()          # concept (no prefix) -> metric_code

    try:
        data, included = list_filings(limit=limit)
    except Exception as e:  # noqa: BLE001 — a probe reports failure, never raises
        out["errors"].append(f"index unreachable: {type(e).__name__}: {e}"[:300])
        return out

    out["filing_attribute_keys"] = sorted((data[0].get("attributes") or {}).keys()) if data else []
    out["included_types"] = sorted({i.get("type") for i in included})

    idx = _entity_index(included)
    samples = []
    for f in data[:limit]:
        a = f.get("attributes") or {}
        ent = _entity_of(f, idx)
        samples.append({
            "country": a.get("country"), "period_end": a.get("period_end"),
            "entity": ent.get("name"),
            # NOT always an LEI: Ukrainian filings carry an 8-digit EDRPOU code
            # here. Anything joining on this needs to cope with both.
            "identifier": ent.get("identifier"),
            # Whichever of these exists is how we fetch the actual numbers.
            "json_url": _abs(a.get("json_url")), "package_url": _abs(a.get("package_url")),
            "report_url": _abs(a.get("report_url")), "error_count": a.get("error_count"),
        })
    out["samples"] = samples
    # How often is the easy path available? Cloetta (SE) had a package but no
    # json_url, so this ratio decides whether an iXBRL parser is optional or
    # mandatory — a bigger question than any single filing answers.
    out["json_url_available"] = f"{sum(1 for s in samples if s['json_url'])}/{len(samples)}"

    # The decisive check: pull a report and see how many of its concepts we
    # already map. Try each candidate rather than only the first, so one bad
    # filing can't blank the answer we came here for.
    targets = [s for s in samples if s.get("json_url")]
    if not targets:
        out["xbrl_json"] = "no json_url on any sampled filing — iXBRL parsing required"
    for t in targets:
        try:
            counts = _facts_from_xbrl_json(t["json_url"])
        except Exception as e:  # noqa: BLE001
            out["errors"].append(f"xbrl-json {t['json_url'][-60:]}: {type(e).__name__}: {e}"[:240])
            continue
        hits = {c: known[c] for c in counts if c in known}
        out["xbrl_json"] = {
            "url": t["json_url"], "entity": t["entity"], "country": t["country"],
            "distinct_concepts": len(counts), "total_facts": sum(counts.values()),
            "concepts_we_already_map": len(hits),
            "mapped": dict(sorted(hits.items())),
            "top_unmapped": sorted(
                ((c, n) for c, n in counts.items() if c not in known),
                key=lambda x: -x[1])[:25],
        }
        break

    for c in (countries or ["FI", "FR", "DE", "NL", "SE", "GB", "IT", "ES"]):
        try:
            rows, _ = list_filings(country=c, limit=1, include_entity=False)
            out["countries"][c] = "ok" if rows else "no filings returned"
        except Exception as e:  # noqa: BLE001
            out["countries"][c] = f"error: {type(e).__name__}"
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="engine.sources.esef")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe", help="verify the live API shape and IFRS concept overlap")
    p.add_argument("--countries", default="", help="comma-separated ISO-2 codes")
    p.add_argument("--limit", type=int, default=5)
    a = ap.parse_args(argv)

    if a.cmd == "probe":
        res = probe([c.strip().upper() for c in a.countries.split(",") if c.strip()] or None,
                    limit=a.limit)
        print(json.dumps(res, indent=2, default=str))
        # A probe that cannot reach the index is a failed probe; a probe that
        # reaches it and finds an awkward shape is a SUCCESSFUL probe with a
        # useful answer, so only the former is a non-zero exit.
        return 1 if any("unreachable" in e for e in res.get("errors", [])) else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
