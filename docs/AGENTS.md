# Jobs vs Agents — what runs, what's intelligent, and at what cadence

**Terminology (deliberate):**
- **Job** = deterministic Python (no LLM). Does the work, runs frequently, ~free.
- **Agent** = LLM-powered, *intelligent* review. **Improves the jobs** (proposes new
  rules/KPIs/sources/checks), runs **infrequently**, costs a little.

> The agents are the *developers*; the jobs are the *workers*. An agent does not sit
> in the hot path of every run — it periodically reviews how the jobs are doing and
> evolves their rules/config (and, eventually, their code). This keeps the frequent
> work free and the intelligent work rare. **All 5 agents are now built** (2026-07-23)
> and activate automatically once a model is configured — each one degrades to a
> clean no-op without a key, so the deterministic jobs never depend on them.

---

## Jobs (deterministic — running now, no LLM)

| Job | What it does | Cadence | Entry point |
|---|---|---|---|
| **Valuation / scoring** | Score ~90 indices, surface insights, grade past calls, publish the dashboard snapshot | weekly | `engine.cli refresh` · `refresh.yml` |
| **Data pipeline** | Sequenced: ① probe sources ② ingest fundamentals (EDGAR) ③ tag securities (SIC) ④ validate + auto-fix the KPI catalog ⑤ data-quality checks ⑥ recalibration check | daily | `engine.datapipeline` · `data-pipeline.yml` |
| **Catalogue audit** | Report only: for every `metric_catalog` row, the tag syntax, coverage in the Tier B store (`fundamental_metrics` only, never prices), Postgres vs JSON drift, inputs of computed rows and, optionally, SEC frames filer counts; a verdict and a suggested action per row. Unlike step ④ it never changes the catalogue | on demand | `engine.catalogaudit` · `catalog-audit.yml` |

Validation (steps ④⑤⑥) runs **right after ingestion**, in the same job — not as
separate crons. EDGAR (and any future source) ingestion is part of the data-pipeline
job's role.

---

## Agents (LLM — all built, dormant without a model)

Each below is wired as a hook that no-ops cleanly without a model configured (an
API key today, or a self-hosted model via the provider abstraction — see
[ARCHITECTURE.md](ARCHITECTURE.md#2-the-model-routing-strategy-the-cost-lever)).
Note the real routing gap this table used to gloss over: `engine/llm.py::chain_for()`
only has THREE actual chains (`cheap`, `smart`, and everything-else → the "agent"
chain, `MODEL_AGENT_CHAIN`) — there's no separate T2 tier today, so the "T1→T2"
entries below collapse onto the shared agent chain in practice, same as the
already-shipped Source-Discovery/Sector-KPI Research always have.

| Agent | Expected work (improves which job) | Model tier | Cadence | Hook |
|---|---|---|---|---|
| **Source-Discovery** | Research new/better data sources for coverage gaps the data-pipeline flags; propose adapters to build | T1 cheap (Qwen/GLM/DeepSeek) | monthly | `dataagent/discover.py` |
| **Sector-KPI Research** | For new/emerging or thin-coverage sub-sectors, research the KPIs that drive them; propose catalog additions + sub-sector tag refinements | T1→T2 (agent chain) | monthly | `sectoragent/research.py` |
| **Quality-Triage** | Read the data-quality warnings; explain root causes, propose fixes and **new deterministic checks** to add | T1 cheap | on findings | `qualitytriage.py`, hooked into `datapipeline.py` step 7 |
| **Analyst** | Investigate the handful of markets the scoring job flags; fetch news/fill gaps via tools; write falsifiable theses; self-grade (reflection) | T2 (agent chain) | per valuation run | `agent/agent.py` (Pillar 1), hooked into `pipeline.py` between surfacing and brief |
| **Strategist brief** | The 1-paragraph headline read on the scoreboard | T3 frontier | weekly | `llm.smart_brief` |
| **Model-Upgrade** | Eval models in `model_scorecard` vs their configured chain; propose promote/demote | — (cheap tier for the optional narrative only) | monthly | `modelupgrade.py` (Pillar 5, v1 — see ADR), hooked into `pipeline.py` |

Analyst and Model-Upgrade are gated behind `engine.cli refresh --agent` /
`--model-upgrade` (both default off at the CLI level); Quality-Triage runs
automatically whenever `data-pipeline.yml`'s `--agents` flag is on AND
`quality.run()` raised issues this run — no separate flag needed. In
production, `refresh.yml` passes `--agent` on every weekly run and
`--model-upgrade` on the first 7 days of the month (2026-07-23 — see
`docs/STATUS.md`), with `OLLAMA_API_KEY`/`GROQ_API_KEY` now exported there too.

**The meta-loop:** an agent's output is a *proposal* (a new KPI + its XBRL tag, a new
source, a new quality check). A human or a follow-up step turns the proposal into a
deterministic rule/adapter/check that the jobs then run cheaply, forever. So
intelligence is spent *once* to improve a job, not *every time* the job runs.

### Closing the meta-loop (2026-08-01, ADR-028)

For two weeks only the *first* half of that loop existed. Agents appended free text to
`taxonomy_changes` and nothing read it back: **166 proposals accumulated, zero were ever
applied**, and the same ideas were re-proposed nightly forever (`capex_intensity` 15× in
7 days; `timeseries_jump` 8× in **8 different wordings**).

The second half now exists:

| Piece | What it does |
|---|---|
| `engine/proposals.py` | Capture → dedup → decide → apply. One row per **decision**, not per phrasing. |
| `engine/migrations/0013` | `proposals`, append-only `proposal_events`, chat thread, solution revisions. |
| `supabase/functions/admin` | Actions a decision the moment it's clicked; answers questions. |
| `dashboard/admin.html` | The review console — read it, ask about it, decide it. |
| `engine/builder.py` | **The 6th agent.** Approved *code* proposals → English plan → PR. |

Two properties worth not regressing:

1. **Dedup is on the decision, not the wording.** The decision "do we add capex_intensity?" is
   the same question however the model words its pitch. Hashing the text, even normalised,
   gives 8 rows for the 8 wordings of `timeseries_jump` and rebuilds the flood. The raw
   `(kind, target)` key did not make `declined` stick against synonyms, though ('FRED', 'fred'
   and 'fred_idx' were three keys); the canonical key below does (ADR-044).
2. **Approving code does not mean code exists.** DATA kinds (`catalog_kpi`,
   `model_routing`) change the live system in-process. CODE kinds (`quality_check`,
   `source_adapter`) file a GitHub issue and hand off to the Builder, and only become
   `actioned` when their **PR merges**. The console says so in different words per kind.

**The Builder** is English-first by owner directive: it drafts a plain-English solution
(what changes, which files, what could break, how we'd know), the admin approves *that*,
and only then is code written — as atomic search/replace edits behind a compile+import
gate, on a `builder/proposal-<id>` branch, merged when checks go green. It runs on the
cheap `coder` chain (Qwen3-Coder first), never in the hot path. See `.github/workflows/builder.yml`.

### Agents v2: needs, canonical keys, expiry (2026-11-05, ADR-044)

On 31 Oct 2026 the owner declined 152 proposals and asked what happens to the genuine issues
behind them. The answer is the **needs register**: declining a proposal rejects that
*solution*, never the *need*.

| Piece | What it does |
|---|---|
| `data_needs` (migration 0017) | Every need, with a status: `open`, `answered_by_roadmap` (and the reference), `parked` (and a date) or `met`. Source needs, sector-KPI needs and data-quality needs (`quality:<check>`). Seeded insert-only by `dataagent/agent.py::seed_needs`, so the owner's edits stick; a parked need reopens on its date. |
| `engine/canonical.py` | The decision a target stands for: provider at need (`source_adapter:fred@macro_fred`), KPI concept at broad sector (`catalog_kpi:crop_yield@materials`), and the proposed check (`quality_check:alt_revenue_tag`). |
| `proposals.capture()` | Refuses a need that is not open, a KPI already in the catalogue, and any synonym of a declined or parked decision. Evidence counts distinct signals (a sub-sector, a firing check, a need), not nights. |
| `proposals.expire_stale()` | A pending proposal whose trigger is gone (a retired check, a catalogued code, an answered need, 42 days unraised) expires, with an audit event. Raised again, it revives. |
| `proposals.CONSUMERS` | The fixed list of what the code actually reads. `how_used` is built from it, never from the model's words. |

What each agent now does differently:
- **Source-Discovery** asks only about open source needs, with the need's description and the
  providers already known, verified and declined in the prompt. Its licence gate reads the
  registry (`registry.verified_license`), never the model's claim, and it writes proposals,
  never registry rows. The registry lets only an adapter or the researched seed catalogue
  change a verified licence, and 0017 marked the invented leads `invented`.
- **Sector-KPI Research** takes the thinnest catalogue coverage first, rotated weekly, and lists
  the catalogue's codes in its prompt. A tag counts as XBRL only if the SEC frames API confirms
  someone files it (`XBRL_VERIFY=1`); otherwise the KPI goes to the non-XBRL need, which is
  parked until there is a way to read MD&A text. With verification off and that need parked,
  the model is not called at all.
- **Quality-Triage** triages only open `quality:<check>` needs, with the need's constraints and
  the fixes already declined in its prompt, and keys the proposal on the check it proposes.

Approving a KPI whose code is already in the catalogue never rewrites the curated row: it
appends a note and says "already in catalogue, no change" (Python and the Edge Function).
Note the gap `how_used` now states plainly: ingestion reads `engine/sources/metric_catalog.json`,
not the `metric_catalog` table an approval writes.

---

## Differential frequency (right-sized to how fast each thing changes)
- **Per-ingestion (hot path):** tag new stocks, validate new data — inside the data-pipeline job.
- **Daily:** data pipeline (ingest new filings + validate).
- **Weekly:** valuation/scoring + recalibration check + strategist brief.
- **Weekly (Wednesday data-pipeline run):** the proposal agents (source discovery, sector KPIs,
  quality triage). They ran on every pipeline run until 2026-10-31 and flooded the queue.
- **Monthly:** taxonomy + model-upgrade.

## Setting up the LLM later (checklist)
1. Configure a model — `ANTHROPIC_API_KEY` (frontier) and/or a self-hosted/owned model
   (Qwen/DeepSeek/GLM via the provider abstraction, Pillar 5) for the cheap tiers.
2. Schedule each agent at its cadence (the hooks already exist / are stubbed).
3. Route each agent to its tier in `config/models.yaml` (Pillar 5).
4. Agents emit proposals → jobs stay deterministic.
