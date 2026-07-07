"""SEC EDGAR — public-domain US stock fundamentals (no key).

Two entry points:
  * EdgarAdapter  — lightweight FUNDAMENTALS source the ingestion agent can probe.
  * ingest_tickers() — the real ingestion: pulls companyfacts XBRL, extracts every
    catalogued in_xbrl metric (universal + sector-specific) across all periods, and
    writes them to Postgres point-in-time (filed_date + form + accession), keeping
    restatement vintages. This is what fills the cloud DB with stock-level data.

EDGAR is public domain and redistribution-safe — the license-clean answer to the
US fundamentals gap. SEC asks for a descriptive User-Agent (set SEC_USER_AGENT).
"""
from __future__ import annotations

import os
import time

import requests

from . import catalog
from .base import DataKind, License, Record, SampleResult, SourceAdapter

_UA = os.getenv("SEC_USER_AGENT", "global-index-valuation-agent research contact@example.com")
_HEADERS = {"User-Agent": _UA, "Accept-Encoding": "gzip, deflate"}
_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
_FACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik:010d}.json"

_AUDITED_FORMS = {"10-K", "10-K/A", "20-F", "40-F"}

_cik_map: dict[str, dict] | None = None
_facts_cache: dict[int, dict] = {}


def _tickers() -> dict[str, dict]:
    """ticker (upper) -> {cik, title}."""
    global _cik_map
    if _cik_map is None:
        r = requests.get(_TICKERS_URL, headers=_HEADERS, timeout=20)
        r.raise_for_status()
        _cik_map = {row["ticker"].upper(): {"cik": int(row["cik_str"]), "title": row["title"]}
                    for row in r.json().values()}
    return _cik_map


def cik_for(ticker: str) -> int | None:
    info = _tickers().get(ticker.upper())
    return info["cik"] if info else None


def _companyfacts(cik: int, cache: bool = True) -> dict | None:
    """cache=False for bulk ingestion: caching every companyfacts JSON (1-10 MB
    each) OOM-killed the CI runner ~700 companies into the 3,000-company
    backfill. The cache serves the adapter's repeated small samples only."""
    if cik in _facts_cache:
        return _facts_cache[cik]
    r = requests.get(_FACTS_URL.format(cik=cik), headers=_HEADERS, timeout=30)
    if r.status_code != 200:
        return None
    data = r.json()
    if cache:
        _facts_cache[cik] = data
    return data


def _iter_facts(facts: dict, tagmap: dict[str, str]):
    """Yield (metric_code, ns, concept, unit, fact) for every catalogued concept."""
    for ns in ("us-gaap", "dei", "ifrs-full"):
        for concept, data in facts.get("facts", {}).get(ns, {}).items():
            mc = tagmap.get(concept)
            if not mc:
                continue
            for unit, arr in data.get("units", {}).items():
                for f in arr:
                    yield mc, ns, concept, unit, f


# --- the real ingestion (writes to Postgres) -------------------------------

def ingest_tickers(tickers: list[str], sector_by_ticker: dict | None = None,
                   sleep: float = 0.2, country_by_ticker: dict | None = None) -> dict:
    from .. import db

    tagmap = catalog.xbrl_tag_map()
    sector_by_ticker = sector_by_ticker or {}
    country_by_ticker = country_by_ticker or {}
    stats = {"securities": 0, "metrics": 0, "filings": 0, "missing": [], "errors": []}

    # Tier B (Parquet/DuckDB) writes, once the store exists — same rows, same
    # ON-CONFLICT-DO-NOTHING semantics (append_metrics anti-joins on the PK), so the
    # daily full companyfacts re-feed only lands genuinely new vintages. The writer
    # captures Tier B trouble (surfaced in stats), never letting it break ingestion.
    #
    # The CUTOVER is data-detected, not code-flagged: while Postgres still holds
    # fundamental_metrics rows we DUAL-write (transition); once the table has been
    # truncated (`engine.tierbsync cutover`), metric rows go to Tier B ONLY and
    # Postgres keeps just the small relational state (ADR-015). securities and
    # filings stay in Postgres either way.
    from .. import tierb
    writer = tierb.MetricWriter() if tierb.enabled() else None
    pg_metrics = True
    if writer is not None:
        try:
            with db.connect() as conn, conn.cursor() as cur:
                cur.execute("select exists (select 1 from fundamental_metrics)")
                pg_metrics = cur.fetchone()[0]
        except Exception:
            pg_metrics = True
        if not pg_metrics:
            stats["tierb_only"] = True

    for i, tk in enumerate(tickers, 1):
        if i % 250 == 0:
            print(f"   ingest progress: {i}/{len(tickers)} companies", flush=True)
        cik = cik_for(tk)
        if not cik:
            stats["missing"].append(tk)
            continue
        try:
            # slow network — done OUTSIDE any DB connection; cache=False keeps
            # memory flat across thousands of companies
            facts = _companyfacts(cik, cache=False)
        except Exception as e:
            stats["errors"].append(f"{tk}: {str(e)[:80]}")
            continue
        if not facts:
            stats["missing"].append(tk)
            continue

        # Build all rows in memory first (no DB held during the slow fetch above).
        # Then write with a SHORT-LIVED connection per company — long-lived connections
        # get dropped by the pooler across a 500-company run. Retry once on a drop;
        # isolate per-company errors so one blip can't kill the batch.
        for attempt in (1, 2):
            try:
                with db.connect() as conn, conn.cursor() as cur:
                    # country comes from the committed universe seed (foreign
                    # filers are 20-F/40-F ADRs — their EDGAR presence doesn't
                    # make them US companies); unmapped tickers default to US.
                    country = country_by_ticker.get(tk.upper()) or country_by_ticker.get(tk)
                    cur.execute(
                        """insert into securities (ticker, exchange, name, country, cik, kind, sector)
                           values (%s,'', %s, coalesce(%s,'United States'), %s, 'stock', %s)
                           on conflict (ticker, exchange) do update set cik=excluded.cik, name=excluded.name,
                             sector=coalesce(excluded.sector, securities.sector),
                             country=coalesce(%s, securities.country)
                           returning id""",
                        (tk.upper(), facts.get("entityName"), country, str(cik),
                         sector_by_ticker.get(tk), country),
                    )
                    sec_id = cur.fetchone()[0]

                    metric_rows: dict[tuple, tuple] = {}
                    filing_rows: dict[str, tuple] = {}
                    for mc, ns, concept, unit, f in _iter_facts(facts, tagmap):
                        end, filed = f.get("end"), f.get("filed")
                        if not end or not filed:
                            continue
                        fp = f.get("fp") or ""
                        form = f.get("form") or ""
                        accn = f.get("accn")
                        audited = form in _AUDITED_FORMS
                        key = (sec_id, end, fp, mc, "xbrl", filed)
                        metric_rows.setdefault(key, (
                            sec_id, end, fp, mc, f.get("val"), unit, form, audited, filed,
                            f"{ns}:{concept}"))
                        if accn and accn not in filing_rows:
                            filing_rows[accn] = (sec_id, form, end, fp, filed, accn, audited)

                    if metric_rows and pg_metrics:
                        cur.executemany(
                            """insert into fundamental_metrics
                               (security_id,period_end,fiscal_period,metric_code,value,unit,
                                report_type,audited,filed_date,raw_tag,source)
                               values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'xbrl')
                               on conflict do nothing""",
                            list(metric_rows.values()),
                        )
                    if filing_rows:
                        cur.executemany(
                            """insert into filings
                               (security_id,form,period_end,fiscal_period,filed_date,accession,audited,source)
                               values (%s,%s,%s,%s,%s,%s,%s,'edgar')
                               on conflict (security_id, accession) do nothing""",
                            list(filing_rows.values()),
                        )
                    conn.commit()
                stats["securities"] += 1
                stats["metrics"] += len(metric_rows)
                stats["filings"] += len(filing_rows)
                if writer is not None:
                    writer.add(v + ("xbrl",) for v in metric_rows.values())
                break  # success
            except Exception as e:
                if attempt == 2:
                    stats["errors"].append(f"{tk}: {str(e)[:80]}")
        time.sleep(sleep)  # SEC fair-use
    if writer is not None:
        writer.close()
        stats["tierb_metrics"] = writer.added
        if writer.error:
            stats["tierb_error"] = writer.error
            print(f"   WARNING: Tier B dual-write failed: {writer.error}")
    return stats


def recent_filer_ciks(days: int = 7) -> set[int]:
    """CIKs that filed ANYTHING in the last `days` calendar days, from EDGAR's
    public daily indexes (one small text file per business day). This is what
    makes daily ingestion INCREMENTAL: only companies with fresh filings get
    their companyfacts re-pulled, so runtime stays flat as the universe grows.
    Weekends/holidays 404 and are skipped."""
    import re
    from datetime import date, timedelta

    ciks: set[int] = set()
    today = date.today()
    for d in (today - timedelta(days=i) for i in range(days)):
        q = (d.month - 1) // 3 + 1
        url = (f"https://www.sec.gov/Archives/edgar/daily-index/{d.year}/QTR{q}/"
               f"company.{d:%Y%m%d}.idx")
        try:
            r = requests.get(url, headers=_HEADERS, timeout=30)
        except Exception:
            continue
        if r.status_code != 200:
            continue
        ciks.update(int(m) for m in re.findall(r"edgar/data/(\d+)/", r.text))
        time.sleep(0.1)  # SEC fair-use
    return ciks


# --- lightweight adapter for the data-ingestion agent ----------------------

class EdgarAdapter(SourceAdapter):
    id = "edgar"
    name = "SEC EDGAR (XBRL fundamentals)"
    provider = "SEC"
    kinds = (DataKind.FUNDAMENTALS,)
    markets = "US-listed companies (public domain); highest quality"
    license = License.PUBLIC_DOMAIN
    access_method = "rest_api"
    endpoint = "https://data.sec.gov"

    def fetch_sample(self, kind: str, keys: list[str]) -> SampleResult:
        t0 = time.time()
        recs, err = [], None
        for tk in keys:
            try:
                cik = cik_for(tk)
                if not cik:
                    continue
                facts = _companyfacts(cik)
                if not facts:
                    continue
                rev = _series(facts, "RevenueFromContractWithCustomerExcludingAssessedTax") or \
                    _series(facts, "Revenues")
                ni = _series(facts, "NetIncomeLoss")
                fields = {"rev_growth": _yoy(rev), "earnings_growth": _yoy(ni)}
                asof = max([p for p, _ in (rev or [])] or [None])
                if any(v is not None for v in fields.values()):
                    recs.append(Record(key=tk, fields=fields, asof=asof))
            except Exception as e:
                err = str(e)[:160]
        return SampleResult(self.id, kind, recs, latency_ms=(time.time() - t0) * 1000,
                            error=err if not recs else None)


def _series(facts: dict, concept: str):
    """Annual (FY, 10-K) values for a us-gaap concept as [(period_end, val), ...]."""
    node = facts.get("facts", {}).get("us-gaap", {}).get(concept)
    if not node:
        return None
    out = []
    for unit, arr in node.get("units", {}).items():
        for f in arr:
            if f.get("fp") == "FY" and f.get("form") in _AUDITED_FORMS and f.get("end"):
                out.append((f["end"], f.get("val")))
    return sorted(set(out)) if out else None


def _yoy(series):
    if not series or len(series) < 2:
        return None
    vals = [v for _, v in series if isinstance(v, (int, float))]
    if len(vals) < 2 or not vals[-2]:
        return None
    return round(vals[-1] / abs(vals[-2]) - 1.0, 4)
