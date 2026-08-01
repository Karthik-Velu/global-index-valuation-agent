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

1. **Dedup is on `(kind, target)`.** The decision "do we add capex_intensity?" is the same
   question however the model words its pitch. Hashing the text — even normalised — gives
   8 rows for the 8 wordings of `timeseries_jump` and rebuilds the flood. It's also what
   makes `declined` stick: a rejected idea can't return through a synonym.
2. **Approving code does not mean code exists.** DATA kinds (`catalog_kpi`,
   `model_routing`) change the live system in-process. CODE kinds (`quality_check`,
   `source_adapter`) file a GitHub issue and hand off to the Builder, and only become
   `actioned` when their **PR merges**. The console says so in different words per kind.

**The Builder** is English-first by owner directive: it drafts a plain-English solution
(what changes, which files, what could break, how we'd know), the admin approves *that*,
and only then is code written — as atomic search/replace edits behind a compile+import
gate, on a `builder/proposal-<id>` branch, merged when checks go green. It runs on the
cheap `coder` chain (Qwen3-Coder first), never in the hot path. See `.github/workflows/builder.yml`.

---

## Differential frequency (right-sized to how fast each thing changes)
- **Per-ingestion (hot path):** tag new stocks, validate new data — inside the data-pipeline job.
- **Daily:** data pipeline (ingest new filings + validate).
- **Weekly:** valuation/scoring + recalibration check + strategist brief.
- **Monthly:** the LLM research/discovery agents (taxonomy, sources, KPIs) + model-upgrade.

## Setting up the LLM later (checklist)
1. Configure a model — `ANTHROPIC_API_KEY` (frontier) and/or a self-hosted/owned model
   (Qwen/DeepSeek/GLM via the provider abstraction, Pillar 5) for the cheap tiers.
2. Schedule each agent at its cadence (the hooks already exist / are stubbed).
3. Route each agent to its tier in `config/models.yaml` (Pillar 5).
4. Agents emit proposals → jobs stay deterministic.
