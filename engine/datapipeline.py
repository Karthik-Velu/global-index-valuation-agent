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

from . import config, db, llm, quality, recalibration
from .config import DATA_DIR
from .dataagent import agent as source_probe   # deterministic source health/scoring
from .sectoragent import tagging
from .sectoragent import validate as sector_validate
from .sources import edgar

REPORT_PATH = DATA_DIR / "datapipeline_report.json"


def _tracked_tickers() -> list[str]:
    with db.connect() as c, c.cursor() as cur:
        cur.execute("select ticker from securities where cik is not null order by ticker")
        return [r[0] for r in cur.fetchall()]


def run(ingest: bool = True, tickers: list[str] | None = None, with_agents: bool = False) -> dict:
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
        tks = tickers or _tracked_tickers()
        if tks:
            st = edgar.ingest_tickers(tks)
            steps["ingest"] = {k: st[k] for k in ("securities", "metrics", "filings")}
            print(f"   ingest: {steps['ingest']}")
        else:
            steps["ingest"] = {"note": "no tracked securities with CIK yet"}

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
    a = p.parse_args()
    run(ingest=not a.no_ingest, with_agents=a.agents)
