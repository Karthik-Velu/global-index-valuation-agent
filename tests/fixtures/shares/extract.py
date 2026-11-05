"""Trim cached SEC companyfacts into the share-census fixtures (S0, ADR-043).

companyfacts is public domain (EDGAR). The fixtures keep only what the census reads:
the engine/shares.py concepts and the concepts catalog.xbrl_tag_map() sends to the
metrics the census reproduces, in their original order (the legacy ingest keeps the
first fact per key, so concept order is part of the data). Each fact keeps the fields
the code reads; `frame` is dropped. Facts filed before FILED_SINCE are dropped too,
except where a golden needs the history: BRK's share and weighted-average facts (the
evidence for "no count and no weighted average after 2015") and all of SJ's (its 2022
6-K is fixed only on the earlier filings' evidence).

With --store-dump, it also trims a tierb-dump `shares_by_ticker` artifact (EDGAR rows
only) to the goldens, under the same filing-date cut, so the store-vs-simulation test
compares like with like.

Usage, from the repo root, once per refresh (needs a local companyfacts cache):
    python tests/fixtures/shares/extract.py CACHE_DIR [CACHE_DIR ...] [--store-dump PATH]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from engine import shares, sharescensus  # noqa: E402
from engine.sources import catalog  # noqa: E402

OUT = Path(__file__).resolve().parent / "companyfacts"
# The goldens of the S0 tests (plan, "S0 Share census", Tests).
GOLDEN = {"EMN": 915389, "FMC": 37785, "BABA": 1577552, "SJ": 1753673, "META": 1326801,
          "CRWV": 1769628, "BRK-B": 1067983, "MCD": 63908, "TSCO": 916365, "MBLY": 1910139,
          "AAL": 6201,
          # Magic Software Enterprises, the Magic-shaped IFRS issuer. The store lists
          # CIK 876779 as RMTHF; the S0 dump asked for MGIC and found no rows.
          "RMTHF": 876779}
KEEP_FIELDS = ("start", "end", "val", "accn", "fy", "fp", "form", "filed")
FILED_SINCE = "2022-01-01"
FULL_SHARE_HISTORY = {"BRK-B"}     # share and weighted-average facts of every date
FULL_HISTORY = {"SJ"}              # every fact of every date


def keep_concepts() -> set[str]:
    tagmap = catalog.xbrl_tag_map()
    out = {q for q in shares.CONCEPTS}
    for ns in ("us-gaap", "dei", "ifrs-full"):
        out |= {f"{ns}:{c}" for c, mc in tagmap.items() if mc in sharescensus.SIM_CODES}
    return out


def trim(facts: dict, keep: set[str], full_history: bool = False, since=FILED_SINCE) -> dict:
    out = {"cik": facts.get("cik"), "entityName": facts.get("entityName"), "facts": {}}
    history = set(shares.SHARE_CONCEPTS) | set(shares.WA_BASIC) if full_history else set()
    for ns, cs in (facts.get("facts") or {}).items():
        kept = {}
        for c, node in cs.items():
            q = f"{ns}:{c}"
            if q not in keep:
                continue
            units = {}
            for u, arr in (node.get("units") or {}).items():
                fs = [{k: f[k] for k in KEEP_FIELDS if k in f} for f in arr
                      if q in history or (f.get("filed") or "") >= since]
                if fs:
                    units[u] = fs
            if units:
                kept[c] = {"units": units}
        if kept:
            out["facts"][ns] = kept
    return out


def trim_dump(path: Path) -> None:
    d = json.loads(Path(path).read_text())
    tks = [t for t in d.get("tickers") or [] if t in GOLDEN]
    rows = [r for r in d["rows"] if r["ticker"] in GOLDEN and (
        r["ticker"] in FULL_SHARE_HISTORY | FULL_HISTORY or r["filed_date"] >= FILED_SINCE)]
    out = {"preset": d["preset"], "tickers": tks, "n_rows": len(rows), "truncated": False,
           "filed_since": FILED_SINCE, "rows": rows}
    dest = OUT.parent / "store_shares_by_ticker.json"
    dest.write_text(json.dumps(out, indent=0) + "\n")
    print(f"   store dump: {dest.name} {len(rows)} rows")


def main(argv) -> int:
    dirs = [a for a in argv if not a.startswith("--")]
    if "--store-dump" in argv:
        dump = argv[argv.index("--store-dump") + 1]
        dirs.remove(dump)
        trim_dump(Path(dump))
    idx = sharescensus.cache_index(dirs)
    keep = keep_concepts()
    OUT.mkdir(parents=True, exist_ok=True)
    for tk, cik in GOLDEN.items():
        if cik not in idx:
            print(f"   {tk}: CIK {cik} not in the cache")
            continue
        doc = trim(sharescensus.load_companyfacts(idx[cik]), keep, tk in FULL_SHARE_HISTORY,
                   "" if tk in FULL_HISTORY else FILED_SINCE)
        path = OUT / f"CIK{cik:010d}.json"
        path.write_text(json.dumps(doc, separators=(",", ":")) + "\n")
        print(f"   {tk}: {path.name} {path.stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
