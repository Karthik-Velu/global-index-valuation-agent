"""Stock-universe job — the committed seed + deterministic expansion (no LLM).

The universe is DATA in the repo (engine/sources/universe_stocks.json): curated
EDGAR-covered foreign stocks for the top-10 markets of Europe / Asia / rest of
world, plus a generated top-N US list. The pipeline reconciles the securities
table to this file, so the universe is reproducible from a fresh clone — the
original 501 lived only in the DB.

  python -m engine.universescan expand-us    # rank US filers by public float
                                             # (XBRL frames API) -> stocks_us
  python -m engine.universescan validate     # ingest the cross-region validation
                                             # batch + report core-metric coverage
  python -m engine.universescan coverage     # per-market coverage report (needs DB)

`expand-us` ranks by dei:EntityPublicFloat — the SEC's own dollar size measure
from 10-K covers — via the frames API (one request per quarter tried), falling
back to us-gaap:Revenues. Fully public-domain: no index membership lists (ADR-003),
no price feed needed.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import requests

SEED_PATH = Path(__file__).parent / "sources" / "universe_stocks.json"
_UA = os.getenv("SEC_USER_AGENT", "global-index-valuation-agent research contact@example.com")
_HEADERS = {"User-Agent": _UA, "Accept-Encoding": "gzip, deflate"}
_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/{tax}/{concept}/{unit}/{frame}.json"


def load_seed() -> dict:
    return json.loads(SEED_PATH.read_text())


def seed_stocks() -> dict[str, str]:
    """ticker -> country for the whole committed universe (foreign + US)."""
    seed = load_seed()
    out = {s["ticker"].upper(): s["country"] for s in seed.get("stocks_foreign", [])}
    out.update({s["ticker"].upper(): s.get("country", "United States")
                for s in seed.get("stocks_us", [])})
    return out


def _recent_frames() -> list[str]:
    """Instantaneous quarterly frame names, newest first (~2 years back)."""
    from datetime import date
    today = date.today()
    frames = []
    y, q = today.year, (today.month - 1) // 3 + 1
    for _ in range(9):
        q -= 1
        if q == 0:
            y, q = y - 1, 4
        frames.append(f"CY{y}Q{q}I")
    return frames


def _fetch_frame(tax: str, concept: str, unit: str, frame: str) -> list[dict]:
    r = requests.get(_FRAMES_URL.format(tax=tax, concept=concept, unit=unit, frame=frame),
                     headers=_HEADERS, timeout=60)
    if r.status_code != 200:
        return []
    return r.json().get("data", [])


def expand_us(n: int | None = None, write: bool = True) -> list[dict]:
    """Rank US filers by public float and write the top N into stocks_us."""
    from .sources import edgar

    seed = load_seed()
    n = n or int(seed.get("us_target", 1000))

    # Public float is filed once a year (10-K cover), so one quarterly frame only
    # holds a slice of the population — union the last ~6 quarters for everyone.
    # Score each CIK by the MEDIAN across its appearances: EntityPublicFloat is
    # self-tagged and scale errors run BOTH ways (a $3B float filed as $3T, and
    # MSFT's dropped as ~$3M in one frame) — min/max each get poisoned by one bad
    # tail; the median survives a single bad appearance, and the revenue
    # cross-check below catches filers whose every appearance is inflated.
    import statistics
    vals_by_cik: dict[int, list[float]] = {}
    frames_used: list[str] = []
    for frame in _recent_frames():
        rows = _fetch_frame("dei", "EntityPublicFloat", "USD", frame)
        if not rows:
            continue
        frames_used.append(frame)
        for r in rows:
            cik, val = int(r.get("cik", 0)), r.get("val")
            if cik and isinstance(val, (int, float)) and 0 < val < 1e13:
                vals_by_cik.setdefault(cik, []).append(float(val))
        if len(frames_used) >= 6:
            break
    used_frame = f"dei/EntityPublicFloat median over {frames_used}"
    by_cik = {cik: statistics.median(vals) for cik, vals in vals_by_cik.items()}
    if not by_cik:
        raise RuntimeError("no usable XBRL frame found (frames API unreachable?)")

    # Sanity layer: public float is self-tagged and some filers mis-scale it by
    # x1000 CONSISTENTLY (same filer software every year), which median-damping
    # can't catch — run 1 ranked $6B OLED above NVDA. Cross-check against an
    # independent size proxy: max(annual revenue, total assets / 10).
    #   * revenue comes from calendar-year duration frames — but June-FYE
    #     companies (MSFT, PG) never align to a CY frame, so
    #   * assets come from INSTANT frames (every filer has quarter-end balance
    #     sheets whatever its fiscal calendar), and assets/10 keeps the test
    #     meaningful for banks, whose assets dwarf their float.
    # float > 200x proxy -> thousands-scaled, divide by 1000; still implausible
    # or no proxy at all -> drop as garbage.
    from datetime import date
    proxy_by_cik: dict[int, float] = {}
    for concept in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"):
        for frame in (f"CY{y}" for y in range(date.today().year, date.today().year - 3, -1)):
            rows = _fetch_frame("us-gaap", concept, "USD", frame)
            if len(rows) > 1000:
                for r in rows:
                    cik, val = int(r.get("cik", 0)), r.get("val")
                    if cik and isinstance(val, (int, float)) and val > 0:
                        proxy_by_cik[cik] = max(proxy_by_cik.get(cik, 0.0), float(val))
                break
    assets_by_cik: dict[int, list[float]] = {}
    for frame in _recent_frames()[:5]:
        for r in _fetch_frame("us-gaap", "Assets", "USD", frame):
            cik, val = int(r.get("cik", 0)), r.get("val")
            if cik and isinstance(val, (int, float)) and val > 0:
                assets_by_cik.setdefault(cik, []).append(float(val))
    for cik, vals in assets_by_cik.items():
        proxy_by_cik[cik] = max(proxy_by_cik.get(cik, 0.0), statistics.median(vals) / 10)

    checked: dict[int, float] = {}
    n_descaled = n_dropped = 0
    for cik, f in by_cik.items():
        proxy = proxy_by_cik.get(cik)
        if not proxy:
            continue
        if f > 200 * proxy:
            f, n_descaled = f / 1000, n_descaled + 1
            if f > 200 * proxy:
                n_dropped += 1
                continue
        checked[cik] = f
    by_cik = checked
    print(f"   size-proxy cross-check: {len(by_cik):,} kept, "
          f"{n_descaled} de-scaled x1000, {n_dropped} dropped")

    # CIK -> ticker via SEC's own mapping; prefer the shortest ticker (primary
    # listing over share classes like BRK-B vs BRK-A ordering quirks).
    tickers = edgar._tickers()
    by_cik_ticker: dict[int, str] = {}
    for tk, info in tickers.items():
        c = info["cik"]
        if c not in by_cik_ticker or len(tk) < len(by_cik_ticker[c]):
            by_cik_ticker[c] = tk

    foreign = {s["ticker"].upper() for s in seed.get("stocks_foreign", [])}
    ranked = sorted(by_cik.items(), key=lambda kv: kv[1], reverse=True)
    out: list[dict] = []
    for cik, val in ranked:
        tk = by_cik_ticker.get(cik)
        if not tk or tk in foreign:
            continue
        out.append({"ticker": tk, "country": "United States"})
        if len(out) >= n:
            break

    print(f"== universescan expand-us ==\n   frame: {used_frame} ({len(by_cik):,} filers)"
          f"\n   selected top {len(out)} US tickers by public float"
          f"\n   top 10: {', '.join(s['ticker'] for s in out[:10])}")
    if write:
        seed["stocks_us"] = out
        SEED_PATH.write_text(json.dumps(seed, indent=2) + "\n")
        print(f"   wrote {SEED_PATH}")
    return out


def validate() -> dict:
    """ADR-011 validate-before-scale: ingest the committed cross-region validation
    batch, then report per-market core-metric coverage. Run in CI (needs DB)."""
    from . import quality
    from .sources import edgar

    seed = load_seed()
    batch = seed.get("validation_batch", [])
    countries = seed_stocks()
    print(f"== universescan validate — {len(batch)} companies across regions ==")
    stats = edgar.ingest_tickers(batch, country_by_ticker=countries)
    print(f"   ingest: {stats}")
    report = coverage()
    q = quality.run()
    return {"ingest": stats, "coverage": report,
            "quality_score": q["data_quality_score"]}


_COVERAGE_SQL = """
    select s.country, count(distinct s.id) as n,
           count(distinct s.id) filter (where fm.metric_code='total_revenue') as with_rev,
           count(distinct s.id) filter (where fm.metric_code='net_income') as with_ni
    from {securities} s
    left join fundamental_metrics fm on fm.security_id = s.id
    {where} group by s.country order by n desc"""


def coverage() -> list[dict]:
    """Per-market: how many securities, and what share resolve the core metrics
    (total_revenue + net_income)? This is the honest measure of whether IFRS
    mapping + ADR coverage actually deliver usable fundamentals per market.
    Reads Tier B when it's live and current (post-cutover Postgres has no rows)."""
    from . import db, tierb

    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select count(*) from fundamental_metrics")
        pg_n = cur.fetchone()[0]
        if tierb.enabled() and tierb.counts()["fundamental_metrics"] >= pg_n:
            duck = tierb.connect()
            cur.execute("select id, country from securities where cik is not null")
            duck.execute("create or replace temp table sec_live (id bigint, country varchar)")
            duck.executemany("insert into sec_live values (?, ?)", cur.fetchall())
            rows = duck.execute(_COVERAGE_SQL.format(securities="sec_live", where="")).fetchall()
            engine = "tierb"
        else:
            cur.execute(_COVERAGE_SQL.format(securities="securities",
                                             where="where s.cik is not null"))
            rows = cur.fetchall()
            engine = "postgres"
    out = []
    print(f"== per-market core-metric coverage ({engine}) ==")
    for country, ncomp, with_rev, with_ni in rows:
        out.append({"country": country, "companies": ncomp,
                    "with_revenue": with_rev, "with_net_income": with_ni})
        print(f"   {str(country):<22} {ncomp:>5}  revenue {with_rev:>5}  net_income {with_ni:>5}")
    return out


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(prog="engine.universescan", description="Stock-universe job")
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("expand-us", help="rank US filers by public float -> stocks_us")
    e.add_argument("--n", type=int, default=None, help="override us_target")
    e.add_argument("--dry-run", action="store_true", help="don't write the seed file")
    sub.add_parser("validate", help="ingest the validation batch + coverage report")
    sub.add_parser("coverage", help="per-market coverage report")
    a = p.parse_args()
    if a.cmd == "expand-us":
        expand_us(n=a.n, write=not a.dry_run)
    elif a.cmd == "validate":
        validate()
    elif a.cmd == "coverage":
        coverage()
