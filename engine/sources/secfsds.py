"""SEC Financial Statement Data Sets — a POINT-IN-TIME list of who was filing.

The backtest's biggest documented gap is survivorship bias: the stock universe is
built from `company_tickers.json`, which lists CURRENT registrants only. A company
that delisted, was acquired, or went bankrupt before we started ingesting is not
in `securities` at all — so it is absent from every historical rebalance date too.
Losers disappear; winners remain. Every backtest number is flattered by an unknown
amount, and "unknown" is the problem: nothing in the system can currently say
whether the effect is 2% or 40%.

This module answers that, using the SEC's quarterly Financial Statement Data Sets
(public domain, no key). Each quarterly ZIP contains `sub.txt` — one row per
submission, with the filer's CIK — which is exactly a snapshot of who was filing
in that quarter. Comparing that set against `securities.cik` measures the hole
directly rather than estimating it.

The raw comparison overstates it, though: plenty of periodic filers are closed-end
funds, ABS trusts and blank-check shells that were never candidates for a stock
ranking, so counting them as "missing" measures the wrong thing. The headline is
therefore taken over operating companies only (non-operating SIC codes dropped),
with the unfiltered figure reported alongside as an explicit upper bound.

MEASURE FIRST. Actually closing the gap means backfilling delisted CIKs
(companyfacts still serves them — EDGAR keeps a CIK forever) plus their price
history, which is a substantial piece of work and depends on whether the price
source covers delisted tickers. Doing that before knowing the size would be
building on a guess.

  python -m engine.sources.secfsds coverage --year 2024 --quarter 3
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import zipfile

import requests

FSDS_URL = ("https://www.sec.gov/files/dera/data/financial-statement-data-sets/"
            "{year}q{quarter}.zip")
_TIMEOUT = 120

# Periodic reports only — the same forms the ingest path cares about. A company
# that filed only an 8-K that quarter isn't evidence of an ingestible filer.
PERIODIC_FORMS = frozenset({"10-K", "10-Q", "20-F", "40-F"})

# Registrants that file periodic reports but were never candidates for a stock
# ranking: funds, asset-backed trusts and blank-check shells. `securities` is
# built from ticker-bearing operating companies, so counting these as "missing"
# would inflate the hole instead of measuring it — the raw filer count is an
# upper bound, not the answer.
NON_OPERATING_SIC = {
    "6189": "asset-backed securities (trusts, no equity)",
    "6722": "open-end investment offices (mutual funds)",
    "6726": "investment offices NEC (closed-end funds, ETFs, unit trusts)",
    "6770": "blank checks (SPACs and shells)",
}
# A registrant with no SIC is almost always a trust or shell too, but that is a
# weaker inference than an explicit code, so it is counted and reported apart.
_BLANK_SIC = {"", "0000", "0"}


def _headers() -> dict:
    from ..config import sec_user_agent
    return {"User-Agent": sec_user_agent(), "Accept-Encoding": "gzip, deflate"}


def filer_ciks(year: int, quarter: int,
               forms: frozenset[str] | None = PERIODIC_FORMS) -> tuple[dict[str, set[int]], dict]:
    """CIKs that filed in `year`Q`quarter`. Returns ({"all", "operating"}, stats).

    "operating" drops funds, ABS trusts and blank-check shells by SIC — the set
    that is actually comparable to a ticker-bearing stock universe. A CIK counts
    as operating if ANY of its rows that quarter carries a rankable SIC, so a
    registrant with mixed rows isn't discarded on its worst one.

    Columns are looked up BY NAME from sub.txt's header rather than by position —
    the layout has changed across years, and a positional read would silently
    return garbage rather than fail.
    """
    url = FSDS_URL.format(year=year, quarter=quarter)
    r = requests.get(url, headers=_headers(), timeout=_TIMEOUT)
    r.raise_for_status()
    stats: dict = {"url": url, "bytes": len(r.content)}

    with zipfile.ZipFile(io.BytesIO(r.content)) as z:
        name = next((n for n in z.namelist() if n.lower().endswith("sub.txt")), None)
        if not name:
            raise RuntimeError(f"no sub.txt in {url} (members: {z.namelist()[:8]})")
        with z.open(name) as fh:
            rdr = csv.reader(io.TextIOWrapper(fh, encoding="utf-8", errors="replace"),
                             delimiter="\t")
            header = next(rdr)
            try:
                i_cik, i_form = header.index("cik"), header.index("form")
            except ValueError as e:
                raise RuntimeError(f"sub.txt header missing cik/form: {header[:12]}") from e
            # `sic` is not load-bearing the way cik/form are: without it the
            # headline just falls back to the raw upper bound, which the digest
            # then says out loud rather than quietly passing off as refined.
            i_sic = header.index("sic") if "sic" in header else None
            need = max(i_cik, i_form, i_sic if i_sic is not None else 0)

            ciks: set[int] = set()
            operating: set[int] = set()
            blank_sic: set[int] = set()
            rows = kept = 0
            for row in rdr:
                rows += 1
                if len(row) <= need:
                    continue
                if forms is not None and row[i_form].strip().upper() not in forms:
                    continue
                try:
                    cik = int(row[i_cik])
                except ValueError:
                    continue
                ciks.add(cik)
                kept += 1
                if i_sic is None:
                    operating.add(cik)
                    continue
                sic = row[i_sic].strip().lstrip("0").rjust(4, "0") if row[i_sic].strip() else ""
                if sic in _BLANK_SIC:
                    blank_sic.add(cik)
                elif sic not in NON_OPERATING_SIC:
                    operating.add(cik)

    stats.update({"submissions": rows, "periodic_submissions": kept,
                  "distinct_ciks": len(ciks), "operating_ciks": len(operating),
                  "excluded_non_operating": len(ciks) - len(operating),
                  "excluded_blank_sic": len(blank_sic - operating),
                  "sic_available": i_sic is not None})
    return {"all": ciks, "operating": operating}, stats


def coverage(year: int, quarter: int) -> dict:
    """How much of that quarter's filer population is missing from `securities`?

    The missing set is the survivorship hole for any rebalance date in that
    quarter: companies that demonstrably existed and filed then, which the
    backtest cannot see because they aren't in the universe now.
    """
    from .. import db

    out: dict = {"year": year, "quarter": quarter}
    try:
        sets, stats = filer_ciks(year, quarter)
    except Exception as e:  # noqa: BLE001 — a probe reports failure, never raises
        out["error"] = f"{type(e).__name__}: {e}"[:300]
        return out
    out.update(stats)
    theirs, theirs_all = sets["operating"], sets["all"]

    if not db.have_db():
        out["note"] = "DATABASE_URL not set — cannot compare against securities"
        return out
    with db.connect() as conn, conn.cursor() as cur:
        cur.execute("select cik from securities where cik is not null and cik <> ''")
        ours = set()
        for (c,) in cur.fetchall():
            try:
                ours.add(int(c))
            except (TypeError, ValueError):
                continue

    missing = theirs - ours
    missing_all = theirs_all - ours
    out.update({
        "universe_ciks": len(ours),
        # THE number: of the operating companies filing periodic reports back
        # then, what share is invisible to the backtest today?
        "filed_that_quarter": len(theirs),
        "covered": len(theirs & ours),
        "missing_from_universe": len(missing),
        "survivorship_hole_pct": round(100 * len(missing) / len(theirs), 1) if theirs else None,
        # The unfiltered comparison, kept so the refinement is auditable rather
        # than something you have to take on trust — it is an UPPER BOUND, since
        # its denominator counts funds and trusts we would never have ranked.
        "filed_that_quarter_all": len(theirs_all),
        "missing_from_universe_all": len(missing_all),
        "survivorship_hole_pct_all_filers":
            round(100 * len(missing_all) / len(theirs_all), 1) if theirs_all else None,
        "sample_missing_ciks": sorted(missing)[:20],
    })
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="engine.sources.secfsds")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("coverage", help="measure the survivorship hole for one quarter")
    p.add_argument("--year", type=int, required=True)
    p.add_argument("--quarter", type=int, required=True, choices=[1, 2, 3, 4])
    p.add_argument("--out", default="", help="write the full JSON here instead of stdout")
    a = ap.parse_args(argv)

    res = coverage(a.year, a.quarter)
    blob = json.dumps(res, indent=2, default=str)
    # The tool owns its file rather than being `tee`d into one — a piped stdout is
    # block-buffered, so a summary printed "last" arrives first (learned the hard
    # way on the ESEF probe, 2026-08-03).
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(blob)
    else:
        print(blob)

    print("\n=== SURVIVORSHIP " + "=" * 50)
    if res.get("error"):
        print(f"  ERROR  {res['error']}")
        return 1
    if res.get("survivorship_hole_pct") is None:
        print(f"  {res.get('note') or 'no comparison available'}")
        return 0
    print(f"  quarter           {res['year']}Q{res['quarter']}")
    print(f"  filed back then   {res['filed_that_quarter']} operating companies "
          f"(periodic reports, funds/trusts/shells excluded by SIC)")
    print(f"  in our universe   {res['covered']}")
    print(f"  MISSING           {res['missing_from_universe']}"
          f"  ->  {res['survivorship_hole_pct']}% of that quarter's operating "
          f"filers are invisible to the backtest")
    print(f"  upper bound       {res['survivorship_hole_pct_all_filers']}% if you "
          f"count all {res['filed_that_quarter_all']} periodic filers "
          f"({res['excluded_non_operating']} dropped as non-operating)")
    if not res.get("sic_available"):
        print("  NOTE: sub.txt had no `sic` column, so NO filtering was applied — "
              "both figures above are the raw upper bound.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
