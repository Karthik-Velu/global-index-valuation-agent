"""The data pipeline — a regular, deterministic JOB (no LLM, not an "agent").

Runs the data steps in sequence so validation happens right after ingestion, in one
job rather than separate cron jobs:

  1. probe sources        — which sources are healthy / license-clean (updates registry)
  2. ingest fundamentals  — EDGAR (and, later, other sources) for tracked securities
  3. tag securities       — deterministic SIC sector/sub-sector tagging
  4. validate catalog     — check XBRL metric mappings; auto-fix mis-mapped tags
  5. data-quality checks  — raise warnings to data_quality_issues
  6. recalibration check  — is a re-backtest needed given corrections since last one?

The LLM "agents" (source discovery, sector-KPI research, analyst/strategist) are
SEPARATE and infrequent — they improve these jobs rather than run inside them. See
docs/AGENTS.md. They are dormant until an API key / model is configured.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timezone

from . import config, db, llm, memory, quality, recalibration
from .config import DATA_DIR
from .dataagent import agent as source_probe   # deterministic source health/scoring
from .sectoragent import tagging
from .sectoragent import validate as sector_validate
from .sources import edgar

REPORT_PATH = DATA_DIR / "datapipeline_report.json"


def _tracked_tickers() -> list[tuple]:
    """(ticker, cik) for everything already in the DB."""
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select ticker, cik from securities where cik is not null order by ticker")
        return cur.fetchall()


def _ingest_universe(full: bool) -> tuple[list[str], dict, str]:
    """Decide what to ingest this run: (tickers, country_by_ticker, mode).

    The universe = DB-tracked tickers ∪ the committed seed (universe_stocks.json).
    Daily runs are INCREMENTAL — only tracked companies that actually filed in the
    last few days (EDGAR daily index) plus any not-yet-ingested seed tickers — so
    runtime stays flat as the universe grows; the weekly full sweep re-feeds all.

    Expansion gate: while Postgres still holds fundamental_metrics (pre-cutover
    dual-write), new seed tickers are capped to the ~30-company validation batch —
    a full expansion would blow the Supabase 500 MB free cap before the Tier B
    cutover empties the table (ADR-014).
    """
    from . import universescan

    tracked = _tracked_tickers()
    tracked_tk = {t for t, _ in tracked}
    seed = universescan.seed_stocks()
    new_seed = sorted(set(seed) - tracked_tk)

    with db.connect() as c, c.cursor() as cur:
        cur.execute("select count(*) from fundamental_metrics")
        pre_cutover = cur.fetchone()[0] > 0
    if pre_cutover and new_seed:
        batch = set(universescan.load_seed().get("validation_batch", []))
        gated = [t for t in new_seed if t in batch]
        if len(gated) < len(new_seed):
            print(f"   expansion gate: pre-cutover — ingesting {len(gated)} validation-"
                  f"batch tickers now; {len(new_seed) - len(gated)} more join after cutover")
        new_seed = gated

    if full:
        return sorted(tracked_tk | set(new_seed)), seed, "full"
    try:
        recent = edgar.recent_filer_ciks(days=7)
        fresh = {t for t, cik in tracked if cik and cik.isdigit() and int(cik) in recent}
        return sorted(fresh | set(new_seed)), seed, "incremental"
    except Exception as e:  # index unreachable -> fall back to a full sweep
        print(f"   daily-index unavailable ({str(e)[:80]}) — falling back to full sweep")
        return sorted(tracked_tk | set(new_seed)), seed, "full_fallback"


def run(ingest: bool = True, tickers: list[str] | None = None, with_agents: bool = False,
        full_ingest: bool = False) -> dict:
    print("== Data pipeline (job) ==")
    steps: dict = {}

    # 1. Source health/license probe (deterministic part of the ingestion role).
    try:
        sp = source_probe.run(sample_n=6, auto_apply=True, with_discovery=False)
        steps["sources"] = {"decisions": len(sp.get("decisions", [])),
                            "alerts": len(sp.get("alerts", []))}
    except Exception as e:
        steps["sources"] = {"error": str(e)[:160]}

    # 2. Ingest fundamentals (EDGAR is part of the ingestion role).
    if ingest:
        if tickers:
            tks, countries, mode = tickers, {}, "explicit"
        else:
            tks, countries, mode = _ingest_universe(full=full_ingest)
        if tks:
            st = edgar.ingest_tickers(tks, country_by_ticker=countries)
            steps["ingest"] = {"mode": mode, "candidates": len(tks)}
            steps["ingest"].update({k: st[k] for k in ("securities", "metrics", "filings")})
            steps["ingest"].update({k: st[k] for k in ("tierb_metrics", "tierb_error")
                                    if k in st})
            print(f"   ingest: {steps['ingest']}")
        else:
            steps["ingest"] = {"mode": mode, "note": "nothing to ingest this run"}

    # 2b. Tier B reconcile — while both stores take writes, an incremental export
    #     right after ingestion catches anything the dual-write missed, so the
    #     Parquet store the checks below read is in lockstep with Postgres.
    #     No-op until the store is initialized (engine.tierbsync export).
    try:
        from . import tierb, tierbsync
        if tierb.enabled() and db.have_db():
            inc = tierbsync.export(incremental=True)
            steps["tierb"] = {"synced": inc["rows_exported"],
                              "rows": inc["fundamental_metrics"],
                              "postgres_rows": inc["postgres_rows"]}
        else:
            steps["tierb"] = {"note": "store not initialized (run engine.tierbsync export)"}
    except Exception as e:
        # Recorded, not fatal: the quality/validate jobs below guard themselves
        # against a lagging store (they fall back to Postgres and warn).
        steps["tierb"] = {"error": str(e)[:160]}
        print(f"   WARNING: Tier B reconcile failed: {str(e)[:160]}")

    # 2c. Prices (Tier B only — bulk daily OHLCV has no Postgres home, ADR-016).
    #     Incremental daily (cheap: only trading days after each ticker's stored
    #     max date); a full re-feed rides the SAME monthly-sweep flag as the
    #     fundamentals full sweep, since re-basing a split needs the whole series
    #     re-fetched (prices.bulk_ingest(full=True) purges + re-fetches per ticker).
    try:
        from . import tierb
        from .sources import prices as prices_source
        if tierb.enabled():
            pst = prices_source.bulk_ingest(full=full_ingest)
            steps["prices"] = {k: v for k, v in pst.items() if k != "errors"}
            if pst.get("errors"):
                steps["prices"]["n_errors"] = len(pst["errors"])
            print(f"   prices: {steps['prices']}")
        else:
            steps["prices"] = {"note": "Tier B not initialized — prices have no Postgres home"}
    except Exception as e:
        # Recorded, not fatal: a price-source hiccup must never break the ingestion
        # of record (fundamentals) or the checks that follow.
        steps["prices"] = {"error": str(e)[:160]}
        print(f"   WARNING: price ingestion failed: {str(e)[:160]}")

    # 3. Tag securities (deterministic).
    steps["tagging"] = tagging.tag_securities()

    # 4. Validate + auto-fix the metric catalog (deterministic self-correction).
    val = sector_validate.validate_catalog()
    fixed = sector_validate.auto_fix_suspects(val)
    steps["catalog"] = {"ok": sum(v["verdict"] == "ok" for v in val),
                        "suspect_fixed": fixed,
                        "no_data": sum(v["verdict"] == "no_data" for v in val)}

    # 5. Data-quality checks (right after ingestion).
    q = quality.run()
    steps["quality"] = {"score": q["data_quality_score"], "issues": q["n_issues"]}

    # 6. Recalibration recommendation.
    rc = recalibration.run()
    steps["recalibration"] = {"recommend": rc["recommend"], "kind": rc["kind"]}

    # 7. LLM AGENTS (optional, infrequent) — they IMPROVE the jobs (propose new
    #    sources/KPIs), they don't do the deterministic work. Only run when activated
    #    AND a model is configured (Ollama / a provider key).
    if with_agents and llm.available():
        from .dataagent.discover import discover_for_needs
        from .sectoragent.research import research_thin_subsectors
        from .sources import registry
        disc = discover_for_needs(registry.list_needs())
        res = research_thin_subsectors()
        steps["agents"] = {"active": True, "model": config.MODEL_AGENT,
                          "discovery": disc, "research": res}
        print(f"   agents: ran source-discovery + sector-KPI research on {config.MODEL_AGENT}")
    elif with_agents:
        steps["agents"] = {"active": False, "note": "no model configured — set up Ollama or a provider key"}
        print("   agents: requested but no model configured (Ollama not running / no key)")
    else:
        steps["agents"] = {"active": False, "note": "not requested (run with --agents)"}

    # 8. Semantic-memory lifecycle (deterministic): consolidate freshly captured
    #    candidates to 'active', then decay/retire stale ones. Runs after the agents
    #    so anything they just captured is consolidated in the same pass.
    steps["memory"] = {"consolidate": memory.consolidate(), "decay": memory.verify_decay(),
                       "stats": memory.stats()}

    report = {"asof": date.today().isoformat(),
              "generated_at": datetime.now(timezone.utc).isoformat(), "steps": steps}
    REPORT_PATH.write_text(json.dumps(report, indent=2, default=str))
    print(f"   pipeline done — quality {steps['quality']['score']}/100, "
          f"recalibration={steps['recalibration']['kind']}. wrote {REPORT_PATH}")
    return report


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser(prog="engine.datapipeline", description="Data pipeline job")
    p.add_argument("--no-ingest", action="store_true", help="skip EDGAR ingestion")
    p.add_argument("--agents", action="store_true", help="also run the LLM agents (needs a model)")
    p.add_argument("--full", action="store_true",
                   help="full re-feed of the whole universe (default: incremental — "
                        "only companies that filed recently, plus new seed tickers)")
    a = p.parse_args()
    run(ingest=not a.no_ingest, with_agents=a.agents, full_ingest=a.full)
