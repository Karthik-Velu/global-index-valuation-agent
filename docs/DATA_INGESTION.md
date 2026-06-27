# Data-Ingestion Agent

> Its sole job: keep the product's data ingestion as good as possible — discover
> sources, **test them** for coverage/cleanliness/freshness/license, score them, and
> rewire which source feeds each need. The operational form of architecture Pillar 6.

## What it does (each pass)
1. **Probe** every adapter that serves a data need over a region-spread sample of
   markets — deterministic, no LLM, so it's free and can run as often as we like.
   Measures **coverage** (keys returned), **completeness** (non-null fields),
   **sanity** (values in plausible ranges), **freshness** (age of newest data), and
   **latency** → a 0–100 quality score (`engine/dataagent/probe.py`).
2. **Decide** the best source per need, **preferring license-clean** sources for
   public needs, and **rewire** the active source if a better one exists
   (`engine/dataagent/agent.py`; logged in `source_decisions`).
3. **Flag** problems: broken sources, licensing risk (e.g. "using Yahoo —
   personal_only — for a public need"), and coverage gaps ("NO working source").
4. **Maintain a backlog** of researched, verified, license-aware sources to wire in
   next (`engine/sources/seed_catalog.json`, 40 sources).
5. *(optional)* **Discover** new candidates via the cheap LLM tier
   (`engine/dataagent/discover.py`) — degrades to a no-op with no API key.

## Run it
```bash
python -m engine.dataagent.cli run            # one pass (probe, decide, report)
python -m engine.dataagent.cli status         # needs + active source + quality
python -m engine.dataagent.cli sources --leads  # the prioritized backlog
python -m engine.dataagent.cli run --discover   # + LLM discovery (needs key)
```
Scheduled daily via `.github/workflows/data-agent.yml` (uploads the report artifact).

## What this run already found (honest)
- Yahoo works (price q≈95, valuation q≈94) **but is `prohibited`/`personal_only`** —
  not safe for a public product.
- **Stooq is broken** for automated use (it added a SHA-256 proof-of-work bot
  challenge) → the probe scores it 0 and the agent flags it.
- **No working stock-fundamentals source yet** — the #1 coverage gap.
- Prioritized, **license-clean** leads to adopt next: **EDINET** (Japan, public
  domain), **filings.xbrl.org** (EU/UK, redistribution-OK), **UK Companies House**
  (public domain), **SEC EDGAR** (US, public domain), **SimFin** (redistribution-OK),
  **GDELT** (news), **Frankfurter/ECB** (FX). The honest paid option for broad non-US
  fundamentals is **EODHD** (needs a commercial license for public redistribution).

## Components
```
engine/sources/
  base.py          # SourceAdapter interface + DataKind / License + Record/SampleResult
  registry.py      # catalog + eval ledger + data_needs + decisions (SQLite)
  adapters.py      # live adapter instances (yahoo, stooq)
  yahoo.py stooq.py# concrete adapters
  seed_catalog.json# 40 research-verified, license-aware sources (the backlog)
engine/dataagent/
  probe.py         # deterministic quality scoring (the "test cleanliness" core)
  agent.py         # orchestrate: probe -> score -> decide -> rewire -> report
  discover.py      # optional cheap-LLM source discovery
  cli.py           # run / status / sources / report
```

## Next steps (to make decisions actually take effect + close the gaps)
1. **Honor the registry in retrieval.** `engine/datasource.py` still hard-codes
   Yahoo; route it through `registry.active_source` + the adapter so the agent's
   "rewire" decisions actually change what the product fetches.
2. **Build adapters for the top public-safe leads** (EDINET, filings.xbrl.org, SEC
   EDGAR, SimFin) — this both unlocks **stock-level fundamentals** and removes the
   Yahoo licensing blocker for going public.
3. **Persist quality history in the cloud DB** (Pillar 7) so the agent tracks source
   quality *trends* and can react to gradual degradation, not just hard breakage.
