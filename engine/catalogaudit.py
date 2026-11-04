"""Catalogue audit: which metric_catalog rows actually collect anything.

The 31 Oct proposal review found live catalogue rows that collect nothing:
production_volume's tags are filed by 0 of 688 issuers, and several KPI rows carry
guessed or malformed tags ('us-gaap:Sales', 'us-gaap_X'). Nothing said so, because a
row that collects nothing fails quietly: ingestion just finds no facts for it.

REPORT-ONLY. This reads the committed catalogue (engine/sources/metric_catalog.json,
the file ingestion builds its tag map from), the live Postgres metric_catalog table
when DATABASE_URL is set (in a read-only transaction), the Tier B fundamental_metrics
view when the store is present (CI), and optionally SEC XBRL frames. It never changes
any of them. The only files it writes are data/catalog_audit.json and
data/catalog_audit.md, and every suggested action is text for a human.

Deterministic, $0, no LLM. It never reads the Tier B prices view: the report is a
public artifact and Massive bars are licensed (P0.5a), so the view is dropped from the
connection before any query runs.

Verdicts, most urgent first (each row gets the first that applies; `flags` keeps all):
  malformed_tag       a tag is not "ns:Concept", so the tag map cannot match it
  db_json_drift       Postgres and the JSON disagree (ingestion reads the JSON)
  non_xbrl_by_design  disclosed in MD&A, 8-K, decks: nothing to collect from XBRL
  dead                collects nothing: no tag lands as this code, no filer uses
                      the tags, no rows in the store, or (computed) no input covered
  low_coverage        fewer than --min-issuers issuers
  unverified          no evidence either way (no store, no frames): run it in CI
  ok

  python -m engine.catalogaudit             # JSON (+ Postgres and store when present)
  python -m engine.catalogaudit --frames    # also count SEC filers per tag (CI)
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from datetime import date, datetime, timezone
from pathlib import Path

from . import db, tierb
from .config import DATA_DIR, sec_user_agent
from .sources import catalog

OUT_DIR = DATA_DIR
MIN_ISSUERS = 25
VERDICTS = ("malformed_tag", "db_json_drift", "non_xbrl_by_design", "dead",
            "low_coverage", "unverified", "ok")
# Namespaces SEC companyfacts and frames know, and the subset ingestion reads
# (engine/sources/edgar.py::_iter_facts). A srt: tag is well formed but never collected.
_KNOWN_NS = ("us-gaap", "dei", "ifrs-full", "srt")
_INGESTED_NS = ("us-gaap", "dei", "ifrs-full")
# Fields that change what gets collected; a label edit is not drift.
_DRIFT_FIELDS = ("in_xbrl", "xbrl_tags", "source_if_not_xbrl", "unit")

_TAG_RE = re.compile(r"([A-Za-z][A-Za-z0-9-]*)([:_])([A-Za-z][A-Za-z0-9]*)")
_MENTION_RE = re.compile(r"\b(us-gaap|dei|ifrs-full|srt)[:_]([A-Z][A-Za-z0-9]+)")
_CONCEPT_RE = re.compile(r"\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]*)+\b")


def normalise_tag(raw) -> tuple[str, str | None]:
    """(tag as "ns:Concept", problem or None). A problem means ingestion's
    namespace-stripping tag map (catalog.xbrl_tag_map) would not match the tag as
    written, or it names a namespace SEC does not publish."""
    s = str(raw or "").strip()
    m = _TAG_RE.fullmatch(s)
    if not m:
        if re.fullmatch(r"[A-Z][A-Za-z0-9]*", s):
            return f"us-gaap:{s}", "no namespace (us-gaap assumed)"
        return s, "not an ns:Concept tag"
    ns, sep, concept = m.groups()
    tag = f"{ns.lower()}:{concept}"
    if sep == "_":
        return tag, "underscore separator (an XBRL element id, not ns:Concept)"
    if ns.lower() not in _KNOWN_NS:
        return tag, f"unknown namespace {ns!r}"
    if ns != ns.lower():
        return tag, "upper-case namespace"
    if not concept[0].isupper():
        return tag, "concept must start upper-case"
    return tag, None


def _tags_of(row: dict) -> list:
    tags = row.get("xbrl_tags") or []
    if isinstance(tags, str):  # jsonb can arrive as text
        try:
            tags = json.loads(tags)
        except ValueError:
            tags = [tags]
    return list(tags)


def _kind(row: dict) -> str:
    if row.get("in_xbrl"):
        return "xbrl"
    src = (row.get("source_if_not_xbrl") or "").strip()
    if src == "computed":
        return "computed"
    if src and src != "n_a":
        return "by_design"
    return "xbrl"  # in_xbrl false and no other source: judged (and found dead) on its tags


# --- evidence ---------------------------------------------------------------

def _db_catalog() -> tuple[list[dict] | None, str | None]:
    """The live metric_catalog rows, read in a read-only transaction."""
    if not db.have_db():
        return None, None
    try:
        with db.connect() as conn:
            conn.read_only = True  # belt and braces: Postgres refuses any write
            with conn.cursor() as cur:
                cur.execute("select metric_code, label, definition, unit, in_xbrl, "
                            "xbrl_tags, source_if_not_xbrl, notes from metric_catalog")
                cols = [d[0] for d in cur.description]
                return [dict(zip(cols, r)) for r in cur.fetchall()], None
    except Exception as e:
        return None, f"metric_catalog read failed: {str(e)[:160]}"


def _store():
    """Tier B with only fundamental_metrics left registered, or None outside CI.
    Dropping the prices view first means no query here can read licensed prices."""
    if not tierb.enabled():
        return None
    con = tierb.connect()
    con.execute("drop view if exists prices")
    return con


def _day(d) -> str | None:
    return str(d) if d is not None else None


def store_coverage(con, tags: list[str], codes: list[str]) -> dict:
    """Distinct securities and latest filed_date per raw_tag and per metric_code,
    from fundamental_metrics only."""
    by_tag = {t: {"issuers": n, "last_filed": _day(last), "stored_as": sorted(mc)}
              for t, n, last, mc in con.execute(
                  "select raw_tag, count(distinct security_id), max(filed_date), "
                  "list(distinct metric_code) from fundamental_metrics "
                  "where raw_tag in (select unnest(?::varchar[])) group by raw_tag",
                  [tags]).fetchall()}
    by_code = {c: {"issuers": n, "last_filed": _day(last)}
               for c, n, last in con.execute(
                   "select metric_code, count(distinct security_id), max(filed_date) "
                   "from fundamental_metrics where metric_code in "
                   "(select unnest(?::varchar[])) group by metric_code", [codes]).fetchall()}
    rows, issuers, last = con.execute(
        "select count(*), count(distinct security_id), max(filed_date) "
        "from fundamental_metrics").fetchone()
    return {"rows": rows, "issuers": issuers, "last_filed": _day(last),
            "by_tag": by_tag, "by_code": by_code}


# SEC XBRL frames: one fact per filer per calendar period, so the length of `data` is
# the number of filers using that concept. Kept in this module for now: fold it into
# a shared SEC helper once PR #78 (agents v2) lands, since that adds SEC frames
# verification too.
_FRAMES_URL = "https://data.sec.gov/api/xbrl/frames/{ns}/{concept}/{unit}/{period}.json"
_MIN_INTERVAL = 0.2  # at most 5 requests a second (SEC's fair-use ceiling is 10)
_FRAME_UNITS = ("USD", "shares", "pure", "USD-per-shares")


def _frame_units(unit: str) -> list[str]:
    """The SEC unit the catalogue unit implies first, then the rest: a guessed unit
    that 404s must not read as "nobody files this"."""
    u = (unit or "").lower()
    first = ("USD-per-shares" if "share" in u and "usd" in u else "shares" if "share" in u
             else "pure" if ("percent" in u or "ratio" in u) else "USD")
    return [first] + [x for x in _FRAME_UNITS if x != first]


def frames_coverage(tag_units: dict[str, str], year: int, get=None,
                    sleep=time.sleep) -> dict:
    """Filers per tag for calendar `year` (duration frame CY{year}, then the instant
    frame CY{year}Q4I). Failures are recorded per tag, never raised."""
    out = {"year": year, "error": None, "tags": {}}
    try:
        headers = {"User-Agent": sec_user_agent(), "Accept-Encoding": "gzip, deflate"}
    except RuntimeError as e:
        out["error"] = str(e)[:200]
        return out
    if get is None:
        import requests
        get = requests.get
    last = 0.0
    for tag, unit in sorted(tag_units.items()):
        ns, concept = tag.split(":", 1)
        res = {"filers": 0, "unit": None, "period": None, "error": None}
        for u in _frame_units(unit):
            for period in (f"CY{year}", f"CY{year}Q4I"):
                gap = _MIN_INTERVAL - (time.monotonic() - last)
                if gap > 0:
                    sleep(gap)
                last = time.monotonic()
                url = _FRAMES_URL.format(ns=ns, concept=concept, unit=u, period=period)
                try:
                    r = get(url, headers=headers, timeout=30)
                    if r.status_code == 404:
                        continue
                    if r.status_code != 200:
                        res["error"] = f"HTTP {r.status_code} for {u}/{period}"
                        continue
                    body = r.json()
                    res.update(filers=len(body.get("data") or []) or int(body.get("pts") or 0),
                               unit=u, period=period, error=None)
                    break
                except Exception as e:
                    res["error"] = f"{type(e).__name__}: {str(e)[:120]}"
            if res["period"]:
                break
        if res["error"] and not res["period"]:
            res["filers"] = None  # unknown, not zero: a failed fetch is not evidence
        out["tags"][tag] = res
    return out


# --- the audit --------------------------------------------------------------

def _drift(j: dict | None, d: dict | None) -> list[str]:
    if d is None:
        return ["missing from Postgres metric_catalog"]
    if j is None:
        return ["only in Postgres: ingestion reads metric_catalog.json, so nothing collects it"]

    def norm(row, f):
        v = row.get(f)
        if f == "xbrl_tags":
            return [str(t).strip() for t in _tags_of(row)]
        if f == "in_xbrl":
            return bool(v)
        return (v or "").strip()
    return [f"{f}: json={norm(j, f)!r} db={norm(d, f)!r}"
            for f in _DRIFT_FIELDS if norm(j, f) != norm(d, f)]


def _inputs(row: dict, codes: set[str], tagmap: dict[str, str]) -> list[dict]:
    """What a computed row says it is computed from: catalogue codes named in its
    definition/notes, plus XBRL concepts (its own tags, ns:Concept mentions, and bare
    concepts the tag map knows), each resolved to the catalogue code that collects it."""
    code = row["metric_code"]
    text = f"{row.get('definition') or ''} {row.get('notes') or ''}"
    out: dict[str, dict] = {}
    for c in sorted(codes - {code}):
        if re.search(rf"(?<![a-z0-9_]){re.escape(c)}(?![a-z0-9_])", text):
            out[c] = {"input": c, "code": c}
    tags = [normalise_tag(t)[0] for t in _tags_of(row)]
    tags += [f"{ns}:{c}" for ns, c in _MENTION_RE.findall(text)]
    tags += [f"us-gaap:{c}" for c in _CONCEPT_RE.findall(text) if c in tagmap]
    for tag in tags:
        ns, concept = tag.split(":", 1) if ":" in tag else ("", tag)
        hit = tagmap.get(concept) if ns in _INGESTED_NS else None
        hit = hit if hit in codes else None  # a pinned code this catalogue lacks
        out.setdefault(hit or tag, {"input": tag, "code": hit})
    return list(out.values())


def audit(json_rows: list[dict], db_rows: list[dict] | None = None, con=None,
          frames: dict | None = None, min_issuers: int = MIN_ISSUERS) -> dict:
    """Pure over its inputs: builds the report, writes nothing."""
    jmap = {r["metric_code"]: r for r in json_rows}
    dmap = {r["metric_code"]: r for r in db_rows} if db_rows is not None else None
    order = list(jmap) + [c for c in (dmap or {}) if c not in jmap]
    tagmap = catalog.xbrl_tag_map(json_rows)  # the exact map ingestion builds
    codes = set(order)

    rows = []
    for code in order:
        base = jmap.get(code) or dmap[code]
        seen: dict[str, dict] = {}
        for side, r in (("json", jmap.get(code)), ("db", (dmap or {}).get(code))):
            for raw in _tags_of(r or {}):
                tag, problem = normalise_tag(raw)
                t = seen.setdefault(raw, {"raw": raw, "tag": tag, "problem": problem, "in": []})
                t["in"].append(side)
        for t in seen.values():
            ns, concept = t["tag"].split(":", 1) if ":" in t["tag"] else ("", t["tag"])
            # What ingestion files a fact of this concept under (None: never collected).
            # Looked up by the concept a filer actually files, so 'us-gaap_X', which
            # the map keys verbatim, correctly lands nowhere.
            t["lands_as"] = (tagmap.get(concept)
                             if ns in _INGESTED_NS and code in jmap else None)
        rows.append({"metric_code": code, "label": base.get("label"),
                     "kind": _kind(base), "in_json": code in jmap,
                     "in_xbrl": bool(base.get("in_xbrl")),
                     "source_if_not_xbrl": base.get("source_if_not_xbrl"),
                     "unit": base.get("unit"), "tags": list(seen.values()),
                     "drift": _drift(jmap.get(code), dmap.get(code)) if dmap is not None else []})
        if rows[-1]["kind"] == "computed":
            rows[-1]["inputs"] = _inputs(base, codes, tagmap)

    store = None
    if con is not None:
        all_tags = sorted({t["tag"] for r in rows for t in r["tags"]}
                          | {i["input"] for r in rows for i in r.get("inputs", []) if not i["code"]})
        store = store_coverage(con, all_tags, sorted(codes))

    for r in rows:
        _judge(r, store, frames, min_issuers)

    counts = {v: sum(r["verdict"] == v for r in rows) for v in VERDICTS}
    return {"generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "min_issuers": min_issuers,
            "sources": {"json_rows": len(json_rows),
                        "db_rows": len(db_rows) if db_rows is not None else None,
                        "store": ({k: store[k] for k in ("rows", "issuers", "last_filed")}
                                  if store else None),
                        "frames": ({"year": frames["year"], "error": frames["error"],
                                    "tags": len(frames["tags"])} if frames else None)},
            "verdict_counts": counts, "rows": rows}


def _judge(r: dict, store: dict | None, frames: dict | None, n: int) -> None:
    """Attach evidence, `flags` (every verdict that applies), `verdict` (the most
    urgent) and a suggested `action` (text only) to one audited row."""
    code, flags, actions = r["metric_code"], [], []
    bad = [t for t in r["tags"] if t["problem"]]
    if bad:
        flags.append("malformed_tag")
        actions.append("Fix " + "; ".join(f"{t['raw']!r} -> {t['tag']!r} ({t['problem']})"
                                          for t in bad) + ".")
    if r["drift"]:
        flags.append("db_json_drift")
        actions.append("Reconcile Postgres and metric_catalog.json (" + "; ".join(r["drift"])
                       + "); ingestion reads the JSON.")
    for t in r["tags"]:
        if store:
            st = store["by_tag"].get(t["tag"], {})
            t.update(store_issuers=st.get("issuers", 0), store_last_filed=st.get("last_filed"),
                     stored_as=st.get("stored_as", []))
        if frames and t["tag"] in frames["tags"]:
            f = frames["tags"][t["tag"]]
            t.update(sec_filers=f["filers"], sec_period=f["period"], sec_error=f["error"])
    if store:
        sc = store["by_code"].get(code, {})
        r.update(store_issuers=sc.get("issuers", 0), store_last_filed=sc.get("last_filed"))

    if r["kind"] == "by_design":
        flags.append("non_xbrl_by_design")
        actions.append(f"None: disclosed via {r['source_if_not_xbrl']}, nothing to collect.")
    elif r["kind"] == "computed":
        _judge_computed(r, store, n, flags, actions)
    else:
        _judge_xbrl(r, store, frames, n, flags, actions)

    if not flags:
        flags.append("ok")
    r["flags"] = flags
    r["verdict"] = next(v for v in VERDICTS if v in flags)
    r["action"] = " ".join(actions)


def _judge_xbrl(r, store, frames, n, flags, actions) -> None:
    code, tags = r["metric_code"], [t for t in r["tags"] if not t["problem"]]
    elsewhere = sorted({t["lands_as"] for t in r["tags"]
                        if t["lands_as"] and t["lands_as"] != code})
    if not any(t["lands_as"] == code for t in r["tags"]):
        flags.append("dead")
        if not r["in_json"]:
            actions.append("Not in metric_catalog.json, which ingestion reads, so nothing "
                           "collects it.")
        elif not r["tags"]:
            actions.append("Names no XBRL tags: add a verified tag or mark it computed.")
        elif not tags:
            actions.append("Every tag is malformed, so nothing collects it.")
        elif not r["in_xbrl"]:
            actions.append("in_xbrl is false and no other source is named, so the tag map "
                           "skips it: set in_xbrl or name a source.")
        elif elsewhere:
            actions.append(f"Every ingestable tag is claimed first by {', '.join(elsewhere)}: "
                           "mark it computed from those, or give it a tag of its own.")
        else:
            actions.append("No tag is in an ingested namespace (edgar reads "
                           f"{', '.join(_INGESTED_NS)}), so nothing collects it.")
        return
    sec = [t.get("sec_filers") for t in tags if "sec_filers" in t]
    sec_known = [x for x in sec if x is not None]
    if store is not None and r["store_issuers"] == 0:
        flags.append("dead")
        actions.append("No rows in the Tier B store: check the tags with --frames before "
                       "retargeting.")
    elif sec and len(sec_known) == len(sec) and max(sec_known) == 0:
        flags.append("dead")
        actions.append(f"No SEC filer uses these tags in CY{frames['year']}: set in_xbrl false "
                       f"(source_if_not_xbrl: {r['source_if_not_xbrl']}) or find the concept "
                       "issuers actually file.")
    elif store is not None and r["store_issuers"] < n:
        flags.append("low_coverage")
        actions.append(f"Only {r['store_issuers']} issuers in the store (< {n}): fine if "
                       "sector-specific, otherwise look for the concept peers file.")
    elif store is None and sec_known and max(sec_known) < n:
        flags.append("low_coverage")
        actions.append(f"At most {max(sec_known)} SEC filers (< {n}).")
    elif store is None and not sec_known:
        flags.append("unverified")
        actions.append("Tags are collectable but coverage is unmeasured: run "
                       "catalog-audit.yml (Tier B store, optionally frames).")


def _judge_computed(r, store, n, flags, actions) -> None:
    ins = r["inputs"]
    if not ins:
        flags.append("dead")
        actions.append("Names no input the catalogue collects (no catalogue code, and no "
                       "tag that maps to one): name them, or set source_if_not_xbrl to where "
                       "the figure is disclosed.")
        return
    missing = [i["input"] for i in ins if not i["code"]]
    if store is None:
        flags.append("unverified")
        actions.append("Input coverage is unmeasured: run catalog-audit.yml."
                       + (f" Not catalogue codes: {', '.join(missing)}." if missing else ""))
        return
    for i in ins:
        hit = store["by_code"].get(i["code"]) if i["code"] else store["by_tag"].get(i["input"])
        i["store_issuers"] = (hit or {}).get("issuers", 0)
    weak = [i["input"] for i in ins if i["store_issuers"] < n]
    if all(i["store_issuers"] == 0 for i in ins):
        flags.append("dead")
        actions.append("No input has any rows in the store, so it cannot be computed.")
    elif weak or missing:
        flags.append("low_coverage")
        actions.append("Weak inputs: " + ", ".join(sorted(set(weak) | set(missing)))
                       + f" (under {n} issuers or not a catalogue code).")


# --- output -----------------------------------------------------------------

def _cell(s) -> str:
    return str(s if s is not None else "").replace("|", "\\|").replace("\n", " ")


def render_md(rep: dict) -> str:
    s = rep["sources"]
    lines = ["# Catalogue audit", "",
             f"Generated {rep['generated_at']} by `python -m engine.catalogaudit`. Report only: "
             "nothing here changed the catalogue. Low coverage means under "
             f"{rep['min_issuers']} issuers.", "",
             f"- JSON catalogue: {s['json_rows']} rows",
             f"- Postgres metric_catalog: "
             + (f"{s['db_rows']} rows" if s["db_rows"] is not None
                else s.get("db_error") or "not read (no DATABASE_URL)"),
             "- Tier B store: " + (f"{s['store']['rows']:,} metric rows, {s['store']['issuers']} "
                                   f"issuers, last filed {s['store']['last_filed']}"
                                   if s["store"] else "not present (coverage unmeasured)"),
             "- SEC frames: " + ((f"CY{s['frames']['year']}, {s['frames']['tags']} tags"
                                  + (f", error: {s['frames']['error']}" if s['frames']['error'] else ""))
                                 if s["frames"] else "not fetched (pass --frames)"),
             "", "| Verdict | Rows |", "|---|---|"]
    lines += [f"| {v} | {c} |" for v, c in rep["verdict_counts"].items() if c]
    for v in VERDICTS:
        group = [r for r in rep["rows"] if r["verdict"] == v]
        if not group:
            continue
        lines += ["", f"## {v} ({len(group)})", "",
                  "| Metric | Kind | Tags | Store issuers | SEC filers | Also | Suggested action |",
                  "|---|---|---|---|---|---|---|"]
        for r in group:
            tags = ", ".join(t["tag"] + (" (malformed)" if t["problem"] else "")
                             for t in r["tags"]) or "none"
            sec = [t["sec_filers"] for t in r["tags"] if t.get("sec_filers") is not None]
            also = ", ".join(f for f in r["flags"] if f != v)
            lines.append("| " + " | ".join(_cell(x) for x in (
                r["metric_code"], r["kind"], tags, r.get("store_issuers", ""),
                max(sec) if sec else "", also, r["action"])) + " |")
    return "\n".join(lines) + "\n"


def run(frames: bool = False, year: int | None = None, min_issuers: int = MIN_ISSUERS,
        out_dir=None) -> dict:
    json_rows = catalog.load()
    db_rows, db_error = _db_catalog()
    con = _store()
    fr = None
    if frames:
        tag_units = {}
        for r in list(json_rows) + list(db_rows or []):
            if _kind(r) != "xbrl":
                continue
            for raw in _tags_of(r):
                tag, problem = normalise_tag(raw)
                if not problem:
                    tag_units.setdefault(tag, r.get("unit") or "")
        fr = frames_coverage(tag_units, year or date.today().year - 1)
    rep = audit(json_rows, db_rows, con, fr, min_issuers)
    rep["sources"]["db_error"] = db_error

    out = Path(out_dir or OUT_DIR)
    out.mkdir(parents=True, exist_ok=True)
    (out / "catalog_audit.json").write_text(json.dumps(rep, indent=2, default=str))
    (out / "catalog_audit.md").write_text(render_md(rep))
    print("   catalogue audit: " + ", ".join(f"{v} {c}" for v, c in rep["verdict_counts"].items()
                                              if c))
    for r in rep["rows"]:
        if r["verdict"] in ("malformed_tag", "db_json_drift", "dead"):
            print(f"     {r['verdict']:<14} {r['metric_code']}: {r['action'][:110]}")
    print(f"   wrote {out / 'catalog_audit.json'} and {out / 'catalog_audit.md'}")
    return rep


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--frames", action="store_true",
                    help="count SEC filers per tag via XBRL frames (needs SEC_USER_AGENT)")
    ap.add_argument("--year", type=int, default=None,
                    help="calendar year for frames (default: last year)")
    ap.add_argument("--min-issuers", type=int, default=MIN_ISSUERS,
                    help=f"low_coverage threshold (default {MIN_ISSUERS})")
    a = ap.parse_args(argv)
    run(a.frames, a.year, a.min_issuers)
    return 0


if __name__ == "__main__":
    sys.exit(main())
