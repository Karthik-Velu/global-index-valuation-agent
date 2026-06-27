"""Data-Ingestion Agent CLI.

  python -m engine.dataagent.cli run                 # one improvement pass
  python -m engine.dataagent.cli run --discover      # + LLM source discovery (needs key)
  python -m engine.dataagent.cli status              # needs + active source + quality
  python -m engine.dataagent.cli sources --leads     # the backlog of sources to wire in
  python -m engine.dataagent.cli report              # last run's report
"""
from __future__ import annotations

import argparse
import json

from ..config import DATA_DIR
from ..sources import registry
from .agent import REPORT_PATH, run


def main(argv=None):
    p = argparse.ArgumentParser(prog="engine.dataagent.cli", description="Data-Ingestion Agent")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="run one ingestion-improvement pass")
    r.add_argument("--sample", type=int, default=8)
    r.add_argument("--no-apply", action="store_true", help="recommend but don't rewire")
    r.add_argument("--discover", action="store_true", help="LLM source discovery (needs key)")

    sub.add_parser("status", help="needs + active source + latest quality")
    s = sub.add_parser("sources", help="list the source catalog")
    s.add_argument("--leads", action="store_true")
    s.add_argument("--candidates", action="store_true")
    sub.add_parser("report", help="print the last report")

    args = p.parse_args(argv)

    if args.cmd == "run":
        rep = run(sample_n=args.sample, auto_apply=not args.no_apply, with_discovery=args.discover)
        print("\n--- needs ---")
        for n in rep["needs"]:
            print(f"  {n['need']:<18} active={n['active']} -> recommended={n.get('recommended')} "
                  f"(q={n.get('recommended_quality')})")
        if rep["alerts"]:
            print("--- alerts ---")
            for a in rep["alerts"]:
                print(f"  ! {a}")
        if rep["leads_to_adapt"]:
            print("--- top leads to adapt next (public-safe first) ---")
            for l in rep["leads_to_adapt"]:
                print(f"  + {l['id']:<34} [{l['license']}] {','.join(l['kinds'] if isinstance(l['kinds'],list) else [l['kinds']])}")

    elif args.cmd == "status":
        registry.seed_from_catalog()
        for n in registry.list_needs():
            print(f"  {n['id']:<18} kind={n['kind']:<16} active={n['active_source_id']} "
                  f"public_only={n['public_only']}")
        print("\n  evals (latest):")
        for e in registry.latest_evals():
            print(f"    {e['source_id']:<8} {e['kind']:<16} q={e['quality_score']} "
                  f"cov={e['coverage_pct']} err={e['error']}")

    elif args.cmd == "sources":
        registry.seed_from_catalog()
        rows = registry.list_sources()
        if args.leads:
            rows = [r for r in rows if not r["has_adapter"]]
        if args.candidates:
            rows = [r for r in rows if r["has_adapter"]]
        rows.sort(key=lambda r: (r["license"] in ("public_domain", "redistribution_ok"),
                                 r["confidence"] == "high"), reverse=True)
        for r in rows:
            print(f"  {r['id']:<36} [{r['license']:<16}] {r['kinds']:<28} {r['status']}")
        print(f"\n  {len(rows)} sources")

    elif args.cmd == "report":
        if REPORT_PATH.exists():
            print(REPORT_PATH.read_text())
        else:
            print("no report yet — run: python -m engine.dataagent.cli run")


if __name__ == "__main__":
    main()
