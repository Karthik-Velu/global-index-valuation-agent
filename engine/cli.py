"""Command line entry point.

  python -m engine.cli refresh        # fetch + score + write dashboard JSON
  python -m engine.cli refresh --no-cache --no-llm
  python -m engine.cli feedback market brazil pin "cheap and I like the setup"
  python -m engine.cli accuracy       # show the model's track record so far
"""
from __future__ import annotations

import argparse
import json

from . import ledger
from .config import DASHBOARD_JSON
from .pipeline import run


def main(argv=None):
    p = argparse.ArgumentParser(prog="engine.cli", description="Global Index Valuation Agent")
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("refresh", help="run the full pipeline")
    r.add_argument("--no-cache", action="store_true", help="force re-fetch from source")
    r.add_argument("--no-llm", action="store_true", help="skip LLM tags/brief")
    r.add_argument("--agent", action="store_true",
                   help="also run the Analyst agent (bounded ReAct loop over ambiguous markets)")
    r.add_argument("--model-upgrade", action="store_true",
                   help="also run the Model-Upgrade agent (advisory chain-health proposals)")
    r.add_argument("--asof", default=None, help="YYYY-MM-DD (default today)")

    f = sub.add_parser("feedback", help="record user feedback")
    f.add_argument("kind", choices=["market", "insight"])
    f.add_argument("target")
    f.add_argument("signal", choices=["pin", "dismiss", "up", "down"])
    f.add_argument("note", nargs="?", default="")

    sub.add_parser("accuracy", help="print model track record")

    args = p.parse_args(argv)

    if args.cmd == "refresh":
        run(asof=args.asof, use_cache=not args.no_cache, with_llm=not args.no_llm,
            with_agent=args.agent, with_model_upgrade=args.model_upgrade)
        print(f"\nDashboard JSON ready: {DASHBOARD_JSON}")
    elif args.cmd == "feedback":
        ledger.add_feedback(args.kind, args.target, args.signal, args.note)
        print(f"recorded: {args.kind} {args.target} -> {args.signal}")
    elif args.cmd == "accuracy":
        print(json.dumps(ledger.accuracy_summary(), indent=2))


if __name__ == "__main__":
    main()
