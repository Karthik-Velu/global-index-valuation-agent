"""Sector-Intelligence Agent CLI.

  python -m engine.sectoragent.cli run        # tag stocks + validate catalog
  python -m engine.sectoragent.cli tags       # show current stock tags
  python -m engine.sectoragent.cli validation # show latest catalog validation
"""
from __future__ import annotations

import argparse

from .. import db
from .agent import run


def main(argv=None):
    p = argparse.ArgumentParser(prog="engine.sectoragent.cli", description="Sector-Intelligence Agent")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--limit", type=int, default=None)
    r.add_argument("--research", action="store_true")
    sub.add_parser("tags")
    sub.add_parser("validation")
    args = p.parse_args(argv)

    if args.cmd == "run":
        run(tag_limit=args.limit, with_research=args.research)
    elif args.cmd == "tags":
        with db.connect() as c, c.cursor() as cur:
            cur.execute("""select s.ticker, t.sector, t.sub_sector, t.sic_description
                           from security_tags t join securities s on s.id=t.security_id
                           where t.source='sic' order by s.ticker""")
            for r in cur.fetchall():
                print(f"  {r[0]:<6} {r[1]:<24} {r[2]:<28} [{r[3]}]")
    elif args.cmd == "validation":
        with db.connect() as c, c.cursor() as cur:
            cur.execute("""select metric_code, verdict, n_companies, median_abs, note from catalog_validation
                           where ts=(select max(ts) from catalog_validation)
                           order by case verdict when 'suspect' then 0 when 'ok' then 1 else 2 end, metric_code""")
            for r in cur.fetchall():
                print(f"  [{r[1]:<8}] {r[0]:<32} n={r[2]} med={r[3]} {r[4]}")


if __name__ == "__main__":
    main()
