"""Share census (ADR-043, stage S0): measure, read-only, what every later stage of the
share-count fix would change, before any of it ships. A job: deterministic, no LLM.

One module, three modes:
  --cache DIR [--cache DIR]  local. companyfacts files named CIK##########.json[.gz]
                             (the probe cache). No SEC, no database. It tests the
                             logic; its sample leans towards the flagged issuers, so
                             its thresholds are advisory and never re-order the plan.
  --store                    CI. DATABASE_URL plus a read-only Tier B restore; no SEC.
                             What the store holds: today's resolved row, the live
                             numerator rows, the interim-guard projection (S3).
  --companyfacts             CI. As --store, plus fresh companyfacts for every CIK
                             (SEC_USER_AGENT, 5 requests a second or fewer): every
                             later stage's rules, reconciled against the store.

Today's row is reproduced with the code that computes it, not a copy: the ingest is
`edgar._iter_facts` with `catalog.xbrl_tag_map()` and the ingest key, the read is
`tierb.metrics_asof`, the pick is `stockvaluation._resolve_shares_concept` and the
`_nth_per_security` ordering, the annual net income is `growthhistory.annual_series`.
The accession-first count is `engine/shares.py`, the code S5 will ship.

Writes data/shares_census.json (sections A to M, thresholds T1 to T16) and
data/shares_census.csv (one row per security).

Licensing (plan rule 6): both files carry EDGAR data and aggregate counts only. Prices
are counted, never read as values (the picks liquidity gate reads the snapshot's market
cap in memory and only a count leaves). Massive splits are used in memory and reported
as counts: the per-ticker guard reasons are computed without them, and in the store
modes they steer `classify_accessions` exactly as S5 will, so a per-ticker count is
still an EDGAR value (as filed, or fixed by a power of 1,000) and no split ratio, date
or factor is written. `licence_check` refuses to write a file whose keys match the
rule-6 pattern.
"""
from __future__ import annotations

import argparse
import csv
import gzip
import json
import math
import re
import statistics
import sys
import time
from collections import Counter, defaultdict
from datetime import date, datetime, timezone
from pathlib import Path

from . import shares

OUT_DIR = Path("data")
OUT_NAME = "shares_census"
LICENCE_RE = re.compile(
    r"price|close|mcap|market_cap|split_from|split_to|execution_date|basis_|split_factor", re.I)

SIM_CODES = ("shares_outstanding", "net_income", "total_equity", "total_revenue",
             "operating_cash_flow")
OLD_CHECK_RATIO = 1.5            # quality.py check 7: max/min of one concept's values
GUARD_CONFLICT = 1.5             # S3 rule (a)
GUARD_OUTLIER = 3.0              # S3 rule (b)
GUARD_WINDOW_DAYS = 400          # S3 rule (b) neighbourhood
GUARD_SPLIT_TOL = 0.25           # a split explains a ratio within 25%
OUT_OF_BAND = 1.25               # D: live count against the same filing's W
BAND = (0.67, 1.5)               # E and S6 starting band for C/W
SCALE_SINCE = "2023-07-01"       # H
SPLITS_SINCE = "2023-01-01"      # J
SPLIT_TAG_DAYS = 400             # J: EDGAR split-ratio tags filed this recently
SEC_MIN_INTERVAL = 0.2           # 5 requests a second or fewer
UNIVERSE_HINT = 3100             # M: securities the S4 backfill covers
_SENTINEL = -1                    # a security id no real row carries
# The only two reads of Tier B prices: how many bars a security has, and when each bar
# was fetched. Neither selects a value column (a test runs both against a prices
# table that has none).
BAR_COUNT_SQL = "select security_id, count(*) from prices group by security_id"
# ingested_at is cast to a date in SQL: only the day is used, and fetching a timestamptz
# makes DuckDB import pytz, which pandas 3 no longer installs (the CI census would crash).
BAR_DATES_SQL = ("select security_id, date, cast(ingested_at as date) as ingested_at from prices "
                 "where security_id in (select unnest(?::bigint[]))")

LEGIT = {"in_band", "treasury_stock", "issuance", "up_c_nci", "split_after_period",
         "reverse_split_after_period", "partial_class", "post_period_reduction"}
ERRORS = {"scale_1000k", "ten_x_slip", "cso_equals_issued"}

CSV_COLUMNS = (
    "ticker", "cik", "security_id", "entity", "old_check_groups",
    "today_value", "today_concept", "today_period_end", "today_filed", "today_age_days",
    "sim_value", "sim_concept", "sim_period_end", "store_vs_sim",
    "new_value", "new_candidate", "new_concept", "new_count_date", "new_accession",
    "new_filed", "new_form", "new_verdict", "new_flags", "new_reason", "new_age_days",
    "collision_ratio", "wa_same_filing", "wa_newest_raw", "wa_newest_verdict",
    "wa_newest_period_end", "wa_fallback_value", "wa_fallback_period_end",
    "today_over_wa_newest", "band_cover", "band_cso", "band_csi", "band_label",
    "guard_edgar", "live_over_same_filing_wa", "newest_periodic_form", "ads_ratios",
    "reporting_currency", "edgar_split_ratio", "edgar_split_ratio_filed",
    "ni_concept", "ni_parent_gap", "ni_nci_share", "te_concept", "te_parent_gap",
    "te_nci_share", "diluted_over_basic", "fact_rows", "reasons")


# --- small helpers -------------------------------------------------------------

def _d(s) -> date:
    return s if isinstance(s, date) and not isinstance(s, datetime) else date.fromisoformat(str(s)[:10])


def _iso(v):
    if v is None:
        return None
    if hasattr(v, "isoformat"):
        return v.isoformat()[:10]
    return str(v)[:10]


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) or math.isinf(f) else f


def _ratio(a, b):
    a, b = _num(a), _num(b)
    return a / b if a is not None and b and b > 0 and a > 0 else None


def _pct(xs, q):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    i = min(len(xs) - 1, max(0, int(round(q * (len(xs) - 1)))))
    return round(xs[i], 4)


def _r(x, n=4):
    return None if x is None else round(x, n)


def licence_check(obj, path="$") -> None:
    """Rule 6: no key anywhere may name a price, a market cap or a Massive
    corporate-action field. Raises before anything is written."""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if LICENCE_RE.search(str(k)):
                raise ValueError(f"licence guard: key {path}.{k} matches the rule-6 pattern")
            licence_check(v, f"{path}.{k}")
    elif isinstance(obj, (list, tuple)):
        for i, v in enumerate(obj):
            licence_check(v, f"{path}[{i}]")


def load_companyfacts(path: Path) -> dict | None:
    """A cached companyfacts file: plain, gzipped, or gzipped twice."""
    raw = path.read_bytes()
    for _ in range(3):
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        else:
            break
    try:
        return json.loads(raw)
    except ValueError:
        return None


_CIK_FILE = re.compile(r"^CIK(\d{10})\.json(\.gz)*$")


def cache_index(dirs) -> dict[int, Path]:
    """cik -> file across the cache directories (the first directory wins)."""
    out: dict[int, Path] = {}
    for d in dirs:
        for p in sorted(Path(d).iterdir()):
            m = _CIK_FILE.match(p.name)
            if m:
                out.setdefault(int(m.group(1)), p)
    return out


# --- today's path, reproduced ----------------------------------------------------

def simulate_ingest(facts_list: list[dict], sid: int, tagmap: dict) -> list[tuple]:
    """The metric rows edgar.ingest_tickers would store for one security: the same
    iteration (`_iter_facts`), the same key (security, end, fp, metric, 'xbrl',
    filed) and the same first-write-wins. Facts of predecessor CIKs come first."""
    from .sources import edgar
    rows: dict[tuple, tuple] = {}
    for facts in facts_list:
        for mc, ns, concept, unit, f in edgar._iter_facts(facts, tagmap):
            if mc not in SIM_CODES:
                continue
            end, filed = f.get("end"), f.get("filed")
            if not end or not filed:
                continue
            fp, form = f.get("fp") or "", f.get("form") or ""
            rows.setdefault((end, fp, mc, filed), (
                sid, end, fp, mc, _num(f.get("val")), unit, form, form in edgar._AUDITED_FORMS,
                filed, f"{ns}:{concept}", "xbrl"))
    return list(rows.values())


def fm_frame(rows: list[tuple]):
    """FM_APPEND_COLUMNS tuples -> a DataFrame in tierb.FM_COLUMNS order."""
    import pandas as pd
    from . import tierb
    df = pd.DataFrame(rows, columns=list(tierb.FM_APPEND_COLUMNS))
    df["confidence"], df["ingested_at"] = None, None
    for c in ("period_end", "filed_date"):
        df[c] = pd.to_datetime(df[c])
    df["value"] = pd.to_numeric(df["value"], errors="coerce")
    return df[list(tierb.FM_COLUMNS)]


def _row(r) -> dict:
    return {"value": _num(r.value), "concept": r.raw_tag, "period_end": _iso(r.period_end),
            "filed": _iso(r.filed_date), "unit": r.unit}


def today_rows(con, asof, security_ids=None) -> dict[int, dict]:
    """Today's live rows per security, through the functions score_frame uses:
    {"shares", "equity", "net_income", "currency"}."""
    import pandas as pd
    from . import growthhistory, stockvaluation as sv, tierb
    rows = tierb.metrics_asof(_d(asof), metric_codes=list(SIM_CODES), security_ids=security_ids,
                              source="xbrl", con=con)
    out: dict[int, dict] = defaultdict(dict)
    if not rows:
        return out
    fm = pd.DataFrame(rows, columns=tierb.FM_COLUMNS)
    fm["period_end"] = pd.to_datetime(fm["period_end"])
    fm["filed_date"] = pd.to_datetime(fm["filed_date"])
    fm["value"] = pd.to_numeric(fm["value"], errors="coerce")

    inst = fm[fm["metric_code"].isin(sv.INSTANT_CODES)]
    shr = inst[inst["metric_code"] == "shares_outstanding"]
    if len(shr) and not (shr["raw_tag"] != sv._SHARES_ISSUED_TAG).any():
        # _resolve_shares_concept maps through the per-security "latest outstanding"
        # table, which pandas cannot build empty with datetime values. Over the whole
        # universe it never is; for a single issued-only security it would be. One
        # sentinel outstanding row under its own security id keeps the real function
        # on its normal path and changes no other security's result.
        sentinel = shr.iloc[:1].assign(security_id=_SENTINEL, raw_tag=shares.COVER, value=1.0)
        inst = pd.concat([inst, sentinel], ignore_index=True)
    inst = sv._resolve_shares_concept(inst)
    inst = inst[inst["security_id"] != _SENTINEL]
    res = inst[inst["metric_code"] == "shares_outstanding"]
    for sid, g in res.groupby("security_id"):
        out[int(sid)]["resolved"] = [(_iso(pe), _num(v)) for pe, v in zip(g["period_end"], g["value"])]
    latest = (inst.sort_values(["security_id", "metric_code", "period_end"])
                  .groupby(["security_id", "metric_code"], sort=False).tail(1))
    for r in latest.itertuples(index=False):
        out[int(r.security_id)]["shares" if r.metric_code == "shares_outstanding" else "equity"] = _row(r)

    flow = fm[fm["metric_code"].isin(sv.FLOW_CODES) & (fm["fiscal_period"] == "FY")]
    ni = (flow[flow["metric_code"] == "net_income"]
          .sort_values(["security_id", "metric_code", "period_end", "filed_date"]))
    ni_last = {(int(r.security_id), r.period_end): r for r in ni.itertuples(index=False)}
    placed = set()
    annual = growthhistory.annual_series(flow)
    if not annual.empty:
        recent = annual.sort_values("period_end").groupby("security_id").tail(2)
        for sid, g in recent.groupby("security_id"):
            # score_frame overwrites net_income for every security the clean series
            # holds, with NaN when neither recent year has one; the old pick never wins.
            placed.add(int(sid))
            g = g[g["net_income"].notna()]
            if g.empty:
                continue
            r = ni_last.get((int(sid), g["period_end"].iloc[-1]))
            if r is not None:
                out[int(sid)]["net_income"] = _row(r)
    if not ni.empty:
        fallback = ni.sort_values(["security_id", "metric_code", "period_end"]) \
                     .groupby(["security_id", "metric_code"], sort=False).tail(1)
        for r in fallback.itertuples(index=False):
            if int(r.security_id) not in placed:
                out[int(r.security_id)]["net_income"] = _row(r)
    rc = (flow[flow["metric_code"].isin(["total_revenue", "net_income"])]
          .sort_values(["period_end", "filed_date"]).groupby("security_id")["unit"].last())
    for sid, u in rc.items():
        out[int(sid)]["currency"] = u
    return out


def old_check(share_rows) -> int:
    """quality.py check 7 over one security's stored share rows: the number of
    (period_end, raw_tag) groups with two or more positive values over 1.5x apart."""
    groups = defaultdict(set)
    for pe, tag, v in share_rows:
        v = _num(v)
        if v is not None and v > 0:
            groups[(str(pe)[:10], tag)].add(v)
    return sum(1 for vs in groups.values() if len(vs) > 1 and max(vs) / min(vs) > OLD_CHECK_RATIO)


# --- per-security measures -------------------------------------------------------

def guard(live: dict, vintages: list[tuple], asof, splits=None, resolved=None) -> list[str]:
    """The S3 interim guard on today's row. vintages: (period_end, fp, raw_tag,
    value, filed) for every stored share row; resolved: (period_end, value) of the
    rows _resolve_shares_concept keeps as of asof (rule b's neighbours). splits:
    [(executed, factor)] in memory, or None for the EDGAR-only evaluation."""
    v = _num(live.get("value"))
    pe, tag, filed = live["period_end"], live["concept"], live["filed"]
    asof = _d(asof)
    reasons = []
    if v is None or v <= 0:
        return ["non_positive"]
    vis = [x for x in vintages if _d(x[4]) <= asof]
    same = [(x[3], x[4]) for x in vis if str(x[0])[:10] == pe and x[2] == tag and (x[3] or 0) > 0]
    if same:
        lo, hi = min(same), max(same)
        if hi[0] / lo[0] > GUARD_CONFLICT and not _split_explains(
                hi[0] / lo[0], splits, min(lo[1], hi[1]), max(lo[1], hi[1])):
            reasons.append("conflict")
    neigh = [v_ for d_, v_ in (resolved or [])
             if v_ and v_ > 0 and 0 < (_d(pe) - _d(d_)).days <= GUARD_WINDOW_DAYS]
    if neigh:
        m = statistics.median(neigh)
        r = v / m
        # a future-dated cover (AAL) must not reach splits executed after asof
        hi = min(_d(pe), asof)
        if (r > GUARD_OUTLIER or r < 1 / GUARD_OUTLIER) and not _split_explains(
                r, splits, date.fromordinal(_d(pe).toordinal() - GUARD_WINDOW_DAYS), hi):
            reasons.append("outlier")
    if splits:
        basis = pe if tag == shares.COVER else filed
        if any(_d(basis) < _d(ex) <= asof for ex, _ in splits):
            reasons.append("after_split")
    return reasons


def _split_explains(ratio, splits, lo, hi) -> bool:
    """A cumulative factor of the splits executed in (lo, hi] explains the ratio."""
    return any(abs(ratio / t - 1) <= GUARD_SPLIT_TOL
               for k in shares._split_factors(splits, lo, hi) for t in (k, 1 / k))


def _newest_periodic(verdicts):
    acc = {}
    for r in verdicts:
        if r["form"] in shares.PERIODIC_FORMS:
            acc.setdefault(r["accession"], {})[r["candidate"]] = r
    order = sorted(acc, key=lambda a: (next(iter(acc[a].values()))["filed_date"], a))
    return order, acc


def band_measures(verdicts, rows) -> dict:
    """E: the newest periodic accession's cover, CSO and CSI over its validated W,
    each out-of-band case labelled against the scale-error policy table."""
    order, acc = _newest_periodic(verdicts)
    out = {"band_cover": None, "band_cso": None, "band_csi": None, "band_label": None,
           "band_cases": []}
    if not order:
        return out
    a = order[-1]
    c = acc[a]
    wr = c.get("wa_basic")
    w = wr["value_clean"] if wr else None
    if not w:
        if any(k in c for k in shares.COUNT_ORDER):
            out["band_label"] = "wa_rejected" if wr else "no_wa"
        return out
    prev = None
    for b in reversed(order[:-1]):
        pw = acc[b].get("wa_basic")
        if pw and pw["value_clean"]:
            prev = (acc[b], pw["value_clean"])
            break
    facts = [r for r in rows if r["accession"] == a]
    split_tags = [r["value"] for r in facts if r["concept"] == shares.SPLIT_RATIO_TAG and r["value"]]
    nci = _nci_equity_share(facts)
    labels = []   # the security's label comes from the cover and CSO; issued is last anyway
    for name, col in (("cover", "band_cover"), ("bs", "band_cso"), ("bs_issued", "band_csi")):
        r = c.get(name)
        if not r or not r["value_raw"]:
            continue
        q = r["value_raw"] / w
        out[col] = _r(q)
        lab = _band_label(name, r, q, c, w, prev, split_tags, nci)
        if name != "bs_issued":
            labels.append(lab)
        if lab != "in_band":
            out["band_cases"].append({"candidate": name, "ratio": _r(q), "label": lab})
    bad = [x for x in labels if x != "in_band"]
    out["band_label"] = bad[0] if bad else ("in_band" if labels else None)
    return out


def _near(x, t, tol):
    return t and abs(x / t - 1) <= tol


def _band_label(name, r, q, c, w, prev, split_tags, nci) -> str:
    """The scale-error policy table, row by row. Issued may sit above W by treasury
    stock; everything else is judged against the 0.67 to 1.5 band."""
    lo, hi = BAND
    fix = shares.BANDS["fix"]
    upper = shares.BANDS["issued_upper"] if name == "bs_issued" else fix[1]
    if lo <= q <= hi:
        return "in_band"
    k = round(math.log10(q) / 3)
    if k and fix[0] <= q / 1000 ** k <= upper:
        return "scale_1000k"
    if name == "bs_issued" and hi < q <= 10:
        return "treasury_stock"
    if r.get("reason") == "cso_equals_issued":
        return "cso_equals_issued"
    if _near(q, 0.1, 0.03) or _near(q, 10, 0.03):
        return "ten_x_slip"
    for s_ in split_tags:
        if any(lo <= x <= hi for x in (q / s_, q * s_)):
            return "split_after_period" if q > hi else "reverse_split_after_period"
    if q > hi:
        if nci is not None and nci >= 0.02:
            return "up_c_nci"
        if prev:
            pc = next((prev[0][n] for n in shares.COUNT_ORDER
                       if n in prev[0] and prev[0][n]["value_clean"]), None)
            if w >= 1.15 * prev[1] or (pc and r["value_raw"] >= 1.25 * pc["value_clean"]):
                return "issuance"
        return "unexplained"
    # below band
    cso = c.get("bs")
    if name == "cover" and cso and cso["value_raw"]:
        cq = cso["value_raw"] / w
        if lo <= cq <= hi:
            return "post_period_reduction"
        if cq < lo:
            return "partial_class"
    if prev:
        pr = next((prev[0][n] for n in ("cover", "bs") if n in prev[0] and prev[0][n]["value_raw"]), None)
        if pr:
            pq = pr["value_raw"] / prev[1]
            if pq < lo and abs(pq / q - 1) <= 0.25:
                return "partial_class"
    return "unexplained"


def _nci_equity_share(facts, asof=None) -> float | None:
    """NCI over equity including NCI at the newest balance-sheet date carrying both
    (within the foreign age limit of asof, when asof is given)."""
    by = defaultdict(dict)
    lo = _d(asof).toordinal() - shares.MAX_COUNT_AGE_DAYS_FOREIGN if asof else None
    for r in facts:
        if r["duration_days"] == 0 and r["value"] is not None and (
                lo is None or _d(r["period_end"]).toordinal() >= lo):
            by[r["period_end"]][r["concept"]] = r["value"]
    for pe in sorted(by, reverse=True):
        cons = next((by[pe][q] for q in shares.EQ_CONSOLIDATED if q in by[pe]), None)
        nci = next((by[pe][q] for q in shares.EQ_NCI if q in by[pe]), None)
        if cons and nci is not None and cons > 0:
            return abs(nci) / cons
    return None


def numerator_measures(live: dict, rows) -> dict:
    """L: the concept of today's net_income and total_equity rows; for a
    consolidated winner, the same-context parent value, the NCI fact and the gap."""
    out = {}
    for key, pre, parents, ncis, cons in (
            ("net_income", "ni", shares.NI_PARENT[1:], shares.NI_NCI, shares.NI_CONSOLIDATED),
            ("equity", "te", shares.EQ_PARENT, shares.EQ_NCI, shares.EQ_CONSOLIDATED)):
        r = live.get(key)
        out[f"{pre}_concept"] = r["concept"] if r else None
        out[f"{pre}_parent_gap"] = out[f"{pre}_nci_share"] = None
        out[f"{pre}_parent_found"] = None
        if not r or r["concept"] not in cons:
            continue
        hit = next((f for f in rows if f["concept"] == r["concept"] and f["period_end"] == r["period_end"]
                    and f["filed_date"] == r["filed"] and f["value"] == r["value"]), None)
        if not hit:
            continue
        ctx = [f for f in rows if f["accession"] == hit["accession"] and f["period_end"] == hit["period_end"]
               and f["period_start"] == hit["period_start"] and f["value"] is not None]
        par = next((f["value"] for q in parents for f in ctx if f["concept"] == q), None)
        nci = next((f["value"] for q in ncis for f in ctx if f["concept"] == q), None)
        out[f"{pre}_parent_found"] = par is not None
        if par:
            out[f"{pre}_parent_gap"] = _r(abs(r["value"] / par - 1)) if par else None
        if nci is not None and r["value"]:
            out[f"{pre}_nci_share"] = _r(abs(nci) / abs(r["value"]))
    return out


def diluted_over_basic(verdicts, rows):
    order, acc = _newest_periodic(verdicts)
    if not order:
        return None
    a = order[-1]
    w = acc[a].get("wa_basic")
    if not w or not w["value_clean"]:
        return None
    dil = [f for f in rows if f["accession"] == a and f["concept"] == shares.WA_DILUTED
           and f["period_end"] == w["period_end"] and f["duration_days"] > 0 and f["value"]]
    if not dil:
        return None
    d = max(dil, key=lambda f: (f["period_start"], -f["value"]))
    return _r(d["value"] / w["value_clean"])


def same_filing_wa(live: dict, rows, verdicts):
    """The validated basic W of the accession that carries today's share fact."""
    if not live:
        return None
    acc = {f["accession"] for f in rows if f["filed_date"] == live["filed"]
           and f["period_end"] == live["period_end"] and f["concept"] == live["concept"]
           and f["value"] == live["value"]}
    for r in verdicts:
        if r["accession"] in acc and r["candidate"] == "wa_basic" and r["value_clean"]:
            return r["value_clean"]
    return None


def store_same_filing_wa(live: dict, wa_rows) -> float | None:
    """Store mode: the basic weighted average stored with today's row's filing date.
    The ingest maps these concepts into other metric codes (S11 removes them), and its
    key keeps one duration per period end; the latest period end is the filing's own."""
    same = [(pe, v) for pe, _tag, v, filed in wa_rows if filed == live["filed"] and v and v > 0]
    return max(same)[1] if same else None


def edgar_split_tag(rows, asof):
    """J: the newest StockholdersEquityNoteStockSplitConversionRatio1 fact filed in
    the last SPLIT_TAG_DAYS (EDGAR's own ratio and filing date)."""
    lo = _d(asof).toordinal() - SPLIT_TAG_DAYS
    hits = [r for r in rows if r["concept"] == shares.SPLIT_RATIO_TAG and r["value"]
            and lo < _d(r["filed_date"]).toordinal() <= _d(asof).toordinal()]
    if not hits:
        return None, None
    h = max(hits, key=lambda r: (r["filed_date"], r["period_end"]))
    return h["value"], h["filed_date"]


def wa_drift(verdicts):
    """F: |log| of the change between the last two periodic accessions' validated W."""
    order, acc = _newest_periodic(verdicts)
    ws = [acc[a]["wa_basic"]["value_clean"] for a in order
          if acc[a].get("wa_basic") and acc[a]["wa_basic"]["value_clean"]]
    return abs(math.log(ws[-1] / ws[-2])) if len(ws) >= 2 else None


def scale_detail(verdicts, since=SCALE_SINCE):
    """H per security: FIX and QUARANTINE reasons since `since`, and the FIX and
    QUARANTINE verdicts of the newest periodic accession."""
    why = Counter(f"{v['candidate']}:{v['reason'] or v['fix_code']}" for v in verdicts
                  if v["candidate"] in shares.COUNT_ORDER and v["filed_date"] >= since
                  and v["verdict"] in ("FIX", "QUARANTINE"))
    order, acc = _newest_periodic(verdicts)
    newest = [] if not order else [
        {"candidate": n, "verdict": v["verdict"], "reason": v["reason"] or v["fix_code"],
         "value_raw": v["value_raw"], "filed": v["filed_date"]}
        for n, v in acc[order[-1]].items()
        if n in shares.COUNT_ORDER and v["verdict"] in ("FIX", "QUARANTINE")]
    return why, newest


def scale_verdicts(verdicts, since=SCALE_SINCE):
    return {(r["accession"], r["candidate"]): r["verdict"] for r in verdicts
            if r["candidate"] in shares.COUNT_ORDER and r["filed_date"] >= since}


# --- one security --------------------------------------------------------------

def census_facts(sec: dict, facts_list: list[dict], asof, tagmap, con, splits=None,
                 cutoff=None) -> dict:
    """Every per-security measure that needs companyfacts. EDGAR in, EDGAR out;
    `splits` (in memory) only steer classify_accessions and are never echoed.
    `cutoff` (the store's newest filing date) also gives today's simulated row as of
    the store's own knowledge, for the store-vs-simulation comparison (B)."""
    sid = sec["sid"]
    rows = []
    for facts in facts_list:
        rows.extend(shares.fact_rows(int(sec["cik"]), facts))
    # Point in time: every measure below sees only facts filed on or before asof (the
    # band, scale, drift, NCI and diluted measures would otherwise read later filings).
    # classify_accessions is truncation-invariant, so `select` is unchanged by the cut.
    rows = [r for r in rows if _d(r["filed_date"]) <= _d(asof)]
    sim = simulate_ingest(facts_list, sid, tagmap)
    share_rows = [x for x in sim if x[3] == "shares_outstanding" and _d(x[8]) <= _d(asof)]
    live_sim, sim_cut = {}, None
    if sim:
        _register(con, fm_frame(sim))
        live_sim = today_rows(con, asof, [sid]).get(sid, {})
        if cutoff is not None:
            sim_cut = today_rows(con, cutoff, [sid]).get(sid, {}).get("shares")

    verdicts = shares.classify_accessions(rows, splits=splits)
    sel = shares.select(verdicts, asof)
    wider = {k: _scaled(k, 1.1) for k in ("count", "income", "issued_upper", "fix")}
    narrower = {k: _scaled(k, 1 / 1.1) for k in ("count", "income", "issued_upper", "fix")}
    base = scale_verdicts(verdicts)
    flips = 0
    for b in (wider, narrower):
        alt = scale_verdicts(shares.classify_accessions(rows, splits=splits, bands=b))
        flips += sum(1 for k, v in base.items() if alt.get(k) != v)
    tag_ratio, tag_filed = edgar_split_tag(rows, asof)
    ads = shares.ads_ratios(rows, asof)
    return {
        "rows": rows, "verdicts": verdicts, "select": sel, "live_sim": live_sim,
        "sim_today_at_cutoff": sim_cut,
        "sim_vintages": [(x[1], x[2], x[9], x[4], x[8]) for x in share_rows],
        "sim_numerators": [(x[3], x[1], x[2], x[8], x[9], x[4]) for x in sim
                           if x[3] in ("net_income", "total_equity")],
        "old_check_sim": old_check([(x[1], x[9], x[4]) for x in share_rows]),
        "band": band_measures(verdicts, rows), "scale": Counter(base.values()),
        "scale_detail": scale_detail(verdicts),
        "scale_flips": flips, "drift": wa_drift(verdicts),
        "dil_basic": diluted_over_basic(verdicts, rows),
        "nci_equity": _nci_equity_share(rows, asof),
        "split_tag": (tag_ratio, tag_filed), "ads": ads,
        "entity": next((f.get("entityName") for f in facts_list if f.get("entityName")), None),
        "n_fact_rows": len(rows),
    }


def _scaled(key, f):
    b = shares.BANDS[key]
    if isinstance(b, tuple):
        return (b[0] / f, b[1] * f)
    return b * f


def _register(con, df):
    try:
        con.unregister("fundamental_metrics")
    except Exception:
        pass
    con.register("fundamental_metrics", df)


def record(sec: dict, live: dict, cf: dict | None, asof, vintages, ctx: dict) -> dict:
    """One CSV row plus the extras the sections aggregate."""
    sh = live.get("shares") or {}
    rec = {k: None for k in CSV_COLUMNS}
    rec.update(ticker=sec.get("ticker"), cik=sec.get("cik"), security_id=sec.get("security_id"),
               entity=sec.get("name"))
    rec.update(today_value=sh.get("value"), today_concept=sh.get("concept"),
               today_period_end=sh.get("period_end"), today_filed=sh.get("filed"),
               today_age_days=(_d(asof) - _d(sh["period_end"])).days if sh else None,
               reporting_currency=live.get("currency"))
    res = live.get("resolved")
    rec["guard_edgar"] = ";".join(guard(sh, vintages, asof, None, res)) if sh else None
    rec["_guard_full"] = guard(sh, vintages, asof, ctx.get("splits"), res) if sh else []
    rec["_live"] = live
    rec["old_check_groups"] = old_check([(x[0], x[2], x[3]) for x in vintages])
    if cf is None:
        rec["live_over_same_filing_wa"] = _r(_ratio(sh.get("value"), store_same_filing_wa(
            sh, ctx.get("wa_rows") or []))) if sh else None
        rec.update(ni_concept=(live.get("net_income") or {}).get("concept"),
                   te_concept=(live.get("equity") or {}).get("concept"),
                   reasons=rec["guard_edgar"] or None)
        return rec
    s = cf["select"]
    sim = cf["live_sim"].get("shares") or {}
    rec.update(entity=rec["entity"] or cf["entity"],
               sim_value=sim.get("value"), sim_concept=sim.get("concept"),
               sim_period_end=sim.get("period_end"),
               new_value=s["value"], new_candidate=s["candidate"], new_concept=s["concept"],
               new_count_date=s["count_date"], new_accession=s["accession"],
               new_filed=s["filed_date"], new_form=s["form"], new_verdict=s["verdict"],
               new_flags=";".join(s["flags"]) or None, new_reason=s["reason"],
               new_age_days=s["age_days"], collision_ratio=_r(_ratio(sh.get("value"), s["value"])),
               wa_same_filing=s["wa_value"], wa_newest_raw=s["wa_newest_raw"],
               wa_newest_verdict=s["wa_newest_verdict"], wa_newest_period_end=s["wa_newest_period_end"],
               wa_fallback_value=s["wa_fallback_value"],
               wa_fallback_period_end=s["wa_fallback_period_end"],
               today_over_wa_newest=_r(_ratio(sh.get("value"), s["wa_newest_raw"])),
               newest_periodic_form=s["newest_periodic_form"],
               ads_ratios=";".join(f"{d_}:{v:g}" for d_, v in cf["ads"]) or None,
               edgar_split_ratio=cf["split_tag"][0], edgar_split_ratio_filed=cf["split_tag"][1],
               diluted_over_basic=cf["dil_basic"], fact_rows=cf["n_fact_rows"])
    rec.update({k: cf["band"][k] for k in ("band_cover", "band_cso", "band_csi", "band_label")})
    w = same_filing_wa(sh, cf["rows"], cf["verdicts"]) if sh else None
    rec["live_over_same_filing_wa"] = _r(_ratio(sh.get("value"), w))
    nm = numerator_measures(live, cf["rows"])
    rec.update({k: v for k, v in nm.items() if k in CSV_COLUMNS})
    # Fact rows and verdicts are thousands of dicts per issuer; the sections need only
    # the aggregates above, so they go here (3,100 issuers would not fit otherwise).
    for k in ("rows", "verdicts"):
        cf.pop(k, None)
    if not ctx.get("keep_numerators"):
        cf.pop("sim_numerators", None)
    rec["_cf"] = cf
    rec["_nm"] = nm
    codes = [s["reason"]] + s["flags"] + (rec["guard_edgar"] or "").split(";")
    if rec["band_label"] not in (None, "in_band"):
        codes.append(rec["band_label"])
    rec["reasons"] = ";".join(dict.fromkeys(c for c in codes if c)) or None
    return rec


# --- sections --------------------------------------------------------------------

def _limit(form):
    return shares.MAX_COUNT_AGE_DAYS_FOREIGN if form in shares.FOREIGN_FORMS \
        else shares.MAX_COUNT_AGE_DAYS


def sections(recs: list[dict], ctx: dict) -> tuple[dict, dict]:
    asof = _d(ctx["asof"])
    have_cf = any("_cf" in r for r in recs)
    cfr = [r for r in recs if "_cf" in r]
    n = len(recs)
    S: dict = {}

    # A Population
    with_row = [r for r in recs if r["today_value"] is not None]
    ages = [r["today_age_days"] for r in with_row if r["today_age_days"] is not None]
    flagged = [r for r in recs if r["old_check_groups"]]
    S["A"] = {
        "securities": n, "with_cik": sum(1 for r in recs if r["cik"]),
        "with_share_row": len(with_row),
        "method": dict(Counter((r["today_concept"] or "").split(":")[-1] for r in with_row)),
        "age_days": {"p50": _pct(ages, .5), "p90": _pct(ages, .9),
                     "over_400": sum(1 for a in ages if a > 400),
                     "over_800": sum(1 for a in ages if a > 800)},
        "old_check": {"issuers": len(flagged),
                      "rows": sum(r["old_check_groups"] for r in flagged),
                      "expected": {"issuers": 691, "rows": 1287}},
    }

    # B Store vs simulation
    S["B"] = ctx.get("store_vs_sim") or {"available": False,
                                          "note": "needs the store and companyfacts together "
                                                  "(--companyfacts, or --cache with --store-dump)"}

    # C Collision
    if have_cf:
        moves = []
        to_nan = from_nan = 0
        for r in cfr:
            t, v = r["today_value"], r["new_value"]
            if t and v:
                moves.append((abs(math.log(t / v)), r))
            elif t and not v:
                to_nan += 1
            elif v and not t:
                from_nan += 1
        elig = ctx.get("pick_eligible")
        over5 = [r for lr, r in moves if lr > math.log(1.05)]
        S["C"] = {
            "compared": len(moves),
            "over_1pct": sum(1 for lr, _ in moves if lr > math.log(1.01)),
            "over_5pct": len(over5),
            "over_20pct": sum(1 for lr, _ in moves if lr > math.log(1.2)),
            "over_2x": sum(1 for lr, _ in moves if lr > math.log(2)),
            "to_nan": to_nan, "from_nan": from_nan,
            "over_5pct_pick_eligible": (sum(1 for r in over5 if r["ticker"] in elig)
                                        if elig is not None else None),
            "over_5pct_in_flagged_set": sum(1 for r in over5 if r["old_check_groups"]),
            "top": [{"ticker": r["ticker"], "cik": r["cik"], "ratio": r["collision_ratio"],
                     "today": f"{r['today_concept']} {r['today_period_end']}",
                     "new": f"{r['new_candidate']} {r['new_count_date']}",
                     "today_value": r["today_value"], "new_value": r["new_value"]}
                    for _, r in sorted(moves, key=lambda x: -x[0])[:50]],
        }
    else:
        S["C"] = {"available": False, "note": "needs companyfacts"}

    # D Interim guard
    reasons = Counter(x for r in with_row for x in r["_guard_full"])
    quarantined = [r for r in with_row if r["_guard_full"]]
    oob = defaultdict(lambda: [0, 0])
    for r in with_row:
        q = r["live_over_same_filing_wa"]
        if q is None:
            continue
        grp = "readmitted" if r["old_check_groups"] else "eligible"
        oob[grp][1] += 1
        if q > OUT_OF_BAND or q < 1 / OUT_OF_BAND:
            oob[grp][0] += 1
    rate = {g: (_r(a / b) if b else None) for g, (a, b) in oob.items()}
    S["D"] = {"quarantined": len(quarantined),
              "share_of_securities": _r(len(quarantined) / n) if n else None,
              "by_reason": dict(reasons), "splits_used": ctx.get("splits_available", False),
              "out_of_band_rate": rate,
              "out_of_band_counts": {g: {"out": a, "of": b} for g, (a, b) in oob.items()}}

    # E Band
    if have_cf:
        cases = [(r, c) for r in cfr for c in r["_cf"]["band"]["band_cases"]]
        dist = defaultdict(Counter)
        for r in cfr:
            for col, nm in (("band_cover", "cover"), ("band_cso", "cso"), ("band_csi", "csi")):
                q = r[col]
                if q is None:
                    continue
                b = ("<0.1" if q < 0.1 else "0.1-0.67" if q < 0.67 else "0.67-0.9" if q < 0.9
                     else "0.9-1.1" if q <= 1.1 else "1.1-1.5" if q <= 1.5 else "1.5-10" if q <= 10
                     else ">10")
                dist[nm][b] += 1
        labels = Counter(c["label"] for _, c in cases)
        unexplained = labels.get("unexplained", 0)
        S["E"] = {"distribution": {k: dict(v) for k, v in dist.items()},
                  "out_of_band_cases": len(cases), "labels": dict(labels),
                  "legitimate": sum(v for k, v in labels.items() if k in LEGIT),
                  "errors": sum(v for k, v in labels.items() if k in ERRORS),
                  "unexplained_share": _r(unexplained / len(cases)) if cases else None,
                  "cases": [{"ticker": r["ticker"], "cik": r["cik"], **c} for r, c in cases][:300]}
    else:
        S["E"] = {"available": False, "note": "needs companyfacts"}

    # F Weighted average
    if have_cf:
        pairs = [r["new_value"] / r["wa_same_filing"] for r in cfr
                 if r["new_value"] and r["wa_same_filing"]]
        logs = [abs(math.log(q)) for q in pairs]
        drift = [r["_cf"]["drift"] for r in cfr if r["_cf"]["drift"] is not None]
        S["F"] = {"wa_in_newest_periodic": sum(1 for r in cfr if r["wa_newest_raw"]),
                  "wa_rejected_scale": sum(1 for r in cfr if r["wa_newest_verdict"] == "QUARANTINE"),
                  "accepted_pairs": len(pairs),
                  "abs_log_c_over_w": {"p50": _pct(logs, .5), "p90": _pct(logs, .9)},
                  "c_over_w": {"p1": _pct(pairs, .01), "p99": _pct(pairs, .99)},
                  "quarter_drift_abs_log": {"p50": _pct(drift, .5), "p90": _pct(drift, .9)}}
    else:
        S["F"] = {"available": False, "note": "needs companyfacts"}

    # G Missing and stale
    if have_cf:
        def wa_ok(r):
            pe = r["wa_fallback_period_end"]
            return bool(r["wa_fallback_value"] and pe and
                        (asof - _d(pe)).days <= _limit(r["newest_periodic_form"]))
        missing = [r for r in cfr if r["today_value"] is None]
        new_missing = [r for r in cfr if r["new_value"] is None]
        stale = [r for r in cfr if r["new_flags"] and "shares_stale" in r["new_flags"].split(";")]
        ceiling = [r for r in cfr if r["new_reason"] == "stale_beyond_ceiling"]
        partial = [r for r in cfr if r["band_label"] == "partial_class"]
        pool = {id(r): r for r in new_missing + stale + partial}.values()
        S["G"] = {"no_count_today": len(missing),
                  "no_count_today_recoverable_by_wa": sum(1 for r in missing if wa_ok(r)),
                  "no_count_after_resolver": len(new_missing),
                  "needing_instance_facts": sum(1 for r in new_missing if not wa_ok(r)),
                  "past_limit": len(stale), "past_ceiling": len(ceiling),
                  "class_incomplete": len(partial),
                  "pool": len(pool), "pool_with_valid_wa": sum(1 for r in pool if wa_ok(r)),
                  "past_ceiling_list": [f"{r['ticker'] or r['cik']} {r['new_count_date']}"
                                        for r in ceiling][:60]}
    else:
        S["G"] = {"available": False, "note": "needs companyfacts"}

    # H Scale
    if have_cf:
        tot = Counter()
        for r in cfr:
            tot.update(r["_cf"]["scale"])
        newest, why = [], Counter()
        for r in cfr:
            w, nw = r["_cf"]["scale_detail"]
            why.update(w)
            newest += [{"ticker": r["ticker"], "cik": r["cik"], **x} for x in nw]
        S["H"] = {"since": SCALE_SINCE, "verdicts": dict(tot), "by_reason": dict(why.most_common()),
                  "newest_fix_or_quarantine": newest[:300],
                  "newest_fix_or_quarantine_count": len(newest),
                  "flips_at_10pct": sum(r["_cf"]["scale_flips"] for r in cfr)}
    else:
        S["H"] = {"available": False, "note": "needs companyfacts"}

    # I ADS and currency
    cur = Counter((r["reporting_currency"] or "unknown") for r in recs)
    non_usd = sum(v for k, v in cur.items() if k not in ("USD", "unknown"))
    if have_cf:
        foreign = [r for r in cfr if r["newest_periodic_form"] in shares.FOREIGN_FORMS]
        S["I"] = {"foreign_filers": len(foreign),
                  "with_ads_ratio_tag": sum(1 for r in foreign if r["ads_ratios"]),
                  "ads_ratio_tag_any_filer": sum(1 for r in cfr if r["ads_ratios"]),
                  "ratio_listings": [{"ticker": r["ticker"], "cik": r["cik"], "ratios": r["ads_ratios"]}
                                     for r in cfr if r["ads_ratios"]][:200],
                  "currency": dict(cur), "non_usd_reporters": non_usd}
    else:
        S["I"] = {"currency": dict(cur), "non_usd_reporters": non_usd,
                  "note": "ADS ratios need companyfacts"}

    # J Splits (counts only)
    tags = [r for r in cfr if r["edgar_split_ratio"]]
    S["J"] = dict(ctx.get("splits_counts") or {"available": False,
                                                "note": "splits counts need the store modes"})
    S["J"]["edgar_split_tags_recent"] = len(tags)
    have_split = ctx.get("split_sids")
    if have_split is not None:
        gap = [r for r in tags if r["security_id"] not in have_split]
        S["J"]["edgar_tag_without_splits_row"] = len(gap)
        S["J"]["edgar_tag_without_splits_row_list"] = [
            {"ticker": r["ticker"], "edgar_ratio": r["edgar_split_ratio"],
             "edgar_filed": r["edgar_split_ratio_filed"]} for r in gap]
    else:
        S["J"]["edgar_tag_list"] = [{"ticker": r["ticker"] or r["cik"], "edgar_ratio": r["edgar_split_ratio"],
                                     "edgar_filed": r["edgar_split_ratio_filed"]} for r in tags][:100]

    # K Security master
    S["K"] = dict(ctx.get("security_master") or {})
    by_cik = defaultdict(list)
    for r in recs:
        if r["cik"] and r["ticker"]:
            by_cik[str(int(r["cik"]))].append(r["ticker"])
    multi = {c: sorted(t) for c, t in by_cik.items() if len(t) > 1}
    S["K"]["ciks_with_several_listings"] = len(multi)
    S["K"]["not_class_listings"] = sorted(
        "/".join(t) for t in multi.values() if not _class_listings(t))

    # L Numerators and NCI
    ni = Counter(r["ni_concept"] for r in recs if r["ni_concept"])
    te = Counter(r["te_concept"] for r in recs if r["te_concept"])
    L = {"net_income_concepts": dict(ni), "total_equity_concepts": dict(te)}
    if have_cf:
        cons = [r for r in cfr if r["_nm"].get("ni_parent_found") is not None
                or r["_nm"].get("te_parent_found") is not None]
        gap2 = [r for r in cfr if (r["ni_parent_gap"] or 0) > 0.02 or (r["te_parent_gap"] or 0) > 0.02]
        nci = [r for r in cfr if (r["_cf"]["nci_equity"] or 0) >= 0.02]
        dil = [r for r in cfr if (r["diluted_over_basic"] or 0) > 1.15]
        material = {id(r): r for r in nci + dil}.values()
        gap5 = [r for r in material if max(r["_cf"]["nci_equity"] or 0,
                                            (r["diluted_over_basic"] or 1) - 1) > 0.05]
        L.update({"consolidated_live_rows": len(cons),
                  "consolidated_parent_gap_over_2pct": len(gap2),
                  "nci_2pct_of_equity": len(nci), "diluted_over_basic_over_1_15": len(dil),
                  "material_nci_or_exchangeable": len(material), "ownership_gap_over_5pct": len(gap5),
                  "consolidated_list": [{"ticker": r["ticker"], "cik": r["cik"], "ni": r["ni_concept"],
                                         "ni_gap": r["ni_parent_gap"], "ni_nci": r["ni_nci_share"],
                                         "te": r["te_concept"], "te_gap": r["te_parent_gap"],
                                         "te_nci": r["te_nci_share"]} for r in cons][:200]})
    S["L"] = L

    # M Volume
    rows_cf = [r["fact_rows"] for r in cfr if r["fact_rows"] is not None]
    mean = statistics.mean(rows_cf) if rows_cf else None
    universe = ctx.get("universe") or UNIVERSE_HINT
    S["M"] = {"issuers_measured": len(rows_cf), "fact_rows": sum(rows_cf),
              "mean_rows_per_issuer": _r(mean, 1),
              "projected_share_facts_rows": int(mean * universe) if mean else None,
              "projected_for": universe, "runtime_seconds": None}
    return S, thresholds(S, ctx)


def _class_listings(tickers) -> bool:
    """GOOG/GOOGL, BF-A/BF-B: one root, class suffixes. LC/HAPN, AGGI/BSCL: not."""
    roots = {re.split(r"[-.]", t)[0] for t in tickers}
    if len(roots) == 1:
        return True
    ts = sorted(tickers, key=len)
    return all(t.startswith(ts[0]) and len(t) - len(ts[0]) <= 1 for t in ts[1:])


def _t(value, fires, action, measure, evaluable=True, note=None):
    out = {"measure": measure, "value": value, "fires": fires if evaluable else None,
           "action": action if (fires and evaluable) else None, "evaluable": evaluable}
    if note:
        out["note"] = note
    return out


def thresholds(S: dict, ctx: dict) -> dict:
    T = {}
    cf = "available" not in S["C"]
    store = ctx.get("mode") in ("store", "companyfacts")
    C = S["C"]
    if cf:
        n5 = C["over_5pct"]
        el = C["over_5pct_pick_eligible"]
        merge, split = n5 < 20 and el == 0, n5 > 150
        act = ("ship S5 and S6 as one PR and one gate bump" if merge else
               "ship S5 alone with a one-day picks review before S6" if split else None)
        T["T1"] = _t({"over_5pct": n5, "pick_eligible": el}, merge or split, act,
                     "securities moving more than 5% under accession-first selection",
                     note=None if el is not None else "pick eligibility needs the store modes")
    else:
        T["T1"] = _t(None, None, None, "collision moves", False, "needs companyfacts")
    D = S["D"]
    ra, el = D["out_of_band_rate"].get("readmitted"), D["out_of_band_rate"].get("eligible")
    share = D["share_of_securities"] or 0
    fire2 = share > 0.02 or (ra is not None and el is not None and ra > el + 0.01)
    T["T2"] = _t({"quarantine_share": D["share_of_securities"], "readmitted_rate": ra,
                  "eligible_rate": el}, fire2,
                 "S3 ships its first commit only; the removal moves to S6",
                 "S3 quarantine size; re-admitted vs eligible out-of-band rate",
                 note=None if D["splits_used"] else "evaluated without splits (rule c not applied)")
    G = S["G"]
    if "available" not in G:
        frac = (G["pool_with_valid_wa"] / G["pool"]) if G["pool"] else None
        act = ("move S9b ahead of S6 and treat S6 as partial" if frac is not None and frac < 0.5
               else "keep the order; S6 covers only part of the pool"
               if frac is not None and frac < 0.8 else None)
        T["T3"] = _t(_r(frac), act is not None, act,
                     "missing, stale or class-incomplete with a valid W in the newest periodic filing")
    else:
        T["T3"] = _t(None, None, None, "weighted-average coverage", False, "needs companyfacts")
    F = S["F"]
    if "available" not in F:
        p90 = F["abs_log_c_over_w"]["p90"]
        T["T4"] = _t(p90, p90 is not None and p90 > 0.05,
                     "the S6 fallback takes only a W whose period ended within 200 days",
                     "p90 of |log(C/W)| on accepted same-filing pairs")
        E = S["E"]
        p1, p99 = F["c_over_w"]["p1"], F["c_over_w"]["p99"]
        un = E["unexplained_share"]
        fire5 = ((p1 is not None and p1 < 0.67) or (p99 is not None and p99 > 1.5)
                 or (un is not None and un > 0.10))
        T["T5"] = _t({"p1": p1, "p99": p99, "unexplained_share": un}, fire5,
                     "re-derive the bands before S5 freezes rules_version 1",
                     "accepted C/W p1 and p99; unexplained share of out-of-band cases")
    else:
        T["T4"] = _t(None, None, None, "C/W error bound", False, "needs companyfacts")
        T["T5"] = _t(None, None, None, "bands", False, "needs companyfacts")
    K = S["K"]
    z = K.get("class_suffix_tickers_without_bars")
    T["T6"] = _t(z, bool(z), "ship S8a straight after S0",
                 "class-suffix tickers with zero bars", store and z is not None)
    s6221 = K.get("sic_6221_in_stock_universe")
    T["T7"] = _t(s6221, bool(s6221), "put the S8d universe-hygiene decision in #58 for the owner",
                 "SIC 6221 securities in the stock universe", store and s6221 is not None)
    I = S["I"]
    if "foreign_filers" in I and I["foreign_filers"]:
        fr = I["with_ads_ratio_tag"] / I["foreign_filers"]
        act = ("S5 covers most ADS listings; S9b's ADS work shrinks" if fr >= 0.5 else
               "S9a, S9b and S10 move ahead of S8b for 20-F and 40-F filers" if fr < 0.1 else None)
        T["T8"] = _t(_r(fr), act is not None, act, "20-F and 40-F filers carrying the companyfacts ADS ratio tag")
    else:
        T["T8"] = _t(None, None, None, "ADS ratio tag share", False, "needs companyfacts")
    J = S["J"]
    if "live_transients" in J:
        fire9 = J["live_transients"] >= 5 or J["in_window"] >= 30
        T["T9"] = _t({"live_transients": J["live_transients"], "in_window": J["in_window"]}, fire9,
                     "move S7b ahead of S6, straight after S5", "live split transients; in-window splits")
        T["T10"] = _t(J["pairs_on_mixed_bases"], J["pairs_on_mixed_bases"] > 0,
                      "S3's backtest re-run records the count as its mixed-basis caveat",
                      "(security, rebalance date) pairs whose bar and count bases differ")
    else:
        T["T9"] = _t(None, None, None, "split transients", False, "needs the store modes")
        T["T10"] = _t(None, None, None, "mixed-basis pairs", False, "needs the store modes")
    B = S["B"]
    if B.get("available", True) and B.get("today_mismatch_rate") is not None:
        r11 = B["today_mismatch_rate"]
        T["T11"] = _t(r11, r11 > 0.02, "investigate the ingest and dedupe path before S5; "
                      "goldens are re-derived from the store", "store vs simulation mismatch rate")
    else:
        T["T11"] = _t(None, None, None, "store vs simulation", False, B.get("note"))
    M = S["M"]
    T["T12"] = _t(M["projected_share_facts_rows"], (M["projected_share_facts_rows"] or 0) > 8e6,
                  "ingest EPS and net income proxies only for filings since 2019",
                  "projected share_facts rows", M["projected_share_facts_rows"] is not None)
    L = S["L"]
    if "ownership_gap_over_5pct" in L:
        T["T13"] = _t(L["ownership_gap_over_5pct"], L["ownership_gap_over_5pct"] >= 20,
                      "bring the P/S and P/CF convention decision forward to S6",
                      "material NCI or exchangeable units with an ownership gap above 5%")
        T["T16"] = _t(L["consolidated_parent_gap_over_2pct"], L["consolidated_parent_gap_over_2pct"] >= 20,
                      "S5b ships straight after S5, before S6",
                      "live consolidated numerator with a same-context parent more than 2% away")
    else:
        T["T13"] = _t(None, None, None, "NCI", False, "needs companyfacts")
        T["T16"] = _t(None, None, None, "parent numerators", False, "needs companyfacts")
    T["T14"] = _t(I["non_usd_reporters"], I["non_usd_reporters"] > 300,
                  "put the FX conversion decision ahead of S10", "non-USD reporters")
    nc = K.get("not_class_listings")
    T["T15"] = _t(len(nc or []), bool(nc), "they go on the S8d retirement list for the owner",
                  "CIKs with several listings that are not class listings",
                  ctx.get("mode") != "cache" or bool(ctx.get("securities_file")))
    if ctx.get("mode") == "cache":
        for t in T.values():
            t["advisory"] = "cache sample, biased towards the flagged set; never sets a threshold"
    return T


# --- store-vs-simulation (B) -----------------------------------------------------

def store_vs_sim(pairs: list[tuple], cutoff) -> dict:
    """pairs: (rec, store_share_rows, sim_share_rows, store_today, sim_today) per security
    held by both sides. Rows are (period_end, fp, raw_tag, value, filed)."""
    out = {"available": True, "cutoff": _iso(cutoff), "securities": len(pairs),
           "today_mismatch": 0, "row_level": Counter(), "mismatches": []}
    for rec, st_rows, sim_rows, st_today, sim_today in pairs:
        c = _d(cutoff)
        S = {(str(x[0])[:10], x[1], str(x[4])[:10]): (x[2], _num(x[3])) for x in st_rows
             if _d(x[4]) <= c}
        T = {(str(x[0])[:10], x[1], str(x[4])[:10]): (x[2], _num(x[3])) for x in sim_rows
             if _d(x[4]) <= c}
        row = Counter()
        for k in S.keys() | T.keys():
            if k not in T:
                row["store_only"] += 1
            elif k not in S:
                row["sim_only"] += 1
            elif S[k][0] != T[k][0]:
                row["concept_differs"] += 1
            elif S[k][1] != T[k][1]:
                row["value_differs"] += 1
            else:
                row["equal"] += 1
        out["row_level"].update(row)
        a, b = st_today or {}, sim_today or {}
        same = (a.get("concept") == b.get("concept") and a.get("period_end") == b.get("period_end")
                and (_num(a.get("value")) == _num(b.get("value"))))
        rec["store_vs_sim"] = "match" if same else "mismatch"
        if not same:
            out["today_mismatch"] += 1
            out["mismatches"].append({
                "ticker": rec["ticker"], "cik": rec["cik"],
                "store": f"{a.get('concept')} {a.get('period_end')} {a.get('value')}",
                "sim": f"{b.get('concept')} {b.get('period_end')} {b.get('value')}",
                "rows": dict(row)})
    out["row_level"] = dict(out["row_level"])
    out["today_mismatch_rate"] = _r(out["today_mismatch"] / len(pairs)) if pairs else None
    return out


# --- modes -------------------------------------------------------------------------

def _securities_file(path) -> list[dict]:
    data = json.loads(Path(path).read_text())
    rows = data.get("issuers", data) if isinstance(data, dict) else data
    out = []
    for i, x in enumerate(rows, 1):
        out.append({"sid": i, "security_id": None, "ticker": x.get("ticker"),
                    "cik": int(x["cik"]), "name": x.get("name") or x.get("entity_name"),
                    "ciks": [int(c) for c in x.get("predecessor_ciks") or []] + [int(x["cik"])]})
    return out


def run_cache(dirs, asof, securities_file=None, store_dumps=(), limit=None) -> tuple[list, dict]:
    import duckdb
    from .sources import catalog
    idx = cache_index(dirs)
    secs = _securities_file(securities_file) if securities_file else [
        {"sid": i, "security_id": None, "ticker": None, "cik": c, "name": None, "ciks": [c]}
        for i, c in enumerate(sorted(idx), 1)]
    if limit:
        secs = secs[:limit]
    tagmap = catalog.xbrl_tag_map()
    con = duckdb.connect()
    recs, missing, facts_memo = [], [], {}
    sims = {}
    for sec in secs:
        fl = []
        for c in sec["ciks"]:
            if c not in facts_memo:
                facts_memo.clear()
                facts_memo[c] = load_companyfacts(idx[c]) if c in idx else None
            if facts_memo[c]:
                fl.append(facts_memo[c])
        if not fl or not idx.get(sec["cik"]):
            missing.append(sec["ticker"] or sec["cik"])
            continue
        cf = census_facts(sec, fl, asof, tagmap, con)
        rec = record(sec, cf["live_sim"], cf, asof, cf["sim_vintages"],
                     {"keep_numerators": bool(store_dumps)})
        recs.append(rec)
        sims[sec["ticker"]] = (rec, cf)
    ctx = {"mode": "cache", "asof": _iso(asof), "securities_file": securities_file,
           "coverage": {"securities": len(secs), "with_companyfacts": len(recs),
                        "missing": missing[:100]}}
    if store_dumps:
        ctx["store_vs_sim"] = _dump_reconcile(store_dumps, sims, tagmap)
    return recs, ctx


def _dump_reconcile(paths, sims: dict, tagmap) -> dict:
    """B in cache mode: tierb-dump artifacts (shares_by_ticker, metrics_by_ticker)
    against the simulation, at the dump's own cut-off."""
    import duckdb
    rows_by_tk = defaultdict(list)
    num_rows = defaultdict(list)
    complete_num, asked = set(), set()
    for p in paths:
        d = json.loads(Path(p).read_text())
        if d.get("preset") == "shares_by_ticker":
            asked |= set(d.get("tickers") or [])
            for r in d["rows"]:
                rows_by_tk[r["ticker"]].append(r)
        elif d.get("preset") == "metrics_by_ticker":
            tks = [r["ticker"] for r in d["rows"]]
            last = tks[-1] if (d.get("truncated") and tks) else None
            for r in d["rows"]:
                num_rows[r["ticker"]].append(r)
            complete_num |= {t for t in set(tks) if t != last}
    every = [r for rs in rows_by_tk.values() for r in rs] + [r for rs in num_rows.values() for r in rs]
    if not every:
        return {"available": False, "note": "no rows in the store dumps"}
    cutoff = max(r["filed_date"] for r in every)
    con = duckdb.connect()
    pairs, absent = [], []
    numer = Counter()
    numer_diffs = []
    for tk in sorted(asked | set(rows_by_tk)):
        if tk not in sims:
            absent.append(tk)
            continue
        rec, cf = sims[tk]
        st = rows_by_tk.get(tk, [])
        st_rows = [(r["period_end"], r["fiscal_period"] or "", r["raw_tag"], r["value"], r["filed_date"])
                   for r in st]
        sim_rows = cf["sim_vintages"]
        # today at the cut-off, both sides through the same functions
        st_today, sim_today = (_today_at(con, rs, cutoff) for rs in (st_rows, sim_rows))
        if st_rows or sim_rows:
            pairs.append((rec, st_rows, sim_rows, st_today, sim_today))
        if tk in complete_num:
            S = {(r["metric_code"], r["period_end"], r["fiscal_period"] or "", r["filed_date"]):
                 (r["raw_tag"], _num(r["value"])) for r in num_rows[tk]
                 if r["metric_code"] in ("net_income", "total_equity")}
            T = {(mc, pe, fp, fl): (tag, _num(v)) for mc, pe, fp, fl, tag, v in cf["sim_numerators"]
                 if fl <= cutoff}
            for k in S.keys() | T.keys():
                if k not in T:
                    numer["store_only"] += 1
                elif k not in S:
                    numer["sim_only"] += 1
                elif S[k][0] != T[k][0]:
                    numer["concept_differs"] += 1
                    numer_diffs.append({"ticker": tk, "key": "|".join(k), "store": S[k][0], "sim": T[k][0]})
                elif S[k][1] != T[k][1]:
                    numer["value_differs"] += 1
                else:
                    numer["equal"] += 1
    if not pairs:
        # cache securities carry tickers only with --securities
        return {"available": False, "note": "no dump ticker matched a cached security "
                                            "(pass --securities with tickers)",
                "tickers_without_companyfacts": absent}
    out = store_vs_sim(pairs, cutoff)
    out.update(source="tierb-dump artifacts", tickers_without_companyfacts=absent,
               numerators_compared=sorted(complete_num & set(sims)),
               numerator_rows=dict(numer), numerator_differences=numer_diffs[:50])
    return out


def _today_at(con, share_rows, cutoff):
    """Today's resolved share row at `cutoff` from (period_end, fp, raw_tag, value,
    filed) rows alone, through today_rows."""
    if not share_rows:
        return None
    _register(con, fm_frame([(1, pe, fp, "shares_outstanding", v, "shares", "", False, filed, tag,
                              "xbrl") for pe, fp, tag, v, filed in share_rows]))
    return today_rows(con, cutoff, [1]).get(1, {}).get("shares")


def _store_context(asof, companyfacts=False) -> dict:
    """Open the store and Postgres, then read everything the store modes need.
    Every credential is checked before any read: without SEC_USER_AGENT each
    companyfacts fetch would fail, be counted as missing, and leave a census with
    no companyfacts sections after ten minutes of rate-limited waiting."""
    from . import config, db, tierb
    if companyfacts:
        try:
            config.sec_user_agent()
        except RuntimeError as e:
            raise SystemExit(f"--companyfacts: {e}")
    if not tierb.enabled():
        raise SystemExit("Tier B store not present: restore it (CI) or "
                         "`python -m engine.tierbsync pull` first.")
    if not db.have_db():
        raise SystemExit("DATABASE_URL is required for --store and --companyfacts.")
    duck = tierb.connect()
    with db.connect() as conn, conn.cursor() as cur:
        return read_store(duck, cur, asof, have_prices=tierb.have_prices(),
                          rollback=conn.rollback)


def read_store(duck, cur, asof, have_prices=False, rollback=None) -> dict:
    """Everything the store modes read: securities, SIC tags, splits and the screener
    snapshot from Postgres (`cur`); share vintages, today's rows and bar counts from
    Tier B (`duck`). Prices are only counted; splits and the snapshot stay in memory
    and leave this module as counts."""
    ctx: dict = {"duck": duck}
    cur.execute("select id, ticker, cik, name, country from securities where kind='stock' "
                "order by ticker")
    ctx["securities"] = [{"sid": int(i), "security_id": int(i), "ticker": t,
                          "cik": int(c) if c and str(c).isdigit() else None, "name": n,
                          "country": co, "ciks": [int(c)] if c and str(c).isdigit() else []}
                         for i, t, c, n, co in cur.fetchall()]
    cur.execute("select security_id, sic_code from security_tags where sic_code is not null")
    ctx["sic"] = defaultdict(set)
    for sid, sic in cur.fetchall():
        ctx["sic"][int(sid)].add(str(sic))
    cur.execute("select security_id, execution_date, split_from, split_to from splits "
                "where security_id is not null and execution_date is not null")
    splits = defaultdict(list)
    for sid, ex, fr, to in cur.fetchall():
        if fr and to:
            splits[int(sid)].append((ex, float(to) / float(fr)))
    ctx["splits"] = splits
    try:
        cur.execute("select payload from public.screener_snapshots where scope = 'stocks'")
        row = cur.fetchone()
        ctx["pick_eligible"] = _eligible_from_snapshot(row[0] if row else None)
    except Exception:
        if rollback:
            rollback()
        ctx["pick_eligible"] = None
    ctx["have_prices"] = have_prices
    ctx["bars"] = dict(duck.execute(BAR_COUNT_SQL).fetchall()) if have_prices else {}
    vint = defaultdict(list)
    for sid, pe, fp, tag, v, filed in duck.execute(
            "select security_id, period_end, fiscal_period, raw_tag, value, filed_date "
            "from fundamental_metrics where metric_code = 'shares_outstanding' "
            "and source = 'xbrl'").fetchall():
        vint[int(sid)].append((_iso(pe), fp or "", tag, v, _iso(filed)))
    ctx["vintages"] = vint
    wa = defaultdict(list)
    for sid, pe, tag, v, filed in duck.execute(
            "select security_id, period_end, raw_tag, value, filed_date from fundamental_metrics "
            "where raw_tag in (select unnest(?::varchar[])) and source = 'xbrl'",
            [list(shares.WA_BASIC)]).fetchall():
        wa[int(sid)].append((_iso(pe), tag, _num(v), _iso(filed)))
    ctx["wa_rows"] = wa
    ctx["today"] = today_rows(duck, asof)
    ctx["store_cutoff"] = duck.execute(
        "select max(filed_date) from fundamental_metrics").fetchone()[0]
    return ctx


def _eligible_from_snapshot(payload) -> set | None:
    """Tickers passing the picks data and liquidity gates, the old check aside.
    Read in memory from the screener snapshot; only counts leave this module."""
    from .picks import PICK_MIN_MARKET_CAP, QUALITY_PREFIX
    if not payload:
        return None
    p = payload if isinstance(payload, dict) else json.loads(payload)
    f = p.get("fields") or []
    if "ticker" not in f or "data_flags" not in f or "market_cap" not in f:
        return None
    it, iflags, isize = f.index("ticker"), f.index("data_flags"), f.index("market_cap")
    out = set()
    for row in p.get("rows") or []:
        flags = set(row[iflags] or []) - {QUALITY_PREFIX + "shares_multiclass_unsummed"}
        size = _num(row[isize])
        if not flags and size is not None and size >= PICK_MIN_MARKET_CAP:
            out.add(row[it])
    return out


def _splits_counts(ctx, recs, asof) -> dict:
    """J from the store: counts only. No execution date, ratio or ticker list from
    Massive leaves this function."""
    from . import backtest
    splits = ctx["splits"]
    by_year = Counter()
    for sid, lst in splits.items():
        for ex, _ in lst:
            if SPLITS_SINCE <= _iso(ex) <= _iso(asof):
                by_year[_iso(ex)[:4]] += 1
    transients = sum(1 for r in recs if "after_split" in r["_guard_full"])
    out = {"available": True, "rows_by_year": dict(sorted(by_year.items())),
           "live_transients": transients, "in_window": 0, "pairs_on_mixed_bases": 0,
           "bars_fetched_on_a_split_day": 0}
    try:
        start, end = backtest._default_window()
    except Exception as e:
        out["window_note"] = f"backtest window unavailable: {type(e).__name__}"
        return out
    dates = [_d(x) for x in backtest._rebalance_dates(start, end)]
    inwin = {sid: [(_d(ex), f) for ex, f in lst if _d(start) <= _d(ex) <= _d(asof)]
             for sid, lst in splits.items()}
    inwin = {k: v for k, v in inwin.items() if v}
    out["in_window"] = sum(len(v) for v in inwin.values())
    if not inwin or not ctx.get("have_prices"):
        return out
    duck = ctx["duck"]
    bars = defaultdict(dict)
    for sid, d_, ing in duck.execute(BAR_DATES_SQL, [list(inwin)]).fetchall():
        bars[int(sid)][_d(d_)] = _d(ing) if ing is not None else None
    for sid, lst in inwin.items():
        b = bars.get(sid, {})
        for ex, _ in lst:
            out["bars_fetched_on_a_split_day"] += sum(1 for v in b.values() if v == ex)
            for t in dates:
                if t >= ex:
                    continue
                on = max((x for x in b if x <= t), default=None)
                if on is not None and b[on] is not None and b[on] > ex:
                    out["pairs_on_mixed_bases"] += 1
    return out


def _security_master(ctx, recs, companyfacts: bool) -> dict:
    bars, sic = ctx.get("bars", {}), ctx.get("sic", {})
    suffix = [r for r in recs if r["ticker"] and re.search(r"[-.][A-Z]{1,2}$", r["ticker"])]
    out = {"class_suffix_tickers": len(suffix),
           "class_suffix_tickers_without_bars": sum(1 for r in suffix if not bars.get(r["security_id"])),
           "class_suffix_without_bars_list": sorted(r["ticker"] for r in suffix
                                                    if not bars.get(r["security_id"])),
           "sic_6221_in_stock_universe": sum(1 for r in recs if "6221" in sic.get(r["security_id"], ())),
           "sic_6221_list": sorted(r["ticker"] for r in recs if "6221" in sic.get(r["security_id"], ()))}
    if companyfacts:
        out.update(ctx.get("cik_history") or {})
    else:
        out["cik_history"] = "needs --companyfacts (SEC ticker map and submissions)"
    return out


def run_store(asof, companyfacts=False, limit=None, ctx=None) -> tuple[list, dict]:
    """--store and --companyfacts. `ctx` (from read_store) lets a test supply a store."""
    import duckdb
    from .sources import catalog
    ctx = ctx or _store_context(asof, companyfacts)
    if companyfacts:
        # B compares both sides on what the store knew: its own newest filing date.
        ctx["today_at_cutoff"] = today_rows(ctx["duck"], ctx["store_cutoff"])
    secs = list(ctx["securities"])
    if limit:
        secs = secs[:limit]
    recs = []
    tagmap = catalog.xbrl_tag_map()
    sim_con = duckdb.connect()
    pairs, missing = [], []
    memo = {}
    last = 0.0
    for i, sec in enumerate(secs, 1):
        sid = sec["sid"]
        live = ctx["today"].get(sid, {})
        vint = ctx["vintages"].get(sid, [])
        cf = None
        if companyfacts and sec["cik"]:
            if sec["cik"] not in memo:
                memo.clear()
                wait = SEC_MIN_INTERVAL - (time.monotonic() - last)
                if wait > 0:
                    time.sleep(wait)
                last = time.monotonic()
                from .sources import edgar
                try:
                    memo[sec["cik"]] = edgar._companyfacts(sec["cik"], cache=False)
                except Exception:
                    memo[sec["cik"]] = None
            facts = memo[sec["cik"]]
            if facts:
                cf = census_facts(sec, [facts], asof, tagmap, sim_con,
                                  splits=ctx["splits"].get(sid), cutoff=ctx["store_cutoff"])
            else:
                missing.append(sec["ticker"])
        rec = record(sec, live, cf, asof, vint, {"splits": ctx["splits"].get(sid),
                                                  "wa_rows": ctx["wa_rows"].get(sid)})
        recs.append(rec)
        if cf is not None:
            pairs.append((rec, vint, cf["sim_vintages"],
                          ctx["today_at_cutoff"].get(sid, {}).get("shares"),
                          cf["sim_today_at_cutoff"]))
        if i % 250 == 0:
            print(f"   census progress: {i}/{len(secs)}", flush=True)
    out = {"mode": "companyfacts" if companyfacts else "store", "asof": _iso(asof),
           "pick_eligible": ctx.get("pick_eligible"), "splits_available": True,
           "split_sids": set(ctx["splits"]), "universe": len(ctx["securities"]),
           "coverage": {"securities": len(secs),
                        "with_cik": sum(1 for s in secs if s["cik"]),
                        "with_store_share_row": sum(1 for r in recs if r["today_value"] is not None)}}
    if companyfacts:
        out["coverage"]["with_companyfacts"] = sum(1 for r in recs if "_cf" in r)
        out["coverage"]["missing"] = missing[:100]
        cut = ctx["store_cutoff"]
        out["store_vs_sim"] = store_vs_sim(pairs, cut) if pairs else None
        ctx["cik_history"] = _cik_history(secs)
    out["splits_counts"] = _splits_counts(ctx, recs, asof)
    out["security_master"] = _security_master(ctx, recs, companyfacts)
    return recs, out


def _cik_history(secs) -> dict:
    """K (companyfacts mode): securities.cik against SEC's ticker map; each change
    classed verified or candidate by the S8b rules, from submissions JSON."""
    import requests
    from .sources import edgar
    try:
        tmap = edgar._tickers()
    except Exception as e:
        return {"cik_history": f"ticker map unavailable: {type(e).__name__}"}
    missing = [s["ticker"] for s in secs if s["ticker"].upper() not in tmap]
    changes = []
    for s in secs:
        info = tmap.get((s["ticker"] or "").upper())
        if not info or not s["cik"] or info["cik"] == s["cik"]:
            continue
        verdict = "candidate"
        try:
            new = requests.get(f"https://data.sec.gov/submissions/CIK{info['cik']:010d}.json",
                               headers=edgar._headers(), timeout=20).json()
            time.sleep(SEC_MIN_INTERVAL)
            old = requests.get(f"https://data.sec.gov/submissions/CIK{s['cik']:010d}.json",
                               headers=edgar._headers(), timeout=20).json()
            time.sleep(SEC_MIN_INTERVAL)
            former = {(x.get("name") or "").upper() for x in new.get("formerNames") or []}
            if (s.get("name") or "").upper() in former or (old.get("name") or "").upper() in former:
                verdict = "verified"
            else:
                def periodic(sub):
                    rec = (sub.get("filings") or {}).get("recent") or {}
                    return sorted(d_ for f, d_ in zip(rec.get("form", []), rec.get("filingDate", []))
                                  if f in shares.PERIODIC_FORMS)
                pn, po = periodic(new), periodic(old)
                if pn and (not po or po[-1] < pn[0]):
                    verdict = "verified"
        except Exception:
            pass
        changes.append({"ticker": s["ticker"], "stored_cik": s["cik"], "sec_cik": info["cik"],
                        "class": verdict})
    return {"tickers_missing_from_sec_map": len(missing),
            "tickers_missing_from_sec_map_list": sorted(missing)[:200],
            "cik_changes": len(changes), "cik_changes_list": changes}


# --- output ------------------------------------------------------------------------

def headline(S, T, coverage=None) -> list[str]:
    out = []
    cov = coverage or {}
    if "with_companyfacts" in cov:
        # acceptance: companyfacts for at least 98% of securities with a CIK; a fetch
        # that fails mid-run is counted as missing, so this line is where it shows
        base = cov.get("with_cik", cov.get("securities")) or 0
        got = cov["with_companyfacts"]
        out.append(f"companyfacts for {got} of {base} securities with a CIK"
                   + ("" if not base or got >= 0.98 * base else " (BELOW the 98% acceptance)"))
    A = S["A"]
    out.append(f"{A['securities']} securities, {A['with_share_row']} with a share row today; "
               f"old check reproduced as {A['old_check']['issuers']} issuers and "
               f"{A['old_check']['rows']} rows (expected 691 and 1,287 on the full universe)")
    if "available" not in S["C"]:
        C = S["C"]
        out.append(f"collision: {C['over_5pct']} move more than 5% under accession-first selection "
                   f"({C['over_20pct']} over 20%, {C['over_2x']} over 2x); "
                   f"{C['to_nan']} become NaN, {C['from_nan']} gain a count")
    if "available" not in S["G"]:
        G = S["G"]
        out.append(f"missing and stale: {G['no_count_after_resolver']} without a count after the "
                   f"resolver, {G['past_limit']} past the age limit, {G['past_ceiling']} past the ceiling; "
                   f"{G['pool_with_valid_wa']} of {G['pool']} recoverable by a valid weighted average")
    B = S["B"]
    if B.get("available", True) and B.get("today_mismatch_rate") is not None:
        out.append(f"store vs simulation: {B['today_mismatch']} of {B['securities']} today's rows "
                   f"differ (rate {B['today_mismatch_rate']})")
    fired = [k for k, t in T.items() if t["fires"]]
    out.append("thresholds firing: " + (", ".join(fired) if fired else "none"))
    return out


def write(recs, S, T, ctx, out_dir=OUT_DIR, runtime=None) -> tuple[Path, Path]:
    S["M"]["runtime_seconds"] = _r(runtime, 1) if runtime is not None else None
    doc = {"census": "shares", "stage": "S0", "rules_version": shares.RULES_VERSION,
           "mode": ctx["mode"], "asof": ctx["asof"],
           "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
           "coverage": ctx.get("coverage"), "headline": headline(S, T, ctx.get("coverage")),
           "thresholds": T, "sections": S}
    if ctx["mode"] == "cache":
        doc["sample_note"] = ("cache mode: the probe cache leans towards the flagged issuers; "
                              "every figure tests the logic and none sets a threshold")
    licence_check(doc)
    if any(LICENCE_RE.search(c) for c in CSV_COLUMNS):
        raise ValueError("licence guard: a CSV column matches the rule-6 pattern")
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    jp, cp = out_dir / f"{OUT_NAME}.json", out_dir / f"{OUT_NAME}.csv"
    jp.write_text(json.dumps(doc, indent=1, default=str))
    with cp.open("w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(CSV_COLUMNS)
        for r in sorted(recs, key=lambda r: (r["ticker"] or "", r["cik"] or 0)):
            w.writerow(["" if r.get(c) is None else r.get(c) for c in CSV_COLUMNS])
    return jp, cp


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    m = ap.add_mutually_exclusive_group(required=True)
    m.add_argument("--cache", action="append", metavar="DIR",
                   help="companyfacts cache directory (repeatable; the first wins per CIK)")
    m.add_argument("--store", action="store_true", help="Tier B store and Postgres (CI)")
    m.add_argument("--companyfacts", action="store_true",
                   help="as --store plus fresh companyfacts (CI, SEC_USER_AGENT)")
    ap.add_argument("--securities", help="cache mode: JSON list of {ticker, cik, predecessor_ciks}")
    ap.add_argument("--store-dump", action="append", default=[],
                    help="cache mode: tierb-dump JSON (shares_by_ticker, metrics_by_ticker)")
    ap.add_argument("--asof", default=date.today().isoformat())
    ap.add_argument("--out", default=str(OUT_DIR))
    ap.add_argument("--limit", type=int, default=None)
    a = ap.parse_args(argv)
    t0 = time.monotonic()
    asof = _d(a.asof)
    if a.cache:
        recs, ctx = run_cache(a.cache, asof, a.securities, a.store_dump, a.limit)
    else:
        recs, ctx = run_store(asof, companyfacts=a.companyfacts, limit=a.limit)
    S, T = sections(recs, ctx)
    jp, cp = write(recs, S, T, ctx, a.out, time.monotonic() - t0)
    for line in headline(S, T, ctx.get("coverage")):
        print("   " + line)
    print(f"   wrote {jp} and {cp}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
