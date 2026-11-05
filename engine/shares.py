"""Share counts from vintaged EDGAR facts (ADR-043). Pure functions, no I/O.

Not imported by the pipeline yet. S0 (engine/sharescensus.py) runs these exact
functions over the whole universe to measure what the later stages would change;
S4 persists `fact_rows`, S5 wires `classify_accessions` and `select` into the
valuation path. Deterministic, no LLM, no network, no database.

  fact_rows(cik, facts)          every share and proxy fact of one companyfacts JSON,
                                 one row per fact (no setdefault, nothing dropped)
  classify_accessions(rows, ..)  a verdict for each own-date count in each accession,
                                 using only that accession, earlier ones and splits
                                 executed on or before its filing date
  select(verdicts, asof)         the count a date would use: newest visible periodic
                                 accession first, then the cleanest concept in it

Point in time by construction: a verdict never looks at a later filing, so the
verdicts for accessions filed by a date are the same whether or not later
accessions exist (truncation invariance). Raw values are never changed; a FIX or a
QUARANTINE lives in `value_clean` beside `value_raw`.

Licensing: everything here is EDGAR (public domain). `splits` rows, when passed in,
are licensed Massive corporate actions; they are used in memory only, and no output
field carries a split ratio, an execution date or anything derived from one (a vote
a split explains is recorded only as the label `split_explained`).
"""
from __future__ import annotations

import math
from collections import defaultdict
from datetime import date

RULES_VERSION = 1   # initial bands; frozen only after the S0 companyfacts census (T5)

COVER = "dei:EntityCommonStockSharesOutstanding"
CSO = "us-gaap:CommonStockSharesOutstanding"
CSI = "us-gaap:CommonStockSharesIssued"
IFRS_OUTSTANDING = "ifrs-full:NumberOfSharesOutstanding"
TREASURY = ("us-gaap:TreasuryStockShares", "us-gaap:TreasuryStockCommonShares")
SHARE_CONCEPTS = (COVER, CSO, CSI, *TREASURY, IFRS_OUTSTANDING)

WA_BASIC = ("us-gaap:WeightedAverageNumberOfSharesOutstandingBasic",
            "us-gaap:WeightedAverageNumberOfShareOutstandingBasicAndDiluted",
            "ifrs-full:WeightedAverageShares")
WA_DILUTED = "us-gaap:WeightedAverageNumberOfDilutedSharesOutstanding"
EPS_BASIC = ("us-gaap:EarningsPerShareBasic", "us-gaap:EarningsPerShareBasicAndDiluted",
             "ifrs-full:BasicEarningsLossPerShare")
# Basic-EPS numerators, best first: the one that is the EPS numerator by definition,
# then the parent's net income.
NI_PARENT = ("us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic", "us-gaap:NetIncomeLoss",
             "ifrs-full:ProfitLossAttributableToOwnersOfParent")
NI_CONSOLIDATED = ("us-gaap:ProfitLoss", "ifrs-full:ProfitLoss")
NI_NCI = ("us-gaap:NetIncomeLossAttributableToNoncontrollingInterest",
          "ifrs-full:ProfitLossAttributableToNoncontrollingInterests")
EQ_PARENT = ("us-gaap:StockholdersEquity", "ifrs-full:EquityAttributableToOwnersOfParent")
EQ_CONSOLIDATED = ("us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
                   "ifrs-full:Equity")
EQ_NCI = ("us-gaap:MinorityInterest", "ifrs-full:NoncontrollingInterests")
PUBLIC_FLOAT = "dei:EntityPublicFloat"
ADS_RATIO = "dei:EntityListingDepositoryReceiptRatio"
SPLIT_RATIO_TAG = "us-gaap:StockholdersEquityNoteStockSplitConversionRatio1"
PROXY_CONCEPTS = (*WA_BASIC, WA_DILUTED, *EPS_BASIC,
                  "us-gaap:NetIncomeLoss", "us-gaap:NetIncomeLossAvailableToCommonStockholdersBasic",
                  "us-gaap:ProfitLoss", "us-gaap:NetIncomeLossAttributableToNoncontrollingInterest",
                  "ifrs-full:ProfitLoss", "ifrs-full:ProfitLossAttributableToOwnersOfParent",
                  "ifrs-full:ProfitLossAttributableToNoncontrollingInterests",
                  "us-gaap:StockholdersEquity",
                  "us-gaap:StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
                  "us-gaap:MinorityInterest",
                  "ifrs-full:Equity", "ifrs-full:EquityAttributableToOwnersOfParent",
                  "ifrs-full:NoncontrollingInterests",
                  PUBLIC_FLOAT, ADS_RATIO, SPLIT_RATIO_TAG)
CONCEPTS = SHARE_CONCEPTS + PROXY_CONCEPTS

# The forms that put new numbers into companyfacts; the same set as
# edgar.FUNDAMENTAL_FORMS (a test keeps the two equal; this module stays import-light).
PERIODIC_FORMS = frozenset({"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A"})
FOREIGN_FORMS = frozenset({"20-F", "20-F/A", "40-F", "40-F/A"})
SIX_K = frozenset({"6-K", "6-K/A"})

MAX_COUNT_AGE_DAYS = 400          # flagged shares_stale past this
MAX_COUNT_AGE_DAYS_FOREIGN = 550  # 20-F/40-F covers are dated at year-end, filed months later
CEILING_FACTOR = 2                # NaN (stale_beyond_ceiling) past twice the limit
STALE_COVER_DAYS = 120            # a cover dated this long before filing is not a candidate
STALE_COVER_DAYS_FOREIGN = 200    # 20-F/40-F covers are dated at fiscal year-end by the form
FUTURE_COVER_DAYS = 31            # a cover dated this far after filing is clamped to filed_date
ISSUED_MAX_OVER_WA = 1.15         # issued is used only this close to the validated W
WA_PRIOR_DAYS = 400               # W is checked against counts accepted this far back
MIN_EPS = 0.05                    # |EPS| below this makes NI/EPS too noisy to vote

# Bands of the scale-error policy (initial; S0 reports the verdicts that flip at +-10%).
BANDS = {
    "count": (1 / 1.35, 1.35),    # count against count (cover, balance sheet, prior)
    "income": (1 / 1.5, 1.5),     # count against a period average (NI/EPS or W)
    "issued_upper": 3.0,          # issued may exceed outstanding by treasury stock
    "fix": (0.8, 1.25),           # value / (proxy x 1000^k) inside this is "scale k"
}
UNVERIFIED_RANGE = (1e4, 6e10)    # a count with no evidence at all is kept only inside this
# W is rejected when it sits about 10^k from the issuer's accepted counts:
# k a non-zero multiple of 3 within 30%, or k = +-1 within 3%.
WA_REJECT = (((3, 6, 9), 0.30), ((1,), 0.03))

GROUP_OF = {"cover": "cover", "bs": "bs", "issued_minus_treasury": "bs", "bs_issued": "bs"}
COUNT_ORDER = ("cover", "bs", "issued_minus_treasury", "bs_issued")


def _d(s) -> date:
    return s if isinstance(s, date) else date.fromisoformat(str(s)[:10])


def _num(v):
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


# --- S4 shape: every fact as a vintage ---------------------------------------

def fact_rows(cik: int, facts: dict, concepts=CONCEPTS) -> list[dict]:
    """Every share and proxy fact in one companyfacts JSON, one row per fact.

    Columns follow the S4 `share_facts` schema. companyfacts carries no dimensions,
    so `class_member` is '' (per-class facts come from filing instances, S9b), and
    `duration_days` is 0 for instants so every key column is non-null."""
    out = []
    want = defaultdict(set)
    for q in concepts:
        ns, c = q.split(":", 1)
        want[ns].add(c)
    for ns, cs in (facts.get("facts") or {}).items():
        for concept, node in cs.items():
            if concept not in want.get(ns, ()):
                continue
            q = f"{ns}:{concept}"
            for unit, arr in (node.get("units") or {}).items():
                for f in arr:
                    end, filed = f.get("end"), f.get("filed")
                    if not end or not filed:
                        continue
                    start = f.get("start")
                    out.append({
                        "cik": int(cik), "accession": f.get("accn") or "", "filed_date": filed,
                        "form": f.get("form") or "", "fiscal_year": f.get("fy"),
                        "fiscal_period": f.get("fp") or "", "concept": q, "class_member": "",
                        "period_start": start, "period_end": end,
                        "duration_days": (_d(end) - _d(start)).days if start else 0,
                        "unit": unit, "value": _num(f.get("val")), "value_text": None,
                        "decimals": None, "source": "companyfacts"})
    return out


# --- S5: same-filing classification -------------------------------------------

def _vote(v: float, p: float, band: tuple, fix: tuple) -> str:
    if not v or not p or v <= 0 or p <= 0:
        return "disagree"
    r = v / p
    if band[0] <= r <= band[1]:
        return "agree"
    k = round(math.log10(r) / 3)
    if k and fix[0] <= r / 1000 ** k <= fix[1]:
        return f"scale{k:+d}"
    return "disagree"


def _verdict(votes: dict) -> tuple[str, int]:
    """Scale-error policy rules 6 to 8 -> (verdict, k)."""
    agree = sum(1 for lab in votes.values() if lab in ("agree", "split_explained"))
    scales = defaultdict(int)
    for lab in votes.values():
        if lab.startswith("scale"):
            scales[lab] += 1
    if len(scales) == 1:
        lab, n = next(iter(scales.items()))
        if n >= 2 and n > agree:
            return "FIX", int(lab[5:])
    if len(votes) - agree > agree:
        return "QUARANTINE", 0
    return ("OK" if votes else "UNVERIFIED"), 0


def _split_factors(splits, lo, hi) -> list[float]:
    """Cumulative factors of the splits executed in (lo, hi], oldest first."""
    if not splits:
        return []
    lo, hi = _d(lo), _d(hi)
    out, k = [], 1.0
    for ex, ratio in sorted((_d(s[0]), s[1]) for s in splits if s[1] and s[1] > 0):
        if lo < ex <= hi:
            k *= ratio
            out.append(k)
    return out


def _wa_scale_off(w: float, ref: float) -> bool:
    if not w or not ref or w <= 0 or ref <= 0:
        return False
    r = w / ref
    for ks, tol in WA_REJECT:
        for k in ks:
            for sign in (1, -1):
                if abs(r / 10 ** (sign * k) - 1) <= tol:
                    return True
    return False


def _shortest(facts: list[dict], end: str):
    """The fact with the shortest duration ending at `end` (latest start wins)."""
    fs = [f for f in facts if f["period_end"] == end and f["duration_days"] > 0
          and f["value"] is not None]
    return max(fs, key=lambda f: (f["period_start"], f["concept"], -f["value"])) if fs else None


def _at(facts: list[dict], end: str):
    """The fact at `end`; duplicates resolve the same way whatever the input order."""
    fs = [f for f in facts if f["period_end"] == end and f["value"] is not None]
    return min(fs, key=lambda f: (f["value"], f["fiscal_period"])) if fs else None


def _income(by_q: dict, pe: str):
    """NI over basic EPS for the same duration (|EPS| >= MIN_EPS, same currency).
    Returns (value, source) or (None, None)."""
    for eq in EPS_BASIC:
        e = _shortest(by_q.get(eq, []), pe)
        if not e or abs(e["value"]) < MIN_EPS:
            continue
        cur = e["unit"].split("/")[0]
        for nq in NI_PARENT:
            for n in by_q.get(nq, []):
                if (n["period_start"] == e["period_start"] and n["period_end"] == pe
                        and n["unit"] == cur and n["value"]):
                    v = n["value"] / e["value"]
                    if v > 0:
                        return v, "ni_eps"
    return None, None


def _accessions(rows: list[dict]) -> list[tuple[str, list[dict]]]:
    acc = defaultdict(list)
    for r in rows:
        if r["concept"] in CONCEPTS:
            acc[r["accession"]].append(r)
    order = sorted(acc, key=lambda a: (min(r["filed_date"] for r in acc[a]), a))
    return [(a, acc[a]) for a in order]


def classify_accessions(rows: list[dict], prior: dict | None = None, splits=None,
                        bands: dict | None = None) -> list[dict]:
    """A verdict for each own-date candidate in each accession, oldest first.

    rows    fact_rows for one issuer (its CIK set), any order.
    prior   the validated count before the first accession in `rows`, as
            {"value", "filed_date"}; None when `rows` is the issuer's whole history.
    splits  [(execution_date, split_to / split_from)] in memory, or None. Only splits
            executed on or before an accession's filing date affect its verdicts.
    bands   override of BANDS (S0 moves every band 10% to find fragile verdicts).

    Asof-invariant: an accession's verdicts depend only on itself, earlier
    accessions and splits executed by its filing date."""
    B = dict(BANDS, **(bands or {}))
    out: list[dict] = []
    accepted: list[tuple] = []   # (count_date, value_clean, filed_date) of prior bests
    prev = dict(prior) if prior else None
    for accn, facts in _accessions(rows):
        filed = min(f["filed_date"] for f in facts)
        form = min((f["form"] for f in facts if f["form"]), default="")
        cik = min(f["cik"] for f in facts)
        by_q = defaultdict(list)
        for f in facts:
            by_q[f["concept"]].append(f)
        durations = [f["period_end"] for f in facts if f["duration_days"] > 0]
        instants = [f["period_end"] for q in (CSO, CSI, IFRS_OUTSTANDING) for f in by_q.get(q, [])]
        pe = max(durations) if durations else (max(instants) if instants else None)

        cand: dict[str, dict] = {}
        covers = [f for f in by_q.get(COVER, []) if f["value"] is not None]
        if covers:
            cd = max(f["period_end"] for f in covers)
            stale = STALE_COVER_DAYS_FOREIGN if form in FOREIGN_FORMS else STALE_COVER_DAYS
            if (_d(filed) - _d(cd)).days <= stale:
                cand["cover"] = _at(covers, cd)
        if pe:
            for name, qs in (("bs", (CSO, IFRS_OUTSTANDING)), ("bs_issued", (CSI,))):
                for q in qs:
                    f = _at(by_q.get(q, []), pe)
                    if f:
                        cand[name] = f
                        break
            tr = next((t for q in TREASURY for t in [_at(by_q.get(q, []), pe)] if t), None)
            if "bs_issued" in cand and tr and tr["value"] and tr["value"] > 0:
                imt = cand["bs_issued"]["value"] - tr["value"]
                if imt > 0:
                    cand["issued_minus_treasury"] = dict(cand["bs_issued"], value=imt,
                                                         concept=f"{CSI}-treasury")
        else:
            tr = None

        # The weighted average is checked first, against counts accepted in the prior
        # WA_PRIOR_DAYS: one tagged in thousands or millions is no evidence at all.
        wa = None
        for q in WA_BASIC:
            wa = _shortest(by_q.get(q, []), pe) if pe else None
            if wa:
                break
        wa_ok = None
        if wa:
            # earlier counts are put on this filing's basis with the splits executed since
            ref_vals = [v * (_split_factors(splits, f_, filed) or [1.0])[-1] for d_, v, f_ in accepted
                        if pe and 0 <= (_d(pe) - d_).days <= WA_PRIOR_DAYS and v > 0]
            ref = math.exp(sorted(math.log(v) for v in ref_vals)[len(ref_vals) // 2]) \
                if ref_vals else None
            if wa["value"] <= 0 or (ref and _wa_scale_off(wa["value"], ref)):
                wv, wr = "QUARANTINE", ("non_positive" if wa["value"] <= 0 else "wa_scale")
            else:
                wv, wr = ("OK" if ref else "UNVERIFIED"), None
                wa_ok = wa["value"]
            out.append(_row(cik, accn, filed, form, "wa_basic", wa, wa["period_end"],
                            wa["value"] if wa_ok else None, wv, None, wr, {}))

        inc, inc_src = _income(by_q, pe) if pe else (None, None)
        if inc is None and wa_ok:
            inc, inc_src = wa_ok, "wa"
        bs_rep = cand.get("bs") or cand.get("issued_minus_treasury")
        prior_v = None
        if prev:
            k = _split_factors(splits, prev["filed_date"], filed)
            prior_v = prev["value"] * (k[-1] if k else 1.0)

        results = {}
        for name in COUNT_ORDER:
            f = cand.get(name)
            if not f:
                continue
            v = f["value"]
            count_date = f["period_end"]
            fl = []
            if (_d(count_date) - _d(filed)).days > FUTURE_COVER_DAYS:
                count_date, fl = filed, ["count_date_future"]
            hi = B["issued_upper"] if name == "bs_issued" else B["count"][1]
            cband, iband = (B["count"][0], hi), (B["income"][0], max(hi, B["income"][1]))
            proxies = {}
            if name != "cover" and "cover" in cand:
                proxies["cover"] = (cand["cover"]["value"], cband)
            if GROUP_OF[name] != "bs" and bs_rep:
                proxies["bs"] = (bs_rep["value"], cband)
            if inc:
                proxies["income"] = (inc, iband)
            if prior_v:
                proxies["prior"] = (prior_v, cband)
            ks = _split_factors(splits, count_date, filed)
            votes = {}
            for g, (p, band) in proxies.items():
                lab = _vote(v, p, band, B["fix"])
                if lab != "agree" and ks and g != "prior" and any(
                        _vote(v * kk, p, band, B["fix"]) == "agree" or
                        _vote(v / kk, p, band, B["fix"]) == "agree" for kk in ks):
                    lab = "split_explained"
                votes[g] = lab
            reason, k = None, 0
            if v is None or v <= 0:
                vd, reason = "QUARANTINE", "non_positive"
            elif (name == "bs" and f["concept"] == CSO and "bs_issued" in cand
                    and cand["bs_issued"]["value"] == v and tr and (tr["value"] or 0) > 0):
                vd, reason = "QUARANTINE", "cso_equals_issued"
            else:
                vd, k = _verdict(votes)
                if vd == "QUARANTINE":
                    reason = "votes_disagree"
                elif vd == "UNVERIFIED" and not (UNVERIFIED_RANGE[0] <= v <= UNVERIFIED_RANGE[1]):
                    vd, reason = "QUARANTINE", "implausible_unverified"
            clean = None if vd == "QUARANTINE" else (v / 1000 ** k if k else v)
            fix_code = None
            if vd == "FIX":
                fix_code = (f"scale_div_1e{3 * k}" if k > 0 else f"scale_mul_1e{-3 * k}")
            row = _row(cik, accn, filed, form, name, f, count_date, clean, vd, fix_code, reason,
                       votes, value_raw=v)
            row["flags"] = fl
            row["income_source"] = inc_src
            out.append(row)
            results[name] = row

        best = None
        for name in COUNT_ORDER:
            r = results.get(name)
            if not r or r["value_clean"] is None:
                continue
            if name == "bs_issued" and wa_ok and r["value_clean"] > ISSUED_MAX_OVER_WA * wa_ok:
                continue
            best = r
            break
        chain = form in PERIODIC_FORMS or (form in SIX_K and best is not None and _supported(best))
        if best and chain:
            prev = {"value": best["value_clean"], "filed_date": filed}
            accepted.append((_d(best["count_date"]), best["value_clean"], filed))
    return out


def _row(cik, accn, filed, form, candidate, f, count_date, clean, verdict, fix_code, reason,
         votes, value_raw=None):
    return {"cik": cik, "accession": accn, "filed_date": filed, "form": form,
            "candidate": candidate, "concept": f["concept"], "class_member": f["class_member"],
            "period_end": f["period_end"], "count_date": count_date,
            "value_raw": f["value"] if value_raw is None else value_raw,
            "value_clean": clean, "verdict": verdict, "fix_code": fix_code, "reason": reason,
            "votes": dict(votes), "rules_version": RULES_VERSION, "flags": [],
            "income_source": None}


def _supported(r: dict) -> bool:
    """At least one group stands behind the value: an agreeing vote, or the two
    agreeing groups a FIX needs."""
    return r["verdict"] == "FIX" or any(lab in ("agree", "split_explained")
                                        for lab in r["votes"].values())


def _visible(r: dict, asof) -> bool:
    if _d(r["filed_date"]) > _d(asof):
        return False
    return r["form"] in PERIODIC_FORMS or (r["form"] in SIX_K and _supported(r))


def select(verdicts: list[dict], asof) -> dict:
    """The count `asof` would use, accession first (S5), with the S0 measures beside it.

    Visible accessions are periodic forms filed on or before asof (the inclusive
    cut-off of tierb.metrics_asof until S7a), plus 6-Ks whose count has at least one
    agreeing group. The newest visible accession with a usable candidate wins; within
    it: cover, CSO, issued minus treasury, then issued (only within 1.15x of that
    filing's validated weighted average, or when it has none). Stepping back past a
    newer accession whose counts were all unusable flags `shares_stale_accession`.
    A count past the age limit is flagged `shares_stale`; past twice the limit it is
    NaN with reason `stale_beyond_ceiling`. The weighted average is reported, never
    substituted (that is S6)."""
    asof = _d(asof)
    by_acc = defaultdict(dict)
    meta = {}
    for r in verdicts:
        if _d(r["filed_date"]) > asof:
            continue
        by_acc[r["accession"]][r["candidate"]] = r
        meta[r["accession"]] = (r["filed_date"], r["form"])
    order = sorted(by_acc, key=lambda a: (meta[a][0], a), reverse=True)
    periodic = [a for a in order if meta[a][1] in PERIODIC_FORMS]
    newest_periodic = periodic[0] if periodic else None
    form0 = meta[newest_periodic][1] if newest_periodic else None
    limit = MAX_COUNT_AGE_DAYS_FOREIGN if form0 in FOREIGN_FORMS else MAX_COUNT_AGE_DAYS

    out = {"value": None, "candidate": None, "concept": None, "count_date": None,
           "accession": None, "filed_date": None, "form": None, "verdict": None,
           "fix_code": None, "reason": None, "flags": [], "age_days": None,
           "limit_days": limit, "newest_periodic_accession": newest_periodic,
           "newest_periodic_form": form0, "newest_periodic_filed": meta[newest_periodic][0]
           if newest_periodic else None}
    first_with_counts = None
    for a in order:
        c = by_acc[a]
        counts = [c[n] for n in COUNT_ORDER if n in c and _visible(c[n], asof)]
        if not counts:
            continue
        first_with_counts = first_with_counts or a
        w = c.get("wa_basic")
        w_ok = w["value_clean"] if w else None
        pick = None
        for r in counts:
            if r["value_clean"] is None:
                continue
            if r["candidate"] == "bs_issued" and w_ok and r["value_clean"] > ISSUED_MAX_OVER_WA * w_ok:
                continue
            pick = r
            break
        if not pick:
            continue
        out.update(value=pick["value_clean"], candidate=pick["candidate"], concept=pick["concept"],
                   count_date=pick["count_date"], accession=a, filed_date=pick["filed_date"],
                   form=pick["form"], verdict=pick["verdict"], fix_code=pick["fix_code"],
                   flags=list(pick["flags"]))
        if a != first_with_counts:
            out["flags"].append("shares_stale_accession")
        if pick["verdict"] == "FIX":
            out["flags"].append("shares_value_fixed")
        break
    if out["count_date"]:
        age = (asof - _d(out["count_date"])).days
        out["age_days"] = age
        if age > CEILING_FACTOR * limit:
            out.update(value=None, reason="stale_beyond_ceiling")
            out["flags"].append("shares_value_quarantined")
        elif age > limit:
            out["flags"].append("shares_stale")
    elif first_with_counts:
        out["reason"] = "no_valid_count"

    # The basic weighted average, reported three ways and never substituted (S6):
    # in the count's own accession (the C/W evidence), in the newest periodic
    # accession (raw, with its verdict), and the newest validated one (the fallback).
    same = by_acc[out["accession"]].get("wa_basic") if out["accession"] else None
    newest = by_acc[newest_periodic].get("wa_basic") if newest_periodic else None
    fallback = next((by_acc[a]["wa_basic"] for a in periodic
                     if by_acc[a].get("wa_basic") and by_acc[a]["wa_basic"]["value_clean"]), None)
    out.update(wa_value=same["value_clean"] if same else None,
               wa_newest_raw=newest["value_raw"] if newest else None,
               wa_newest_value=newest["value_clean"] if newest else None,
               wa_newest_verdict=newest["verdict"] if newest else None,
               wa_newest_period_end=newest["period_end"] if newest else None,
               wa_fallback_value=fallback["value_clean"] if fallback else None,
               wa_fallback_period_end=fallback["period_end"] if fallback else None,
               wa_fallback_accession=fallback["accession"] if fallback else None)
    return out


# --- ADS ratios (dei, companyfacts) ----------------------------------------------

def ads_ratios(rows: list[dict], asof) -> list[tuple[str, float]]:
    """[(effective_from, ordinaries per ADS)] from dei:EntityListingDepositoryReceiptRatio
    facts filed on or before asof, collapsed to the dates the ratio changes.
    BABA: [('2019-07-29', 1.0), ('2019-07-30', 8.0)]."""
    seen = {}
    for r in rows:
        if r["concept"] == ADS_RATIO and r["value"] and _d(r["filed_date"]) <= _d(asof):
            seen.setdefault(r["period_end"], r["value"])
    out = []
    for end in sorted(seen):
        if not out or out[-1][1] != seen[end]:
            out.append((end, seen[end]))
    return out


def ads_ratio_at(rows: list[dict], on, asof):
    """The ratio in effect on `on`: the latest effective date on or before it."""
    hist = [x for x in ads_ratios(rows, asof) if _d(x[0]) <= _d(on)]
    return hist[-1][1] if hist else None
